/**
 * @deprecated Temporary Phase 1 bridge for workspace packages while internals are migrated behind
 * typed public contracts. Remove these exports in the phase that owns each subsystem.
 */
export {
  createAnchorSelection,
  createSelectionSet,
  normalizeSelectionSet,
  resolveSelection,
} from './selections'
export {
  documentSessionChangeTextSnapshot,
  withDocumentSessionChangeTimings,
} from './documentSession'
export { defineLazyFullTextProperty } from './documentTextSnapshot'
export { parseSnippet, snippetInitialSelection } from './editor/snippet'
export { wordRangeAtOffset } from './textRanges'
export type { ParsedSnippet, SnippetRange, SnippetStop } from './editor/snippet'
export { EditorWorkScheduler } from './editor/workScheduler'
export { VirtualizedTextView } from './virtualization'
export type {
  EditorDocumentContributionContext,
  EditorFeatureContribution,
  EditorFeatureContributionContext,
  EditorFeatureContributionProvider,
  EditorFeatureDomContributionContext,
  EditorInternalPluginContext,
  EditorRangeHighlightContributionContext,
  EditorRowDecorationContributionContext,
  EditorSelectionContributionContext,
} from './plugins'
export type {
  EditorScheduleWorkOptions,
  EditorScheduledWorkHandle,
  EditorWorkContext,
  EditorWorkEvent,
  EditorWorkEventType,
  EditorWorkPriority,
  EditorWorkSchedulerOptions,
  EditorWorkTags,
  EditorWorkTaskClass,
} from './editor/workScheduler'
export type { AnchorSelection, SelectionAffinity, SelectionSet } from './selections'
export type { PieceTableAnchor } from './pieceTable'
export type { VirtualizedTextViewState } from './virtualization'
