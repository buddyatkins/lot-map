import { expect, mock, test } from 'claude-code/testing'

import type { Board, Entry, StationId } from '../types'
import { Cells, DEFAULT, inkFor, isWidth1 } from './cells'
import { setupFrom } from './map'
import type { Setup } from './map'
import { FASTEST_MS, fromBase64 } from './raster'
import { stringsFor } from './text'
import { lanes } from './view-lanes'

// The test runner prints what a test logs, though the hooks' own types have no console.
declare const console: { log: (...parts: unknown[]) => void }

const NOW = 10_000_000
const S = 1000
const LANGUAGES = ['en', 'ru', 'es', 'fr', 'de', 'it'] as const

/** The setup register gives a view: a theme of its own and the terminal's background. */
const setupOf = (options: Record<string, unknown> = {}): Setup => ({
  ...setupFrom({ theme: 'dark', ...options }),
  background: 'transparent',
})
const DARK = setupOf()
const INK = inkFor(DARK)

let serial = 0
/** An entry `ago` seconds old that took `took` seconds, or is running still without it. */
function entry(station: StationId, ago: number, took?: number, extra: Partial<Entry> = {}): Entry {
  return {
    id: `e${serial++}`,
    station,
    label: station,
    from: 'core',
    startedAt: NOW - ago * S,
    ...(took === undefined ? { status: 'run' as const } : { endedAt: NOW - ago * S + took * S, status: 'ok' as const }),
    ...extra,
  }
}
const message = (ago: number): Entry => entry('you', ago, 0, { from: 'inbound', label: 'new message' })
const answer = (ago: number): Entry => entry('you', ago, 0, { mark: 'done', label: 'answer ready' })

type Drawn = { cells: Cells; lines: string[]; nowCol: number }

function draw(board: Board, options: { now?: number; columns?: number; rows?: number; setup?: Setup; memory?: ReturnType<typeof lanes.memory> } = {}): Drawn {
  const cells = lanes.draw(board, options.now ?? NOW, { columns: options.columns ?? 60, rows: options.rows ?? 30 }, options.setup ?? DARK, options.memory ?? lanes.memory())
  const lines = cells.lines()
  // The now edge: the column that holds │ (or ┃, as an answer lands) in the most rows.
  const votes = new Map<number, number>()
  for (const line of lines) [...line].forEach((ch, x) => (ch === '│' || ch === '┃') && votes.set(x, (votes.get(x) ?? 0) + 1))
  const nowCol = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1
  return { cells, lines, nowCol }
}

/** The row of a station's lane: its name two cells right of the now edge. */
const laneRow = (d: Drawn, name: string): number => d.lines.findIndex(line => [...line].slice(d.nowCol + 2).join('').startsWith(`${name} `) || [...line].slice(d.nowCol + 2).join('').trimEnd() === name)
const at = (d: Drawn, x: number, y: number): string => String.fromCodePoint(d.cells.glyph(x, y))
const track = (d: Drawn, y: number): string => [...(d.lines[y] ?? '')].slice(1, d.nowCol).join('')

/** A busy moment: a model step and a command running, a subagent at work, a failed command, a pushed record, a switch. */
function busyBoard(): Board {
  return {
    entries: [
      message(90),
      entry('memory', 90, 0, { from: 'inbound', label: '2 records' }),
      entry('model', 89, 30, { label: 'opus 5.5 · step 1' }),
      entry('model', 58, 0, { mark: 'switch', label: 'opus 4.6 → opus 5.5' }),
      entry('model', 42, undefined, { label: 'opus 5.5 · step 2' }),
      entry('agents', 41, undefined, { label: 'explore auth' }),
      entry('model', 40, 10, { from: 'agents', agentId: 'a1', label: 'opus 5.5 · step 1 · subagent' }),
      entry('files', 3, undefined, { from: 'agents', agentId: 'a1', label: 'src/auth.ts' }),
      entry('shell', 20, 4, { status: 'err', label: 'npm test' }),
      entry('shell', 8, undefined, { label: 'npm run build' }),
      entry('files', 50, 0.2), entry('files', 49, 0.2), entry('hooks', 20.1, 0.1),
    ],
    counts: { you: 1, model: 3, memory: 3, files: 3, shell: 2, hooks: 1, agents: 1 },
    pushed: 2,
    faults: { shell: 1 },
    agents: ['a1'],
    model: 'claude-opus-5-5',
    step: 2,
    context: 34,
    switchedAt: NOW - 58 * S,
  }
}

