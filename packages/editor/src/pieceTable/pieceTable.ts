import type {
  AnchorBias,
  Piece,
  PieceTableEdit,
  PieceTableTreeSnapshot,
  RealAnchor,
  ResolvedAnchor,
} from "./pieceTableTypes";
import { flattenPieces } from "./tree";

export type { AnchorBias, RealAnchor, ResolvedAnchor, PieceTableEdit };

export {
  Anchor,
  anchorAfter,
  anchorAt,
  anchorBefore,
  compareAnchors,
  resolveAnchor,
  resolveAnchorLinear,
} from "./anchors";
export { applyBatchToPieceTable, deleteFromPieceTable, insertIntoPieceTable } from "./edits";
export { offsetToPoint, pointToOffset } from "./positions";
export { getPieceTableLength, getPieceTableOriginalText, getPieceTableText } from "./reads";
export { createPieceTableSnapshot } from "./snapshot";

export const debugPieceTable = (snapshot: PieceTableTreeSnapshot): Piece[] =>
  flattenPieces(snapshot.root, []);
