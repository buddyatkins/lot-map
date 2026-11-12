// The city view, "Night Shift": the session as a city at night. Each station but the person and the model is a
// building, and each call lights one of its windows: white when made, then cooling through amber to an ember as the
// night goes on, so the skyline is the session's whole history. The model's steps are the stars, the context window
// is the moon, and the person is the street, where a light runs when a message arrives.
import type { Board, Entry, StationId, Status } from '../types'
import { Cells, cut, groundFor, inkFor, mix, rgb, soonest } from './cells'
import type { View, ViewSize } from './cells'
import { shortModel } from './map'
import type { Setup } from './map'
import { FASTEST_MS } from './raster'

// ---- the plan of the city ----------------------------------------------------------------------

/** The buildings, left to right. The person and the model are the street and the sky. */
const LOTS: readonly StationId[] = ['memory', 'files', 'shell', 'web', 'browser', 'agents', 'skills', 'hooks']

/** How many calls a window stands for: the first of these that lets the tallest building fit under the sky. */
const SCALES = [1, 2, 3, 4, 5, 6, 8].concat(
  [1, 2, 3].flatMap(power => [10, 12, 15, 20, 25, 30, 40, 50, 60, 80].map(s => s * 10 ** (power - 1))),
)

/** Seconds after its call ends that a window reaches each of its colours: fresh, settled, evening, late, ember. */
const AGES = [0, 3, 45, 360, 1500]
/** Steps between two of those colours. Few, so that a night of windows uses few colours. */
const RAMP_STEPS = 3
/** The quadrant blocks by their quadrants: 1 top left, 2 top right, 4 bottom left, 8 bottom right. */
const QUADRANTS = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'
/** The bit of each braille dot by its row (0 to 3, top down) and its column. */
const DOTS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const
/** A subagent seen from far off: two rotors and a body, as dots around its centre. */
const DRONE = [[-2, 0], [-1, 0], [2, 0], [3, 0], [0, 1], [1, 1]] as const
const MAX_DRONES = 8
/** A bank of cloud, by the height of each of its columns. */
const CLOUD = '▂▄▆▅▄▅▇▆▄▂'
const FULL_BLOCK = 0x2588
const RIGHT_HALF = 0x2590

const BEAM_RISE_MS = 200
const BEAM_FADE_MS = 1400
const FLASH_MS = 600
const LABEL_LIT_MS = 2500
const STREET_MS = 2600
const ABORT_MS = 1500
const GLIDE_MS = 900
const SPARK_MS = 700
const FIREWORK_MS = 2200
const SHOOTING_MS = 1200
const NAME_MS = 8000
const NEW_STAR_MS = 1500
const REFLOW_MS = 1000
const FLICKER_MS = 200
const BEACON_MS = 1500
const BREATH_MS = 2400
const CLOUD_MS = 4000
/** Calls more than this old are embers, the same whether the view still remembers them or not. */
const EMBER_MS = AGES[AGES.length - 1]! * 1000
/** Frame waits for what never ends: while calls run, while only the stars and the beacons move, and once the night is old. */
const RUNNING_EVERY = 100
const RESTING_EVERY = 250
const IDLE_EVERY = 1000
const IDLE_AFTER_MS = 600_000
/** The most calls the view remembers of a station; the rest are embers. */
const LEDGER_MAX = 2000

type Moon = { x: number; y: number; width: number; height: number; quadrants: Uint8Array }

/** What depends only on the size and the cells' shape: worked out once for each. */
type Plan = {
  key: string
  columns: number
  rows: number
  /** Windows on each floor. */
  across: number
  /** Where each building's wall stands. */
  walls: number[]
  /** From one building's wall to the next one's. */
  pitch: number
  street: number
  /** The ground floor's row. */
  base: number
  /** The most floors a building may have and leave the sky above it. */
  floors: number
  moon: Moon
  /** The halo's weight in each cell while the model thinks. */
  halo: Float32Array
  /** Every star the sky can hold, in the order they come out: dot positions, brightness, how fast each twinkles. */
  stars: { x: Uint16Array; y: Uint16Array; level: Uint8Array; speed: Float32Array; phase: Float32Array; hidden: Uint8Array }
  /** Room for a frame's braille dots and its washes of colour over the sky, kept between frames. */
  dots: { bits: Uint8Array; level: Int8Array; ink: Uint32Array }
  wash: { red: Float32Array; green: Float32Array; blue: Float32Array; touched: Uint8Array }
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)
const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const steps = (t: number, n: number): number => Math.round(clamp(t, 0, 1) * n) / n