test('an empty board shows every lane by name, in order, with nothing on it, and asks for no frames', () => {
  const board: Board = { entries: [], counts: {} }
  const d = draw(board)
  const t = stringsFor('en')
  const order: StationId[] = ['you', 'model', 'memory', 'files', 'shell', 'web', 'browser', 'skills', 'hooks', 'agents']
  const rows = order.map(id => laneRow(d, t.stations[id]))
  expect(rows.every(y => y > 0)).toBe(true)
  expect([...rows].sort((a, b) => a - b)).toEqual(rows)
  for (const y of rows) expect(track(d, y).trim()).toBe('')
  // Never used: dim names and no counts.
  expect(d.cells.fg(d.nowCol + 2, rows[3]!)).toBe(INK.dim)
  expect(d.lines[1]).toContain('now')
  expect(d.lines[1]).toContain('30m')
  expect(d.lines[0]).toContain('CLAUDE')
  expect(lanes.nextFrameIn(board, NOW, { columns: 60, rows: 30 }, DARK, lanes.memory(), 33)).toBeUndefined()
  expect(lanes.nextFrameIn(board, NOW, { columns: 60, rows: 30 }, DARK, lanes.memory(), undefined)).toBeUndefined()
  expect(lanes.hidesTally).toBe(true)
})

test('a busy board shows what runs, what went wrong, what came in unasked and where the model changed', () => {
  const board = busyBoard()
  const d = draw(board)
  const model = laneRow(d, 'Model')
  const shell = laneRow(d, 'Shell')
  const files = laneRow(d, 'Files')
  const memory = laneRow(d, 'Memory')
  // The header names the model and its step; the gauge and its percentage sit at the right.
  expect(d.lines[0]).toMatch(/^ opus 5\.5 · step 2 +context ━━━╸─+ 34% $/)
  // The model's step has run for 42 s: a bar out of the now edge, its head beating, its time inside it.
  expect(['●', '◉']).toContain(at(d, d.nowCol, model))
  expect(track(d, model)).toContain(' 0:42 ')
  expect(track(d, model)).toContain('◆')
  expect(d.cells.fg(d.nowCol - 1, model)).toBe(INK.accent)
  // The command runs on, the one before it failed: a red ✕ where it ended, the count of faults beside the count.
  expect(at(d, d.nowCol, shell)).toBe('●')
  expect(track(d, shell)).toContain('✕')
  expect(d.lines[shell]).toMatch(/Shell +2 ✕1$/)
  const cross = [...track(d, shell)].indexOf('✕') + 1
  expect(d.cells.fg(cross, shell)).not.toBe(INK.accent)
  // A subagent reads a file: a light head on Files, and its own thread under Agents saying where it is.
  expect(at(d, d.nowCol, files)).toBe('○')
  const thread = d.lines.findIndex(line => line.includes('explore auth'))
  expect(thread).toBeGreaterThan(laneRow(d, 'Agents'))
  expect(d.lines[thread]).toMatch(/○ {3}Files/)
  // A record a hook brought: ↓ on the Memory lane, and the count split as the map splits it.
  expect(track(d, memory)).toContain('↓')
  expect(d.lines[memory]).toMatch(/Memory +1↓2/)
  // Lit lanes have bright names; the others rest.
  expect(d.cells.fg(d.nowCol + 2, shell)).toBe(INK.bone)
  expect(d.cells.fg(d.nowCol + 2, laneRow(d, 'Browser'))).toBe(INK.dim)
  for (const word of d.cells.words.filter((_, i) => i % 3 === 0)) expect(isWidth1(word)).toBe(true)
})

