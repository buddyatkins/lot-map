// The tiles view: a switchboard of ten tiles around the core. Each tile is a station: its name and count, a strip of
// its last few minutes in ten-second columns, and what it did last. The core's rim is the context window.
// A call lights its tile from the side that faces the core; what runs wears a heavy rim with a clock hand on it.
import type { Board, Entry, StationId } from '../types'
import { Cells, DEFAULT, glyphsOf, groundFor, inkFor, mix, quantize, soonest } from './cells'
import type { Ink, View, ViewSize } from './cells'
import { ALARM_MS, DONE_MS, GLOW_MS, PULSE_MS, RIPPLE_MS, STATIONS, SWITCH_MS, shortModel } from './map'
import type { Setup } from './map'
import { stringsFor } from './text'
import type { Strings } from './text'

// ---- time ---------------------------------------------------------------------------------------

/** One column of a strip. Every tile shares the same columns, so a moment lines up across the board. */
const BUCKET_MS = 10_000
const BUCKETS_A_MINUTE = 6
/** The ledger keeps a finished call this long: more than the widest strip shows. */
const HISTORY_MS = 32 * BUCKET_MS
/** A call lights its tile for as long as the map's pulse flies and ripples. */
const IGNITE_MS = PULSE_MS + RIPPLE_MS
/** The core's rim flashes toward the tile first, then the fronts run round the tile's rim. */
const FLASH_MS = 300
const FRONT_FROM_MS = 150
const FRONT_MS = 800
const TAIL = 4
const BEAT_MS = 1400
/** The part of a beat that swells and settles; the rest of it is still. */
const SWELL_MS = 560
const HAND_MS = 60_000
const LONG_HAND_MS = 600_000
const GLINT_EVERY_MS = 10_000
const GLINT_MS = 900
const LAP_MS = 7000
const BREATH_MS = 4800
const BREATH_RUNNING_MS = 1600
const RING_MS = 1600
/** How often the breath gets a frame: sixteen steps up and sixteen down are all a cell can show of it. */
const BREATH_FRAME_MS = 150
const BREATH_RUNNING_FRAME_MS = 100
const BEAT_FRAME_MS = 66
/** Steps a fade goes in: enough to look smooth, few enough to leave colours for the rest. */
const FADE_STEPS = 12

// ---- glyphs -------------------------------------------------------------------------------------

// Where a cell lies on a rim, which picks its glyph from a style: the four corners, then the four sides.
const TL = 0
const TR = 1
const BR = 2
const BL = 3
const TOP = 4
const RIGHT = 5
const BOTTOM = 6
const LEFT = 7
/** The ninth glyph of a style: a notch on the bottom rim where a minute starts. */
const NOTCH = 8

const ROUND = glyphsOf('╭╮╯╰─│─│┴')
const HEAVY = glyphsOf('┏┓┛┗━┃━┃┻')
const DOUBLE = glyphsOf('╔╗╝╚═║═║╩')
/** A refusal: a wall, heavy and broken. */
const REFUSED = glyphsOf('┏┓┛┗╍╏╍╏┻')
/** Something arriving: a light, broken front. */
const DASHED = glyphsOf('╭╮╯╰╌╎╌╎┴')

/** The core's corners, by which of their arms is heavy: both, the one across, the one down, neither. */
const CORE_CORNERS = [glyphsOf('┏┍┎┌'), glyphsOf('┓┑┒┐'), glyphsOf('┛┙┚┘'), glyphsOf('┗┕┖└')]
const [H_LIGHT = 0, H_HEAVY = 0, V_LIGHT = 0, V_HEAVY = 0] = glyphsOf('─━│┃')

const BLOCKS = glyphsOf(' ▁▂▃▄▅▆▇█')
const [DOT = 0, UPPER = 0, FULL = 0, TOP_EIGHTH = 0, BEAD = 0, RIGHT_HALF = 0, LEFT_HALF = 0, SPACE = 0] = glyphsOf('·▀█▔◆▐▌ ')

// ---- words --------------------------------------------------------------------------------------

/** How long ago, in the fewest letters: seconds, minutes, hours. Not in text.ts yet. */
const AGO: Record<string, readonly [string, string, string]> = {
  en: ['s', 'm', 'h'],
  ru: ['с', 'м', 'ч'],
  es: ['s', 'm', 'h'],
  fr: ['s', 'm', 'h'],
  de: ['s', 'm', 'h'],
  it: ['s', 'm', 'h'],
}
const LANGUAGES = Object.keys(AGO)
const agoUnits = (t: Strings): readonly [string, string, string] => AGO[LANGUAGES.find(l => stringsFor(l) === t) ?? 'en'] ?? ['s', 'm', 'h']