/** A number from 0 to 1 that is the same for the same seed: where a star stands, which window flickers. */
function hash(seed: number): number {
  let x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

function planFor(size: ViewSize, cellShape: number): Plan {
  const columns = Math.max(0, Math.floor(size.columns))
  const rows = Math.max(0, Math.floor(size.rows))
  const across = clamp(Math.floor((columns - 16) / 8) - 1, 3, 5)
  const width = across + 1
  let gap = Math.max(0, Math.floor((columns - 2 - 8 * width) / 7))
  // On the narrowest panes the margins go before the gaps between the buildings do.
  if (gap === 0 && columns - 8 * width >= 7) gap = 1
  const span = 8 * width + 7 * gap
  const left = Math.floor((columns - span) / 2)
  const street = rows - 3
  const base = street - 1
  const isTall = rows >= 22
  const floors = Math.max(1, base - (isTall ? 5 : 4) + 1)

  // The moon is as round as the cells allow: as many columns as its rows are tall in column widths.
  const height = isTall ? 3 : 2
  const moonWidth = clamp(Math.round(height * cellShape), height + 1, 12)
  const moon: Moon = { x: columns - moonWidth - 2, y: isTall ? 1 : 0, width: moonWidth, height, quadrants: new Uint8Array(moonWidth * height) }
  for (let j = 0; j < height * 2; j++) {
    for (let i = 0; i < moonWidth * 2; i++) {
      const dx = (i + 0.5 - moonWidth) / moonWidth
      const dy = (j + 0.5 - height) / height
      // A touch over the circle, so that the rim of a small moon is not too thin.
      if (dx * dx + dy * dy > 1.02) continue
      const k = (j >> 1) * moonWidth + (i >> 1)
      moon.quadrants[k]! |= ((j & 1) === 0 ? 1 : 4) << (i & 1)
    }
  }

  // The halo reaches eleven columns from the moon, and as far up and down: rows are `cellShape` columns tall.
  const halo = new Float32Array(columns * rows)
  const cx = moon.x + (moonWidth - 1) / 2
  const cy = moon.y + (height - 1) / 2
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const dx = (x - cx) / 11
      const dy = ((y - cy) * cellShape) / 11
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < 1) halo[y * columns + x] = (1 - d) ** 1.4
    }
  }

  // The sky holds a star for about every fourth cell of it; they come out where a hash puts them, thicker overhead.
  const sky = Math.max(0, base)
  const cap = Math.round(columns * sky * 0.28)
  const stars = {
    x: new Uint16Array(cap),
    y: new Uint16Array(cap),
    level: new Uint8Array(cap),
    speed: new Float32Array(cap),
    phase: new Float32Array(cap),
    hidden: new Uint8Array(cap),
  }
  for (let i = 0; i < cap; i++) {
    const x = Math.floor(hash(i * 2 + 1) * columns * 2)
    const y = Math.floor(hash(i * 2 + 2) ** 1.6 * sky * 4)
    const r = hash(i * 7 + 3)
    stars.x[i] = x
    stars.y[i] = y
    stars.level[i] = r < 0.1 ? 3 : r < 0.4 ? 2 : 1
    stars.speed[i] = (0.5 + hash(i * 11) * 1.6) / 1000
    stars.phase[i] = hash(i * 13) * 40
    const col = x / 2
    const row = y / 4
    stars.hidden[i] = col >= moon.x - 1 && col <= moon.x + moonWidth && row >= moon.y - 0.5 && row <= moon.y + height ? 1 : 0
  }

  const cells = columns * rows
  return {
    key: planKey(size, cellShape),
    columns,
    rows,
    across,
    walls: LOTS.map((_, i) => left + i * (width + gap)),
    pitch: width + gap,
    street,
    base,
    floors,
    moon,
    halo,
    stars,
    dots: { bits: new Uint8Array(cells), level: new Int8Array(cells), ink: new Uint32Array(cells) },
    wash: { red: new Float32Array(cells), green: new Float32Array(cells), blue: new Float32Array(cells), touched: new Uint8Array(cells) },
  }
}

const planKey = (size: ViewSize, cellShape: number): string => `${size.columns}x${size.rows}x${cellShape}`

/** The fewest calls a window can stand for and keep the tallest building under the sky. */
function scaleFor(most: number, across: number, floors: number): number {
  for (const k of SCALES) if (Math.ceil(Math.ceil(most / k) / across) <= floors) return k
  return Math.ceil(most / (across * floors))
}

const floorsOf = (count: number, k: number, across: number): number => Math.ceil(Math.ceil(count / k) / across)

// ---- colours -----------------------------------------------------------------------------------

type Tones = {
  bodies: number[]
  unlit: number
  /** Window colours by age: 13 steps from fresh to ember, for the warm windows, memory's and the subagents'. */
  warm: number[]
  teal: number[]
  white: number[]
  /** A running call's window flickers between these; the last is a background task's steady light. */
  running: number[]
  red: number
  flash: number
  scar: number
  beaconDim: number
  beaconLit: number
  stars: number[]
  moon: number
  moonAmber: number
  moonRed: number
  moonDark: number
  cloud: number
  label: number
  labelOn: number
  labelRed: number
  street: number
  accent: number
  mem: number
  drone: number
  droneBlink: number
  tether: number
  crane: number
  mast: number
  /** What the washes over the sky mix from, as three channels. */
  ground: [number, number, number]
  /** Washes count for more on a light sky, where the same tint shows less. */
  tintGain: number
}

/** Five colours a window passes through, made into the steps it shows. */
function rampOf(stops: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < stops.length - 1; i++) for (let s = 0; s < RAMP_STEPS; s++) out.push(mix(stops[i]!, stops[i + 1]!, s / RAMP_STEPS))
  out.push(stops[stops.length - 1]!)
  return out
}

/** The steps of a person's own colour: the same shape as the designed ramps, from near white to an ember. */
const ownRamp = (c: number): number[] => rampOf([mix(c, 0xffffff, 0.6), c, mix(c, 0x000000, 0.18), mix(c, 0x000000, 0.36), mix(c, 0x000000, 0.5)])

const hexes = (list: string[]): number[] => list.map(rgb)

// The windows burn in the same colours on either theme: the buildings stay dark, and on a light ground they stand as ink.
const WARM = hexes(['#fbe4c4', '#e1ac6e', '#b88a58', '#8f6c46', '#6e5439'])
const TEAL = hexes(['#c8f2eb', '#62c7ba', '#4c9c92', '#3c7c74', '#2f605a'])
const WHITE = hexes(['#ffffff', '#d3d8e0', '#a8aeb8', '#868c96', '#6e5439'])
const RUNNING = hexes(['#fff6e6', '#f7d6a8', '#ffeccc', '#f0c595'])