test('a fault alarms its lane for six seconds, the ✕ blinking at first, and a refusal shows on Hooks and on its lane', () => {
  const board: Board = {
    entries: [
      message(60),
      entry('hooks', 30, 0, { status: 'block', label: 'stopped Bash' }),
      entry('shell', 30, 0, { status: 'block', label: 'rm -rf' }),
      entry('shell', 5, 4.7, { status: 'err' }),
    ],
    counts: { you: 1, shell: 2, hooks: 1 },
    faults: { shell: 2, hooks: 1 },
  }
  // The failed command ended 0.3 s ago: the ✕ is between blinks.
  const blinkOff = draw(board)
  const shell = laneRow(blinkOff, 'Shell')
  expect(at(blinkOff, blinkOff.nowCol, shell)).toBe('│')
  expect(blinkOff.cells.fg(blinkOff.nowCol + 2, shell)).toBe(INK.red)
  const on = draw(board, { now: NOW + 300 })
  expect(at(on, on.nowCol, shell)).toBe('✕')
  expect(on.cells.fg(on.nowCol, shell)).toBe(INK.red)
  // Six seconds on, the alarm is over; the count of faults stays until the next message.
  const later = draw(board, { now: NOW + 6 * S })
  expect(at(later, later.nowCol, shell)).toBe('│')
  expect(later.cells.fg(later.nowCol + 2, shell)).not.toBe(INK.red)
  expect(later.lines[shell]).toMatch(/Shell +2 ✕2$/)
  // The refusal: ⊘ in the same column on Hooks and on Shell.
  const hooks = laneRow(later, 'Hooks')
  const x = [...later.lines[hooks]!].indexOf('⊘')
  expect(x).toBeGreaterThan(0)
  expect(at(later, x, shell)).toBe('⊘')
  // Narrower than 54 columns there is room for one figure: what went wrong.
  const narrow = draw(board, { now: NOW + 6 * S, columns: 48 })
  expect(narrow.lines[laneRow(narrow, 'Shell')]).toMatch(/Shell +✕2$/)
  expect(narrow.lines[laneRow(narrow, 'Hooks')]).toMatch(/Hooks +✕1$/)
})

test('calls that only touch never count as at once; calls that overlap draw a double line and their count', () => {
  // Model steps back to back: one heavy line with a tick where each step began, never ═.
  const steps = [0, 1, 2, 3, 4].map(k => entry('model', 300 - k * 50, 50))
  const touching = draw({ entries: steps, counts: { model: 5 } })
  const model = laneRow(touching, 'Model')
  expect(track(touching, model)).not.toContain('═')
  expect(track(touching, model)).toContain('┿')
  // Three reads at once, still running: ═ and a head that counts them.
  const reads = [entry('files', 6, undefined), entry('files', 6, undefined), entry('files', 5.5, undefined)]
  const overlapping = draw({ entries: reads, counts: { files: 3 } })
  const files = laneRow(overlapping, 'Files')
  expect(track(overlapping, files)).toContain('═')
  expect(at(overlapping, overlapping.nowCol, files)).toBe('3')
})

test('a call grows from the now edge, lets go when it ends, and drifts left as a dash and then a dot', () => {
  const shellAt = (e: Entry, now = NOW): string => {
    const d = draw({ entries: [e], counts: { shell: 1 } }, { now })
    return track(d, laneRow(d, 'Shell'))
  }
  const running = entry('shell', 3, undefined)
  expect(shellAt(running)).toMatch(/╺?━+$/)
  // Ended 0.4 s ago: no head, the bar a cell or so from the edge.
  const ended = entry('shell', 5.4, 5)
  expect(shellAt(ended)).toMatch(/━╸? ?$/)
  const later = shellAt(ended, NOW + 60 * S).trimEnd()
  expect(later.length).toBeLessThan(shellAt(ended).trimEnd().length)
  expect(later.trim()).toMatch(/^[╺━╸]{1,3}$/)
  expect(shellAt(ended, NOW + 600 * S).trim()).toBe('•')
  // Half an hour on it has gone past the left edge.
  expect(shellAt(ended, NOW + 1800 * S).trim()).toBe('')
})

