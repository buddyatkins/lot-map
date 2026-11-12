// Makes hooks/font.ts, the letters of the terminal picture, from the X.Org misc-fixed BDF fonts (public domain).
// usage: node scripts/font.mjs hooks/font.ts 6x13.bdf 7x14.bdf 9x18.bdf 10x20.bdf --bold 7x14B.bdf
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const args = process.argv.slice(2)
const out = args.shift()
const boldAt = args.indexOf('--bold')
const regular = boldAt < 0 ? args : args.slice(0, boldAt)
const bold = boldAt < 0 ? [] : args.slice(boldAt + 1)

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
const WANTED = [
  ...range(0x20, 0x7e),
  ...range(0xa0, 0xff),
  ...range(0x100, 0x17f),
  ...range(0x400, 0x45f),
  0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20ac,
  0x2190, 0x2191, 0x2192, 0x2193, 0x25c6,
]

function parse(path) {
  const text = readFileSync(path, 'latin1')
  const num = key => Number(new RegExp(`^${key} (-?\\d+)`, 'm').exec(text)?.[1])
  const [bw, bh, bx, by] = /^FONTBOUNDINGBOX (-?\d+) (-?\d+) (-?\d+) (-?\d+)/m.exec(text).slice(1).map(Number)
  const ascent = num('FONT_ASCENT')
  const descent = num('FONT_DESCENT')
  if (bx !== 0 || bh !== ascent + descent) throw new Error(`${path}: unexpected bounding box`)
  const glyphs = new Map()
  for (const block of text.split('STARTCHAR').slice(1)) {
    const code = Number(/ENCODING (-?\d+)/.exec(block)?.[1])
    if (!WANTED.includes(code)) continue
    const dwidth = Number(/DWIDTH (\d+)/.exec(block)?.[1])
    if (dwidth !== bw) continue // not a single-width cell glyph
    const [w, h, xo, yo] = /BBX (-?\d+) (-?\d+) (-?\d+) (-?\d+)/.exec(block).slice(1).map(Number)
    const rows = block.split('BITMAP')[1].split('ENDCHAR')[0].trim().split(/\s+/).filter(Boolean)
    const cell = Array.from({ length: bh }, () => new Array(bw).fill(0))
    rows.forEach((hex, r) => {
      const bits = BigInt(`0x${hex}`)
      const width = hex.length * 4
      for (let c = 0; c < w; c++) {
        if ((bits >> BigInt(width - 1 - c)) & 1n) {
          const y = ascent - yo - h + r
          const x = xo + c
          if (y >= 0 && y < bh && x >= 0 && x < bw) cell[y][x] = 1
        }
      }
    })
    glyphs.set(code, cell)
  }
  return { name: basename(path, '.bdf'), width: bw, height: bh, ascent, glyphs }
}

function pack(font) {
  const perRow = Math.ceil(font.width / 8)
  const codes = WANTED.filter(c => font.glyphs.has(c))
  const missing = WANTED.filter(c => !font.glyphs.has(c))
  const bytes = []
  for (const code of codes) {
    for (const row of font.glyphs.get(code)) {
      for (let b = 0; b < perRow; b++) {
        let v = 0
        for (let k = 0; k < 8; k++) v = (v << 1) | (row[b * 8 + k] ?? 0)
        bytes.push(v)
      }
    }
  }
  if (missing.length > 0) console.error(`${font.name}: missing ${missing.map(c => c.toString(16)).join(' ')}`)
  return {
    width: font.width,
    height: font.height,
    ascent: font.ascent,
    chars: String.fromCodePoint(...codes),
    bits: Buffer.from(bytes).toString('base64'),
  }
}

const literal = f =>
  `  { width: ${f.width}, height: ${f.height}, ascent: ${f.ascent}, chars: ${JSON.stringify(f.chars)},\n    bits: '${f.bits}' }`

const fonts = regular.map(p => pack(parse(p)))
const bolds = bold.map(p => pack(parse(p)))
writeFileSync(
  out,
  `// Generated from the X.Org misc-fixed bitmap fonts (${[...regular, ...bold].map(p => basename(p, '.bdf')).join(', ')}),
// Markus Kuhn's ucs-fonts: "Public domain font. Share and enjoy."
// Each glyph is \`height\` rows of ceil(width / 8) bytes, the leftmost pixel in the highest bit, in the order of \`chars\`.
// Made by scripts/font.mjs; do not edit by hand.

export type BitmapFont = { width: number; height: number; ascent: number; chars: string; bits: string }

/** Regular weight, smallest first. */
export const FONTS: readonly BitmapFont[] = [
${fonts.map(literal).join(',\n')},
]

/** Bold, for the figures that the drawing sets in bold. */
export const BOLD: readonly BitmapFont[] = [
${bolds.map(literal).join(',\n')},
]
`,
)
console.error(`wrote ${out}: ${fonts.map(f => `${f.width}x${f.height} ${[...f.chars].length}`).join(', ')}; bold ${bolds.map(f => `${f.width}x${f.height}`).join(', ')}`)