function tonesFor(setup: Setup): Tones {
  const ink = inkFor(setup)
  const isLight = setup.theme === 'light'
  const own = setup.colors
  const red = own.red === undefined ? rgb('#e8654f') : ink.red
  return {
    bodies: hexes(isLight ? ['#2c3039', '#30353e', '#292d35', '#2e333c'] : ['#141820', '#171b24', '#12161e', '#161a23']),
    unlit: rgb(isLight ? '#3b414c' : '#20252f'),
    warm: own.accent === undefined ? rampOf(WARM) : ownRamp(ink.accent),
    teal: own.mem === undefined ? rampOf(TEAL) : ownRamp(ink.mem),
    white: rampOf(WHITE),
    running: RUNNING,
    red,
    flash: mix(red, 0xffffff, 0.35),
    scar: mix(red, 0x000000, 0.53),
    beaconDim: mix(red, 0x000000, 0.48),
    beaconLit: mix(red, 0xffffff, 0.12),
    stars: hexes(isLight ? ['#cfc9bc', '#b3ada1', '#948f86', '#6f747d', '#3f444d'] : ['#2f343d', '#4f5562', '#7d838f', '#b9b5ad', '#f6f1e8']),
    moon: rgb(isLight ? '#e3c38f' : '#ece4d2'),
    moonAmber: rgb(isLight ? '#d99a4e' : '#f0c595'),
    moonRed: isLight ? ink.red : red,
    moonDark: rgb(isLight ? '#dcd6ca' : '#1e2128'),
    cloud: rgb(isLight ? '#b3ada1' : '#3a3f4a'),
    label: ink.dim,
    labelOn: ink.bone,
    labelRed: ink.red,
    street: ink.line,
    accent: ink.accent,
    mem: ink.mem,
    drone: rgb(isLight ? '#4a505b' : '#d3d8e0'),
    droneBlink: rgb(isLight ? '#1f2228' : '#ffffff'),
    tether: rgb(isLight ? '#a9a59b' : '#565c68'),
    crane: rgb(isLight ? '#b8762a' : '#b98d58'),
    mast: rgb(isLight ? '#5f6570' : '#3a3f4a'),
    ground: [(ink.ground >> 16) & 0xff, (ink.ground >> 8) & 0xff, ink.ground & 0xff],
    tintGain: isLight ? 1.3 : 1,
  }
}

/** Which of a ramp's steps a window shows `seconds` after its call ended. */
function rampIndex(seconds: number): number {
  if (!(seconds > 0)) return 0
  for (let i = 0; i < AGES.length - 1; i++) {
    const from = AGES[i]!
    const to = AGES[i + 1]!
    if (seconds < to) return i * RAMP_STEPS + Math.round(((seconds - from) / (to - from)) * RAMP_STEPS)
  }
  return (AGES.length - 1) * RAMP_STEPS
}

/** Ms until a window `seconds` after its call takes its next step, or undefined once it is an ember. */
function nextStepIn(seconds: number): number | undefined {
  for (let i = 0; i < AGES.length - 1; i++) {
    const from = AGES[i]!
    const to = AGES[i + 1]!
    if (seconds >= to) continue
    for (let s = 0; s < RAMP_STEPS; s++) {
      const at = from + ((s + 0.5) / RAMP_STEPS) * (to - from)
      if (at > seconds) return (at - seconds) * 1000
    }
  }
  return undefined
}

// ---- the ledger: every call a window stands for ------------------------------------------------

/** A call as its window needs it. The board keeps only its newest rows, so the view keeps its own. */
type Call = {
  /** Its place among its station's calls since the session began: which window it lights. */
  ordinal: number
  startedAt: number
  endedAt: number | undefined
  status: Status
  /** A subagent's call: its window burns white. */
  isAgents: boolean
  /** A background task: its window burns steady while it runs, and a crane stands on the roof. */
  isTask: boolean
  /** A fault since the person's last message: red, where an older one is a scar. */
  isFresh: boolean
  /** The last board it was on, by the count of boards the ledger has taken in. */
  seenIn: number
}

type Memory = {
  calls: Map<string, Call>
  /** Each station's calls, oldest first. */
  lots: Map<StationId, Call[]>
  /** The board last taken in, and how many have been: frames of one board take it in once. */
  board: Board | undefined
  boards: number
  /** How many calls a window stands for, since when, and each building's floors then: they re-flow for a second when it changes. */
  scale: { k: number; at: number; from: number[] } | undefined
  /** Each building's floors on the last frame. */
  shown: number[] | undefined
  plan: Plan | undefined
  tones: { key: string; tones: Tones } | undefined
}

const isFault = (status: Status): boolean => status === 'err' || status === 'block'
/** A station's count as a whole number of calls, whatever the board holds. */
const countOf = (board: Board, station: StationId): number => {
  const n = board.counts[station]
  return n !== undefined && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}
const isLot = (station: StationId): boolean => station !== 'you' && station !== 'model'

/** Brings the ledger up to date with a board: new calls get the place their station's count gives them. */
function remember(memory: Memory, board: Board, now: number): void {
  if (memory.board === board) return
  memory.board = board
  const seenIn = ++memory.boards
  const own = new Map<StationId, Entry[]>()
  for (const e of board.entries) {
    if (!isLot(e.station) || e.mark === 'switch') continue
    const list = own.get(e.station)
    if (list === undefined) own.set(e.station, [e])
    else list.push(e)
  }
  let forgot = false
  for (const lot of LOTS) {
    const entries = own.get(lot) ?? []
    let calls = memory.lots.get(lot)
    if (calls === undefined) {
      calls = []
      memory.lots.set(lot, calls)
    }
    // The newest row is the station's last call, and the rows before it count down from there.
    const total = Math.max(countOf(board, lot), entries.length)
    let isNew = false
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!
      const known = memory.calls.get(e.id)
      if (known !== undefined) {
        known.status = e.status
        known.endedAt = e.endedAt
        known.isTask = e.task !== undefined
        known.seenIn = seenIn
        continue
      }
      const call: Call = {
        ordinal: total - (entries.length - i),
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        status: e.status,
        isAgents: e.from === 'agents' || e.agentId !== undefined,
        isTask: e.task !== undefined,
        isFresh: false,
        seenIn,
      }
      memory.calls.set(e.id, call)
      calls.push(call)
      isNew = true
    }
    if (isNew) calls.sort((a, b) => a.ordinal - b.ordinal)

    // A call that left the board still running will never be heard from again: it ends here.
    // Calls that have left the board and burnt down to embers are forgotten; their windows stay embers.
    // Their faults go with them, so that a scar never stands for a window whose later calls are forgotten.
    let kept = 0
    for (const call of calls) {
      if (call.seenIn !== seenIn && call.status === 'run') {
        call.status = 'ok'
        call.endedAt = now
      }
      const isEmber = call.seenIn !== seenIn && now - (call.endedAt ?? call.startedAt) > EMBER_MS
      if (!isEmber) calls[kept++] = call
    }
    if (kept < calls.length) forgot = true
    calls.length = kept
    if (calls.length > LEDGER_MAX) {
      calls.splice(0, calls.length - LEDGER_MAX)
      forgot = true
    }

    // The newest of the station's faults, as many as it has had since the person's last message, are fresh.
    let fresh = board.faults?.[lot] ?? 0
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i]!
      call.isFresh = isFault(call.status) && fresh-- > 0
    }
  }
  if (forgot) {
    const kept = new Set<Call>()
    for (const calls of memory.lots.values()) for (const call of calls) kept.add(call)
    for (const [id, call] of memory.calls) if (!kept.has(call)) memory.calls.delete(id)
  }
}

