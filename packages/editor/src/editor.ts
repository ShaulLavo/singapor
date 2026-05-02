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
export type {
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
} from "./virtualization/virtualizedTextViewTypes";
export type { EditorSyntaxTheme, EditorSyntaxThemeColor, EditorTheme } from "./theme";
export type { EditorSyntaxProvider } from "./syntax";
export type {
  EditorDisposable,
  EditorGutterContribution,
  EditorGutterRowContext,
  EditorGutterWidthContext,
  EditorHighlightResult,
  EditorHighlighterProvider,
  EditorHighlighterSession,
  EditorHighlighterSessionOptions,
  EditorCommandHandler,
  EditorFeatureContribution,
  EditorFeatureContributionContext,
  EditorFeatureContributionProvider,
  EditorPlugin,
  EditorPluginContext,
  EditorResolvedSelection,
  EditorSelectionRange,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from "./plugins";
