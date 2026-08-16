import type { PieceTableEdit, PieceTableTreeSnapshot } from './pieceTableTypes'
import type { SplitContext } from './internalTypes'
import {
  appendChunksToBuffers,
  BUFFER_CHUNK_SIZE,
  countLineBreaks,
  extendTailChunk,
  getBufferText,
  isNewestChunk,
} from './buffers'
import { assignPieceOrders } from './orders'
import { applyReverseIndexChanges } from './reverseIndex'
import { ensureValidRange, isHighSurrogate, isLowSurrogate, splitsSurrogatePair } from './reads'
import { createSnapshotWithIndex } from './snapshot'
import {
  createTreeFromPieces,
  getSubtreeMaxOrder,
  getSubtreeMinOrder,
  findVisiblePieceEndingAt,
  markTreeInvisible,
  merge,
  replacePieceEndingAt,
  splitByVisibleOffset,
} from './tree'

const compareEditsDescending = (left: PieceTableEdit, right: PieceTableEdit): number => {
  if (left.from !== right.from) return right.from - left.from
  return right.to - left.to
}

type BatchBoundaries = {
  readonly starts: ReadonlyMap<number, number>
  readonly ends: ReadonlyMap<number, number>
}

// Counted rather than a set membership test, because an edit is not allowed to
// cover itself: a collapsed edit both starts and ends at its own offset.
const coveredByAnother = (
  boundaries: ReadonlyMap<number, number>,
  offset: number,
  self: boolean,
): boolean => (boundaries.get(offset) ?? 0) - (self ? 1 : 0) > 0

// An edit only corrupts the buffer when it leaves half a surrogate pair behind,
// and it only does that when the replacement text does not put the missing half
// back. Checking the range alone would also widen edits that are already whole:
// syncTextEdit (editor/textEdits.ts) diffs by code unit, so swapping one emoji
// for another arrives as a replacement of a low surrogate by another low
// surrogate — perfectly safe, and expanding it would delete the character the
// caller was building. So the test is on the text this edit leaves behind, not
// on where its endpoints happen to fall.
const orphansSurrogateAtStart = (
  snapshot: PieceTableTreeSnapshot,
  edit: PieceTableEdit,
  boundaries: BatchBoundaries,
): boolean => {
  if (!splitsSurrogatePair(snapshot, edit.from)) return false
  // A sibling edit ending here consumes the leading half, so the pair leaves the
  // document whole rather than in halves.
  if (coveredByAnother(boundaries.ends, edit.from, edit.to === edit.from)) return false
  return !isLowSurrogate(edit.text.charCodeAt(0))
}

const orphansSurrogateAtEnd = (
  snapshot: PieceTableTreeSnapshot,
  edit: PieceTableEdit,
  boundaries: BatchBoundaries,
): boolean => {
  if (!splitsSurrogatePair(snapshot, edit.to)) return false
  if (coveredByAnother(boundaries.starts, edit.to, edit.from === edit.to)) return false
  return !isHighSurrogate(edit.text.charCodeAt(edit.text.length - 1))
}

const snapEditToCodePoints = (
  snapshot: PieceTableTreeSnapshot,
  edit: PieceTableEdit,
  boundaries: BatchBoundaries,
): PieceTableEdit => {
  const atStart = orphansSurrogateAtStart(snapshot, edit, boundaries)
  const atEnd = orphansSurrogateAtEnd(snapshot, edit, boundaries)
  if (!atStart && !atEnd) return edit

  // Asymmetric on purpose: a non-empty range expands outward so that deleting
  // half an emoji deletes the emoji, while a collapsed one moves left instead —
  // expanding a caret would turn an insertion point into a selection.
  if (edit.from === edit.to) return { ...edit, from: edit.from - 1, to: edit.to - 1 }
  return { ...edit, from: atStart ? edit.from - 1 : edit.from, to: atEnd ? edit.to + 1 : edit.to }
}

// Only snapping can produce an overlap here — the batch was checked before it —
// and the overlap is the one surrogate half both neighbours expanded across, so
// concatenating in document order is the whole of the repair. Throwing instead
// would surface a lone RangeError out of an ordinary multi-cursor replace.
const mergeSnappedOverlaps = (edits: readonly PieceTableEdit[]): readonly PieceTableEdit[] => {
  const merged: PieceTableEdit[] = []
  for (const edit of edits) {
    const previous = merged.at(-1)
    if (previous && edit.from < previous.to) {
      merged[merged.length - 1] = {
        from: previous.from,
        to: Math.max(previous.to, edit.to),
        text: previous.text + edit.text,
      }
      continue
    }

    merged.push(edit)
  }

  return merged
}

/**
 * The edits a batch will actually apply: validated, ordered, and snapped off any
 * surrogate pair they would otherwise split. Callers that report a change to
 * anyone else — the session's change events, undo inversion, incremental
 * re-render — must describe these, not the edits they were handed, or every
 * consumer is told about a transformation that did not happen.
 *
 * Snapping is idempotent, so a caller may run this and still hand the result to
 * applyBatchToPieceTable.
 */
export const snapBatchEditRanges = (
  snapshot: PieceTableTreeSnapshot,
  edits: readonly PieceTableEdit[],
): readonly PieceTableEdit[] => {
  const sorted = edits.toSorted((left, right) => left.from - right.from || left.to - right.to)

  let previousEnd = -1
  for (const edit of sorted) {
    ensureValidRange(snapshot, edit.from, edit.to)
    if (edit.from < previousEnd) throw new RangeError('batch edits must not overlap')
    previousEnd = edit.to
  }

  const boundaries = {
    starts: countBoundaries(sorted, (edit) => edit.from),
    ends: countBoundaries(sorted, (edit) => edit.to),
  }
  return mergeSnappedOverlaps(
    sorted.map((edit) => snapEditToCodePoints(snapshot, edit, boundaries)),
  )
}

