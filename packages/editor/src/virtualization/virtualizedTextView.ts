import {
  bufferPointToFoldPoint,
  foldPointToBufferPoint,
  type FoldMap,
  type FoldPoint,
} from "../foldMap";
import type { EditorToken, EditorTokenStyle, TextEdit } from "../tokens";
import {
  buildHighlightRule,
  clamp,
  normalizeTokenStyle,
  serializeTokenStyle,
} from "../style-utils";
import { measureBrowserTextMetrics, type BrowserTextMetrics } from "./browserMetrics";
import {
  FixedRowVirtualizer,
  type FixedRowVirtualItem,
  type FixedRowVirtualizerOptions,
  type FixedRowVirtualizerSnapshot,
  type FixedRowVisibleRange,
} from "./fixedRowVirtualizer";

type CaretPositionResult = {
  readonly offsetNode: Node;
  readonly offset: number;
};

type DocumentWithCaretHitTesting = Document & {
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
  readonly chunks: readonly VirtualizedTextChunk[];
  readonly element: HTMLDivElement;
  readonly textNode: Text;
};

export type VirtualizedTextViewState = {
  readonly lineCount: number;
  readonly contentWidth: number;
  readonly foldMapActive: boolean;
  readonly metrics: BrowserTextMetrics;
  readonly totalHeight: number;
  readonly visibleRange: FixedRowVisibleRange;
  readonly mountedRows: readonly VirtualizedTextRow[];
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

type TokenGroup = {
  readonly name: string;
  readonly highlight: Highlight;
  readonly style: EditorTokenStyle;
  readonly styleKey: string;
  readonly rowSlotId: number;
};

type TokenRowSegment = {
  readonly chunk: VirtualizedTextChunk;
  readonly start: number;
  readonly end: number;
  readonly style: EditorTokenStyle;
  readonly styleKey: string;
};

type MountedVirtualizedTextRow = VirtualizedTextRow & {
  readonly gutterElement: HTMLDivElement;
  readonly gutterLabelElement: HTMLSpanElement;
  readonly foldButtonElement: HTMLButtonElement;
  readonly leftSpacerElement: HTMLSpanElement;
  readonly foldPlaceholderElement: HTMLSpanElement;
  readonly top: number;
  readonly height: number;
  readonly textRevision: number;
  readonly tokenHighlightSlotId: number;
  readonly chunkKey: string;
  readonly foldMarkerKey: string;
  readonly foldCollapsed: boolean;
};

type SameLineEditPatch = {
  readonly rowIndex: number;
  readonly localFrom: number;
  readonly deleteLength: number;
  readonly text: string;
};

type HorizontalChunkWindow = {
  readonly start: number;
  readonly end: number;
};

type OffsetRange = {
  readonly start: number;
  readonly end: number;
};

const DEFAULT_ROW_HEIGHT = 20;
const DEFAULT_OVERSCAN = 24;
// TODO: Size the gutter to the widest visible row marker instead of a constant.
const DEFAULT_GUTTER_WIDTH = 36;
const DEFAULT_SELECTION_HIGHLIGHT = "editor-virtualized-selection";
const DEFAULT_LONG_LINE_CHUNK_SIZE = 2048;
const DEFAULT_LONG_LINE_CHUNK_THRESHOLD = 4096;
const DEFAULT_HORIZONTAL_OVERSCAN_COLUMNS = 256;

export class VirtualizedTextView {
  public readonly scrollElement: HTMLDivElement;
  public readonly inputElement: HTMLTextAreaElement;

  private readonly spacer: HTMLDivElement;
  private readonly gutterElement: HTMLDivElement;
  private readonly caretElement: HTMLDivElement;
  private readonly styleEl: HTMLStyleElement;
  private readonly virtualizer: FixedRowVirtualizer;
  private readonly longLineChunkSize: number;
  private readonly longLineChunkThreshold: number;
  private readonly horizontalOverscanColumns: number;
  private readonly onFoldToggle: ((marker: VirtualizedFoldMarker) => void) | null;
  private readonly rowElements = new Map<number, MountedVirtualizedTextRow>();
  private readonly highlightRegistry: HighlightRegistry | null;
  private readonly selectionHighlightName: string;
  private readonly selectionHighlight: Highlight | null;
  private selectionHighlightRegistered = false;
  private text = "";
  private textRevision = 0;
  private tokens: readonly EditorToken[] = [];
  private lineStarts: number[] = [0];
  private foldMap: FoldMap | null = null;
  private foldMarkers: readonly VirtualizedFoldMarker[] = [];
  private tokenGroups = new Map<string, TokenGroup>();
  private rowTokenSignatures = new Map<number, string>();
  private nextTokenGroupId = 0;
  private nextTokenHighlightSlotId = 0;
  private selectionStart: number | null = null;
  private selectionEnd: number | null = null;
  private lastRenderedRowsKey = "";
  private contentWidth = 0;
  private maxVisualColumnsSeen = 0;
  private lastWidthScanStart = 0;
  private lastWidthScanEnd = -1;
  private tokenRangesFollowLastTextEdit = false;
  private metrics: BrowserTextMetrics = {
    rowHeight: DEFAULT_ROW_HEIGHT,
    characterWidth: 8,
  };

  public constructor(container: HTMLElement, options: VirtualizedTextViewOptions = {}) {
    const overscan = options.overscan ?? DEFAULT_OVERSCAN;
    const gutterWidth = normalizeGutterWidth(options.gutterWidth);

    this.highlightRegistry = options.highlightRegistry ?? getDefaultHighlightRegistry();
    this.selectionHighlightName = options.selectionHighlightName ?? DEFAULT_SELECTION_HIGHLIGHT;
    this.selectionHighlight = new Highlight();
    this.styleEl = container.ownerDocument.createElement("style");
    this.scrollElement = createScrollElement(container, options.className);
    this.metrics = measureBrowserTextMetrics(this.scrollElement);
    const rowHeight = normalizeRowHeight(options.rowHeight ?? this.metrics.rowHeight);
    this.metrics = { ...this.metrics, rowHeight };
    this.inputElement = createInputElement(container);
    this.spacer = container.ownerDocument.createElement("div");
    this.gutterElement = container.ownerDocument.createElement("div");
    this.caretElement = container.ownerDocument.createElement("div");
    this.longLineChunkSize = normalizeChunkSize(options.longLineChunkSize);
    this.longLineChunkThreshold = normalizeChunkThreshold(
      options.longLineChunkThreshold,
      this.longLineChunkSize,
    );
    this.horizontalOverscanColumns = normalizeHorizontalOverscan(options.horizontalOverscanColumns);
    this.onFoldToggle = options.onFoldToggle ?? null;
    this.virtualizer = new FixedRowVirtualizer(createVirtualizerOptions(rowHeight, overscan));

    this.scrollElement.style.setProperty("--editor-gutter-width", `${gutterWidth}px`);
    this.spacer.className = "editor-virtualized-spacer";
    this.gutterElement.className = "editor-virtualized-gutter";
    this.caretElement.className = "editor-virtualized-caret";
    this.caretElement.hidden = true;
    this.spacer.appendChild(this.gutterElement);
    this.spacer.appendChild(this.caretElement);
    this.scrollElement.appendChild(this.spacer);
    this.scrollElement.appendChild(this.inputElement);
    container.ownerDocument.head.appendChild(this.styleEl);

    this.virtualizer.attachScrollElement(this.scrollElement, (snapshot) => {
      this.renderSnapshot(snapshot);
    });
    this.rebuildStyleRules();
  }

  public dispose(): void {
    this.clearSelectionHighlight();
    this.clearTokenHighlights();
    this.virtualizer.dispose();
    this.scrollElement.remove();
    this.styleEl.remove();
    this.rowElements.clear();
  }

  public setText(text: string): void {
    this.text = text;
    this.textRevision += 1;
    this.tokenRangesFollowLastTextEdit = false;
    this.lineStarts = computeLineStarts(text);
    this.foldMap = foldMapMatchesText(this.foldMap, text) ? this.foldMap : null;
    this.clampStoredSelection();
    this.rowTokenSignatures.clear();
    this.lastRenderedRowsKey = "";
    this.resetContentWidthScan();
    this.virtualizer.updateOptions({ count: this.visibleLineCount() });
  }

  public setFoldMap(foldMap: FoldMap | null): void {
    this.foldMap = foldMapMatchesText(foldMap, this.text) ? foldMap : null;
    this.rowTokenSignatures.clear();
    this.lastRenderedRowsKey = "";
    this.virtualizer.updateOptions({ count: this.visibleLineCount() });
  }

  public setFoldMarkers(markers: readonly VirtualizedFoldMarker[]): void {
    this.foldMarkers = normalizeFoldMarkers(markers, this.text.length);
    this.lastRenderedRowsKey = "";
    this.renderSnapshot(this.virtualizer.getSnapshot());
  }

  public refreshMetrics(): BrowserTextMetrics {
    const measured = measureBrowserTextMetrics(this.scrollElement);
    const rowHeight = normalizeRowHeight(measured.rowHeight);
    this.metrics = { rowHeight, characterWidth: measured.characterWidth };
    this.lastRenderedRowsKey = "";
    this.virtualizer.updateOptions({ rowHeight });
    return this.metrics;
  }

  public applyEdit(edit: TextEdit, nextText: string): void {
    const patch = this.sameLineEditPatch(edit);
    if (!patch) {
      this.setText(nextText);
      return;
    }

    this.applySameLineEdit(patch, nextText);
  }

  public setTokens(tokens: readonly EditorToken[]): void {
    if (editorTokensEqual(this.tokens, tokens)) return;

    if (this.canKeepLiveTokenRanges(tokens)) {
      this.tokens = [...tokens];
      this.tokenRangesFollowLastTextEdit = false;
      return;
    }

    this.tokenRangesFollowLastTextEdit = false;
    this.tokens = [...tokens];
    this.syncTokenGroupsToTokenSet();
    this.renderTokenHighlights();
  }

  public setEditable(editable: boolean): void {
    if (editable) {
      this.inputElement.readOnly = false;
      return;
    }

    this.inputElement.readOnly = true;
  }

  public focusInput(): void {
    if (this.inputElement.readOnly) return;

    this.inputElement.value = "";
    this.inputElement.focus({ preventScroll: true });
    this.inputElement.setSelectionRange(0, 0);
    this.inputElement.ownerDocument.getSelection()?.removeAllRanges();
  }

  public setScrollMetrics(scrollTop: number, viewportHeight: number): void {
    this.virtualizer.setScrollMetrics({ scrollTop, viewportHeight });
  }

  public scrollToRow(row: number): void {
    const target = clamp(Math.floor(row), 0, this.visibleLineCount() - 1);
    this.scrollElement.scrollTop = target * this.getRowHeight();
    this.virtualizer.setScrollMetrics({
      scrollTop: this.scrollElement.scrollTop,
      viewportHeight: this.scrollElement.clientHeight,
    });
  }

  public createRange(startOffset: number, endOffset: number): Range | null {
    this.ensureOffsetMounted(startOffset);

    const start = this.resolveMountedOffset(startOffset);
    const end = this.resolveMountedOffset(endOffset);
    if (!start || !end) return null;

    const range = this.scrollElement.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  public getState(): VirtualizedTextViewState {
    const snapshot = this.virtualizer.getSnapshot();
    return {
      lineCount: this.lineStarts.length,
      contentWidth: this.contentWidth,
      foldMapActive: this.foldMap !== null,
      metrics: this.metrics,
      totalHeight: snapshot.totalSize,
      visibleRange: snapshot.visibleRange,
      mountedRows: this.getMountedRows(),
    };
  }

  public validateMountedNativeGeometry(): NativeGeometryValidation {
    const failures: string[] = [];
    const rows = this.getMountedRows();
    const caretChecks = countValidCaretChecks(rows, failures);
    const selectionChecks = countValidSelectionChecks(rows, failures);
    const hitTestChecks = countValidHitTestChecks(this.scrollElement, rows, failures);

    return {
      mountedRows: rows.length,
      caretChecks,
      selectionChecks,
      hitTestChecks,
      failures,
      ok: failures.length === 0,
    };
  }

  public textOffsetFromPoint(clientX: number, clientY: number): number | null {
    const documentWithCaret = this.scrollElement.ownerDocument as DocumentWithCaretHitTesting;
    const position = documentWithCaret.caretPositionFromPoint?.(clientX, clientY);
    if (position) return this.textOffsetFromDomBoundary(position.offsetNode, position.offset);

    const range = documentWithCaret.caretRangeFromPoint?.(clientX, clientY);
    if (!range) return null;
    return this.textOffsetFromDomBoundary(range.startContainer, range.startOffset);
  }

  public textOffsetFromViewportPoint(clientX: number, clientY: number): number {
    const metrics = this.viewportPointMetrics(clientX, clientY);
    if (metrics.verticalDirection < 0) return this.lineStartOffset(this.rowForViewportY(metrics.y));
    if (metrics.verticalDirection > 0) return this.lineEndOffset(this.rowForViewportY(metrics.y));

    const row = this.rowForViewportY(metrics.y);
    const column = Math.floor(metrics.x / this.characterWidth());
    return this.lineStartOffset(row) + clamp(column, 0, this.lineText(row).length);
  }

  public textOffsetFromDomBoundary(node: Node, offset: number): number | null {
    const row = this.rowFromDomBoundary(node);
    if (!row) return null;
    if (node === row.element) return this.rowElementBoundaryToOffset(row, offset);
    const chunk = rowChunkFromDomBoundary(row, node);
    if (chunk) return this.rowChunkBoundaryToOffset(chunk, node, offset);
    if (!row.element.contains(node)) return null;
    return row.endOffset;
  }

  public setSelection(anchorOffset: number, headOffset: number): void {
    this.selectionStart = clamp(Math.min(anchorOffset, headOffset), 0, this.text.length);
    this.selectionEnd = clamp(
      Math.max(anchorOffset, headOffset),
      this.selectionStart,
      this.text.length,
    );
    this.renderSelectionHighlight();
  }

  public clearSelection(): void {
    this.selectionStart = null;
    this.selectionEnd = null;
    this.clearSelectionHighlight();
    this.renderCaret();
  }

  private renderSnapshot(snapshot: FixedRowVirtualizerSnapshot): void {
    const rowsKey = snapshotRowsKey(snapshot, this.horizontalWindowKey());
    if (rowsKey === this.lastRenderedRowsKey) return;

    this.lastRenderedRowsKey = rowsKey;
    this.spacer.style.height = `${snapshot.totalSize}px`;
    this.gutterElement.style.height = `${snapshot.totalSize}px`;
    this.updateContentWidth(snapshot.virtualItems);
    this.reconcileRows(snapshot.virtualItems);
    this.renderTokenHighlights();
    this.renderSelectionHighlight();
  }

  private reconcileRows(items: readonly FixedRowVirtualItem[]): void {
    const reusableRows = this.releaseRowsOutside(items);
    for (const item of items) {
      this.mountOrUpdateRow(item, reusableRows);
    }

    this.removeReusableRows(reusableRows);
  }

  private mountOrUpdateRow(
    item: FixedRowVirtualItem,
    reusableRows: MountedVirtualizedTextRow[],
  ): void {
    const existing = this.rowElements.get(item.index);
    if (existing) {
      this.updateRow(existing, item);
      return;
    }

    const row = reusableRows.shift() ?? this.createRow();
    this.updateRow(row, item);
    this.rowElements.set(item.index, row);
  }

  private createRow(): MountedVirtualizedTextRow {
    const document = this.scrollElement.ownerDocument;
    const element = document.createElement("div");
    const gutterElement = document.createElement("div");
    const gutterLabelElement = document.createElement("span");
    const foldButtonElement = document.createElement("button");
    const leftSpacerElement = document.createElement("span");
    const foldPlaceholderElement = document.createElement("span");
    const textNode = document.createTextNode("");

    element.className = "editor-virtualized-row";
    gutterElement.className = "editor-virtualized-gutter-row";
    gutterLabelElement.className = "editor-virtualized-gutter-label editor-virtualized-line-number";
    foldButtonElement.className = "editor-virtualized-fold-toggle";
    foldButtonElement.type = "button";
    foldButtonElement.hidden = true;
    leftSpacerElement.className = "editor-virtualized-row-spacer";
    foldPlaceholderElement.className = "editor-virtualized-fold-placeholder";
    foldPlaceholderElement.textContent = "...";
    foldPlaceholderElement.hidden = true;
    foldButtonElement.addEventListener("mousedown", preventFoldButtonMouseDown);
    foldButtonElement.addEventListener("click", this.handleFoldButtonClick);
    gutterLabelElement.setAttribute("aria-hidden", "true");
    gutterElement.appendChild(gutterLabelElement);
    gutterElement.appendChild(foldButtonElement);
    element.appendChild(textNode);
    this.gutterElement.appendChild(gutterElement);
    this.spacer.appendChild(element);

    return {
      index: -1,
      bufferRow: -1,
      startOffset: 0,
      endOffset: 0,
      text: "",
      chunks: [],
      top: Number.NaN,
      height: Number.NaN,
      textRevision: -1,
      tokenHighlightSlotId: this.nextTokenHighlightSlotId++,
      chunkKey: "",
      foldMarkerKey: "",
      foldCollapsed: false,
      element,
      gutterElement,
      gutterLabelElement,
      foldButtonElement,
      leftSpacerElement,
      foldPlaceholderElement,
      textNode,
    };
  }

  private updateRow(row: MountedVirtualizedTextRow, item: FixedRowVirtualItem): void {
    if (this.isRowCurrent(row, item)) return;

    const bufferRow = this.bufferRowForVirtualRow(item.index);
    const text = this.lineText(item.index);
    const startOffset = this.lineStartOffset(item.index);
    const endOffset = this.lineEndOffset(item.index);
    const foldMarker = this.foldMarkerForVirtualRow(item.index);

    this.updateRowElement(row, item, text, startOffset);
    updateMutableRow(row, {
      bufferRow,
      endOffset,
      foldCollapsed: foldMarker?.collapsed ?? false,
      foldMarkerKey: foldMarker?.key ?? "",
      height: item.size,
      index: item.index,
      startOffset,
      text,
      textRevision: this.textRevision,
      top: item.start,
      chunkKey: this.rowChunkKey(text),
    });
  }

  private updateRowElement(
    row: MountedVirtualizedTextRow,
    item: FixedRowVirtualItem,
    text: string,
    startOffset: number,
  ): void {
    if (row.index !== item.index) row.element.dataset.editorVirtualRow = String(item.index);
    this.updateGutterRowElement(row, item);
    if (row.height !== item.size) {
      row.element.style.height = `${item.size}px`;
      row.element.style.lineHeight = `${item.size}px`;
    }
    if (row.top !== item.start) {
      row.element.style.transform = `translate3d(0, ${item.start}px, 0)`;
    }
    this.updateRowTextChunks(row, text, startOffset);
    this.updateRowFoldPresentation(row, item);
  }

  private applySameLineEdit(patch: SameLineEditPatch, nextText: string): void {
    const snapshot = this.virtualizer.getSnapshot();
    this.text = nextText;
    this.textRevision += 1;
    this.foldMap = null;
    this.tokenRangesFollowLastTextEdit = true;
    this.lineStarts = computeLineStarts(nextText);
    this.clampStoredSelection();
    this.resetContentWidthScan();
    this.updateContentWidth(snapshot.virtualItems);
    this.updateMountedRowsAfterSameLineEdit(snapshot.virtualItems, patch);
  }

  private updateMountedRowsAfterSameLineEdit(
    items: readonly FixedRowVirtualItem[],
    patch: SameLineEditPatch,
  ): void {
    for (const item of items) {
      const row = this.rowElements.get(item.index);
      if (!row) continue;
      this.updateRowAfterSameLineEdit(row, item, patch);
    }
  }

  private updateRowAfterSameLineEdit(
    row: MountedVirtualizedTextRow,
    item: FixedRowVirtualItem,
    patch: SameLineEditPatch,
  ): void {
    const text = this.lineText(item.index);
    const startOffset = this.lineStartOffset(item.index);
    const endOffset = this.lineEndOffset(item.index);
    const foldMarker = this.foldMarkerForVirtualRow(item.index);

    this.updateRowElementForSameLineEdit(row, item, text, patch, startOffset);
    updateMutableRow(row, {
      bufferRow: this.bufferRowForVirtualRow(item.index),
      endOffset,
      foldCollapsed: foldMarker?.collapsed ?? false,
      foldMarkerKey: foldMarker?.key ?? "",
      height: item.size,
      index: item.index,
      startOffset,
      text,
      textRevision: this.textRevision,
      top: item.start,
      chunkKey: this.rowChunkKey(text),
    });
  }

  private updateRowElementForSameLineEdit(
    row: MountedVirtualizedTextRow,
    item: FixedRowVirtualItem,
    text: string,
    patch: SameLineEditPatch,
    startOffset: number,
  ): void {
    if (row.index !== item.index) row.element.dataset.editorVirtualRow = String(item.index);
    this.updateGutterRowElement(row, item);
    if (row.height !== item.size) {
      row.element.style.height = `${item.size}px`;
      row.element.style.lineHeight = `${item.size}px`;
    }
    if (row.top !== item.start) {
      row.element.style.transform = `translate3d(0, ${item.start}px, 0)`;
    }
    this.updateRowTextForSameLineEdit(row, item, text, patch, startOffset);
    this.updateRowFoldPresentation(row, item);
  }

  private updateRowTextForSameLineEdit(
    row: MountedVirtualizedTextRow,
    item: FixedRowVirtualItem,
    text: string,
    patch: SameLineEditPatch,
    startOffset: number,
  ): void {
    if (item.index !== patch.rowIndex) {
      if (row.text !== text) this.updateRowTextChunks(row, text, startOffset);
      if (row.text === text) this.syncRowChunkOffsets(row, startOffset);
      return;
    }

    if (row.textNode.data !== row.text) {
      this.updateRowTextChunks(row, text, startOffset);
      return;
    }

    if (this.shouldChunkLine(text)) {
      this.updateRowTextChunks(row, text, startOffset);
      return;
    }

    row.textNode.replaceData(patch.localFrom, patch.deleteLength, patch.text);
    this.syncDirectRowChunk(row, text, startOffset);
  }

  private syncRowChunkOffsets(row: MountedVirtualizedTextRow, startOffset: number): void {
    const chunks = row.chunks.map((chunk) => ({
      ...chunk,
      startOffset: startOffset + chunk.localStart,
      endOffset: startOffset + chunk.localEnd,
    }));
    updateMutableRowChunks(row, chunks);
  }

  private updateRowTextChunks(
    row: MountedVirtualizedTextRow,
    text: string,
    startOffset: number,
  ): void {
    if (!this.shouldChunkLine(text)) {
      this.setDirectRowText(row, text, startOffset);
      return;
    }

    this.setChunkedRowText(row, text, startOffset);
  }

  private setDirectRowText(
    row: MountedVirtualizedTextRow,
    text: string,
    startOffset: number,
  ): void {
    if (row.element.firstChild !== row.textNode) {
      row.element.replaceChildren(row.textNode);
    }
    if (row.textNode.data !== text) row.textNode.data = text;
    this.syncDirectRowChunk(row, text, startOffset);
  }

  private syncDirectRowChunk(
    row: MountedVirtualizedTextRow,
    text: string,
    startOffset: number,
  ): void {
    const chunk = {
      startOffset,
      endOffset: startOffset + text.length,
      localStart: 0,
      localEnd: text.length,
      text,
      element: null,
      textNode: row.textNode,
    };
    updateMutableRowChunks(row, [chunk]);
  }

  private setChunkedRowText(
    row: MountedVirtualizedTextRow,
    text: string,
    startOffset: number,
  ): void {
    const window = this.horizontalChunkWindow(text.length);
    const chunks = this.createRowChunks(text, window, startOffset);
    const elements = chunks
      .map((chunk) => chunk.element)
      .filter((element): element is HTMLSpanElement => element !== null);
    row.leftSpacerElement.style.width = `${Math.round(window.start * this.characterWidth())}px`;
    row.element.replaceChildren(row.leftSpacerElement, ...elements);
    updateMutableRowChunks(row, chunks);
  }

  private createRowChunks(
    text: string,
    window: HorizontalChunkWindow,
    startOffset: number,
  ): VirtualizedTextChunk[] {
    const chunks: VirtualizedTextChunk[] = [];

    for (
      let localStart = window.start;
      localStart < window.end;
      localStart += this.longLineChunkSize
    ) {
      chunks.push(this.createRowChunk(text, localStart, window.end, startOffset));
    }

    return chunks;
  }

  private createRowChunk(
    text: string,
    localStart: number,
    windowEnd: number,
    startOffset: number,
  ): VirtualizedTextChunk {
    const localEnd = Math.min(localStart + this.longLineChunkSize, windowEnd);
    const element = this.scrollElement.ownerDocument.createElement("span");
    const textNode = this.scrollElement.ownerDocument.createTextNode(
      text.slice(localStart, localEnd),
    );

    element.className = "editor-virtualized-row-chunk";
    element.dataset.editorVirtualChunkStart = String(localStart);
    element.appendChild(textNode);

    return {
      startOffset: startOffset + localStart,
      endOffset: startOffset + localEnd,
      localStart,
      localEnd,
      text: textNode.data,
      element,
      textNode,
    };
  }

  private shouldChunkLine(text: string): boolean {
    return text.length > this.longLineChunkThreshold;
  }

  private rowChunkKey(text: string): string {
    if (!this.shouldChunkLine(text)) return "direct";

    const window = this.horizontalChunkWindow(text.length);
    return `${window.start}:${window.end}:${this.scrollElement.clientWidth}:${this.scrollElement.scrollLeft}`;
  }

  private horizontalChunkWindow(textLength: number): HorizontalChunkWindow {
    const viewportColumns = this.horizontalViewportColumns();
    const leftColumn = Math.max(
      0,
      Math.floor(this.horizontalTextScrollLeft() / this.characterWidth()),
    );
    const start = alignChunkStart(
      Math.max(0, leftColumn - this.horizontalOverscanColumns),
      this.longLineChunkSize,
    );
    const end = alignChunkEnd(
      Math.min(textLength, leftColumn + viewportColumns + this.horizontalOverscanColumns),
      this.longLineChunkSize,
    );

    return { start, end: clamp(end, start, textLength) };
  }

  private horizontalViewportColumns(): number {
    const width = Math.max(0, this.scrollElement.clientWidth - this.gutterWidth());
    return Math.max(1, Math.ceil(width / this.characterWidth()));
  }

  private horizontalTextScrollLeft(): number {
    return Math.max(0, this.scrollElement.scrollLeft - this.gutterWidth());
  }

  private horizontalWindowKey(): string {
    const scrollLeft = Math.floor(this.scrollElement.scrollLeft);
    return `${scrollLeft}:${this.scrollElement.clientWidth}:${this.longLineChunkSize}`;
  }

  private updateRowFoldPresentation(
    row: MountedVirtualizedTextRow,
    item: FixedRowVirtualItem,
  ): void {
    const marker = this.foldMarkerForVirtualRow(item.index);
    this.updateFoldButton(row, marker);
    this.updateFoldPlaceholder(row, marker);
  }

  private updateFoldButton(
    row: MountedVirtualizedTextRow,
    marker: VirtualizedFoldMarker | null,
  ): void {
    if (!marker) {
      row.foldButtonElement.hidden = true;
      row.foldButtonElement.disabled = true;
      row.foldButtonElement.tabIndex = -1;
      row.foldButtonElement.removeAttribute("data-editor-fold-key");
      row.foldButtonElement.removeAttribute("data-editor-fold-state");
      row.foldButtonElement.removeAttribute("aria-label");
      return;
    }

    const state = marker.collapsed ? "collapsed" : "expanded";
    row.foldButtonElement.hidden = false;
    row.foldButtonElement.disabled = false;
    row.foldButtonElement.tabIndex = 0;
    row.foldButtonElement.dataset.editorFoldKey = marker.key;
    row.foldButtonElement.dataset.editorFoldState = state;
    row.foldButtonElement.setAttribute(
      "aria-label",
      marker.collapsed ? "Expand folded region" : "Collapse foldable region",
    );
  }

  private updateFoldPlaceholder(
    row: MountedVirtualizedTextRow,
    marker: VirtualizedFoldMarker | null,
  ): void {
    const show = marker?.collapsed === true;
    row.foldPlaceholderElement.hidden = !show;
    row.foldPlaceholderElement.dataset.editorFoldPlaceholder = show ? marker.key : "";
    if (!show) {
      row.foldPlaceholderElement.remove();
      return;
    }

    if (row.foldPlaceholderElement.isConnected) return;
    row.element.appendChild(row.foldPlaceholderElement);
  }

  private updateGutterRowElement(row: MountedVirtualizedTextRow, item: FixedRowVirtualItem): void {
    if (row.index !== item.index) {
      row.gutterElement.dataset.editorVirtualGutterRow = String(item.index);
      row.gutterLabelElement.style.counterSet = `editor-line ${item.index + 1}`;
    }
    if (row.height !== item.size) {
      row.gutterElement.style.height = `${item.size}px`;
      row.gutterElement.style.lineHeight = `${item.size}px`;
    }
    if (row.top !== item.start) {
      row.gutterElement.style.transform = `translate3d(0, ${item.start}px, 0)`;
    }
  }

  private foldMarkerForVirtualRow(row: number): VirtualizedFoldMarker | null {
    const bufferRow = this.bufferRowForVirtualRow(row);
    return this.foldMarkers.find((marker) => marker.startRow === bufferRow) ?? null;
  }

  private handleFoldButtonClick = (event: MouseEvent): void => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) return;

    const key = button.dataset.editorFoldKey;
    const marker = key ? this.foldMarkers.find((candidate) => candidate.key === key) : null;
    if (!marker) return;

    event.preventDefault();
    event.stopPropagation();
    this.onFoldToggle?.(marker);
  };

  private isRowCurrent(row: MountedVirtualizedTextRow, item: FixedRowVirtualItem): boolean {
    const text = this.lineText(item.index);
    const bufferRow = this.bufferRowForVirtualRow(item.index);
    const foldMarker = this.foldMarkerForVirtualRow(item.index);
    return (
      row.index === item.index &&
      row.bufferRow === bufferRow &&
      row.top === item.start &&
      row.height === item.size &&
      row.text === text &&
      row.chunkKey === this.rowChunkKey(text) &&
      row.foldMarkerKey === (foldMarker?.key ?? "") &&
      row.foldCollapsed === (foldMarker?.collapsed ?? false) &&
      row.textRevision === this.textRevision
    );
  }

  private releaseRowsOutside(items: readonly FixedRowVirtualItem[]): MountedVirtualizedTextRow[] {
    const mounted = new Set(items.map((item) => item.index));
    const reusableRows: MountedVirtualizedTextRow[] = [];
    for (const [index, row] of this.rowElements) {
      if (mounted.has(index)) continue;
      this.rowElements.delete(index);
      reusableRows.push(row);
    }

    return reusableRows;
  }

  private removeReusableRows(rows: readonly MountedVirtualizedTextRow[]): void {
    for (const row of rows) {
      this.deleteTokenGroupsForRow(row.tokenHighlightSlotId);
      removeRowElements(row);
    }
  }

  private resetContentWidthScan(): void {
    this.contentWidth = 0;
    this.maxVisualColumnsSeen = 0;
    this.lastWidthScanStart = 0;
    this.lastWidthScanEnd = -1;
  }

  private updateContentWidth(items: readonly FixedRowVirtualItem[]): void {
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) {
      this.applyContentWidth(0);
      return;
    }

    this.scanVisualWidthRange(first.index, last.index);
    this.applyContentWidth(this.maxVisualColumnsSeen);
  }

  private scanVisualWidthRange(startIndex: number, endIndex: number): void {
    const overlapsLastScan = rangesIntersectInclusive(
      startIndex,
      endIndex,
      this.lastWidthScanStart,
      this.lastWidthScanEnd,
    );
    if (!overlapsLastScan) {
      this.scanVisualColumns(startIndex, endIndex);
      this.lastWidthScanStart = startIndex;
      this.lastWidthScanEnd = endIndex;
      return;
    }

    if (startIndex < this.lastWidthScanStart) {
      this.scanVisualColumns(startIndex, this.lastWidthScanStart - 1);
    }
    if (endIndex > this.lastWidthScanEnd) {
      this.scanVisualColumns(this.lastWidthScanEnd + 1, endIndex);
    }

    this.lastWidthScanStart = startIndex;
    this.lastWidthScanEnd = endIndex;
  }

  private scanVisualColumns(startIndex: number, endIndex: number): void {
    for (let row = startIndex; row <= endIndex; row += 1) {
      this.maxVisualColumnsSeen = Math.max(
        this.maxVisualColumnsSeen,
        visualColumn(this.lineText(row)),
      );
    }
  }

  private applyContentWidth(visualColumns: number): void {
    const charWidth = this.characterWidth();
    const width = Math.ceil(Math.max(charWidth, visualColumns * charWidth));
    if (width === this.contentWidth) return;

    this.contentWidth = width;
    this.spacer.style.width = `${width + this.gutterWidth()}px`;
  }

  private getMountedRows(): readonly MountedVirtualizedTextRow[] {
    return [...this.rowElements.values()].sort((a, b) => a.index - b.index);
  }

  private rowFromDomBoundary(node: Node): VirtualizedTextRow | null {
    const element = rowElementFromNode(node, this.scrollElement);
    if (!element) return null;

    const rowIndex = Number(element.dataset.editorVirtualRow);
    if (!Number.isInteger(rowIndex)) return null;
    return this.rowElements.get(rowIndex) ?? null;
  }

  private rowElementBoundaryToOffset(row: VirtualizedTextRow, offset: number): number {
    if (offset <= 0) return row.startOffset;
    if (offset >= row.element.childNodes.length) return row.endOffset;

    const child = row.element.childNodes.item(offset);
    const chunk = child ? rowChunkFromDomBoundary(row, child) : null;
    if (chunk) return chunk.startOffset;
    return row.endOffset;
  }

  private rowChunkBoundaryToOffset(
    chunk: VirtualizedTextChunk,
    node: Node,
    offset: number,
  ): number {
    if (node === chunk.textNode) {
      return chunk.startOffset + clamp(offset, 0, chunk.textNode.length);
    }
    if (offset <= 0) return chunk.startOffset;
    return chunk.endOffset;
  }

  private ensureOffsetMounted(offset: number): void {
    if (this.resolveMountedOffset(offset)) return;

    const row = this.rowForOffset(offset);
    this.scrollToRow(row);
    if (this.resolveMountedOffset(offset)) return;

    this.scrollHorizontallyToOffset(row, offset);
    this.virtualizer.setScrollMetrics({
      scrollTop: this.scrollElement.scrollTop,
      viewportHeight: this.scrollElement.clientHeight,
    });
  }

  private scrollHorizontallyToOffset(row: number, offset: number): void {
    const text = this.lineText(row);
    if (!this.shouldChunkLine(text)) return;

    const localOffset = clamp(offset - this.lineStartOffset(row), 0, text.length);
    const targetLeft = this.gutterWidth() + localOffset * this.characterWidth();
    const viewportRight = this.scrollElement.scrollLeft + this.scrollElement.clientWidth;
    if (targetLeft >= this.scrollElement.scrollLeft && targetLeft <= viewportRight) return;

    this.scrollElement.scrollLeft = Math.max(0, targetLeft - this.gutterWidth());
  }

  private resolveMountedOffset(
    offset: number,
  ): { readonly node: Text; readonly offset: number } | null {
    const clamped = clamp(offset, 0, this.text.length);
    const targetRow = this.rowForOffset(clamped);
    for (const row of this.getMountedRows()) {
      if (row.index !== targetRow) continue;
      const rowOffset = clamp(clamped, row.startOffset, row.endOffset);
      const chunk = mountedChunkForOffset(row, rowOffset);
      if (!chunk) return null;
      return {
        node: chunk.textNode,
        offset: clamp(rowOffset - chunk.startOffset, 0, chunk.textNode.length),
      };
    }

    return null;
  }

  private addMountedSelectionRanges(start: number, end: number): void {
    for (const row of this.getMountedRows()) {
      this.addMountedSelectionRange(row, start, end);
    }
  }

  private addMountedSelectionRange(row: VirtualizedTextRow, start: number, end: number): void {
    if (!this.selectionHighlight) return;
    if (end <= row.startOffset || start >= row.endOffset) return;

    for (const chunk of row.chunks) {
      this.addSelectionRangeToChunk(chunk, start, end);
    }
  }

  private addSelectionRangeToChunk(chunk: VirtualizedTextChunk, start: number, end: number): void {
    if (!this.selectionHighlight) return;
    if (end <= chunk.startOffset || start >= chunk.endOffset) return;

    const range = this.scrollElement.ownerDocument.createRange();
    range.setStart(chunk.textNode, clamp(start - chunk.startOffset, 0, chunk.textNode.length));
    range.setEnd(chunk.textNode, clamp(end - chunk.startOffset, 0, chunk.textNode.length));
    this.selectionHighlight.add(range);
  }

  private clearSelectionHighlight(): void {
    this.selectionHighlight?.clear();
    if (!this.selectionHighlightRegistered || !this.highlightRegistry) return;

    this.highlightRegistry.delete(this.selectionHighlightName);
    this.selectionHighlightRegistered = false;
  }

  private renderSelectionHighlight(): void {
    const selectionRange = this.selectionRange();

    this.clearSelectionHighlightRanges();
    this.renderCaret();
    if (!selectionRange) {
      this.clearSelectionHighlight();
      return;
    }
    if (!this.selectionHighlight || !this.highlightRegistry) return;

    this.addMountedSelectionRanges(selectionRange.start, selectionRange.end);
    if (this.selectionHighlight.size === 0) return;

    this.ensureSelectionHighlightRegistered();
  }

  private renderCaret(): void {
    if (this.selectionEnd === null || this.selectionStart !== this.selectionEnd) {
      this.caretElement.hidden = true;
      return;
    }

    const position = this.caretPosition(this.selectionEnd);
    if (!position) {
      this.caretElement.hidden = true;
      return;
    }

    this.caretElement.hidden = false;
    this.caretElement.style.height = `${position.height}px`;
    this.caretElement.style.transform = `translate(${position.left}px, ${position.top}px)`;
  }

  private clampStoredSelection(): void {
    if (this.selectionStart === null || this.selectionEnd === null) return;

    this.selectionStart = clamp(this.selectionStart, 0, this.text.length);
    this.selectionEnd = clamp(this.selectionEnd, this.selectionStart, this.text.length);
  }

  private renderTokenHighlights(): void {
    if (!this.highlightRegistry || this.tokens.length === 0 || this.text.length === 0) {
      this.clearTokenHighlights();
      return;
    }

    const mountedRows = this.getMountedRows();
    const segmentsByRow = this.tokenSegmentsForRows(mountedRows);
    let groupsChanged = false;
    for (const row of mountedRows) {
      groupsChanged =
        this.reconcileTokenHighlightsForRow(
          row,
          segmentsByRow.get(row.tokenHighlightSlotId) ?? [],
        ) || groupsChanged;
    }

    if (!groupsChanged) return;

    this.rebuildStyleRules();
  }

  private reconcileTokenHighlightsForRow(
    row: MountedVirtualizedTextRow,
    segments: readonly TokenRowSegment[],
  ): boolean {
    const signature = tokenRowSignature(row, segments);
    if (this.rowTokenSignatures.get(row.tokenHighlightSlotId) === signature) return false;

    const previousRanges = this.captureTokenHighlightRangesForRow(row.tokenHighlightSlotId);
    const usedStyleKeys = this.addTokenSegmentsForRow(row, segments);
    this.deleteCapturedTokenRanges(previousRanges);
    const removed = this.removeUnusedTokenGroupsForRow(row.tokenHighlightSlotId, usedStyleKeys);
    this.rowTokenSignatures.set(row.tokenHighlightSlotId, signature);
    return previousRanges.size > 0 || usedStyleKeys.size > 0 || removed;
  }

  private tokenSegmentsForRows(
    rows: readonly MountedVirtualizedTextRow[],
  ): Map<number, TokenRowSegment[]> {
    const segmentsByRow = new Map<number, TokenRowSegment[]>();
    const mountedRange = mountedOffsetRange(rows);
    if (!mountedRange) return segmentsByRow;

    for (const token of this.tokens) {
      this.appendTokenSegmentsForMountedRows(segmentsByRow, rows, mountedRange, token);
    }

    return segmentsByRow;
  }

  private appendTokenSegmentsForMountedRows(
    segmentsByRow: Map<number, TokenRowSegment[]>,
    rows: readonly MountedVirtualizedTextRow[],
    mountedRange: OffsetRange,
    token: EditorToken,
  ): void {
    const style = normalizeTokenStyle(token.style);
    if (!style) return;

    const range = this.clampedTokenRange(token);
    if (!range) return;
    if (!rangesIntersect(range.start, range.end, mountedRange.start, mountedRange.end)) return;

    const firstRowIndex = firstIntersectingMountedRow(rows, range.start, range.end);
    if (firstRowIndex === -1) return;

    const styleKey = serializeTokenStyle(style);
    for (let index = firstRowIndex; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (row.startOffset >= range.end) break;
      this.appendTokenSegmentsForRow(segmentsByRow, row, range, style, styleKey);
    }
  }

  private appendTokenSegmentsForRow(
    segmentsByRow: Map<number, TokenRowSegment[]>,
    row: MountedVirtualizedTextRow,
    range: OffsetRange,
    style: EditorTokenStyle,
    styleKey: string,
  ): void {
    const segments = getOrCreateTokenSegments(segmentsByRow, row.tokenHighlightSlotId);
    for (const chunk of row.chunks) {
      appendTokenSegmentForChunk(segments, chunk, range, style, styleKey);
    }
  }

  private clampedTokenRange(token: EditorToken): OffsetRange | null {
    const start = clamp(token.start, 0, this.text.length);
    const end = clamp(token.end, start, this.text.length);
    if (end <= start) return null;

    return { start, end };
  }

  private addTokenSegmentsForRow(
    row: MountedVirtualizedTextRow,
    segments: readonly TokenRowSegment[],
  ): Set<string> {
    const usedStyleKeys = new Set<string>();
    const document = this.scrollElement.ownerDocument;
    for (const segment of segments) {
      const group = this.ensureTokenGroup(row, segment.styleKey, segment.style);
      if (!group) continue;

      usedStyleKeys.add(segment.styleKey);
      addTokenRangeToChunk(document, group.highlight, segment.chunk, segment.start, segment.end);
    }

    return usedStyleKeys;
  }

  private ensureTokenGroup(
    row: MountedVirtualizedTextRow,
    styleKey: string,
    style: EditorTokenStyle,
  ): TokenGroup | null {
    const key = tokenGroupKey(row.tokenHighlightSlotId, styleKey);
    const existing = this.tokenGroups.get(key);
    if (existing) return existing;

    const name = `${this.selectionHighlightName}-token-${this.nextTokenGroupId++}`;
    const highlight = new Highlight();
    if (!highlight) return null;

    const group = {
      name,
      highlight,
      style,
      styleKey,
      rowSlotId: row.tokenHighlightSlotId,
    };
    this.tokenGroups.set(key, group);
    this.highlightRegistry?.set(name, group.highlight);
    return group;
  }

  private clearTokenHighlights(): void {
    for (const group of this.tokenGroups.values()) {
      this.highlightRegistry?.delete(group.name);
    }

    this.tokenGroups.clear();
    this.rowTokenSignatures.clear();
    this.nextTokenGroupId = 0;
    this.rebuildStyleRules();
  }

  private syncTokenGroupsToTokenSet(): void {
    const styleKeys = this.currentTokenStyleKeys();
    if (styleKeys.size === 0 || this.text.length === 0) {
      this.clearTokenHighlights();
      return;
    }

    this.removeUnusedTokenGroups(styleKeys);
  }

  private currentTokenStyleKeys(): Set<string> {
    const styleKeys = new Set<string>();
    for (const token of this.tokens) {
      const style = normalizeTokenStyle(token.style);
      if (!style) continue;
      styleKeys.add(serializeTokenStyle(style));
    }

    return styleKeys;
  }

  private removeUnusedTokenGroups(styleKeys: ReadonlySet<string>): void {
    let removed = false;
    for (const [key, group] of this.tokenGroups) {
      if (styleKeys.has(group.styleKey)) continue;

      this.highlightRegistry?.delete(group.name);
      this.tokenGroups.delete(key);
      this.rowTokenSignatures.delete(group.rowSlotId);
      removed = true;
    }

    if (!removed) return;

    this.rebuildStyleRules();
  }

  private canKeepLiveTokenRanges(tokens: readonly EditorToken[]): boolean {
    if (!this.tokenRangesFollowLastTextEdit) return false;
    if (this.tokens.length !== tokens.length) return false;

    return this.tokens.every((token, index) => {
      const nextToken = tokens[index];
      return nextToken ? tokenStylesEqual(token, nextToken) : false;
    });
  }

  private captureTokenHighlightRangesForRow(
    rowSlotId: number,
  ): Map<TokenGroup, readonly AbstractRange[]> {
    const ranges = new Map<TokenGroup, readonly AbstractRange[]>();
    for (const group of this.tokenGroups.values()) {
      if (group.rowSlotId !== rowSlotId) continue;
      ranges.set(group, [...group.highlight]);
    }

    return ranges;
  }

  private deleteCapturedTokenRanges(
    ranges: ReadonlyMap<TokenGroup, readonly AbstractRange[]>,
  ): void {
    for (const [group, capturedRanges] of ranges) {
      for (const range of capturedRanges) {
        group.highlight.delete(range);
      }
    }
  }

  private removeUnusedTokenGroupsForRow(
    rowSlotId: number,
    styleKeys: ReadonlySet<string>,
  ): boolean {
    let removed = false;
    for (const [key, group] of this.tokenGroups) {
      if (group.rowSlotId !== rowSlotId) continue;
      if (styleKeys.has(group.styleKey)) continue;

      this.highlightRegistry?.delete(group.name);
      this.tokenGroups.delete(key);
      removed = true;
    }

    return removed;
  }

  private deleteTokenGroupsForRow(rowSlotId: number): void {
    let removed = false;
    for (const [key, group] of this.tokenGroups) {
      if (group.rowSlotId !== rowSlotId) continue;

      this.highlightRegistry?.delete(group.name);
      this.tokenGroups.delete(key);
      removed = true;
    }

    this.rowTokenSignatures.delete(rowSlotId);
    if (removed) this.rebuildStyleRules();
  }

  private clearSelectionHighlightRanges(): void {
    this.selectionHighlight?.clear();
  }

  private ensureSelectionHighlightRegistered(): void {
    if (this.selectionHighlightRegistered) return;
    if (!this.selectionHighlight || !this.highlightRegistry) return;

    this.highlightRegistry.set(this.selectionHighlightName, this.selectionHighlight);
    this.selectionHighlightRegistered = true;
  }

  private selectionRange(): { readonly start: number; readonly end: number } | null {
    if (this.selectionStart === null || this.selectionEnd === null) return null;
    if (this.selectionStart === this.selectionEnd) return null;

    return {
      start: this.selectionStart,
      end: this.selectionEnd,
    };
  }

  private rebuildStyleRules(): void {
    const rules = [
      `::highlight(${this.selectionHighlightName}) { background-color: rgba(56, 189, 248, 0.35); }`,
    ];
    for (const group of this.tokenGroups.values()) {
      rules.push(buildHighlightRule(group.name, group.style));
    }

    const nextRules = rules.join("\n");
    if (this.styleEl.textContent === nextRules) return;

    this.styleEl.textContent = nextRules;
  }

  private lineStartOffset(row: number): number {
    return this.bufferLineStartOffset(this.bufferRowForVirtualRow(row));
  }

  private lineEndOffset(row: number): number {
    return this.bufferLineEndOffset(this.bufferRowForVirtualRow(row));
  }

  private bufferLineStartOffset(row: number): number {
    return this.lineStarts[row] ?? this.text.length;
  }

  private bufferLineEndOffset(row: number): number {
    const nextLineStart = this.lineStarts[row + 1];
    if (nextLineStart === undefined) return this.text.length;
    return Math.max(this.bufferLineStartOffset(row), nextLineStart - 1);
  }

  private lineText(row: number): string {
    return this.text.slice(this.lineStartOffset(row), this.lineEndOffset(row));
  }

  private sameLineEditPatch(edit: TextEdit): SameLineEditPatch | null {
    if (this.foldMap) return null;
    if (edit.from < 0 || edit.to < edit.from || edit.to > this.text.length) return null;
    if (edit.text.includes("\n")) return null;
    if (this.text.slice(edit.from, edit.to).includes("\n")) return null;

    const rowIndex = this.rowForOffset(edit.from);
    if (this.lineText(rowIndex).length > this.longLineChunkThreshold) return null;
    return {
      rowIndex,
      localFrom: edit.from - this.lineStartOffset(rowIndex),
      deleteLength: edit.to - edit.from,
      text: edit.text,
    };
  }

  private rowForOffset(offset: number): number {
    return this.virtualRowForBufferRow(this.bufferRowForOffset(offset));
  }

  private bufferRowForOffset(offset: number): number {
    const clamped = clamp(offset, 0, this.text.length);
    let low = 0;
    let high = this.lineStarts.length - 1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const start = this.bufferLineStartOffset(middle);
      const next = this.bufferLineStartOffset(middle + 1);
      if (clamped < start) {
        high = middle - 1;
        continue;
      }
      if (clamped >= next && middle + 1 < this.lineStarts.length) {
        low = middle + 1;
        continue;
      }
      return middle;
    }

    return this.lineStarts.length - 1;
  }

  private rowForViewportY(y: number): number {
    const row = Math.floor((this.scrollElement.scrollTop + y) / this.getRowHeight());
    return clamp(row, 0, this.visibleLineCount() - 1);
  }

  private visibleLineCount(): number {
    if (!this.foldMap) return this.lineStarts.length;

    const hidden = this.foldMap.ranges.reduce((count, range) => {
      return count + Math.max(0, range.endPoint.row - range.startPoint.row);
    }, 0);
    return Math.max(1, this.lineStarts.length - hidden);
  }

  private bufferRowForVirtualRow(row: number): number {
    if (!this.foldMap) return clamp(row, 0, this.lineStarts.length - 1);

    const point = foldPointToBufferPoint(this.foldMap, asFoldPoint({ row, column: 0 }));
    return clamp(point.row, 0, this.lineStarts.length - 1);
  }

  private virtualRowForBufferRow(row: number): number {
    if (!this.foldMap) return clamp(row, 0, this.visibleLineCount() - 1);

    const point = bufferPointToFoldPoint(this.foldMap, { row, column: 0 });
    return clamp(point.row, 0, this.visibleLineCount() - 1);
  }

  private viewportPointMetrics(
    clientX: number,
    clientY: number,
  ): { readonly x: number; readonly y: number; readonly verticalDirection: number } {
    const rect = this.scrollElement.getBoundingClientRect();
    const padding = scrollElementPadding(this.scrollElement);
    const left = rect.left + padding.left;
    const top = rect.top + padding.top;
    const right = Math.max(left, rect.right - padding.right);
    const bottom = Math.max(top, rect.bottom - padding.bottom);

    return {
      x: this.viewportTextX(clientX, left, right),
      y: clamp(clientY, top, Math.max(top, bottom - 1)) - top,
      verticalDirection: pointVerticalDirection(clientY, top, bottom),
    };
  }

  private viewportTextX(clientX: number, left: number, right: number): number {
    const viewportX = clamp(clientX, left, right) - left;
    const scrolledX = viewportX + this.scrollElement.scrollLeft;
    return Math.max(0, scrolledX - this.gutterWidth());
  }

  private characterWidth(): number {
    return Math.max(1, this.metrics.characterWidth);
  }

  private getRowHeight(): number {
    const row = this.virtualizer.getSnapshot().virtualItems[0];
    return row?.size ?? DEFAULT_ROW_HEIGHT;
  }

  private gutterWidth(): number {
    const value = this.scrollElement.style.getPropertyValue("--editor-gutter-width");
    return parseCssPixels(value) ?? DEFAULT_GUTTER_WIDTH;
  }

  private caretPosition(offset: number): {
    readonly left: number;
    readonly top: number;
    readonly height: number;
  } | null {
    const native = this.nativeCaretPosition(offset);
    if (native) return native;

    const rowIndex = this.rowForOffset(offset);
    const row = this.rowElements.get(rowIndex);
    if (!row) return null;

    const columnText = this.text.slice(row.startOffset, offset);
    return {
      left: this.gutterWidth() + visualColumn(columnText) * this.characterWidth(),
      top: rowIndex * this.getRowHeight(),
      height: this.getRowHeight(),
    };
  }

  private nativeCaretPosition(offset: number): {
    readonly left: number;
    readonly top: number;
    readonly height: number;
  } | null {
    const boundary = this.resolveMountedOffset(offset);
    if (!boundary) return null;

    const range = this.scrollElement.ownerDocument.createRange();
    range.setStart(boundary.node, boundary.offset);
    range.setEnd(boundary.node, boundary.offset);

    const rect = firstRangeRect(range);
    if (!rect) return null;

    const scrollRect = this.scrollElement.getBoundingClientRect();
    const left = rect.left - scrollRect.left + this.scrollElement.scrollLeft;
    const top = rect.top - scrollRect.top + this.scrollElement.scrollTop;
    return {
      left,
      top,
      height: rect.height || this.getRowHeight(),
    };
  }
}