// ---- drawing -----------------------------------------------------------------------------------

/** A building as this frame draws it. */
type Tower = {
  lot: StationId
  index: number
  wall: number
  /** The middle of its windows, in columns. */
  middle: number
  windows: number
  /** Floors drawn now: the floors it has, or on the way there while the buildings re-flow. */
  floors: number
  /** The row above its roof. */
  roof: number
  entries: Entry[]
}

type Frame = {
  board: Board
  now: number
  setup: Setup
  plan: Plan
  tones: Tones
  memory: Memory
  cells: Cells
  towers: Tower[]
  k: number
}

function frameOf(board: Board, now: number, size: ViewSize, setup: Setup, memory: Memory): Frame {
  const key = planKey(size, setup.cellShape)
  if (memory.plan?.key !== key) memory.plan = planFor(size, setup.cellShape)
  const plan = memory.plan
  const toneKey = `${setup.theme}|${JSON.stringify(setup.colors)}`
  if (memory.tones?.key !== toneKey) memory.tones = { key: toneKey, tones: tonesFor(setup) }
  remember(memory, board, now)

  const counts = LOTS.map(lot => {
    const calls = memory.lots.get(lot) ?? []
    return Math.max(countOf(board, lot), (calls[calls.length - 1]?.ordinal ?? -1) + 1)
  })
  const k = scaleFor(Math.max(1, ...counts), plan.across, plan.floors)
  const settled = counts.map(count => floorsOf(count, k, plan.across))
  // A new scale starts the buildings from the height they stood at on the last frame.
  if (memory.scale === undefined) memory.scale = { k, at: -Infinity, from: settled }
  else if (memory.scale.k !== k) memory.scale = { k, at: now, from: memory.shown ?? settled }
  const { from, at } = memory.scale
  const reflow = ease(clamp((now - at) / REFLOW_MS, 0, 1))
  const shown = settled.map((floors, i) => Math.min(plan.floors, reflow >= 1 ? floors : Math.round((from[i] ?? floors) + (floors - (from[i] ?? floors)) * reflow)))
  memory.shown = shown

  const towers = LOTS.map((lot, index): Tower => {
    const wall = plan.walls[index]!
    return {
      lot,
      index,
      wall,
      middle: wall + 1 + (plan.across - 1) / 2,
      windows: Math.ceil(counts[index]! / k),
      floors: shown[index]!,
      roof: plan.base - shown[index]!,
      entries: board.entries.filter(e => e.station === lot && e.mark !== 'switch'),
    }
  })
  return { board, now, setup, plan, tones: memory.tones.tones, memory, cells: new Cells(plan.columns, plan.rows, groundFor(setup)), towers, k }
}

/** The tower a subagent's call belongs to; the agents' own for what has no building. */
const towerOf = (frame: Frame, station: StationId | undefined): Tower =>
  frame.towers.find(t => t.lot === station) ?? frame.towers[LOTS.indexOf('agents')]!

const isThinking = (board: Board): boolean => board.entries.some(e => e.station === 'model' && e.status === 'run' && e.from !== 'agents')

function wash(frame: Frame, x: number, y: number, colour: number, alpha: number): void {
  const { plan } = frame
  if (x < 0 || y < 0 || x >= plan.columns || y >= plan.rows) return
  const a = Math.min(1, Math.round(alpha * frame.tones.tintGain * 50) / 50)
  if (a <= 0) return
  const i = y * plan.columns + x
  const w = plan.wash
  if (w.touched[i] === 0) {
    w.touched[i] = 1
    ;[w.red[i], w.green[i], w.blue[i]] = frame.tones.ground
  }
  w.red[i]! += (((colour >> 16) & 0xff) - w.red[i]!) * a
  w.green[i]! += (((colour >> 8) & 0xff) - w.green[i]!) * a
  w.blue[i]! += ((colour & 0xff) - w.blue[i]!) * a
}

/** One braille dot, at a place on the grid of dots; where dots share a cell the brightest names its colour. */
function dot(frame: Frame, dx: number, dy: number, colour: number, level: number): void {
  const { plan } = frame
  const x = Math.floor(dx / 2)
  const y = Math.floor(dy / 4)
  if (dx < 0 || dy < 0 || x >= plan.columns || y >= plan.rows) return
  const i = y * plan.columns + x
  const d = plan.dots
  d.bits[i]! |= DOTS[dy & 3]![dx & 1]!
  if (level >= d.level[i]!) {
    d.level[i] = level
    d.ink[i] = colour
  }
}

