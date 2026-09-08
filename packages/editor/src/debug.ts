// Opt-in diagnostics. Importing the document/editor facade never loads inspection code.
export { debugPieceTable } from './pieceTable'
export type { PieceBufferId, PieceTableSnapshot } from './pieceTable'
export { validatePieceTreeInvariants } from './pieceTable/inspection'
export type {
  PieceTreeIssue,
  PieceTreeIssueKind,
  PieceTreeValidation,
} from './pieceTable/inspection'
export { createPieceTreeInspectionSession } from './pieceTable/inspectionSession'
export type {
  PieceInspectionNode,
  PieceTreeInspection,
  PieceNodeChange,
  PieceTreeComparison,
  PieceInspectionOptions,
} from './pieceTable/inspectionSession'
export {
  formatPieceTree,
  formatPieceTreeInspection,
  formatPieceInspectionNode,
} from './pieceTable/inspectionFormat'
export { getPieceTreeSnapshot } from './documentTextSnapshot'
