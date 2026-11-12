// The map in characters, for the terminal views: a box of cells, each a glyph, a foreground and a background,
// packed as a Raster takes them; braille dots for lines finer than a cell; colours as numbers; and what a view is.
// Nothing here touches the engine.
import type { Board } from '../types'
import { DARK, LIGHT } from './map'
import type { Palette, Setup } from './map'
import { FASTEST_MS, toBase64 } from './raster'

// ---- what a view is ----------------------------------------------------------------------------

export type ViewSize = { columns: number; rows: number }

/**
 * A way of drawing the map in a terminal's cells. `register` keeps one `memory` for the life of the mod,
 * draws the view whenever the board changes, and between drawings asks `nextFrameIn` when to draw it again.
 */
export type View<M = unknown> = {
  /** What the view keeps between frames (ledgers, eases, the last scale), made afresh when the mod loads. */
  memory(): M
  /** The map at `now`, `size` cells big. Pure but for `memory`, which it may bring up to date. Must not throw. */
  draw(board: Board, now: number, size: ViewSize, setup: Setup, memory: M): Cells
  /**
   * Ms from `now` until the view next looks different, or undefined when it never will without a new board.
   * Animations that never end (a breath, a beat, a running call's hands) count only when `endless` is given,
   * and then no more often than every `endless` ms: see `endlessEvery` in raster.ts. Never less than FASTEST_MS.
   */
  nextFrameIn(board: Board, now: number, size: ViewSize, setup: Setup, memory: M, endless: number | undefined): number | undefined
  /** The view shows the counts itself, so the tally row under it is left out. */
  hidesTally?: boolean
}

/** The soonest of some waits, as `nextFrameIn` gives it: undefined for none, and never sooner than FASTEST_MS. */
export function soonest(...waits: (number | undefined)[]): number | undefined {
  let best = Infinity
  for (const w of waits) if (w !== undefined && w < best) best = w
  return best === Infinity ? undefined : Math.max(FASTEST_MS, best)
}

// ---- glyphs ------------------------------------------------------------------------------------

/** The terminal's own colour, as a foreground or a background. */
export const DEFAULT = 0x01000000
const SPACE = 0x20
const UNKNOWN = 0x3f // ?

/** Ranges of the BMP drawn one cell wide by every terminal a Raster reaches, low and high inclusive. */
const NARROW: readonly (readonly [number, number])[] = [
  [0x20, 0x7e], // ASCII
  [0xa0, 0xac], [0xae, 0x2ff], // Latin-1, Latin Extended, IPA, spacing modifiers; not the soft hyphen
  [0x370, 0x482], [0x48a, 0x52f], // Greek, Cyrillic; not Cyrillic's combining marks
  [0x531, 0x58a], [0x10a0, 0x10ff], // Armenian, Georgian
  [0x1e00, 0x1fff], // Latin Extended Additional, Greek Extended
  [0x2010, 0x2027], [0x2030, 0x205e], // punctuation; not the spaces, joiners and direction marks
  [0x2070, 0x209f], [0x20a0, 0x20c0], // super- and subscripts, currency
  [0x2100, 0x218b], [0x2190, 0x2319], [0x231c, 0x2328], [0x232b, 0x23e8], [0x23ed, 0x23ef], [0x23f1, 0x23f2], [0x23f4, 0x23ff],
  [0x2400, 0x2426], [0x2440, 0x244a], [0x2460, 0x24ff],
  [0x2500, 0x25fc], [0x25ff, 0x25ff], // box drawing, blocks, geometric shapes; not the two emoji squares
  [0x2600, 0x2613], [0x2616, 0x262f], [0x2638, 0x2647], [0x2654, 0x267e], [0x2680, 0x2689], [0x2690, 0x2692], [0x2694, 0x26a0], [0x26a2, 0x26a9],
  [0x26ac, 0x26bc], [0x26bf, 0x26c3], [0x26c6, 0x26cd], [0x26cf, 0x26d3], [0x26d5, 0x26e9], [0x26eb, 0x26f1],
  [0x26f4, 0x26f4], [0x26f6, 0x26f9], [0x26fb, 0x26fc], [0x26fe, 0x2704], [0x2706, 0x2709], [0x270c, 0x2727],
  [0x2729, 0x274b], [0x274d, 0x274d], [0x274f, 0x2752], [0x2756, 0x2756], [0x2758, 0x2794], [0x2798, 0x27af],
  [0x27b1, 0x27be], [0x27c0, 0x2b1a], [0x2b1d, 0x2b4f], [0x2b51, 0x2b54], [0x2b56, 0x2bff], // symbols and arrows; not the emoji among them
  [0xfffd, 0xfffd],
]

