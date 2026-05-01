import type { FoldMap } from "../foldMap";
import { normalizeTabSize, type BlockRow } from "../displayTransforms";
import type { EditorTheme } from "../theme";
import type { EditorToken, TextEdit } from "../tokens";
import { applyEditorTheme } from "../theme";
import { measureBrowserTextMetrics, type BrowserTextMetrics } from "./browserMetrics";
import { FixedRowVirtualizer, type FixedRowVirtualizerSnapshot } from "./fixedRowVirtualizer";
import {
  DEFAULT_OVERSCAN,
  DEFAULT_SELECTION_HIGHLIGHT,
  countValidCaretChecks,
  countValidHitTestChecks,
  countValidSelectionChecks,
  computeLineStarts,
  createInputElement,
  createScrollElement,
  createVirtualizerOptions,
  getDefaultHighlightRegistry,
  normalizeChunkSize,
  normalizeChunkThreshold,
  normalizeHorizontalOverscan,
  normalizeRowHeight,
} from "./virtualizedTextViewHelpers";
import {
  adoptTokens as adoptViewTokens,
  clampStoredSelection,
  clearRangeHighlight,
  clearRowTokenState,
  clearSelection,
  clearSelectionHighlight,
  clearTokenHighlights,
  deleteTokenRangesForRow,
  rebuildStyleRules,
  renderRangeHighlight,
  renderSelectionHighlight,
  renderTokenHighlights,
  setRangeHighlight,
  setSelection,
  setSelections,
  setTokens as setViewTokens,
} from "./virtualizedTextViewHighlights";
import {
  normalizeHiddenCharactersMode,
  renderHiddenCharacters,
} from "./virtualizedTextViewHiddenCharacters";
import {
  lineEndOffset,
  lineStartOffset,
  offsetForViewportColumn,
  rebuildDisplayRows,
  refreshDisplayRowsForWrapWidth,
  rowForOffset,
  rowForViewportY,
  rowSizes,
  sameLineEditPatch,
  scrollableHeight,
  setBlockRowsLayout,
  setFoldStateLayout,
  setTextLayoutState,
  setWrapEnabledLayout,
  updateVirtualizerRows,
  visibleLineCount,
  visualColumnForOffset,
} from "./virtualizedTextViewLayout";
import {
  applyRowHeight,
  disposeGutterCells,
  ensureOffsetMounted,
  getMountedRows,
  gutterWidth,
  horizontalViewportColumns,
  pageRowDelta,
  positionInputInViewport,
  renderRows,
  resetContentWidthScan,
  resolveMountedOffset,
  restoreScrollPosition,
  rowsKey,
  scrollOffsetIntoView,
  scrollOffsetToViewportEnd,
  scrollToRow,
  textOffsetFromDomBoundary,
  updateContentWidth,
  updateGutterWidthIfNeeded,
  updateMountedRowsAfterSameLineEdit,
  viewportPointMetrics,
} from "./virtualizedTextViewRows";
import type {
  CreateRangeOptions,
  RevealBlock,
  VirtualizedTextHighlightRange,
  VirtualizedTextHighlightStyle,
  VirtualizedTextSelection,
  VirtualizedTextViewInternal,
} from "./virtualizedTextViewInternals";
import type {
  DocumentWithCaretHitTesting,
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
  NativeGeometryValidation,
  SameLineEditPatch,
  VirtualizedFoldMarker,
  VirtualizedTextViewOptions,
  VirtualizedTextViewState,
} from "./virtualizedTextViewTypes";

export type {
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
  HighlightRegistry,
  NativeGeometryValidation,
  VirtualizedFoldMarker,
  VirtualizedTextChunk,
  VirtualizedTextRow,
  VirtualizedTextViewOptions,
  VirtualizedTextViewState,
} from "./virtualizedTextViewTypes";

const DEFAULT_CURSOR_LINE_HIGHLIGHT: Required<EditorCursorLineHighlightOptions> = {
  gutterNumber: false,
  gutterBackground: true,
  rowBackground: true,
};

export class VirtualizedTextView {
  public readonly scrollElement: HTMLDivElement;
  public readonly inputElement: HTMLTextAreaElement;
  private readonly view: VirtualizedTextViewInternal;

