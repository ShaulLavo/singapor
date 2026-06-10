import type {
  AnchorBias,
  Piece,
  PieceTableEdit,
  PieceTableTreeSnapshot,
  RealAnchor,
  ResolvedAnchor,
} from './pieceTableTypes'
import { flattenPieces } from './tree'

export type { AnchorBias, RealAnchor, ResolvedAnchor, PieceTableEdit }

export {
  Anchor,
  anchorAfter,
  anchorAt,
  anchorBefore,
  compareAnchors,
  resolveAnchor,
  resolveAnchorLinear,
} from './anchors'
export { diffPieceTableSnapshots } from './diff'
export { applyBatchToPieceTable, deleteFromPieceTable, insertIntoPieceTable } from './edits'
export { offsetToPoint, pointToOffset } from './positions'
export {
  getPieceTableLength,
  getPieceTableOriginalText,
  readPieceTableTextRange,
  materializePieceTableFullText,
  forEachPieceTableTextChunk,
  pieceTableSnapshotsHaveSameText,
  streamPieceTablePieces,
  streamPieceTableTextChunks,
} from './reads'
export { createPieceTableSnapshot } from './snapshot'
export {
  createPieceTableWalker,
  type PieceTableWalker,
  type PieceTableWalkerChunk,
} from './walker'

export const debugPieceTable = (snapshot: PieceTableTreeSnapshot): Piece[] =>
  flattenPieces(snapshot.root, [])
