// The ring view: the picture's ring of stations, drawn in characters. Lines are braille dots, two across and four down
// a cell, placed in column widths across and down alike so that circles come out round on cells of any shape;
// the words stand on top of them, each on a rim of empty cells, as the picture's words stand on a rim of ground.
import type { Board, Entry, StationId } from '../types'
import { Cells, DEFAULT, cut, glyphsOf, groundFor, inkFor, mix, quantize, soonest } from './cells'
import type { Ink, View, ViewSize } from './cells'
import { ALARM_MS, DONE_MS, GLOW_MS, PULSE_MS, RIPPLE_MS, STATIONS, SWITCH_MS, TRAIL_FADE_MS, TRAIL_HOLD_MS, routeOf, shortModel } from './map'
import type { Setup } from './map'
import { FASTEST_MS } from './raster'
import { stringsFor } from './text'
import type { Strings } from './text'

// ---- what the ring is made of ------------------------------------------------------------------

const ICONS: Record<StationId, string> = { you: '@', model: '▣', memory: '∴', files: '≡', shell: '$', web: '⊕', browser: '⊟', agents: 'Ψ', skills: '↯', hooks: '⌡' }
const ALARM_ICON = '✕'
const INDEX = new Map<StationId, number>(STATIONS.map((s, i) => [s.id, i]))
const AGENTS = INDEX.get('agents') ?? 7

/** A beam lights the way an action took for half a glow, as in the picture. */
const BEAM_MS = GLOW_MS / 2
/** A running call throbs once a beat: up quickly, down slowly. A background task throbs at a third of the pace, at half the strength. */
const BEAT_MS = 1400
const TASK_BEAT_MS = 4200
const BEAT_UP_MS = 120
const BEAT_DOWN_MS = 900
/** The core breathes slowly at rest, quicker while the main loop or a subagent works. */
const BREATH_MS = 4800
const BREATH_BUSY_MS = 1600
const CREW_LAP_MS = 7000
const CREW_MAX = 6
const SWITCH_LAP_MS = 1600
/** The context ring runs down to its new fill at a compaction rather than jumping. */
const DRAIN_MS = 600
/** The newest leg of the route draws itself, as in the picture, and its end lights a little before it is done. */
const REVEAL_MS = 500
const END_DOT_MS = 400
/** Fewer legs than the picture's six: in cells, more of them cross into one grey tangle. */
const LEGS = 4
/** How far from the core a leg bends, by how many stations apart its ends are: as in the picture. */
const BEND = [0.5, 0.5, 0.4, 0.45, 0.55, 0.75]
/** Steps a fade goes in. Eight read as smooth in cells and keep a busy frame to a few dozen pairs of colours. */
const STEPS = 8

/** Which colour a cell takes when several things put dots in it: the higher wins, and the dots of all of them stay. */
const SPOKE = 1
const OUTLINE = 2
const LEG = 3
const BEAM = 4
const RING = 5
const CREW = 6
const HAND = 7
const RETURN = 8
const TAIL = 9
const HEAD = 10

/** The bit of each dot in a braille cell, by `(column << 2) | row` within the cell. */
const BITS = [0x01, 0x02, 0x04, 0x40, 0x08, 0x10, 0x20, 0x80]
const BRAILLE = 0x2800

/**
 * Sizes in column widths. A full ring has nodes three rows tall, each a small circle around its icon; a short pane
 * (20 rows or fewer) has one-row nodes, a smaller core and its labels right next to the nodes.
 */
type Shape = {
  isCompact: boolean
  nodeR: number
  coreR: number
  /** Rows from a node's row to its label's. */
  labelGap: number
  /** Columns either side of a node's icon that no label may take. */
  nodeHalf: number
  minuteR: number
  tenR: number
  crewR: number
}
const FULL: Shape = { isCompact: false, nodeR: 2.2, coreR: 7, labelGap: 2, nodeHalf: 3, minuteR: 2.8, tenR: 3.4, crewR: 4.4 }
const COMPACT: Shape = { isCompact: true, nodeR: 1.15, coreR: 5.2, labelGap: 1, nodeHalf: 2, minuteR: 1.8, tenR: 2.4, crewR: 3.2 }
/** Room a spoke needs past the core's context ring, and before a node: at both ends a gap of ground. */
const SPOKE_FROM = 1.7
const SPOKE_TO = 1.4
const CONTEXT_GAP = 0.55

type Point = { x: number; y: number }
type Spot = Point & { col: number; row: number; upper: boolean }

/** Everything that follows from the size of the box, the shape of its cells and the layout, made once for them. */
type Geometry = {
  key: string
  columns: number
  rows: number
  cellShape: number
  dotsAcross: number
  dotsDown: number
  shape: Shape
  /** Too little room for a ring: the core's words alone. */
  isTiny: boolean
  coreR: number
  center: Spot
  R: number
  /** How far the ring is turned, in radians: You at the bottom turns it half way round. */
  turn: number
  stations: Spot[]
  /** Dots in order: each spoke from the core outwards, each circle clockwise from twelve. */
  spokes: Int32Array[]
  outlines: Int32Array[]
  minuteHands: Int32Array[]
  tenHands: Int32Array[]
  core: Int32Array
  context: Int32Array
  /** The cells a node's glow tints, and the core's breath. */
  glows: Int32Array[]
  coreCells: Int32Array
  /** Legs, lanes and rings, made the first time they are needed. */
  paths: Map<string, Int32Array>
}

/** The colours of the ring, the palette's and those mixed from it. */
type Paint = Ink & { key: string; spokeDot: number; nodeDot: number; tenHand: number }

/** The lines that stay put for a geometry, a palette and how worn the spokes are: copied under each frame. */
type Base = { key: string; bits: Uint8Array; owner: Uint8Array; color: Uint32Array; spokeColors: number[] }

type Memory = {
  geometry: Geometry | undefined
  base: Base | undefined
  paint: { setup: Setup; paint: Paint } | undefined
  labels: { key: string; spots: (Placed | undefined)[] } | undefined
  /** The context ring as last shown, and where a drain started from and when. */
  context: { target: number; from: number; at: number } | undefined
  work: Canvas | undefined
}

/** One frame's dots: their bits, which layer each cell's colour came from, the colour, and the cells words keep clear. */
type Canvas = { columns: number; dotsAcross: number; dotsDown: number; bits: Uint8Array; owner: Uint8Array; color: Uint32Array; clear: Uint8Array }

type Placed = { col: number; row: number; rung: number }

// ---- geometry ----------------------------------------------------------------------------------

const toward = (a: Point, b: Point, d: number): Point => {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len }
}

/**
 * The dots along a curve, in order, each a neighbour of the last. A line leaves out the corners a diagonal would
 * double, so it is one dot thick; a circle keeps them, which rounds it where it turns.
 */