/** The washes of light over the sky: the moon's halo while the model thinks, the city's glow, the beams of running calls. */
function drawWashes(frame: Frame): void {
  const { board, now, plan, tones } = frame
  const w = plan.wash
  w.touched.fill(0)

  if (isThinking(board)) {
    const breath = 0.5 + 0.5 * Math.sin((2 * Math.PI * now) / BREATH_MS)
    const strength = 0.13 + 0.09 * breath
    for (let i = 0; i < plan.halo.length; i++) {
      const h = plan.halo[i]!
      if (h > 0) wash(frame, i % plan.columns, Math.floor(i / plan.columns), tones.accent, strength * h)
    }
  }

  // The city glows on the horizon with the pace of the work: calls of the last minutes, each worth half as much a minute on.
  let rate = isThinking(board) ? 2 : 0
  for (const e of board.entries) if (isLot(e.station) && now >= e.startedAt) rate += 0.5 ** ((now - e.startedAt) / 60_000)
  const glow = clamp(rate / 14, 0, 1)
  if (glow > 0) {
    for (let y = Math.max(0, plan.base - 8); y <= plan.base; y++) {
      const a = glow * 0.16 * (1 - (plan.base - y) / 9) ** 1.8
      for (let x = 0; x < plan.columns; x++) wash(frame, x, y, tones.accent, a)
    }
  }

  // A call of the main loop shines a beam from its roof while it runs, and it falls away after.
  for (const t of frame.towers) {
    let strength = 0
    let colour = t.lot === 'memory' ? tones.mem : tones.accent
    for (const e of t.entries) {
      if (e.from !== 'core' || e.task !== undefined) continue
      if (e.status === 'run') strength = Math.max(strength, clamp((now - e.startedAt) / BEAM_RISE_MS, 0, 1))
      else if (e.endedAt !== undefined && now >= e.endedAt && now - e.endedAt < BEAM_FADE_MS) {
        const left = 1 - (now - e.endedAt) / BEAM_FADE_MS
        if (left > strength) {
          strength = left
          if (isFault(e.status)) colour = tones.red
        }
      }
    }
    if (strength <= 0) continue
    const roof = t.floors > 0 ? t.roof + 1 : plan.base + 1
    const width = plan.across + 1
    for (let y = roof - 1; y >= 0; y--) {
      const fall = (1 - (roof - y) / (roof + 1)) ** 1.25
      const shimmer = 0.92 + 0.08 * Math.sin(now / 160 + y * 0.9)
      for (let x = t.wall; x <= t.wall + width; x++) {
        const off = Math.abs(x - (t.wall + width / 2)) / (width / 2 + 0.5)
        const across = off < 0.45 ? 1 : off < 0.8 ? 0.6 : 0.25
        wash(frame, x, y, colour, strength * 0.3 * fall * across * shimmer)
      }
    }
  }

  const { cells } = frame
  for (let i = 0; i < w.touched.length; i++) {
    if (w.touched[i] === 0) continue
    cells.tint(i % plan.columns, Math.floor(i / plan.columns), (Math.round(w.red[i]!) << 16) | (Math.round(w.green[i]!) << 8) | Math.round(w.blue[i]!))
  }
}

/** The stars, one for each step of the model: many at first, fewer as the sky fills. */
function drawStars(frame: Frame): void {
  const { board, now, plan, tones } = frame
  const s = plan.stars
  const cap = s.x.length
  const shown = Math.min(cap, Math.round(cap * (1 - Math.exp(-countOf(board, 'model') / Math.max(1, cap)))))
  let newest: Entry | undefined
  for (const e of board.entries) if (e.station === 'model' && e.mark !== 'switch') newest = e
  const isNew = newest !== undefined && now >= newest.startedAt && now - newest.startedAt < NEW_STAR_MS
  for (let i = 0; i < shown; i++) {
    if (s.hidden[i] === 1) continue
    let level = s.level[i]!
    const twinkle = Math.sin(now * s.speed[i]! + s.phase[i]!)
    if (twinkle > 0.93) level = Math.min(4, level + 1)
    else if (twinkle < -0.97) level = Math.max(0, level - 1)
    if (isNew && i === shown - 1) level = 4
    dot(frame, s.x[i]!, s.y[i]!, tones.stars[level]!, level)
  }
}

/** Each subagent still at work, as a drone over the building of its latest call. */
function drawDrones(frame: Frame): void {
  const { board, now, plan, tones } = frame
  const crew = board.agents ?? []
  const shown = crew.slice(0, MAX_DRONES)
  const drones = shown.map((agentId, j) => {
    let tool: Entry | undefined
    let before: Entry | undefined
    let step: Entry | undefined
    for (const e of board.entries) {
      if (e.agentId !== agentId) continue
      if (e.station === 'model') step = e
      else {
        before = tool
        tool = e
      }
    }
    const to = towerOf(frame, tool?.station)
    const from = towerOf(frame, before?.station ?? tool?.station)
    const glide = tool === undefined ? 1 : ease(clamp((now - tool.startedAt) / GLIDE_MS, 0, 1))
    const thinks = step?.status === 'run' && (tool === undefined || step.startedAt > tool.startedAt)
    return { j, to, x: from.middle + (to.middle - from.middle) * glide, isWorking: tool?.status === 'run' && !thinks, thinks }
  })
  for (const d of drones) {
    const peers = drones.filter(o => o.to === d.to)
    const slot = peers.indexOf(d)
    const roof = d.to.floors > 0 ? d.to.roof + 1 : plan.base + 1
    const row = Math.max(1, roof - 3 - (slot % 2))
    const sx = Math.round(d.x * 2) + 1 + Math.round((slot - (peers.length - 1) / 2) * 6)
    const sy = row * 4 + 1 + Math.round(Math.sin(now / 650 + d.j * 2.1))
    const blink = (Math.floor(now / 600) + d.j) % 3 === 0
    const colour = d.thinks ? (blink ? tones.running[0]! : tones.accent) : blink ? tones.droneBlink : tones.drone
    for (const [ox, oy] of DRONE) dot(frame, sx + ox, sy + oy, colour, 6)
    if (d.isWorking) for (let y = sy + 3; y < roof * 4 - 1; y += 2) dot(frame, sx + 1, y, tones.tether, 5)
  }
  if (crew.length > shown.length) {
    const agents = towerOf(frame, 'agents')
    const roof = agents.floors > 0 ? agents.roof + 1 : plan.base + 1
    frame.cells.text(agents.wall + 1, Math.max(0, roof - 6), `+${crew.length - shown.length}`, tones.drone)
  }
}

