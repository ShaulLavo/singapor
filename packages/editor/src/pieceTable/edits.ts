import type { PieceTableEdit, PieceTableTreeSnapshot } from "./pieceTableTypes";
import type { SplitContext } from "./internalTypes";
import { appendChunksToBuffers } from "./buffers";
import { assignPieceOrders } from "./orders";
import { applyReverseIndexChanges } from "./reverseIndex";
import { ensureValidRange } from "./reads";
import { createSnapshotWithIndex } from "./snapshot";
import {
  createTreeFromPieces,
  getSubtreeMaxOrder,
  getSubtreeMinOrder,
  markTreeInvisible,
  merge,
  splitByVisibleOffset,
} from "./tree";

const compareEditsDescending = (left: PieceTableEdit, right: PieceTableEdit): number => {
  if (left.from !== right.from) return right.from - left.from;
  return right.to - left.to;
};

const validateBatchEdits = (
  snapshot: PieceTableTreeSnapshot,
  edits: readonly PieceTableEdit[],
): void => {
  let previousEnd = -1;
  const sorted = [...edits].sort((left, right) => left.from - right.from);

  for (const edit of sorted) {
    ensureValidRange(snapshot, edit.from, edit.to);
    if (edit.from < previousEnd) throw new RangeError("batch edits must not overlap");
    previousEnd = edit.to;
  }
};

export const insertIntoPieceTable = (
  snapshot: PieceTableTreeSnapshot,
  offset: number,
  text: string,
): PieceTableTreeSnapshot => {
  if (text.length === 0) return snapshot;
  if (offset < 0 || offset > snapshot.length) {
    throw new RangeError("invalid offset");
  }

  const context: SplitContext = { changes: [], normalizeOrders: false };
  const { left, right } = splitByVisibleOffset(snapshot.root, offset, snapshot.buffers, context);
  const leftOrder = left ? getSubtreeMaxOrder(left) : null;
  const rightOrder = right ? getSubtreeMinOrder(right) : null;
  const ordered = assignPieceOrders(
    appendChunksToBuffers(snapshot.buffers, text),
    leftOrder,
    rightOrder,
  );
  const insertionTree = createTreeFromPieces(ordered.pieces);
  const merged = merge(merge(left, insertionTree), right);
  const insertionChanges = ordered.pieces.map((piece) => ({ add: piece }));
  const reverseIndexRoot = applyReverseIndexChanges(snapshot.reverseIndexRoot, [
    ...context.changes,
    ...insertionChanges,
  ]);

  return createSnapshotWithIndex(
    snapshot.buffers,
    merged,
    reverseIndexRoot,
    context.normalizeOrders || ordered.normalizeOrders,
  );
};

export const deleteFromPieceTable = (
  snapshot: PieceTableTreeSnapshot,
  offset: number,
  length: number,
): PieceTableTreeSnapshot => {
  if (length <= 0) return snapshot;
  ensureValidRange(snapshot, offset, offset + length);

  const context: SplitContext = { changes: [], normalizeOrders: false };
  const { left, right } = splitByVisibleOffset(snapshot.root, offset, snapshot.buffers, context);
  const { left: deleted, right: tail } = splitByVisibleOffset(
    right,
    length,
    snapshot.buffers,
    context,
  );
  const invisible = markTreeInvisible(deleted, context.changes);
  const merged = merge(merge(left, invisible), tail);
  const reverseIndexRoot = applyReverseIndexChanges(snapshot.reverseIndexRoot, context.changes);
  return createSnapshotWithIndex(
    snapshot.buffers,
    merged,
    reverseIndexRoot,
    context.normalizeOrders,
  );
};

export const applyBatchToPieceTable = (
  snapshot: PieceTableTreeSnapshot,
  edits: readonly PieceTableEdit[],
): PieceTableTreeSnapshot => {
  if (edits.length === 0) return snapshot;

  validateBatchEdits(snapshot, edits);

  let next = snapshot;
  const sorted = [...edits].sort(compareEditsDescending);

  for (const edit of sorted) {
    next = deleteFromPieceTable(next, edit.from, edit.to - edit.from);
    next = insertIntoPieceTable(next, edit.from, edit.text);
  }

  return next;
};
