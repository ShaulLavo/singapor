import { bufferPointToFoldPoint, foldPointToBufferPoint, type FoldMap } from "../foldMap";
import {
  DEFAULT_TAB_SIZE,
  createDisplayRows,
  visualColumnToBufferColumn,
  visualColumnLength,
  type BlockRow,
  type DisplayRow,
} from "../displayTransforms";
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
  type FixedRowVirtualizerSnapshot,
} from "./fixedRowVirtualizer";
import {
  DEFAULT_GUTTER_WIDTH,
  DEFAULT_OVERSCAN,
  DEFAULT_ROW_HEIGHT,
  DEFAULT_SELECTION_HIGHLIGHT,
  addTokenRangeToChunk,
  alignChunkEnd,
  alignChunkStart,
  appendTokenRange,
  appendTokenSegmentForChunk,
  asFoldPoint,
  computeLineStarts,
  countValidCaretChecks,
  countValidHitTestChecks,
  countValidSelectionChecks,
  createInputElement,
  createScrollElement,
  createVirtualizerOptions,
  editorTokensEqual,
  firstIntersectingMountedRow,
  foldMapMatchesText,
  foldMarkersEqual,
  getDefaultHighlightRegistry,
  getOrCreateTokenSegments,
  hideFoldButton,
  hideFoldPlaceholder,
  mountedChunkForOffset,
  mountedOffsetRange,
  normalizeChunkSize,
  normalizeChunkThreshold,
  normalizeFoldMarkers,
  normalizeGutterWidth,
  normalizeHorizontalOverscan,
  normalizeRowHeight,
  parseCssPixels,
  pointVerticalDirection,
  preventFoldButtonMouseDown,
  rangesIntersect,
  rangesIntersectInclusive,
  removeRowElements,
  rowChunkFromDomBoundary,
  rowElementFromNode,
  scrollElementPadding,
  setCounterSet,
  setElementHidden,
  setStyleValue,
  showFoldButton,
  showFoldPlaceholder,
  snapshotRowsKey,
  tokenRowSignature,
  tokenStylesEqual,
  updateMutableRow,
  updateMutableRowChunks,
} from "./virtualizedTextViewHelpers";
import type {
  DocumentWithCaretHitTesting,
  HighlightRegistry,
  HorizontalChunkWindow,
  MountedVirtualizedTextRow,
  NativeGeometryValidation,
  OffsetRange,
  SameLineEditPatch,
  TokenGroup,
  TokenRowSegment,
  VirtualizedFoldMarker,
  VirtualizedTextChunk,
  VirtualizedTextRow,
  VirtualizedTextViewOptions,
  VirtualizedTextViewState,
} from "./virtualizedTextViewTypes";

