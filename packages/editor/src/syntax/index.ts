export {
  createEmptySyntaxResult,
  createEmptySyntaxSession,
  createEditorSyntaxSession,
  isEditorSyntaxLanguage,
  type BracketInfo,
  type EditorSyntaxCapture,
  type EditorSyntaxError,
  type EditorSyntaxInjection,
  type EditorSyntaxLanguageId,
  type EditorSyntaxProvider,
  type EditorSyntaxResult,
  type EditorSyntaxSession,
  type EditorSyntaxSessionOptions,
  type FoldRange,
} from "./session";
export { styleForTreeSitterCapture, treeSitterCapturesToEditorTokens } from "./captures";