function trace(g: Pick<Geometry, 'cellShape' | 'dotsAcross' | 'dotsDown'>, at: (t: number) => Point, length: number, isThin = true): Int32Array {
  const n = Math.max(1, Math.ceil(length * 8))
  const xs: number[] = []
  const ys: number[] = []
  for (let k = 0; k <= n; k++) {
    const p = at(k / n)
    const dx = Math.floor(p.x * 2)
    const dy = Math.floor((p.y / g.cellShape) * 4)
    if (!(dx >= 0 && dy >= 0 && dx < g.dotsAcross && dy < g.dotsDown)) continue
    const m = xs.length
    if (m > 0 && xs[m - 1] === dx && ys[m - 1] === dy) continue
    if (isThin && m > 1 && Math.abs(xs[m - 2]! - dx) <= 1 && Math.abs(ys[m - 2]! - dy) <= 1) {
      xs.pop()
      ys.pop()
    }
    xs.push(dx)
    ys.push(dy)
  }
  return Int32Array.from(xs, (dx, k) => ys[k]! * g.dotsAcross + dx)
}

function circleOf(g: Pick<Geometry, 'cellShape' | 'dotsAcross' | 'dotsDown'>, c: Point, r: number): Int32Array {
  const dots = trace(g, t => ({ x: c.x + r * Math.sin(2 * Math.PI * t), y: c.y - r * Math.cos(2 * Math.PI * t) }), 2 * Math.PI * r, false)
  return dots.length > 1 && dots[0] === dots[dots.length - 1] ? dots.subarray(0, dots.length - 1) : dots
}

function lineOf(g: Pick<Geometry, 'cellShape' | 'dotsAcross' | 'dotsDown'>, a: Point, b: Point): Int32Array {
  return trace(g, t => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }), Math.hypot(b.x - a.x, b.y - a.y))
}

/** The cells within `r` of a point, by their centres, on the rows `reach` either side of its own. */
function cellsWithin(columns: number, rows: number, cellShape: number, c: Spot, r: number, reach: number): Int32Array {
  const out: number[] = []
  for (let row = Math.max(0, c.row - reach); row <= Math.min(rows - 1, c.row + reach); row++) {
    for (let col = 0; col < columns; col++) {
      const x = col + 0.5 - c.x
      const y = (row + 0.5) * cellShape - c.y
      if (x * x + y * y <= r * r) out.push(row * columns + col)
    }
  }
  return Int32Array.from(out)
}

/**
 * The ring's radius in rows for a shape: as tall as the box allows, and as wide. Ten stations at 36°: the widest
 * pair sits sin 72° of the radius out, and needs half a node beside it.
 */
function radiusFor(shape: Shape, columns: number, rows: number, cellShape: number): number {
  const byHeight = Math.floor((rows - 1 - 2 * shape.labelGap) / 2)
  const byWidth = Math.floor((columns / 2 - shape.nodeHalf) / (Math.sin((2 * Math.PI) / 5) * cellShape))
  return Math.min(byHeight, byWidth)
}

/** Room a spoke has between the core and a node, in column widths, for a shape and a radius. */
const spokeRoom = (shape: Shape, R: number): number => R - shape.coreR - CONTEXT_GAP - SPOKE_FROM - shape.nodeR - SPOKE_TO

function geometryFor(columns: number, rows: number, cellShape: number, layout: Setup['layout']): Geometry {
  // A short box takes the compact ring, and so does a narrow one where full-size nodes would leave the spokes stubs.
  const shape = rows <= 20 || spokeRoom(FULL, radiusFor(FULL, columns, rows, cellShape) * cellShape) < 3.5 ? COMPACT : FULL
  const Ry = radiusFor(shape, columns, rows, cellShape)
  const R = Ry * cellShape
  // On cells nearly square a node three rows tall would reach its label's row.
  const nodeR = Math.min(shape.nodeR, 1.4 * cellShape)
  const coreR = Math.max(3, Math.min(shape.coreR, R - nodeR - SPOKE_FROM - SPOKE_TO - CONTEXT_GAP - 2))
  const used = 2 * Ry + 2 * shape.labelGap + 1
  const top = Math.max(0, Math.floor((rows - used) / 2))
  const crow = top + shape.labelGap + Ry
  const ccol = Math.floor((columns - 1) / 2)
  const center: Spot = { x: ccol + 0.5, y: (crow + 0.5) * cellShape, col: ccol, row: crow, upper: false }
  const g = { cellShape, dotsAcross: columns * 2, dotsDown: rows * 4 }
  const turn = layout === 'you-bottom' ? Math.PI : 0
  const stations = STATIONS.map((_, i): Spot => {
    const a = turn + (i * 2 * Math.PI) / STATIONS.length
    // Snapped to the middle of a cell, so the icon sits in the middle of its circle; the mirror stays exact.
    const col = Math.floor(center.x + R * Math.sin(a))
    const row = Math.round((center.y - R * Math.cos(a)) / cellShape - 0.5)
    return { x: col + 0.5, y: (row + 0.5) * cellShape, col, row, upper: Math.cos(a) > 0.01 }
  })
  // A node glows in the three cells across its icon: inside its circle, a lit window; any more, a box around it.
  const glowOf = (s: Spot): Int32Array => Int32Array.from([-1, 0, 1].filter(d => s.col + d >= 0 && s.col + d < columns && s.row >= 0 && s.row < rows).map(d => s.row * columns + s.col + d))
  return {
    key: `${columns}x${rows}:${cellShape}:${layout}`,
    columns,
    rows,
    ...g,
    shape: { ...shape, nodeR },
    isTiny: Ry < 3 || columns < 20,
    coreR,
    center,
    R,
    turn,
    stations,
    spokes: stations.map(s => lineOf(g, toward(center, s, coreR + SPOKE_FROM), toward(s, center, nodeR + SPOKE_TO))),
    outlines: stations.map(s => circleOf(g, s, nodeR)),
    minuteHands: stations.map(s => circleOf(g, s, shape.minuteR)),
    tenHands: stations.map(s => circleOf(g, s, shape.tenR)),
    core: circleOf(g, center, coreR),
    context: circleOf(g, center, coreR + CONTEXT_GAP),
    glows: stations.map(glowOf),
    // The breath lies under the core's three rows of words: on the rows above and below, cells are too coarse for a round.
    coreCells: cellsWithin(columns, rows, cellShape, center, coreR - 0.9, 1),
    paths: new Map(),
  }
}

/** A path made once for a geometry and kept with it. */
function pathOf(g: Geometry, key: string, make: () => Int32Array): Int32Array {
  const known = g.paths.get(key)
  if (known !== undefined) return known
  const made = make()
  g.paths.set(key, made)
  return made
}

