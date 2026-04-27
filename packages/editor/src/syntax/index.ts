export {
  createEditorSyntaxSession,
  isEditorSyntaxLanguage,
  type EditorSyntaxLanguageId,
  type EditorSyntaxResult,
  type EditorSyntaxSession,
  type EditorSyntaxSessionOptions,
} from "./session";
export { styleForTreeSitterCapture, treeSitterCapturesToEditorTokens } from "./captures";
export type {
  BracketInfo,
  FoldRange,
  TreeSitterCapture,
  TreeSitterError,
  TreeSitterParseResult,
  TreeSitterPoint,
} from "./treeSitter/types";
