export {
  FixedRowVirtualizer,
  computeFixedRowTotalSize,
  computeFixedRowVisibleRange,
  computeFixedRowVirtualItems,
} from "./fixedRowVirtualizer";
export { measureBrowserTextMetrics } from "./browserMetrics";
export { VirtualizedTextView } from "./virtualizedTextView";
export type { BrowserTextMetrics } from "./browserMetrics";
export type { VirtualizedTextSelection } from "./virtualizedTextViewInternals";
export type {
  FixedRowScrollMetrics,
  FixedRowVirtualItem,
  FixedRowVirtualizerChangeHandler,
  FixedRowVirtualizerOptions,
  FixedRowVirtualizerSnapshot,
  FixedRowVisibleRange,
} from "./fixedRowVirtualizer";
export type {
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
  HighlightRegistry as VirtualizedTextHighlightRegistry,
  NativeGeometryValidation,
  VirtualizedFoldMarker,
  VirtualizedTextChunk,
  VirtualizedTextHighlightRange,
  VirtualizedTextHighlightStyle,
  VirtualizedTextRow,
  VirtualizedTextViewOptions,
  VirtualizedTextViewState,
} from "./virtualizedTextViewTypes";