function normalizeGutterWidth(width: number | undefined): number {
  if (width === undefined) return DEFAULT_GUTTER_WIDTH;
  if (!Number.isFinite(width) || width < 0) return DEFAULT_GUTTER_WIDTH;
  return width;
}

function normalizeRowHeight(rowHeight: number): number {
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) return DEFAULT_ROW_HEIGHT;
  return rowHeight;
}

function normalizeChunkSize(size: number | undefined): number {
  if (!Number.isFinite(size) || size === undefined || size <= 0) {
    return DEFAULT_LONG_LINE_CHUNK_SIZE;
  }

  return Math.floor(size);
}

function normalizeChunkThreshold(threshold: number | undefined, chunkSize: number): number {
  if (!Number.isFinite(threshold) || threshold === undefined || threshold <= 0) {
    return Math.max(DEFAULT_LONG_LINE_CHUNK_THRESHOLD, chunkSize);
  }

  return Math.max(Math.floor(threshold), chunkSize);
}

function normalizeHorizontalOverscan(overscan: number | undefined): number {
  if (!Number.isFinite(overscan) || overscan === undefined || overscan < 0) {
    return DEFAULT_HORIZONTAL_OVERSCAN_COLUMNS;
  }

  return Math.floor(overscan);
}

function normalizeFoldMarkers(
  markers: readonly VirtualizedFoldMarker[],
  textLength: number,
): readonly VirtualizedFoldMarker[] {
  return markers
    .filter((marker) => marker.endOffset > marker.startOffset)
    .filter((marker) => marker.endRow > marker.startRow)
    .map((marker) => ({
      ...marker,
      startOffset: clamp(marker.startOffset, 0, textLength),
      endOffset: clamp(marker.endOffset, marker.startOffset, textLength),
    }))
    .toSorted((left, right) => left.startRow - right.startRow || left.endRow - right.endRow);
}

