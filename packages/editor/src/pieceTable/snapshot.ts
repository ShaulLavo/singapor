import type {
  PieceTableBuffers,
  PieceTableReverseIndexNode,
  PieceTableTreeSnapshot,
  PieceTreeNode,
} from "./pieceTableTypes";
import { createInitialBuffers, createOriginalPiece } from "./buffers";
import { buildReverseIndex } from "./reverseIndex";
import {
  createNode,
  getSubtreePieces,
  getSubtreeVisibleLength,
  normalizePieceOrders,
} from "./tree";
import { PIECE_ORDER_STEP } from "./orders";

export const createSnapshot = (
  buffers: PieceTableBuffers,
  root: PieceTreeNode | null,
  reverseIndexRoot: PieceTableReverseIndexNode | null,
): PieceTableTreeSnapshot => ({
  buffers,
  root,
  reverseIndexRoot,
  length: getSubtreeVisibleLength(root),
  pieceCount: getSubtreePieces(root),
});

export const createSnapshotWithIndex = (
  buffers: PieceTableBuffers,
  root: PieceTreeNode | null,
  reverseIndexRoot: PieceTableReverseIndexNode | null,
  normalizeOrders: boolean,
): PieceTableTreeSnapshot => {
  if (!normalizeOrders) return createSnapshot(buffers, root, reverseIndexRoot);

  const normalizedRoot = normalizePieceOrders(root, { value: PIECE_ORDER_STEP });
  return createSnapshot(buffers, normalizedRoot, buildReverseIndex(normalizedRoot));
};

export const createPieceTableSnapshot = (original: string): PieceTableTreeSnapshot => {
  const buffers = createInitialBuffers(original);
  const originalPiece = createOriginalPiece(buffers);
  const root = originalPiece ? createNode(originalPiece) : null;
  return createSnapshot(buffers, root, buildReverseIndex(root));
};
