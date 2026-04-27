import type { Piece, PieceTableBuffers, PieceTreeNode } from "./pieceTableTypes";
import type { ReverseIndexChange, SplitContext } from "./internalTypes";
import { bufferForPiece, createPiece } from "./buffers";
import { allocateOrdersBetween, PIECE_ORDER_MIN_GAP, PIECE_ORDER_STEP } from "./orders";

const randomPriority = () => Math.random();

export const getSubtreeLength = (node: PieceTreeNode | null): number =>
  node ? node.subtreeLength : 0;

export const getSubtreeVisibleLength = (node: PieceTreeNode | null): number =>
  node ? node.subtreeVisibleLength : 0;

export const getSubtreePieces = (node: PieceTreeNode | null): number =>
  node ? node.subtreePieces : 0;

export const getSubtreeLineBreaks = (node: PieceTreeNode | null): number =>
  node ? node.subtreeLineBreaks : 0;

export const getSubtreeMinOrder = (node: PieceTreeNode | null): number =>
  node ? node.subtreeMinOrder : Number.POSITIVE_INFINITY;

export const getSubtreeMaxOrder = (node: PieceTreeNode | null): number =>
  node ? node.subtreeMaxOrder : Number.NEGATIVE_INFINITY;

export const getPieceVisibleLength = (piece: Piece): number => (piece.visible ? piece.length : 0);

export const getPieceVisibleLineBreaks = (piece: Piece): number =>
  piece.visible ? piece.lineBreaks : 0;

export const cloneNode = (node: PieceTreeNode): PieceTreeNode => ({
  piece: node.piece,
  left: node.left,
  right: node.right,
  priority: node.priority,
  subtreeLength: node.subtreeLength,
  subtreeVisibleLength: node.subtreeVisibleLength,
  subtreePieces: node.subtreePieces,
  subtreeLineBreaks: node.subtreeLineBreaks,
  subtreeMinOrder: node.subtreeMinOrder,
  subtreeMaxOrder: node.subtreeMaxOrder,
});

const computeSubtreeLength = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number => piece.length + getSubtreeLength(left) + getSubtreeLength(right);

const computeSubtreeVisibleLength = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number =>
  getPieceVisibleLength(piece) + getSubtreeVisibleLength(left) + getSubtreeVisibleLength(right);

const computeSubtreePieces = (left: PieceTreeNode | null, right: PieceTreeNode | null): number =>
  1 + getSubtreePieces(left) + getSubtreePieces(right);

const computeSubtreeLineBreaks = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number =>
  getPieceVisibleLineBreaks(piece) + getSubtreeLineBreaks(left) + getSubtreeLineBreaks(right);

const computeSubtreeMinOrder = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number => Math.min(piece.order, getSubtreeMinOrder(left), getSubtreeMinOrder(right));

const computeSubtreeMaxOrder = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number => Math.max(piece.order, getSubtreeMaxOrder(left), getSubtreeMaxOrder(right));

export const createNode = (
  piece: Piece,
  left: PieceTreeNode | null = null,
  right: PieceTreeNode | null = null,
  priority = randomPriority(),
): PieceTreeNode => ({
  piece,
  left,
  right,
  priority,
  subtreeLength: computeSubtreeLength(piece, left, right),
  subtreeVisibleLength: computeSubtreeVisibleLength(piece, left, right),
  subtreePieces: computeSubtreePieces(left, right),
  subtreeLineBreaks: computeSubtreeLineBreaks(piece, left, right),
  subtreeMinOrder: computeSubtreeMinOrder(piece, left, right),
  subtreeMaxOrder: computeSubtreeMaxOrder(piece, left, right),
});

export const updateNode = (node: PieceTreeNode | null): PieceTreeNode | null => {
  if (!node) return node;
  node.subtreeLength = computeSubtreeLength(node.piece, node.left, node.right);
  node.subtreeVisibleLength = computeSubtreeVisibleLength(node.piece, node.left, node.right);
  node.subtreePieces = computeSubtreePieces(node.left, node.right);
  node.subtreeLineBreaks = computeSubtreeLineBreaks(node.piece, node.left, node.right);
  node.subtreeMinOrder = computeSubtreeMinOrder(node.piece, node.left, node.right);
  node.subtreeMaxOrder = computeSubtreeMaxOrder(node.piece, node.left, node.right);
  return node;
};

export const merge = (
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): PieceTreeNode | null => {
  if (!left) return right;
  if (!right) return left;

  if (left.priority < right.priority) {
    const newLeft = cloneNode(left);
    newLeft.right = merge(newLeft.right, right);
    return updateNode(newLeft);
  }

  const newRight = cloneNode(right);
  newRight.left = merge(left, newRight.left);
  return updateNode(newRight);
};

