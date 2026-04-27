import type {
  Anchor as AnchorType,
  AnchorBias,
  Piece,
  PieceBufferId,
  PieceTableReverseIndexNode,
  PieceTableTreeSnapshot,
  PieceTreeNode,
  PieceTableBuffers,
  Point,
  RealAnchor,
  ResolvedAnchor,
  PieceTableEdit,
} from "./pieceTableTypes";

export type { AnchorBias, RealAnchor, ResolvedAnchor, PieceTableEdit };

export const Anchor = {
  MIN: { kind: "min" },
  MAX: { kind: "max" },
} as const satisfies Record<"MIN" | "MAX", AnchorType>;

const BUFFER_CHUNK_SIZE = 16 * 1024;
const PIECE_ORDER_STEP = 1024;
const PIECE_ORDER_MIN_GAP = 1e-9;
let nextBufferSequence = 0;

const randomPriority = () => Math.random();

const createBufferId = (): PieceBufferId => `buffer:${nextBufferSequence++}` as PieceBufferId;

const getSubtreeLength = (node: PieceTreeNode | null): number => (node ? node.subtreeLength : 0);

const getSubtreeVisibleLength = (node: PieceTreeNode | null): number =>
  node ? node.subtreeVisibleLength : 0;

const getSubtreePieces = (node: PieceTreeNode | null): number => (node ? node.subtreePieces : 0);

const getSubtreeLineBreaks = (node: PieceTreeNode | null): number =>
  node ? node.subtreeLineBreaks : 0;

const getSubtreeMinOrder = (node: PieceTreeNode | null): number =>
  node ? node.subtreeMinOrder : Number.POSITIVE_INFINITY;

const getSubtreeMaxOrder = (node: PieceTreeNode | null): number =>
  node ? node.subtreeMaxOrder : Number.NEGATIVE_INFINITY;

const getPieceVisibleLength = (piece: Piece): number => (piece.visible ? piece.length : 0);

const getPieceVisibleLineBreaks = (piece: Piece): number => (piece.visible ? piece.lineBreaks : 0);

const countLineBreaks = (text: string, start = 0, end = text.length): number => {
  let count = 0;
  let index = text.indexOf("\n", start);

  while (index !== -1 && index < end) {
    count++;
    index = text.indexOf("\n", index + 1);
  }

  return count;
};

const getBufferText = (buffers: PieceTableBuffers, buffer: PieceBufferId): string => {
  const text = buffers.chunks.get(buffer);
  if (text !== undefined) return text;
  throw new Error("piece buffer not found");
};

const createPiece = (
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  start: number,
  length: number,
  order: number,
  visible = true,
): Piece => {
  const text = getBufferText(buffers, buffer);
  return {
    buffer,
    start,
    length,
    order,
    lineBreaks: countLineBreaks(text, start, start + length),
    visible,
  };
};

