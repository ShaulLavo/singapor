import type { EditorGutterContribution } from "../plugins";
import type { EditorTokenStyle } from "../tokens";
import type { BlockRow } from "../displayTransforms";
import type { BrowserTextMetrics } from "./browserMetrics";
import type { FixedRowVisibleRange } from "./fixedRowVirtualizer";

export type CaretPositionResult = {
  readonly offsetNode: Node;
  readonly offset: number;
};

export type DocumentWithCaretHitTesting = Document & {
  readonly caretPositionFromPoint?: (x: number, y: number) => CaretPositionResult | null;
  readonly caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

export type VirtualizedTextViewOptions = {
  readonly rowHeight?: number;
  readonly overscan?: number;
  readonly className?: string;
  readonly gutterWidth?: number;
  readonly longLineChunkSize?: number;
  readonly longLineChunkThreshold?: number;
  readonly horizontalOverscanColumns?: number;
  readonly selectionHighlightName?: string;
  readonly highlightRegistry?: HighlightRegistry;
  readonly onFoldToggle?: (marker: VirtualizedFoldMarker) => void;
  readonly onViewportChange?: () => void;
  readonly wrap?: boolean;
  readonly blockRows?: readonly BlockRow[];
  readonly gutterContributions?: readonly EditorGutterContribution[];
  readonly cursorLineHighlight?: EditorCursorLineHighlightOptions;
  readonly hiddenCharacters?: HiddenCharactersMode;
};

export type HiddenCharactersMode = "hidden" | "show" | "show-on-selection";

export type VirtualizedTextHighlightRange = {
  readonly start: number;
  readonly end: number;
};

export type VirtualizedTextHighlightStyle = {
  readonly backgroundColor: string;
  readonly color?: string;
};

export type EditorCursorLineHighlightOptions = {
  readonly gutterNumber?: boolean;
  readonly gutterBackground?: boolean | readonly string[];
  readonly rowBackground?: boolean;
};

export type VirtualizedTextChunk = {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly localStart: number;
  readonly localEnd: number;
  readonly text: string;
  readonly element: HTMLSpanElement | null;
  readonly textNode: Text;
};

export type VirtualizedFoldMarker = {
  readonly key: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startRow: number;
  readonly endRow: number;
  readonly collapsed: boolean;
};

export type VirtualizedTextRow = {
  readonly index: number;
  readonly bufferRow: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
  readonly kind: "text" | "block";
  readonly chunks: readonly VirtualizedTextChunk[];
  readonly element: HTMLDivElement;
  readonly textNode: Text;
};

export type VirtualizedTextViewState = {
  readonly lineCount: number;
  readonly contentWidth: number;
  readonly foldMapActive: boolean;
  readonly metrics: BrowserTextMetrics;
  readonly scrollHeight: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly scrollWidth: number;
  readonly borderBoxHeight: number;
  readonly borderBoxWidth: number;
  readonly totalHeight: number;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
  readonly visibleRange: FixedRowVisibleRange;
  readonly mountedRows: readonly VirtualizedTextRow[];
  readonly wrapActive: boolean;
  readonly blockRowCount: number;
};

export type NativeGeometryValidation = {
  readonly mountedRows: number;
  readonly caretChecks: number;
  readonly selectionChecks: number;
  readonly hitTestChecks: number;
  readonly failures: readonly string[];
  readonly ok: boolean;
};

export interface HighlightRegistry {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

export type TokenGroup = {
  readonly name: string;
  readonly highlight: Highlight;
  readonly style: EditorTokenStyle;
  readonly styleKey: string;
};

export type TokenRowSegment = {
  readonly chunk: VirtualizedTextChunk;
  readonly start: number;
  readonly end: number;
  readonly style: EditorTokenStyle;
  readonly styleKey: string;
};

export type MountedVirtualizedTextRow = VirtualizedTextRow & {
  readonly gutterElement: HTMLDivElement;
  readonly gutterCells: Map<string, HTMLElement>;
  readonly leftSpacerElement: HTMLSpanElement;
  readonly foldPlaceholderElement: HTMLSpanElement;
  readonly hiddenCharactersLayerElement: HTMLDivElement;
  readonly top: number;
  readonly height: number;
  readonly textRevision: number;
  readonly tokenHighlightSlotId: number;
  readonly chunkKey: string;
  readonly hiddenCharactersKey: string;
  readonly foldMarkerKey: string;
  readonly foldCollapsed: boolean;
  readonly displayKind: "text" | "block";
};

export type SameLineEditPatch = {
  readonly rowIndex: number;
  readonly localFrom: number;
  readonly deleteLength: number;
  readonly text: string;
};

export type HorizontalChunkWindow = {
  readonly start: number;
  readonly end: number;
};

export type OffsetRange = {
  readonly start: number;
  readonly end: number;
};
