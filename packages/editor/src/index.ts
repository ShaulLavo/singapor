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
export * from "./virtualization";
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
