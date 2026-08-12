import { anchorAfter, anchorBefore, resolveAnchor } from '../pieceTable/anchors'
import type { Anchor, PieceTableSnapshot } from '../pieceTable/pieceTableTypes'

export type SnippetStopRange = {
  readonly start: number
  readonly end: number
}

type TrackedStop = {
  readonly startAnchor: Anchor
  readonly endAnchor: Anchor
}

/**
 * The tab stops of the snippet currently being filled in.
 *
 * Stops are anchors, so typing inside one carries the later stops along. Validity is keyed on
 * snapshot object identity, exactly as the auto-close store is: undo, redo, a programmatic edit, or
 * an edit from another view all produce a snapshot this session was never advanced onto, and it
 * goes quiet rather than moving the caret somewhere stale.
 */
export class SnippetSession {
  private validForSnapshot: PieceTableSnapshot | null = null
  private stops: TrackedStop[] = []
  private cursor = 0

  start(snapshot: PieceTableSnapshot, ranges: readonly SnippetStopRange[]): void {
    if (ranges.length <= 1) {
      // A single stop is where the caret already is; there is nothing to cycle through.
      this.clear()
      return
    }

    this.validForSnapshot = snapshot
    this.stops = ranges.map((range) => ({
      endAnchor: anchorBefore(snapshot, range.end),
      startAnchor: anchorAfter(snapshot, range.start),
    }))
    this.cursor = 0
  }

  get active(): boolean {
    return this.stops.length > 0
  }

  /** Advances to the next or previous stop and returns its range, or null when there is none. */
  move(snapshot: PieceTableSnapshot, direction: 1 | -1): SnippetStopRange | null {
    if (this.validForSnapshot !== snapshot) {
      this.clear()
      return null
    }

    const next = this.cursor + direction
    if (next < 0 || next >= this.stops.length) {
      // Walking off either end ends the session, so the next Tab indents as usual.
      this.clear()
      return null
    }

    this.cursor = next
    const range = this.rangeAt(snapshot, next)
    if (!range) {
      this.clear()
      return null
    }

    return range
  }

  /** Keeps the session alive across an edit this editor itself produced. */
  advance(snapshot: PieceTableSnapshot): void {
    if (this.validForSnapshot === null) return

    this.validForSnapshot = snapshot
  }

  clear(): void {
    this.validForSnapshot = null
    this.stops = []
    this.cursor = 0
  }

  private rangeAt(snapshot: PieceTableSnapshot, index: number): SnippetStopRange | null {
    const stop = this.stops[index]
    if (!stop) return null

    const start = resolveAnchor(snapshot, stop.startAnchor)
    const end = resolveAnchor(snapshot, stop.endAnchor)
    if (start.liveness !== 'live' || end.liveness !== 'live') return null
    if (end.offset < start.offset) return null

    return { end: end.offset, start: start.offset }
  }
}