test('every size from 40×16 to 72×30, and cells of any shape, hold the whole picture', () => {
  const board = busyBoard()
  const t = stringsFor('en')
  for (const [columns, rows] of [[40, 16], [72, 16], [40, 30], [72, 30], [54, 20], [53, 26]] as const) {
    for (const cellShape of [2, 2.4, 3]) {
      const d = draw(board, { columns, rows, setup: setupOf({ cellShape }) })
      expect(d.lines.length).toBe(rows)
      for (const line of d.lines) expect([...line].length).toBe(columns)
      for (let i = 0; i < d.cells.words.length; i += 3) expect(isWidth1(d.cells.words[i]!)).toBe(true)
      for (const id of Object.keys(t.stations) as StationId[]) expect(laneRow(d, t.stations[id])).toBeGreaterThan(0)
      expect(d.lines[0]).toMatch(/34%/)
      expect(d.lines.some(line => line.includes('explore auth'))).toBe(true)
      // The gauge has ten cells from 54 columns, six below.
      expect(d.lines[0]!.match(/[━╸─]/g)?.length).toBe(columns >= 54 ? 10 : 6)
    }
  }
  // Below the sizes the pane draws, or none at all, it still never throws.
  for (const [columns, rows] of [[0, 0], [1, 1], [12, 3], [200, 80], [Number.NaN, 5]] as const) {
    expect(lanes.draw(board, NOW, { columns, rows }, DARK, lanes.memory()).rows).toBeGreaterThanOrEqual(0)
  }
})

test('the lanes part into groups with a little room, and a break under each lane with more', () => {
  const board = busyBoard()
  const gapsIn = (rows: number): number => {
    const d = draw(board, { rows })
    const you = laneRow(d, 'You')
    const agents = laneRow(d, 'Agents')
    return agents - you - 9
  }
  expect(gapsIn(16)).toBe(0)
  expect(gapsIn(22)).toBe(3)
  expect(gapsIn(30)).toBe(9)
})

test('with you-bottom the person is at the bottom by the axis, and the threads hang above Agents', () => {
  const d = draw(busyBoard(), { setup: setupOf({ layout: 'you-bottom' }) })
  const you = laneRow(d, 'You')
  const agents = laneRow(d, 'Agents')
  expect(you).toBeGreaterThan(agents)
  expect(d.lines[29]).toMatch(/30m.*now/)
  expect(d.lines[0]).toMatch(/opus 5\.5/)
  const thread = d.lines.findIndex(line => line.includes('explore auth'))
  expect(thread).toBeLessThan(agents)
  expect(thread).toBeGreaterThan(0)
})

test('the light theme draws in the light palette on the terminal\'s own background', () => {
  const light = setupOf({ theme: 'light' })
  const ink = inkFor(light)
  const d = draw(busyBoard(), { setup: light, now: NOW + 1000 })
  const shell = laneRow(d, 'Shell')
  expect(ink.accent).toBe(0xb8762a)
  expect(d.cells.fg(d.nowCol - 1, shell)).toBe(ink.accent)
  expect(d.cells.fg(d.nowCol + 2, shell)).toBe(ink.bone)
  expect(d.cells.bg(d.nowCol - 1, shell)).toBe(DEFAULT)
  // A colour the person set holds.
  const own = setupOf({ colors: ['accent=#123456'] })
  const mine = draw(busyBoard(), { setup: own, now: NOW + 1000 })
  expect(mine.cells.fg(mine.nowCol - 1, laneRow(mine, 'Shell'))).toBe(0x123456)
})

test('a board of 80 entries draws, and what slips off it stays on the lanes for half an hour', () => {
  const memory = lanes.memory()
  const first: Entry[] = [entry('web', 600, 3, { label: 'api.example.com' })]
  for (let k = 0; k < 79; k++) first.push(entry('files', 500 - k, 0.3))
  const d1 = draw({ entries: first, counts: { web: 1, files: 79 } }, { memory })
  expect(track(d1, laneRow(d1, 'Network')).trim()).not.toBe('')
  // Eighty newer entries push the network call off the board; the lane still shows it.
  const second: Entry[] = []
  for (let k = 0; k < 80; k++) second.push(entry('shell', 300 - k, 0.5))
  const d2 = draw({ entries: second, counts: { web: 1, files: 79, shell: 80 } }, { memory, now: NOW + 1000 })
  expect(track(d2, laneRow(d2, 'Network')).trim()).not.toBe('')
  expect(track(d2, laneRow(d2, 'Files')).trim()).not.toBe('')
  // A board with room to spare has lost nothing: what it lacks belonged to another.
  const d3 = draw({ entries: [entry('shell', 1, 0.5)], counts: { shell: 1 } }, { memory, now: NOW + 2000 })
  expect(track(d3, laneRow(d3, 'Network')).trim()).toBe('')
  // A fresh memory, as after a reload, draws the 80 it is given.
  const d4 = draw({ entries: second, counts: { shell: 80 } })
  expect(track(d4, laneRow(d4, 'Shell')).trim()).not.toBe('')
})

