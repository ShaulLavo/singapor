import './style.css'

export { createBracketMatchPlugin, EDITOR_BRACKET_MATCH_PLUGIN_ID } from './bracketMatchPlugin'
export type { EditorBracketMatchPluginOptions } from './bracketMatchPlugin'
export {
  bracketJumpTargetOffset,
  collectBracketLevels,
  findBracketMatchAtCaret,
} from './editor/bracketMatching'
export type { BracketLevel, BracketLevelOptions, BracketMatch } from './editor/bracketMatching'
export { createDocumentLinkPlugin, EDITOR_DOCUMENT_LINK_PLUGIN_ID } from './documentLinkPlugin'
export type { EditorDocumentLinkPluginOptions } from './documentLinkPlugin'
export {
  createOccurrenceHighlightPlugin,
  EDITOR_OCCURRENCE_HIGHLIGHT_PLUGIN_ID,
} from './occurrenceHighlightPlugin'
export type { EditorOccurrenceHighlightPluginOptions } from './occurrenceHighlightPlugin'
export {
  createMergeConflictPlugin,
  EDITOR_MERGE_CONFLICT_FEATURE,
  EDITOR_MERGE_CONFLICT_FEATURE_ID,
} from './mergeConflictPlugin'
export type { EditorFindFeature } from './editor/findFeature'
export { Editor } from './editor/Editor'
export {
  observeEditorMountTiming,
  resetEditorInstanceCount,
  setEditorSyntaxSessionFactory,
  setHighlightRegistry,
} from './editor/runtime'
export {
  createEditorConsoleLogger,
  createEditorConsoleLoggingPlugin,
  createEditorLoggingPlugin,
} from './logging'
export {
  createMergeConflictDocumentText,
  parseMergeConflicts,
  resolveMergeConflict,
} from './mergeConflicts'
export type {
  EditorSelectionRevealOptions,
  EditorSelectionRevealTarget,
} from './editor/selectionReveal'
export type {
  EditorChangeHandler,
  EditorDocumentMode,
  EditorEditability,
  EditorEditHistoryMode,
  EditorEditInput,
  EditorEditOptions,
  EditorEditSelection,
  EditorOpenDocumentOptions,
  EditorOptions,
  EditorRangeDecoration,
  EditorScrollMode,
  EditorScrollPosition,
  EditorSelectionSyncMode,
  EditorSessionChangeHandler,
  EditorSessionOptions,
  EditorSetTextOptions,
  EditorState,
  EditorSyntaxSessionFactory,
  EditorSyntaxStatus,
  HighlightRegistry,
} from './editor/types'
export type { EditorCommandContext, EditorCommandId } from './editor/commands'
export {
  defaultEditorCommandPacks,
  defaultEditorKeyBindings,
  defaultEditorKeymapLayers,
  editorCommandPackForCommand,
  editorKeyBindings,
  editorKeyBindingsFromLayers,
  editorKeymapLayerForCommandPack,
  editorKeymapLayers,
  editorKeymapLayersForBindings,
  editorKeymapLayersForCommandPacks,
  filterEditorKeymapLayersByCommandPacks,
  readonlySafeEditorCommandPacks,
} from './editor/keymap'
export type {
  EditorCommandPack,
  EditorKeyBinding,
  EditorKeymapLayer,
  EditorKeymapLayerSource,
  EditorKeymapOptions,
} from './editor/keymap'
export type {
  EditorMergeConflictFeature,
  EditorMergeConflictPluginOptions,
} from './mergeConflictPlugin'
export type {
  BoundedSize,
  EditorBlock,
  EditorBlockAnchor,
  EditorBlockHorizontalSurface,
  EditorBlockMount,
  EditorBlockMountContext,
  EditorBlockProvider,
  EditorBlockProviderContext,
  EditorBlockSize,
  EditorBlockSurfaceSlot,
  EditorBlockVerticalSurface,
  FixedSize,
  MaxSize,
  MinSize,
} from './editorBlocks'
export type {
  CreateMergeConflictDocumentTextOptions,
  MergeConflictRegion,
  MergeConflictResolution,
  MergeConflictResolutionResult,
  MergeConflictSide,
  TextOffsetRange,
} from './mergeConflicts'
export type {
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
} from './virtualization/virtualizedTextViewTypes'
export type { EditorSyntaxTheme, EditorSyntaxThemeColor, EditorTheme } from './theme'
export type { EditorSyntaxProvider } from './syntax'
export type {
  EditorCapabilityContribution,
  EditorCapabilityContributionContext,
  EditorCapabilityContributionProvider,
  EditorCommandContribution,
  EditorCommandContributionContext,
  EditorCommandContributionProvider,
  EditorCommandHandler,
  EditorDecorationContribution,
  EditorDecorationContributionContext,
  EditorDecorationContributionProvider,
  EditorEditContribution,
  EditorEditContributionContext,
  EditorEditContributionProvider,
  EditorDisposable,
  EditorGutterContribution,
  EditorGutterRowContext,
  EditorGutterWidthContext,
  EditorHighlightResult,
  EditorHighlighterProvider,
  EditorHighlighterSession,
  EditorHighlighterSessionOptions,
  EditorInjectedTextRow,
  EditorInjectedTextRowProvider,
  EditorInjectedTextRowProviderContext,
  EditorLogEditorContext,
  EditorLogError,
  EditorLogEvent,
  EditorLogInput,
  EditorLogger,
  EditorLogLevel,
  EditorPlugin,
  EditorPluginContext,
  EditorPluginLifecycleState,
  EditorResolvedSelection,
  EditorSelectionRange,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from './plugins'