  public constructor(container: HTMLElement, options: VirtualizedTextViewOptions = {}) {
    const overscan = options.overscan ?? DEFAULT_OVERSCAN;
    const gutterContributions = [...(options.gutterContributions ?? [])];

    const styleEl = container.ownerDocument.createElement("style");
    const scrollElement = createScrollElement(container, options.className);
    const measuredMetrics = measureBrowserTextMetrics(scrollElement);
    const lineHeightOverride = options.lineHeight ?? options.rowHeight ?? null;
    const rowHeight = normalizeRowHeight(lineHeightOverride ?? measuredMetrics.rowHeight);
    const inputElement = createInputElement(container);
    const spacer = container.ownerDocument.createElement("div");
    const gutterElement = container.ownerDocument.createElement("div");
    const caretLayerElement = container.ownerDocument.createElement("div");
    const caretElement = container.ownerDocument.createElement("div");
    const longLineChunkSize = normalizeChunkSize(options.longLineChunkSize);
    const longLineChunkThreshold = normalizeChunkThreshold(
      options.longLineChunkThreshold,
      longLineChunkSize,
    );
    const tabSize = normalizeTabSize(options.tabSize);
    const virtualizer = new FixedRowVirtualizer(createVirtualizerOptions(rowHeight, overscan));

    this.scrollElement = scrollElement;
    this.inputElement = inputElement;
    this.view = {
      scrollElement,
      inputElement,
      spacer,
      gutterElement,
      gutterContributions,
      caretLayerElement,
      caretElement,
      secondaryCaretElements: [],
      styleEl,
      virtualizer,
      longLineChunkSize,
      longLineChunkThreshold,
      horizontalOverscanColumns: normalizeHorizontalOverscan(options.horizontalOverscanColumns),
      onFoldToggle: options.onFoldToggle ?? null,
      onViewportChange: options.onViewportChange ?? null,
      cursorLineHighlight: normalizeCursorLineHighlight(options.cursorLineHighlight),
      rowElements: new Map(),
      rowPool: [],
      highlightRegistry: options.highlightRegistry ?? getDefaultHighlightRegistry(),
      selectionHighlightName: options.selectionHighlightName ?? DEFAULT_SELECTION_HIGHLIGHT,
      selectionHighlight: new Highlight(),
      rangeHighlightGroups: new Map(),
      selectionHighlightRegistered: false,
      text: "",
      textRevision: 0,
      tokens: [],
      tokenRenderEntries: [],
      tokenRenderEntryMaxEnds: [],
      tokenRenderStyles: new Map(),
      tokenRenderIndexDirty: true,
      lineStarts: [0],
      displayRows: [],
      foldMap: null,
      foldMarkers: [],
      foldMarkerByStartRow: new Map(),
      foldMarkerByKey: new Map(),
      blockRows: options.blockRows ?? [],
      wrapEnabled: options.wrap ?? false,
      currentWrapColumn: null,
      tabSize,
      tokenGroups: new Map(),
      rowTokenSignatures: new Map(),
      rowTokenRanges: new Map(),
      nextTokenGroupId: 0,
      nextTokenHighlightSlotId: 0,
      selectionStart: null,
      selectionEnd: null,
      selectionHead: null,
      selections: [],
      lastSelectionHighlightSignature: "",
      lastRenderedRowsKey: "",
      gutterWidthDirty: true,
      currentGutterWidth: 0,
      contentWidth: 0,
      maxVisualColumnsSeen: 0,
      lastWidthScanStart: 0,
      lastWidthScanEnd: -1,
      tokenRangesFollowLastTextEdit: false,
      lineHeightOverride,
      metrics: { ...measuredMetrics, rowHeight },
      hiddenCharacters: normalizeHiddenCharactersMode(options.hiddenCharacters),
    };

    scrollElement.style.setProperty("--editor-gutter-width", "0px");
    scrollElement.style.setProperty("--editor-tab-size", String(tabSize));
    applyRowHeight(this.view, rowHeight);
    spacer.className = "editor-virtualized-spacer";
    gutterElement.className = "editor-virtualized-gutter";
    caretLayerElement.className = "editor-virtualized-caret-layer";
    caretElement.className = "editor-virtualized-caret";
    caretElement.hidden = true;
    caretLayerElement.appendChild(caretElement);
    if (gutterContributions.length > 0) spacer.appendChild(gutterElement);
    spacer.appendChild(caretLayerElement);
    scrollElement.appendChild(spacer);
    scrollElement.appendChild(inputElement);
    container.ownerDocument.head.appendChild(styleEl);

    virtualizer.attachScrollElement(scrollElement, (snapshot) => {
      this.renderSnapshot(snapshot);
    });
    rebuildStyleRules(this.view);
  }