function ago(ms: number, units: readonly [string, string, string]): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}${units[0]}` : s < 3600 ? `${Math.floor(s / 60)}${units[1]}` : `${Math.min(99, Math.floor(s / 3600))}${units[2]}`
}

/** A stopwatch: m:ss, and h:mm:ss past an hour. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number): string => String(n).padStart(2, '0')
  return s < 3600 ? `${Math.floor(s / 60)}:${two(s % 60)}` : `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`
}

// ---- the board's shape --------------------------------------------------------------------------

/** The tiles' places clockwise from the top middle, as the stations go round the painted map; the core fills the middle. */
const SLOTS: readonly (readonly [number, number])[] = [[1, 0], [2, 0], [2, 1], [2, 2], [2, 3], [1, 3], [0, 3], [0, 2], [0, 1], [0, 0]]

type Box = { x: number; y: number; w: number; h: number }

/** The cells of a box's rim, clockwise from its top left corner, each with its place on the rim. */
type Rim = { xs: number[]; ys: number[]; kinds: number[] }

type Tile = {
  station: StationId
  x: number
  y: number
  w: number
  h: number
  rim: Rim
  /** The rim cell that faces the core, where a call comes in. */
  face: number
  /** The core's rim cell nearest it, and how far either way the core's flash spreads. */
  coreFace: number
  coreSpread: number
  /** The middle of the top rim, where a clock hand starts. */
  noon: number
}

type Layout = {
  /** The size, the layout and the cells' shape it was made for. */
  key: string
  tiles: Tile[]
  core: Box & { rim: Rim; noon: number }
  /** A column inside a tile's rim on either side, once there are 15 or more. */
  pad: number
  /** Columns of text and strip inside a tile. */
  width: number
  stripRows: number
  hasStatus: boolean
  /** The agents tile lists its crew, from six rows a tile. */
  hasRoster: boolean
}

function rimOf(x: number, y: number, w: number, h: number): Rim {
  const rim: Rim = { xs: [], ys: [], kinds: [] }
  const add = (cx: number, cy: number, kind: number): void => {
    rim.xs.push(cx)
    rim.ys.push(cy)
    rim.kinds.push(kind)
  }
  for (let i = 0; i < w; i++) add(x + i, y, i === 0 ? TL : i === w - 1 ? TR : TOP)
  for (let j = 1; j < h; j++) add(x + w - 1, y + j, j === h - 1 ? BR : RIGHT)
  for (let i = w - 2; i >= 0; i--) add(x + i, y + h - 1, i === 0 ? BL : BOTTOM)
  for (let j = h - 2; j >= 1; j--) add(x, y + j, LEFT)
  return rim
}

const indexOn = (rim: Rim, x: number, y: number): number => Math.max(0, rim.xs.findIndex((cx, i) => cx === x && rim.ys[i] === y))

function layoutOf(size: ViewSize, setup: Setup, key: string): Layout | undefined {
  const tw = Math.floor(size.columns / 3)
  const th = Math.max(4, Math.min(7, Math.floor(size.rows / 4)))
  if (tw < 6) return undefined
  const spare = size.columns - 3 * tw
  const x0 = spare - Math.floor(spare / 2)
  const y0 = Math.max(0, Math.floor((size.rows - 4 * th) / 2))
  const inner = tw - 2
  const pad = inner >= 15 ? 1 : 0
  const shift = setup.layout === 'you-bottom' ? 5 : 0
  const core = { x: x0 + tw, y: y0 + th, w: tw, h: 2 * th, rim: rimOf(x0 + tw, y0 + th, tw, 2 * th), noon: Math.floor(tw / 2) }
  const tiles = STATIONS.map((s, i): Tile => {
    const [col, row] = SLOTS[(i + shift) % SLOTS.length] ?? [0, 0]
    const x = x0 + col * tw
    const y = y0 + row * th
    // Toward the core: across from the side columns, down from the top row, up from the bottom one.
    const dx = col === 0 ? 1 : col === 2 ? -1 : 0
    const dy = row === 0 ? 1 : row === 3 ? -1 : 0
    const fx = dx > 0 ? x + tw - 1 : dx < 0 ? x : x + Math.floor(tw / 2)
    const fy = dy > 0 ? y + th - 1 : dy < 0 ? y : y + Math.floor(th / 2)
    const rim = rimOf(x, y, tw, th)
    let coreFace = 0
    let best = Infinity
    core.rim.xs.forEach((cx, k) => {
      const d = (cx - fx) ** 2 + (((core.rim.ys[k] ?? 0) - fy) * setup.cellShape) ** 2
      if (d < best) {
        best = d
        coreFace = k
      }
    })
    const coreSpread = dx === 0 ? Math.floor(tw / 2) - 1 : dy === 0 ? Math.floor(th / 2) : 2
    return { station: s.id, x, y, w: tw, h: th, rim, face: indexOn(rim, fx, fy), coreFace, coreSpread, noon: Math.floor(tw / 2) }
  })
  return {
    key,
    tiles,
    core,
    pad,
    width: inner - 2 * pad,
    stripRows: th === 4 ? 1 : th - 4,
    hasStatus: th >= 5,
    hasRoster: th >= 6,
  }
}

// ---- colours ------------------------------------------------------------------------------------

type Paint = {
  ink: Ink
  ground: number
  /** What a tint mixes from: the ground's own colour, even where the terminal's shows. */
  base: number
  units: readonly [string, string, string]
  /** A strip's columns from the oldest to the newest, dimmer to brighter, for the accent and for memory. */
  ramp: number[]
  memRamp: number[]
}

function paintOf(setup: Setup, width: number): Paint {
  const ink = inkFor(setup)
  const ramp = (to: number): number[] =>
    Array.from({ length: Math.max(0, width) }, (_, i) => mix(mix(ink.line, to, 0.55), to, quantize(width > 1 ? i / (width - 1) : 1, 4)))
  return { ink, ground: groundFor(setup), base: ink.ground, units: agoUnits(setup.t), ramp: ramp(ink.accent), memRamp: ramp(ink.mem) }
}

/** The ground of a cell `t` of the way to `color`: the terminal's own when nothing tints it. */
const tinted = (paint: Paint, color: number, t: number): number => (t <= 0 ? paint.ground : mix(paint.base, color, t))

// ---- what the board says ------------------------------------------------------------------------

type Station = {
  count: number
  latest: Entry | undefined
  /** The oldest call still running here: the main loop's, or else a subagent's. */
  running: Entry | undefined
  /** The oldest background task still running here. */
  task: Entry | undefined
  /** Since this station last did anything. */
  quiet: number
  /** The newest error or refusal here. */
  fault: Entry | undefined
  /** Subagents with a call running here. */
  crew: number
  /** Calls that began a moment ago and are still lighting the tile, newest last. */
  sparks: Entry[]
}

type Look = {
  stations: Station[]
  anyRunning: boolean
  compacting: boolean
  /** The subagents still at work: where each is, and since when. */
  crew: { station: StationId | undefined; since: number }[]
  /** The person's turn: when it began, and when and how it ended. */
  turn: { since: number; until: number | undefined; isAborted: boolean } | undefined
  done: Entry | undefined
  switchAge: number
}

type Seen = { station: StationId; startedAt: number; endedAt: number | undefined; isTask: boolean; isHung: boolean; isFault: boolean }

type Strip = { counts: number[]; hang: number[]; flags: number[] }
const RUN = 1
const FAULT = 2

type Memory = {
  /** Every call of the last few minutes, by id: the board keeps only its newest 80. */
  ledger: Map<string, Seen>
  version: number
  board: Board | undefined
  seenAt: number
  total: number
  /** When each subagent at work was first seen. */
  crew: Map<string, number>
  /** The person's last message, which may have left the board in a long turn. */
  message: number | undefined
  layout: Layout | undefined
  paint: { setup: Setup; width: number; paint: Paint } | undefined
  strips: { key: string; strips: Strip[] } | undefined
  look: { board: Board; now: number; setup: Setup; look: Look } | undefined
}

const isFault = (e: Entry): boolean => e.status === 'err' || e.status === 'block'

/** The board merged into the ledger: kept until it has scrolled off every strip. */
function remember(memory: Memory, board: Board, now: number): void {
  if (memory.board === board) return
  const total = STATIONS.reduce((sum, s) => sum + (board.counts[s.id] ?? 0), 0)
  // Fewer calls than before: a new session, whose strips start empty.
  if (total < memory.total) {
    memory.ledger.clear()
    memory.crew.clear()
    memory.message = undefined
  }
  memory.total = total
  const here = new Set<string>()
  for (const e of board.entries) {
    if (e.mark === 'switch') continue
    here.add(e.id)
    memory.ledger.set(e.id, {
      station: e.station,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      isTask: e.task !== undefined,
      isHung: e.station === 'memory' && e.from === 'inbound',
      isFault: isFault(e),
    })
    if (e.station === 'you' && e.from === 'inbound' && (memory.message === undefined || e.startedAt > memory.message)) memory.message = e.startedAt
    for (const id of [e.agentId, e.task]) {
      if (id !== undefined) memory.crew.set(id, Math.min(memory.crew.get(id) ?? Infinity, e.startedAt))
    }
  }
  for (const [id, seen] of memory.ledger) {
    // A call that left the board still running ran at least until the last board that had it.
    if (seen.endedAt === undefined && !here.has(id)) seen.endedAt = memory.seenAt
    if ((seen.endedAt ?? now) < now - HISTORY_MS) memory.ledger.delete(id)
  }
  const working = new Set(board.agents ?? [])
  for (const id of working) if (!memory.crew.has(id)) memory.crew.set(id, now)
  for (const id of memory.crew.keys()) if (!working.has(id)) memory.crew.delete(id)
  memory.board = board
  memory.seenAt = now
  memory.version++
}

function lookAt(memory: Memory, board: Board, now: number, setup: Setup): Look {
  if (memory.look?.board === board && memory.look.now === now && memory.look.setup === setup) return memory.look.look
  const stations = STATIONS.map(
    (s): Station => ({
      count: board.counts[s.id] ?? 0,
      latest: undefined,
      running: undefined,
      task: undefined,
      quiet: Infinity,
      fault: undefined,
      crew: 0,
      sparks: [],
    }),
  )
  const crewAt = STATIONS.map(() => new Set<string>())
  const latestOf = new Map<string, StationId>()
  let anyRunning = false
  let compacting = false
  let done: Entry | undefined
  let message: number | undefined
  let end: Entry | undefined
  for (const e of board.entries) {
    const k = STATIONS.findIndex(s => s.id === e.station)
    const st = stations[k]
    if (st === undefined) continue
    st.latest = e
    st.quiet = Math.max(0, now - (e.endedAt ?? e.startedAt))
    if (e.status === 'run') {
      anyRunning = true
      if (e.task !== undefined) st.task ??= e
      // The main loop's call before a subagent's: it is what the person waits on.
      else if (st.running === undefined || (st.running.from === 'agents' && e.from !== 'agents')) st.running = e
      if (e.from === 'agents' && e.agentId !== undefined) crewAt[k]?.add(e.agentId)
      if (e.station === 'model' && e.label === setup.t.compacting) compacting = true
    }
    if (isFault(e)) st.fault = e
    if (e.mark !== 'switch' && now - e.startedAt >= 0 && now - e.startedAt < IGNITE_MS) {
      st.sparks.push(e)
      if (st.sparks.length > 3) st.sparks.shift()
    }
    if (e.agentId !== undefined) latestOf.set(e.agentId, e.station)
    if (e.mark === 'done') done = e
    if (e.station === 'you') {
      if (e.from === 'inbound') {
        message = e.startedAt
        end = undefined
      } else end = e
    }
  }
  stations.forEach((st, k) => {
    st.crew = crewAt[k]?.size ?? 0
    if (st.running !== undefined) st.quiet = 0
  })
  const since = message ?? memory.message
  const turn =
    since === undefined
      ? undefined
      : { since, until: end !== undefined && end.startedAt >= since ? end.startedAt : undefined, isAborted: end?.status === 'err' }
  const crew = (board.agents ?? []).map(id => ({ station: latestOf.get(id), since: memory.crew.get(id) ?? now }))
  const switchAge = board.switchedAt === undefined ? Infinity : now - board.switchedAt
  const look: Look = { stations, anyRunning, compacting, crew, turn, done, switchAge: switchAge < 0 ? Infinity : switchAge }
  memory.look = { board, now, setup, look }
  return look
}

/** Each station's calls in the shared ten-second columns, the newest column on the right. */
function stripsOf(memory: Memory, now: number, width: number): Strip[] {
  const last = Math.floor(now / BUCKET_MS)
  const key = `${memory.version}:${last}:${width}`
  if (memory.strips?.key === key) return memory.strips.strips
  const strips = STATIONS.map(() => ({ counts: new Array<number>(width).fill(0), hang: new Array<number>(width).fill(0), flags: new Array<number>(width).fill(0) }))
  const first = last - width + 1
  for (const seen of memory.ledger.values()) {
    const strip = strips[STATIONS.findIndex(s => s.id === seen.station)]
    if (strip === undefined) continue
    const from = Math.max(first, Math.floor(seen.startedAt / BUCKET_MS))
    const to = Math.min(last, Math.floor((seen.endedAt ?? now) / BUCKET_MS))
    for (let b = from; b <= to; b++) {
      const i = b - first
      if (seen.isHung) strip.hang[i] = (strip.hang[i] ?? 0) + 1
      else strip.counts[i] = (strip.counts[i] ?? 0) + 1
      if (seen.endedAt === undefined && !seen.isTask) strip.flags[i] = (strip.flags[i] ?? 0) | RUN
    }
    // The column the call failed in, red.
    if (seen.isFault && seen.endedAt !== undefined) {
      const i = Math.floor(seen.endedAt / BUCKET_MS) - first
      if (i >= 0 && i < width) strip.flags[i] = (strip.flags[i] ?? 0) | FAULT
    }
  }
  memory.strips = { key, strips }
  return strips
}

/** Of the strip's height: one call a quarter, three a half, fifteen the whole. */
const share = (n: number): number => (n <= 0 ? 0 : Math.min(1, Math.log2(1 + n) / 4))

// ---- light on a rim -----------------------------------------------------------------------------

/** How far along a rim, either way round, from one cell to another. */
const apart = (a: number, b: number, length: number): number => {
  const d = Math.abs(a - b) % length
  return Math.min(d, length - d)
}

/**
 * How bright each cell of a tile's rim is as a call comes in: two fronts that run from the side facing the core
 * round to the far side, or for something arriving, from the far side to the near one. Like a fuse, the cells
 * a front has passed are `reached`, and take the tile's new look.
 */
function fronts(glow: number[], reached: boolean[], tile: Tile, age: number, isInbound: boolean): void {
  const length = tile.rim.xs.length
  const half = Math.ceil(length / 2)
  const t = isInbound ? age : age - FRONT_FROM_MS
  const progress = Math.max(0, Math.min(1, t / FRONT_MS))
  // After the fronts meet, they fade where they met.
  const fading = t <= FRONT_MS ? 1 : Math.max(0, 1 - (t - FRONT_MS) / (IGNITE_MS - FRONT_MS - FRONT_FROM_MS))
  const head = isInbound ? half * (1 - progress) : half * progress
  for (let k = 0; k < length; k++) {
    const d = apart(k, tile.face, length)
    const behind = isInbound ? d - head : head - d
    if (behind >= 0) reached[k] = true
    if (t < 0 || behind < 0 || behind > TAIL) continue
    const level = (1 - behind / (TAIL + 1)) * fading
    if (level > (glow[k] ?? 0)) glow[k] = level
  }
}

/** How bright the core's rim is toward a tile as a call leaves for it, or as something arriving there reaches the core. */
function coreFlash(glow: number[], tile: Tile, length: number, age: number, isInbound: boolean): void {
  const t = isInbound ? age - FRONT_MS * 0.9 : age
  if (t < 0 || t >= FLASH_MS) return
  const level = 1 - t / FLASH_MS
  for (let d = -tile.coreSpread; d <= tile.coreSpread; d++) {
    const k = (((tile.coreFace + d) % length) + length) % length
    const v = level * (1 - Math.abs(d) / (tile.coreSpread + 1))
    if (v > (glow[k] ?? 0)) glow[k] = v
  }
}

// ---- drawing ------------------------------------------------------------------------------------

type Scene = { cells: Cells; L: Layout; paint: Paint; look: Look; now: number; setup: Setup; board: Board; notches: boolean[] }

function drawTile(scene: Scene, tile: Tile, st: Station, strip: Strip | undefined): void {
  const { cells, L, paint, now, setup, board, look } = scene
  const { ink } = paint
  const isMemory = tile.station === 'memory'
  const main = isMemory ? ink.mem : ink.accent
  const hot = isMemory ? ink.memHot : ink.hot
  const running = st.running
  const isRunning = running !== undefined
  const isTask = !isRunning && st.task !== undefined
  const fault = st.fault
  const alarm = fault === undefined ? Infinity : Math.max(0, now - (fault.endedAt ?? fault.startedAt))
  const isAlarm = alarm < ALARM_MS
  const faults = board.faults?.[tile.station] ?? 0
  const isWronged = fault !== undefined && st.latest === fault && faults > 0
  const isLit = isRunning || st.quiet < GLOW_MS
  // A call's fronts light the tile as they go round; until then it looks as it did.
  const spark = st.sparks[st.sparks.length - 1]
  const arriving = spark === undefined ? 1 : Math.min(1, Math.max(0, (now - spark.startedAt - FRONT_FROM_MS) / FRONT_MS))

  // The body: red for a fault, a beat while something runs, a glow that fades after it ends.
  let tint = paint.ground
  if (isAlarm) {
    tint = tinted(paint, ink.red, 0.22 * quantize(1 - alarm / ALARM_MS, FADE_STEPS))
  } else if (isRunning) {
    const phase = (now - running.startedAt) % BEAT_MS
    const swell = phase < SWELL_MS ? 1 - phase / SWELL_MS : 0
    tint = tinted(paint, main, (0.1 + 0.08 * quantize(swell, 8)) * arriving)
  } else if (st.quiet < GLOW_MS) {
    tint = tinted(paint, main, 0.18 * quantize(1 - st.quiet / GLOW_MS, FADE_STEPS) * arriving)
  }
  if (tint !== paint.ground) cells.fill(tile.x + 1, tile.y + 1, tile.w - 2, tile.h - 2, SPACE, ink.bone, tint)

  const x = tile.x + 1 + L.pad
  const width = L.width
  const name = setup.t.stations[tile.station]
  const nameColor = isLit || isAlarm ? ink.bone : st.count > 0 ? ink.ash : ink.dim

  // The name, and the count; with no row for the status, a running call's time stands in for the count.
  let right = ''
  let rightColor = ink.dim
  if (!L.hasStatus && isRunning) {
    right = clock(now - running.startedAt)
    rightColor = hot
  } else if (st.count > 0) {
    const pushed = isMemory ? Math.min(st.count, board.pushed ?? 0) : 0
    const asked = st.count - pushed
    right = pushed === 0 ? String(st.count) : `${asked > 0 ? `${asked} ` : ''}↓${pushed}`
    if (pushed > 0 && right.length + 2 > width - name.length) right = right.replace(' ', '')
  }
  const rightLength = glyphsOf(right).length
  cells.text(x, tile.y + 1, name, nameColor, undefined, Math.max(1, width - rightLength - (rightLength > 0 ? 1 : 0)))
  if (rightLength > 0) {
    const at = x + width - rightLength
    const arrow = right.indexOf('↓')
    if (arrow < 0) cells.text(at, tile.y + 1, right, rightColor)
    else {
      cells.text(at, tile.y + 1, right.slice(0, arrow), ink.dim)
      cells.text(at + arrow, tile.y + 1, right.slice(arrow), ink.mem)
    }
  }

  // The agents tile lists its crew at the bottom, in place of its status and as much of its strip as it takes.
  const crewRows = tile.station === 'agents' && L.hasRoster ? Math.min(look.crew.length, tile.h - 3) : 0
  const stripRows = crewRows > 0 ? tile.h - 3 - crewRows : L.stripRows
  if (strip !== undefined && stripRows > 0) drawStrip(scene, strip, isMemory, x, tile.y + 2, stripRows)
  if (crewRows > 0) roster(scene, x, tile.y + tile.h - 1 - crewRows, crewRows)
  else if (L.hasStatus) status(scene, st, x, tile.y + tile.h - 2, hot)

  // The rim: worn in with use, heavy while something runs, double for a background task, broken for a refusal.
  const wear = Math.min(1, Math.log2(1 + st.count) / 7)
  const rest = mix(ink.line, main, 0.35 * wear)
  let style = ROUND
  let rimColor = rest
  if (isRunning) {
    style = HEAVY
    rimColor = main
  } else if (isTask) {
    style = DOUBLE
    rimColor = main
  } else if (isWronged && fault?.status === 'block') {
    style = REFUSED
  }
  if (!isRunning && !isTask) {
    if (isAlarm) rimColor = mix(rest, ink.red, quantize(0.35 + 0.65 * (1 - alarm / ALARM_MS), FADE_STEPS))
    else if (isWronged) rimColor = mix(rest, ink.red, 0.35)
    else if (st.quiet < GLOW_MS) rimColor = mix(rest, main, quantize(1 - st.quiet / GLOW_MS, FADE_STEPS))
  }
  const length = tile.rim.xs.length
  const glow = new Array<number>(length).fill(0)
  const dashed = new Array<boolean>(length).fill(false)
  // Until the newest call's fronts have gone round, the cells they have not reached keep the tile's resting look.
  const wasRunning = isRunning && spark !== undefined && running.startedAt < spark.startedAt
  const reached = new Array<boolean>(length).fill(spark === undefined || wasRunning)
  for (const e of st.sparks) {
    const isInbound = e.from === 'inbound'
    const before = isInbound ? glow.slice() : undefined
    fronts(glow, reached, tile, now - e.startedAt, isInbound)
    if (before !== undefined) glow.forEach((v, k) => (dashed[k] = dashed[k] === true || v > (before[k] ?? 0)))
  }
  // A clock hand: once round a minute for a call, once round ten minutes for a background task, then a glint every ten seconds.
  let hand = 0
  let glint = -1
  if (isRunning) hand = Math.floor((((now - running.startedAt) % HAND_MS) / HAND_MS) * length)
  else if (st.task !== undefined) {
    const elapsed = now - st.task.startedAt
    hand = Math.floor(Math.min(1, elapsed / LONG_HAND_MS) * length)
    const phase = (elapsed - LONG_HAND_MS) % GLINT_EVERY_MS
    if (elapsed >= LONG_HAND_MS && phase < GLINT_MS) glint = Math.floor((phase / GLINT_MS) * length)
  }
  for (let k = 0; k < length; k++) {
    const cx = tile.rim.xs[k] ?? 0
    const cy = tile.rim.ys[k] ?? 0
    const kind = tile.rim.kinds[k] ?? TOP
    const light = glow[k] ?? 0
    const isReached = reached[k] === true
    const look = light >= 0.5 ? (dashed[k] === true ? DASHED : HEAVY) : isReached ? style : ROUND
    const glyph = kind === BOTTOM && scene.notches[cx - x] === true ? (look[NOTCH] ?? 0) : (look[kind] ?? 0)
    const fromNoon = (k - tile.noon + length) % length
    let color = isReached ? rimColor : rest
    if (isReached && fromNoon < hand) color = hot
    if (glint >= 0) {
      const behind = (glint - fromNoon + length) % length
      if (behind < 3) color = mix(hot, ink.bone, 1 - behind / 3)
    }
    if (light > 0) {
      const level = quantize(light, 4)
      cells.set(cx, cy, glyph, mix(color, light > 0.8 ? ink.bone : hot, level), tinted(paint, hot, 0.3 * level))
    } else cells.set(cx, cy, glyph, color)
  }

  // Faults since the person's last message: a pill on the top rim, at the left.
  let pillEnd = tile.x + 1
  if (faults > 0) {
    const n = faults > 99 ? '99+' : String(faults)
    const at = tile.x + 2
    cells.set(at, tile.y, RIGHT_HALF, ink.red)
    cells.text(at + 1, tile.y, n, ink.raised, ink.red)
    cells.set(at + 1 + n.length, tile.y, LEFT_HALF, ink.red)
    pillEnd = at + 2 + n.length
  }
  // A subagent at work here: a bead each on the top rim, at the right.
  const beads = Math.min(st.crew, tile.x + tile.w - 2 - pillEnd - 1)
  for (let b = 0; b < beads; b++) cells.set(tile.x + tile.w - 2 - b, tile.y, BEAD, ink.hot)
  if (tile.station === 'agents') orbit(scene, tile)
}

/** Where a minute starts among a strip's columns: a notch on the bottom rim below it. */
function notchesOf(now: number, width: number): boolean[] {
  const last = Math.floor(now / BUCKET_MS)
  return Array.from({ length: Math.max(0, width) }, (_, i) => {
    const bucket = last - (width - 1 - i)
    return ((bucket % BUCKETS_A_MINUTE) + BUCKETS_A_MINUTE) % BUCKETS_A_MINUTE === 0
  })
}

function drawStrip(scene: Scene, strip: Strip, isMemory: boolean, x: number, top: number, rows: number): void {
  const { cells, paint } = scene
  const { ink } = paint
  const ramp = isMemory ? paint.memRamp : paint.ramp
  const hot = isMemory ? ink.memHot : ink.hot
  const width = strip.counts.length
  for (let i = 0; i < width; i++) {
    const n = strip.counts[i] ?? 0
    const flags = strip.flags[i] ?? 0
    const color = flags & FAULT ? ink.red : flags & RUN ? hot : (ramp[i] ?? ink.accent)
    const v = n > 0 ? Math.max(1, Math.round(share(n) * 8 * rows)) : 0
    for (let r = 0; r < rows; r++) {
      const part = Math.max(0, Math.min(8, v - 8 * r))
      const y = top + rows - 1 - r
      if (part > 0) cells.set(x + i, y, BLOCKS[part] ?? FULL, color)
      else if (r === 0) cells.set(x + i, y, DOT, ink.line)
    }
    // What a hook brought to memory unasked hangs from the top.
    const pushed = strip.hang[i] ?? 0
    if (pushed > 0) {
      let h = Math.max(1, Math.round(share(pushed) * 8 * rows))
      for (let r = 0; r < rows && h > 0; r++, h -= 8) cells.set(x + i, top + r, h >= 8 ? FULL : h >= 4 ? UPPER : TOP_EIGHTH, ink.mem)
    }
  }
}

/** What the station did last, with a mark when it failed or a subagent did it; how long ago, or how long it has run. */
function status(scene: Scene, st: Station, x: number, y: number, hot: number): void {
  const { cells, paint, now, board, L, setup } = scene
  const { ink } = paint
  const e = st.running ?? st.task ?? st.latest
  if (e === undefined) return
  const isRunning = st.running !== undefined
  const isTask = !isRunning && st.task !== undefined
  const right = isRunning || isTask ? clock(now - e.startedAt) : ago(now - (e.endedAt ?? e.startedAt), paint.units)
  const rightLength = glyphsOf(right).length
  cells.text(x + L.width - rightLength, y, right, isRunning ? hot : isTask ? ink.ash : ink.dim)
  let label = e.label
  // The model's own name is in the core, and a bead says a subagent's: its tile keeps to the step.
  const model = board.model === undefined ? '' : `${shortModel(board.model)} · `
  if (e.station === 'model' && model !== '' && label.startsWith(model)) label = label.slice(model.length)
  const subagent = ` · ${setup.t.subagent}`
  if (e.from === 'agents' && label.endsWith(subagent)) label = label.slice(0, -subagent.length)
  let at = x
  let room = L.width - rightLength - 1
  const mark = isFault(e) ? { glyph: e.status === 'block' ? '⊘' : '✕', color: ink.red } : e.from === 'agents' ? { glyph: '◆', color: ink.hot } : undefined
  if (mark !== undefined && room > 4) {
    cells.set(at, y, mark.glyph, mark.color)
    at += 2
    room -= 2
  }
  // A path or an address says most at its end.
  const keep = /^[^\s]*[/.][^\s]*$/.test(label) ? 'end' : 'start'
  cells.text(at, y, label, isRunning || st.quiet < GLOW_MS ? ink.bone : ink.ash, undefined, room, keep)
}

/** The subagents at work, one a row: where each is now, and for how long it has been at work. */
function roster(scene: Scene, x: number, top: number, rows: number): void {
  const { cells, paint, look, now, setup, L } = scene
  const { ink } = paint
  const shown = look.crew.length > rows ? rows - 1 : rows
  look.crew.slice(0, shown).forEach((member, r) => {
    const time = clock(now - member.since)
    const where = member.station === undefined ? setup.t.subagent : setup.t.stations[member.station]
    cells.set(x, top + r, BEAD, ink.hot)
    cells.text(x + 2, top + r, where, ink.ash, undefined, L.width - 3 - time.length)
    cells.text(x + L.width - time.length, top + r, time, ink.dim)
  })
  if (look.crew.length > shown) cells.text(x, top + shown, `+${look.crew.length - shown}`, ink.dim)
}

/** Each subagent at work is a bead going round the agents tile, once in seven seconds, spaced evenly. */
function orbit(scene: Scene, tile: Tile): void {
  const { cells, paint, look, now } = scene
  const length = tile.rim.xs.length
  const n = Math.min(6, look.crew.length)
  for (let b = 0; b < n; b++) {
    const k = Math.floor((((now + (b * LAP_MS) / n) % LAP_MS) / LAP_MS) * length)
    cells.set(tile.rim.xs[k] ?? 0, tile.rim.ys[k] ?? 0, BEAD, paint.ink.hot)
  }
}

function drawCore(scene: Scene): void {
  const { cells, L, paint, look, now, setup, board } = scene
  const { ink } = paint
  const { x, y, w, h, rim } = L.core

  // The centre breathes: slowly at rest, quicker and brighter while something runs. The glow takes the core's shape.
  const period = look.anyRunning ? BREATH_RUNNING_MS : BREATH_MS
  const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * (now % period)) / period)
  const peak = look.anyRunning ? 0.06 + 0.14 * breath : 0.03 + 0.07 * breath
  const cx = x + (w - 1) / 2
  const cy = y + (h - 1) / 2
  const rx = Math.max(1, w / 2 - 1)
  const ry = Math.max(1, h / 2 - 1)
  for (let j = y + 1; j < y + h - 1; j++) {
    for (let i = x + 1; i < x + w - 1; i++) {
      const d = ((i - cx) / rx) ** 2 + ((j - cy) / ry) ** 2
      cells.tint(i, j, tinted(paint, ink.accent, quantize(peak * Math.max(0, 1 - d), 32)))
    }
  }

  // What the core says: its name, the model and its step, how full the context is, the turn's time.
  const room = w - 2
  const spaced = [...setup.core].join(' ')
  const lines: { text: string; color: number; mark?: { glyph: string; color: number } }[][] = []
  lines.push([{ text: glyphsOf(spaced).length <= room ? spaced : setup.core, color: ink.bone }])
  const isSwitching = look.switchAge < SWITCH_MS
  const model: { text: string; color: number }[] = []
  if (board.model !== undefined) model.push({ text: shortModel(board.model), color: isSwitching ? ink.hot : ink.ash })
  if (look.compacting) model.push({ text: setup.t.compacting, color: ink.accent })
  else if (board.step !== undefined) model.push({ text: setup.t.step(board.step), color: ink.dim })
  if (model.length > 0) lines.push(model)
  if (board.context !== undefined) {
    const pct = `${Math.round(Math.max(0, Math.min(100, board.context)))}%`
    const words = `${setup.t.context} ${pct}`
    lines.push([{ text: glyphsOf(words).length <= room ? words : pct, color: ink.dim }])
  }
  const turn = look.turn
  if (turn !== undefined) {
    const isOpen = turn.until === undefined
    const mark = isOpen ? { glyph: '◷', color: ink.hot } : turn.isAborted ? { glyph: '✕', color: ink.red } : { glyph: '✓', color: ink.ash }
    lines.push([{ text: clock((turn.until ?? now) - turn.since), color: isOpen ? ink.bone : ink.ash, mark }])
  }
  const flat = lines.flat()
  const inside = h - 2
  // Rows between the groups while there is room: before the turn's time first, then before the context, then after the name.
  const gaps = new Array<number>(lines.length).fill(0)
  let spare = inside - flat.length
  for (const g of [lines.length - 1, lines.length - 2, 1]) {
    if (spare > 0 && g > 0 && g < lines.length && gaps[g] === 0) {
      gaps[g] = 1
      spare--
    }
  }
  const used = flat.length + gaps.reduce((a, b) => a + b, 0)
  let row = y + 1 + Math.max(0, Math.floor((inside - used) / 2))
  lines.forEach((group, g) => {
    row += gaps[g] ?? 0
    for (const line of group) {
      if (row >= y + h - 1) return
      const text = line.mark === undefined ? line.text : `${line.mark.glyph} ${line.text}`
      const length = Math.min(room, glyphsOf(text).length)
      const at = x + 1 + Math.floor((room - length) / 2)
      cells.text(at, row, text, line.color, undefined, room)
      if (line.mark !== undefined) cells.set(at, row, line.mark.glyph, line.mark.color)
      row++
    }
  })

  // The rim is the context gauge: heavy from the top middle clockwise as far as the window is full.
  const length = rim.xs.length
  const full = board.context === undefined ? 0 : Math.round((length * Math.max(0, Math.min(100, board.context))) / 100)
  const gauge = board.context === undefined ? ink.ash : board.context >= 90 ? ink.red : board.context >= 70 ? ink.accent : ink.ash
  const lineColor = look.anyRunning ? mix(ink.line, ink.accent, 0.4) : ink.line
  const flash = new Array<number>(length).fill(0)
  L.tiles.forEach((tile, i) => {
    for (const e of look.stations[i]?.sparks ?? []) {
      if (e.from !== 'agents') coreFlash(flash, tile, length, now - e.startedAt, e.from === 'inbound')
    }
  })
  for (let k = 0; k < length; k++) {
    const g = (k - L.core.noon + length) % length
    const heavy = g < full
    const kind = rim.kinds[k] ?? TOP
    let glyph: number
    if (kind <= BL) {
      // A corner's arms: the one it is reached by is as heavy as the corner, the one it leaves by as the next cell.
      const reached = heavy
      const leaves = g + 1 < full
      const across = kind === TL || kind === BR ? leaves : reached
      const down = kind === TL || kind === BR ? reached : leaves
      glyph = CORE_CORNERS[kind]?.[across && down ? 0 : across ? 1 : down ? 2 : 3] ?? 0
    } else {
      const isAcross = kind === TOP || kind === BOTTOM
      glyph = heavy || (flash[k] ?? 0) >= 0.5 ? (isAcross ? H_HEAVY : V_HEAVY) : isAcross ? H_LIGHT : V_LIGHT
    }
    const color = heavy ? (look.compacting ? ink.accent : gauge) : lineColor
    const light = quantize(flash[k] ?? 0, 4)
    if (light > 0) cells.set(rim.xs[k] ?? 0, rim.ys[k] ?? 0, glyph, mix(color, light > 0.8 ? ink.bone : ink.hot, light), tinted(paint, ink.hot, 0.3 * light))
    else cells.set(rim.xs[k] ?? 0, rim.ys[k] ?? 0, glyph, color)
  }
}

/**
 * A ring of light on the ground of the cells of a box: the outline of a box `r` of the way from its middle to its rim,
 * with a softer trail inside it. Square, as everything on the board is.
 */
function ring(scene: Scene, box: Box, r: number, strength: number, color: number): void {
  const { cells, paint } = scene
  const hw = (box.w - 1) / 2
  const hh = (box.h - 1) / 2
  const mx = box.x + hw
  const my = box.y + hh
  for (let j = Math.max(0, box.y); j < Math.min(cells.rows, box.y + box.h); j++) {
    for (let i = Math.max(0, box.x); i < Math.min(cells.columns, box.x + box.w); i++) {
      const off = Math.max(Math.abs(i - mx) - r * hw, Math.abs(j - my) - r * hh)
      const t = quantize(strength * (off > 0.5 ? 0 : off > -0.5 ? 1 : Math.max(0, 0.5 + (off + 0.5) / 5)), 8)
      if (t <= 0) continue
      const bg = cells.bg(i, j)
      cells.tint(i, j, mix(bg === DEFAULT ? paint.base : bg, color, t))
    }
  }
}

/** A box's rim, in one colour: the rims of the core and the model's tile ring as the model changes. */
function ringRim(scene: Scene, rim: Rim, level: number): void {
  const { cells, paint } = scene
  if (level <= 0) return
  rim.xs.forEach((x, k) => {
    const y = rim.ys[k] ?? 0
    cells.ink(x, y, mix(cells.fg(x, y), paint.ink.bone, level))
  })
}

function waves(scene: Scene): void {
  const { L, look, now, paint } = scene
  const { core } = L
  const first = L.tiles[0]
  // The answer is ready: a wave from the core out across the whole board.
  if (look.done !== undefined && first !== undefined) {
    const age = now - look.done.startedAt
    const board = { x: core.x - core.w, y: core.y - first.h, w: 3 * core.w, h: 4 * first.h }
    if (age >= 0 && age < DONE_MS) ring(scene, board, age / DONE_MS, 0.32 * (1 - age / DONE_MS), paint.ink.hot)
  }
  // The model changed: a lap at a time, rings go out from the middle of the core and of the model's tile, and their rims ring.
  if (look.switchAge < SWITCH_MS) {
    const lap = (look.switchAge % RING_MS) / RING_MS
    const fading = 1 - look.switchAge / SWITCH_MS
    const model = L.tiles.find(t => t.station === 'model')
    for (const box of model === undefined ? [core] : [core, model]) {
      ring(scene, { x: box.x + 1, y: box.y + 1, w: box.w - 2, h: box.h - 2 }, lap, 0.22 * fading, paint.ink.bone)
      ringRim(scene, box.rim, quantize(0.7 * fading * Math.max(0, 1 - lap * 3), 8))
    }
  }
}

// ---- the view -----------------------------------------------------------------------------------

function layoutFor(memory: Memory, size: ViewSize, setup: Setup): Layout | undefined {
  const key = `${size.columns}x${size.rows}:${setup.layout}:${setup.cellShape}`
  if (memory.layout?.key === key) return memory.layout
  const layout = layoutOf(size, setup, key)
  if (layout !== undefined) memory.layout = layout
  return layout
}

function paintFor(memory: Memory, setup: Setup, width: number): Paint {
  if (memory.paint?.setup === setup && memory.paint.width === width) return memory.paint.paint
  const paint = paintOf(setup, width)
  memory.paint = { setup, width, paint }
  return paint
}

export const tiles: View<Memory> = {
  memory: () => ({
    ledger: new Map(),
    version: 0,
    board: undefined,
    seenAt: 0,
    total: 0,
    crew: new Map(),
    message: undefined,
    layout: undefined,
    paint: undefined,
    strips: undefined,
    look: undefined,
  }),

  draw(board, now, size, setup, memory) {
    const cells = new Cells(Math.max(0, size.columns), Math.max(0, size.rows), groundFor(setup))
    const L = layoutFor(memory, size, setup)
    if (L === undefined) return cells
    remember(memory, board, now)
    const look = lookAt(memory, board, now, setup)
    const strips = stripsOf(memory, now, Math.max(0, L.width))
    const scene: Scene = { cells, L, paint: paintFor(memory, setup, L.width), look, now, setup, board, notches: notchesOf(now, L.width) }
    L.tiles.forEach((tile, i) => {
      const st = look.stations[i]
      if (st !== undefined) drawTile(scene, tile, st, strips[i])
    })
    drawCore(scene)
    waves(scene)
    return cells
  },

  nextFrameIn(board, now, size, setup, memory, endless) {
    const L = layoutFor(memory, size, setup)
    if (L === undefined) return undefined
    const look = lookAt(memory, board, now, setup)
    const waits: (number | undefined)[] = []
    // Animations with an end: a call lighting its tile, the answer's wave, the model's rings, and the fades after them,
    // whose steps change half way between two of `quantize`'s.
    const step = (age: number, span: number): number => {
      const each = span / FADE_STEPS
      return each - ((age + each / 2) % each)
    }
    let endlessRate = look.anyRunning ? BREATH_RUNNING_FRAME_MS : BREATH_FRAME_MS
    look.stations.forEach((st, i) => {
      if (st.sparks.length > 0) waits.push(0)
      if (st.running === undefined && st.quiet < GLOW_MS) waits.push(step(st.quiet, GLOW_MS))
      const fault = st.fault
      const alarm = fault === undefined ? Infinity : now - (fault.endedAt ?? fault.startedAt)
      if (alarm >= 0 && alarm < ALARM_MS) waits.push(step(alarm, ALARM_MS))
      // Without an end: a beat while a call runs, and the glint on a long background task.
      if (st.running !== undefined) {
        const phase = (now - st.running.startedAt) % BEAT_MS
        endlessRate = Math.min(endlessRate, phase < SWELL_MS ? BEAT_FRAME_MS : BEAT_MS - phase)
      } else if (st.task !== undefined) {
        const elapsed = now - st.task.startedAt
        const phase = (elapsed - LONG_HAND_MS) % GLINT_EVERY_MS
        if (elapsed >= LONG_HAND_MS && phase < GLINT_MS) endlessRate = 0
      }
      if (L.tiles[i]?.station === 'agents' && look.crew.length > 0) endlessRate = Math.min(endlessRate, LAP_MS / (L.tiles[i]?.rim.xs.length ?? 1))
    })
    if (look.done !== undefined && now - look.done.startedAt >= 0 && now - look.done.startedAt < DONE_MS) waits.push(0)
    if (look.switchAge < SWITCH_MS) waits.push(0)
    return soonest(...waits, endless === undefined ? undefined : Math.max(endless, endlessRate))
  },

  hidesTally: true,
}
