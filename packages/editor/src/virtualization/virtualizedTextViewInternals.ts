import type { FoldMap } from "../foldMap";
import type { BlockRow, DisplayRow } from "../displayTransforms";
import type { EditorGutterContribution } from "../plugins";
import type { EditorToken, EditorTokenStyle } from "../tokens";
import type { BrowserTextMetrics } from "./browserMetrics";
import type { FixedRowVirtualizer } from "./fixedRowVirtualizer";
import type {
  HighlightRegistry,
  MountedVirtualizedTextRow,
  TokenGroup,
  VirtualizedFoldMarker,
} from "./virtualizedTextViewTypes";

export type RevealBlock = "nearest" | "end";

export type CreateRangeOptions = {
  readonly scrollIntoView?: boolean;
};

export type TokenRenderEntry = {
  readonly start: number;
  readonly end: number;
  readonly style: EditorTokenStyle;
  readonly styleKey: string;
  readonly sourceIndex: number;
};

export interface VirtualizedTextViewInternal {
  readonly scrollElement: HTMLDivElement;
  readonly inputElement: HTMLTextAreaElement;
  readonly spacer: HTMLDivElement;
  readonly gutterElement: HTMLDivElement;
  readonly gutterContributions: readonly EditorGutterContribution[];
  readonly caretElement: HTMLDivElement;
  readonly styleEl: HTMLStyleElement;
  readonly virtualizer: FixedRowVirtualizer;
  readonly longLineChunkSize: number;
  readonly longLineChunkThreshold: number;
  readonly horizontalOverscanColumns: number;
  readonly onFoldToggle: ((marker: VirtualizedFoldMarker) => void) | null;
  readonly onViewportChange: (() => void) | null;
  readonly rowElements: Map<number, MountedVirtualizedTextRow>;
  readonly rowPool: MountedVirtualizedTextRow[];
  readonly highlightRegistry: HighlightRegistry | null;
  readonly selectionHighlightName: string;
  readonly selectionHighlight: Highlight | null;
  selectionHighlightRegistered: boolean;
  text: string;
  textRevision: number;
  tokens: readonly EditorToken[];
  tokenRenderEntries: readonly TokenRenderEntry[];
  tokenRenderEntryMaxEnds: readonly number[];
  tokenRenderStyles: ReadonlyMap<string, EditorTokenStyle>;
  tokenRenderIndexDirty: boolean;
  lineStarts: number[];
  displayRows: DisplayRow[];
  foldMap: FoldMap | null;
  foldMarkers: readonly VirtualizedFoldMarker[];
  foldMarkerByStartRow: ReadonlyMap<number, VirtualizedFoldMarker>;
  foldMarkerByKey: ReadonlyMap<string, VirtualizedFoldMarker>;
  blockRows: readonly BlockRow[];
  wrapEnabled: boolean;
  currentWrapColumn: number | null;
  tokenGroups: Map<string, TokenGroup>;
  rowTokenSignatures: Map<number, string>;
  rowTokenRanges: Map<number, Map<string, readonly AbstractRange[]>>;
  nextTokenGroupId: number;
  nextTokenHighlightSlotId: number;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionHead: number | null;
  lastSelectionHighlightSignature: string;
  lastRenderedRowsKey: string;
  gutterWidthDirty: boolean;
  currentGutterWidth: number;
  contentWidth: number;
  maxVisualColumnsSeen: number;
  lastWidthScanStart: number;
  lastWidthScanEnd: number;
  tokenRangesFollowLastTextEdit: boolean;
  metrics: BrowserTextMetrics;
}
