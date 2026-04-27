import type { Piece } from "./pieceTableTypes";

export const PIECE_ORDER_STEP = 1024;
export const PIECE_ORDER_MIN_GAP = 1e-9;

export const allocateOrdersBetween = (
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

export const assignPieceOrders = (
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
    pieces: pieces.map((piece, index) => ({ ...piece, order: orders[index]! })),
    normalizeOrders: false,
  };
};
