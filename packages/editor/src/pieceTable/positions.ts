import type {
  Piece,
  PieceTableBuffers,
  PieceTableTreeSnapshot,
  PieceTreeNode,
  Point,
} from "./pieceTableTypes";
import { bufferForPiece, countLineBreaks } from "./buffers";
import {
  getPieceVisibleLength,
  getPieceVisibleLineBreaks,
  getSubtreeLineBreaks,
  getSubtreeVisibleLength,
} from "./tree";

const countPiecePrefixLineBreaks = (
  buffers: PieceTableBuffers,
  piece: Piece,
  prefixLength: number,
): number => {
  if (!piece.visible || prefixLength <= 0) return 0;
  if (prefixLength >= piece.length) return piece.lineBreaks;

  const text = bufferForPiece(buffers, piece);
  return countLineBreaks(text, piece.start, piece.start + prefixLength);
};

const findOffsetAfterPieceLineBreak = (
  buffers: PieceTableBuffers,
  piece: Piece,
  lineBreakOrdinal: number,
): number => {
  const text = bufferForPiece(buffers, piece);
  let remaining = lineBreakOrdinal;

  for (let index = piece.start; index < piece.start + piece.length; index++) {
    if (text[index] !== "\n") continue;
    remaining--;
    if (remaining === 0) return index - piece.start + 1;
  }

  throw new Error("line break not found in piece");
};

const countLineBreaksBeforeOffset = (
  node: PieceTreeNode | null,
  buffers: PieceTableBuffers,
  offset: number,
): number => {
  if (!node || offset <= 0) return 0;

  const leftLen = getSubtreeVisibleLength(node.left);
  const nodeLen = getPieceVisibleLength(node.piece);
  const nodeEnd = leftLen + nodeLen;

  if (offset <= leftLen) return countLineBreaksBeforeOffset(node.left, buffers, offset);

  const leftLineBreaks = getSubtreeLineBreaks(node.left);
  if (offset <= nodeEnd) {
    return leftLineBreaks + countPiecePrefixLineBreaks(buffers, node.piece, offset - leftLen);
  }

  return (
    leftLineBreaks +
    getPieceVisibleLineBreaks(node.piece) +
    countLineBreaksBeforeOffset(node.right, buffers, offset - nodeEnd)
  );
};

const findOffsetAfterLineBreak = (
  node: PieceTreeNode | null,
  buffers: PieceTableBuffers,
  lineBreakOrdinal: number,
  baseOffset = 0,
): number | null => {
  if (!node || lineBreakOrdinal <= 0) return null;

  const leftLineBreaks = getSubtreeLineBreaks(node.left);
  const leftLength = getSubtreeVisibleLength(node.left);

  if (lineBreakOrdinal <= leftLineBreaks) {
    return findOffsetAfterLineBreak(node.left, buffers, lineBreakOrdinal, baseOffset);
  }

  const remainingAfterLeft = lineBreakOrdinal - leftLineBreaks;
  const pieceLineBreaks = getPieceVisibleLineBreaks(node.piece);
  if (remainingAfterLeft <= pieceLineBreaks) {
    return (
      baseOffset +
      leftLength +
      findOffsetAfterPieceLineBreak(buffers, node.piece, remainingAfterLeft)
    );
  }

  return findOffsetAfterLineBreak(
    node.right,
    buffers,
    remainingAfterLeft - pieceLineBreaks,
    baseOffset + leftLength + getPieceVisibleLength(node.piece),
  );
};

const lineStartOffset = (snapshot: PieceTableTreeSnapshot, row: number): number => {
  if (row <= 0) return 0;

  const offset = findOffsetAfterLineBreak(snapshot.root, snapshot.buffers, row);
  return offset ?? snapshot.length;
};

const lineEndOffset = (snapshot: PieceTableTreeSnapshot, row: number): number => {
  const totalRows = getSubtreeLineBreaks(snapshot.root);
  if (row >= totalRows) return snapshot.length;

  const nextLineStart = findOffsetAfterLineBreak(snapshot.root, snapshot.buffers, row + 1);
  return nextLineStart === null ? snapshot.length : nextLineStart - 1;
};

export const offsetToPoint = (snapshot: PieceTableTreeSnapshot, offset: number): Point => {
  if (offset < 0 || offset > snapshot.length) {
    throw new RangeError("invalid offset");
  }

  const row = countLineBreaksBeforeOffset(snapshot.root, snapshot.buffers, offset);
  const column = offset - lineStartOffset(snapshot, row);
  return { row, column };
};

export const pointToOffset = (snapshot: PieceTableTreeSnapshot, point: Point): number => {
  const row = Math.max(0, point.row);
  const column = Math.max(0, point.column);
  const start = lineStartOffset(snapshot, row);
  const end = lineEndOffset(snapshot, row);
  return Math.min(start + column, end);
};
