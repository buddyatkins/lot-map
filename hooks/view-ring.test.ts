import { expect, mock, test } from 'claude-code/testing'

import type { Board, Entry, StationId } from '../types'
import { Cells, DEFAULT, inkFor, isWidth1 } from './cells'
import { TRAIL_FADE_MS, TRAIL_HOLD_MS, setupFrom } from './map'
import type { Setup } from './map'
import { FASTEST_MS, fromBase64 } from './raster'
import { stringsFor } from './text'
import { ring } from './view-ring'

// The test runner has a console, though a hooks module has none: the draw time goes to the test's output.
declare const console: { log: (...args: unknown[]) => void }

const NOW = 1_000_000_000
const ICONS = '@▣∴≡$⊕⊟Ψ↯⌡'
const PANE = {
  plugin: 'lot-map',
  component: 'Pane',
  requestId: 'lot-map',
  props: { title: 'Map', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** The setup a terminal view is given: a theme of its own, and the terminal's background. */
const terminal = (options: Record<string, unknown> = {}): Setup => {
  const setup = setupFrom(options)
  return { ...setup, theme: setup.theme === 'light' ? 'light' : 'dark', background: 'transparent' }
}
const DARK = terminal()
const ink = inkFor(DARK)

let id = 0
/** An action `ago` ms before NOW that took `took` ms, or runs still. */
const act = (station: StationId, ago: number, took?: number, extra: Partial<Entry> = {}): Entry => ({
  id: `e${id++}`,
  station,
  label: station,
  from: 'core',
  startedAt: NOW - ago,
  ...(took === undefined ? { status: 'run' as const } : { endedAt: NOW - ago + took, status: 'ok' as const }),
  ...extra,
})

const QUIET: Board = {
  entries: [act('you', 300_000, 0, { from: 'inbound' }), act('files', 290_000, 300), act('shell', 280_000, 4000), act('you', 270_000, 0, { mark: 'done' })],
  counts: { you: 2, model: 9, memory: 3, files: 7, shell: 4, web: 1, hooks: 2 },
  pushed: 1,
  context: 23,
  model: 'claude-opus-5-5',
}

/** Calls running on several stations, a subagent at work, a fault, a memory record nobody asked for, a model just changed. */
const BUSY: Board = {
  entries: [
    ...QUIET.entries,
    act('you', 100_000, 0, { from: 'inbound' }),
    act('shell', 95_000, undefined, { label: 'npm test' }),
    act('agents', 30_000, undefined, { label: 'explore' }),
    act('model', 6000, undefined),
    act('web', 1500, 300, { status: 'err' }),
    act('files', 400, undefined),
    act('files', 380, undefined),
    act('files', 300, undefined, { from: 'agents', agentId: 'a1' }),
    act('memory', 200, 0, { from: 'inbound' }),
  ],
  counts: { you: 3, model: 12, memory: 4, files: 10, shell: 5, web: 2, agents: 1, hooks: 2 },
  pushed: 2,
  faults: { web: 1 },
  agents: ['a1'],
  context: 47,
  model: 'claude-sonnet-5',
  switchedAt: NOW - 1000,
}

/** Every label at its longest. */
const WORST: Board = {
  entries: [
    act('files', 20_000),
    act('files', 20_000),
    act('files', 20_000),
    act('browser', 905_000),
    act('browser', 905_000),
    act('agents', 3_700_000),
    act('agents', 3_700_000),
  ],
  counts: { you: 12, model: 140, memory: 37, files: 212, shell: 88, web: 9, browser: 14, agents: 6, skills: 3, hooks: 21 },
  faults: { shell: 3, web: 12, browser: 2 },
  pushed: 5,
  context: 66,
  model: 'claude-sonnet-4-5',
  agents: ['a', 'b', 'c'],
}

const draw = (board: Board, size: [number, number] = [60, 30], setup: Setup = DARK, now = NOW): Cells => ring.draw(board, now, { columns: size[0], rows: size[1] }, setup, ring.memory())

/** Where a text first stands, as [column, row]; every glyph the ring draws is one UTF-16 unit, so an index is a column. */
const where = (cells: Cells, text: string): [number, number] | undefined => {
  const lines = cells.lines()
  const row = lines.findIndex(l => l.includes(text))
  return row < 0 ? undefined : [lines[row]!.indexOf(text), row]
}
const count = (cells: Cells, glyph: string): number => cells.lines().join('').split(glyph).length - 1
const isDots = (cp: number): boolean => cp >= 0x2800 && cp <= 0x28ff

/** The colours of every cell holding braille, with how many. */
const dotColours = (cells: Cells): Map<number, number> => {
  const out = new Map<number, number>()
  for (let y = 0; y < cells.rows; y++) for (let x = 0; x < cells.columns; x++) if (isDots(cells.glyph(x, y))) out.set(cells.fg(x, y), (out.get(cells.fg(x, y)) ?? 0) + 1)
  return out
}

const pairsOf = (cells: Cells): number => {
  const pairs = new Set<string>()
  for (let i = 0; i < cells.words.length; i += 3) pairs.add(`${cells.words[i + 1]} ${cells.words[i + 2]}`)
  return pairs.size
}

test('at rest the ring has every station round the core, each name outside its node, and the core says whose it is', () => {
  const cells = draw({ entries: [], counts: {} })
  const names = stringsFor('en').stations
  for (const icon of ICONS) expect(count(cells, icon), icon).toBe(1)
  expect(where(cells, 'C L A U D E')).toBeDefined()
  const core = where(cells, 'C L A U D E')![1]
  const [, youRow] = where(cells, '@')!
  const [, netRow] = where(cells, '⊕')!
  expect(youRow).toBeLessThan(core)
  expect(netRow).toBeGreaterThan(core)
  // The upper half's names stand over their nodes, the lower half's under them.
  expect(where(cells, names.you)![1]).toBeLessThan(youRow)
  expect(where(cells, names.web)![1]).toBeGreaterThan(netRow)
  for (const id of Object.keys(names) as StationId[]) expect(where(cells, names[id]), id).toBeDefined()
  // No model and no context yet: the core holds its name alone, and no count is shown.
  expect(cells.lines().join('')).not.toMatch(/\d/)
  // Spokes and outlines in braille, in their quiet colours.
  const colours = dotColours(cells)
  expect(colours.size).toBeLessThanOrEqual(2)
  for (const colour of colours.keys()) expect([ink.ash, ink.bone, ink.accent]).not.toContain(colour)
})

test('a quiet board shows its counts, memory\'s pushed records in its own colour, the context and the model', () => {
  const cells = draw(QUIET)
  expect(where(cells, 'Model 9')).toBeDefined()
  const [x, y] = where(cells, 'Memory 2 ↓1')!
  expect(cells.fg(x, y)).toBe(ink.ash)
  expect(cells.fg(x + 9, y)).toBe(ink.mem)
  expect(cells.fg(x + 7, y)).toBe(ink.dim)
  const [px, py] = where(cells, '23%')!
  expect(cells.fg(px, py)).toBe(ink.dim)
  expect(where(cells, 'opus 5.5')![1]).toBe(py + 2)
  // The context ring: an arc of the words' grey, a quarter of the way round.
  expect(dotColours(cells).get(ink.ash)).toBeGreaterThan(2)
  // Memory has a count, so its icon is in memory's colour; the rest idle in grey.
  const [mx, my] = where(cells, '∴')!
  expect(cells.fg(mx, my)).toBe(ink.mem)
  const [fx, fy] = where(cells, '≡')!
  expect(cells.fg(fx, fy)).toBe(ink.ash)
})

test('a busy board shows what runs, how many and for how long, what went wrong, what came unasked and the model that changed', () => {
  const cells = draw(BUSY)
  // Network failed a moment ago: a red cross, its fault on a red badge before its name, the name in full white.
  const [nx, ny] = where(cells, '✕')!
  expect(cells.fg(nx, ny)).toBe(ink.red)
  const [bx, by] = where(cells, '▐1▌ Network 2')!
  expect([cells.fg(bx, by), cells.bg(bx + 1, by), cells.fg(bx + 1, by), cells.fg(bx + 2, by)]).toEqual([ink.red, ink.red, ink.ground, ink.red])
  expect(cells.fg(bx + 4, by)).toBe(ink.bone)
  expect(count(cells, '⊕')).toBe(0)
  // Three reads at once (one a subagent's), and a command running for a minute and a half.
  const [fx, fy] = where(cells, 'Files 10 ×3')!
  expect(cells.fg(fx + 9, fy)).toBe(ink.hot)
  const [sx, sy] = where(cells, 'Shell 5 1m')!
  expect(cells.fg(sx + 8, sy)).toBe(ink.hot)
  // A running station glows behind its icon.
  const [ix, iy] = where(cells, '$')!
  expect(cells.fg(ix, iy)).toBe(ink.hot)
  expect(cells.bg(ix, iy)).not.toBe(DEFAULT)
  expect(cells.bg(ix - 1, iy)).toBe(cells.bg(ix, iy))
  // A record a hook brought: counted apart, in memory's colour, and the icon lit.
  const [mx, my] = where(cells, '↓2')!
  expect(cells.fg(mx, my)).toBe(ink.mem)
  const [ax, ay] = where(cells, '∴')!
  expect(cells.fg(ax, ay)).toBe(ink.memHot)
  // The model changed a second ago: its name in the hot colour, and rings going out in white.
  const [ox, oy] = where(cells, 'sonnet 5')!
  expect(cells.fg(ox, oy)).toBe(ink.hot)
  // The colours of things in flight: a pulse's head in the hot colour, a subagent's crew too.
  expect(dotColours(cells).get(ink.hot)).toBeGreaterThan(3)
  expect(ring.nextFrameIn(BUSY, NOW, { columns: 60, rows: 30 }, DARK, ring.memory(), undefined)).toBe(FASTEST_MS)
})

test('a subagent at work circles the agents station, and its calls fly from there along a curve', () => {
  const board: Board = { entries: [act('agents', 30_000), act('files', 300, undefined, { from: 'agents', agentId: 'a1' })], counts: { agents: 1, files: 1 }, agents: ['a1'] }
  const alone: Board = { entries: [], counts: { agents: 1, files: 1 } }
  const [ax, ay] = where(draw(alone), 'Ψ')!
  const hotNear = (cells: Cells): number => {
    let n = 0
    for (let y = ay - 3; y <= ay + 3; y++) for (let x = ax - 6; x <= ax + 6; x++) if (isDots(cells.glyph(x, y)) && cells.fg(x, y) === ink.hot) n++
    return n
  }
  // A bead two dots square: in one cell or a few, and only while the subagent runs.
  const crew = hotNear(draw({ ...alone, agents: ['a1'] })) - hotNear(draw(alone))
  expect(crew).toBeGreaterThanOrEqual(1)
  expect(crew).toBeLessThanOrEqual(4)
  // Its call to Files flies from Agents, under the core: a hot head below the core's row.
  const cells = draw(board)
  const core = where(cells, 'C L A U D E')![1]
  let below = 0
  for (let y = core + 1; y < cells.rows; y++) for (let x = ax + 6; x < cells.columns - 6; x++) if (isDots(cells.glyph(x, y)) && cells.fg(x, y) === ink.hot) below++
  expect(below).toBeGreaterThan(0)
})

test('every size from 40×16 to 72×30, on cells of any shape and either way up, holds the whole ring with nothing over a node', () => {
  for (const [columns, rows] of [[40, 16], [72, 16], [40, 30], [72, 30], [48, 21], [60, 20], [60, 30]] as const) {
    for (const cellShape of [2, 2.4, 3]) {
      for (const layout of ['you-top', 'you-bottom']) {
        const setup = terminal({ cellShape, layout })
        for (const board of [WORST, BUSY, { entries: [], counts: {} }]) {
          const cells = ring.draw(board, NOW, { columns, rows }, setup, ring.memory())
          const what = `${columns}×${rows} on ${cellShape} ${layout}`
          expect([cells.columns, cells.rows], what).toEqual([columns, rows])
          for (let i = 0; i < cells.words.length; i += 3) expect(isWidth1(cells.words[i]!), what).toBe(true)
          // Each icon (or the cross that stands for one) once, and every station's name.
          const shown = [...ICONS].filter(icon => count(cells, icon) === 1).length + count(cells, '✕')
          expect(shown, what).toBe(10)
          for (const name of Object.values(stringsFor('en').stations)) expect(where(cells, name), `${what}: ${name}`).toBeDefined()
          expect(where(cells, 'CLAUDE') ?? where(cells, 'C L A U D E'), what).toBeDefined()
        }
      }
    }
  }
})

test('a short pane draws the compact ring: one-row nodes, labels beside them, the name unspaced', () => {
  const cells = draw(QUIET, [40, 16])
  expect(where(cells, 'CLAUDE')).toBeDefined()
  const [x, y] = where(cells, '@')!
  // The node's sides are braille in the cells either side of its icon.
  expect(isDots(cells.glyph(x - 1, y)) && isDots(cells.glyph(x + 1, y))).toBe(true)
  expect(where(cells, 'You 2')![1]).toBe(y - 1)
})

test('with You at the bottom the ring is turned: the network on top, You under the core, its name under it', () => {
  const cells = draw(QUIET, [60, 30], terminal({ layout: 'you-bottom' }))
  const core = where(cells, 'C L A U D E')![1]
  const [, you] = where(cells, '@')!
  expect(you).toBeGreaterThan(core)
  expect(where(cells, '⊕')![1]).toBeLessThan(core)
  expect(where(cells, 'You 2')![1]).toBeGreaterThan(you)
  expect(where(cells, 'Network 1')![1]).toBeLessThan(where(cells, '⊕')![1])
})

test('the light theme draws in its own colours, on the terminal\'s own background', () => {
  const light = terminal({ theme: 'light' })
  const paper = inkFor(light)
  const cells = draw(BUSY, [60, 30], light)
  const [x, y] = where(cells, 'Hooks 2')!
  expect(cells.fg(x, y)).toBe(paper.ash)
  expect(cells.bg(x, y)).toBe(DEFAULT)
  const [cx, cy] = where(cells, '✕')!
  expect(cells.fg(cx, cy)).toBe(paper.red)
  for (const colour of dotColours(cells).keys()) expect(Object.values(ink)).not.toContain(colour)
  // A ground colour of the person's own is the ground of every cell.
  const own = { ...setupFrom({ colors: ['background=#123456'] }), theme: 'dark' as const, background: 'solid' as const }
  expect(draw(QUIET, [60, 30], own).bg(0, 0)).toBe(0x123456)
})

test('labels speak every language, and say less when the room runs out: the count goes first, the name never', () => {
  for (const lang of ['en', 'ru', 'es', 'fr', 'de', 'it']) {
    const cells = draw(WORST, [48, 21], terminal({ language: lang }))
    for (const name of Object.values(stringsFor(lang).stations)) expect(where(cells, name), `${lang}: ${name}`).toBeDefined()
  }
  // A long call's time in the letters of the language.
  expect(where(draw(WORST, [72, 30], terminal({ language: 'ru' })), 'Агенты 6 ×2 1ч01')).toBeDefined()
  expect(where(draw(WORST, [72, 30], terminal({ language: 'de' })), 'Agenten 6 ×2 1h01')).toBeDefined()
  // At full width every label is whole; in a narrow pane Browser's, which shares its row with Network's node, loses its count.
  expect(where(draw(WORST, [72, 30]), '▐2▌ Browser 14 ×2 15m')).toBeDefined()
  const narrow = draw(WORST, [40, 30])
  expect(where(narrow, 'Browser 14')).toBeUndefined()
  expect(where(narrow, '▐2▌ Browser ×2')).toBeDefined()
  expect(where(narrow, 'Agents 6 ×2 1h01')).toBeDefined()
})

test('a board of 80 entries draws whole, the same from a fresh memory as from a used one', () => {
  const stations: StationId[] = ['files', 'shell', 'model', 'memory', 'web', 'files', 'hooks', 'skills']
  const entries = Array.from({ length: 80 }, (_, k) => act(stations[k % stations.length]!, (80 - k) * 700, k % 9 === 0 ? undefined : 200, k % 13 === 0 ? { status: 'err' } : {}))
  const board: Board = { entries, counts: { files: 400, shell: 90, model: 300, memory: 40, web: 30, hooks: 12, skills: 8 }, context: 81, model: 'claude-opus-5-5', faults: { files: 3 } }
  const used = ring.memory()
  for (let t = -2000; t < 0; t += 100) ring.draw(board, NOW + t, { columns: 72, rows: 30 }, DARK, used)
  const again = ring.draw(board, NOW, { columns: 72, rows: 30 }, DARK, used)
  const fresh = draw(board, [72, 30])
  expect(again.toBase64()).toBe(fresh.toBase64())
  expect(where(fresh, '81%')).toBeDefined()
  expect(count(fresh, '✕')).toBeGreaterThan(0)
})

test('draw never throws, whatever the box and whatever the board', () => {
  const odd = [
    { entries: [], counts: {} },
    { entries: [{ id: 'x', station: 'nowhere', label: '', from: 'core', startedAt: Number.NaN, status: 'run' }], counts: { files: -3 } },
    { entries: [act('files', -5000), act('shell', 10, undefined, { endedAt: Number.POSITIVE_INFINITY })], counts: { files: 1e12 }, context: 400, faults: { files: 1000 }, pushed: -2 },
    { ...WORST, model: '' },
  ] as unknown as Board[]
  for (const [columns, rows] of [[0, 0], [1, 1], [12, 5], [39, 15], [40, 16], [200, 90]] as const) {
    for (const board of odd) {
      const memory = ring.memory()
      const cells = ring.draw(board, NOW, { columns, rows }, DARK, memory)
      expect([cells.columns, cells.rows]).toEqual([columns, rows])
      ring.nextFrameIn(board, NOW, { columns, rows }, DARK, memory, 33)
    }
  }
})

test('the context ring runs down at a compaction rather than jumping, in the colour of how full it is', () => {
  const memory = ring.memory()
  const at = (context: number, t: number): Cells => ring.draw({ ...QUIET, context }, NOW + t, { columns: 60, rows: 30 }, DARK, memory)
  const full = at(92, 0)
  expect(dotColours(full).get(ink.red)).toBeGreaterThan(10)
  expect(where(at(18, 100), '92%')).toBeDefined()
  const percent = (cells: Cells): number => Number(/(\d+)%/.exec(cells.lines().join(' '))?.[1])
  const midway = percent(at(18, 400))
  expect(midway).toBeGreaterThan(18)
  expect(midway).toBeLessThan(92)
  expect(ring.nextFrameIn({ ...QUIET, context: 18 }, NOW + 400, { columns: 60, rows: 30 }, DARK, memory, undefined)).toBe(FASTEST_MS)
  expect(percent(at(18, 700))).toBe(18)
  expect(dotColours(at(75, 800)).get(ink.accent)).toBeGreaterThan(10)
})

test('the route is drawn between the stations the main loop went through, held, then faded away', () => {
  const route: Board = { entries: [act('files', 10_000, 200), act('shell', 9000, 300)], counts: { files: 1, shell: 1 } }
  const dots = (t: number): number => [...dotColours(draw(route, [60, 30], DARK, NOW + t)).values()].reduce((a, b) => a + b, 0)
  const held = dots(TRAIL_HOLD_MS - 10_000)
  const fading = dots(TRAIL_HOLD_MS + TRAIL_FADE_MS / 2 - 9000)
  const gone = dots(TRAIL_HOLD_MS + TRAIL_FADE_MS)
  expect(held).toBeGreaterThan(gone + 5)
  expect(fading).toBe(held)
  const memory = ring.memory()
  ring.draw(route, NOW, { columns: 60, rows: 30 }, DARK, memory)
  // Held for forty seconds from when the loop got to Shell: the next frame is when the fading starts.
  expect(ring.nextFrameIn(route, NOW + 20_000, { columns: 60, rows: 30 }, DARK, memory, undefined)).toBe(TRAIL_HOLD_MS - 29_000)
  expect(ring.nextFrameIn(route, NOW + TRAIL_HOLD_MS + TRAIL_FADE_MS, { columns: 60, rows: 30 }, DARK, memory, undefined)).toBeUndefined()
})

test('the next frame comes soon while something flies, at the pace of what is endless only when asked, and never at rest', () => {
  const size = { columns: 60, rows: 30 }
  const next = (board: Board, t: number, endless: number | undefined): number | undefined => ring.nextFrameIn(board, NOW + t, size, DARK, ring.memory(), endless)
  const read: Board = { entries: [act('files', 0, 300)], counts: { files: 1 } }
  expect(next(read, 100, undefined)).toBe(FASTEST_MS)
  // Landed and back: the glow fades in eight steps over 3.2 s, a frame each.
  const glowing = next(read, 2000, undefined)!
  expect(glowing).toBeGreaterThan(FASTEST_MS)
  expect(glowing).toBeLessThanOrEqual(400)
  // At rest: nothing without `endless`; with it, the core's breath, whose shade takes a step every 190 ms at the quickest.
  expect(next(read, 10_000, undefined)).toBeUndefined()
  let t = 10_000 + next(read, 10_000, 33)!
  for (let k = 0; k < 30; k++) {
    const wait = next(read, t, 33)!
    expect(wait).toBeGreaterThanOrEqual(190)
    t += wait
  }
  expect(next(read, 10_000, 5000)).toBe(5000)
  // A background task running for twenty minutes: its hands are endless.
  const task: Board = { entries: [act('shell', 1_200_000, undefined, { task: 't1' })], counts: { shell: 1 } }
  expect(next(task, 0, undefined)).toBeUndefined()
  expect(next(task, 0, 5000)).toBe(5000)
  const quick = next(task, 0, 33)!
  expect(quick).toBeGreaterThanOrEqual(FASTEST_MS)
  expect(quick).toBeLessThan(1000)
})

test('a busy frame at 72×30 draws in well under 5 ms and in a few dozen pairs of colours', () => {
  const memory = ring.memory()
  const size = { columns: 72, rows: 30 }
  const board: Board = {
    ...BUSY,
    entries: [...Array.from({ length: 70 }, (_, k) => act((['files', 'shell', 'model', 'web'] as const)[k % 4]!, 200_000 - k * 2500, 300)), ...BUSY.entries.slice(-10)],
    agents: ['a', 'b', 'c', 'd'],
  }
  let pairs = 0
  for (let k = 0; k < 30; k++) pairs = Math.max(pairs, pairsOf(ring.draw(board, NOW + k * 33, size, DARK, memory)))
  const frames = 300
  const started = performance.now()
  for (let k = 0; k < frames; k++) ring.draw(board, NOW + 1000 + k * 33, size, DARK, memory)
  const each = (performance.now() - started) / frames
  console.log(`ring view: ${each.toFixed(3)} ms a frame at 72×30 on a busy board, ${pairs} pairs of colours at most`)
  expect(each).toBeLessThan(5)
  expect(pairs).toBeLessThan(400)
})

test('with terminalView ring the pane draws the ring, moves while something moves, slows at rest and stops in the end', { options: { terminalView: 'ring' }, timeoutMs: 60_000 }, async ($, on) => {
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
  const words = new Uint32Array(fromBase64(String(raster?.props.cells)).buffer)
  const text = String.fromCodePoint(...Array.from({ length: words.length / 3 }, (_, k) => words[k * 3]!))
  expect(text).toContain('C L A U D E')
  expect(text).toContain('Files 1')
  // The pulse flies out and back: thirty frames a second.
  await clock.advance(1000)
  expect(frames).toBeGreaterThanOrEqual(28)
  expect(last).not.toBe('')
  // Once the glow has gone, only the core's breath moves: a frame for each step of its shade, a dozen or so in its 4.8 s.
  await clock.advance(4000)
  const resting = frames
  await clock.advance(4800)
  expect(frames - resting).toBeGreaterThan(10)
  expect(frames - resting).toBeLessThan(30)
  // Ten minutes after the map last changed, nothing runs and nothing more is drawn.
  await clock.advance(600_000)
  const stopped = frames
  await clock.advance(10_000)
  expect(frames).toBe(stopped)
  await ui.unmount()
})
