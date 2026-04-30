export {
  Editor,
  resetEditorInstanceCount,
  setEditorSyntaxSessionFactory,
  setHighlightRegistry,
} from "./editor";
export * from "./documentSession";
export * from "./displayTransforms";
export * from "./foldMap";
export * from "./history";
export * from "./pieceTable";
export * from "./plugins";
export * from "./selections";
export * from "./syntax";
export * from "./theme";
export * from "./virtualization";
export type { EditorCommandContext, EditorCommandId } from "./editor/commands";
export type { EditorKeyBinding, EditorKeymapOptions } from "./editor/keymap";
export type {
  EditorChangeHandler,
  EditorEditHistoryMode,
  EditorEditInput,
  EditorEditOptions,
  EditorEditSelection,
  EditorOpenDocumentOptions,
  EditorOptions,
  EditorSetTextOptions,
  EditorState,
  EditorSyntaxSessionFactory,
  EditorSyntaxStatus,
  HighlightRegistry,
} from "./editor";
export type { EditorDocument, EditorToken, EditorTokenStyle, TextEdit } from "./tokens";
export type { EditorSyntaxTheme, EditorSyntaxThemeColor, EditorTheme } from "./theme";