function preventFoldButtonMouseDown(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function createVirtualizerOptions(rowHeight: number, overscan: number): FixedRowVirtualizerOptions {
  return {
    count: 1,
    rowHeight,
    overscan,
    enabled: true,
  };
}

function snapshotRowsKey(snapshot: FixedRowVirtualizerSnapshot, horizontalKey: string): string {
  const first = snapshot.virtualItems[0];
  const last = snapshot.virtualItems.at(-1);
  return `${snapshot.totalSize}:${first?.index ?? -1}:${last?.index ?? -1}:${snapshot.virtualItems.length}:${horizontalKey}`;
}

function createScrollElement(
  container: HTMLElement,
  className: string | undefined,
): HTMLDivElement {
  const scrollElement = container.ownerDocument.createElement("div");
  scrollElement.className = className ? `editor-virtualized ${className}` : "editor-virtualized";
  scrollElement.tabIndex = 0;
  scrollElement.spellcheck = false;
  container.appendChild(scrollElement);
  return scrollElement;
}

function createInputElement(container: HTMLElement): HTMLTextAreaElement {
  const input = container.ownerDocument.createElement("textarea");
  input.className = "editor-virtualized-input";
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.readOnly = true;
  input.spellcheck = false;
  input.setAttribute("aria-label", "Editor input");
  return input;
}

function editorTokensEqual(left: readonly EditorToken[], right: readonly EditorToken[]): boolean {
  if (left === right) return true;

  const length = left.length;
  if (length !== right.length) return false;

  for (let index = 0; index < length; index += 1) {
    const leftToken = left[index]!;
    const rightToken = right[index]!;
    if (leftToken === rightToken) continue;
    if (leftToken.start !== rightToken.start || leftToken.end !== rightToken.end) return false;
    if (!tokenStylesEqual(leftToken, rightToken)) return false;
  }

  return true;
}

function tokenStylesEqual(left: EditorToken, right: EditorToken): boolean {
  const leftStyle = left.style;
  const rightStyle = right.style;
  if (leftStyle === rightStyle) return true;

  return (
    (leftStyle.color || undefined) === (rightStyle.color || undefined) &&
    (leftStyle.backgroundColor || undefined) === (rightStyle.backgroundColor || undefined) &&
    (leftStyle.fontStyle || undefined) === (rightStyle.fontStyle || undefined) &&
    (leftStyle.fontWeight || undefined) === (rightStyle.fontWeight || undefined) &&
    (leftStyle.textDecoration || undefined) === (rightStyle.textDecoration || undefined)
  );
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  let index = text.indexOf("\n");

  while (index !== -1) {
    starts.push(index + 1);
    index = text.indexOf("\n", index + 1);
  }

  return starts;
}

function rowElementFromNode(node: Node, boundary: HTMLElement): HTMLDivElement | null {
  if (node instanceof HTMLDivElement && node.dataset.editorVirtualRow !== undefined) return node;
  if (!(node.parentElement instanceof HTMLElement)) return null;

  const element = node.parentElement.closest<HTMLDivElement>("[data-editor-virtual-row]");
  if (!element || !boundary.contains(element)) return null;
  return element;
}

function rowChunkFromDomBoundary(row: VirtualizedTextRow, node: Node): VirtualizedTextChunk | null {
  for (const chunk of row.chunks) {
    if (node === chunk.textNode || node === chunk.element) return chunk;
    if (chunk.element?.contains(node)) return chunk;
  }

  return null;
}

function mountedChunkForOffset(
  row: VirtualizedTextRow,
  offset: number,
): VirtualizedTextChunk | null {
  for (const chunk of row.chunks) {
    if (offset < chunk.startOffset || offset > chunk.endOffset) continue;
    return chunk;
  }

  return null;
}

function mountedOffsetRange(rows: readonly VirtualizedTextRow[]): OffsetRange | null {
  const first = rows[0];
  const last = rows.at(-1);
  if (!first || !last) return null;

  return {
    start: first.startOffset,
    end: last.endOffset,
  };
}

function firstIntersectingMountedRow(
  rows: readonly VirtualizedTextRow[],
  start: number,
  end: number,
): number {
  if (end <= start) return -1;

  let low = 0;
  let high = rows.length - 1;
  let result = rows.length;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const row = rows[middle]!;
    if (row.endOffset > start) {
      result = middle;
      high = middle - 1;
      continue;
    }

    low = middle + 1;
  }

  const row = rows[result];
  if (!row || row.startOffset >= end) return -1;
  return result;
}