const countBoundaries = (
  edits: readonly PieceTableEdit[],
  offsetOf: (edit: PieceTableEdit) => number,
): ReadonlyMap<number, number> => {
  const counts = new Map<number, number>()
  for (const edit of edits) {
    const offset = offsetOf(edit)
    counts.set(offset, (counts.get(offset) ?? 0) + 1)
  }

  return counts
}

export const insertIntoPieceTable = (
  snapshot: PieceTableTreeSnapshot,
  offset: number,
  text: string,
): PieceTableTreeSnapshot => {
  if (text.length === 0) return snapshot
  if (offset < 0 || offset > snapshot.length) {
    throw new RangeError('invalid offset')
  }

  const [snapped] = snapBatchEditRanges(snapshot, [{ from: offset, to: offset, text }])
  return insertTextAt(snapshot, snapped?.from ?? offset, text)
}

const insertTextAt = (
  snapshot: PieceTableTreeSnapshot,
  from: number,
  text: string,
): PieceTableTreeSnapshot => {
  const coalesced = tryCoalesceInsert(snapshot, from, text)
  if (coalesced) return coalesced

  const context: SplitContext = { changes: [], normalizeOrders: false }
  const { left, right } = splitByVisibleOffset(snapshot.root, from, snapshot.buffers, context)
  const leftOrder = left ? getSubtreeMaxOrder(left) : null
  const rightOrder = right ? getSubtreeMinOrder(right) : null
  const appended = appendChunksToBuffers(snapshot.buffers, text)
  const ordered = assignPieceOrders(appended.pieces, leftOrder, rightOrder)
  const insertionTree = createTreeFromPieces(ordered.pieces, appended.buffers.prioritySeed)
  const merged = merge(merge(left, insertionTree), right)
  const insertionChanges = ordered.pieces.map((piece) => ({ add: piece }))
  const reverseIndexRoot = applyReverseIndexChanges(
    snapshot.reverseIndexRoot,
    [...context.changes, ...insertionChanges],
    appended.buffers.prioritySeed,
  )

  return createSnapshotWithIndex(
    appended.buffers,
    merged,
    reverseIndexRoot,
    context.normalizeOrders || ordered.normalizeOrders,
  )
}

const tryCoalesceInsert = (
  snapshot: PieceTableTreeSnapshot,
  offset: number,
  text: string,
): PieceTableTreeSnapshot | null => {
  const location = findVisiblePieceEndingAt(snapshot.root, offset)
  if (!location) return null

  const piece = location.piece
  const chunkText = getBufferText(snapshot.buffers, piece.buffer)
  if (piece.buffer === snapshot.buffers.original) return null
  if (!isNewestChunk(snapshot.buffers, piece.buffer)) return null
  if (piece.start + piece.length !== chunkText.length) return null
  if (chunkText.length + text.length > BUFFER_CHUNK_SIZE) return null

  const buffers = extendTailChunk(snapshot.buffers, text)
  const pieceWithTail = {
    ...piece,
    length: piece.length + text.length,
    lineBreaks: piece.lineBreaks + countLineBreaks(text),
  }
  const root = replacePieceEndingAt(snapshot.root, offset, pieceWithTail)
  const reverseIndexRoot = applyReverseIndexChanges(
    snapshot.reverseIndexRoot,
    [{ add: pieceWithTail }],
    buffers.prioritySeed,
  )

  return createSnapshotWithIndex(buffers, root, reverseIndexRoot, false)
}

export const deleteFromPieceTable = (
  snapshot: PieceTableTreeSnapshot,
  offset: number,
  length: number,
): PieceTableTreeSnapshot => {
  if (length <= 0) return snapshot

  const [snapped] = snapBatchEditRanges(snapshot, [{ from: offset, to: offset + length, text: '' }])
  return deleteRange(snapshot, snapped?.from ?? offset, snapped?.to ?? offset + length)
}

const deleteRange = (
  snapshot: PieceTableTreeSnapshot,
  from: number,
  to: number,
): PieceTableTreeSnapshot => {
  if (to <= from) return snapshot

  const context: SplitContext = { changes: [], normalizeOrders: false }
  const { left, right } = splitByVisibleOffset(snapshot.root, from, snapshot.buffers, context)
  const { left: deleted, right: tail } = splitByVisibleOffset(
    right,
    to - from,
    snapshot.buffers,
    context,
  )
  const invisible = markTreeInvisible(deleted, context.changes)
  const merged = merge(merge(left, invisible), tail)
  const reverseIndexRoot = applyReverseIndexChanges(
    snapshot.reverseIndexRoot,
    context.changes,
    snapshot.buffers.prioritySeed,
  )
  return createSnapshotWithIndex(
    snapshot.buffers,
    merged,
    reverseIndexRoot,
    context.normalizeOrders,
  )
}

export const applyBatchToPieceTable = (
  snapshot: PieceTableTreeSnapshot,
  edits: readonly PieceTableEdit[],
): PieceTableTreeSnapshot => {
  if (edits.length === 0) return snapshot

  // Snapped once, against this snapshot. Re-snapping per edit as the tree
  // changes underneath would measure offsets against a document that no longer
  // matches the ones the caller asked about.
  const applied = snapBatchEditRanges(snapshot, edits)

  let next = snapshot
  for (const edit of applied.toSorted(compareEditsDescending)) {
    next = deleteRange(next, edit.from, edit.to)
    if (edit.text.length > 0) next = insertTextAt(next, edit.from, edit.text)
  }

  return next
}