test('every label and word comes in the person\'s language', () => {
  const axisNow: Record<string, string> = { en: 'now', ru: 'сейчас', es: 'ahora', fr: 'maintenant', de: 'jetzt', it: 'ora' }
  for (const language of LANGUAGES) {
    const setup = setupOf({ language })
    const t = stringsFor(language)
    const board = busyBoard()
    const d = draw(board, { setup })
    for (const id of Object.keys(t.stations) as StationId[]) expect(laneRow(d, t.stations[id])).toBeGreaterThan(0)
    expect(d.lines[0]).toContain(t.step(2))
    expect(d.lines[1]).toContain(axisNow[language])
    // The thread's label is the person's own words, as the Agent call had them.
    expect(d.lines.some(line => line.includes('explore auth'))).toBe(true)
    // Narrow, the longest names still fit beside the now edge.
    const narrow = draw(board, { setup, columns: 40, rows: 16 })
    for (const id of Object.keys(t.stations) as StationId[]) expect(laneRow(narrow, t.stations[id])).toBeGreaterThan(0)
  }
})

test('a finished subagent keeps its row, with how long it took, until the next message', () => {
  const work: Entry[] = [
    message(300),
    entry('agents', 200, 150, { label: 'review diff' }),
    entry('model', 199, 20, { from: 'agents', agentId: 'a1' }),
    entry('files', 170, 1, { from: 'agents', agentId: 'a1' }),
    entry('model', 168, 118, { from: 'agents', agentId: 'a1' }),
  ]
  const before = draw({ entries: work, counts: { agents: 1, files: 1 } })
  const row = before.lines.findIndex(line => line.includes('review diff'))
  expect(row).toBeGreaterThan(0)
  expect(before.lines[row]).toMatch(/│ {3}✓ 2m/)
  expect(at(before, before.nowCol, row)).toBe('│')
  const after = draw({ entries: [...work, message(10)], counts: { agents: 1, files: 1, you: 2 } })
  expect(after.lines.some(line => line.includes('review diff'))).toBe(false)
  // A background task: ╍ for as long as it runs, beyond the left edge too, with how long ago it began.
  const server = draw({ entries: [entry('shell', 8040, undefined, { label: 'dev server', task: 'b1' })], counts: { shell: 1 } })
  const line = server.lines.find(l => l.includes('dev server')) ?? ''
  expect(line).toMatch(/^ ╍ dev server · 2h14m ╍+●   Shell/)
})

test('short of rows, the threads are capped, then lanes never used fold into a line of names', () => {
  const crew: Entry[] = []
  const agents: string[] = []
  for (let k = 0; k < 12; k++) {
    agents.push(`a${k}`)
    crew.push(entry('agents', 60 - k, undefined, { label: `task ${k}` }), entry('files', 50 - k, undefined, { from: 'agents', agentId: `a${k}` }))
  }
  const board: Board = { entries: [message(70), entry('model', 69, 5), ...crew], counts: { you: 1, model: 1, agents: 12, files: 12 }, agents }
  const d = draw(board, { columns: 60, rows: 16 })
  const footer = d.lines[15]!
  for (const name of ['Memory', 'Shell', 'Network', 'Browser', 'Skills', 'Hooks']) expect(footer).toContain(name)
  for (const name of ['You', 'Model', 'Files', 'Agents']) expect(laneRow(d, name)).toBeGreaterThan(0)
  // Twelve threads, nine rows for them once the lanes fold: eight and a ninth that counts the rest.
  expect(d.lines.filter(line => /task \d/.test(line)).length).toBe(8)
  expect(d.lines.some(line => /and 4 more {2}│/.test(line))).toBe(true)
  // With rows to spare nothing folds.
  const tall = draw(board, { columns: 60, rows: 30 })
  expect(laneRow(tall, 'Browser')).toBeGreaterThan(0)
})