function getOrCreateTokenSegments(
  segmentsByRow: Map<number, TokenRowSegment[]>,
  rowSlotId: number,
): TokenRowSegment[] {
  const existing = segmentsByRow.get(rowSlotId);
  if (existing) return existing;

  const segments: TokenRowSegment[] = [];
  segmentsByRow.set(rowSlotId, segments);
  return segments;
}

function appendTokenSegmentForChunk(
  segments: TokenRowSegment[],
  chunk: VirtualizedTextChunk,
  range: OffsetRange,
  style: EditorTokenStyle,
  styleKey: string,
): void {
  if (!rangesIntersect(range.start, range.end, chunk.startOffset, chunk.endOffset)) return;

  segments.push({
    chunk,
    start: Math.max(range.start, chunk.startOffset),
    end: Math.min(range.end, chunk.endOffset),
    style,
    styleKey,
  });
}

function tokenRowSignature(
  row: MountedVirtualizedTextRow,
  segments: readonly TokenRowSegment[],
): string {
  const parts = [`${row.chunkKey}:${row.text.length}`];
  for (const segment of segments) {
    parts.push(tokenSegmentSignature(segment));
  }

  return parts.join("|");
}

function tokenSegmentSignature(segment: TokenRowSegment): string {
  const localStart = segment.start - segment.chunk.startOffset;
  const localEnd = segment.end - segment.chunk.startOffset;
  return `${segment.styleKey}:${segment.chunk.localStart}:${localStart}:${localEnd}`;
}

