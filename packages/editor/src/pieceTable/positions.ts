import type {
  Piece,
  PieceTableBuffers,
  PieceTableTreeSnapshot,
  PieceTreeNode,
  Point,
} from './pieceTableTypes'
import { countBufferLineBreaks, findBufferLineBreakOffset } from './buffers'
import {
  getPieceVisibleLength,
  getPieceVisibleLineBreaks,
  getSubtreeLineBreaks,
  getSubtreeVisibleLength,
} from './tree'

const countPiecePrefixLineBreaks = (
  buffers: PieceTableBuffers,
  piece: Piece,
  prefixLength: number,
): number => {
  if (!piece.visible || prefixLength <= 0) return 0
  if (prefixLength >= piece.length) return piece.lineBreaks

  return countBufferLineBreaks(buffers, piece.buffer, piece.start, piece.start + prefixLength)
}

const findOffsetAfterPieceLineBreak = (
  buffers: PieceTableBuffers,
  piece: Piece,
  lineBreakOrdinal: number,
): number => {
  const offset = findBufferLineBreakOffset(buffers, piece.buffer, piece.start, lineBreakOrdinal)
  if (offset === null || offset >= piece.start + piece.length) {
    throw new Error('line break not found in piece')
  }

  return offset - piece.start + 1
}

// Counts the line breaks before `offset` and, in the same descent, records the
// offset the resulting row starts at into `lineStart` — the column then falls
// out as `offset - lineStart` with no second descent. `lineStart` stays null
// only when the last break before `offset` sits in a subtree this descent never
// entered, i.e. when `offset` lands on the first line of the piece it falls in.
const findRowAtOffset = (
  node: PieceTreeNode | null,
  buffers: PieceTableBuffers,
  offset: number,
  baseOffset: number,
  lineStart: { value: number | null },
): number => {
  if (!node || offset <= 0) return 0

  const leftLen = getSubtreeVisibleLength(node.left)
  const nodeLen = getPieceVisibleLength(node.piece)
  const nodeEnd = leftLen + nodeLen

  if (offset <= leftLen) return findRowAtOffset(node.left, buffers, offset, baseOffset, lineStart)

  const leftLineBreaks = getSubtreeLineBreaks(node.left)
  if (offset <= nodeEnd) {
    const prefixLineBreaks = countPiecePrefixLineBreaks(buffers, node.piece, offset - leftLen)
    if (prefixLineBreaks > 0) {
      lineStart.value =
        baseOffset + leftLen + findOffsetAfterPieceLineBreak(buffers, node.piece, prefixLineBreaks)
    }

    return leftLineBreaks + prefixLineBreaks
  }

  const pieceLineBreaks = getPieceVisibleLineBreaks(node.piece)
  const tailRow = findRowAtOffset(
    node.right,
    buffers,
    offset - nodeEnd,
    baseOffset + nodeEnd,
    lineStart,
  )
  // Only the *last* break before `offset` names the row start, so this piece
  // answers just when nothing after it held one.
  if (tailRow === 0 && pieceLineBreaks > 0) {
    lineStart.value =
      baseOffset + leftLen + findOffsetAfterPieceLineBreak(buffers, node.piece, pieceLineBreaks)
  }

  return leftLineBreaks + pieceLineBreaks + tailRow
}

// The augmented `subtreeLineBreaks` counts pick the branch, so a whole left
// subtree is skipped in one comparison rather than walked. `lineBreakOrdinal` is
// 1-based, and null means the subtree holds fewer breaks than that.
const findOffsetAfterLineBreak = (
  node: PieceTreeNode | null,
  buffers: PieceTableBuffers,
  lineBreakOrdinal: number,
  baseOffset = 0,
): number | null => {
  if (!node || lineBreakOrdinal <= 0) return null

  const leftLineBreaks = getSubtreeLineBreaks(node.left)
  const leftLength = getSubtreeVisibleLength(node.left)

  if (lineBreakOrdinal <= leftLineBreaks) {
    return findOffsetAfterLineBreak(node.left, buffers, lineBreakOrdinal, baseOffset)
  }

  const remainingAfterLeft = lineBreakOrdinal - leftLineBreaks
  const pieceLineBreaks = getPieceVisibleLineBreaks(node.piece)
  if (remainingAfterLeft <= pieceLineBreaks) {
    return (
      baseOffset +
      leftLength +
      findOffsetAfterPieceLineBreak(buffers, node.piece, remainingAfterLeft)
    )
  }

  return findOffsetAfterLineBreak(
    node.right,
    buffers,
    remainingAfterLeft - pieceLineBreaks,
    baseOffset + leftLength + getPieceVisibleLength(node.piece),
  )
}

const lineStartOffset = (snapshot: PieceTableTreeSnapshot, row: number): number => {
  if (row <= 0) return 0

  const offset = findOffsetAfterLineBreak(snapshot.root, snapshot.buffers, row)
  return offset ?? snapshot.length
}

const lineEndOffset = (snapshot: PieceTableTreeSnapshot, row: number): number => {
  const totalRows = getSubtreeLineBreaks(snapshot.root)
  if (row >= totalRows) return snapshot.length

  const nextLineStart = findOffsetAfterLineBreak(snapshot.root, snapshot.buffers, row + 1)
  return nextLineStart === null ? snapshot.length : nextLineStart - 1
}

export const offsetToPoint = (snapshot: PieceTableTreeSnapshot, offset: number): Point => {
  if (offset < 0 || offset > snapshot.length) {
    throw new RangeError('invalid offset')
  }

  const lineStart: { value: number | null } = { value: null }
  const row = findRowAtOffset(snapshot.root, snapshot.buffers, offset, 0, lineStart)

  return { row, column: offset - (lineStart.value ?? lineStartOffset(snapshot, row)) }
}

export const pointToOffset = (snapshot: PieceTableTreeSnapshot, point: Point): number => {
  const row = Math.max(0, point.row)
  const column = Math.max(0, point.column)
  const start = lineStartOffset(snapshot, row)
  const end = lineEndOffset(snapshot, row)
  return Math.min(start + column, end)
}
