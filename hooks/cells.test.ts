import { expect, test } from 'claude-code/testing'

import { Braille, Cells, DEFAULT, cut, fade, glyphsOf, groundFor, inkFor, isWidth1, mix, rgb, soonest } from './cells'
import { setupFrom } from './map'
import { FASTEST_MS, fromBase64 } from './raster'

test('cells hold one narrow character each, cut with an ellipsis, packed as a Raster takes them', () => {
  for (const ch of 'aЖ━┿╍▖▐⠿●○◆✕✓⊘↯Ψ∴≡⊕⊟⌡▣◷…') expect(isWidth1(ch.codePointAt(0)!)).toBe(true)
  for (const ch of ['中', '⚡', '❌', '✅', '⬛', '\u0301', '\u200b', '\t', '😀', '☰']) expect(isWidth1(ch.codePointAt(0)!)).toBe(false)
  expect(glyphsOf('e\u0301中').map(cp => String.fromCodePoint(cp)).join('')).toBe('e?')
  expect(cut('content.py', 6)).toBe('conte…')
  expect(cut('a/b/content.py', 8, 'end')).toBe('…tent.py')

  const cells = new Cells(4, 2)
  expect(cells.text(1, 0, 'hello', 0xff8800)).toBe(3)
  cells.set(0, 1, '中')
  cells.tint(3, 1, 0x112233)
  expect(cells.lines()).toEqual([' he…', '?   '])
  const words = new Uint32Array(fromBase64(cells.toBase64()).buffer)
  expect(words.length).toBe(4 * 2 * 3)
  expect([...words.slice(3, 6)]).toEqual(['h'.codePointAt(0), 0xff8800, DEFAULT])
  expect(words[(1 * 4 + 3) * 3 + 2]).toBe(0x112233)
})

test('braille dots land on the right bits, come out round on tall cells, and add up', () => {
  const dots = new Braille(2, 1, 2)
  dots.dotAt(0, 0)
  dots.dotAt(3, 3)
  expect([dots.at(0, 0), dots.at(1, 0)]).toEqual([0x01, 0x80])
  const cells = new Cells(2, 1)
  dots.drawInto(cells, 0xffffff)
  const more = new Braille(2, 1, 2)
  more.dotAt(1, 0)
  more.drawInto(cells, 0xffffff)
  expect(cells.lines()).toEqual(['⠉⢀'])
  // A circle on cells twice as tall as wide: a dot is half a column wide and half a column tall, so as many dots each way.
  const round = new Braille(12, 6, 2)
  round.circle(6, 6, 4)
  const BITS = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]]
  const lit: [number, number][] = []
  for (let dy = 0; dy < 24; dy++) for (let dx = 0; dx < 24; dx++) if (round.at(dx >> 1, dy >> 2) & BITS[dx & 1]![dy & 3]!) lit.push([dx, dy])
  const across = Math.max(...lit.map(p => p[0])) - Math.min(...lit.map(p => p[0]))
  const down = Math.max(...lit.map(p => p[1])) - Math.min(...lit.map(p => p[1]))
  expect(Math.abs(across - down)).toBeLessThanOrEqual(1)
})

test('colours mix in steps, and the terminal\'s own stays itself', () => {
  expect(rgb('#ff8800')).toBe(0xff8800)
  expect(rgb('#f80')).toBe(0xff8800)
  expect(rgb('nope')).toBe(DEFAULT)
  expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080)
  expect(mix(DEFAULT, 0xffffff, 0.2)).toBe(DEFAULT)
  expect(fade(0x000000, 0xff0000, 0.49, 4)).toBe(0x800000)
  expect(inkFor(setupFrom({ theme: 'light' })).accent).toBe(0xb8762a)
  expect(inkFor(setupFrom({ colors: ['accent=#123456'] })).accent).toBe(0x123456)
  expect(groundFor(setupFrom({ background: 'transparent' }))).toBe(DEFAULT)
  expect(soonest(undefined, 500, 10)).toBe(FASTEST_MS)
  expect(soonest(undefined)).toBeUndefined()
})