function tokenGroupKey(rowSlotId: number, styleKey: string): string {
  return `${rowSlotId}:${styleKey}`;
}

function addTokenRangeToChunk(
  document: Document,
  highlight: Highlight,
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): void {
  if (end <= chunk.startOffset || start >= chunk.endOffset) return;

  const range = document.createRange();
  range.setStart(chunk.textNode, clamp(start - chunk.startOffset, 0, chunk.textNode.length));
  range.setEnd(chunk.textNode, clamp(end - chunk.startOffset, 0, chunk.textNode.length));
  highlight.add(range);
}

function firstRangeRect(range: Range): DOMRect | null {
  const rects = range.getClientRects();
  const first = rects.item(0);
  if (first) return first;

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return rect;
}

function countValidCaretChecks(rows: readonly VirtualizedTextRow[], failures: string[]): number {
  let count = 0;
  for (const row of rows) {
    const chunk = row.chunks[0];
    if (!chunk) continue;
    count += 1;
    validateCollapsedRange(chunk, failures);
  }

  return count;
}

function validateCollapsedRange(chunk: VirtualizedTextChunk, failures: string[]): void {
  const range = chunk.textNode.ownerDocument.createRange();
  range.setStart(chunk.textNode, 0);
  range.setEnd(chunk.textNode, 0);
  if (range.startContainer !== chunk.textNode) failures.push("caret range escaped row text");
}

