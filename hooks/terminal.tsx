// The map above the rows in a terminal: a picture painted here, where the terminal shows pictures, or one of the
// views drawn in characters, in any terminal. Each keeps itself moving between drawings with a loop of frames.
import type { EngineInterface, RenderElement, RenderInputOf } from 'claude-code'

import type { Board } from '../types'
import type { View, ViewSize } from './cells'
import { describeNow, drawMap } from './map'
import type { Setup } from './map'
import { endlessEvery, imageSource, nextChangeIn, paint, parseMap, scaleFor } from './raster'
import type { Scene } from './raster'
import { city } from './view-city'
import { lanes } from './view-lanes'
import { ring } from './view-ring'
import { tiles } from './view-tiles'

const MAP_KEY = 'map'
/** Pixels per unit of the drawing: about what a docked pane shows on a sharp screen. The Image's size limit may take it lower. */
const SCALE = 1.5
/** Narrower than this the map cannot be read, and the pane stays text. */
const MAP_MIN_COLUMNS = 24
const MAP_MAX_COLUMNS = 72
/** Rows left under the map for the current action and the first rows of the feed. */
const FEED_ROWS = 6
/** How soon after the first picture the loop tries a frame, to learn whether this terminal shows pictures at all. */
const PROBE_MS = 100

const VIEWS: Record<Exclude<Setup['terminalView'], 'picture'>, View<unknown>> = { ring, lanes, tiles, city }
/** Smaller than this a view drawn in characters cannot be read, and the pane stays text. */
const CELLS_MIN_COLUMNS = 40
const CELLS_MIN_ROWS = 16
const CELLS_MAX_ROWS = 30

/** What a terminal shows above the rows, and whether it says what the tally row would. */
type Above = { map: RenderElement | undefined; hidesTally: boolean }

/** Whatever goes wrong on the map must never reach the tool, the turn or the conversation. */
async function quietly<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

/** Only while something runs do endless animations count. */
const isBusy = (board: Board): boolean => board.entries.some(x => x.status === 'run') || (board.agents ?? []).length > 0

/** The map on show in a terminal, and the loop that keeps it moving between drawings. */
type Picture = {
  kind: 'picture'
  setup: Setup
  /** The drawing on show, the pane it is on, when it was made, and whether anything runs. */
  shown: { scene: Scene; pane: string; drawnAt: number; isBusy: boolean } | undefined
  timer: { cancel: () => void } | undefined
  /** A frame has gone through, so this terminal is known to show pictures. */
  showsPictures: boolean
  /** The terminal drew the picture's words instead of the picture: it shows none, and the pane goes back to text. */
  noPictures: boolean
}

/** A view drawn in characters on show in a terminal, and the loop that draws it again between boards. */
type Grid = {
  kind: 'grid'
  view: View<unknown>
  /** The view's own, kept for the life of the mod. */
  memory: unknown
  setup: Setup
  /** The board on show, the pane it is on, how big, when it was drawn, and whether anything runs. */
  shown: { board: Board; pane: string; size: ViewSize; drawnAt: number; isBusy: boolean } | undefined
  timer: { cancel: () => void } | undefined
}

type Loop = { timer: { cancel: () => void } | undefined }

function after($: EngineInterface, loop: Loop, delay: number | undefined, run: () => void): void {
  loop.timer?.cancel()
  loop.timer = undefined
  if (delay === undefined) return
  try {
    loop.timer = $.clock.after(delay, run)
  } catch {
    loop.timer = undefined
  }
}

function schedule($: EngineInterface, picture: Picture, delay: number | undefined): void {
  after($, picture, delay, () => void tick($, picture))
}

function scheduleGrid($: EngineInterface, grid: Grid, delay: number | undefined): void {
  after($, grid, delay, () => void tickGrid($, grid))
}

/** The map in a terminal and the loop that keeps it moving: the picture, or the view in characters the person chose. */
export type TerminalMap = Picture | Grid

/** The terminal's map for this setup. A reload starts the loop afresh: the engine cancels the old one's timer with the old environment. */
export function terminalMap(setup: Setup): TerminalMap {
  // `auto` has nothing to go by in a terminal, so the map is dark. It lies on the terminal's own background,
  // as the pane does, unless the person gave it a background colour of their own.
  const terminalSetup: Setup = {
    ...setup,
    theme: setup.theme === 'auto' ? 'dark' : setup.theme,
    background: setup.colors.ground === undefined ? 'transparent' : setup.background,
  }
  if (setup.terminalView === 'picture') return { kind: 'picture', setup: terminalSetup, shown: undefined, timer: undefined, showsPictures: false, noPictures: false }
  const view = VIEWS[setup.terminalView]
  return { kind: 'grid', view, memory: view.memory(), setup: terminalSetup, shown: undefined, timer: undefined }
}

/** What the terminal shows above the rows for this board, drawn now; its loop then keeps it moving. */
export async function drawTerminal($: EngineInterface, e: RenderInputOf<'Pane', 'terminal'>, board: Board, now: number, terminal: TerminalMap): Promise<Above> {
  return terminal.kind === 'picture' ? drawPicture($, e, board, now, terminal) : drawGrid($, e, board, now, terminal)
}