/** Moments: a firework when an answer is ready, a shooting star when the model changes, a spark of memory falling in. */
function drawMoments(frame: Frame): void {
  const { board, now, plan, tones, setup } = frame
  let done: Entry | undefined
  for (const e of board.entries) if (e.mark === 'done') done = e
  if (done !== undefined && now >= done.startedAt && now - done.startedAt < FIREWORK_MS) {
    const t = (now - done.startedAt) / FIREWORK_MS
    const bx = Math.round(plan.columns * (0.3 + 0.35 * hash(Math.floor(done.startedAt)))) * 2
    const by = clamp(Math.round(plan.base / 4), 2, 7) * 4 + 2
    const r = 11 * (1 - (1 - t) ** 3)
    const colour = t < 0.25 ? tones.running[0]! : t < 0.55 ? tones.running[3]! : t < 0.8 ? tones.accent : tones.warm[9]!
    // Dots are half a column wide and a quarter of a row tall: the burst is squeezed to come out round.
    const squeeze = 2 / setup.cellShape
    for (let a = 0; a < 18; a++) {
      const angle = (a / 18) * Math.PI * 2
      for (const f of [1, 0.72]) dot(frame, Math.round(bx + Math.cos(angle) * r * f), Math.round(by + Math.sin(angle) * r * f * squeeze + 6 * t * t), colour, 7)
    }
  }

  if (board.switchedAt !== undefined && now >= board.switchedAt && now - board.switchedAt < SHOOTING_MS) {
    const t = (now - board.switchedAt) / SHOOTING_MS
    const [x0, y0, x1, y1] = [plan.columns * 0.2, 2, plan.columns * 1.4, Math.min(14, plan.base * 2)]
    for (let k = 0; k < 14; k++) {
      const u = t - k * 0.02
      if (u < 0) continue
      dot(frame, Math.round(x0 + (x1 - x0) * u), Math.round(y0 + (y1 - y0) * u), tones.stars[k < 2 ? 4 : k < 6 ? 3 : 2]!, 7 - Math.floor(k / 3))
    }
  }

  // What a hook brought to memory unasked falls into its building as a spark.
  for (const e of board.entries) {
    if (e.from !== 'inbound' || !isLot(e.station) || now < e.startedAt || now - e.startedAt > SPARK_MS) continue
    const t = towerOf(frame, e.station)
    const roof = t.floors > 0 ? t.roof + 1 : plan.base
    const head = Math.round(((now - e.startedAt) / SPARK_MS) * roof * 4)
    for (let k = 0; k < 6; k++) if (head - k * 2 >= 0) dot(frame, Math.round(t.middle * 2) + 1, head - k * 2, k < 2 ? tones.teal[0]! : tones.mem, 7)
  }
}

function drawDots(frame: Frame): void {
  const { plan, cells } = frame
  const d = plan.dots
  for (let i = 0; i < d.bits.length; i++) {
    if (d.bits[i] === 0) continue
    cells.set(i % plan.columns, Math.floor(i / plan.columns), 0x2800 | d.bits[i]!, d.ink[i])
  }
}

/** The moon: the context window, lit from the right as it fills; amber when it is getting full, red when nearly. */
function drawMoon(frame: Frame): void {
  const { board, now, plan, tones, cells, setup } = frame
  const { moon } = plan
  const context = board.context
  const lit = context === undefined || !Number.isFinite(context) ? 0 : clamp(context / 100, 0, 1)
  const colour = lit >= 0.9 ? tones.moonRed : lit >= 0.7 ? tones.moonAmber : tones.moon
  const halves = moon.width * 2
  const litFrom = halves - Math.round(lit * halves)
  for (let r = 0; r < moon.height; r++) {
    for (let c = 0; c < moon.width; c++) {
      const quadrants = moon.quadrants[r * moon.width + c]!
      if (quadrants === 0) continue
      const x = moon.x + c
      const y = moon.y + r
      const isLeftLit = c * 2 >= litFrom
      const isRightLit = c * 2 + 1 >= litFrom
      if (quadrants === 15) {
        if (isLeftLit === isRightLit) cells.set(x, y, '█', isLeftLit ? colour : tones.moonDark)
        else cells.set(x, y, '▐', colour, tones.moonDark)
        continue
      }
      // A cell the moon's edge crosses has one colour to give: the lit part's, if it has one.
      const litQuadrants = quadrants & ((isLeftLit ? 5 : 0) | (isRightLit ? 10 : 0))
      if (litQuadrants !== 0) cells.set(x, y, QUADRANTS[litQuadrants]!, colour)
      else cells.set(x, y, QUADRANTS[quadrants]!, tones.moonDark)
    }
  }

  // While the context is compacted, a bank of cloud drifts across the foot of the moon, again and again.
  if (board.entries.some(e => e.station === 'model' && e.status === 'run' && e.label === setup.t.compacting)) {
    const from = moon.x - CLOUD.length
    const travel = moon.width + CLOUD.length + 2
    const left = from + Math.floor(((now / CLOUD_MS) % 1) * travel)
    const y = moon.y + moon.height - 1
    for (let c = 0; c < CLOUD.length; c++) {
      const x = left + c
      // In front of the moon the cloud stands on the moon's own light.
      const there = cells.glyph(x, y)
      const behind = there === FULL_BLOCK || there === RIGHT_HALF ? cells.fg(x, y) : cells.bg(x, y)
      cells.set(x, y, CLOUD[c]!, tones.cloud, behind)
    }
  }
}