function countValidSelectionChecks(
  rows: readonly VirtualizedTextRow[],
  failures: string[],
): number {
  let count = 0;
  for (const row of rows) {
    const chunk = row.chunks.find((candidate) => candidate.textNode.length > 0);
    if (!chunk) continue;
    count += 1;
    validateSelectionRange(chunk, failures);
  }

  return count;
}

function validateSelectionRange(chunk: VirtualizedTextChunk, failures: string[]): void {
  const range = chunk.textNode.ownerDocument.createRange();
  range.setStart(chunk.textNode, 0);
  range.setEnd(chunk.textNode, Math.min(1, chunk.textNode.length));
  if (range.endContainer !== chunk.textNode) failures.push("selection range escaped row text");
}

function countValidHitTestChecks(
  scrollElement: HTMLElement,
  rows: readonly VirtualizedTextRow[],
  failures: string[],
): number {
  const documentWithCaret = scrollElement.ownerDocument as DocumentWithCaretHitTesting;
  const probe = hitTestProbePoint(rows);
  if (!probe) return 0;

  const node = hitTestNodeFromPoint(documentWithCaret, probe.x, probe.y);
  if (!node) return 0;
  if (!rows.some((row) => row.element.contains(node)))
    failures.push("hit test missed mounted rows");
  return 1;
}