async function drawPicture($: EngineInterface, e: RenderInputOf<'Pane', 'terminal'>, board: Board, now: number, picture: Picture): Promise<Above> {
  if (picture.noPictures) return { map: undefined, hidesTally: false }
  const { Image } = $.ui.resolve(e)
  const { setup } = picture
  const map = await quietly(async () => {
    const scene = parseMap(drawMap(board, now, setup))
    // Rows per column that keep the map's shape. iTerm2 keeps the picture's own shape in a box that is off, leaving the rest of it empty; kitty and Ghostty stretch it.
    const perColumn = scene.height / scene.width / setup.cellShape
    const room = e.props.scroll.bodyRows - FEED_ROWS
    const columns = Math.min(e.props.bodyColumns, MAP_MAX_COLUMNS, room > 0 ? Math.floor(room / perColumn) : MAP_MAX_COLUMNS)
    if (columns < MAP_MIN_COLUMNS) {
      picture.shown = undefined
      return undefined
    }
    const busy = isBusy(board)
    picture.shown = { scene, pane: e.requestId, drawnAt: now, isBusy: busy }
    // This frame goes with the drawing; the loop sends the ones after it, and its first frame tells whether pictures show here at all.
    const next = nextChangeIn(scene, 0, endlessEvery(0, busy))
    schedule($, picture, picture.showsPictures ? next : Math.min(PROBE_MS, next ?? PROBE_MS))
    return (
      <Image
        key={MAP_KEY}
        source={imageSource(paint(scene, 0, scaleFor(scene, SCALE)))}
        columns={columns}
        rows={Math.max(1, Math.round(columns * perColumn))}
        alt={`${setup.t.title}. ${describeNow(board, setup.t)}`}
      />
    )
  })
  return { map, hidesTally: false }
}

/** The next frame of the drawing on show, sent in place of the last; then the one after, when the drawing will look different. */
async function tick($: EngineInterface, picture: Picture): Promise<void> {
  picture.timer = undefined
  const drawing = picture.shown
  if (drawing === undefined) return
  await quietly(async () => {
    const t = (await $.clock.now()) - drawing.drawnAt
    const sent = await $.ui.blit({ requestId: drawing.pane, key: MAP_KEY, source: imageSource(paint(drawing.scene, t, scaleFor(drawing.scene, SCALE))) })
    if (sent.deny !== undefined) {
      // Not on show any more, or the terminal draws the words in its place. The engine says which only in words.
      if (picture.shown === drawing) picture.shown = undefined
      if (!picture.showsPictures && /\balt\b/.test(sent.deny)) {
        picture.noPictures = true
        $.ui.invalidate('ui.render')
      }
      return
    }
    picture.showsPictures = true
    if (picture.shown !== drawing) return
    const next = nextChangeIn(drawing.scene, t, endlessEvery(t, drawing.isBusy))
    // Counted from when this frame began, so that making and sending it does not slow the rate;
    // but never less than a third of the wait, which leaves the mod's other hooks their turn.
    const spent = (await $.clock.now()) - drawing.drawnAt - t
    schedule($, picture, next === undefined ? undefined : Math.round(Math.max(next - spent, next / 3)))
  })
}

async function drawGrid($: EngineInterface, e: RenderInputOf<'Pane', 'terminal'>, board: Board, now: number, grid: Grid): Promise<Above> {
  const { Raster } = $.ui.resolve(e)
  const map = await quietly(async () => {
    const columns = Math.min(e.props.bodyColumns, MAP_MAX_COLUMNS)
    const rows = Math.min(e.props.scroll.bodyRows - FEED_ROWS, CELLS_MAX_ROWS)
    if (columns < CELLS_MIN_COLUMNS || rows < CELLS_MIN_ROWS) {
      grid.shown = undefined
      scheduleGrid($, grid, undefined)
      return undefined
    }
    const size = { columns, rows }
    const busy = isBusy(board)
    const cells = grid.view.draw(board, now, size, grid.setup, grid.memory).toBase64()
    grid.shown = { board, pane: e.requestId, size, drawnAt: now, isBusy: busy }
    scheduleGrid($, grid, grid.view.nextFrameIn(board, now, size, grid.setup, grid.memory, endlessEvery(0, busy)))
    return <Raster key={MAP_KEY} columns={columns} rows={rows} cells={cells} />
  })
  // A pane too small for the view keeps the tally row.
  return { map, hidesTally: map !== undefined && grid.view.hidesTally === true }
}

/** The view drawn again at this moment, sent in place of the last; then the next time it will look different. */
async function tickGrid($: EngineInterface, grid: Grid): Promise<void> {
  grid.timer = undefined
  const shown = grid.shown
  if (shown === undefined) return
  await quietly(async () => {
    const now = await $.clock.now()
    const cells = grid.view.draw(shown.board, now, shown.size, grid.setup, grid.memory).toBase64()
    const sent = await $.ui.blit({ requestId: shown.pane, key: MAP_KEY, cells })
    if (sent.deny !== undefined) {
      // Not on show any more: the next drawing starts the loop again.
      if (grid.shown === shown) grid.shown = undefined
      return
    }
    if (grid.shown !== shown) return
    const next = grid.view.nextFrameIn(shown.board, now, shown.size, grid.setup, grid.memory, endlessEvery(now - shown.drawnAt, shown.isBusy))
    // As for the picture: counted from when this frame began, but never less than a third of the wait.
    const spent = (await $.clock.now()) - now
    scheduleGrid($, grid, next === undefined ? undefined : Math.round(Math.max(next - spent, next / 3)))
  })
}