function windowColour(frame: Frame, t: Tower, w: number, newest: Call | undefined, fault: Call | undefined): number {
  const { now, tones } = frame
  // A fault since the last message shows whatever came after it in its window; an older one only while it is the newest there.
  if (fault !== undefined && (fault.isFresh || fault === newest)) {
    if (!fault.isFresh) return tones.scar
    const age = now - (fault.endedAt ?? fault.startedAt)
    return age >= 0 && age < FLASH_MS && Math.floor(age / 150) % 2 === 0 ? tones.flash : tones.red
  }
  const family = t.lot === 'memory' ? tones.teal : tones.warm
  if (newest === undefined) return family[family.length - 1]!
  if (newest.status === 'run') return newest.isTask ? tones.running[3]! : tones.running[Math.floor(hash(Math.floor(now / FLICKER_MS) * 31 + w * 7 + t.index * 977) * 4)]!
  const ramp = newest.isAgents && t.lot !== 'memory' ? tones.white : family
  return ramp[rampIndex((now - (newest.endedAt ?? newest.startedAt)) / 1000)]!
}

function drawBuildings(frame: Frame): void {
  const { board, now, plan, tones, cells, memory, k } = frame
  const faults = board.faults ?? {}
  for (const t of frame.towers) {
    const body = tones.bodies[t.index % tones.bodies.length]!
    if (t.floors === 0) {
      for (let x = t.wall + 1; x <= t.wall + plan.across; x++) cells.set(x, plan.base, '▁', tones.street)
      continue
    }
    // Which call each window shows: the newest of those it stands for, or a fault among them.
    const newest: (Call | undefined)[] = new Array(t.windows)
    const faulty: (Call | undefined)[] = new Array(t.windows)
    for (const call of memory.lots.get(t.lot) ?? []) {
      const w = Math.floor(call.ordinal / k)
      if (w < 0 || w >= t.windows) continue
      newest[w] = call
      if (isFault(call.status)) faulty[w] = call
    }
    for (let f = 0; f < t.floors; f++) {
      const y = plan.base - f
      cells.set(t.wall, y, '▐', body)
      for (let c = 0; c < plan.across; c++) {
        const w = f * plan.across + c
        const colour = w < t.windows ? windowColour(frame, t, w, newest[w], faulty[w]) : tones.unlit
        cells.set(t.wall + 1 + c, y, '▖', colour, body)
      }
    }

    // Rooftops: a dome on memory, a mast on the network, a landing pad on the agents' building.
    const roof = t.roof
    const middle = Math.round(t.middle)
    if (t.lot === 'memory') {
      cells.set(t.wall + 1, roof, '▗', body)
      for (let x = t.wall + 2; x < t.wall + plan.across; x++) cells.set(x, roof, '▄', body)
      cells.set(t.wall + plan.across, roof, '▖', body)
    } else if (t.lot === 'web') {
      cells.set(middle, roof, '╻', tones.mast)
      cells.set(middle, roof - 1, '╷', tones.mast)
    } else if (t.lot === 'agents') {
      for (let x = t.wall + 1; x <= t.wall + plan.across; x++) cells.set(x, roof, '▁', tones.mast)
    }

    // A crane while a background task works here; its hook rides the jib.
    if (t.entries.some(e => e.status === 'run' && e.task !== undefined)) {
      const mast = t.wall + plan.across
      cells.set(t.wall - 1, roof - 1, '╺', tones.crane)
      for (let x = t.wall; x < mast; x++) cells.set(x, roof - 1, '━', tones.crane)
      cells.set(mast, roof - 1, '┳', tones.crane)
      cells.set(mast + 1, roof - 1, '╸', tones.crane)
      cells.set(mast, roof, '┃', tones.crane)
      const phase = (now / 7000) % 1
      const reach = Math.max(1, plan.across - 2)
      cells.set(t.wall + Math.round((phase < 0.5 ? phase * 2 : 2 - phase * 2) * reach), roof, '╽', tones.crane)
    }

    // A red light on the roof while the station has faults since the person's last message, and how many.
    const count = faults[t.lot] ?? 0
    if (count > 0) {
      const blink = 0.5 + 0.5 * Math.sin((2 * Math.PI * now) / BEACON_MS)
      cells.set(t.wall + 1, roof, '▄', mix(tones.beaconDim, tones.beaconLit, steps(blink, 3)))
      if (count > 1) cells.text(t.wall + 2, roof, count > 9 ? '9+' : String(count), tones.red)
    }
  }
}

/** The street, the light that runs along it when a message arrives, and the buildings' names. */
function drawStreet(frame: Frame): void {
  const { board, now, plan, tones, cells, setup } = frame
  for (let x = 0; x < plan.columns; x++) cells.set(x, plan.street, '▔', tones.street)
  let message: Entry | undefined
  let aborted: Entry | undefined
  for (const e of board.entries) {
    if (e.station !== 'you') continue
    if (e.from === 'inbound') message = e
    else if (e.status === 'err') aborted = e
  }
  if (message !== undefined && now >= message.startedAt && now - message.startedAt < STREET_MS) {
    const head = -2 + ((now - message.startedAt) / STREET_MS) * (plan.columns + 14)
    for (let x = 0; x < plan.columns; x++) {
      const d = head - x
      if (d < 0 || d > 12) continue
      cells.set(x, plan.street, d < 2 ? '▀' : '▔', d < 2 ? tones.running[0]! : mix(tones.street, tones.running[3]!, steps(1 - d / 12, 4)))
    }
  }
  if (aborted !== undefined && now >= aborted.startedAt && now - aborted.startedAt < ABORT_MS) {
    for (let x = 0; x < plan.columns; x++) cells.set(x, plan.street, '▔', tones.red)
  }

  // Names alternate between two rows, so that each has the room of two buildings.
  const faults = board.faults ?? {}
  for (const t of frame.towers) {
    const name = cut(setup.t.stations[t.lot], Math.max(3, plan.pitch * 2 - 1))
    const length = [...name].length
    const isLit = t.entries.some(e => e.status === 'run' || (e.endedAt !== undefined && now >= e.endedAt && now - e.endedAt < LABEL_LIT_MS))
    const colour = (faults[t.lot] ?? 0) > 0 ? tones.labelRed : isLit ? tones.labelOn : tones.label
    const start = clamp(Math.round(t.middle + 0.5 - length / 2), 0, Math.max(0, plan.columns - length))
    cells.text(start, plan.street + 1 + (t.index % 2), name, colour)
  }
}

