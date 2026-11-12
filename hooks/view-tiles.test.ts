import { expect, mock, test } from 'claude-code/testing'

import type { Board, Entry, StationId } from '../types'
import { Cells, DEFAULT, inkFor, isWidth1 } from './cells'
import { STATIONS, setupFrom } from './map'
import type { Setup } from './map'
import { FASTEST_MS, fromBase64 } from './raster'
import { stringsFor } from './text'
import { tiles } from './view-tiles'

// The test runner has a console, though a hooks module has none.
declare const console: { log: (...data: unknown[]) => void }

const NOW = 1_000_000_000
const PANE = {
  plugin: 'lot-map',
  component: 'Pane',
  requestId: 'lot-map',
  props: { title: 'Map', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** The setup a view is drawn with in a terminal: a theme of its own, on the terminal's own background. */
const terminal = (options: Record<string, unknown> = {}): Setup => {
  const setup = setupFrom({ terminalView: 'tiles', ...options })
  return { ...setup, theme: setup.theme === 'light' ? 'light' : 'dark', background: 'transparent' }
}
const DARK = terminal()

let serial = 0
/** A call `ago` ms before NOW that took `took` ms, or is still running without it. */
const call = (station: StationId, label: string, ago: number, took?: number, extra: Partial<Entry> = {}): Entry => ({
  id: `t${serial++}`,
  station,
  label,
  from: 'core',
  startedAt: NOW - ago,
  status: took === undefined ? 'run' : 'ok',
  ...(took === undefined ? {} : { endedAt: NOW - ago + took }),
  ...extra,
})

const countsOf = (entries: Entry[]): Board['counts'] => {
  const counts: Board['counts'] = {}
  for (const e of entries) if (e.mark !== 'switch') counts[e.station] = (counts[e.station] ?? 0) + 1
  return counts
}

const EMPTY: Board = { entries: [], counts: {} }

/** A turn in full swing: calls running on several stations, a subagent at work, a fault, a pushed record, a new model. */
function busy(): Board {
  const entries = [
    call('you', 'new message', 125_000, 0, { from: 'inbound' }),
    call('memory', '1 record: #212', 124_000, 0, { from: 'inbound' }),
    call('files', 'hooks/map.ts', 90_000, 400),
    call('shell', 'Lint the hooks', 30_000, 2000, { status: 'err' }),
    call('model', 'opus 5.5 → sonnet 5', 4000, 0, { mark: 'switch' }),
    call('agents', 'Explore the hooks', 50_000),
    call('files', 'hooks/raster.ts', 20_000, 400, { from: 'agents', agentId: 'a1' }),
    call('files', 'hooks/cells.ts', 2000, undefined, { from: 'agents', agentId: 'a1' }),
    call('shell', 'Run the test suite', 12_000),
    call('model', 'sonnet 5 · step 24', 1500),
  ]
  return {
    entries,
    counts: countsOf(entries),
    pushed: 1,
    faults: { shell: 1 },
    agents: ['a1'],
    model: 'claude-sonnet-5',
    step: 24,
    context: 47,
    switchedAt: NOW - 4000,
  }
}

/** The places of the tiles, as the view lays them out: a 3 by 4 board, the core two rows tall in the middle. */
const SLOTS = [[1, 0], [2, 0], [2, 1], [2, 2], [2, 3], [1, 3], [0, 3], [0, 2], [0, 1], [0, 0]] as const
function tileOf(station: StationId, columns: number, rows: number, layout: Setup['layout'] = 'you-top'): { x: number; y: number; w: number; h: number } {
  const w = Math.floor(columns / 3)
  const h = Math.max(4, Math.min(7, Math.floor(rows / 4)))
  const spare = columns - 3 * w
  const i = STATIONS.findIndex(s => s.id === station)
  const [col, row] = SLOTS[(i + (layout === 'you-bottom' ? 5 : 0)) % 10] ?? [0, 0]
  return { x: spare - Math.floor(spare / 2) + col * w, y: Math.max(0, Math.floor((rows - 4 * h) / 2)) + row * h, w, h }
}

const draw = (board: Board, now = NOW, columns = 60, rows = 30, setup = DARK, memory = tiles.memory()): Cells =>
  tiles.draw(board, now, { columns, rows }, setup, memory)
const glyph = (cells: Cells, x: number, y: number): string => String.fromCodePoint(cells.glyph(x, y))
const text = (cells: Cells): string => cells.lines().join('\n')
const narrow = (cells: Cells): boolean => {
  for (let i = 0; i < cells.words.length; i += 3) if (!isWidth1(cells.words[i] ?? 0)) return false
  return true
}

test('an empty board is ten quiet tiles around the core, and nothing moves but its breath', () => {
  const cells = draw(EMPTY)
  expect(narrow(cells)).toBe(true)
  for (const s of STATIONS) expect(text(cells)).toContain(DARK.t.stations[s.id])
  expect(text(cells)).toContain('C L A U D E')
  // Every tile at rest wears a round rim; the core's is square, and nothing has filled its gauge.
  const shell = tileOf('shell', 60, 30)
  expect(glyph(cells, shell.x, shell.y)).toBe('╭')
  expect(glyph(cells, 20, tileOf('skills', 60, 30).y)).toBe('┌')
  expect(text(cells)).not.toContain('━')
  const size = { columns: 60, rows: 30 }
  const memory = tiles.memory()
  tiles.draw(EMPTY, NOW, size, DARK, memory)
  expect(tiles.nextFrameIn(EMPTY, NOW, size, DARK, memory, undefined)).toBeUndefined()
  // At rest the breath steps slowly: a frame about six times a second, or as seldom as the loop asks.
  expect(tiles.nextFrameIn(EMPTY, NOW, size, DARK, memory, FASTEST_MS)).toBe(150)
  expect(tiles.nextFrameIn(EMPTY, NOW, size, DARK, memory, 5000)).toBe(5000)
  expect(tiles.hidesTally).toBe(true)
})

test('a busy board shows what runs, who works where, what failed and what was pushed', () => {
  const board = busy()
  const cells = draw(board)
  const ink = inkFor(DARK)
  expect(narrow(cells)).toBe(true)
  // Running: heavy rims, with the time so far in the status row.
  const shell = tileOf('shell', 60, 30)
  expect(glyph(cells, shell.x + shell.w - 1, shell.y)).toBe('┓')
  expect(cells.lines()[shell.y + shell.h - 2]).toContain('0:12')
  // The fault since the last message: a red pill on the top rim and a red bar where it failed.
  expect(cells.lines()[shell.y]?.slice(shell.x, shell.x + 5)).toBe('┏━▐1▌')
  expect(cells.fg(shell.x + 3, shell.y)).toBe(ink.raised)
  expect(cells.bg(shell.x + 3, shell.y)).toBe(ink.red)
  const red = [...Array(shell.w).keys()].some(i => cells.fg(shell.x + i, shell.y + shell.h - 3) === ink.red)
  expect(red).toBe(true)
  // A subagent at work on the files: a bead on that tile's top rim and its row in the agents' roster.
  const files = tileOf('files', 60, 30)
  expect(glyph(cells, files.x + files.w - 2, files.y)).toBe('◆')
  const agents = tileOf('agents', 60, 30)
  expect(cells.lines()[agents.y + agents.h - 2]).toMatch(/◆ Files +0:20/)
  // The record a hook pushed: counted apart, and hanging from the top of the memory strip.
  const memory = tileOf('memory', 60, 30)
  expect(cells.lines()[memory.y + 1]).toContain('↓1')
  // The model changed four seconds ago: its name in the core is lit.
  const at = text(cells).split('\n').findIndex(l => l.includes('sonnet 5'))
  const x = cells.lines()[at]?.indexOf('sonnet 5') ?? -1
  expect(cells.fg(x, at)).toBe(ink.hot)
  expect(text(cells)).toContain('◷ 2:05')
  expect(text(cells)).toContain('47%')
})

test('the board fits every size a pane gives it, on cells of any shape', () => {
  for (const [columns, rows] of [[40, 16], [72, 16], [40, 30], [72, 30], [51, 21], [60, 30]] as const) {
    for (const cellShape of [2, 2.4, 3]) {
      const setup = terminal({ cellShape })
      const cells = draw(busy(), NOW + 250, columns, rows, setup)
      expect(narrow(cells)).toBe(true)
      for (const s of STATIONS) expect(text(cells)).toContain(setup.t.stations[s.id].slice(0, 5))
      const you = tileOf('you', columns, rows)
      expect(glyph(cells, you.x, you.y)).toBe('╭')
    }
  }
  // Under 20 rows there is no room for a status row: a running call's time stands in for its count.
  const low = draw(busy(), NOW, 60, 16)
  const shell = tileOf('shell', 60, 16)
  expect(low.lines()[shell.y + 1]).toMatch(/Shell +0:12/)
  // Fifteen calls in ten seconds fill a strip: one row of it up to 23 rows, two from 24, three from 28.
  const burst = Array.from({ length: 15 }, (_, k) => call('files', `f${k}.ts`, 5000 + k * 100, 50))
  const rowsOf = (rows: number): number => {
    const cells = draw({ entries: burst, counts: countsOf(burst) }, NOW, 60, rows)
    const tile = tileOf('files', 60, rows)
    let n = 0
    for (let y = tile.y + 1; y < tile.y + tile.h - 1; y++) if (cells.lines()[y]?.slice(tile.x, tile.x + tile.w).includes('█')) n++
    return n
  }
  expect([rowsOf(16), rowsOf(20), rowsOf(24), rowsOf(28)]).toEqual([1, 1, 2, 3])
  // Nothing throws, at any size at all.
  for (const [columns, rows] of [[0, 0], [1, 1], [17, 5], [200, 80]] as const) expect(draw(busy(), NOW, columns, rows).columns).toBe(columns)
})

test('with the person at the bottom the ring turns by five places', () => {
  const setup = terminal({ layout: 'you-bottom' })
  const cells = draw(busy(), NOW, 60, 30, setup)
  const you = tileOf('you', 60, 30, 'you-bottom')
  const web = tileOf('web', 60, 30, 'you-bottom')
  expect(you.y).toBeGreaterThan(web.y)
  expect(cells.lines()[you.y + 1]).toContain('You')
  expect(cells.lines()[web.y + 1]).toContain('Network')
  expect(cells.lines()[tileOf('model', 60, 30, 'you-bottom').y + 1]?.slice(0, 20)).toContain('Model')
})

test('the light theme draws in its own colours', () => {
  const setup = terminal({ theme: 'light' })
  const ink = inkFor(setup)
  const cells = draw(busy(), NOW, 60, 30, setup)
  const shell = tileOf('shell', 60, 30)
  expect(cells.fg(shell.x + shell.w - 1, shell.y + 2)).toBe(ink.accent)
  expect(cells.fg(shell.x + 2, shell.y + 1)).toBe(ink.bone)
  expect(ink.bone).toBe(0x1f2228)
})

test('a board of 80 entries draws, and the strips keep what scrolled off it', () => {
  const memory = tiles.memory()
  const older = Array.from({ length: 40 }, (_, k) => call('web', `host${k}.example`, 140_000 - k * 1000, 300))
  const newer = Array.from({ length: 80 }, (_, k) => call(k % 2 === 0 ? 'files' : 'shell', `f${k}.ts`, 79_000 - k * 900, 200))
  const first: Board = { entries: [...older, ...newer].slice(-80), counts: countsOf([...older, ...newer]) }
  // The mod saw the older calls before they scrolled off the board.
  draw({ entries: older, counts: countsOf(older) }, NOW - 100_000, 72, 30, DARK, memory)
  const cells = draw(first, NOW, 72, 30, DARK, memory)
  expect(first.entries.length).toBe(80)
  expect(first.entries.some(e => e.station === 'web')).toBe(false)
  const web = tileOf('web', 72, 30)
  const bars = (c: Cells) => [...Array(web.w).keys()].filter(i => '▁▂▃▄▅▆▇█'.includes(glyph(c, web.x + i, web.y + web.h - 3))).length
  expect(bars(cells)).toBeGreaterThan(0)
  // A mod loaded afresh knows only the board.
  expect(bars(draw(first, NOW, 72, 30))).toBe(0)
})

test('labels are cut where they say least: a path at its start, anything else at its end', () => {
  const entries = [call('files', 'a/very/long/path/to/the/content.py', 40_000, 300), call('shell', 'Run the whole end to end suite', 40_000, 300)]
  const cells = draw({ entries, counts: countsOf(entries) })
  const files = tileOf('files', 60, 30)
  const shell = tileOf('shell', 60, 30)
  expect(cells.lines()[files.y + files.h - 2]).toMatch(/…[a-z/]*content\.py +39s/)
  expect(cells.lines()[shell.y + shell.h - 2]).toMatch(/Run the whol?e?… +39s/)
})

test('every language names its tiles, its context and its ages', () => {
  for (const language of ['en', 'ru', 'es', 'fr', 'de', 'it']) {
    const setup = terminal({ language })
    const t = stringsFor(language)
    const entries = [call('shell', 'git status', 30_000, 300)]
    const cells = draw({ entries, counts: countsOf(entries), context: 12 }, NOW, 72, 30, setup)
    for (const s of STATIONS) expect(text(cells)).toContain(t.stations[s.id])
    expect(text(cells)).toContain(`${t.context} 12%`)
    expect(text(cells)).toContain(language === 'ru' ? '29с' : '29s')
  }
})

test('a refusal walls its tile in, an error marks its row, and a background task wears a double rim', () => {
  const entries = [
    call('hooks', 'stopped WebFetch', 2000, 0, { status: 'block' }),
    call('shell', 'Lint the hooks', 2000, 500, { status: 'err' }),
    call('browser', 'Watch the e2e suite', 25 * 60_000, undefined, { task: 'b1' }),
  ]
  const ink = inkFor(DARK)
  const cells = draw({ entries, counts: countsOf(entries), faults: { hooks: 1, shell: 1 } })
  const hooks = tileOf('hooks', 60, 30)
  expect(glyph(cells, hooks.x, hooks.y + 2)).toBe('╏')
  expect(cells.lines()[hooks.y + hooks.h - 2]).toContain('⊘ stopped')
  const shell = tileOf('shell', 60, 30)
  expect(cells.lines()[shell.y + shell.h - 2]).toContain('✕ Lint')
  expect(cells.fg(shell.x + 2, shell.y + shell.h - 2)).toBe(ink.red)
  // Red fades from the tile's body over six seconds.
  expect(cells.bg(shell.x + 1, shell.y + 2)).not.toBe(DEFAULT)
  expect(draw({ entries, counts: countsOf(entries), faults: { hooks: 1, shell: 1 } }, NOW + 6000).bg(shell.x + 1, shell.y + 2)).toBe(DEFAULT)
  const browser = tileOf('browser', 60, 30)
  expect(glyph(cells, browser.x, browser.y)).toBe('╔')
  expect(cells.lines()[browser.y + browser.h - 2]).toContain('25:00')
})

test('the core keeps the turn\'s time, then how long the answer took, and its rim fills as the context does', () => {
  const asked = call('you', 'new message', 95_000, 0, { from: 'inbound' })
  const running = draw({ entries: [asked, call('model', 'opus 5.5 · step 3', 1000)], counts: { you: 1, model: 1 }, context: 50 })
  expect(text(running)).toContain('◷ 1:35')
  const done = draw({ entries: [asked, call('you', 'answer ready', 5000, 0, { mark: 'done' })], counts: { you: 2 }, context: 50 })
  expect(text(done)).toContain('✓ 1:30')
  // Half the context: the heavy line goes from the top middle round to the bottom middle.
  const core = { x: 20, y: tileOf('skills', 60, 30).y, w: 20, h: 14 }
  expect(glyph(done, core.x + 10, core.y)).toBe('━')
  expect(glyph(done, core.x + core.w - 1, core.y + 5)).toBe('┃')
  expect(glyph(done, core.x + 3, core.y + core.h - 1)).toBe('─')
  expect(glyph(done, core.x, core.y + 5)).toBe('│')
})

test('a tile that is used more wears a warmer rim', () => {
  const few = [call('files', 'a.ts', 60_000, 100)]
  const many = Array.from({ length: 60 }, (_, k) => call('files', `f${k}.ts`, 60_000 + k, 100))
  const files = tileOf('files', 60, 30)
  const rim = (entries: Entry[]) => draw({ entries, counts: countsOf(entries) }).fg(files.x, files.y)
  const ink = inkFor(DARK)
  expect(rim(few)).not.toBe(rim(many))
  expect(rim([])).toBe(ink.line)
})

test('a call lights its tile from the core: the core\'s rim flashes, then fronts run round the tile', () => {
  const entries = [call('files', 'hooks/map.ts', 0)]
  const board = { entries, counts: countsOf(entries) }
  const files = tileOf('files', 60, 30)
  const ink = inkFor(DARK)
  // The core's rim facing the tile flashes first.
  const flash = draw(board, NOW + 50)
  const facing = files.y + Math.floor(files.h / 2)
  expect(flash.bg(39, facing)).not.toBe(DEFAULT)
  // Then the fronts set off from the side facing the core: lit cells near it, the far side still at rest.
  const going = draw(board, NOW + 400)
  expect(going.bg(files.x, facing - 1) !== DEFAULT || going.bg(files.x, facing + 2) !== DEFAULT || going.bg(files.x + 2, files.y) !== DEFAULT).toBe(true)
  expect(glyph(going, files.x + files.w - 1, facing)).toBe('│')
  // Once round, the whole rim is heavy and lit.
  const lit = draw(board, NOW + 1500)
  expect(glyph(lit, files.x + files.w - 1, facing)).toBe('┃')
  expect(lit.fg(files.x + files.w - 1, facing)).toBe(ink.accent)
})

test('the answer sends a wave across the board, and a new model rings the core', () => {
  const entries = [call('you', 'answer ready', 0, 0, { mark: 'done' })]
  const board: Board = { entries, counts: countsOf(entries) }
  const memory = tiles.memory()
  const size = { columns: 60, rows: 30 }
  // Half way through, the wave is past the core and on the tiles around it.
  const cells = tiles.draw(board, NOW + 550, size, DARK, memory)
  const tinted = cells.words.filter((w, i) => i % 3 === 2 && w !== DEFAULT).length
  expect(tinted).toBeGreaterThan(20)
  expect(tiles.nextFrameIn(board, NOW + 550, size, DARK, memory, undefined)).toBe(FASTEST_MS)
  const switched: Board = { entries: [], counts: {}, model: 'claude-sonnet-5', switchedAt: NOW }
  const ringing = tiles.draw(switched, NOW + 100, size, DARK, memory)
  expect(ringing.fg(20, tileOf('skills', 60, 30).y)).not.toBe(inkFor(DARK).line)
  expect(tiles.nextFrameIn(switched, NOW + 100, size, DARK, memory, undefined)).toBe(FASTEST_MS)
})

test('the next frame comes soon while something flies, at the beat while a call runs, and at the breath at rest', () => {
  const size = { columns: 60, rows: 30 }
  const at = (board: Board, now: number, endless: number | undefined) => {
    const memory = tiles.memory()
    tiles.draw(board, now, size, DARK, memory)
    return tiles.nextFrameIn(board, now, size, DARK, memory, endless)
  }
  const started = [call('shell', 'npm test', 0)]
  const board = { entries: started, counts: countsOf(started) }
  // A call just started: thirty frames a second while its fronts run, endless or not.
  expect(at(board, NOW + 100, undefined)).toBe(FASTEST_MS)
  // Running: the beat swells at fifteen a second, then waits for the next one; nothing at all once the loop stops asking.
  expect(at(board, NOW + 1400 * 3 + 100, FASTEST_MS)).toBe(66)
  expect(at(board, NOW + 1400 * 3 + 1000, FASTEST_MS)).toBe(100)
  expect(at(board, NOW + 1400 * 3 + 100, undefined)).toBeUndefined()
  // A finished call's glow fades in steps, with or without the endless ones.
  const ended = [call('shell', 'ls', 2000, 100)]
  const glow = at({ entries: ended, counts: countsOf(ended) }, NOW, undefined)
  expect(glow).toBeGreaterThan(FASTEST_MS)
  expect(glow).toBeLessThanOrEqual(3200 / 12)
  expect(at({ entries: ended, counts: countsOf(ended) }, NOW + 5000, undefined)).toBeUndefined()
})

test('a busy frame takes well under 5 ms and well under 400 pairs of colours', () => {
  const memory = tiles.memory()
  const size = { columns: 72, rows: 30 }
  const entries: Entry[] = []
  for (let k = 0; k < 74; k++) {
    const station = STATIONS[k % STATIONS.length]?.id ?? 'files'
    entries.push(call(station, `call ${k}`, 200_000 - k * 2600, 900, k % 13 === 0 ? { status: 'err' } : k % 7 === 0 ? { from: 'agents', agentId: `a${k % 3}` } : {}))
  }
  entries.push(call('you', 'new message', 210_000, 0, { from: 'inbound' }))
  entries.push(call('memory', '2 records', 5000, 0, { from: 'inbound' }))
  entries.push(call('shell', 'npm test', 30_000), call('files', 'a.ts', 500, undefined, { from: 'agents', agentId: 'a1' }), call('model', 'opus 5.5 · step 40', 300))
  entries.push(call('browser', 'watch', 900_000, undefined, { task: 'b1' }))
  const board: Board = {
    entries,
    counts: countsOf(entries),
    pushed: 3,
    faults: { files: 2, shell: 1 },
    agents: ['a0', 'a1', 'a2'],
    model: 'claude-opus-5-5',
    step: 40,
    context: 71,
    switchedAt: NOW - 2000,
  }
  expect(entries.length).toBe(80)
  const frames = 300
  const started = performance.now()
  for (let k = 0; k < frames; k++) tiles.draw(board, NOW + k * 33, size, DARK, memory)
  const each = (performance.now() - started) / frames
  // The most pairs at any moment of the next six seconds: the fronts, the rings, the beats and the fades.
  let pairs = 0
  for (let k = 0; k < 60; k++) {
    const cells = tiles.draw(board, NOW + k * 100, size, DARK, memory)
    const seen = new Set<string>()
    for (let i = 0; i < cells.words.length; i += 3) seen.add(`${cells.words[i + 1]}/${cells.words[i + 2]}`)
    pairs = Math.max(pairs, seen.size)
  }
  console.log(`tiles: ${each.toFixed(3)} ms a frame at 72x30 on a busy board, ${pairs} colour pairs at most`)
  expect(each).toBeLessThan(5)
  expect(pairs).toBeLessThan(400)
})

test('no board breaks it', () => {
  const memory = tiles.memory()
  let seed = 7
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const statuses = ['run', 'ok', 'err', 'block'] as const
  const froms = ['core', 'agents', 'inbound'] as const
  for (let round = 0; round < 60; round++) {
    const entries: Entry[] = Array.from({ length: Math.floor(random() * 90) }, (_, k) => {
      const status = statuses[Math.floor(random() * 4)] ?? 'ok'
      const startedAt = NOW - Math.floor(random() * 400_000) + 2000
      return {
        id: `r${round}-${k}`,
        station: STATIONS[Math.floor(random() * 10)]?.id ?? 'you',
        label: random() < 0.1 ? '' : random() < 0.5 ? 'a/b/' + 'x'.repeat(Math.floor(random() * 80)) : 'Ж中😀 label',
        from: froms[Math.floor(random() * 3)] ?? 'core',
        startedAt,
        status,
        ...(status === 'run' ? {} : { endedAt: startedAt + Math.floor(random() * 5000) }),
        ...(random() < 0.2 ? { agentId: `a${k % 4}` } : {}),
        ...(random() < 0.05 ? { task: `b${k}` } : {}),
        ...(random() < 0.05 ? { mark: random() < 0.5 ? ('switch' as const) : ('done' as const) } : {}),
      }
    })
    const board: Board = {
      entries,
      counts: countsOf(entries),
      pushed: Math.floor(random() * 300),
      faults: { shell: Math.floor(random() * 120) },
      agents: Array.from({ length: Math.floor(random() * 13) }, (_, k) => `a${k}`),
      context: random() * 130 - 10,
      ...(random() < 0.5 ? { model: 'claude-opus-5-5', step: 3, switchedAt: NOW - random() * 9000 } : {}),
    }
    const size = { columns: 40 + Math.floor(random() * 33), rows: 16 + Math.floor(random() * 15) }
    const setup = terminal({ language: ['en', 'ru', 'de'][round % 3], layout: round % 2 === 0 ? 'you-top' : 'you-bottom', theme: round % 4 === 0 ? 'light' : 'dark', coreName: 'ABCDEFGHIJ' })
    const cells = tiles.draw(board, NOW + round * 517, size, setup, memory)
    expect(narrow(cells)).toBe(true)
    const next = tiles.nextFrameIn(board, NOW + round * 517, size, setup, memory, round % 2 === 0 ? FASTEST_MS : undefined)
    if (next !== undefined) expect(next).toBeGreaterThanOrEqual(FASTEST_MS)
  }
})

test('in the pane the tiles move while something moves, keep breathing for a while, and then stop', { options: { terminalView: 'tiles' }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let frames = 0
  let last = ''
  on('ui.blit', (_, e) => {
    frames++
    last = 'cells' in e ? e.cells : ''
    return { value: {} }
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Read', file_path: '/a/b/c.py' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const raster = await ui.find({ type: 'Raster' })
  expect([raster?.props.columns, raster?.props.rows]).toEqual([60, 30])
  // The tiles show the counts, so the tally row under them is left out.
  expect(await ui.find({ type: 'Text', text: /^Files 1$/ })).toBeUndefined()
  // The call's fronts and glow: thirty frames a second at first.
  await clock.advance(1000)
  expect(frames).toBeGreaterThanOrEqual(25)
  const words = new Uint32Array(fromBase64(last).buffer)
  expect(words.length).toBe(60 * 30 * 3)
  // At rest the core breathes, a frame every 150 ms, for ten minutes after the board last changed; then nothing.
  await clock.advance(5000)
  const resting = frames
  await clock.advance(1500)
  expect(frames - resting).toBeGreaterThanOrEqual(8)
  expect(frames - resting).toBeLessThanOrEqual(12)
  await clock.advance(600_000)
  const stopped = frames
  await clock.advance(20_000)
  expect(frames).toBe(stopped)
  await ui.unmount()
})