export const splitByVisibleOffset = (
  node: PieceTreeNode | null,
  offset: number,
  buffers: PieceTableBuffers,
  context: SplitContext,
  upperOrder: number | null = null,
): { left: PieceTreeNode | null; right: PieceTreeNode | null } => {
  if (!node) return { left: null, right: null };

  const leftLen = getSubtreeVisibleLength(node.left);
  const nodeLen = getPieceVisibleLength(node.piece);

  if (offset < leftLen) {
    const newNode = cloneNode(node);
    const { left, right } = splitByVisibleOffset(
      newNode.left,
      offset,
      buffers,
      context,
      node.piece.order,
    );
    newNode.left = right;
    return { left, right: updateNode(newNode) };
  }

  if (offset > leftLen + nodeLen) {
    const newNode = cloneNode(node);
    const { left, right } = splitByVisibleOffset(
      newNode.right,
      offset - leftLen - nodeLen,
      buffers,
      context,
      upperOrder,
    );
    newNode.right = left;
    return { left: updateNode(newNode), right };
  }

  if (nodeLen === 0) {
    const newNode = cloneNode(node);
    const rightTree = newNode.right;
    newNode.right = null;
    return { left: updateNode(newNode), right: rightTree };
  }

  if (offset === leftLen) {
    const newNode = cloneNode(node);
    const leftTree = newNode.left;
    newNode.left = null;
    return { left: leftTree, right: updateNode(newNode) };
  }

  if (offset === leftLen + nodeLen) {
    const newNode = cloneNode(node);
    const rightTree = newNode.right;
    newNode.right = null;
    return { left: updateNode(newNode), right: rightTree };
  }

  const localOffset = offset - leftLen;
  const rightUpperOrder = node.right ? getSubtreeMinOrder(node.right) : upperOrder;
  const rightOrders = allocateOrdersBetween(node.piece.order, rightUpperOrder, 1);
  const rightOrder = rightOrders?.[0] ?? node.piece.order + PIECE_ORDER_MIN_GAP;
  context.normalizeOrders ||= !rightOrders;
  const leftPiece = createPiece(
    buffers,
    node.piece.buffer,
    node.piece.start,
    localOffset,
    node.piece.order,
    node.piece.visible,
  );
  const rightPiece = createPiece(
    buffers,
    node.piece.buffer,
    node.piece.start + localOffset,
    nodeLen - localOffset,
    rightOrder,
    node.piece.visible,
  );

  const leftNode = createNode(leftPiece);
  const rightNode = createNode(rightPiece);
  const leftTree = merge(node.left, leftNode);
  const rightTree = merge(rightNode, node.right);

  context.changes.push({ remove: node.piece });
  context.changes.push({ add: leftNode.piece });
  context.changes.push({ add: rightNode.piece });

  return { left: leftTree, right: rightTree };
};

export const createTreeFromPieces = (pieces: readonly Piece[]): PieceTreeNode | null => {
  let tree: PieceTreeNode | null = null;

  for (const piece of pieces) {
    tree = merge(tree, createNode(piece));
  }

  return tree;
};

export const collectTextInRange = (
  node: PieceTreeNode | null,
  buffers: PieceTableBuffers,
  start: number,
  end: number,
  acc: string[],
  baseOffset = 0,
) => {
  if (!node || baseOffset >= end) return;

  const leftLen = getSubtreeVisibleLength(node.left);
  const nodeLen = getPieceVisibleLength(node.piece);
  const nodeStart = baseOffset + leftLen;
  const nodeEnd = nodeStart + nodeLen;

  if (start < nodeStart) collectTextInRange(node.left, buffers, start, end, acc, baseOffset);

  if (node.piece.visible && nodeEnd > start && nodeStart < end) {
    const pieceStart = Math.max(0, start - nodeStart);
    const pieceEnd = Math.min(node.piece.length, end - nodeStart);
    if (pieceEnd > pieceStart) {
      const buf = bufferForPiece(buffers, node.piece);
      acc.push(buf.slice(node.piece.start + pieceStart, node.piece.start + pieceEnd));
    }
  }

  if (end > nodeEnd) collectTextInRange(node.right, buffers, start, end, acc, nodeEnd);
};

export const flattenPieces = (node: PieceTreeNode | null, acc: Piece[]): Piece[] => {
  if (!node) return acc;
  flattenPieces(node.left, acc);
  acc.push({ ...node.piece });
  flattenPieces(node.right, acc);
  return acc;
};

export type AnchorLocation = {
  piece: Piece;
  visibleStart: number;
};