test('a count flashes as it goes up, the gauge eases to a new value, and the now edge turns bold as the answer lands', () => {
  const memory = lanes.memory()
  const first: Board = { entries: [entry('files', 10, 1)], counts: { files: 1 }, context: 80, model: 'claude-opus-5-5', step: 1 }
  draw(first, { memory })
  const second: Board = { ...first, entries: [...first.entries, entry('files', 0, 0.1)], counts: { files: 2 }, context: 20 }
  const now = draw(second, { memory })
  const files = laneRow(now, 'Files')
  const figure = now.nowCol + 2 + 7 + 1 + 3
  expect(now.cells.fg(figure, files)).toBe(INK.hot)
  expect(now.lines[0]).toContain('80%')
  const soon = draw(second, { memory, now: NOW + 1000 })
  expect(soon.cells.fg(figure, files)).toBe(INK.dim)
  expect(soon.lines[0]).toContain('20%')

  const done = draw({ entries: [message(20), entry('model', 19, 18.9), answer(0.1)], counts: { you: 2, model: 1 } })
  expect(at(done, done.nowCol, laneRow(done, 'Shell'))).toBe('┃')
  expect(done.cells.fg(done.nowCol, laneRow(done, 'Shell'))).toBe(INK.bone)
  expect(track(done, laneRow(done, 'You'))).toContain('✓')
  const settled = draw({ entries: [message(20), entry('model', 19, 18.9), answer(0.1)], counts: { you: 2, model: 1 } }, { now: NOW + 2000 })
  expect(at(settled, settled.nowCol, laneRow(settled, 'Shell'))).toBe('│')
})

test('the next frame comes soon while something flies, at the endless rate at rest, and never without it', () => {
  const size = { columns: 60, rows: 30 }
  const next = (board: Board, endless: number | undefined, now = NOW): number | undefined => lanes.nextFrameIn(board, now, size, DARK, lanes.memory(), endless)
  // A call just started: its spark wants every frame there is.
  const spark: Board = { entries: [entry('files', 0.1, undefined)], counts: { files: 1 } }
  expect(next(spark, 33)).toBe(FASTEST_MS)
  expect(next(spark, undefined)).toBe(FASTEST_MS)
  // Running on: fifteen frames a second while frames are free, no more often than the endless rate after.
  const running: Board = { entries: [entry('shell', 20, undefined)], counts: { shell: 1 } }
  expect(next(running, 33)).toBe(67)
  expect(next(running, 5000)).toBe(5000)
  // At rest, two minutes after the last call: the now edge breathes while frames are free...
  const resting: Board = { entries: [entry('files', 121, 1)], counts: { files: 1 } }
  const breathing = next(resting, 33)
  expect(breathing).toBeGreaterThanOrEqual(FASTEST_MS)
  expect(breathing).toBeLessThanOrEqual(150)
  // ...and without them only the drift of the last call along the track remains: a half cell there lasts about 9 s.
  const drifting = next(resting, undefined)
  expect(drifting).toBeGreaterThan(150)
  expect(drifting).toBeLessThan(9000)
  const moved = lanes.draw(resting, NOW + (drifting ?? 0), size, DARK, lanes.memory()).lines()
  const before = lanes.draw(resting, NOW + (drifting ?? 0) - 40, size, DARK, lanes.memory()).lines()
  expect(moved).not.toEqual(before)
  // Nothing within half an hour, nothing running: no frame at all.
  const still: Board = { entries: [entry('files', 1900, 1)], counts: { files: 1 } }
  expect(next(still, 33)).toBeUndefined()
  expect(next(still, undefined)).toBeUndefined()
  // A call cooling after it ended: a frame at its next step of colour, within 200 ms.
  const cooling = next({ entries: [entry('files', 2, 1)], counts: { files: 1 } }, undefined)
  expect(cooling).toBeLessThanOrEqual(200)
})