/** Whether a code point is one printable character that takes exactly one cell: what a Raster's cell must hold. */
export function isWidth1(cp: number): boolean {
  let lo = 0
  let hi = NARROW.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [a, b] = NARROW[mid]!
    if (cp < a) hi = mid - 1
    else if (cp > b) lo = mid + 1
    else return true
  }
  return false
}

/** The code points of a text as cells take them: one per cell, `?` for anything wider, joining or unprintable. */
export function glyphsOf(text: string): number[] {
  const out: number[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? UNKNOWN
    // Marks that join the character before them, and the variation selectors, take no cell of their own.
    if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d) continue
    out.push(isWidth1(cp) ? cp : UNKNOWN)
  }
  return out
}

/** A text cut to at most `max` cells with `…` where it was cut: at its end, or at its start for a path, whose end says most. */
export function cut(text: string, max: number, keep: 'start' | 'end' = 'start'): string {
  const glyphs = glyphsOf(text)
  if (glyphs.length <= max) return String.fromCodePoint(...glyphs)
  if (max <= 0) return ''
  if (max === 1) return '…'
  return keep === 'start' ? `${String.fromCodePoint(...glyphs.slice(0, max - 1))}…` : `…${String.fromCodePoint(...glyphs.slice(glyphs.length - max + 1))}`
}

// ---- cells -------------------------------------------------------------------------------------

/** A box of cells, row by row, each three words: the glyph, the foreground, the background. */
export class Cells {
  readonly columns: number
  readonly rows: number
  /** Every cell's background to begin with: the terminal's own, or the person's own background colour. */
  readonly ground: number
  readonly words: Uint32Array

  constructor(columns: number, rows: number, ground: number = DEFAULT) {
    this.columns = columns
    this.rows = rows
    this.ground = ground
    this.words = new Uint32Array(Math.max(0, columns * rows * 3))
    this.clear()
  }

  clear(): void {
    for (let i = 0; i < this.words.length; i += 3) {
      this.words[i] = SPACE
      this.words[i + 1] = DEFAULT
      this.words[i + 2] = this.ground
    }
  }

  has(x: number, y: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.columns && y < this.rows
  }

  /** One cell. Outside the box it does nothing; a glyph wider than a cell becomes `?`; without `bg` the cell keeps its background. */
  set(x: number, y: number, ch: string | number, fg: number = DEFAULT, bg?: number): void {
    if (!this.has(x, y)) return
    const i = (y * this.columns + x) * 3
    const cp = typeof ch === 'number' ? ch : (ch.codePointAt(0) ?? SPACE)
    this.words[i] = isWidth1(cp) ? cp : UNKNOWN
    this.words[i + 1] = fg
    if (bg !== undefined) this.words[i + 2] = bg
  }

  /** Only the background of a cell: a tint under whatever it holds. */
  tint(x: number, y: number, bg: number): void {
    if (this.has(x, y)) this.words[(y * this.columns + x) * 3 + 2] = bg
  }

  /** Only the foreground of a cell. */
  ink(x: number, y: number, fg: number): void {
    if (this.has(x, y)) this.words[(y * this.columns + x) * 3 + 1] = fg
  }

  glyph(x: number, y: number): number {
    return this.has(x, y) ? this.words[(y * this.columns + x) * 3]! : SPACE
  }

  fg(x: number, y: number): number {
    return this.has(x, y) ? this.words[(y * this.columns + x) * 3 + 1]! : DEFAULT
  }

  bg(x: number, y: number): number {
    return this.has(x, y) ? this.words[(y * this.columns + x) * 3 + 2]! : this.ground
  }