  public dispose(): void {
    const view = this.view;
    clearSelectionHighlight(view);
    for (const name of view.rangeHighlightGroups.keys()) clearRangeHighlight(view, name);
    clearTokenHighlights(view);
    view.virtualizer.dispose();
    disposeGutterCells(view);
    this.scrollElement.remove();
    view.styleEl.remove();
    view.rowElements.clear();
    view.rowPool.length = 0;
  }

  public setText(text: string): void {
    const view = this.view;
    view.tokenRangesFollowLastTextEdit = false;
    view.tokenRenderIndexDirty = true;
    const { lineCountChanged } = setTextLayoutState(view, text);
    if (lineCountChanged) view.gutterWidthDirty = true;
    rebuildDisplayRows(view, horizontalViewportColumns(view));
    clampStoredSelection(view);
    clearRowTokenState(view);
    view.lastRenderedRowsKey = "";
    resetContentWidthScan(view);
    updateVirtualizerRows(view);
  }

  public setFoldMap(foldMap: FoldMap | null): void {
    this.setFoldState(this.view.foldMarkers, foldMap);
  }

  public setFoldMarkers(markers: readonly VirtualizedFoldMarker[]): void {
    this.setFoldState(markers, this.view.foldMap);
  }

  public setFoldState(markers: readonly VirtualizedFoldMarker[], foldMap: FoldMap | null): void {
    const view = this.view;
    const update = setFoldStateLayout(view, markers, foldMap);
    if (!update.changed) return;

    if (update.foldMapChanged) clearRowTokenState(view);
    if (update.foldMapChanged) rebuildDisplayRows(view, horizontalViewportColumns(view));

    view.lastRenderedRowsKey = "";
    if (update.foldMapChanged) {
      updateVirtualizerRows(view);
      return;
    }

    this.renderSnapshot(view.virtualizer.getSnapshot());
  }

  public refreshMetrics(): BrowserTextMetrics {
    const view = this.view;
    const measured = measureBrowserTextMetrics(this.scrollElement);
    const rowHeightValue = normalizeRowHeight(view.lineHeightOverride ?? measured.rowHeight);
    this.applyMetrics({ rowHeight: rowHeightValue, characterWidth: measured.characterWidth });
    return view.metrics;
  }

  public setLineHeight(lineHeight: number): boolean {
    const view = this.view;
    const rowHeightValue = normalizeRowHeight(lineHeight);
    view.lineHeightOverride = rowHeightValue;
    if (view.metrics.rowHeight === rowHeightValue) return false;

    this.applyMetrics({ ...view.metrics, rowHeight: rowHeightValue });
    return true;
  }

  public setRowHeight(rowHeight: number): boolean {
    return this.setLineHeight(rowHeight);
  }

  private applyMetrics(metrics: BrowserTextMetrics): void {
    const view = this.view;
    view.metrics = metrics;
    const rowHeightValue = metrics.rowHeight;
    applyRowHeight(view, rowHeightValue);
    view.gutterWidthDirty = true;
    this.refreshWrapWidth();
    view.lastRenderedRowsKey = "";
    view.virtualizer.updateOptions({ rowHeight: rowHeightValue, rowSizes: rowSizes(view) });
  }

  public applyEdit(edit: TextEdit, nextText: string): void {
    const view = this.view;
    const patch = sameLineEditPatch(view, edit);
    if (!patch) {
      this.setText(nextText);
      return;
    }

    this.applySameLineEdit(patch, nextText);
  }

  public setTokens(tokens: readonly EditorToken[]): void {
    setViewTokens(this.view, tokens);
  }

  public adoptTokens(tokens: readonly EditorToken[]): void {
    adoptViewTokens(this.view, tokens);
  }

  public setTheme(theme: EditorTheme | null | undefined): void {
    applyEditorTheme(this.scrollElement, theme);
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

    const view = this.view;
    const scrollTop = this.scrollElement.scrollTop;
    const scrollLeft = this.scrollElement.scrollLeft;
    positionInputInViewport(view, scrollTop, scrollLeft);
    this.inputElement.value = "";
    this.inputElement.focus({ preventScroll: true });
    this.inputElement.setSelectionRange(0, 0);
    this.inputElement.ownerDocument.getSelection()?.removeAllRanges();
    restoreScrollPosition(view, scrollTop, scrollLeft);
  }