test('draw takes well under 5 ms on a busy board at 72×30, in few colours', () => {
  // A busy half hour: 80 entries on the board and 300 more in the ledger, on every lane, with subagents and tasks.
  const memory = lanes.memory()
  const stations: StationId[] = ['model', 'memory', 'files', 'shell', 'web', 'browser', 'skills', 'hooks', 'agents']
  const old: Entry[] = []
  for (let k = 0; k < 300; k++) old.push(entry(stations[k % stations.length]!, 1700 - k * 5, (k % 7) * 0.8))
  draw({ entries: old.slice(-80), counts: { files: 300 } }, { memory })
  const recent: Entry[] = [message(100)]
  for (let k = 0; k < 70; k++) recent.push(entry(stations[k % stations.length]!, 95 - k * 1.3, k % 3 === 0 ? 2.5 : 0.4, k % 5 === 0 ? { from: 'agents', agentId: `a${k % 3}` } : {}))
  recent.push(entry('model', 9, undefined), entry('shell', 6, undefined), entry('files', 2, undefined), entry('files', 1.5, undefined), entry('agents', 60, undefined, { label: 'explore' }))
  recent.push(entry('shell', 900, undefined, { label: 'dev server', task: 'b1' }), entry('shell', 12, 1, { status: 'err' }))
  const board: Board = { entries: recent, counts: { files: 300, shell: 40, model: 30 }, faults: { shell: 1 }, agents: ['a0', 'a1', 'a2'], context: 64, model: 'claude-opus-5-5', step: 30 }
  const size = { columns: 72, rows: 30 }
  for (let k = 0; k < 30; k++) lanes.draw(board, NOW + k * 33, size, DARK, memory)
  const runs = 300
  const started = performance.now()
  let cells = lanes.draw(board, NOW, size, DARK, memory)
  for (let k = 0; k < runs; k++) cells = lanes.draw(board, NOW + k * 33, size, DARK, memory)
  const each = (performance.now() - started) / runs
  const pairs = new Set<string>()
  for (let i = 0; i < cells.words.length; i += 3) if (cells.words[i] !== 0x20) pairs.add(`${cells.words[i + 1]}:${cells.words[i + 2]}`)
  console.log(`lanes: ${each.toFixed(2)} ms a frame at 72×30 on a busy board; ${pairs.size} colour pairs`)
  expect(each).toBeLessThan(5)
  expect(pairs.size).toBeLessThan(400)
})

const PANE = {
  plugin: 'lot-map',
  component: 'Pane',
  requestId: 'lot-map',
  props: { title: 'Map', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('in a terminal the lanes keep moving while a step runs, leave out the tally, and stop once nothing moves', { options: { terminalView: 'lanes' }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const frames: string[] = []
  on('ui.blit', (_, e) => {
    frames.push('cells' in e ? e.cells : '')
    return { value: {} }
  })
  on('tool.call', () => ({ result: {} }))
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'x' } as never
    return { turnId: 't1', index: 0, answer: '', toolUses: [] } as never
  })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)[Symbol.asyncIterator]()
  await step.next()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const raster = await ui.find({ type: 'Raster' })
  expect([raster?.props.columns, raster?.props.rows]).toEqual([60, 30])
  // The counts are on the lanes: no tally row under them.
  await $.tool.call({ tool: 'Read', file_path: '/a/b/content.py' })
  expect(await ui.find({ type: 'Text', text: /^Files \d+/ })).toBeUndefined()
  frames.length = 0
  await clock.advance(1000)
  // A step runs: fifteen frames a second at least.
  expect(frames.length).toBeGreaterThanOrEqual(14)
  for (const frame of frames.slice(-3)) {
    const words = new Uint32Array(fromBase64(frame).buffer)
    expect(words.length).toBe(60 * 30 * 3)
    for (let i = 0; i < words.length; i += 3) expect(isWidth1(words[i]!)).toBe(true)
  }
  await step.next()
  // Half an hour later every mark has gone past the left edge and the now edge has long stopped breathing.
  await clock.advance(31 * 60 * 1000)
  const settled = frames.length
  await clock.advance(10_000)
  expect(frames.length).toBe(settled)
  await ui.unmount()
})
