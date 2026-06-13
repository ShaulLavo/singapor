export type {
  Anchor as PieceTableAnchor,
  AnchorBias,
  AnchorLiveness,
  PieceBufferId,
  PieceTableEdit,
  PieceTableSnapshot,
  Point,
  RealAnchor,
  ResolvedAnchor,
} from './pieceTableTypes'

export type { PieceTableWalker, PieceTableWalkerChunk } from './pieceTable'

export {
  Anchor,
  anchorAfter,
  anchorAt,
  anchorBefore,
  applyBatchToPieceTable,
  compareAnchors,
  createPieceTableSnapshot,
  createPieceTableWalker,
  deleteFromPieceTable,
  debugPieceTable,
  diffPieceTableSnapshots,
  forEachPieceTableTextChunk,
  getPieceTableLength,
  insertIntoPieceTable,
  materializePieceTableFullText,
  offsetToPoint,
  pieceTableSnapshotsHaveSameText,
  pointToOffset,
  readPieceTableTextRange,
  resolveAnchor,
  resolveAnchorLinear,
  streamPieceTablePieces,
  streamPieceTableTextChunks,
} from './pieceTable'