const cloneNode = (node: PieceTreeNode): PieceTreeNode => ({
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

const createNode = (
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

const updateNode = (node: PieceTreeNode | null): PieceTreeNode | null => {
  if (!node) return node;
  node.subtreeLength = computeSubtreeLength(node.piece, node.left, node.right);
  node.subtreeVisibleLength = computeSubtreeVisibleLength(node.piece, node.left, node.right);
  node.subtreePieces = computeSubtreePieces(node.left, node.right);
  node.subtreeLineBreaks = computeSubtreeLineBreaks(node.piece, node.left, node.right);
  node.subtreeMinOrder = computeSubtreeMinOrder(node.piece, node.left, node.right);
  node.subtreeMaxOrder = computeSubtreeMaxOrder(node.piece, node.left, node.right);
  return node;
};

const merge = (left: PieceTreeNode | null, right: PieceTreeNode | null): PieceTreeNode | null => {
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

type ReverseIndexChange = {
  remove?: Piece;
  add?: Piece;
};

type SplitContext = {
  changes: ReverseIndexChange[];
  normalizeOrders: boolean;
};

const allocateOrdersBetween = (
  lower: number | null,
  upper: number | null,
  count: number,
): number[] | null => {
  if (count <= 0) return [];

  if (lower === null && upper === null) {
    return Array.from({ length: count }, (_, index) => (index + 1) * PIECE_ORDER_STEP);
  }

  if (upper === null) {
    const start = (lower ?? 0) + PIECE_ORDER_STEP;
    return Array.from({ length: count }, (_, index) => start + index * PIECE_ORDER_STEP);
  }

  if (lower === null) {
    const start = upper - count * PIECE_ORDER_STEP;
    return Array.from({ length: count }, (_, index) => start + index * PIECE_ORDER_STEP);
  }

  const gap = upper - lower;
  if (gap <= PIECE_ORDER_MIN_GAP * (count + 1)) return null;

  const step = gap / (count + 1);
  return Array.from({ length: count }, (_, index) => lower + step * (index + 1));
};

const assignPieceOrders = (
  pieces: readonly Piece[],
  lower: number | null,
  upper: number | null,
): { pieces: Piece[]; normalizeOrders: boolean } => {
  const orders = allocateOrdersBetween(lower, upper, pieces.length);

  if (!orders) {
    return {
      pieces: pieces.map((piece, index) => ({
        ...piece,
        order: (lower ?? 0) + (index + 1) * PIECE_ORDER_MIN_GAP,
      })),
      normalizeOrders: true,
    };
  }

  return {
    pieces: pieces.map((piece, index) => ({ ...piece, order: orders[index] })),
    normalizeOrders: false,
  };
};

const splitByVisibleOffset = (
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

const createTreeFromPieces = (pieces: readonly Piece[]): PieceTreeNode | null => {
  let tree: PieceTreeNode | null = null;

  for (const piece of pieces) {
    tree = merge(tree, createNode(piece));
  }

  return tree;
};

const bufferForPiece = (buffers: PieceTableBuffers, piece: Piece) =>
  getBufferText(buffers, piece.buffer);

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

const appendChunksToBuffers = (buffers: PieceTableBuffers, text: string): Piece[] => {
  const chunks = buffers.chunks as Map<PieceBufferId, string>;
  const pieces: Piece[] = [];
  let textOffset = 0;

  while (textOffset < text.length) {
    const chunkText = text.slice(textOffset, textOffset + BUFFER_CHUNK_SIZE);
    const buffer = createBufferId();
    chunks.set(buffer, chunkText);
    pieces.push({
      buffer,
      start: 0,
      length: chunkText.length,
      order: 0,
      lineBreaks: countLineBreaks(chunkText),
      visible: true,
    });
    textOffset += chunkText.length;
  }

  return pieces;
};

const createInitialBuffers = (original: string): PieceTableBuffers => {
  const originalBuffer = createBufferId();
  const chunks = new Map<PieceBufferId, string>([[originalBuffer, original]]);
  return {
    original: originalBuffer,
    chunks,
  };
};

const createOriginalPiece = (buffers: PieceTableBuffers): Piece | null => {
  const original = getBufferText(buffers, buffers.original);
  if (original.length === 0) return null;

  return {
    buffer: buffers.original,
    start: 0,
    length: original.length,
    order: PIECE_ORDER_STEP,
    lineBreaks: countLineBreaks(original),
    visible: true,
  };
};

const collectTextInRange = (
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

const flattenPieces = (node: PieceTreeNode | null, acc: Piece[]): Piece[] => {
  if (!node) return acc;
  flattenPieces(node.left, acc);
  acc.push({ ...node.piece });
  flattenPieces(node.right, acc);
  return acc;
};

type AnchorLocation = {
  piece: Piece;
  visibleStart: number;
};

const findVisiblePieceEndingAt = (
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

const findVisiblePieceStartingAt = (
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

const findVisiblePieceContainingOffset = (
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

const flattenNodes = (node: PieceTreeNode | null, acc: PieceTreeNode[]): PieceTreeNode[] => {
  if (!node) return acc;
  flattenNodes(node.left, acc);
  acc.push(node);
  flattenNodes(node.right, acc);
  return acc;
};

const compareReverseKeys = (
  leftBuffer: PieceBufferId,
  leftStart: number,
  rightBuffer: PieceBufferId,
  rightStart: number,
): number => {
  if (leftBuffer < rightBuffer) return -1;
  if (leftBuffer > rightBuffer) return 1;
  return leftStart - rightStart;
};

const cloneReverseIndexNode = (node: PieceTableReverseIndexNode): PieceTableReverseIndexNode => ({
  buffer: node.buffer,
  start: node.start,
  piece: node.piece,
  order: node.order,
  priority: node.priority,
  left: node.left,
  right: node.right,
});

const createReverseIndexNode = (piece: Piece): PieceTableReverseIndexNode => ({
  buffer: piece.buffer,
  start: piece.start,
  piece,
  order: piece.order,
  priority: randomPriority(),
  left: null,
  right: null,
});

const rotateReverseRight = (node: PieceTableReverseIndexNode): PieceTableReverseIndexNode => {
  const pivot = cloneReverseIndexNode(node.left!);
  const newRight = cloneReverseIndexNode(node);
  newRight.left = pivot.right;
  pivot.right = newRight;
  return pivot;
};

const rotateReverseLeft = (node: PieceTableReverseIndexNode): PieceTableReverseIndexNode => {
  const pivot = cloneReverseIndexNode(node.right!);
  const newLeft = cloneReverseIndexNode(node);
  newLeft.right = pivot.left;
  pivot.left = newLeft;
  return pivot;
};

const insertReverseIndexNode = (
  root: PieceTableReverseIndexNode | null,
  piece: Piece,
): PieceTableReverseIndexNode => {
  if (!root) return createReverseIndexNode(piece);

  const comparison = compareReverseKeys(piece.buffer, piece.start, root.buffer, root.start);

  if (comparison < 0) {
    const next = cloneReverseIndexNode(root);
    next.left = insertReverseIndexNode(next.left, piece);
    return next.left.priority < next.priority ? rotateReverseRight(next) : next;
  }

  if (comparison > 0) {
    const next = cloneReverseIndexNode(root);
    next.right = insertReverseIndexNode(next.right, piece);
    return next.right.priority < next.priority ? rotateReverseLeft(next) : next;
  }

  return {
    ...root,
    piece,
    order: piece.order,
  };
};

const mergeReverseIndexNodes = (
  left: PieceTableReverseIndexNode | null,
  right: PieceTableReverseIndexNode | null,
): PieceTableReverseIndexNode | null => {
  if (!left) return right;
  if (!right) return left;

  if (left.priority < right.priority) {
    const next = cloneReverseIndexNode(left);
    next.right = mergeReverseIndexNodes(next.right, right);
    return next;
  }

  const next = cloneReverseIndexNode(right);
  next.left = mergeReverseIndexNodes(left, next.left);
  return next;
};

const deleteReverseIndexNode = (
  root: PieceTableReverseIndexNode | null,
  piece: Piece,
): PieceTableReverseIndexNode | null => {
  if (!root) return null;

  const comparison = compareReverseKeys(piece.buffer, piece.start, root.buffer, root.start);

  if (comparison < 0) {
    const next = cloneReverseIndexNode(root);
    next.left = deleteReverseIndexNode(next.left, piece);
    return next;
  }

  if (comparison > 0) {
    const next = cloneReverseIndexNode(root);
    next.right = deleteReverseIndexNode(next.right, piece);
    return next;
  }

  return mergeReverseIndexNodes(root.left, root.right);
};

const applyReverseIndexChanges = (
  root: PieceTableReverseIndexNode | null,
  changes: readonly ReverseIndexChange[],
): PieceTableReverseIndexNode | null => {
  let next = root;

  for (const change of changes) {
    if (change.remove && change.remove.length > 0) {
      next = deleteReverseIndexNode(next, change.remove);
    }
    if (change.add && change.add.length > 0) {
      next = insertReverseIndexNode(next, change.add);
    }
  }

  return next;
};

const normalizePieceOrders = (
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

const createSnapshotWithIndex = (
  buffers: PieceTableBuffers,
  root: PieceTreeNode | null,
  reverseIndexRoot: PieceTableReverseIndexNode | null,
  normalizeOrders: boolean,
): PieceTableTreeSnapshot => {
  if (!normalizeOrders) return createSnapshot(buffers, root, reverseIndexRoot);

  const normalizedRoot = normalizePieceOrders(root, { value: PIECE_ORDER_STEP });
  return createSnapshot(buffers, normalizedRoot, buildReverseIndex(normalizedRoot));
};

const buildReverseIndex = (root: PieceTreeNode | null): PieceTableReverseIndexNode | null => {
  let indexRoot: PieceTableReverseIndexNode | null = null;
  const nodes = flattenNodes(root, []);

  for (const node of nodes) {
    if (node.piece.length === 0) continue;
    indexRoot = insertReverseIndexNode(indexRoot, node.piece);
  }

  return indexRoot;
};

const reversePredecessor = (
  root: PieceTableReverseIndexNode | null,
  buffer: PieceBufferId,
  offset: number,
  strict: boolean,
): PieceTableReverseIndexNode | null => {
  let node = root;
  let candidate: PieceTableReverseIndexNode | null = null;

  while (node) {
    const comparison = compareReverseKeys(node.buffer, node.start, buffer, offset);
    const accepts = strict ? comparison < 0 : comparison <= 0;

    if (accepts) {
      candidate = node;
      node = node.right;
      continue;
    }

    node = node.left;
  }

  if (candidate?.buffer === buffer) return candidate;
  return null;
};

const coversAnchorOffset = (piece: Piece, offset: number): boolean =>
  offset >= piece.start && offset <= piece.start + piece.length;

const lookupReverseIndex = (
  snapshot: PieceTableTreeSnapshot,
  anchor: RealAnchor,
): PieceTableReverseIndexNode | null => {
  const strict = anchor.bias === "left" && anchor.offset > 0;
  const preferred = reversePredecessor(
    snapshot.reverseIndexRoot,
    anchor.buffer,
    anchor.offset,
    strict,
  );

  if (preferred && coversAnchorOffset(preferred.piece, anchor.offset)) return preferred;

  const fallback = reversePredecessor(
    snapshot.reverseIndexRoot,
    anchor.buffer,
    anchor.offset,
    false,
  );
  if (fallback && coversAnchorOffset(fallback.piece, anchor.offset)) return fallback;

  return null;
};

const createSnapshot = (
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

const ensureValidRange = (snapshot: PieceTableTreeSnapshot, start: number, end: number) => {
  if (start < 0 || end < start || end > snapshot.length) {
    throw new RangeError("invalid range");
  }
};

const ensureCodePointBoundary = (snapshot: PieceTableTreeSnapshot, offset: number): void => {
  if (offset <= 0 || offset >= snapshot.length) return;

  const text = getPieceTableText(snapshot, offset - 1, offset + 1);
  const before = text.charCodeAt(0);
  const after = text.charCodeAt(1);
  const beforeIsHighSurrogate = before >= 0xd800 && before <= 0xdbff;
  const afterIsLowSurrogate = after >= 0xdc00 && after <= 0xdfff;

  if (beforeIsHighSurrogate && afterIsLowSurrogate) {
    throw new RangeError("anchor offset must be a code-point boundary");
  }
};

const anchorFromLocation = (
  location: AnchorLocation,
  offset: number,
  bias: AnchorBias,
): RealAnchor => {
  const pieceOffset = offset - location.visibleStart;

  return {
    kind: "anchor",
    buffer: location.piece.buffer,
    offset: location.piece.start + pieceOffset,
    bias,
  };
};

const anchorInEmptySnapshot = (snapshot: PieceTableTreeSnapshot, bias: AnchorBias): RealAnchor => ({
  kind: "anchor",
  buffer: snapshot.buffers.original,
  offset: 0,
  bias,
});

const findAnchorLocation = (
  snapshot: PieceTableTreeSnapshot,
  offset: number,
  bias: AnchorBias,
): AnchorLocation | null => {
  const interior = findVisiblePieceContainingOffset(snapshot.root, offset);
  if (interior) return interior;

  const left = findVisiblePieceEndingAt(snapshot.root, offset);
  const right = findVisiblePieceStartingAt(snapshot.root, offset);

  if (bias === "left") return left ?? right;
  return right ?? left;
};

const markTreeInvisible = (
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

const visiblePrefixBeforeOrder = (
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

const visibleLengthBetweenOrders = (
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

const reverseSuccessor = (
  root: PieceTableReverseIndexNode | null,
  buffer: PieceBufferId,
  offset: number,
): PieceTableReverseIndexNode | null => {
  let node = root;
  let candidate: PieceTableReverseIndexNode | null = null;

  while (node) {
    const comparison = compareReverseKeys(node.buffer, node.start, buffer, offset);

    if (comparison >= 0) {
      candidate = node;
      node = node.left;
      continue;
    }

    node = node.right;
  }

  if (candidate?.buffer === buffer) return candidate;
  return null;
};

const deletedLeftEdgeOffset = (
  snapshot: PieceTableTreeSnapshot,
  entry: PieceTableReverseIndexNode,
  prefix: number,
): number => {
  const previous = reversePredecessor(
    snapshot.reverseIndexRoot,
    entry.piece.buffer,
    entry.piece.start,
    true,
  );
  const lowOrder = previous?.order ?? Number.NEGATIVE_INFINITY;
  return prefix - visibleLengthBetweenOrders(snapshot.root, lowOrder, entry.order);
};

const deletedRightEdgeOffset = (
  snapshot: PieceTableTreeSnapshot,
  entry: PieceTableReverseIndexNode,
  prefix: number,
): number => {
  const next = reverseSuccessor(
    snapshot.reverseIndexRoot,
    entry.piece.buffer,
    entry.piece.start + entry.piece.length,
  );
  const highOrder = next?.order ?? Number.POSITIVE_INFINITY;
  return prefix + visibleLengthBetweenOrders(snapshot.root, entry.order, highOrder);
};

const resolveAnchorAgainstEntry = (
  snapshot: PieceTableTreeSnapshot,
  anchor: RealAnchor,
  entry: PieceTableReverseIndexNode,
): ResolvedAnchor => {
  const prefix = visiblePrefixBeforeOrder(snapshot.root, entry.order);
  if (prefix === null) return { offset: 0, liveness: "deleted" };

  if (entry.piece.visible) {
    return {
      offset: prefix + Math.min(anchor.offset - entry.piece.start, entry.piece.length),
      liveness: "live",
    };
  }

  return {
    offset:
      anchor.bias === "left"
        ? deletedLeftEdgeOffset(snapshot, entry, prefix)
        : deletedRightEdgeOffset(snapshot, entry, prefix),
    liveness: "deleted",
  };
};

const resolveMissingAnchor = (
  snapshot: PieceTableTreeSnapshot,
  anchor: RealAnchor,
): ResolvedAnchor => {
  const originalText = getBufferText(snapshot.buffers, snapshot.buffers.original);
  const isEmptyOriginalAnchor =
    originalText.length === 0 && anchor.buffer === snapshot.buffers.original && anchor.offset === 0;

  if (isEmptyOriginalAnchor) {
    return {
      offset: anchor.bias === "left" ? 0 : snapshot.length,
      liveness: "live",
    };
  }

  return { offset: 0, liveness: "deleted" };
};

const findLinearAnchorNode = (
  snapshot: PieceTableTreeSnapshot,
  anchor: RealAnchor,
): PieceTreeNode | null => {
  const nodes = flattenNodes(snapshot.root, []);
  const candidates = nodes.filter((node) => {
    if (node.piece.buffer !== anchor.buffer) return false;
    return coversAnchorOffset(node.piece, anchor.offset);
  });

  if (candidates.length === 0) return null;

  if (anchor.bias === "left") {
    return candidates.findLast((node) => node.piece.start < anchor.offset) ?? candidates[0];
  }

  return (
    candidates.find((node) => node.piece.start === anchor.offset) ??
    candidates.find((node) => node.piece.start <= anchor.offset) ??
    candidates[0]
  );
};

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

export const createPieceTableSnapshot = (original: string): PieceTableTreeSnapshot => {
  const buffers = createInitialBuffers(original);
  const originalPiece = createOriginalPiece(buffers);
  const root = originalPiece ? createNode(originalPiece) : null;
  return createSnapshot(buffers, root, buildReverseIndex(root));
};

export const getPieceTableLength = (snapshot: PieceTableTreeSnapshot): number => snapshot.length;

export const getPieceTableOriginalText = (snapshot: PieceTableTreeSnapshot): string =>
  getBufferText(snapshot.buffers, snapshot.buffers.original);

export const getPieceTableText = (
  snapshot: PieceTableTreeSnapshot,
  start = 0,
  end?: number,
): string => {
  const effectiveEnd = end ?? snapshot.length;
  ensureValidRange(snapshot, start, effectiveEnd);
  if (start === effectiveEnd) return "";

  const chunks: string[] = [];
  collectTextInRange(snapshot.root, snapshot.buffers, start, effectiveEnd, chunks);
  return chunks.join("");
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

export const anchorAt = (
  snapshot: PieceTableTreeSnapshot,
  offset: number,
  bias: AnchorBias,
): RealAnchor => {
  if (offset < 0 || offset > snapshot.length) {
    throw new RangeError("invalid offset");
  }

  ensureCodePointBoundary(snapshot, offset);

  const location = findAnchorLocation(snapshot, offset, bias);
  if (!location) return anchorInEmptySnapshot(snapshot, bias);

  return anchorFromLocation(location, offset, bias);
};

export const anchorBefore = (snapshot: PieceTableTreeSnapshot, offset: number): RealAnchor =>
  anchorAt(snapshot, offset, "left");

export const anchorAfter = (snapshot: PieceTableTreeSnapshot, offset: number): RealAnchor =>
  anchorAt(snapshot, offset, "right");

export const resolveAnchorLinear = (
  snapshot: PieceTableTreeSnapshot,
  anchor: AnchorType,
): ResolvedAnchor => {
  if (anchor.kind === "min") return { offset: 0, liveness: "live" };
  if (anchor.kind === "max") return { offset: snapshot.length, liveness: "live" };

  const pieceNode = findLinearAnchorNode(snapshot, anchor);
  if (!pieceNode) return resolveMissingAnchor(snapshot, anchor);

  return resolveAnchorAgainstEntry(snapshot, anchor, {
    buffer: pieceNode.piece.buffer,
    start: pieceNode.piece.start,
    piece: pieceNode.piece,
    order: pieceNode.piece.order,
    priority: 0,
    left: null,
    right: null,
  });
};

export const resolveAnchor = (
  snapshot: PieceTableTreeSnapshot,
  anchor: AnchorType,
): ResolvedAnchor => {
  if (anchor.kind === "min") return { offset: 0, liveness: "live" };
  if (anchor.kind === "max") return { offset: snapshot.length, liveness: "live" };

  const indexed = lookupReverseIndex(snapshot, anchor);
  if (!indexed) return resolveAnchorLinear(snapshot, anchor);

  return resolveAnchorAgainstEntry(snapshot, anchor, indexed);
};

export const compareAnchors = (
  snapshot: PieceTableTreeSnapshot,
  left: AnchorType,
  right: AnchorType,
): number => {
  const leftResolved = resolveAnchor(snapshot, left);
  const rightResolved = resolveAnchor(snapshot, right);

  if (leftResolved.offset !== rightResolved.offset)
    return leftResolved.offset - rightResolved.offset;
  if (left.kind !== "anchor" || right.kind !== "anchor") return 0;
  if (left.bias === right.bias) return 0;
  return left.bias === "left" ? -1 : 1;
};

export const debugPieceTable = (snapshot: PieceTableTreeSnapshot): Piece[] =>
  flattenPieces(snapshot.root, []);
