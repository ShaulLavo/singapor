export {
  Editor,
  resetEditorInstanceCount,
  setEditorSyntaxSessionFactory,
  setHighlightRegistry,
} from "./editor";
export * from "./documentSession";
export * from "./history";
export * from "./pieceTable";
export * from "./selections";
export * from "./syntax";
export type {
  EditorChangeHandler,
  EditorOpenDocumentOptions,
  EditorOptions,
  EditorState,
  EditorSyntaxSessionFactory,
  EditorSyntaxStatus,
  HighlightRegistry,
} from "./editor";
export type { EditorDocument, EditorToken, EditorTokenStyle, TextEdit } from "./tokens";
