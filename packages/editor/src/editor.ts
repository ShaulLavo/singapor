export {
  Editor,
  resetEditorInstanceCount,
  setEditorSyntaxSessionFactory,
  setHighlightRegistry,
} from "./editor/Editor";
export type {
  EditorChangeHandler,
  EditorEditHistoryMode,
  EditorEditInput,
  EditorEditOptions,
  EditorEditSelection,
  EditorOpenDocumentOptions,
  EditorOptions,
  EditorScrollPosition,
  EditorSessionChangeHandler,
  EditorSessionOptions,
  EditorSetTextOptions,
  EditorState,
  EditorSyntaxSessionFactory,
  EditorSyntaxStatus,
  HighlightRegistry,
} from "./editor/types";
export type { EditorCommandContext, EditorCommandId } from "./editor/commands";
export type { EditorKeyBinding, EditorKeymapOptions } from "./editor/keymap";
export type { EditorSyntaxTheme, EditorSyntaxThemeColor, EditorTheme } from "./theme";
export type {
  EditorDisposable,
  EditorGutterContribution,
  EditorGutterRowContext,
  EditorGutterWidthContext,
  EditorHighlightResult,
  EditorHighlighterProvider,
  EditorHighlighterSession,
  EditorHighlighterSessionOptions,
  EditorPlugin,
  EditorPluginContext,
  EditorResolvedSelection,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from "./plugins";
export {
  createFoldGutterPlugin,
  createLineGutterPlugin,
  type FoldGutterIcon,
  type FoldGutterIconContext,
  type FoldGutterPluginOptions,
  type LineGutterPluginOptions,
} from "./gutters";
