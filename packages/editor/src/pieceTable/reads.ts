import type { Piece, PieceTableTreeSnapshot } from './pieceTableTypes'
import { getBufferText } from './buffers'
import { collectTextInRange, forEachTextInRange } from './tree'
import { createPieceTableWalker } from './walker'

export const getPieceTableLength = (snapshot: PieceTableTreeSnapshot): number => snapshot.length

export const getPieceTableOriginalText = (snapshot: PieceTableTreeSnapshot): string =>
  getBufferText(snapshot.buffers, snapshot.buffers.original)

export const ensureValidRange = (snapshot: PieceTableTreeSnapshot, start: number, end: number) => {
  if (start < 0 || end < start || end > snapshot.length) {
    throw new RangeError('invalid range')
  }
}

export const readPieceTableTextRange = (
  snapshot: PieceTableTreeSnapshot,
  start: number,
  end: number,
): string => {
  ensureValidRange(snapshot, start, end)
  if (start === end) return ''

  const chunks: string[] = []
  collectTextInRange(snapshot.root, snapshot.buffers, start, end, chunks)
  return chunks.join('')
}

export const materializePieceTableFullText = (snapshot: PieceTableTreeSnapshot): string =>
  readPieceTableTextRange(snapshot, 0, snapshot.length)

export const streamPieceTableTextChunks = (
  snapshot: PieceTableTreeSnapshot,
  visit: (text: string, start: number, end: number) => void,
  start = 0,
  end?: number,
): void => {
  const effectiveEnd = end ?? snapshot.length
  ensureValidRange(snapshot, start, effectiveEnd)
  if (start === effectiveEnd) return
  let offset = start
  forEachTextInRange(snapshot.root, snapshot.buffers, start, effectiveEnd, (buffer, from, to) => {
    const text = buffer.slice(from, to)
    const nextOffset = offset + text.length
    visit(text, offset, nextOffset)
    offset = nextOffset
  })
}

export const forEachPieceTableTextChunk = streamPieceTableTextChunks

export type PieceTablePieceStreamEntry = {
  readonly piece: Piece
  readonly text: string
  readonly start: number
  readonly end: number
}

export const streamPieceTablePieces = (
  snapshot: PieceTableTreeSnapshot,
  visit: (entry: PieceTablePieceStreamEntry) => void,
  start = 0,
  end?: number,
): void => {
  const effectiveEnd = end ?? snapshot.length
  ensureValidRange(snapshot, start, effectiveEnd)
  if (start === effectiveEnd) return
  streamPieces(snapshot.root, snapshot, visit, start, effectiveEnd)
}

export const pieceTableSnapshotsHaveSameText = (
  left: PieceTableTreeSnapshot,
  right: PieceTableTreeSnapshot,
): boolean => {
  if (left === right) return true
  if (left.length !== right.length) return false
  if (left.length === 0) return true
  // Same tree implies same text: buffers only ever grow by appending, so the
  // windows existing pieces read from are stable across snapshots.
  if (left.root === right.root) return true

  const leftWalker = createPieceTableWalker(left)
  const rightWalker = createPieceTableWalker(right)

  for (;;) {
    const leftChunk = leftWalker.chunk()
    const rightChunk = rightWalker.chunk()
    if (!leftChunk || !rightChunk) return !leftChunk && !rightChunk

    const length = Math.min(leftChunk.end - leftChunk.start, rightChunk.end - rightChunk.start)
    const leftText =
      leftChunk.text.length === length ? leftChunk.text : leftChunk.text.slice(0, length)
    const rightText =
      rightChunk.text.length === length ? rightChunk.text : rightChunk.text.slice(0, length)
    if (leftText !== rightText) return false

    leftWalker.skip(length)
    rightWalker.skip(length)
  }
}

const streamPieces = (
  node: PieceTableTreeSnapshot['root'],
  snapshot: PieceTableTreeSnapshot,
  visit: (entry: PieceTablePieceStreamEntry) => void,
  start: number,
  end: number,
  baseOffset = 0,
): void => {
  if (!node || baseOffset >= end) return

  const leftLength = node.left?.subtreeVisibleLength ?? 0
  const pieceLength = node.piece.visible ? node.piece.length : 0
  const pieceStart = baseOffset + leftLength
  const pieceEnd = pieceStart + pieceLength

  if (start < pieceStart) streamPieces(node.left, snapshot, visit, start, end, baseOffset)
  streamCurrentPiece(node.piece, snapshot, visit, start, end, pieceStart, pieceEnd)
  if (end > pieceEnd) streamPieces(node.right, snapshot, visit, start, end, pieceEnd)
}

const streamCurrentPiece = (
  piece: Piece,
  snapshot: PieceTableTreeSnapshot,
  visit: (entry: PieceTablePieceStreamEntry) => void,
  start: number,
  end: number,
  pieceStart: number,
  pieceEnd: number,
): void => {
  if (!piece.visible || pieceEnd <= start || pieceStart >= end) return

  const localStart = Math.max(0, start - pieceStart)
  const localEnd = Math.min(piece.length, end - pieceStart)
  if (localEnd <= localStart) return

  const buffer = getBufferText(snapshot.buffers, piece.buffer)
  visit({
    piece,
    text: buffer.slice(piece.start + localStart, piece.start + localEnd),
    start: pieceStart + localStart,
    end: pieceStart + localEnd,
  })
}