export type {
  HighlightRegistry,
  NativeGeometryValidation,
  VirtualizedFoldMarker,
  VirtualizedTextChunk,
  VirtualizedTextRow,
  VirtualizedTextViewOptions,
  VirtualizedTextViewState,
} from "./virtualizedTextViewTypes";

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
  private readonly onViewportChange: (() => void) | null;
  private readonly rowElements = new Map<number, MountedVirtualizedTextRow>();
  private readonly highlightRegistry: HighlightRegistry | null;
  private readonly selectionHighlightName: string;
  private readonly selectionHighlight: Highlight | null;
  private selectionHighlightRegistered = false;
  private text = "";
  private textRevision = 0;
  private tokens: readonly EditorToken[] = [];
  private lineStarts: number[] = [0];
  private displayRows: DisplayRow[] = [];
  private foldMap: FoldMap | null = null;
  private foldMarkers: readonly VirtualizedFoldMarker[] = [];
  private blockRows: readonly BlockRow[] = [];
  private wrapEnabled = false;
  private currentWrapColumn: number | null = null;
  private tokenGroups = new Map<string, TokenGroup>();
  private rowTokenSignatures = new Map<number, string>();
  private rowTokenRanges = new Map<number, Map<string, readonly AbstractRange[]>>();
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
    this.onViewportChange = options.onViewportChange ?? null;
    this.wrapEnabled = options.wrap ?? false;
    this.blockRows = options.blockRows ?? [];
    this.virtualizer = new FixedRowVirtualizer(createVirtualizerOptions(rowHeight, overscan));

    this.scrollElement.style.setProperty("--editor-gutter-width", `${gutterWidth}px`);
    this.applyRowHeight(rowHeight);
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
    this.rebuildDisplayRows();
    this.clampStoredSelection();
    this.clearRowTokenState();
    this.lastRenderedRowsKey = "";
    this.resetContentWidthScan();
    this.updateVirtualizerRows();
  }

  public setFoldMap(foldMap: FoldMap | null): void {
    this.setFoldState(this.foldMarkers, foldMap);
  }

  public setFoldMarkers(markers: readonly VirtualizedFoldMarker[]): void {
    this.setFoldState(markers, this.foldMap);
  }

  public setFoldState(markers: readonly VirtualizedFoldMarker[], foldMap: FoldMap | null): void {
    const nextFoldMap = foldMapMatchesText(foldMap, this.text) ? foldMap : null;
    const foldMapChanged = this.foldMap !== nextFoldMap;
    if (!foldMapChanged && markers.length === 0 && this.foldMarkers.length === 0) return;

    const nextFoldMarkers = normalizeFoldMarkers(markers, this.text.length);
    const foldMarkersChanged = !foldMarkersEqual(this.foldMarkers, nextFoldMarkers);
    if (!foldMapChanged && !foldMarkersChanged) return;

    this.foldMarkers = nextFoldMarkers;
    this.foldMap = nextFoldMap;
    if (foldMapChanged) this.clearRowTokenState();
    if (foldMapChanged) this.rebuildDisplayRows();

    this.lastRenderedRowsKey = "";
    if (foldMapChanged) {
      this.updateVirtualizerRows();
      return;
    }

    this.renderSnapshot(this.virtualizer.getSnapshot());
  }

  public refreshMetrics(): BrowserTextMetrics {
    const measured = measureBrowserTextMetrics(this.scrollElement);
    const rowHeight = normalizeRowHeight(measured.rowHeight);
    this.metrics = { rowHeight, characterWidth: measured.characterWidth };
    this.applyRowHeight(rowHeight);
    this.refreshDisplayRowsForWrapWidth();
    this.lastRenderedRowsKey = "";
    this.virtualizer.updateOptions({ rowHeight, rowSizes: this.rowSizes() });
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
    this.adoptTokens([...tokens]);
  }

  public adoptTokens(tokens: readonly EditorToken[]): void {
    if (editorTokensEqual(this.tokens, tokens)) {
      this.tokens = tokens;
      this.tokenRangesFollowLastTextEdit = false;
      return;
    }

    if (this.canKeepLiveTokenRanges(tokens)) {
      this.tokens = tokens;
      this.tokenRangesFollowLastTextEdit = false;
      return;
    }

    this.tokenRangesFollowLastTextEdit = false;
    this.tokens = tokens;
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
    this.refreshDisplayRowsForWrapWidth();
    this.virtualizer.setScrollMetrics({ scrollTop, viewportHeight });
  }

  public setWrapEnabled(enabled: boolean): void {
    if (this.wrapEnabled === enabled) return;

    this.wrapEnabled = enabled;
    this.currentWrapColumn = null;
    this.rebuildDisplayRows();
    this.resetContentWidthScan();
    this.lastRenderedRowsKey = "";
    this.updateVirtualizerRows();
  }

  public setBlockRows(blockRows: readonly BlockRow[]): void {
    this.blockRows = blockRows;
    this.rebuildDisplayRows();
    this.resetContentWidthScan();
    this.lastRenderedRowsKey = "";
    this.updateVirtualizerRows();
  }

  public reserveOverlayWidth(side: "left" | "right", width: number): void {
    const value = width > 0 && Number.isFinite(width) ? `${Math.ceil(width)}px` : "";
    if (side === "left") {
      this.scrollElement.style.paddingLeft = value;
      return;
    }

    this.scrollElement.style.paddingRight = value;
  }

  public scrollToRow(row: number): void {
    const target = clamp(Math.floor(row), 0, this.visibleLineCount() - 1);
    this.scrollElement.scrollTop = this.rowTop(target);
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
      wrapActive: this.wrapEnabled,
      blockRowCount: this.blockRows.length,
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
    return this.offsetForViewportColumn(row, column);
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
    const rowsKey = snapshotRowsKey(snapshot, this.horizontalWindowKey(snapshot.virtualItems));
    if (rowsKey === this.lastRenderedRowsKey) return;

    this.lastRenderedRowsKey = rowsKey;
    this.applyTotalHeight(snapshot.totalSize);
    this.updateContentWidth(snapshot.virtualItems);
    this.reconcileRows(snapshot.virtualItems);
    this.renderTokenHighlights();
    this.renderSelectionHighlight();
    this.onViewportChange?.();
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
    foldButtonElement.disabled = true;
    foldButtonElement.tabIndex = -1;
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
      kind: "text",
      chunks: [],
      top: Number.NaN,
      height: Number.NaN,
      textRevision: -1,
      tokenHighlightSlotId: this.nextTokenHighlightSlotId++,
      chunkKey: "",
      foldMarkerKey: "",
      foldCollapsed: false,
      displayKind: "text",
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
    const displayKind = this.displayRowKind(item.index);

    this.updateRowElement(row, item, text, startOffset);
    updateMutableRow(row, {
      bufferRow,
      endOffset,
      kind: displayKind,
      foldCollapsed: foldMarker?.collapsed ?? false,
      foldMarkerKey: foldMarker?.key ?? "",
      height: item.size,
      index: item.index,
      startOffset,
      text,
      textRevision: this.textRevision,
      top: item.start,
      chunkKey: this.rowChunkKey(text),
      displayKind,
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
    if (row.top !== item.start) {
      row.element.style.transform = `translate3d(0, ${item.start}px, 0)`;
    }
    if (this.displayRowKind(item.index) === "block") {
      this.setBlockRowText(row, text, startOffset);
      this.updateRowFoldPresentation(row, item);
      return;
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
    this.rebuildDisplayRows();
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
    const displayKind = this.displayRowKind(item.index);

    this.updateRowElementForSameLineEdit(row, item, text, patch, startOffset);
    updateMutableRow(row, {
      bufferRow: this.bufferRowForVirtualRow(item.index),
      endOffset,
      kind: displayKind,
      foldCollapsed: foldMarker?.collapsed ?? false,
      foldMarkerKey: foldMarker?.key ?? "",
      height: item.size,
      index: item.index,
      startOffset,
      text,
      textRevision: this.textRevision,
      top: item.start,
      chunkKey: this.rowChunkKey(text),
      displayKind,
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
    if (row.top !== item.start) {
      row.element.style.transform = `translate3d(0, ${item.start}px, 0)`;
    }
    if (this.displayRowKind(item.index) === "block") {
      this.setBlockRowText(row, text, startOffset);
      this.updateRowFoldPresentation(row, item);
      return;
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

  private setBlockRowText(row: MountedVirtualizedTextRow, text: string, startOffset: number): void {
    row.element.replaceChildren(row.textNode);
    if (row.textNode.data !== text) row.textNode.data = text;
    this.syncDirectRowChunk(row, text, startOffset);
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
    if (this.wrapEnabled) return false;
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

  private horizontalWindowKey(items: readonly FixedRowVirtualItem[]): string {
    if (!this.hasHorizontalChunkedRows(items)) return "direct";

    const scrollLeft = Math.floor(this.scrollElement.scrollLeft);
    return `${scrollLeft}:${this.scrollElement.clientWidth}:${this.longLineChunkSize}`;
  }

  private hasHorizontalChunkedRows(items: readonly FixedRowVirtualItem[]): boolean {
    for (const item of items) {
      if (this.shouldChunkLine(this.lineText(item.index))) return true;
    }

    return false;
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
      hideFoldButton(row.foldButtonElement);
      return;
    }

    const state = marker.collapsed ? "collapsed" : "expanded";
    showFoldButton(row.foldButtonElement, marker.key, state);
  }

  private updateFoldPlaceholder(
    row: MountedVirtualizedTextRow,
    marker: VirtualizedFoldMarker | null,
  ): void {
    const show = marker?.collapsed === true;
    if (!show) {
      hideFoldPlaceholder(row.foldPlaceholderElement);
      return;
    }

    showFoldPlaceholder(row.foldPlaceholderElement, marker.key);
    if (row.foldPlaceholderElement.isConnected) return;
    row.element.appendChild(row.foldPlaceholderElement);
  }

  private updateGutterRowElement(row: MountedVirtualizedTextRow, item: FixedRowVirtualItem): void {
    if (row.index !== item.index) {
      row.gutterElement.dataset.editorVirtualGutterRow = String(item.index);
      setCounterSet(row.gutterLabelElement, `editor-line ${item.index + 1}`);
    }
    if (row.top !== item.start) {
      row.gutterElement.style.transform = `translate3d(0, ${item.start}px, 0)`;
    }
  }

  private foldMarkerForVirtualRow(row: number): VirtualizedFoldMarker | null {
    const displayRow = this.displayRows[row];
    if (displayRow?.kind === "block") return null;
    if (displayRow?.kind === "text" && displayRow.sourceStartColumn !== 0) return null;

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
    const displayKind = this.displayRowKind(item.index);
    return (
      row.index === item.index &&
      row.bufferRow === bufferRow &&
      row.top === item.start &&
      row.height === item.size &&
      row.text === text &&
      row.chunkKey === this.rowChunkKey(text) &&
      row.foldMarkerKey === (foldMarker?.key ?? "") &&
      row.foldCollapsed === (foldMarker?.collapsed ?? false) &&
      row.displayKind === displayKind &&
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
      this.deleteTokenRangesForRow(row.tokenHighlightSlotId);
      this.rowTokenSignatures.delete(row.tokenHighlightSlotId);
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
        visualColumnLength(this.lineText(row), DEFAULT_TAB_SIZE),
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

  private applyRowHeight(rowHeight: number): void {
    setStyleValue(this.scrollElement, "--editor-row-height", `${rowHeight}px`);
  }

  private applyTotalHeight(totalHeight: number): void {
    const height = `${totalHeight}px`;
    setStyleValue(this.spacer, "height", height);
    setStyleValue(this.gutterElement, "height", height);
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
    this.clearSelectionHighlightRanges();
    if (!this.selectionHighlightRegistered || !this.highlightRegistry) return;

    this.highlightRegistry.delete(this.selectionHighlightName);
    this.selectionHighlightRegistered = false;
  }

  private renderSelectionHighlight(): void {
    const selectionRange = this.selectionRange();

    this.renderCaret();
    if (!selectionRange) {
      this.clearSelectionHighlight();
      return;
    }
    if (!this.selectionHighlight || !this.highlightRegistry) return;

    this.clearSelectionHighlightRanges();
    this.addMountedSelectionRanges(selectionRange.start, selectionRange.end);
    if (this.selectionHighlight.size === 0) return;

    this.ensureSelectionHighlightRegistered();
  }

  private renderCaret(): void {
    if (this.selectionEnd === null || this.selectionStart !== this.selectionEnd) {
      setElementHidden(this.caretElement, true);
      return;
    }

    const position = this.caretPosition(this.selectionEnd);
    if (!position) {
      setElementHidden(this.caretElement, true);
      return;
    }

    setElementHidden(this.caretElement, false);
    setStyleValue(this.caretElement, "height", `${position.height}px`);
    setStyleValue(
      this.caretElement,
      "transform",
      `translate(${position.left}px, ${position.top}px)`,
    );
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

    this.deleteTokenRangesForRow(row.tokenHighlightSlotId);
    const result = this.addTokenSegmentsForRow(row, segments);
    this.rowTokenSignatures.set(row.tokenHighlightSlotId, signature);
    return result.groupsChanged;
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
  ): { readonly groupsChanged: boolean } {
    const rangesByStyle = new Map<string, AbstractRange[]>();
    const document = this.scrollElement.ownerDocument;
    let groupsChanged = false;
    for (const segment of segments) {
      const result = this.ensureTokenGroup(segment.styleKey, segment.style);
      const group = result.group;
      if (!group) continue;

      const range = addTokenRangeToChunk(
        document,
        group.highlight,
        segment.chunk,
        segment.start,
        segment.end,
      );
      groupsChanged = groupsChanged || result.created;
      if (!range) continue;
      appendTokenRange(rangesByStyle, segment.styleKey, range);
    }

    if (rangesByStyle.size > 0) {
      this.rowTokenRanges.set(row.tokenHighlightSlotId, rangesByStyle);
    }

    return { groupsChanged };
  }

  private ensureTokenGroup(
    styleKey: string,
    style: EditorTokenStyle,
  ): { readonly group: TokenGroup | null; readonly created: boolean } {
    const existing = this.tokenGroups.get(styleKey);
    if (existing) return { group: existing, created: false };

    const name = `${this.selectionHighlightName}-token-${this.nextTokenGroupId++}`;
    const highlight = new Highlight();
    if (!highlight) return { group: null, created: false };

    const group = {
      name,
      highlight,
      style,
      styleKey,
    };
    this.tokenGroups.set(styleKey, group);
    this.highlightRegistry?.set(name, group.highlight);
    return { group, created: true };
  }

  private clearTokenHighlights(): void {
    if (this.tokenGroups.size === 0 && this.rowTokenRanges.size === 0) return;

    for (const group of this.tokenGroups.values()) {
      this.highlightRegistry?.delete(group.name);
    }

    this.tokenGroups.clear();
    this.clearRowTokenState();
    this.nextTokenGroupId = 0;
    this.rebuildStyleRules();
  }

  private syncTokenGroupsToTokenSet(): void {
    const styles = this.currentTokenStyles();
    if (styles.size === 0 || this.text.length === 0) {
      this.clearTokenHighlights();
      return;
    }

    const added = this.ensureTokenGroupsForStyles(styles);
    const removed = this.removeUnusedTokenGroups(new Set(styles.keys()));
    if (added || removed) this.rebuildStyleRules();
  }

  private currentTokenStyles(): Map<string, EditorTokenStyle> {
    const styles = new Map<string, EditorTokenStyle>();
    for (const token of this.tokens) {
      const style = normalizeTokenStyle(token.style);
      if (!style) continue;
      styles.set(serializeTokenStyle(style), style);
    }

    return styles;
  }

  private ensureTokenGroupsForStyles(styles: ReadonlyMap<string, EditorTokenStyle>): boolean {
    let added = false;
    for (const [styleKey, style] of styles) {
      const result = this.ensureTokenGroup(styleKey, style);
      added = added || result.created;
    }

    return added;
  }

  private removeUnusedTokenGroups(styleKeys: ReadonlySet<string>): boolean {
    let removed = false;
    for (const [key, group] of this.tokenGroups) {
      if (styleKeys.has(key)) continue;

      this.highlightRegistry?.delete(group.name);
      this.tokenGroups.delete(key);
      removed = true;
    }

    if (!removed) return false;

    this.clearRowTokenState();
    return true;
  }

  private canKeepLiveTokenRanges(tokens: readonly EditorToken[]): boolean {
    if (!this.tokenRangesFollowLastTextEdit) return false;
    if (this.tokens.length !== tokens.length) return false;

    return this.tokens.every((token, index) => {
      const nextToken = tokens[index];
      return nextToken ? tokenStylesEqual(token, nextToken) : false;
    });
  }

  private deleteTokenRangesForRow(rowSlotId: number): void {
    const rangesByStyle = this.rowTokenRanges.get(rowSlotId);
    if (!rangesByStyle) return;

    for (const [styleKey, capturedRanges] of rangesByStyle) {
      const group = this.tokenGroups.get(styleKey);
      if (!group) continue;

      for (const range of capturedRanges) {
        group.highlight.delete(range);
      }
    }

    this.rowTokenRanges.delete(rowSlotId);
  }

  private clearRowTokenState(): void {
    for (const rowSlotId of this.rowTokenRanges.keys()) {
      this.deleteTokenRangesForRow(rowSlotId);
    }

    this.rowTokenSignatures.clear();
    this.rowTokenRanges.clear();
  }

  private clearSelectionHighlightRanges(): void {
    if (!this.selectionHighlight || this.selectionHighlight.size === 0) return;

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

  private rebuildDisplayRows(): void {
    this.currentWrapColumn = this.wrapColumn();
    this.displayRows = createDisplayRows({
      text: this.text,
      lineStarts: this.lineStarts,
      visibleLineCount: this.foldVisibleLineCount(),
      bufferRowForVisibleRow: (row) => this.foldBufferRowForVisibleRow(row),
      wrapColumn: this.currentWrapColumn,
      blocks: this.blockRows,
      tabSize: DEFAULT_TAB_SIZE,
    });
  }

  private refreshDisplayRowsForWrapWidth(): void {
    if (!this.wrapEnabled) return;

    const wrapColumn = this.wrapColumn();
    if (wrapColumn === this.currentWrapColumn) return;

    this.rebuildDisplayRows();
    this.resetContentWidthScan();
    this.lastRenderedRowsKey = "";
    this.updateVirtualizerRows();
  }

  private updateVirtualizerRows(): void {
    this.virtualizer.updateOptions({
      count: this.visibleLineCount(),
      rowSizes: this.rowSizes(),
    });
  }

  private rowSizes(): readonly number[] | undefined {
    if (!this.hasVariableRows()) return undefined;

    const rowHeight = this.metrics.rowHeight;
    return this.displayRows.map((row) => {
      if (row.kind === "block") return row.heightRows * rowHeight;
      return rowHeight;
    });
  }

  private hasVariableRows(): boolean {
    return this.displayRows.some((row) => row.kind === "block" && row.heightRows !== 1);
  }

  private rowTop(row: number): number {
    const rowSizes = this.rowSizes();
    if (!rowSizes) return row * this.getRowHeight();

    let top = 0;
    for (let index = 0; index < row; index += 1) top += rowSizes[index] ?? 0;
    return top;
  }

  private wrapColumn(): number | null {
    if (!this.wrapEnabled) return null;

    return this.horizontalViewportColumns();
  }

  private displayRowKind(row: number): "text" | "block" {
    return this.displayRows[row]?.kind ?? "text";
  }

  private offsetForViewportColumn(row: number, visualColumn: number): number {
    const displayRow = this.displayRows[row];
    if (!displayRow) return this.text.length;
    if (displayRow.kind === "block") return displayRow.startOffset;

    const bufferColumn = visualColumnToBufferColumn(
      displayRow.text,
      visualColumn,
      "nearest",
      DEFAULT_TAB_SIZE,
    );
    return displayRow.startOffset + clamp(bufferColumn, 0, displayRow.text.length);
  }

  private lineStartOffset(row: number): number {
    return this.displayRows[row]?.startOffset ?? this.text.length;
  }

  private lineEndOffset(row: number): number {
    return this.displayRows[row]?.endOffset ?? this.text.length;
  }

  private bufferLineStartOffset(row: number): number {
    return this.lineStarts[row] ?? this.text.length;
  }

  private lineText(row: number): string {
    return this.displayRows[row]?.text ?? "";
  }

  private sameLineEditPatch(edit: TextEdit): SameLineEditPatch | null {
    if (this.foldMap) return null;
    if (this.wrapEnabled || this.blockRows.length > 0) return null;
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
    const displayRow = this.displayRows.find((row) => {
      if (row.kind !== "text") return false;
      if (offset < row.startOffset) return false;
      return offset <= row.endOffset;
    });
    if (displayRow) return displayRow.index;

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
    const offset = this.scrollElement.scrollTop + y;
    const rowSizes = this.rowSizes();
    if (!rowSizes)
      return clamp(Math.floor(offset / this.getRowHeight()), 0, this.visibleLineCount() - 1);

    let top = 0;
    for (let row = 0; row < rowSizes.length; row += 1) {
      top += rowSizes[row] ?? 0;
      if (offset < top) return row;
    }

    return this.visibleLineCount() - 1;
  }

  private visibleLineCount(): number {
    return Math.max(1, this.displayRows.length);
  }

  private foldVisibleLineCount(): number {
    if (!this.foldMap) return this.lineStarts.length;

    const hidden = this.foldMap.ranges.reduce((count, range) => {
      return count + Math.max(0, range.endPoint.row - range.startPoint.row);
    }, 0);
    return Math.max(1, this.lineStarts.length - hidden);
  }

  private bufferRowForVirtualRow(row: number): number {
    const displayRow = this.displayRows[row];
    if (displayRow?.kind === "text") return displayRow.bufferRow;
    if (displayRow?.kind === "block") return displayRow.anchorBufferRow;
    return this.foldBufferRowForVisibleRow(row);
  }

  private foldBufferRowForVisibleRow(row: number): number {
    if (!this.foldMap) return clamp(row, 0, this.lineStarts.length - 1);
    const point = foldPointToBufferPoint(this.foldMap, asFoldPoint({ row, column: 0 }));
    return clamp(point.row, 0, this.lineStarts.length - 1);
  }

  private virtualRowForBufferRow(row: number): number {
    const match = this.displayRows.find((displayRow) => {
      return displayRow.kind === "text" && displayRow.bufferRow === row;
    });
    if (match) return match.index;

    return this.foldVirtualRowForBufferRow(row);
  }

  private foldVirtualRowForBufferRow(row: number): number {
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
    const rowIndex = this.rowForOffset(offset);
    const row = this.rowElements.get(rowIndex);
    if (!row) return null;

    const columnText = this.text.slice(row.startOffset, offset);
    return {
      left:
        this.gutterWidth() +
        visualColumnLength(columnText, DEFAULT_TAB_SIZE) * this.characterWidth(),
      top: row.top,
      height: row.height,
    };
  }
}