  public setScrollMetrics(
    scrollTop: number,
    viewportHeight: number,
    viewportWidth?: number,
    scrollLeft?: number,
  ): void {
    const width = viewportWidth ?? this.view.virtualizer.getSnapshot().viewportWidth;
    this.refreshWrapWidth(width);
    this.view.virtualizer.setScrollMetrics({
      scrollTop,
      viewportHeight,
      viewportWidth,
      scrollLeft,
    });
  }

  public setWrapEnabled(enabled: boolean): void {
    const view = this.view;
    if (!setWrapEnabledLayout(view, enabled, horizontalViewportColumns(view))) return;

    resetContentWidthScan(view);
    view.lastRenderedRowsKey = "";
    updateVirtualizerRows(view);
  }

  public setHiddenCharacters(mode: HiddenCharactersMode): void {
    const view = this.view;
    const next = normalizeHiddenCharactersMode(mode);
    if (view.hiddenCharacters === next) return;

    view.hiddenCharacters = next;
    renderHiddenCharacters(view);
  }

  public setBlockRows(blockRows: readonly BlockRow[]): void {
    const view = this.view;
    setBlockRowsLayout(view, blockRows, horizontalViewportColumns(view));
    resetContentWidthScan(view);
    view.lastRenderedRowsKey = "";
    updateVirtualizerRows(view);
  }

  public reserveOverlayWidth(side: "left" | "right", width: number): boolean {
    const value = width > 0 && Number.isFinite(width) ? `${Math.ceil(width)}px` : "";
    const property = side === "left" ? "paddingLeft" : "paddingRight";
    if (this.scrollElement.style[property] === value) return false;

    this.scrollElement.style[property] = value;
    return true;
  }

  public scrollToRow(row: number): void {
    scrollToRow(this.view, row);
  }

  public revealOffset(offset: number, block: RevealBlock = "nearest"): void {
    const view = this.view;
    if (block === "end") {
      scrollOffsetToViewportEnd(view, offset);
      ensureOffsetMounted(view, offset);
      return;
    }

    ensureOffsetMounted(view, offset);
    scrollOffsetIntoView(view, offset);
  }

  public visualColumnForOffset(offset: number): number {
    return visualColumnForOffset(this.view, offset);
  }

  public offsetByDisplayRows(offset: number, rowDelta: number, visualColumn: number): number {
    const view = this.view;
    const row = rowForOffset(view, offset);
    const targetRow = Math.max(0, Math.min(row + rowDelta, visibleLineCount(view) - 1));
    return offsetForViewportColumn(view, targetRow, visualColumn);
  }

  public offsetAtLineBoundary(offset: number, boundary: "start" | "end"): number {
    const view = this.view;
    const row = rowForOffset(view, offset);
    if (boundary === "start") return lineStartOffset(view, row);
    return lineEndOffset(view, row);
  }

  public pageRowDelta(): number {
    return pageRowDelta(this.view);
  }

  public getLineStarts(): readonly number[] {
    return this.view.lineStarts;
  }

