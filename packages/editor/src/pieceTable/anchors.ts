import type {
  Anchor as AnchorType,
  AnchorBias,
  PieceTableReverseIndexNode,
  PieceTableTreeSnapshot,
  PieceTreeNode,
  RealAnchor,
  ResolvedAnchor,
} from "./pieceTableTypes";
import { getBufferText } from "./buffers";
import { getPieceTableText } from "./reads";
import {
  coversAnchorOffset,
  lookupReverseIndex,
  reversePredecessor,
  reverseSuccessor,
} from "./reverseIndex";
import {
  type AnchorLocation,
  findVisiblePieceContainingOffset,
  findVisiblePieceEndingAt,
  findVisiblePieceStartingAt,
  flattenNodes,
  visibleLengthBetweenOrders,
  visiblePrefixBeforeOrder,
} from "./tree";

export const Anchor = {
  MIN: { kind: "min" },
  MAX: { kind: "max" },
} as const satisfies Record<"MIN" | "MAX", AnchorType>;

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
    return findLastNodeStartingBefore(candidates, anchor.offset) ?? candidates[0] ?? null;
  }

  return (
    candidates.find((node) => node.piece.start === anchor.offset) ??
    candidates.find((node) => node.piece.start <= anchor.offset) ??
    candidates[0] ??
    null
  );
};

const findLastNodeStartingBefore = (
  nodes: readonly PieceTreeNode[],
  offset: number,
): PieceTreeNode | null => {
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (node && node.piece.start < offset) return node;
  }

  return null;
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