  /**
   * A text from (x, y) rightwards, one character a cell, cut with `…` to `max` cells and to the box.
   * Returns how many cells it took.
   */
  text(x: number, y: number, text: string, fg: number = DEFAULT, bg?: number, max = this.columns - x, keep: 'start' | 'end' = 'start'): number {
    const room = Math.min(max, this.columns - x)
    if (room <= 0 || !this.has(Math.max(0, x), y)) return 0
    const glyphs = glyphsOf(cut(text, room, keep))
    glyphs.forEach((cp, k) => this.set(x + k, y, cp, fg, bg))
    return glyphs.length
  }

  /** A rectangle of one glyph; a space with `bg` paints a block of colour. */
  fill(x: number, y: number, width: number, height: number, ch: string | number, fg: number = DEFAULT, bg?: number): void {
    for (let j = y; j < y + height; j++) for (let i = x; i < x + width; i++) this.set(i, j, ch, fg, bg)
  }

  /** The rows as text, for tests and for looking at a view in a console. */
  lines(): string[] {
    const out: string[] = []
    for (let y = 0; y < this.rows; y++) {
      const row: number[] = []
      for (let x = 0; x < this.columns; x++) row.push(this.words[(y * this.columns + x) * 3]!)
      out.push(String.fromCodePoint(...row))
    }
    return out
  }

  /** As a Raster's `cells` and a blit's: standard padded base64 of the words, little-endian. */
  toBase64(): string {
    return toBase64(new Uint8Array(this.words.buffer, this.words.byteOffset, this.words.byteLength))
  }
}

// ---- braille: lines finer than a cell ----------------------------------------------------------

/** The bit of each dot of a braille cell, by its column (0 left, 1 right) and its row (0 to 3, top down). */
const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const
const BRAILLE = 0x2800

/**
 * Two dots across and four down in each cell. Points are in column widths, across and down alike, so that a circle
 * comes out round: a row is `cellShape` column widths tall. Angles are in radians, clockwise from twelve o'clock.
 */
export class Braille {
  /** The dots of each cell, as a braille pattern's bits. */
  readonly bits: Uint8Array
  readonly columns: number
  readonly rows: number
  readonly cellShape: number
  readonly dotsAcross: number
  readonly dotsDown: number

  constructor(columns: number, rows: number, cellShape: number) {
    this.columns = columns
    this.rows = rows
    this.cellShape = cellShape
    this.bits = new Uint8Array(Math.max(0, columns * rows))
    this.dotsAcross = columns * 2
    this.dotsDown = rows * 4
  }

  clear(): void {
    this.bits.fill(0)
  }

  /** One dot, by its place on the grid of dots. */
  dotAt(dx: number, dy: number): void {
    if (dx < 0 || dy < 0 || dx >= this.dotsAcross || dy >= this.dotsDown) return
    const cx = dx >> 1
    const cy = dy >> 2
    this.bits[cy * this.columns + cx]! |= DOT_BITS[dx & 1]![dy & 3]!
  }

  /** The dot under a point. */
  dot(x: number, y: number): void {
    this.dotAt(Math.floor(x * 2), Math.floor((y / this.cellShape) * 4))
  }

