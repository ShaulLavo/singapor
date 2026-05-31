export {
  FixedRowVirtualizer,
  computeFixedRowTotalSize,
  computeFixedRowVisibleRange,
  computeFixedRowVirtualItems,
} from './fixedRowVirtualizer'
export { clearBrowserTextMetricsCache, measureBrowserTextMetrics } from './browserMetrics'
export { VirtualizedTextView } from './virtualizedTextView'
export type { BrowserTextMetrics } from './browserMetrics'
export type { VirtualizedTextSelection } from './virtualizedTextViewInternals'
export type {
  FixedRowScrollMetrics,
  FixedRowScrollMode,
  FixedRowVirtualItem,
  FixedRowVirtualizerChangeHandler,
  FixedRowVirtualizerOptions,
  FixedRowVirtualizerSnapshot,
  FixedRowVisibleRange,
} from './fixedRowVirtualizer'
export type {
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
  HighlightRegistry as VirtualizedTextHighlightRegistry,
  NativeGeometryValidation,
  VirtualizedBlockLaneMount,
  VirtualizedBlockLaneMountContext,
  VirtualizedBlockRowDisposable,
  VirtualizedBlockRowMount,
  VirtualizedBlockRowMountContext,
  VirtualizedFoldMarker,
  VirtualizedTextChunk,
  VirtualizedTextHighlightRange,
  VirtualizedTextHighlightStyle,
  VirtualizedTextRowDecoration,
  VirtualizedTextRow,
  VirtualizedTextViewOptions,
  VirtualizedTextViewScrollMode,
  VirtualizedTextViewState,
} from './virtualizedTextViewTypes'