function hitTestProbePoint(
  rows: readonly VirtualizedTextRow[],
): { readonly x: number; readonly y: number } | null {
  for (const row of rows) {
    const chunk = row.chunks.find((candidate) => candidate.textNode.length > 0);
    const rect = chunk ? rangeRectForChunk(chunk) : null;
    if (!rect) continue;
    return { x: rect.left + 1, y: rect.top + rect.height / 2 };
  }

  return null;
}

function rangeRectForChunk(chunk: VirtualizedTextChunk): DOMRect | null {
  const range = chunk.textNode.ownerDocument.createRange();
  range.setStart(chunk.textNode, 0);
  range.setEnd(chunk.textNode, Math.min(1, chunk.textNode.length));
  return firstRangeRect(range);
}

function hitTestNodeFromPoint(
  documentWithCaret: DocumentWithCaretHitTesting,
  x: number,
  y: number,
): Node | null {
  const position = documentWithCaret.caretPositionFromPoint?.(x, y);
  if (position) return position.offsetNode;

  const range = documentWithCaret.caretRangeFromPoint?.(x, y);
  return range?.startContainer ?? null;
}

function updateMutableRow(
  row: MountedVirtualizedTextRow,
  values: {
    readonly index: number;
    readonly bufferRow: number;
    readonly startOffset: number;
    readonly endOffset: number;
    readonly text: string;
    readonly top: number;
    readonly height: number;
    readonly textRevision: number;
    readonly chunkKey: string;
    readonly foldMarkerKey: string;
    readonly foldCollapsed: boolean;
  },
): void {
  const mutable = row as {
    index: number;
    bufferRow: number;
    startOffset: number;
    endOffset: number;
    text: string;
    top: number;
    height: number;
    textRevision: number;
    chunkKey: string;
    foldMarkerKey: string;
    foldCollapsed: boolean;
  };
  mutable.index = values.index;
  mutable.bufferRow = values.bufferRow;
  mutable.startOffset = values.startOffset;
  mutable.endOffset = values.endOffset;
  mutable.text = values.text;
  mutable.top = values.top;
  mutable.height = values.height;
  mutable.textRevision = values.textRevision;
  mutable.chunkKey = values.chunkKey;
  mutable.foldMarkerKey = values.foldMarkerKey;
  mutable.foldCollapsed = values.foldCollapsed;
}