  line(x0: number, y0: number, x1: number, y1: number): void {
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0) * 2, (Math.abs(y1 - y0) / this.cellShape) * 4)) + 1
    for (let k = 0; k <= steps; k++) {
      const f = k / steps
      this.dot(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f)
    }
  }

  /** An arc of radius `r` from angle `from` to angle `to`, clockwise. */
  arc(cx: number, cy: number, r: number, from: number, to: number): void {
    const dotsPerUnit = Math.max(2, 4 / this.cellShape)
    const steps = Math.max(1, Math.ceil(Math.abs(to - from) * r * dotsPerUnit * 1.5))
    for (let k = 0; k <= steps; k++) {
      const a = from + ((to - from) * k) / steps
      this.dot(cx + r * Math.sin(a), cy - r * Math.cos(a))
    }
  }

  circle(cx: number, cy: number, r: number): void {
    this.arc(cx, cy, r, 0, 2 * Math.PI)
  }

  /** Every dot within `r` of the centre. */
  disc(cx: number, cy: number, r: number): void {
    const x0 = Math.max(0, Math.floor((cx - r) * 2))
    const x1 = Math.min(this.dotsAcross - 1, Math.ceil((cx + r) * 2))
    const y0 = Math.max(0, Math.floor(((cy - r) / this.cellShape) * 4))
    const y1 = Math.min(this.dotsDown - 1, Math.ceil(((cy + r) / this.cellShape) * 4))
    for (let dy = y0; dy <= y1; dy++) {
      for (let dx = x0; dx <= x1; dx++) {
        const x = (dx + 0.5) / 2 - cx
        const y = ((dy + 0.5) / 4) * this.cellShape - cy
        if (x * x + y * y <= r * r) this.dotAt(dx, dy)
      }
    }
  }

  /** The dots of one cell, as a braille pattern's bits. */
  at(x: number, y: number): number {
    return x >= 0 && y >= 0 && x < this.columns && y < this.rows ? this.bits[y * this.columns + x]! : 0
  }

  /**
   * Every cell with a dot, written into `cells` in `fg` (and `bg`, if given). A cell that already holds braille
   * keeps its dots too, so layers of dots add up; any other glyph there is replaced.
   */
  drawInto(cells: Cells, fg: number, bg?: number): void {
    for (let y = 0; y < Math.min(this.rows, cells.rows); y++) {
      for (let x = 0; x < Math.min(this.columns, cells.columns); x++) {
        const bits = this.bits[y * this.columns + x]!
        if (bits === 0) continue
        const there = cells.glyph(x, y)
        const before = there >= BRAILLE && there <= BRAILLE + 0xff ? there - BRAILLE : 0
        cells.set(x, y, BRAILLE | before | bits, fg, bg)
      }
    }
  }
}

// ---- colours -----------------------------------------------------------------------------------

/** `#rrggbb` or `#rgb` as 0xRRGGBB; anything else is the terminal's own colour. */
export function rgb(hex: string): number {
  const m = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i.exec(hex)
  if (m === null) return DEFAULT
  const h = m[2] ?? [...m[1]!].map(c => c + c).join('')
  return Number.parseInt(h, 16)
}

const clamp01 = (t: number): number => (t <= 0 || Number.isNaN(t) ? 0 : t >= 1 ? 1 : t)

/** `t` of the way from colour `a` to colour `b`. The terminal's own colour has no value to mix: it stays itself until `t` passes a half. */
export function mix(a: number, b: number, t: number): number {
  const f = clamp01(t)
  if (a === DEFAULT || b === DEFAULT) return f < 0.5 ? a : b
  const ch = (shift: number): number => Math.round(((a >> shift) & 0xff) * (1 - f) + ((b >> shift) & 0xff) * f) << shift
  return ch(16) | ch(8) | ch(0)
}

/**
 * `t` rounded to one of `steps` steps. A Raster shows 1024 pairs of colours at once and the rest as their nearest,
 * so a fade goes in steps: sixteen look smooth and leave room for everything else on the map.
 */
export const quantize = (t: number, steps = 16): number => Math.round(clamp01(t) * steps) / steps

/** `mix` in steps: what a fade or a tint should use. */
export const fade = (a: number, b: number, t: number, steps = 16): number => mix(a, b, quantize(t, steps))

/** The palette as numbers. */
export type Ink = { [K in keyof Palette]: number }

/** The map's colours for this setup as numbers, with the person's own over the theme's. Give it the setup `draw` was given. */
export function inkFor(setup: Setup): Ink {
  const palette = { ...(setup.theme === 'light' ? LIGHT : DARK), ...setup.colors }
  return Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, rgb(v)])) as Ink
}

/**
 * The background of a cell with nothing on it: the terminal's own, unless the person gave the map a ground of its own.
 * Tints mix towards a colour from `ink.ground`, which on the terminal's own background is near enough to it.
 */
export function groundFor(setup: Setup): number {
  return setup.background === 'transparent' ? DEFAULT : inkFor(setup).ground
}
