import type { Piece, PieceTableTreeSnapshot } from './pieceTableTypes'
import { flattenPieces } from './tree'

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
  readPieceTableTextRange,
  materializePieceTableFullText,
  forEachPieceTableTextChunk,
  pieceTableSnapshotsHaveSameText,
  streamPieceTablePieces,
  streamPieceTableTextChunks,
} from './reads'
export { createPieceTableSnapshot } from './snapshot'
export {
  applyDocumentLineEnding,
  DEFAULT_DOCUMENT_LINE_ENDING,
  detectDocumentLineEnding,
  hasByteOrderMark,
  normalizeDocumentText,
  normalizeLineEndings,
  UTF8_BYTE_ORDER_MARK,
  type DocumentLineEnding,
  type NormalizedDocumentText,
} from './lineEndings'
export {
  pieceTableByteOrderMark,
  pieceTableContainsUnusualLineTerminators,
  pieceTableDocumentText,
  pieceTableLineEnding,
  type PieceTableDocumentTextOptions,
} from './documentText'
export { createPieceTableWalker, type PieceTableWalker, type PieceTableWalkerChunk } from './walker'

export const debugPieceTable = (snapshot: PieceTableTreeSnapshot): Piece[] =>
  flattenPieces(snapshot.root, [])