function updateMutableRowChunks(
  row: MountedVirtualizedTextRow,
  chunks: readonly VirtualizedTextChunk[],
): void {
  const mutable = row as { chunks: readonly VirtualizedTextChunk[]; textNode: Text };
  mutable.chunks = chunks;
  mutable.textNode = chunks[0]?.textNode ?? row.textNode;
}

function removeRowElements(row: MountedVirtualizedTextRow): void {
  row.element.remove();
  row.gutterElement.remove();
}

function scrollElementPadding(element: HTMLElement): {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
} {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return {
    left: parseCssPixels(style?.paddingLeft) ?? 0,
    right: parseCssPixels(style?.paddingRight) ?? 0,
    top: parseCssPixels(style?.paddingTop) ?? 0,
    bottom: parseCssPixels(style?.paddingBottom) ?? 0,
  };
}

function parseCssPixels(value: string | undefined): number | null {
  if (!value) return null;

  const pixels = Number.parseFloat(value);
  if (!Number.isFinite(pixels)) return null;
  return pixels;
}

function pointVerticalDirection(clientY: number, top: number, bottom: number): number {
  if (clientY < top) return -1;
  if (clientY >= bottom) return 1;
  return 0;
}

function alignChunkStart(value: number, chunkSize: number): number {
  return Math.floor(value / chunkSize) * chunkSize;
}

function alignChunkEnd(value: number, chunkSize: number): number {
  return Math.ceil(value / chunkSize) * chunkSize;
}

function foldMapMatchesText(foldMap: FoldMap | null, text: string): boolean {
  if (!foldMap) return false;
  return foldMap.snapshot.length === text.length;
}

function asFoldPoint(point: { readonly row: number; readonly column: number }): FoldPoint {
  return point as FoldPoint;
}

function getDefaultHighlightRegistry(): HighlightRegistry | null {
  const css = globalThis.CSS as { highlights?: HighlightRegistry } | undefined;
  return css?.highlights ?? null;
}

function rangesIntersect(startA: number, endA: number, startB: number, endB: number): boolean {
  return endA > startB && startA < endB;
}

function rangesIntersectInclusive(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): boolean {
  return endA >= startB && startA <= endB;
}

function visualColumn(text: string): number {
  let column = 0;
  for (const char of text) {
    if (char === "\t") {
      column += 4 - (column % 4);
      continue;
    }

    column += 1;
  }

  return column;
}