function drawSigns(frame: Frame): void {
  const { board, now, plan, tones, cells, k } = frame
  // For a while after the model changes, its name hangs under the moon.
  if (board.switchedAt !== undefined && board.model !== undefined && now >= board.switchedAt && now - board.switchedAt < NAME_MS) {
    const name = shortModel(board.model)
    const length = [...name].length
    const { moon } = plan
    const x = Math.max(0, Math.min(plan.columns - length, moon.x + moon.width - length + 1))
    cells.text(x, moon.y + moon.height + 1, name, mix(tones.running[3]!, tones.label, steps((now - board.switchedAt) / NAME_MS, 4)))
  }
  // How many calls a window stands for, once it is more than one.
  if (k > 1) {
    const isNew = now - (frame.memory.scale?.at ?? -Infinity) < REFLOW_MS * 2
    cells.set(0, 0, '▖', tones.warm[isNew ? 0 : 6]!)
    cells.text(1, 0, `=${k}`, isNew ? tones.labelOn : tones.label)
  }
}

function draw(board: Board, now: number, size: ViewSize, setup: Setup, memory: Memory): Cells {
  const frame = frameOf(board, now, size, setup, memory)
  const d = frame.plan.dots
  d.bits.fill(0)
  d.level.fill(-1)
  drawWashes(frame)
  drawStars(frame)
  drawDrones(frame)
  drawMoments(frame)
  drawDots(frame)
  drawMoon(frame)
  drawBuildings(frame)
  drawStreet(frame)
  drawSigns(frame)
  return frame.cells
}

// ---- when to draw again ------------------------------------------------------------------------

function nextFrameIn(board: Board, now: number, _size: ViewSize, _setup: Setup, memory: Memory, endless: number | undefined): number | undefined {
  remember(memory, board, now)
  const flying = FASTEST_MS
  const waits: (number | undefined)[] = []
  const within = (since: number | undefined, span: number): boolean => since !== undefined && now >= since && now - since < span
  let isRunning = false
  let isWorking = false
  let latest = -Infinity
  for (const e of board.entries) {
    latest = Math.max(latest, e.endedAt ?? e.startedAt)
    if (e.status === 'run') {
      isRunning = true
      if (e.task === undefined) isWorking = true
    }
    if (e.station === 'you') {
      if (e.from === 'inbound' && within(e.startedAt, STREET_MS)) waits.push(flying)
      if (e.status === 'err' && within(e.startedAt, ABORT_MS)) waits.push(ABORT_MS - (now - e.startedAt))
      if (e.mark === 'done' && within(e.startedAt, FIREWORK_MS)) waits.push(flying)
      continue
    }
    if (e.station === 'model') {
      if (within(e.startedAt, NEW_STAR_MS)) waits.push(NEW_STAR_MS - (now - e.startedAt))
      continue
    }
    if (e.from === 'inbound' && within(e.startedAt, SPARK_MS)) waits.push(flying)
    if (e.agentId !== undefined && within(e.startedAt, GLIDE_MS)) waits.push(flying)
    if (e.status === 'run' && e.from === 'core' && e.task === undefined && within(e.startedAt, BEAM_RISE_MS)) waits.push(flying)
    if (e.endedAt !== undefined && e.from === 'core' && e.task === undefined && within(e.endedAt, BEAM_FADE_MS)) waits.push(flying)
    if (e.endedAt !== undefined && isFault(e.status) && within(e.endedAt, FLASH_MS)) waits.push(flying)
    if (e.endedAt !== undefined && within(e.endedAt, LABEL_LIT_MS)) waits.push(LABEL_LIT_MS - (now - e.endedAt))
  }
  if (board.switchedAt !== undefined && within(board.switchedAt, SHOOTING_MS)) waits.push(flying)
  if (board.switchedAt !== undefined && board.model !== undefined && within(board.switchedAt, NAME_MS)) {
    // The name under the moon fades in four steps, at the odd eighths of its time, and is gone at the end.
    const age = now - board.switchedAt
    const next = [1, 3, 5, 7, 8].map(e => (e * NAME_MS) / 8).find(at => at > age)
    if (next !== undefined) waits.push(next - age)
  }
  if (memory.scale !== undefined && within(memory.scale.at, REFLOW_MS * 2)) waits.push(now - memory.scale.at < REFLOW_MS ? flying : REFLOW_MS * 2 - (now - memory.scale.at))

  // Each window takes its next step of colour at a moment of its own.
  let step = Infinity
  for (const calls of memory.lots.values()) {
    for (const call of calls) {
      if (call.status === 'run' || isFault(call.status)) continue
      step = Math.min(step, nextStepIn((now - (call.endedAt ?? call.startedAt)) / 1000) ?? Infinity)
    }
  }
  if (step < Infinity) waits.push(step)

  if (endless !== undefined) {
    const isThinkingNow = isThinking(board)
    const hasDrones = (board.agents ?? []).length > 0
    const hasStars = countOf(board, 'model') > 0
    const hasBeacons = LOTS.some(lot => (board.faults?.[lot] ?? 0) > 0)
    if (isWorking || isThinkingNow || hasDrones) waits.push(Math.max(endless, RUNNING_EVERY))
    else if (isRunning || hasStars || hasBeacons) waits.push(Math.max(endless, now - latest < IDLE_AFTER_MS ? RESTING_EVERY : IDLE_EVERY))
  }
  return soonest(...waits)
}

export const city: View<Memory> = {
  memory: () => ({ calls: new Map(), lots: new Map(), board: undefined, boards: 0, scale: undefined, shown: undefined, plan: undefined, tones: undefined }),
  draw,
  nextFrameIn,
}
