import type { Piece } from "./pieceTableTypes";

export type ReverseIndexChange = {
  remove?: Piece;
  add?: Piece;
};

export type SplitContext = {
  changes: ReverseIndexChange[];
  normalizeOrders: boolean;
};
