import { expect, mock, test } from 'claude-code/testing'

import type { Board, Entry, StationId } from '../types'
import { DEFAULT, cut, inkFor, isWidth1, mix, rgb } from './cells'
import type { Cells } from './cells'
import { setupFrom } from './map'
import { FASTEST_MS, fromBase64 } from './raster'
import { stringsFor } from './text'
import { city } from './view-city'

// The test runner prints what a test logs; the hooks' own types leave the console out.
declare const console: { log: (...parts: unknown[]) => void }

const PANE = {
  plugin: 'lot-map',
  component: 'Pane',
  requestId: 'lot-map',
  props: { title: 'Map', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const NOW = 50_000_000
const LOTS: StationId[] = ['memory', 'files', 'shell', 'web', 'browser', 'agents', 'skills', 'hooks']

/** The setup a terminal view is given: a theme of its own, and the terminal's background. */
const setupOf = (options: Record<string, unknown> = {}) => ({ ...setupFrom({ theme: 'dark', ...options }), background: 'transparent' as const })
const DARK = setupOf()

let ids = 0
/** A finished call, 100 ms long, unless told otherwise. */
const call = (station: StationId, startedAt: number, more: Partial<Entry> = {}): Entry => ({
  id: `c${ids++}`,
  station,
  label: station,
  from: 'core',
  startedAt,
  endedAt: startedAt + 100,
  status: 'ok',
  ...more,
})
const running = (station: StationId, startedAt: number, more: Partial<Entry> = {}): Entry => {
  const e = call(station, startedAt, { status: 'run', ...more })
  delete e.endedAt
  return e
}

/** A board of these entries as the mod would keep it: every one counted, but for a model change. */
function boardOf(entries: Entry[], more: Partial<Board> = {}): Board {
  const counts: Board['counts'] = {}
  for (const e of entries) if (e.mark !== 'switch') counts[e.station] = (counts[e.station] ?? 0) + 1
  return { entries, counts, ...more }
}

/** Calls running on several stations, a subagent at work, two faults, memory pushed in, a model change. */
function busy(): Board {
  const entries: Entry[] = [call('you', NOW - 60_000, { from: 'inbound' })]
  for (const lot of LOTS) for (let i = 0; i < 3; i++) entries.push(call(lot, NOW - 50_000 + i * 1000))
  for (let i = 0; i < 6; i++) entries.push(call('model', NOW - 45_000 + i * 5000))
  entries.push(running('agents', NOW - 30_000, { task: 'a1' }))
  entries.push(call('shell', NOW - 20_000, { status: 'err' }))
  entries.push(call('model', NOW - 3000, { mark: 'switch', label: 'opus 5.5 → sonnet 4.5' }))
  entries.push(running('files', NOW - 2000, { from: 'agents', agentId: 'a1' }))
  entries.push(call('shell', NOW - 1500, { status: 'err', endedAt: NOW - 300 }))
  entries.push(running('web', NOW - 1000))
  entries.push(running('model', NOW - 500))
  entries.push(call('memory', NOW - 200, { from: 'inbound', label: '1 record: #7' }))
  return boardOf(entries, { faults: { shell: 2 }, agents: ['a1'], pushed: 1, context: 75, model: 'claude-sonnet-4-5', switchedAt: NOW - 3000 })
}

const draw = (board: Board, now = NOW, columns = 60, rows = 30, setup = DARK, memory = city.memory()): Cells => city.draw(board, now, { columns, rows }, setup, memory)
const glyph = (cells: Cells, x: number, y: number): string => String.fromCodePoint(cells.glyph(x, y))
const isBraille = (cells: Cells, x: number, y: number): boolean => cells.glyph(x, y) >= 0x2800 && cells.glyph(x, y) <= 0x28ff

/** Where a text stands in the cells, by the row that holds it. */
function find(cells: Cells, text: string, from = 0): { x: number; y: number } | undefined {
  const lines = cells.lines()
  for (let y = from; y < lines.length; y++) {
    const x = lines[y]!.indexOf(text)
    if (x >= 0) return { x, y }
  }
  return undefined
}

/** Each building's wall, left to right, found on its ground floor: the row over the street. */
function walls(cells: Cells): number[] {
  const base = cells.rows - 4
  const out: number[] = []
  for (let x = 0; x < cells.columns; x++) if (glyph(cells, x, base) === '▐') out.push(x)
  return out
}

/** A building's windows, floor by floor from the ground, as their colours. */
function windows(cells: Cells, wall: number): number[][] {
  const floors: number[][] = []
  for (let y = cells.rows - 4; y >= 0 && glyph(cells, wall, y) === '▐'; y--) {
    const floor: number[] = []
    for (let x = wall + 1; glyph(cells, x, y) === '▖'; x++) floor.push(cells.fg(x, y))
    floors.push(floor)
  }
  return floors
}

const pairsOf = (cells: Cells): number => {
  const pairs = new Set<number>()
  for (let i = 0; i < cells.words.length; i += 3) pairs.add(cells.words[i + 1]! * 0x2000000 + cells.words[i + 2]!)
  return pairs.size
}

const luminance = (c: number): number => (0.2126 * ((c >> 16) & 0xff) + 0.7152 * ((c >> 8) & 0xff) + 0.0722 * (c & 0xff)) / 255

const WARM_FRESH = rgb('#fbe4c4')
const WARM_EMBER = rgb('#6e5439')
const TEAL_FRESH = rgb('#c8f2eb')
const TEAL_EMBER = rgb('#2f605a')
const WHITE_FRESH = rgb('#ffffff')
const UNLIT = rgb('#20252f')
const RUNNING = ['#fff6e6', '#f7d6a8', '#ffeccc', '#f0c595'].map(rgb)
const RED = rgb('#e8654f')

// ---- what it shows ------------------------------------------------------------------------------

test('an empty board is a dark street under an empty sky, every lot named and waiting', () => {
  const cells = draw({ entries: [], counts: {} })
  const lines = cells.lines()
  expect(lines[27]).toBe('▔'.repeat(60))
  for (const lot of LOTS) expect(find(cells, DARK.t.stations[lot], 28)).toBeDefined()
  // No windows, no stars: each lot is an empty plot by the street.
  expect(lines.slice(6, 27).join('').includes('▖')).toBe(false)
  expect(lines.slice(0, 26).some(l => [...l].some(c => c >= '⠀' && c <= '⣿'))).toBe(false)
  expect((lines[26]!.match(/▁/g) ?? []).length).toBe(8 * 4)
  // The moon is there, all dark: nothing of the context window is known.
  expect(find(cells, '███████')).toBeDefined()
  expect(city.nextFrameIn({ entries: [], counts: {} }, NOW, { columns: 60, rows: 30 }, DARK, city.memory(), 33)).toBeUndefined()
})

test('every call lights a window of its building, fresh as it ends and an ember half an hour on', () => {
  const entries = [
    call('files', NOW - 3 * 3_600_000),
    call('files', NOW - 3 * 3_600_000),
    call('files', NOW - 100),
    call('memory', NOW - 3 * 3_600_000),
    call('memory', NOW - 100),
    call('shell', NOW - 100, { from: 'agents', agentId: 'a1' }),
  ]
  const cells = draw(boardOf(entries))
  const [memory, files, shell] = walls(cells).map(w => windows(cells, w))
  // Four windows a floor at sixty columns: the calls light them in order, the rest of the floor is dark.
  expect(files).toEqual([[WARM_EMBER, WARM_EMBER, WARM_FRESH, UNLIT]])
  expect(memory).toEqual([[TEAL_EMBER, TEAL_FRESH, UNLIT, UNLIT]])
  // A subagent's call burns white.
  expect(shell).toEqual([[WHITE_FRESH, UNLIT, UNLIT, UNLIT]])
  // The other lots are empty plots.
  expect(walls(cells).length).toBe(3)
})

test('a busy city: beams, a drone, a crane, a beacon, a spark of memory and the new model under the moon', () => {
  const board = busy()
  const cells = draw(board)
  const ink = inkFor(DARK)
  const [memory, files, shell, web, , agents] = walls(cells)
  const roof = (wall: number) => cells.rows - 4 - windows(cells, wall).length

  // What runs: the network's newest window flickers, and its beam washes the sky above the roof.
  const network = windows(cells, web!)
  expect(RUNNING).toContain(network[0]![3]!)
  expect(cells.bg(web! + 2, roof(web!) - 2)).not.toBe(DEFAULT)
  expect(cells.fg(find(cells, 'Network', 28)!.x, find(cells, 'Network', 28)!.y)).toBe(ink.bone)

  // Faults since the last message: red windows, a red name, and a beacon on the roof with how many.
  // The older is red, the newer still flashing as it lands.
  expect(windows(cells, shell!)[0]![3]).toBe(RED)
  expect(windows(cells, shell!)[1]![0]).toBe(mix(RED, 0xffffff, 0.35))
  const name = find(cells, 'Shell', 28)!
  expect(cells.fg(name.x, name.y)).toBe(ink.red)
  expect(glyph(cells, shell! + 1, roof(shell!))).toBe('▄')
  expect(glyph(cells, shell! + 2, roof(shell!))).toBe('2')

  // A subagent hovers over the building of its call, its tether down to the roof while the call runs.
  let drone = 0
  for (let y = 0; y < roof(files!); y++) for (let x = files!; x <= files! + 5; x++) if (isBraille(cells, x, y) && [rgb('#d3d8e0'), WHITE_FRESH].includes(cells.fg(x, y))) drone++
  expect(drone).toBeGreaterThan(1)
  // A background task: a crane on the agents' roof.
  expect(glyph(cells, agents! + 4, roof(agents!) - 1)).toBe('┳')
  // Memory pushed in a moment ago falls into its building as a teal spark.
  let spark = 0
  for (let y = 0; y < roof(memory!); y++) for (let x = memory!; x <= memory! + 5; x++) if (isBraille(cells, x, y) && [TEAL_FRESH, ink.mem].includes(cells.fg(x, y))) spark++
  expect(spark).toBeGreaterThan(0)
  // The model changed three seconds ago: its name hangs under the moon. The moon is amber, three quarters full.
  const model = find(cells, 'sonnet 4.5')!
  expect(model.y).toBe(5)
  expect(cells.lines()[2]!.includes('█')).toBe(true)
  expect(cells.fg(cells.columns - 3, 2)).toBe(rgb('#f0c595'))
  // The model thinks: the moon's halo washes the sky around it.
  expect(cells.bg(cells.columns - 12, 2)).not.toBe(DEFAULT)
})

test('a fault flashes, stays red until the next message, and is a scar after it', () => {
  const memory = city.memory()
  const message = call('you', NOW - 10_000, { from: 'inbound' })
  const fault = call('shell', NOW - 1000, { status: 'err', endedAt: NOW - 900 })
  const first = boardOf([message, call('shell', NOW - 5000), fault], { faults: { shell: 1 } })
  const at = (cells: Cells) => windows(cells, walls(cells)[0]!)[0]![1]
  expect(at(draw(first, NOW - 900 + 50, 60, 30, DARK, memory))).toBe(mix(RED, 0xffffff, 0.35))
  expect(at(draw(first, NOW, 60, 30, DARK, memory))).toBe(RED)
  const again = boardOf([message, call('shell', NOW - 5000), fault, call('you', NOW + 1000, { from: 'inbound' })], { faults: {} })
  const after = draw(again, NOW + 2000, 60, 30, DARK, memory)
  expect(at(after)).toBe(mix(RED, 0x000000, 0.53))
  expect(glyph(after, walls(after)[0]! + 1, 25)).not.toBe('▄')
  expect(after.fg(find(after, 'Shell', 28)!.x, 28)).toBe(inkFor(DARK).dim)
})

test('the view keeps its own ledger: a call the board has let go keeps its light, and a reload shows it as an ember', () => {
  // A hundred reads a minute ago; the board keeps the newest eighty.
  const all = Array.from({ length: 100 }, (_, i) => call('files', NOW - 61_000 + i))
  const counts = { files: 100 }
  const early: Board = { entries: all.slice(0, 80), counts: { files: 80 } }
  const late: Board = { entries: all.slice(20), counts }
  const memory = city.memory()
  draw(early, NOW - 30_000, 72, 30, DARK, memory)
  const kept = draw(late, NOW, 72, 30, DARK, memory)
  const evening = rgb('#b88a58')
  expect(windows(kept, walls(kept)[0]!)[0]).toEqual([evening, evening, evening, evening, evening])
  const reloaded = draw(late, NOW, 72, 30)
  expect(windows(reloaded, walls(reloaded)[0]!)[0]).toEqual([WARM_EMBER, WARM_EMBER, WARM_EMBER, WARM_EMBER, WARM_EMBER])
  expect(windows(reloaded, walls(reloaded)[0]!)[4]).toEqual([evening, evening, evening, evening, evening])
})

test('a board of eighty rows and a long day of calls: a window stands for several, and the city keeps under the sky', () => {
  const entries = Array.from({ length: 80 }, (_, i) => call(LOTS[i % 8]!, NOW - 80_000 + i * 1000))
  const board: Board = { entries, counts: { files: 400, shell: 120, memory: 30, web: 25, browser: 9, agents: 4, skills: 12, hooks: 40, model: 300 }, context: 64 }
  for (const [columns, rows] of [[60, 30], [40, 16], [72, 30]] as const) {
    const cells = draw(board, NOW, columns, rows)
    const legend = cells.lines()[0]!
    expect(legend).toMatch(/^▖=\d+/)
    const top = rows >= 22 ? 5 : 4
    for (const wall of walls(cells)) expect(cells.rows - 4 - windows(cells, wall).length + 1).toBeGreaterThanOrEqual(top)
  }
  expect(draw(board).lines()[0]!.startsWith('▖=5')).toBe(true)
})

test('when a window comes to stand for more calls, the buildings settle to their new height over a second', () => {
  const memory = city.memory()
  const reads = (n: number) => boardOf(Array.from({ length: n }, (_, i) => call('files', NOW - 120_000 + i)))
  const height = (cells: Cells) => windows(cells, walls(cells)[0]!).length
  expect(height(draw(reads(80), NOW, 60, 30, DARK, memory))).toBe(20)
  const more = reads(100)
  expect(height(draw(more, NOW + 10, 60, 30, DARK, memory))).toBe(20)
  const midway = height(draw(more, NOW + 500, 60, 30, DARK, memory))
  expect(midway).toBeLessThan(20)
  expect(midway).toBeGreaterThan(13)
  expect(city.nextFrameIn(more, NOW + 500, { columns: 60, rows: 30 }, DARK, memory, undefined)).toBe(FASTEST_MS)
  const settled = draw(more, NOW + 1200, 60, 30, DARK, memory)
  expect(height(settled)).toBe(13)
  expect(settled.lines()[0]!.startsWith('▖=2')).toBe(true)
})

test('moments: a run of light down the street, a firework for the answer, a cloud over the moon while compacting', () => {
  const message = boardOf([call('you', NOW - 1000, { from: 'inbound' })])
  const street = draw(message).lines()[27]!
  expect(street.includes('▀')).toBe(true)
  expect(draw(message, NOW + 3000).lines()[27]).toBe('▔'.repeat(60))

  const done = boardOf([call('files', NOW - 5000), call('you', NOW - 800, { mark: 'done', label: 'answer ready' })])
  const burst = draw(done).lines().slice(0, 10).join('')
  expect([...burst].filter(c => c >= '⠀' && c <= '⣿').length).toBeGreaterThan(10)

  const compacting = boardOf([running('model', NOW - 1000, { label: DARK.t.compacting })], { context: 95 })
  const lines = Array.from({ length: 4 }, (_, k) => draw(compacting, NOW + k * 1000).lines()[3]!)
  expect(lines.some(l => /[▂▄▅▆▇]/.test(l))).toBe(true)
  // Red: the context window is nearly full.
  expect(draw(compacting).fg(56, 2)).toBe(RED)
})

test('every size from 40x16 to 72x30, on cells of any shape, holds the whole city', () => {
  const board = busy()
  for (const cellShape of [2, 2.4, 3]) {
    const setup = setupOf({ cellShape })
    for (const [columns, rows] of [[40, 16], [72, 16], [40, 30], [72, 30], [60, 30], [53, 21]] as const) {
      const cells = draw(board, NOW, columns, rows, setup)
      expect([cells.columns, cells.rows]).toEqual([columns, rows])
      for (let i = 0; i < cells.words.length; i += 3) expect(isWidth1(cells.words[i]!)).toBe(true)
      expect(cells.lines()[rows - 3]).toBe('▔'.repeat(columns))
      expect(walls(cells).length).toBe(8)
      const pitch = (walls(cells)[1]! - walls(cells)[0]!) * 2 - 1
      for (const lot of LOTS) expect(find(cells, cut(setup.t.stations[lot], pitch), rows - 2)).toBeDefined()
      // The moon keeps round: as many columns as its rows are tall in column widths.
      const moon = cells.lines()[rows >= 22 ? 2 : 1]!.replace(/[^\u2580-\u259f]/g, '').length
      expect(moon).toBe(Math.round((rows >= 22 ? 3 : 2) * cellShape))
    }
  }
})

test('nothing makes it throw: odd sizes, odd numbers, calls from the future', () => {
  const odd: Board = {
    entries: [call('files', NOW + 60_000), running('shell', NOW + 10), call('memory', Number.NaN), call('you', NOW, { status: 'err' })],
    counts: { files: -3, shell: 1e9 },
    context: Number.NaN,
    agents: Array.from({ length: 12 }, (_, i) => `a${i}`),
    faults: { shell: 40 },
    switchedAt: NOW,
  }
  for (const [columns, rows] of [[0, 0], [1, 1], [12, 5], [39, 15], [200, 90]] as const) {
    expect(() => draw(odd, NOW, columns, rows)).not.toThrow()
    expect(() => city.nextFrameIn(odd, NOW, { columns, rows }, DARK, city.memory(), 33)).not.toThrow()
  }
  expect(() => draw({ ...odd, counts: { files: Number.NaN, model: Number.POSITIVE_INFINITY, web: 2.5 } })).not.toThrow()
  const crowd = draw(odd)
  expect(find(crowd, '+4')).toBeDefined()
  expect(find(crowd, '9+')).toBeDefined()
})

test('with the person at the bottom the city is the same: the street is always theirs', () => {
  const top = draw(busy())
  const bottom = draw(busy(), NOW, 60, 30, setupOf({ layout: 'you-bottom' }))
  expect(bottom.lines()).toEqual(top.lines())
  expect([...bottom.words]).toEqual([...top.words])
})

test('on a light theme the buildings stand as ink on paper, and the washes are light', () => {
  const light = setupOf({ theme: 'light' })
  const ink = inkFor(light)
  const cells = draw(busy(), NOW, 60, 30, light)
  const [, files, , web] = walls(cells)
  expect(luminance(cells.bg(files! + 1, 26))).toBeLessThan(0.25)
  expect(cells.fg(find(cells, 'Browser', 28)!.x, 28)).toBe(ink.dim)
  expect(cells.fg(find(cells, 'Network', 28)!.x, 29)).toBe(ink.bone)
  const beam = cells.bg(web! + 2, 10)
  expect(beam).not.toBe(DEFAULT)
  expect(luminance(beam)).toBeGreaterThan(0.6)
  expect(cells.fg(0, 27)).toBe(ink.line)
})

test('the stations are named in each language, cut to the room they have', () => {
  for (const language of ['en', 'ru', 'es', 'fr', 'de', 'it']) {
    const setup = setupOf({ language })
    expect(setup.t).toBe(stringsFor(language))
    for (const [columns, rows] of [[60, 30], [40, 16]] as const) {
      const cells = draw(busy(), NOW, columns, rows, setup)
      const room = columns === 40 ? 9 : 13
      for (const lot of LOTS) expect(find(cells, cut(setup.t.stations[lot], room), rows - 2)).toBeDefined()
    }
  }
  expect(find(draw(busy(), NOW, 40, 16, setupOf({ language: 'fr' })), 'Navigate…')).toBeDefined()
})

// ---- when it moves ------------------------------------------------------------------------------

test('the next frame: soon while something flies, steady while calls run, slower at rest, never without endless at rest', () => {
  const size = { columns: 60, rows: 30 }
  const next = (board: Board, endless: number | undefined, now = NOW) => city.nextFrameIn(board, now, size, DARK, city.memory(), endless)

  // A message runs down the street.
  expect(next(boardOf([call('you', NOW - 500, { from: 'inbound' })]), undefined)).toBe(FASTEST_MS)
  // A call runs: its window flickers and its beam shimmers ten times a second, while the endless count.
  const working = boardOf([running('files', NOW - 2000)])
  expect(next(working, 33)).toBe(100)
  expect(next(working, 5000)).toBe(5000)
  // Long after the last call: the stars twinkle once a second while endless animations count, and nothing moves without them.
  const night = boardOf([...Array.from({ length: 9 }, (_, i) => call('model', NOW - 3_600_000 + i)), call('files', NOW - 3_600_000)])
  expect(next(night, 33)).toBe(1000)
  expect(next(night, undefined)).toBeUndefined()
  // A few minutes after: four times a second, and the windows still cooling ask for a frame when they next change colour.
  const evening = boardOf([call('model', NOW - 120_000), call('files', NOW - 120_000)])
  expect(next(evening, 33)).toBe(250)
  const step = next(evening, undefined)!
  expect(step).toBeGreaterThan(1000)
  expect(step).toBeLessThan(90_000)
})

test('a busy frame takes well under five milliseconds to draw, in few colours', () => {
  const board = busy()
  const memory = city.memory()
  const size = { columns: 72, rows: 30 }
  for (let i = 0; i < 30; i++) city.draw(board, NOW + i * 33, size, DARK, memory)
  const runs = 300
  let most = 0
  const t0 = performance.now()
  for (let i = 0; i < runs; i++) {
    const cells = city.draw(board, NOW + i * 33, size, DARK, memory)
    city.nextFrameIn(board, NOW + i * 33, size, DARK, memory, 33)
    if (i % 30 === 0) most = Math.max(most, pairsOf(cells))
  }
  const ms = (performance.now() - t0) / runs
  console.log(`city: ${ms.toFixed(3)} ms a frame at 72x30, ${most} colour pairs at most`)
  expect(ms).toBeLessThan(5)
  expect(most).toBeLessThan(400)
})

test('in the pane the city moves while something does and stops when nothing does', { options: { terminalView: 'city' }, timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const frames: Uint32Array[] = []
  on('ui.blit', (_, e) => {
    frames.push(new Uint32Array(fromBase64('cells' in e ? e.cells : '').buffer))
    return { value: {} }
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Read', file_path: '/a/b/c.py' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const raster = await ui.find({ type: 'Raster' })
  expect([raster?.props.columns, raster?.props.rows]).toEqual([60, 30])
  // The read's beam falls away: thirty frames a second.
  await clock.advance(1000)
  expect(frames.length).toBeGreaterThanOrEqual(25)
  expect(frames[0]!.length).toBe(60 * 30 * 3)
  // Then only its window cooling, a step at a time, until it is an ember; then nothing.
  await clock.advance(1000)
  const fallen = frames.length
  await clock.advance(30 * 60_000)
  expect(frames.length - fallen).toBeLessThan(20)
  const embers = frames.length
  await clock.advance(10 * 60_000)
  expect(frames.length).toBe(embers)
  await ui.unmount()
})

test('in the pane the stars twinkle a few times a second at rest, not thirty', { options: { terminalView: 'city' }, timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let frames = 0
  on('ui.blit', () => {
    frames++
    return { value: {} }
  })
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [] } as never
  })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void _

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(3000)
  const settled = frames
  await clock.advance(2000)
  expect(frames - settled).toBeGreaterThanOrEqual(6)
  expect(frames - settled).toBeLessThanOrEqual(12)
  await ui.unmount()
})
