import type { VirtualizedFoldMarker } from './virtualizedTextViewTypes'

/** Row lookups keep viewport painting independent of the document's fold count. */
export type FoldMarkerSource = {
  readonly size: number
  get(row: number): VirtualizedFoldMarker | undefined
  all(): readonly VirtualizedFoldMarker[]
}
