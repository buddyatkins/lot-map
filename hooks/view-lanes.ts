// The lanes view: a lane for each station, the last half hour along it on a log scale, and the now edge at the right.
// A call grows out of the now edge while it runs. When it ends it lets go and drifts left, cooling as it goes and
// shrinking to a dash and then a dot, so the right of the view moves and the rest of it stays still.
// Subagents and background tasks each get a thread row under the Agents lane.
import type { Board, Entry, StationId } from '../types'
import { Cells, cut, glyphsOf, groundFor, inkFor, mix, quantize, soonest } from './cells'
import type { Ink, View, ViewSize } from './cells'
import { ALARM_MS, DONE_MS, GLOW_MS, PULSE_MS, SWITCH_MS, shortModel } from './map'
import type { Setup } from './map'
import { FASTEST_MS, endlessEvery } from './raster'
import { stringsFor } from './text'
import type { Strings } from './text'

// ---- the scale ---------------------------------------------------------------------------------

/** Up to about this age the track is near linear; past it, each step back covers more time. */
const KNEE_MS = 5000
/** The left edge of the track: half an hour ago. */
const HORIZON_MS = 1_800_000
const SPAN = Math.log(1 + HORIZON_MS / KNEE_MS)

/**
 * How far back along the track a moment `age` ms old lies: 0 at the now edge, 1 at the horizon. The scale never
 * changes with what is on it, since a rescale would move every mark at once and look like an event.
 */
const depth = (age: number): number => (age <= 0 ? 0 : age >= HORIZON_MS ? 1 : Math.log(1 + age / KNEE_MS) / SPAN)
/** The half cell a moment lies in, counted back from the now edge: 0 is the newest. */
const halfOf = (age: number, halves: number): number => Math.min(halves - 1, Math.floor(halves * depth(age)))
/** The age at which a moment moves into half cell `h`. */
const ageOfHalf = (h: number, halves: number): number => KNEE_MS * (Math.exp((h * SPAN) / halves) - 1)
/** How long the half cell a moment `age` ms old lies in lasts. A call shorter than that is a dot. */
const halfLasts = (age: number, halves: number): number => ((Math.max(0, age) + KNEE_MS) * SPAN) / halves
/** History keeps its colour for the first minute, then fades toward the line until the horizon. */
const AGING_FROM = depth(60_000)
/** Where the ticks of the axis fall: 10 s, 1 min, 5 min and the horizon. */
const TICKS = [10_000, 60_000, 300_000, HORIZON_MS] as const

// ---- time and motion ---------------------------------------------------------------------------

/** A running call's head beats; a background task's, slower, so that it never outshines the work in front. */
const BEAT_MS = 1400
const TASK_BEAT_MS = 2800
/** How long the head shows ◉ at the start of each beat. */
const BEAT_FLASH_MS = 200
/** A fault's head blinks for this long, this fast, and then holds until the alarm is over. */
const BLINK_FOR_MS = 1200
const BLINK_MS = 250
/** The now edge breathes, faster while anything runs, and stops after this long with nothing done. */
const BREATH_REST_MS = 4800
const BREATH_BUSY_MS = 1600
const BREATH_STOPS_MS = 300_000
/** The context gauge eases to a new value; a count flashes when it goes up. */
const EASE_MS = 600
const FLASH_MS = PULSE_MS
/** A running bar this long shows how long it has run. */
const INSET_FROM_MS = 10_000
/** Frames while a call runs: its bar grows, its head beats and its time counts. */
const RUNNING_EVERY_MS = 67
const TASK_EVERY_MS = TASK_BEAT_MS / 16

// ---- the lanes ---------------------------------------------------------------------------------

/** The person and the model first; Agents last, so that thread rows hang under it. */
const ORDER: readonly StationId[] = ['you', 'model', 'memory', 'files', 'shell', 'web', 'browser', 'skills', 'hooks', 'agents']
/** With room for a few breaks but not for one under every lane, the lanes part into groups. */
const GROUP_ENDS: ReadonlySet<StationId> = new Set(['model', 'browser', 'hooks'])
/** The person and the model are the spine of every turn: they never fold away. */
const NEVER_FOLD: ReadonlySet<StationId> = new Set(['you', 'model'])
/** A lane with nothing for this long may fold away when rows are short. */
const FOLD_IDLE_MS = 600_000
/** When rows are short, lanes fold away until this many thread rows fit. */
const WANTED_THREADS = 6
/** The board keeps its newest 80 entries: with fewer it has lost nothing. As `KEEP` in register.tsx. */
const BOARD_KEEPS = 80
/** A bound on the ledger, far above what half an hour holds. */
const LEDGER_MAX = 4000
/** A thread's label goes left of where it began when at least this much of it fits there. */
const LABEL_MIN = 6

// ---- glyphs ------------------------------------------------------------------------------------

const HEAVY = 0x2501 // ━ a main-loop call
const HEAVY_OLDER = 0x2578 // ╸ only the older (left) half of a cell
const HEAVY_NEWER = 0x257a // ╺
const LIGHT = 0x2500 // ─ a subagent's call
const LIGHT_OLDER = 0x2574 // ╴
const LIGHT_NEWER = 0x2576 // ╶
const DOUBLE = 0x2550 // ═ two or more calls at once
const STEP = 0x253f // ┿ where a model step began
const DOT = 0x2022 // • a short call
const SMALL_DOT = 0x00b7 // · a subagent's short call
const HEAD = 0x25cf // ● a running call at the now edge
const BEAT = 0x25c9 // ◉
const SUB_HEAD = 0x25cb // ○ a subagent's running call
const ERROR = 0x2715 // ✕
const REFUSED = 0x2298 // ⊘
const SWITCH = 0x25c6 // ◆ the model changed
const DONE = 0x2713 // ✓ the answer
const PUSHED = 0x2193 // ↓ a memory record nobody asked for
const TURN = 0x250a // ┊ a message from the person
const TASK_LINE = 0x254d // ╍ a background task
const EDGE = 0x2502 // │ the now edge
const CURTAIN = 0x2503 // ┃ the now edge as the answer lands

// ---- words -------------------------------------------------------------------------------------

/** Words this view needs that text.ts has not got: the units of the axis and of a thread's time, and the now edge. */
type Words = { now: string; second: string; minute: string; hour: string }

const ENGLISH: Words = { now: 'now', second: 's', minute: 'm', hour: 'h' }
const WORDS: readonly (readonly [string, Words])[] = [
  ['en', ENGLISH],
  ['ru', { now: 'сейчас', second: 'с', minute: 'мин', hour: 'ч' }],
  ['es', { now: 'ahora', second: 's', minute: 'min', hour: 'h' }],
  ['fr', { now: 'maintenant', second: 's', minute: 'min', hour: 'h' }],
  ['de', { now: 'jetzt', second: 's', minute: 'min', hour: 'h' }],
  ['it', { now: 'ora', second: 's', minute: 'min', hour: 'h' }],
]