  public createRange(
    startOffset: number,
    endOffset: number,
    options: CreateRangeOptions = {},
  ): Range | null {
    const view = this.view;
    if (options.scrollIntoView !== false) ensureOffsetMounted(view, startOffset);

    const start = resolveMountedOffset(view, startOffset);
    const end = resolveMountedOffset(view, endOffset);
    if (!start || !end) return null;

    const range = this.scrollElement.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  public getState(): VirtualizedTextViewState {
    const view = this.view;
    const snapshot = view.virtualizer.getSnapshot();
    return {
      lineCount: view.lineStarts.length,
      contentWidth: view.contentWidth,
      foldMapActive: view.foldMap !== null,
      metrics: view.metrics,
      scrollHeight: Math.max(snapshot.viewportHeight, scrollableHeight(view, snapshot)),
      scrollLeft: snapshot.scrollLeft,
      scrollTop: snapshot.scrollTop,
      scrollWidth: Math.max(snapshot.viewportWidth, view.contentWidth + gutterWidth(view)),
      borderBoxHeight: snapshot.borderBoxHeight,
      borderBoxWidth: snapshot.borderBoxWidth,
      totalHeight: snapshot.totalSize,
      viewportHeight: snapshot.viewportHeight,
      viewportWidth: snapshot.viewportWidth,
      visibleRange: snapshot.visibleRange,
      mountedRows: getMountedRows(view),
      foldMarkers: view.foldMarkers,
      wrapActive: view.wrapEnabled,
      blockRowCount: view.blockRows.length,
      tabSize: view.tabSize,
    };
  }

  public validateMountedNativeGeometry(): NativeGeometryValidation {
    const rows = getMountedRows(this.view);
    const failures: string[] = [];
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
    const view = this.view;
    const metrics = viewportPointMetrics(view, clientX, clientY);
    if (metrics.verticalDirection < 0)
      return lineStartOffset(view, rowForViewportY(view, metrics.y));
    if (metrics.verticalDirection > 0) return lineEndOffset(view, rowForViewportY(view, metrics.y));

    const row = rowForViewportY(view, metrics.y);
    const column = Math.floor(metrics.x / Math.max(1, view.metrics.characterWidth));
    return offsetForViewportColumn(view, row, column);
  }

  public textOffsetFromDomBoundary(node: Node, offset: number): number | null {
    return textOffsetFromDomBoundary(this.view, node, offset);
  }

  public setSelection(anchorOffset: number, headOffset: number): void {
    setSelection(this.view, anchorOffset, headOffset);
  }

  public setSelections(selections: readonly VirtualizedTextSelection[]): void {
    setSelections(this.view, selections);
  }

  public clearSelection(): void {
    clearSelection(this.view);
  }

  public setRangeHighlight(
    name: string,
    ranges: readonly VirtualizedTextHighlightRange[],
    style: VirtualizedTextHighlightStyle,
  ): void {
    setRangeHighlight(this.view, name, ranges, style);
  }

  public clearRangeHighlight(name: string): void {
    clearRangeHighlight(this.view, name);
  }

  private renderSnapshot(snapshot: FixedRowVirtualizerSnapshot): void {
    const view = this.view;
    updateGutterWidthIfNeeded(view);
    const key = rowsKey(view, snapshot);
    if (key === view.lastRenderedRowsKey) return;

    view.lastRenderedRowsKey = key;
    renderRows(view, snapshot, (rowSlotId) => deleteTokenRangesForRow(view, rowSlotId));
    renderTokenHighlights(view);
    for (const name of view.rangeHighlightGroups.keys()) renderRangeHighlight(view, name);
    renderSelectionHighlight(view);
    view.onViewportChange?.();
  }

  private applySameLineEdit(patch: SameLineEditPatch, nextText: string): void {
    const view = this.view;
    const snapshot = view.virtualizer.getSnapshot();
    view.text = nextText;
    view.textRevision += 1;
    view.foldMap = null;
    view.tokenRangesFollowLastTextEdit = true;
    view.tokenRenderIndexDirty = true;
    view.lineStarts = computeLineStarts(nextText);
    rebuildDisplayRows(view, horizontalViewportColumns(view));
    clampStoredSelection(view);
    resetContentWidthScan(view);
    updateContentWidth(view, snapshot.virtualItems);
    updateMountedRowsAfterSameLineEdit(view, snapshot.virtualItems, patch, snapshot);
    renderHiddenCharacters(view);
  }

  private refreshWrapWidth(
    viewportWidth = this.view.virtualizer.getSnapshot().viewportWidth,
  ): void {
    const view = this.view;
    const changed = refreshDisplayRowsForWrapWidth(
      view,
      horizontalViewportColumns(view, viewportWidth),
    );
    if (!changed) return;

    resetContentWidthScan(view);
    view.lastRenderedRowsKey = "";
    updateVirtualizerRows(view);
  }
}

function normalizeCursorLineHighlight(
  options: EditorCursorLineHighlightOptions | undefined,
): Required<EditorCursorLineHighlightOptions> {
  return {
    gutterNumber: options?.gutterNumber ?? DEFAULT_CURSOR_LINE_HIGHLIGHT.gutterNumber,
    gutterBackground: options?.gutterBackground ?? DEFAULT_CURSOR_LINE_HIGHLIGHT.gutterBackground,
    rowBackground: options?.rowBackground ?? DEFAULT_CURSOR_LINE_HIGHLIGHT.rowBackground,
  };
}