export const findVisiblePieceEndingAt = (
  node: PieceTreeNode | null,
  offset: number,
  baseOffset = 0,
): AnchorLocation | null => {
  if (!node) return null;

  const leftLen = getSubtreeVisibleLength(node.left);
  const nodeLen = getPieceVisibleLength(node.piece);
  const nodeStart = baseOffset + leftLen;
  const nodeEnd = nodeStart + nodeLen;

  if (offset <= nodeStart) return findVisiblePieceEndingAt(node.left, offset, baseOffset);
  if (nodeLen > 0 && offset === nodeEnd) return { piece: node.piece, visibleStart: nodeStart };

  return findVisiblePieceEndingAt(node.right, offset, nodeEnd);
};

export const findVisiblePieceStartingAt = (
  node: PieceTreeNode | null,
  offset: number,
  baseOffset = 0,
): AnchorLocation | null => {
  if (!node) return null;

  const leftLen = getSubtreeVisibleLength(node.left);
  const nodeLen = getPieceVisibleLength(node.piece);
  const nodeStart = baseOffset + leftLen;
  const nodeEnd = nodeStart + nodeLen;

  if (offset < nodeStart) return findVisiblePieceStartingAt(node.left, offset, baseOffset);
  if (nodeLen > 0 && offset === nodeStart) return { piece: node.piece, visibleStart: nodeStart };

  return findVisiblePieceStartingAt(node.right, offset, nodeEnd);
};

export const findVisiblePieceContainingOffset = (
  node: PieceTreeNode | null,
  offset: number,
  baseOffset = 0,
): AnchorLocation | null => {
  if (!node) return null;

  const leftLen = getSubtreeVisibleLength(node.left);
  const nodeLen = getPieceVisibleLength(node.piece);
  const nodeStart = baseOffset + leftLen;
  const nodeEnd = nodeStart + nodeLen;

  if (offset < nodeStart) return findVisiblePieceContainingOffset(node.left, offset, baseOffset);
  if (nodeLen > 0 && offset > nodeStart && offset < nodeEnd) {
    return { piece: node.piece, visibleStart: nodeStart };
  }

  return findVisiblePieceContainingOffset(node.right, offset, nodeEnd);
};

export const flattenNodes = (node: PieceTreeNode | null, acc: PieceTreeNode[]): PieceTreeNode[] => {
  if (!node) return acc;
  flattenNodes(node.left, acc);
  acc.push(node);
  flattenNodes(node.right, acc);
  return acc;
};

export const markTreeInvisible = (
  node: PieceTreeNode | null,
  changes: ReverseIndexChange[],
): PieceTreeNode | null => {
  if (!node) return null;

  const next = cloneNode(node);
  next.left = markTreeInvisible(next.left, changes);
  next.right = markTreeInvisible(next.right, changes);
  next.piece = {
    ...next.piece,
    visible: false,
  };
  changes.push({ add: next.piece });

  return updateNode(next);
};

export const visiblePrefixBeforeOrder = (
  node: PieceTreeNode | null,
  order: number,
  baseOffset = 0,
): number | null => {
  if (!node) return null;

  const leftLength = getSubtreeVisibleLength(node.left);
  const nodeStart = baseOffset + leftLength;

  if (order === node.piece.order) return nodeStart;
  if (order < node.piece.order) return visiblePrefixBeforeOrder(node.left, order, baseOffset);

  return visiblePrefixBeforeOrder(node.right, order, nodeStart + getPieceVisibleLength(node.piece));
};

export const visibleLengthBetweenOrders = (
  node: PieceTreeNode | null,
  lowExclusive: number,
  highExclusive: number,
): number => {
  if (!node || lowExclusive >= highExclusive) return 0;
  if (getSubtreeMaxOrder(node) <= lowExclusive) return 0;
  if (getSubtreeMinOrder(node) >= highExclusive) return 0;

  if (getSubtreeMinOrder(node) > lowExclusive && getSubtreeMaxOrder(node) < highExclusive) {
    return getSubtreeVisibleLength(node);
  }

  const nodeLength =
    node.piece.order > lowExclusive && node.piece.order < highExclusive
      ? getPieceVisibleLength(node.piece)
      : 0;

  return (
    visibleLengthBetweenOrders(node.left, lowExclusive, highExclusive) +
    nodeLength +
    visibleLengthBetweenOrders(node.right, lowExclusive, highExclusive)
  );
};

export const normalizePieceOrders = (
  node: PieceTreeNode | null,
  nextOrder: { value: number },
): PieceTreeNode | null => {
  if (!node) return null;

  const next = cloneNode(node);
  next.left = normalizePieceOrders(next.left, nextOrder);
  next.piece = {
    ...next.piece,
    order: nextOrder.value,
  };
  nextOrder.value += PIECE_ORDER_STEP;
  next.right = normalizePieceOrders(next.right, nextOrder);
  return updateNode(next);
};