function wordsFor(t: Strings): Words {
  for (const [language, words] of WORDS) if (stringsFor(language) === t) return words
  return ENGLISH
}

/** A span of time in a few cells: 42s, 6m, 2h14m. */
function shortSpan(ms: number, w: Words): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}${w.second}`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}${w.minute}`
  return `${Math.floor(minutes / 60)}${w.hour}${String(minutes % 60).padStart(2, '0')}${w.minute}`
}

/** How long a call has run, as a clock shows it: 0:42, 12:05, 1:02:03. */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const s = String(seconds % 60).padStart(2, '0')
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}:${s}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${s}`
}

/** A count in the four cells it has. */
const figure = (n: number): string => (n < 10_000 ? String(n) : n < 1_000_000 ? `${Math.floor(n / 1000)}k` : '1M+')

// ---- colour ------------------------------------------------------------------------------------

/** How a kind of mark looks over its life: hot as it starts, live while it runs, cooling to rest, then aging. */
type Family = { live: number; hot: number; cooling: number[]; aging: number[]; coolMs: number }

const MAIN = 0
const MEMORY = 1
const FAULT = 2
const PERSON = 3
const TASK = 4
const CHANGE = 5
const THINKING = 6

type Paint = {
  ink: Ink
  ground: number
  families: Family[]
  /** A lane's name as the lane lets go: bone to ash. */
  names: number[]
  /** The now edge breathing: line to dim. */
  breath: number[]
  /** A count that went up: hot to dim. */
  flash: number[]
  /** A head's beat, from hot to its own colour. */
  beat: number[]
  memoryBeat: number[]
  taskBeat: number[]
}

/** Sixteen steps from one colour to another, the most a fade needs to look smooth. */
const stepsFrom = (a: number, b: number): number[] => Array.from({ length: 17 }, (_, i) => mix(a, b, i / 16))
const stepOf = (t: number): number => Math.round(quantize(t) * 16)

function paintFor(setup: Setup): Paint {
  const ink = inkFor(setup)
  // History fades toward the line, never into it: half way is as faint as it gets.
  const old = (c: number): number => mix(c, ink.line, 0.5)
  const family = (live: number, hot: number, rest: number, aged: number, coolMs = GLOW_MS): Family => ({
    live,
    hot,
    cooling: stepsFrom(live, rest),
    aging: stepsFrom(rest, aged),
    coolMs,
  })
  const task = mix(ink.accent, ink.dim, 0.5)
  return {
    ink,
    ground: groundFor(setup),
    families: [
      family(ink.accent, ink.hot, ink.dim, old(ink.dim)),
      // Memory and faults keep their hue as they age, so that their history still reads as theirs.
      family(ink.mem, ink.memHot, mix(ink.mem, ink.line, 0.25), old(ink.mem)),
      family(ink.red, ink.red, mix(ink.red, ink.line, 0.25), old(ink.red)),
      family(ink.bone, ink.bone, ink.ash, old(ink.ash)),
      family(task, ink.accent, ink.dim, old(ink.dim)),
      family(ink.hot, ink.hot, ink.ash, old(ink.ash), SWITCH_MS),
      family(ink.ash, ink.ash, ink.dim, old(ink.dim)),
    ],
    names: stepsFrom(ink.bone, ink.ash),
    breath: stepsFrom(ink.line, ink.dim),
    flash: stepsFrom(ink.hot, ink.dim),
    beat: stepsFrom(ink.hot, ink.accent),
    memoryBeat: stepsFrom(ink.memHot, ink.mem),
    taskBeat: stepsFrom(ink.accent, task),
  }
}

/**
 * The colour of a mark that ended (or happened) at `at`, `h` half cells back: hot for a moment after it starts,
 * cooling from live to rest after it ends, then aging with its place on the track, which moves only in half cells.
 */
function tone(paint: Paint, family: number, at: number, startedAt: number, h: number, halves: number, now: number): number {
  const f = paint.families[family] ?? paint.families[MAIN]!
  const since = now - at
  if (now - startedAt < PULSE_MS && since < PULSE_MS) return f.hot
  if (since < f.coolMs) return f.cooling[stepOf(since / f.coolMs)]!
  return f.aging[stepOf((h / halves - AGING_FROM) / (1 - AGING_FROM))]!
}

// ---- the layout --------------------------------------------------------------------------------

/**
 * How the rows are spent, by how many there are: a break under every lane, breaks between groups of lanes, one
 * break under the axis, or none. It depends on the size alone, so lanes never move as threads come and go.
 */
type Spacing = 'spaced' | 'grouped' | 'airy' | 'tight'

/** Per half cell, everything one lane (or one thread's calls) holds. */
type Halves = {
  size: number
  /** 1 a main-loop call covers it, 2 a subagent's. */
  cover: Uint8Array
  /** The most calls open at one moment within it. */
  most: Uint8Array
  /** 1 a main-loop call's dot, 2 a subagent's. */
  dot: Uint8Array
  /** A model step began here. */
  step: Uint8Array
  /** The newest thing here: when it ended (now while it runs), when it began, and its colour. */
  newest: Float64Array
  newestStart: Float64Array
  family: Uint8Array
  mark: Uint32Array
  markRank: Uint8Array
  markAt: Float64Array
  markFamily: Uint8Array
  /** Every span's start and end, for counting how many are open at once. */
  spans: number[]
}

type Layout = {
  setup: Setup
  columns: number
  rows: number
  t: Strings
  words: Words
  paint: Paint
  narrow: boolean
  nameWidth: number
  track: number
  halves: number
  nowCol: number
  nameCol: number
  countCol: number
  faultCol: number
  gaugeCells: number
  spacing: Spacing
  axis: { x: number; text: string }[]
  scratch: Halves
}

function halvesOf(size: number): Halves {
  const n = Math.max(0, size)
  return {
    size: n,
    cover: new Uint8Array(n),
    most: new Uint8Array(n),
    dot: new Uint8Array(n),
    step: new Uint8Array(n),
    newest: new Float64Array(n),
    newestStart: new Float64Array(n),
    family: new Uint8Array(n),
    mark: new Uint32Array(n),
    markRank: new Uint8Array(n),
    markAt: new Float64Array(n),
    markFamily: new Uint8Array(n),
    spans: [],
  }
}

function layoutFor(size: ViewSize, setup: Setup, memory: Memory): Layout {
  const columns = Math.max(0, Math.floor(Number.isFinite(size.columns) ? size.columns : 0))
  const rows = Math.max(0, Math.floor(Number.isFinite(size.rows) ? size.rows : 0))
  const kept = memory.layout
  if (kept !== undefined && kept.setup === setup && kept.columns === columns && kept.rows === rows) return kept
  const t = setup.t
  const words = wordsFor(t)
  const narrow = columns < 54
  // The name field fits the language's longest name, so the now edge stays put whatever lights up.
  const nameWidth = Math.max(...ORDER.map(id => glyphsOf(t.stations[id]).length))
  // The now edge, a space, the name, a space, the count, and at 54 columns or more the faults.
  const right = 1 + 1 + nameWidth + 1 + 4 + (narrow ? 0 : 3)
  const track = Math.max(0, columns - 1 - right)
  const nowCol = 1 + track
  const nameCol = nowCol + 2
  const countCol = nameCol + nameWidth + 1
  const layout: Layout = {
    setup,
    columns,
    rows,
    t,
    words,
    paint: paintFor(setup),
    narrow,
    nameWidth,
    track,
    halves: 2 * track,
    nowCol,
    nameCol,
    countCol,
    faultCol: narrow ? -1 : countCol + 4,
    gaugeCells: narrow ? 6 : 10,
    spacing: rows >= 26 ? 'spaced' : rows >= 20 ? 'grouped' : rows >= 17 ? 'airy' : 'tight',
    axis: [],
    scratch: halvesOf(2 * track),
  }
  layout.axis = axisOf(layout)
  memory.layout = layout
  return layout
}

/** The axis labels: each tick's label ends at its column, and one that would touch another is left out. */
function axisOf(layout: Layout): { x: number; text: string }[] {
  const { words, halves, nowCol, columns } = layout
  if (halves === 0) return []
  const at = (age: number): number => nowCol - 1 - (halfOf(age - 1, halves) >> 1)
  const labels: { x: number; text: string }[] = []
  const taken: [number, number][] = []
  const free = (a: number, b: number): boolean => a >= 1 && taken.every(([c, d]) => b < c - 1 || a > d + 1)
  const [tenSeconds, minute, fiveMinutes, horizon] = TICKS
  const names: [number, string][] = [
    [tenSeconds, `10${words.second}`],
    [horizon, `30${words.minute}`],
    [minute, `1${words.minute}`],
    [fiveMinutes, `5${words.minute}`],
  ]
  for (const [age, text] of names) {
    const length = glyphsOf(text).length
    const x = Math.max(1, at(age) - length + 1)
    if (!free(x, x + length - 1)) continue
    labels.push({ x, text })
    taken.push([x, x + length - 1])
  }
  // The now label ends at the now edge, or as near it as the 10 s label leaves room for, running on to the right.
  const length = glyphsOf(words.now).length
  const after = taken[0] !== undefined ? taken[0][1] + 2 : 1
  const x = Math.max(nowCol - length + 1, after)
  if (x < columns) labels.push({ x, text: words.now })
  return labels
}

// ---- what the view keeps -----------------------------------------------------------------------

type Thread = {
  label: string
  isAgent: boolean
  /** -Infinity when where it began has slipped off the ledger. */
  start: number
  end: number | undefined
  failed: boolean
  /** Where a task runs. */
  station: StationId
  /** A subagent's own steps and calls. */
  calls: Entry[]
}

/** What the ledger holds, sorted as the drawing needs it. Rebuilt whenever a new board comes in. */
type Scene = {
  lanes: Record<StationId, Entry[]>
  /** The newest moment on each lane: Infinity while a call runs there, -Infinity for never. */
  latest: Record<StationId, number>
  used: Set<StationId>
  threads: Thread[]
  /** When each message came. */
  turns: number[]
  lastMessage: number
  done: number
  switchAt: number
  switchLabel: string
  compacting: boolean
  /** Something runs, a background task or a subagent included: as register counts it. */
  busy: boolean
  /** A call runs in the foreground: its bar grows. */
  working: boolean
  /** A background task runs. */
  tasking: boolean
  lastActivity: number
}

type Gauge = { from: number; to: number; at: number }

type Memory = {
  /** The board last merged, and the words its scene was read in. */
  board: Board | undefined
  strings: Strings | undefined
  /** When the board on show was first drawn: endless motion runs smoothly for a while after each new board. */
  boardAt: number
  /** Every entry of the last half hour, by id: the board keeps only its newest 80. */
  ledger: Map<string, Entry>
  scene: Scene
  counts: Partial<Record<StationId, number>>
  flashAt: Partial<Record<StationId, number>>
  gauge: Gauge | undefined
  layout: Layout | undefined
}

const byStation = <T>(make: () => T): Record<StationId, T> =>
  Object.fromEntries(ORDER.map(id => [id, make()])) as Record<StationId, T>

function emptyScene(): Scene {
  return {
    lanes: byStation<Entry[]>(() => []),
    latest: byStation(() => -Infinity),
    used: new Set(),
    threads: [],
    turns: [],
    lastMessage: -Infinity,
    done: -Infinity,
    switchAt: -Infinity,
    switchLabel: '',
    compacting: false,
    busy: false,
    working: false,
    tasking: false,
    lastActivity: -Infinity,
  }
}

const STATION_SET: ReadonlySet<string> = new Set(ORDER)

function isDrawable(e: unknown): e is Entry {
  if (typeof e !== 'object' || e === null) return false
  const x = e as Partial<Entry>
  return typeof x.id === 'string' && typeof x.station === 'string' && STATION_SET.has(x.station) && Number.isFinite(x.startedAt)
}

const gaugeAt = (g: Gauge, now: number): number => {
  const f = Math.min(1, Math.max(0, (now - g.at) / EASE_MS))
  return g.from + (g.to - g.from) * (1 - (1 - f) ** 3)
}

/** Brings the ledger, the counts and the gauge up to date with a board not seen before. */
function merge(board: Board, now: number, memory: Memory, t: Strings): void {
  if (memory.board === board && memory.strings === t) return
  const isFirst = memory.board === undefined
  memory.board = board
  memory.strings = t
  memory.boardAt = now
  const entries: unknown[] = Array.isArray(board.entries) ? board.entries : []
  const onBoard = new Set<string>()
  for (const e of entries) {
    if (!isDrawable(e)) continue
    onBoard.add(e.id)
    memory.ledger.set(e.id, Number.isFinite(e.endedAt) || e.endedAt === undefined ? e : { ...e, endedAt: undefined })
  }
  const isFull = entries.length >= BOARD_KEEPS
  for (const [id, e] of memory.ledger) {
    if (onBoard.has(id)) continue
    // A board with room to spare has lost nothing: what it no longer holds was another board's.
    if (!isFull) memory.ledger.delete(id)
    // A call that slipped off a full board while it ran is never seen to end: it ends where it was lost.
    else if (e.endedAt === undefined) memory.ledger.set(id, { ...e, status: 'ok', endedAt: now })
    else if (now - e.endedAt > HORIZON_MS) memory.ledger.delete(id)
  }
  for (const id of memory.ledger.keys()) {
    if (memory.ledger.size <= LEDGER_MAX) break
    memory.ledger.delete(id)
  }

  const counts = board.counts ?? {}
  for (const id of ORDER) {
    const n = counts[id] ?? 0
    if (!isFirst && n > (memory.counts[id] ?? 0)) memory.flashAt[id] = now
    memory.counts[id] = n
  }
  if (typeof board.context === 'number' && Number.isFinite(board.context)) {
    const to = Math.max(0, Math.min(100, board.context))
    const g = memory.gauge
    if (g === undefined) memory.gauge = { from: to, to, at: now }
    else if (g.to !== to) memory.gauge = { from: gaugeAt(g, now), to, at: now }
  }
  memory.scene = sceneOf(memory.ledger, board, t)
}

function sceneOf(ledger: Map<string, Entry>, board: Board, t: Strings): Scene {
  const scene = emptyScene()
  const agents = Array.isArray(board.agents) ? board.agents : []
  scene.busy = agents.length > 0
  const byAgent = new Map<string, Entry[]>()
  const launches: Entry[] = []
  const agentCalls: Entry[] = []
  for (const e of ledger.values()) {
    const isRunning = e.endedAt === undefined
    if (isRunning) {
      scene.busy = true
      if (e.task === undefined) scene.working = true
      else scene.tasking = true
    }
    scene.lastActivity = Math.max(scene.lastActivity, e.endedAt ?? e.startedAt)
    if (e.agentId !== undefined) {
      const own = byAgent.get(e.agentId)
      if (own === undefined) byAgent.set(e.agentId, [e])
      else own.push(e)
    }
    if (e.task !== undefined) launches.push(e)
    else if (e.station === 'agents' && !['SendMessage', 'TaskStop', t.workflow].includes(e.label)) agentCalls.push(e)
    // A subagent's steps belong to its thread: the Model lane is the main loop's.
    if (e.station !== 'model' || (e.from !== 'agents' && e.agentId === undefined)) {
      scene.lanes[e.station].push(e)
      scene.used.add(e.station)
      const moment = isRunning && e.task === undefined ? Infinity : (e.endedAt ?? e.startedAt)
      if (moment > scene.latest[e.station]) scene.latest[e.station] = moment
    }
    if (e.station === 'you' && e.from === 'inbound') {
      scene.turns.push(e.startedAt)
      scene.lastMessage = Math.max(scene.lastMessage, e.startedAt)
    }
    if (e.mark === 'done') scene.done = Math.max(scene.done, e.startedAt)
    if (e.mark === 'switch' && e.startedAt >= scene.switchAt) {
      scene.switchAt = e.startedAt
      scene.switchLabel = e.label
    }
    if (e.station === 'model' && isRunning && e.label === t.compacting) scene.compacting = true
  }
  for (const id of ORDER) if ((board.counts?.[id] ?? 0) > 0) scene.used.add(id)

  const threads: Thread[] = []
  const launched = new Set<string>()
  for (const launch of launches) {
    const task = launch.task ?? ''
    const own = byAgent.get(task)
    launched.add(task)
    threads.push({
      label: launch.label,
      isAgent: own !== undefined,
      start: launch.startedAt,
      end: launch.endedAt,
      failed: launch.status === 'err' || launch.status === 'block',
      station: launch.station,
      calls: own ?? [],
    })
  }
  // A subagent in the foreground is not linked to the Agent call that started it: it takes the name of the oldest
  // call not yet taken that began before it and was still open then.
  const running = new Set(agents)
  const loose = [...byAgent].filter(([id]) => !launched.has(id)).map(([id, own]) => ({ id, own, first: Math.min(...own.map(e => e.startedAt)) }))
  loose.sort((a, b) => a.first - b.first)
  agentCalls.sort((a, b) => a.startedAt - b.startedAt)
  const taken = new Set<Entry>()
  for (const agent of loose) {
    const call = agentCalls.find(c => !taken.has(c) && c.startedAt <= agent.first && (c.endedAt === undefined || c.endedAt >= agent.first))
    if (call !== undefined) taken.add(call)
    const lastOwn = Math.max(...agent.own.map(e => e.endedAt ?? e.startedAt))
    threads.push({
      label: call?.label ?? t.subagent,
      isAgent: true,
      start: call?.startedAt ?? agent.first,
      end: running.has(agent.id) ? undefined : Math.max(lastOwn, call?.endedAt ?? -Infinity),
      failed: call?.status === 'err',
      station: 'agents',
      calls: agent.own,
    })
  }
  // A subagent still at work whose every call has slipped off the ledger.
  for (const id of running) {
    if (byAgent.has(id) || launched.has(id)) continue
    threads.push({ label: t.subagent, isAgent: true, start: -Infinity, end: undefined, failed: false, station: 'agents', calls: [] })
  }
  threads.sort((a, b) => a.start - b.start)
  scene.threads = threads
  return scene
}

// ---- filling a lane ----------------------------------------------------------------------------

/** What a lane's head and name need to know. */
type LaneState = {
  running: number
  /** How many of the running calls are a subagent's. */
  light: number
  oldestRun: number
  newestRun: number
  faultAt: number
  faultGlyph: number
}

function reset(h: Halves): void {
  h.cover.fill(0)
  h.most.fill(0)
  h.dot.fill(0)
  h.step.fill(0)
  h.newest.fill(-Infinity)
  h.newestStart.fill(-Infinity)
  h.family.fill(0)
  h.mark.fill(0)
  h.markRank.fill(0)
  h.markAt.fill(-Infinity)
  h.markFamily.fill(0)
  h.spans.length = 0
}

function touch(h: Halves, i: number, at: number, startedAt: number, family: number): void {
  if (at < h.newest[i]!) return
  h.newest[i] = at
  h.newestStart[i] = startedAt
  h.family[i] = family
}

/** A mark in a half cell: a fault outranks a switch, which outranks the rest; among equals the newer wins. */
function mark(h: Halves, i: number, glyph: number, rank: number, at: number, family: number): void {
  if (h.mark[i] !== 0 && (rank < h.markRank[i]! || (rank === h.markRank[i]! && at < h.markAt[i]!))) return
  h.mark[i] = glyph
  h.markRank[i] = rank
  h.markAt[i] = at
  h.markFamily[i] = family
}

/**
 * Lays a lane's entries into its half cells. `station` undefined lays a thread's own calls, all of them heavy.
 * A finished call shorter than the half cell it ends in is a dot there; a refusal is a mark where it was refused.
 */
function fill(h: Halves, entries: readonly Entry[], station: StationId | undefined, now: number): LaneState {
  reset(h)
  const halves = h.size
  const state: LaneState = { running: 0, light: 0, oldestRun: Infinity, newestRun: -Infinity, faultAt: -Infinity, faultGlyph: ERROR }
  if (halves === 0) return state
  for (const e of entries) {
    const start = e.startedAt
    const isRunning = e.endedAt === undefined
    const end = e.endedAt ?? now
    const endAge = now - end
    if (endAge >= HORIZON_MS) continue
    const hs = halfOf(now - start, halves)
    const he = halfOf(endAge, halves)
    const isLight = station !== undefined && e.from === 'agents'
    const isBad = e.status === 'err' || e.status === 'block'
    // The person's interrupted turn is no fault of a station's.
    if (isBad && station !== 'you' && end >= state.faultAt) {
      state.faultAt = end
      state.faultGlyph = e.status === 'block' ? REFUSED : ERROR
    }
    const family = isBad ? FAULT : station === 'memory' ? MEMORY : MAIN
    if (e.mark === 'switch') {
      mark(h, hs, SWITCH, 1, start, CHANGE)
      continue
    }
    if (station === 'you' && (e.from === 'inbound' || e.mark === 'done' || (e.status === 'err' && e.endedAt === start))) {
      mark(h, hs, e.from === 'inbound' ? HEAD : e.mark === 'done' ? DONE : ERROR, 0, start, e.status === 'err' ? FAULT : PERSON)
      continue
    }
    if (station === 'memory' && e.from === 'inbound') {
      mark(h, hs, PUSHED, 0, start, MEMORY)
      continue
    }
    // A background task's launch is a dot where it began; its thread shows the rest.
    if (e.task !== undefined) {
      h.dot[hs]! |= isLight ? 2 : 1
      touch(h, hs, start, start, MAIN)
      continue
    }
    if (e.status === 'block') {
      mark(h, hs, REFUSED, 2, start, FAULT)
      continue
    }
    if (isRunning) {
      state.running++
      if (isLight) state.light++
      state.oldestRun = Math.min(state.oldestRun, start)
      state.newestRun = Math.max(state.newestRun, start)
    } else if (hs - he <= 1 && end - start < halfLasts(endAge, halves)) {
      if (e.status === 'err') mark(h, he, ERROR, 2, end, FAULT)
      else {
        h.dot[he]! |= isLight ? 2 : 1
        touch(h, he, end, start, family)
      }
      continue
    }
    for (let i = he; i <= hs; i++) {
      h.cover[i]! |= isLight ? 2 : 1
      touch(h, i, end, start, family)
    }
    h.spans.push(start, end)
    if (e.status === 'err') mark(h, he, ERROR, 2, end, FAULT)
    if (station === 'model') h.step[hs] = 1
  }
  sweep(h, now)
  return state
}

/**
 * How many calls are open at once in each half cell. Ends come before starts at the same moment, so calls that only
 * touch (one model step after another) never count as two.
 */
function sweep(h: Halves, now: number): void {
  const spans = h.spans
  const n = spans.length / 2
  if (n < 2) return
  // Most lanes never overlap at all: one pass in order of start tells.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => spans[2 * a]! - spans[2 * b]!)
  let reach = -Infinity
  let overlaps = false
  for (const i of order) {
    if (spans[2 * i]! < reach) overlaps = true
    reach = Math.max(reach, spans[2 * i + 1]!)
  }
  if (!overlaps) return
  const times: number[] = []
  const deltas: number[] = []
  for (let i = 0; i < n; i++) {
    times.push(spans[2 * i]!, spans[2 * i + 1]!)
    deltas.push(1, -1)
  }
  const events = Array.from({ length: 2 * n }, (_, i) => i).sort((a, b) => times[a]! - times[b]! || deltas[a]! - deltas[b]!)
  let open = 0
  for (let k = 0; k < events.length; k++) {
    const e = events[k]!
    open += deltas[e]!
    const next = events[k + 1]
    if (next === undefined || open < 2 || times[next]! <= times[e]!) continue
    const from = halfOf(now - times[next]!, h.size)
    const to = halfOf(now - times[e]!, h.size)
    for (let i = from; i <= to; i++) if (h.most[i]! < open) h.most[i] = open
  }
}

// ---- drawing -----------------------------------------------------------------------------------

/** The cells of a filled track, right to left from the now edge. Empty cells are left as they are. */
function drawTrack(cells: Cells, y: number, h: Halves, layout: Layout, now: number, isModel: boolean): void {
  const { nowCol, track, halves, paint } = layout
  let lastStep = -Infinity
  for (let k = 0; k < track; k++) {
    const r = 2 * k
    const l = r + 1
    let glyph: number
    let i: number
    const markR = h.mark[r]!
    const markL = h.mark[l]!
    if (markR !== 0 || markL !== 0) {
      const older = markR === 0 || (markL !== 0 && (h.markRank[l]! > h.markRank[r]! || (h.markRank[l] === h.markRank[r] && h.markAt[l]! > h.markAt[r]!)))
      i = older ? l : r
      glyph = h.mark[i]!
      cells.set(nowCol - 1 - k, y, glyph, tone(paint, h.markFamily[i]!, h.markAt[i]!, h.markAt[i]!, i, halves, now))
      continue
    }
    const coverR = h.cover[r]!
    const coverL = h.cover[l]!
    if ((coverR | coverL) !== 0) {
      const isHeavy = ((coverR | coverL) & 1) !== 0
      if (h.most[r]! >= 2 || h.most[l]! >= 2) glyph = DOUBLE
      else if (coverR !== 0 && coverL !== 0) {
        // Where one step follows another with no gap a half cell could show, inside the bar and not at its start,
        // and at least four cells from the last such tick.
        const follows = (h.step[r] === 1 || h.step[l] === 1) && l + 1 < halves && h.cover[l + 1] !== 0
        const isStep = isModel && isHeavy && follows && k - lastStep >= 4
        if (isStep) lastStep = k
        glyph = isStep ? STEP : isHeavy ? HEAVY : LIGHT
      } else if (coverL !== 0) glyph = isHeavy ? HEAVY_OLDER : LIGHT_OLDER
      else glyph = isHeavy ? HEAVY_NEWER : LIGHT_NEWER
    } else if ((h.dot[r]! | h.dot[l]!) !== 0) glyph = ((h.dot[r]! | h.dot[l]!) & 1) !== 0 ? DOT : SMALL_DOT
    else continue
    i = h.newest[l]! > h.newest[r]! ? l : r
    cells.set(nowCol - 1 - k, y, glyph, tone(paint, h.family[i]!, h.newest[i]!, h.newestStart[i]!, i, halves, now))
  }
}

/** Whether what moves without end (a beat, a breath) can move smoothly now; when it cannot, it holds still. */
type Motion = { smooth: boolean }

function drawLane(cells: Cells, y: number, station: StationId, layout: Layout, scene: Scene, board: Board, now: number, memory: Memory, motion: Motion): void {
  const { paint, nowCol, halves, t } = layout
  const { ink } = paint
  const h = layout.scratch
  const state = fill(h, scene.lanes[station], station, now)
  drawTrack(cells, y, h, layout, now, station === 'model')

  const isMemory = station === 'memory'
  const live = isMemory ? ink.mem : ink.accent
  if (state.running > 0 && now - state.oldestRun >= INSET_FROM_MS && halves > 0) {
    // How long the oldest running call has run, inside its bar, where it fits.
    const text = ` ${clock(now - state.oldestRun)} `
    const x = nowCol - 1 - (halfOf(now - state.oldestRun, halves) >> 1) + 2
    if (x + text.length - 1 <= nowCol - 3) cells.text(x, y, text, isMemory ? ink.memHot : ink.hot)
  }

  const alarmAge = now - state.faultAt
  const isAlarm = alarmAge >= 0 && alarmAge < ALARM_MS
  if (state.running > 0) {
    let glyph = state.light === state.running ? SUB_HEAD : HEAD
    let colour = live
    if (state.running >= 2) glyph = state.running > 9 ? 0x2b : 0x30 + state.running
    else if (now - state.newestRun < PULSE_MS) colour = isMemory ? ink.memHot : ink.hot
    else if (motion.smooth) {
      const phase = (now - state.oldestRun) % BEAT_MS
      if (phase < BEAT_FLASH_MS && glyph === HEAD) glyph = BEAT
      colour = (isMemory ? paint.memoryBeat : paint.beat)[stepOf((phase - BEAT_FLASH_MS) / (BEAT_MS - BEAT_FLASH_MS))]!
    }
    cells.set(nowCol, y, glyph, colour)
  } else if (isAlarm && !(alarmAge < BLINK_FOR_MS && Math.floor(alarmAge / BLINK_MS) % 2 === 1)) {
    cells.set(nowCol, y, state.faultGlyph, ink.red)
  }

  const count = Math.max(0, board.counts?.[station] ?? 0)
  const latest = scene.latest[station]
  let nameColour = ink.ash
  if (isAlarm) nameColour = ink.red
  else if (state.running > 0) nameColour = ink.bone
  else if (!scene.used.has(station)) nameColour = ink.dim
  else if (now - latest < GLOW_MS) nameColour = paint.names[stepOf((now - latest) / GLOW_MS)]!
  cells.text(layout.nameCol, y, t.stations[station], nameColour, undefined, layout.nameWidth)

  const flashAge = now - (memory.flashAt[station] ?? -Infinity)
  const countColour = flashAge >= 0 && flashAge < FLASH_MS ? paint.flash[stepOf(flashAge / FLASH_MS)]! : ink.dim
  const faults = Math.max(0, board.faults?.[station] ?? 0)
  const fault = `✕${faults > 99 ? 99 : faults}`
  const right = layout.countCol + 4
  if (layout.narrow && faults > 0) {
    // No room for both: what went wrong matters more than how often things went right.
    cells.text(right - fault.length, y, fault, ink.red)
  } else if (count > 0) {
    // Memory keeps two counts, as the map does: what was asked for, and what a hook brought unasked.
    const pushed = isMemory ? Math.min(count, Math.max(0, board.pushed ?? 0)) : 0
    const asked = count - pushed
    let head = figure(count)
    let tail = ''
    if (pushed > 0) {
      head = asked > 0 ? figure(asked) : ''
      tail = `↓${figure(pushed)}`
      if (head.length + tail.length > 4) head = ''
      if (tail.length > 4) [head, tail] = [figure(count), '']
    }
    const x = right - head.length - tail.length
    cells.text(x, y, head, countColour)
    cells.text(x + head.length, y, tail, flashAge >= 0 && flashAge < FLASH_MS ? countColour : ink.mem)
  }
  if (!layout.narrow && faults > 0) cells.text(layout.faultCol + 1, y, fault, ink.red)
}

function drawThread(cells: Cells, y: number, thread: Thread, layout: Layout, now: number, motion: Motion): void {
  const { paint, nowCol, halves, t, words } = layout
  const { ink } = paint
  if (halves === 0) return
  const startAge = now - thread.start
  const isBeyond = !(startAge < HORIZON_MS)
  const hs = isBeyond ? halves - 1 : halfOf(startAge, halves)
  const end = thread.end
  const he = end === undefined ? 0 : halfOf(now - end, halves)
  const family = thread.isAgent ? THINKING : TASK
  const live = paint.families[family]!.live
  for (let k = he >> 1; k <= hs >> 1; k++) {
    const hasNewer = 2 * k >= he
    const hasOlder = 2 * k + 1 <= hs
    const glyph = !thread.isAgent ? TASK_LINE : hasNewer && hasOlder ? LIGHT : hasOlder ? LIGHT_OLDER : LIGHT_NEWER
    const colour = end === undefined ? live : tone(paint, family, end, thread.start, hasNewer ? 2 * k : 2 * k + 1, halves, now)
    cells.set(nowCol - 1 - k, y, glyph, colour)
  }
  // A subagent's own calls ride on its line; its steps are the line itself.
  const calls = thread.calls.filter(e => e.station !== 'model')
  if (calls.length > 0) {
    fill(layout.scratch, calls, undefined, now)
    drawTrack(cells, y, layout.scratch, layout, now, false)
  }
  if (end !== undefined) cells.set(nowCol - 1 - (he >> 1), y, thread.failed ? ERROR : DONE, thread.failed ? ink.red : tone(paint, THINKING, end, end, he, halves, now))

  // The label sits just before where the thread began. Without room there it goes over the start of the line; past the
  // left edge it goes inside the line, with how long ago the thread began.
  const startX = nowCol - 1 - (hs >> 1)
  const endX = end === undefined ? nowCol : nowCol - 1 - (he >> 1)
  const label = glyphsOf(thread.label).length
  if (!isBeyond && startX - 2 >= label) cells.text(startX - 1 - label, y, thread.label, ink.ash)
  else if (!isBeyond) {
    const room = endX - 4
    if (room >= LABEL_MIN || room >= label) cells.text(1, y, `${cut(thread.label, room)} `, ink.ash)
  } else {
    const since = Number.isFinite(thread.start) ? ` · ${shortSpan(startAge, words)}` : ''
    const room = endX - startX - 5
    if (room >= 3) cells.text(startX + 1, y, ` ${cut(thread.label + since, room)} `, ink.ash)
  }

  const whereX = nowCol + 4
  if (end === undefined) {
    const beat = thread.isAgent ? BEAT_MS : TASK_BEAT_MS
    const phase = Number.isFinite(thread.start) ? (((now - thread.start) % beat) + beat) % beat : 0
    const colour = !motion.smooth ? (thread.isAgent ? ink.accent : live) : (thread.isAgent ? paint.beat : paint.taskBeat)[stepOf(phase / beat)]!
    cells.set(nowCol, y, thread.isAgent ? SUB_HEAD : HEAD, colour)
    let where: StationId = thread.isAgent ? 'model' : thread.station
    let newest = -Infinity
    for (const e of calls) {
      if (e.endedAt === undefined && e.startedAt >= newest) {
        newest = e.startedAt
        where = e.station
      }
    }
    cells.text(whereX, y, t.stations[where], ink.bone)
  } else {
    const took = Number.isFinite(thread.start) ? ` ${shortSpan(end - thread.start, words)}` : ''
    cells.set(whereX, y, thread.failed ? ERROR : DONE, thread.failed ? ink.red : ink.ash)
    cells.text(whereX + 1, y, took, ink.ash)
  }
}

/** The model and its step, and the context gauge at the right. */
function drawHeader(cells: Cells, layout: Layout, board: Board, scene: Scene, now: number, memory: Memory): void {
  const { paint, columns, t } = layout
  const { ink } = paint
  // At the left the model and its step (or what it changed from, for a while after a switch); at the right the gauge.
  const switchAge = now - scene.switchAt
  const isSwitching = switchAge >= 0 && switchAge < SWITCH_MS && scene.switchLabel !== ''
  const model = board.model === undefined ? '' : shortModel(board.model)
  const what = scene.compacting ? t.compacting : board.step !== undefined ? t.step(board.step) : ''
  const left = isSwitching ? scene.switchLabel : board.model === undefined ? layout.setup.core : what === '' ? model : `${model} · ${what}`
  let room = columns - 2
  if (memory.gauge !== undefined && board.context !== undefined) {
    const value = gaugeAt(memory.gauge, now)
    const n = layout.gaugeCells
    const filled = Math.round((value / 100) * n * 2)
    const percent = `${Math.round(value)}%`
    const fillColour = value >= 90 ? ink.red : value >= 70 ? ink.accent : ink.ash
    const word = glyphsOf(t.context).length + 1
    const gauge = n + 1 + percent.length
    // The word goes first when the row is short: the gauge says enough alone.
    const withWord = 1 + glyphsOf(left).length + 2 + word + gauge <= columns - 1
    let x = columns - 1 - gauge - (withWord ? word : 0)
    room = x - 3
    if (withWord) x += cells.text(x, 0, t.context, ink.dim) + 1
    for (let i = 0; i < n; i++) {
      const halves = filled - 2 * i
      cells.set(x + i, 0, halves >= 2 ? '━' : halves === 1 ? '╸' : '─', halves >= 1 ? fillColour : ink.line)
    }
    cells.text(x + n + 1, 0, percent, ink.ash)
  }
  if (isSwitching) cells.text(1, 0, scene.switchLabel, ink.hot, undefined, room)
  else if (board.model === undefined) cells.text(1, 0, layout.setup.core, ink.ash, undefined, room)
  else {
    const used = cells.text(1, 0, model, ink.bone, undefined, room)
    if (what !== '' && used < room) cells.text(1 + used, 0, ` · ${what}`, ink.ash, undefined, room - used)
  }
}

// ---- the rows ----------------------------------------------------------------------------------

type Row =
  | { kind: 'header' | 'axis' | 'space' | 'gap' | 'empty' }
  | { kind: 'lane'; station: StationId }
  | { kind: 'thread'; thread: Thread }
  | { kind: 'more'; count: number }
  | { kind: 'footer'; text: string }

const SPACE_ROW: Row = { kind: 'space' }
const GAP_ROW: Row = { kind: 'gap' }

function stack(lanes: readonly StationId[], spacing: Spacing): Row[] {
  const rows: Row[] = [{ kind: 'axis' }]
  if (spacing !== 'tight') rows.push(SPACE_ROW)
  lanes.forEach((station, i) => {
    rows.push({ kind: 'lane', station })
    if (i < lanes.length - 1 && (spacing === 'spaced' || (spacing === 'grouped' && GROUP_ENDS.has(station)))) rows.push(GAP_ROW)
  })
  return rows
}

/**
 * The rows top to bottom for `you-top`, mirrored under the header for `you-bottom`. When rows are short the threads
 * are capped, then lanes never used fold into a footer of names, then lanes idle for ten minutes (never You, Model,
 * or a lane lit now).
 */
function planOf(layout: Layout, scene: Scene, board: Board, now: number): Row[] {
  const { rows, spacing } = layout
  const threads = scene.threads.filter(th => th.end === undefined || (th.end >= scene.lastMessage && now - th.end < HORIZON_MS))
  const isLit = (s: StationId): boolean => scene.latest[s] > now - GLOW_MS
  const isUnused = (s: StationId): boolean => !scene.used.has(s) && (board.counts?.[s] ?? 0) === 0
  const keeps = (s: StationId): boolean => NEVER_FOLD.has(s) || isLit(s) || (s === 'agents' && threads.length > 0)
  const attempts = [
    ORDER,
    ORDER.filter(s => keeps(s) || !isUnused(s)),
    ORDER.filter(s => keeps(s) || (!isUnused(s) && scene.latest[s] >= now - FOLD_IDLE_MS)),
  ]
  const before = threads.length > 0 && (spacing === 'spaced' || spacing === 'grouped') ? 1 : 0
  let body: Row[] = []
  let folded: StationId[] = []
  let room = 0
  for (const lanes of attempts) {
    body = stack(lanes, spacing)
    folded = ORDER.filter(s => !lanes.includes(s))
    room = rows - 1 - body.length - (folded.length > 0 ? 1 : 0) - before
    if (room >= Math.min(threads.length, WANTED_THREADS)) break
  }
  if (threads.length > 0 && room > 0) {
    if (before === 1) body.push(SPACE_ROW)
    let shown = threads
    if (threads.length > room) {
      // The running ones first, then shown in the order they began.
      const ranked = [...threads].sort((a, b) => Number(a.end !== undefined) - Number(b.end !== undefined) || a.start - b.start)
      const kept = new Set(ranked.slice(0, room - 1))
      shown = threads.filter(th => kept.has(th))
    }
    for (const thread of shown) body.push({ kind: 'thread', thread })
    if (shown.length < threads.length) body.push({ kind: 'more', count: threads.length - shown.length })
  }
  const footer: Row[] = folded.length > 0 ? [{ kind: 'footer', text: folded.map(s => layout.t.stations[s]).join(' · ') }] : []
  while (body.length < rows - 1 - footer.length) body.push({ kind: 'empty' })
  body.push(...footer)
  body = body.slice(0, Math.max(0, rows - 1))
  return [{ kind: 'header' }, ...(layout.setup.layout === 'you-bottom' ? body.reverse() : body)]
}

// ---- the view ----------------------------------------------------------------------------------

function render(board: Board, now: number, size: ViewSize, setup: Setup, memory: Memory): Cells {
  const layout = layoutFor(size, setup, memory)
  merge(board, now, memory, layout.t)
  const { paint, columns, nowCol, halves } = layout
  const { ink } = paint
  const scene = memory.scene
  const cells = new Cells(columns, layout.rows, paint.ground)
  if (columns === 0 || layout.rows === 0) return cells

  const isIdle = !scene.busy && now - scene.lastActivity >= BREATH_STOPS_MS
  const isBusyNow = (Array.isArray(board.entries) && board.entries.some(e => e.status === 'run')) || (board.agents ?? []).length > 0
  const smooth = endlessEvery(now - memory.boardAt, isBusyNow) === FASTEST_MS
  let edge = paint.breath[8]!
  if (smooth && !isIdle) {
    const period = scene.busy ? BREATH_BUSY_MS : BREATH_REST_MS
    const phase = (((now % period) + period) % period) / period
    edge = paint.breath[stepOf((1 - Math.cos(2 * Math.PI * phase)) / 2)]!
  }
  let edgeGlyph = EDGE
  const doneAge = now - scene.done
  if (doneAge >= 0 && doneAge < DONE_MS) {
    // The answer is ready: the whole now edge turns bold and bright, then settles back.
    const f = doneAge / DONE_MS
    edgeGlyph = f < 0.6 ? CURTAIN : EDGE
    edge = f < 0.6 ? ink.bone : mix(ink.bone, edge, quantize((f - 0.6) / 0.4))
  }
  const motion: Motion = { smooth }

  const plan = planOf(layout, scene, board, now)
  plan.forEach((row, y) => {
    if (row.kind === 'lane' || row.kind === 'gap' || row.kind === 'space' || row.kind === 'thread' || row.kind === 'more') cells.set(nowCol, y, edgeGlyph, edge)
  })
  plan.forEach((row, y) => {
    switch (row.kind) {
      case 'header':
        drawHeader(cells, layout, board, scene, now, memory)
        break
      case 'axis':
        for (const label of layout.axis) cells.text(label.x, y, label.text, label.text === layout.words.now ? ink.ash : ink.dim)
        break
      case 'lane':
        drawLane(cells, y, row.station, layout, scene, board, now, memory, motion)
        break
      case 'thread':
        drawThread(cells, y, row.thread, layout, now, motion)
        break
      case 'more': {
        const text = layout.t.andMore(row.count).trim()
        cells.text(Math.max(1, nowCol - 2 - glyphsOf(text).length), y, text, ink.dim)
        break
      }
      case 'footer':
        cells.text(Math.max(1, columns - 1 - glyphsOf(row.text).length), y, row.text, ink.dim)
        break
    }
  })

  // Each message draws a faint line down through the lanes, in whatever cells nothing else took.
  if (halves > 0) {
    for (const at of scene.turns) {
      const age = now - at
      if (age < 0 || age >= HORIZON_MS) continue
      const x = nowCol - 1 - (halfOf(age, halves) >> 1)
      plan.forEach((row, y) => {
        if ((row.kind === 'lane' || row.kind === 'gap') && cells.glyph(x, y) === 0x20) cells.set(x, y, TURN, ink.line)
      })
    }
  }
  return cells
}

/** The time until the view next looks different: see `View.nextFrameIn`. */
function waitFor(board: Board, now: number, layout: Layout, memory: Memory, endless: number | undefined): number | undefined {
  const { halves } = layout
  const scene = memory.scene
  let wait = Infinity
  const soon = (ms: number): void => {
    if (ms < wait) wait = ms
  }
  /** A moment moves a half cell along the track, or off its left end. */
  const drift = (at: number): void => {
    const age = now - at
    if (age < 0 || age >= HORIZON_MS || halves === 0) return
    soon(ageOfHalf(halfOf(age, halves) + 1, halves) - age + 1)
  }
  for (const e of memory.ledger.values()) {
    const sinceStart = now - e.startedAt
    if (sinceStart >= 0 && sinceStart < PULSE_MS) soon(FASTEST_MS)
    if (e.endedAt === undefined) {
      if (e.task !== undefined) drift(e.startedAt)
      continue
    }
    const since = now - e.endedAt
    if (since >= HORIZON_MS) continue
    drift(e.startedAt)
    drift(e.endedAt)
    const coolMs = e.mark === 'switch' ? SWITCH_MS : GLOW_MS
    const coolFrom = e.mark === 'switch' ? sinceStart : since
    if (coolFrom >= 0 && coolFrom < coolMs) {
      // The next of its sixteen steps from live to rest.
      const step = coolMs / 16
      soon((Math.round(coolFrom / step) + 0.5) * step - coolFrom)
    }
    const took = e.endedAt - e.startedAt
    const dotFrom = (took * halves) / SPAN - KNEE_MS
    if (dotFrom > since) soon(dotFrom - since)
    if ((e.status === 'err' || e.status === 'block') && e.station !== 'you' && since >= 0 && since < ALARM_MS) {
      soon(since < BLINK_FOR_MS ? BLINK_MS - (since % BLINK_MS) : ALARM_MS - since)
    }
  }
  const doneAge = now - scene.done
  if (doneAge >= 0 && doneAge < DONE_MS) soon(FASTEST_MS)
  for (const id of ORDER) {
    const flashAge = now - (memory.flashAt[id] ?? -Infinity)
    if (flashAge >= 0 && flashAge < FLASH_MS) soon(FASTEST_MS)
  }
  if (memory.gauge !== undefined && now - memory.gauge.at < EASE_MS && memory.gauge.from !== memory.gauge.to) soon(FASTEST_MS)

  // What moves without end: a running call's bar, head and time; a task's beat; the now edge breathing.
  let need = Infinity
  if (scene.working) need = RUNNING_EVERY_MS
  else if (scene.tasking || (board.agents ?? []).length > 0) need = TASK_EVERY_MS
  const isIdle = !scene.busy && now - scene.lastActivity >= BREATH_STOPS_MS
  // A breath goes through sixteen colours each way; while anything runs, fifteen frames a second are enough for it.
  if (endless === FASTEST_MS && !isIdle) need = Math.min(need, scene.busy ? RUNNING_EVERY_MS : BREATH_REST_MS / 32)
  return soonest(wait === Infinity ? undefined : Math.max(0, wait), endless !== undefined && need !== Infinity ? Math.max(endless, need) : undefined)
}

export const lanes: View<Memory> = {
  memory: () => ({
    board: undefined,
    strings: undefined,
    boardAt: 0,
    ledger: new Map(),
    scene: emptyScene(),
    counts: {},
    flashAt: {},
    gauge: undefined,
    layout: undefined,
  }),
  draw(board, now, size, setup, memory) {
    try {
      return render(board, now, size, setup, memory)
    } catch {
      // A board this view cannot read gives a blank map, never a broken pane.
      return new Cells(Math.max(0, Math.floor(size.columns) || 0), Math.max(0, Math.floor(size.rows) || 0), groundFor(setup))
    }
  },
  nextFrameIn(board, now, size, setup, memory, endless) {
    try {
      const layout = layoutFor(size, setup, memory)
      merge(board, now, memory, layout.t)
      return waitFor(board, now, layout, memory, endless)
    } catch {
      return undefined
    }
  },
  hidesTally: true,
}
