import type { TextOffsetRange } from '../textRanges'
import { clamp } from '../style-utils'
import type { TextEdit } from '../tokens'
import { nowMs } from './timing'

/**
 * What each end of a drag snaps to. `column` is the odd one out: it follows the pointer the same
 * way, but the selection it leaves behind is a rectangle rather than a range.
 */
export type MouseSelectionGranularity = 'char' | 'word' | 'line' | 'column'

export type MouseSelectionDrag = {
  // The drag pivots on whichever end of the anchored word or line the pointer is away from, so the
  // unit the press landed on stays whole however far the pointer travels in either direction.
  readonly anchor: TextOffsetRange
  readonly granularity: MouseSelectionGranularity
  headOffset: number
  clientX: number
  clientY: number
}

export type MouseSelectionEnds = {
  readonly anchorOffset: number
  readonly headOffset: number
}

/**
 * A head stopping exactly where the anchor begins has still crossed it — the pointer is on the far
 * side of the anchored word or line — so the ends merely touching is a backwards drag, not an empty
 * one.
 */
export function mouseSelectionEnds(
  anchor: TextOffsetRange,
  head: TextOffsetRange,
): MouseSelectionEnds {
  if (head.end <= anchor.start) return { anchorOffset: anchor.end, headOffset: head.start }
  return { anchorOffset: anchor.start, headOffset: head.end }
}

/**
 * A press that landed inside the selection, which may yet carry that text elsewhere. Nothing is
 * committed while it is held, because the same press is still the click that places the caret if it
 * turns out never to travel.
 */
export type MouseTextMoveDrag = {
  readonly source: TextOffsetRange
  readonly pressOffset: number
  // Null whenever the pointer is back over the run being carried, where there is nowhere to put it:
  // a release there has to leave the document alone rather than fall back on some earlier spot the
  // user has since moved away from.
  dropOffset: number | null
  moved: boolean
}

export type MouseTextMove = {
  readonly edits: readonly TextEdit[]
  readonly selection: TextOffsetRange
}

/**
 * Where dropped text ends up.
 *
 * A move is one delete and one insert measured against the same document, so text travelling right
 * arrives at an offset its own removal then pulls back — by exactly its own length. Landing on
 * either edge of the source leaves the document as it was, which is worth an edit only when the
 * original is being left behind.
 */
export function mouseTextMove(
  source: TextOffsetRange,
  text: string,
  dropOffset: number,
  copy: boolean,
): MouseTextMove | null {
  if (dropOffset > source.start && dropOffset < source.end) return null
  if (copy) {
    return {
      edits: [{ from: dropOffset, text, to: dropOffset }],
      selection: { start: dropOffset, end: dropOffset + text.length },
    }
  }

  if (dropOffset === source.start || dropOffset === source.end) return null

  const start = dropOffset < source.start ? dropOffset : dropOffset - text.length
  return {
    edits: [
      { from: source.start, text: '', to: source.end },
      { from: dropOffset, text, to: dropOffset },
    ],
    selection: { start, end: start + text.length },
  }
}

const MOUSE_SELECTION_SCROLL_ZONE_PX = 40
const MOUSE_SELECTION_MAX_SCROLL_PX = 24
const MOUSE_SELECTION_MIN_SCROLL_PX = 2

export function mouseSelectionAutoScrollDelta(clientY: number, rect: DOMRect): number {
  if (rect.height <= 0) return 0
  if (clientY < rect.top + MOUSE_SELECTION_SCROLL_ZONE_PX) {
    return -mouseSelectionScrollStep(rect.top + MOUSE_SELECTION_SCROLL_ZONE_PX - clientY)
  }
  if (clientY > rect.bottom - MOUSE_SELECTION_SCROLL_ZONE_PX) {
    return mouseSelectionScrollStep(clientY - (rect.bottom - MOUSE_SELECTION_SCROLL_ZONE_PX))
  }

  return 0
}

export function requestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
  return setTimeout(() => callback(nowMs()), 0) as unknown as number
}

export function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle)
    return
  }

  clearTimeout(handle)
}

function mouseSelectionScrollStep(distance: number): number {
  const ratio = distance / MOUSE_SELECTION_SCROLL_ZONE_PX
  const scaled = Math.ceil(ratio * MOUSE_SELECTION_MAX_SCROLL_PX)
  return clamp(scaled, MOUSE_SELECTION_MIN_SCROLL_PX, MOUSE_SELECTION_MAX_SCROLL_PX)
}
