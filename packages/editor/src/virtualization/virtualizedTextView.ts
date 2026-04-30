import type { FoldMap } from "../foldMap";
import type { BlockRow } from "../displayTransforms";
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
  normalizeGutterWidth,
  normalizeHorizontalOverscan,
  normalizeRowHeight,
} from "./virtualizedTextViewHelpers";
import {
  adoptTokens as adoptViewTokens,
  clampStoredSelection,
  clearRowTokenState,
  clearSelection,
  clearSelectionHighlight,
  clearTokenHighlights,
  deleteTokenRangesForRow,
  rebuildStyleRules,
  renderSelectionHighlight,
  renderTokenHighlights,
  setSelection,
  setTokens as setViewTokens,
} from "./virtualizedTextViewHighlights";
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
  VirtualizedTextViewInternal,
} from "./virtualizedTextViewInternals";
import type {
  DocumentWithCaretHitTesting,
  NativeGeometryValidation,
  SameLineEditPatch,
  VirtualizedFoldMarker,
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
  private readonly view: VirtualizedTextViewInternal;

  public constructor(container: HTMLElement, options: VirtualizedTextViewOptions = {}) {
    const overscan = options.overscan ?? DEFAULT_OVERSCAN;
    const gutterWidth = normalizeGutterWidth(options.gutterWidth);

    const styleEl = container.ownerDocument.createElement("style");
    const scrollElement = createScrollElement(container, options.className);
    const measuredMetrics = measureBrowserTextMetrics(scrollElement);
    const rowHeight = normalizeRowHeight(options.rowHeight ?? measuredMetrics.rowHeight);
    const inputElement = createInputElement(container);
    const spacer = container.ownerDocument.createElement("div");
    const gutterElement = container.ownerDocument.createElement("div");
    const caretElement = container.ownerDocument.createElement("div");
    const longLineChunkSize = normalizeChunkSize(options.longLineChunkSize);
    const longLineChunkThreshold = normalizeChunkThreshold(
      options.longLineChunkThreshold,
      longLineChunkSize,
    );
    const virtualizer = new FixedRowVirtualizer(createVirtualizerOptions(rowHeight, overscan));

    this.scrollElement = scrollElement;
    this.inputElement = inputElement;
    this.view = {
      scrollElement,
      inputElement,
      spacer,
      gutterElement,
      minimumGutterWidth: gutterWidth,
      caretElement,
      styleEl,
      virtualizer,
      longLineChunkSize,
      longLineChunkThreshold,
      horizontalOverscanColumns: normalizeHorizontalOverscan(options.horizontalOverscanColumns),
      onFoldToggle: options.onFoldToggle ?? null,
      onViewportChange: options.onViewportChange ?? null,
      rowElements: new Map(),
      rowPool: [],
      highlightRegistry: options.highlightRegistry ?? getDefaultHighlightRegistry(),
      selectionHighlightName: options.selectionHighlightName ?? DEFAULT_SELECTION_HIGHLIGHT,
      selectionHighlight: new Highlight(),
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
      blockRows: options.blockRows ?? [],
      wrapEnabled: options.wrap ?? false,
      currentWrapColumn: null,
      tokenGroups: new Map(),
      rowTokenSignatures: new Map(),
      rowTokenRanges: new Map(),
      nextTokenGroupId: 0,
      nextTokenHighlightSlotId: 0,
      selectionStart: null,
      selectionEnd: null,
      lastSelectionHighlightSignature: "",
      lastRenderedRowsKey: "",
      gutterWidthDirty: true,
      currentGutterWidth: gutterWidth,
      contentWidth: 0,
      maxVisualColumnsSeen: 0,
      lastWidthScanStart: 0,
      lastWidthScanEnd: -1,
      tokenRangesFollowLastTextEdit: false,
      metrics: { ...measuredMetrics, rowHeight },
    };

    scrollElement.style.setProperty("--editor-gutter-min-width", `${gutterWidth}px`);
    applyRowHeight(this.view, rowHeight);
    spacer.className = "editor-virtualized-spacer";
    gutterElement.className = "editor-virtualized-gutter";
    caretElement.className = "editor-virtualized-caret";
    caretElement.hidden = true;
    spacer.appendChild(gutterElement);
    spacer.appendChild(caretElement);
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
    clearTokenHighlights(view);
    view.virtualizer.dispose();
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
    const rowHeightValue = normalizeRowHeight(measured.rowHeight);
    view.metrics = { rowHeight: rowHeightValue, characterWidth: measured.characterWidth };
    applyRowHeight(view, rowHeightValue);
    view.gutterWidthDirty = true;
    this.refreshWrapWidth();
    view.lastRenderedRowsKey = "";
    view.virtualizer.updateOptions({ rowHeight: rowHeightValue, rowSizes: rowSizes(view) });
    return view.metrics;
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

  public setBlockRows(blockRows: readonly BlockRow[]): void {
    const view = this.view;
    setBlockRowsLayout(view, blockRows, horizontalViewportColumns(view));
    resetContentWidthScan(view);
    view.lastRenderedRowsKey = "";
    updateVirtualizerRows(view);
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
      wrapActive: view.wrapEnabled,
      blockRowCount: view.blockRows.length,
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

  public clearSelection(): void {
    clearSelection(this.view);
  }

  private renderSnapshot(snapshot: FixedRowVirtualizerSnapshot): void {
    const view = this.view;
    updateGutterWidthIfNeeded(view);
    const key = rowsKey(view, snapshot);
    if (key === view.lastRenderedRowsKey) return;

    view.lastRenderedRowsKey = key;
    renderRows(view, snapshot, (rowSlotId) => deleteTokenRangesForRow(view, rowSlotId));
    renderTokenHighlights(view);
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