/** The way from one station to another: the picture's curve through the room between the core and the ring. */
function legOf(g: Geometry, i: number, j: number): Int32Array {
  return pathOf(g, `leg ${i} ${j}`, () => {
    const n = STATIONS.length
    let steps = (((j - i) % n) + n) % n
    if (steps > n / 2) steps -= n
    const a = g.turn + ((i + steps / 2) * 2 * Math.PI) / n
    const f = BEND[Math.abs(steps)] ?? 0.5
    const bend = { x: g.center.x + g.R * f * Math.sin(a), y: g.center.y - g.R * f * Math.cos(a) }
    const from = toward(g.stations[i]!, bend, g.shape.nodeR + SPOKE_TO)
    const to = toward(g.stations[j]!, bend, g.shape.nodeR + SPOKE_TO)
    const length = Math.hypot(bend.x - from.x, bend.y - from.y) + Math.hypot(to.x - bend.x, to.y - bend.y)
    return trace(
      g,
      t => ({
        x: (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * bend.x + t * t * to.x,
        y: (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * bend.y + t * t * to.y,
      }),
      length,
    )
  })
}

/** A spoke moved sideways, so that pulses sharing it at one moment fly side by side. */
function laneOf(g: Geometry, i: number, lane: number): Int32Array {
  if (lane === 0) return g.spokes[i]!
  return pathOf(g, `lane ${i} ${lane}`, () => {
    const s = g.stations[i]!
    const a = toward(g.center, s, g.coreR + SPOKE_FROM)
    const b = toward(s, g.center, g.shape.nodeR + SPOKE_TO)
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const off = lane * 0.6
    const dx = (-(b.y - a.y) * off) / len
    const dy = ((b.x - a.x) * off) / len
    return lineOf(g, { x: a.x + dx, y: a.y + dy }, { x: b.x + dx, y: b.y + dy })
  })
}

/** A circle around a point, its radius rounded to a tenth so that a growing ring reuses its circles. */
function ringOf(g: Geometry, c: Point, r: number): Int32Array {
  const tenths = Math.round(r * 10)
  return pathOf(g, `ring ${c.x} ${c.y} ${tenths}`, () => circleOf(g, c, tenths / 10))
}

// ---- colours -----------------------------------------------------------------------------------

function paintFor(setup: Setup, memory: Memory): Paint {
  if (memory.paint?.setup === setup) return memory.paint.paint
  const ink = inkFor(setup)
  // The picture's spoke colour is too dark for lines of single dots: they take a step towards the words' grey.
  const paint: Paint = {
    ...ink,
    key: Object.values(ink).join(','),
    spokeDot: mix(ink.line, ink.dim, setup.theme === 'light' ? 0.6 : 0.35),
    nodeDot: mix(ink.line, ink.dim, setup.theme === 'light' ? 0.85 : 0.6),
    tenHand: mix(ink.ground, ink.hot, 0.6),
  }
  memory.paint = { setup, paint }
  return paint
}

/** How worn a spoke is by its count, in the picture's measure and in steps. */
const wornBy = (count: number): number => quantize(Math.min(1, Math.log2(1 + Math.max(0, count)) / 7), STEPS)

const spokeColor = (paint: Paint, id: StationId, worn: number): number => mix(paint.spokeDot, id === 'memory' ? paint.mem : paint.accent, 0.55 * worn)

// ---- the canvas of dots ------------------------------------------------------------------------

function baseFor(g: Geometry, paint: Paint, counts: Board['counts'], memory: Memory): Base {
  const worn = STATIONS.map(s => wornBy(counts[s.id] ?? 0))
  const key = `${g.key}|${paint.key}|${worn.join(',')}`
  if (memory.base?.key === key) return memory.base
  const size = g.columns * g.rows
  const canvas: Canvas = { columns: g.columns, dotsAcross: g.dotsAcross, dotsDown: g.dotsDown, bits: new Uint8Array(size), owner: new Uint8Array(size), color: new Uint32Array(size), clear: new Uint8Array(size) }
  const spokeColors = STATIONS.map((s, i) => spokeColor(paint, s.id, worn[i]!))
  if (!g.isTiny) {
    // Where spokes meet near the core, the more worn one gives the cell its colour.
    const order = STATIONS.map((_, i) => i).sort((a, b) => worn[a]! - worn[b]!)
    for (const i of order) plotPath(canvas, g.spokes[i]!, SPOKE, spokeColors[i]!)
    for (const outline of g.outlines) plotPath(canvas, outline, OUTLINE, paint.nodeDot)
    plotPath(canvas, g.core, OUTLINE, paint.nodeDot)
  }
  memory.base = { key, bits: canvas.bits, owner: canvas.owner, color: canvas.color, spokeColors }
  return memory.base
}

function workFor(g: Geometry, base: Base, memory: Memory): Canvas {
  const size = g.columns * g.rows
  let work = memory.work
  if (work === undefined || work.bits.length !== size || work.columns !== g.columns) {
    work = { columns: g.columns, dotsAcross: g.dotsAcross, dotsDown: g.dotsDown, bits: new Uint8Array(size), owner: new Uint8Array(size), color: new Uint32Array(size), clear: new Uint8Array(size) }
    memory.work = work
  }
  work.bits.set(base.bits)
  work.owner.set(base.owner)
  work.color.set(base.color)
  work.clear.fill(0)
  return work
}

function plotAt(c: Canvas, dx: number, dy: number, layer: number, color: number): void {
  if (dx < 0 || dy < 0 || dx >= c.dotsAcross || dy >= c.dotsDown) return
  const cell = (dy >> 2) * c.columns + (dx >> 1)
  c.bits[cell]! |= BITS[((dx & 1) << 2) | (dy & 3)]!
  if (layer >= c.owner[cell]!) {
    c.owner[cell] = layer
    c.color[cell] = color
  }
}

const plot = (c: Canvas, dot: number, layer: number, color: number): void => plotAt(c, dot % c.dotsAcross, Math.floor(dot / c.dotsAcross), layer, color)

/** Dots of a path from `from` up to `to` (exclusive); `every` 2 makes it dotted. */
function plotPath(c: Canvas, path: Int32Array, layer: number, color: number, from = 0, to = path.length, every = 1): void {
  for (let k = Math.max(0, from); k < Math.min(to, path.length); k += every) plot(c, path[k]!, layer, color)
}

/** A block of dots around one: four by four without its corners for a pulse's head, hollow for a signal nobody asked for, two by two for a bead. */
function plotBlob(c: Canvas, dot: number, size: 2 | 4, layer: number, color: number, isHollow = false): void {
  const dx = dot % c.dotsAcross
  const dy = Math.floor(dot / c.dotsAcross)
  const lo = size === 4 ? -2 : -1
  const hi = size === 4 ? 1 : 0
  for (let y = lo; y <= hi; y++) {
    for (let x = lo; x <= hi; x++) {
      const isEdgeX = x === lo || x === hi
      const isEdgeY = y === lo || y === hi
      if (size === 4 && isEdgeX && isEdgeY) continue
      if (isHollow && !isEdgeX && !isEdgeY) continue
      plotAt(c, dx + x, dy + y, layer, color)
    }
  }
}

// ---- what the board says -----------------------------------------------------------------------

type Station = {
  running: number
  /** When the longest-running of its calls began. */
  since: number
  /** Every call running here is a background task. */
  onlyTasks: boolean
  /** When it was last used: the latest call's end, or start while it runs. */
  usedAt: number
  /** When its latest error or refusal happened. */
  alarmAt: number
}

const isBad = (e: Entry): boolean => e.status === 'err' || e.status === 'block'
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function stationsOf(entries: readonly Entry[]): Station[] {
  const out = STATIONS.map((): Station => ({ running: 0, since: Infinity, onlyTasks: true, usedAt: -Infinity, alarmAt: -Infinity }))
  for (const e of entries) {
    const s = out[INDEX.get(e.station) ?? -1]
    if (s === undefined || !finite(e.startedAt)) continue
    const at = finite(e.endedAt) ? e.endedAt : e.startedAt
    s.usedAt = at
    if (e.status === 'run') {
      s.running++
      s.since = Math.min(s.since, e.startedAt)
      if (e.task === undefined) s.onlyTasks = false
    }
    if (isBad(e)) s.alarmAt = at
  }
  return out
}

/** A breath's swell, 0 to 1 and back over a period, in steps. */
const breathOf = (now: number, period: number): number => quantize((1 - Math.cos((2 * Math.PI * (((now % period) + period) % period)) / period)) / 2, STEPS)

/** Ms until a breath's swell takes its next step: where it next crosses half way between two steps, or turns. */
function breathIn(now: number, period: number): number {
  const phase = (((now % period) + period) % period) / period
  const level = (1 - Math.cos(2 * Math.PI * phase)) / 2
  const isRising = phase < 0.5
  const step = Math.round(level * STEPS) + (isRising ? 0.5 : -0.5)
  // The next crossing, if the swell gets there before it turns; the turn itself changes nothing.
  const cross = Math.max(0, Math.min(1, step / STEPS))
  const at = Math.acos(1 - 2 * cross) / (2 * Math.PI)
  const next = isRising ? at : 1 - at
  // A millisecond past the crossing, so that the frame lands after it and not a rounding error before.
  return Math.ceil((next > phase ? next - phase : next + 1 - phase) * period) + 1
}

/** A beat's swell, 0 to 1: up in a moment, down slowly, then still until the next. */
function beatOf(elapsed: number, period: number): number {
  const p = ((elapsed % period) + period) % period
  return p < BEAT_UP_MS ? p / BEAT_UP_MS : p < BEAT_UP_MS + BEAT_DOWN_MS ? 1 - (p - BEAT_UP_MS) / BEAT_DOWN_MS : 0
}

/**
 * The letters for a minute and an hour in a label's short time, by language. text.ts has the time only at length
 * (`14 min 20 s`), too long beside a node; a language not here writes `m` and `h`.
 */
const CLOCK_LETTERS: Record<string, { minute: string; hour: string }> = { ru: { minute: 'м', hour: 'ч' } }

function clockLettersFor(t: Strings): { minute: string; hour: string } {
  for (const [language, letters] of Object.entries(CLOCK_LETTERS)) if (stringsFor(language) === t) return letters
  return { minute: 'm', hour: 'h' }
}

/** How long a call has run, as a label says it: minutes, then hours and minutes. */
function tookText(ms: number, t: Strings): string {
  const { minute, hour } = clockLettersFor(t)
  const minutes = Math.floor(ms / 60000)
  return minutes < 60 ? `${minutes}${minute}` : `${Math.floor(minutes / 60)}${hour}${String(minutes % 60).padStart(2, '0')}`
}

/** The context ring's fill at `now`: the board's, run down to over a moment when it fell. */
function contextShown(board: Board, now: number, memory: Memory): number | undefined {
  if (!finite(board.context)) {
    memory.context = undefined
    return undefined
  }
  const target = Math.max(0, Math.min(100, board.context))
  const was = memory.context
  if (was === undefined) memory.context = { target, from: target, at: now }
  else if (target !== was.target) {
    const shown = drained(was, now)
    memory.context = target < shown ? { target, from: shown, at: now } : { target, from: target, at: now }
  }
  return drained(memory.context!, now)
}

function drained(c: { target: number; from: number; at: number }, now: number): number {
  const t = Math.max(0, Math.min(1, (now - c.at) / DRAIN_MS))
  return c.from + (c.target - c.from) * (1 - (1 - t) * (1 - t))
}

// ---- words -------------------------------------------------------------------------------------

type Piece = { text: string; fg: number; bg?: number }

const widthOf = (pieces: readonly Piece[]): number => pieces.reduce((n, p) => n + glyphsOf(p.text).length, 0)

/** A station's label from the most it can say down to the least: the count goes first, then the time, then how many run. */
function rungsOf(id: StationId, board: Board, counts: Board['counts'], s: Station, now: number, setup: Setup, paint: Paint, name: number): Piece[][] {
  const faults = Math.max(0, Math.floor(board.faults?.[id] ?? 0))
  const count = Math.max(0, Math.floor(counts[id] ?? 0))
  const badge: Piece[] = faults > 0 ? [{ text: '▐', fg: paint.red }, { text: faults > 99 ? '99+' : String(faults), fg: paint.ground, bg: paint.red }, { text: '▌', fg: paint.red }] : []
  const named: Piece[] = [{ text: setup.t.stations[id], fg: name }]
  // Memory keeps two counts: what was asked for, and what a hook brought down unasked.
  const pushed = id === 'memory' ? Math.min(count, Math.max(0, Math.floor(board.pushed ?? 0))) : 0
  const counted: Piece[] =
    count === 0 ? [] : pushed === 0 ? [{ text: String(count), fg: paint.dim }] : [...(count > pushed ? [{ text: `${count - pushed} `, fg: paint.dim }] : []), { text: `↓${pushed}`, fg: paint.mem }]
  const hot = id === 'memory' ? paint.memHot : paint.hot
  const many: Piece[] = s.running > 1 ? [{ text: `×${s.running}`, fg: hot }] : []
  const took: Piece[] = s.running > 0 && now - s.since >= 60000 ? [{ text: tookText(now - s.since, setup.t), fg: hot }] : []
  const join = (...groups: Piece[][]): Piece[] => groups.filter(g => g.length > 0).flatMap((g, k) => (k === 0 ? g : [{ text: ' ', fg: DEFAULT }, ...g]))
  return [join(badge, named, counted, many, took), join(badge, named, many, took), join(badge, named, many), join(badge, named)]
}

/**
 * Where each label goes: on the row just outside its node, nearest the middle first, each at the place within six
 * columns of centred that covers the fewest lines and never a node or another word. When nothing fits, the label
 * says less; when even its name does not fit, it goes on the node's other side, or a row further out; failing all
 * that, it is left out. Kept while the labels' widths stay the same, so a label never jumps as a pulse passes under it.
 */
function placeLabels(g: Geometry, base: Base, words: { cells: Uint8Array; key: string }, widths: number[][], memory: Memory): (Placed | undefined)[] {
  const key = `${g.key}|${widths.map(w => w.join(',')).join(';')}|${words.key}`
  if (memory.labels?.key === key) return memory.labels.spots
  const { columns, rows, shape } = g
  const taken = words.cells.slice()
  const isFree = (col: number, row: number, len: number): boolean => {
    for (let x = col; x < col + len; x++) if (x >= 0 && x < columns && taken[row * columns + x] !== 0) return false
    return true
  }
  const reach = shape.isCompact ? 0 : 1
  const hitsNode = (col: number, row: number, len: number): boolean =>
    g.stations.some(s => row >= s.row - reach && row <= s.row + reach && col <= s.col + shape.nodeHalf && col + len - 1 >= s.col - shape.nodeHalf)
  /** The best place on a row for a label this long, and what it costs; undefined where it cannot go. */
  const bestOn = (s: Spot, row: number, len: number): { col: number; cost: number } | undefined => {
    if (row < 0 || row >= rows || len > columns) return undefined
    const centred = Math.round(s.x - len / 2)
    let best: { col: number; cost: number } | undefined
    for (let d = -6; d <= 6; d++) {
      const col = Math.max(0, Math.min(columns - len, centred + d))
      // A rim of one empty cell either side, except where the box ends.
      if (!isFree(col - 1, row, len + 2) || hitsNode(col, row, len)) continue
      let cost = Math.abs(d) * 0.3
      for (let x = Math.max(0, col - 1); x <= Math.min(columns - 1, col + len); x++) if (base.bits[row * columns + x] !== 0) cost++
      if (best === undefined || cost < best.cost) best = { col, cost }
    }
    return best
  }
  const order = g.stations.map((_, i) => i).sort((a, b) => Math.abs(g.stations[a]!.x - g.center.x) - Math.abs(g.stations[b]!.x - g.center.x))
  const spots: (Placed | undefined)[] = g.stations.map(() => undefined)
  for (const i of order) {
    const s = g.stations[i]!
    const out = s.upper ? -1 : 1
    const rows = [shape.labelGap, -shape.labelGap, shape.labelGap + 1, -shape.labelGap - 1].map(d => s.row + out * d)
    const rungs = widths[i]!
    let placed: Placed | undefined
    for (const row of rows) {
      for (let rung = 0; rung < rungs.length && placed === undefined; rung++) {
        const spot = bestOn(s, row, rungs[rung]!)
        if (spot !== undefined) placed = { col: spot.col, row, rung }
      }
      if (placed !== undefined) break
    }
    if (placed === undefined) continue
    spots[i] = placed
    for (let x = placed.col; x < placed.col + (rungs[placed.rung] ?? 0); x++) taken[placed.row * columns + x] = 1
  }
  memory.labels = { key, spots }
  return spots
}

/** Text across a row, each piece in its colours, its cells and a rim either side kept clear of dots. */
function writeText(cells: Cells, canvas: Canvas, col: number, row: number, pieces: readonly Piece[]): void {
  if (row < 0 || row >= cells.rows) return
  const len = widthOf(pieces)
  for (let x = col - 1; x <= col + len; x++) if (x >= 0 && x < cells.columns) canvas.clear[row * cells.columns + x] = 1
  let x = col
  for (const p of pieces) x += cells.text(x, row, p.text, p.fg, p.bg, cells.columns - x)
}

// ---- the frame ---------------------------------------------------------------------------------

function geometryOf(size: ViewSize, setup: Setup, memory: Memory): Geometry {
  const columns = Math.max(0, Math.floor(size.columns))
  const rows = Math.max(0, Math.floor(size.rows))
  const cellShape = finite(setup.cellShape) && setup.cellShape > 0 ? setup.cellShape : 2.4
  const key = `${columns}x${rows}:${cellShape}:${setup.layout}`
  if (memory.geometry?.key !== key) {
    memory.geometry = geometryFor(columns, rows, cellShape, setup.layout)
    memory.base = undefined
    memory.labels = undefined
  }
  return memory.geometry
}

/** The entries whose moment is still on the map: pulses out and back, beams, and the newest of each kind of mark. */
type Moments = { flights: Entry[]; returns: Entry[]; beams: Entry[]; done: Entry | undefined }

function momentsOf(entries: readonly Entry[], now: number): Moments {
  const flights: Entry[] = []
  const returns: Entry[] = []
  const beams: Entry[] = []
  let done: Entry | undefined
  // As in the picture: the newest fourteen of each, oldest first.
  for (let k = entries.length - 1; k >= 0; k--) {
    const e = entries[k]!
    if (!finite(e.startedAt) || INDEX.get(e.station) === undefined) continue
    const age = now - e.startedAt
    if (age >= 0 && age < PULSE_MS + RIPPLE_MS && flights.length < 14) flights.unshift(e)
    if (age >= 0 && age < BEAM_MS && beams.length < 10) beams.unshift(e)
    if (finite(e.endedAt) && e.from !== 'inbound' && now - e.endedAt >= 0 && now - e.endedAt < PULSE_MS && returns.length < 14) returns.unshift(e)
    if (done === undefined && e.mark === 'done') done = e
  }
  return { flights, returns, beams, done }
}

/** The way an entry's pulse takes, from where it starts: the core's spoke (in its lane), or the leg from the agents station. */
function wayOf(g: Geometry, e: Entry, lane: number): { path: Int32Array; isLeg: boolean } {
  const i = INDEX.get(e.station) ?? 0
  if (e.from === 'agents' && i !== AGENTS) return { path: legOf(g, AGENTS, i), isLeg: true }
  return { path: laneOf(g, i, lane), isLeg: false }
}

function lanesOf(list: readonly Entry[]): Map<Entry, number> {
  const out = new Map<Entry, number>()
  for (const e of list) {
    const peers = list.filter(x => x.station === e.station && x.from === e.from)
    out.set(e, Math.max(-2, Math.min(2, Math.round(peers.indexOf(e) - (peers.length - 1) / 2))))
  }
  return out
}

/** How a station looks this frame: its icon, the colour of its name, and its outline and glow when it is lit. */
type Look = { glyph: string; icon: number; name: number; outline: number | undefined; glow: number; glowColor: number }

function lookOf(id: StationId, s: Station, count: number, crew: number, now: number, paint: Paint): Look {
  const main = id === 'memory' ? paint.mem : paint.accent
  const hot = id === 'memory' ? paint.memHot : paint.hot
  const alarmAge = now - s.alarmAt
  const isAlarm = alarmAge >= 0 && alarmAge < ALARM_MS
  const sinceUse = now - s.usedAt
  const isRunning = s.running > 0
  const isLit = isRunning || (sinceUse >= 0 && sinceUse < GLOW_MS)
  const color = isAlarm ? paint.red : main
  const left = quantize(isAlarm ? 1 - alarmAge / ALARM_MS : 1 - sinceUse / GLOW_MS, STEPS)
  const look: Look = {
    glyph: isAlarm ? ALARM_ICON : ICONS[id],
    icon: isAlarm ? paint.red : isLit ? hot : id === 'memory' && count > 0 ? main : paint.ash,
    name: isAlarm || isRunning ? paint.bone : isLit ? mix(paint.ash, paint.bone, left) : paint.ash,
    outline: undefined,
    glow: 0,
    glowColor: color,
  }
  if (isRunning && !isAlarm) {
    // A beat on top of a steady glow; the agents station keeps still while its crew goes round it.
    const swell = id === 'agents' && crew > 0 ? 0 : quantize(beatOf(now - s.since, s.onlyTasks ? TASK_BEAT_MS : BEAT_MS), STEPS) * (s.onlyTasks ? 0.5 : 1)
    look.outline = mix(main, hot, swell)
    look.glow = 0.16 + 0.18 * swell
  } else if (isLit || isAlarm) {
    // Lit a moment ago, or in alarm: the glow and the outline's colour fade out.
    look.outline = mix(paint.nodeDot, color, left)
    look.glow = 0.3 * left
  }
  return look
}

/** The core's three lines: how full the context is, whose map it is, and the model, hot while it has just changed. */
function coreLinesOf(g: Geometry, board: Board, context: number | undefined, now: number, setup: Setup, paint: Paint): { col: number; row: number; pieces: Piece[] }[] {
  const lines: Piece[][] = []
  const rows: number[] = []
  if (context !== undefined) {
    lines.push([{ text: `${Math.round(context)}%`, fg: paint.dim }])
    rows.push(g.center.row - 1)
  }
  const isSpaced = !g.shape.isCompact && g.coreR >= 6.5 && glyphsOf(setup.core).length <= 6
  lines.push([{ text: isSpaced ? [...setup.core].join(' ') : setup.core, fg: paint.bone }])
  rows.push(g.center.row)
  if (typeof board.model === 'string' && board.model !== '') {
    const switchAge = finite(board.switchedAt) ? now - board.switchedAt : Infinity
    const isSwitching = switchAge >= 0 && switchAge < SWITCH_MS
    lines.push([{ text: cut(shortModel(board.model), Math.max(1, Math.min(11, Math.round(2 * g.coreR)))), fg: isSwitching ? paint.hot : paint.ash }])
    rows.push(g.center.row + 1)
  }
  return lines.map((pieces, k) => ({ col: g.center.col - Math.floor((widthOf(pieces) - 1) / 2), row: rows[k]!, pieces }))
}

function draw(board: Board, now: number, size: ViewSize, setup: Setup, memory: Memory): Cells {
  const g = geometryOf(size, setup, memory)
  const paint = paintFor(setup, memory)
  const cells = new Cells(g.columns, g.rows, groundFor(setup))
  if (g.columns === 0 || g.rows === 0) return cells
  const entries = Array.isArray(board.entries) ? board.entries : []
  const counts = board.counts ?? {}
  const context = contextShown(board, now, memory)
  const coreLines = coreLinesOf(g, board, context, now, setup, paint)
  const base = baseFor(g, paint, counts, memory)
  const canvas = workFor(g, base, memory)
  if (!g.isTiny) drawRing(g, canvas, cells, board, entries, counts, context, coreLines, now, setup, paint, base, memory)
  for (const line of coreLines) writeText(cells, canvas, line.col, line.row, line.pieces)

  // The dots go under everything written.
  const out = cells.words
  for (let cell = 0; cell < canvas.bits.length; cell++) {
    const bits = canvas.bits[cell]!
    if (bits === 0 || canvas.clear[cell] !== 0 || out[cell * 3] !== 0x20) continue
    out[cell * 3] = BRAILLE | bits
    out[cell * 3 + 1] = canvas.color[cell]!
  }
  return cells
}

/** Everything but the core's words: the breath, the context ring, the route, the stations, what moves, and the labels. */
function drawRing(
  g: Geometry,
  canvas: Canvas,
  cells: Cells,
  board: Board,
  entries: readonly Entry[],
  counts: Board['counts'],
  context: number | undefined,
  coreLines: { col: number; row: number; pieces: Piece[] }[],
  now: number,
  setup: Setup,
  paint: Paint,
  base: Base,
  memory: Memory,
): void {
  const stations = stationsOf(entries)
  const crew = Math.min(CREW_MAX, Array.isArray(board.agents) ? board.agents.length : 0)
  const isBusy = entries.some(e => e.status === 'run' && e.task === undefined) || crew > 0
  const tint = (cell: number, bg: number): void => cells.tint(cell % g.columns, Math.floor(cell / g.columns), bg)

  // The core breathes under its words, and its outline is lit while the main loop or a subagent works.
  const [lo, hi] = isBusy ? [0.06, 0.2] : [0.03, 0.08]
  const breath = mix(paint.ground, paint.accent, lo + (hi - lo) * breathOf(now, isBusy ? BREATH_BUSY_MS : BREATH_MS))
  for (const cell of g.coreCells) tint(cell, breath)
  if (isBusy) plotPath(canvas, g.core, OUTLINE, paint.accent)
  if (context !== undefined) {
    const full = Math.round(context)
    plotPath(canvas, g.context, OUTLINE, full >= 90 ? paint.red : full >= 70 ? paint.accent : paint.ash, 0, Math.round((full / 100) * g.context.length))
  }
  drawRoute(g, canvas, entries, now, paint)

  const moments = momentsOf(entries, now)
  // Beams: the way an action took, lit in its colour for a moment; a signal nobody asked for lights every other dot.
  for (const e of moments.beams) {
    const { path, isLeg } = wayOf(g, e, 0)
    const lit = quantize(1 - (now - e.startedAt) / BEAM_MS, STEPS) * 0.75
    const from = isLeg ? paint.ground : (base.spokeColors[INDEX.get(e.station) ?? 0] ?? paint.spokeDot)
    const color = isBad(e) ? paint.red : e.station === 'memory' ? paint.mem : paint.accent
    plotPath(canvas, path, BEAM, mix(from, color, lit), 0, path.length, e.from === 'inbound' ? 2 : 1)
  }

  const looks = STATIONS.map(({ id }, i) => lookOf(id, stations[i]!, counts[id] ?? 0, crew, now, paint))
  looks.forEach((look, i) => {
    const s = stations[i]!
    if (look.glow > 0) for (const cell of g.glows[i]!) tint(cell, mix(paint.ground, look.glowColor, look.glow))
    if (look.outline !== undefined) plotPath(canvas, g.outlines[i]!, OUTLINE, look.outline)
    if (s.running > 0) {
      // Two hands of a clock: the inner one goes round in a minute, thickening the outline; the outer one fills in ten.
      const hot = STATIONS[i]!.id === 'memory' ? paint.memHot : paint.hot
      const elapsed = Math.max(0, now - s.since)
      const minute = g.minuteHands[i]!
      plotPath(canvas, minute, HAND, hot, 0, Math.floor(((elapsed % 60000) / 60000) * minute.length))
      const ten = g.tenHands[i]!
      plotPath(canvas, ten, HAND, paint.tenHand, 0, Math.floor(Math.min(1, elapsed / 600000) * ten.length), 2)
    }
  })

  // Each subagent at work circles the agents station.
  const agents = g.stations[AGENTS]!
  for (let k = 0; k < crew; k++) {
    const a = 2 * Math.PI * ((((now % CREW_LAP_MS) + CREW_LAP_MS) % CREW_LAP_MS) / CREW_LAP_MS + k / crew)
    const x = agents.x + g.shape.crewR * Math.sin(a)
    const y = agents.y - g.shape.crewR * Math.cos(a)
    plotBlob(canvas, Math.floor((y / g.cellShape) * 4) * g.dotsAcross + Math.floor(x * 2), 2, CREW, paint.hot)
  }
  drawRings(g, canvas, board, moments, now, paint)
  drawPulses(g, canvas, moments, now, paint, base)

  // The labels, placed around the icons and the core's words, then the icons; each word keeps a rim clear of dots.
  const words = new Uint8Array(g.columns * g.rows)
  const mark = (col: number, row: number, len: number): void => {
    for (let x = Math.max(0, col); x < Math.min(g.columns, col + len); x++) if (row >= 0 && row < g.rows) words[row * g.columns + x] = 1
  }
  for (const line of coreLines) mark(line.col - 1, line.row, widthOf(line.pieces) + 2)
  for (const spot of g.stations) mark(spot.col, spot.row, 1)
  const rungs = STATIONS.map(({ id }, i) => rungsOf(id, board, counts, stations[i]!, now, setup, paint, looks[i]!.name))
  const wordsKey = coreLines.map(line => `${line.col} ${line.row} ${widthOf(line.pieces)}`).join(',')
  const spots = placeLabels(g, base, { cells: words, key: wordsKey }, rungs.map(r => r.map(widthOf)), memory)
  spots.forEach((spot, i) => {
    if (spot !== undefined) writeText(cells, canvas, spot.col, spot.row, rungs[i]![spot.rung] ?? [])
  })
  g.stations.forEach((spot, i) => {
    if (spot.row < 0 || spot.row >= g.rows || spot.col < 0 || spot.col >= g.columns) return
    canvas.clear[spot.row * g.columns + spot.col] = 1
    cells.set(spot.col, spot.row, looks[i]!.glyph, looks[i]!.icon)
  })
}

/** The route: the last legs the main loop took between stations, held for a while, then faded; the newest draws itself. */
function drawRoute(g: Geometry, canvas: Canvas, entries: readonly Entry[], now: number, paint: Paint): void {
  const stops = routeOf(entries, LEGS + 1)
  for (let k = 1; k < stops.length; k++) {
    const from = INDEX.get(stops[k - 1]!.station)
    const to = INDEX.get(stops[k]!.station)
    if (from === undefined || to === undefined || from === to) continue
    const age = Math.max(0, now - stops[k]!.at)
    if (age >= TRAIL_HOLD_MS + TRAIL_FADE_MS) continue
    const left = age < TRAIL_HOLD_MS ? 1 : quantize(1 - (age - TRAIL_HOLD_MS) / TRAIL_FADE_MS, STEPS)
    const opacity = (0.12 + (0.5 * k) / (stops.length - 1)) * left
    const path = legOf(g, from, to)
    const isHead = k === stops.length - 1
    const shown = isHead ? Math.ceil(Math.min(1, age / REVEAL_MS) * path.length) : path.length
    plotPath(canvas, path, LEG, mix(paint.ground, paint.trail, opacity), 0, shown)
    if (isHead && age >= END_DOT_MS && path.length > 0) plotBlob(canvas, path[path.length - 1]!, 2, LEG, mix(paint.ground, paint.trail, 0.85 * left))
  }
}

/** Rings that spread: a pulse landing, the answer leaving the core, a changed model ringing at the core and its station. */
function drawRings(g: Geometry, canvas: Canvas, board: Board, moments: Moments, now: number, paint: Paint): void {
  const hotOf = (id: StationId): number => (id === 'memory' ? paint.memHot : paint.hot)
  const ring = (c: Point, r: number, color: number, strength: number): void => {
    if (strength <= 0) return
    plotPath(canvas, ringOf(g, c, r), RING, mix(paint.ground, color, strength), 0, Infinity, 2)
  }
  const coreFrom = g.coreR + CONTEXT_GAP + 0.05
  for (const e of moments.flights) {
    const t = (now - e.startedAt - PULSE_MS) / RIPPLE_MS
    if (t < 0 || t >= 1) continue
    const color = e.status === 'block' ? paint.red : hotOf(e.station)
    const strength = quantize(1 - t, STEPS) * 0.7
    if (e.from === 'inbound') ring(g.center, coreFrom + 1.4 * t, color, strength)
    else ring(g.stations[INDEX.get(e.station) ?? 0]!, g.shape.nodeR + 1.4 * t, color, strength)
  }
  const switchAge = finite(board.switchedAt) ? now - board.switchedAt : Infinity
  if (switchAge >= 0 && switchAge < SWITCH_MS) {
    const t = (switchAge % SWITCH_LAP_MS) / SWITCH_LAP_MS
    const strength = quantize(1 - t, STEPS) * 0.7
    ring(g.center, coreFrom + 3.2 * t, paint.bone, strength)
    ring(g.stations[INDEX.get('model') ?? 1]!, g.shape.nodeR + 2.8 * t, paint.bone, strength)
  }
  if (moments.done !== undefined) {
    const t = (now - moments.done.startedAt) / DONE_MS
    if (t >= 0 && t < 1) ring(g.center, coreFrom + 4.8 * t, paint.bone, quantize(1 - t, STEPS) * 0.6)
  }
}

/** Pulses out to a station and beads back from it, each with a short tail along its way. */
function drawPulses(g: Geometry, canvas: Canvas, moments: Moments, now: number, paint: Paint, base: Base): void {
  const hotOf = (id: StationId): number => (id === 'memory' ? paint.memHot : paint.hot)
  const returning = lanesOf(moments.returns)
  for (const e of moments.returns) {
    const { path } = wayOf(g, e, returning.get(e) ?? 0)
    if (path.length === 0) continue
    const t = (now - (e.endedAt ?? now)) / PULSE_MS
    const k = path.length - 1 - Math.round(t * (path.length - 1))
    plotBlob(canvas, path[Math.max(0, Math.min(path.length - 1, k))]!, 2, RETURN, e.status === 'ok' ? paint.ash : paint.red)
  }
  const flying = lanesOf(moments.flights)
  for (const e of moments.flights) {
    const t = (now - e.startedAt) / PULSE_MS
    if (t >= 1) continue
    const { path, isLeg } = wayOf(g, e, flying.get(e) ?? 0)
    const n = path.length
    if (n === 0) continue
    const isInbound = e.from === 'inbound'
    const step = (k: number): number => path[isInbound ? n - 1 - k : k]!
    const head = Math.round(t * (n - 1))
    const color = e.status === 'block' ? paint.red : hotOf(e.station)
    const trailOff = isLeg ? paint.ground : (base.spokeColors[INDEX.get(e.station) ?? 0] ?? paint.spokeDot)
    const main = e.status === 'block' ? paint.red : e.station === 'memory' ? paint.mem : paint.accent
    for (let k = 1; k <= 5 && head - k >= 0; k++) plot(canvas, step(head - k), TAIL, mix(main, trailOff, quantize((k - 1) / 5, STEPS)))
    plotBlob(canvas, step(head), 4, HEAD, color, isInbound)
  }
}

// ---- when to draw again ------------------------------------------------------------------------

/** Ms until a fade of `steps` steps over `span`, `age` into it, next takes a step, or undefined once it is over. */
function stepIn(age: number, span: number, steps = STEPS): number | undefined {
  if (age < 0) return -age
  if (age >= span) return undefined
  // `quantize` rounds, so a step falls half way between two levels.
  const x = (1 - age / span) * steps
  const frac = x - Math.floor(x)
  const down = frac > 0.5 ? frac - 0.5 : frac + 0.5
  return Math.ceil(Math.min(span - age, (down / steps) * span)) + 1
}

function nextFrameIn(board: Board, now: number, size: ViewSize, setup: Setup, memory: Memory, endless: number | undefined): number | undefined {
  const g = geometryOf(size, setup, memory)
  const entries = Array.isArray(board.entries) ? board.entries : []
  const waits: (number | undefined)[] = []
  const flying = FASTEST_MS
  for (const e of entries) {
    if (!finite(e.startedAt)) continue
    const age = now - e.startedAt
    if (age < 0) waits.push(-age)
    else if (age < PULSE_MS + RIPPLE_MS) waits.push(flying)
    else if (age < BEAM_MS) waits.push(stepIn(age, BEAM_MS))
    if (finite(e.endedAt) && e.from !== 'inbound') {
      const back = now - e.endedAt
      if (back < 0) waits.push(-back)
      else if (back < PULSE_MS) waits.push(flying)
    }
    if (e.mark === 'done' && age >= 0 && age < DONE_MS) waits.push(flying)
  }
  const stations = stationsOf(entries)
  for (const s of stations) {
    const alarmAge = now - s.alarmAt
    if (alarmAge >= 0 && alarmAge < ALARM_MS) waits.push(stepIn(alarmAge, ALARM_MS))
    if (s.running === 0) waits.push(stepIn(now - s.usedAt, GLOW_MS))
  }
  if (!g.isTiny) {
    const stops = routeOf(entries, LEGS + 1)
    for (let k = 1; k < stops.length; k++) {
      const age = now - stops[k]!.at
      if (age < 0) waits.push(-age)
      else if (k === stops.length - 1 && age < REVEAL_MS) waits.push(flying)
      else if (age < TRAIL_HOLD_MS) waits.push(TRAIL_HOLD_MS - age)
      else waits.push(stepIn(age - TRAIL_HOLD_MS, TRAIL_FADE_MS))
    }
  }
  const switchAge = finite(board.switchedAt) ? now - board.switchedAt : Infinity
  if (switchAge >= 0 && switchAge < SWITCH_MS) waits.push(flying)
  if (memory.context !== undefined && now - memory.context.at < DRAIN_MS && memory.context.from !== memory.context.target) waits.push(flying)

  if (endless !== undefined && !g.isTiny) {
    const crew = Math.min(CREW_MAX, Array.isArray(board.agents) ? board.agents.length : 0)
    const isBusy = entries.some(e => e.status === 'run' && e.task === undefined) || crew > 0
    const forever: number[] = [breathIn(now, isBusy ? BREATH_BUSY_MS : BREATH_MS)]
    // A bead on the crew's circle moves a dot about every eighth of a second.
    if (crew > 0) forever.push(CREW_LAP_MS / (2 * Math.PI * g.shape.crewR * 2))
    stations.forEach((s, i) => {
      if (s.running === 0) return
      const elapsed = Math.max(0, now - s.since)
      const period = s.onlyTasks ? TASK_BEAT_MS : BEAT_MS
      const p = elapsed % period
      forever.push(p < BEAT_UP_MS ? FASTEST_MS : (stepIn(p - BEAT_UP_MS, BEAT_DOWN_MS) ?? period - p))
      const minute = g.minuteHands[i]!.length
      if (minute > 0) forever.push(((Math.floor(((elapsed % 60000) / 60000) * minute) + 1) / minute) * 60000 - (elapsed % 60000))
      const ten = g.tenHands[i]!.length
      if (ten > 0 && elapsed < 600000) forever.push(((Math.floor((elapsed / 600000) * ten) + 1) / ten) * 600000 - elapsed)
    })
    for (const w of forever) waits.push(Math.max(endless, w))
  }
  return soonest(...waits)
}

export const ring: View<Memory> = {
  memory: () => ({ geometry: undefined, base: undefined, paint: undefined, labels: undefined, context: undefined, work: undefined }),
  draw,
  nextFrameIn,
}
