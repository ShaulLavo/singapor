import {
  DEFAULT_TAB_SIZE,
  bufferColumnToVisualColumn,
  visualColumnLength,
} from "../displayTransforms";
import { clamp } from "../style-utils";
import type {
  EditorGutterContribution,
  EditorGutterRowContext,
  EditorGutterWidthContext,
} from "../plugins";
import type { FixedRowVirtualItem, FixedRowVirtualizerSnapshot } from "./fixedRowVirtualizer";
import {
  alignChunkEnd,
  alignChunkStart,
  hideFoldPlaceholder,
  mountedChunkForOffset,
  rangesIntersectInclusive,
  restoreRowElements,
  retireRowElements,
  rowChunkFromDomBoundary,
  rowElementFromNode,
  scrollElementPadding,
  setStyleValue,
  showFoldPlaceholder,
  snapshotRowsKey,
  updateMutableRow,
  updateMutableRowChunks,
} from "./virtualizedTextViewHelpers";
import {
  bufferRowForOffset,
  bufferRowForVirtualRow,
  displayRowKind,
  getRowHeight,
  lineEndOffset,
  lineStartOffset,
  lineText,
  rowForOffset,
  rowHeight,
  rowTop,
  scrollableHeight,
  visibleLineCount,
} from "./virtualizedTextViewLayout";
import type {
  HorizontalChunkWindow,
  MountedVirtualizedTextRow,
  SameLineEditPatch,
  VirtualizedFoldMarker,
  VirtualizedTextChunk,
  VirtualizedTextRow,
} from "./virtualizedTextViewTypes";
import type { VirtualizedTextViewInternal } from "./virtualizedTextViewInternals";

const GUTTER_CELL_CLASS = "editor-virtualized-gutter-cell";

export function rowsKey(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
): string {
  return snapshotRowsKey(snapshot, horizontalWindowKey(view, snapshot.virtualItems, snapshot));
}

export function renderRows(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
  onRemoveSlot: (rowSlotId: number) => void,
): void {
  applyTotalHeight(view, snapshot);
  updateContentWidth(view, snapshot.virtualItems);
  reconcileRows(view, snapshot.virtualItems, snapshot, onRemoveSlot);
}

export function reconcileRows(
  view: VirtualizedTextViewInternal,
  items: readonly FixedRowVirtualItem[],
  snapshot: FixedRowVirtualizerSnapshot,
  onRemoveSlot: (rowSlotId: number) => void,
): void {
  const reusableRows = releaseRowsOutside(view, items);
  for (const item of items) {
    mountOrUpdateRow(view, item, reusableRows, snapshot);
  }

  removeReusableRows(view, reusableRows, onRemoveSlot);
}

function mountOrUpdateRow(
  view: VirtualizedTextViewInternal,
  item: FixedRowVirtualItem,
  reusableRows: MountedVirtualizedTextRow[],
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  const existing = view.rowElements.get(item.index);
  if (existing) {
    updateRow(view, existing, item, snapshot);
    return;
  }

  const row = reusableRows.pop() ?? view.rowPool.pop() ?? createRow(view);
  const gutterParent = view.gutterContributions.length > 0 ? view.gutterElement : null;
  restoreRowElements(row, view.spacer, gutterParent);
  updateRow(view, row, item, snapshot);
  view.rowElements.set(item.index, row);
}

function createRow(view: VirtualizedTextViewInternal): MountedVirtualizedTextRow {
  const document = view.scrollElement.ownerDocument;
  const element = document.createElement("div");
  const gutterElement = document.createElement("div");
  const leftSpacerElement = document.createElement("span");
  const foldPlaceholderElement = document.createElement("span");
  const textNode = document.createTextNode("");
  const gutterCells = createGutterCells(view, document);

  element.className = "editor-virtualized-row";
  gutterElement.className = "editor-virtualized-gutter-row";
  leftSpacerElement.className = "editor-virtualized-row-spacer";
  foldPlaceholderElement.className = "editor-virtualized-fold-placeholder";
  foldPlaceholderElement.textContent = "...";
  foldPlaceholderElement.hidden = true;
  for (const cell of gutterCells.values()) gutterElement.appendChild(cell);
  element.appendChild(textNode);
  if (view.gutterContributions.length > 0) view.gutterElement.appendChild(gutterElement);
  view.spacer.appendChild(element);

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
    tokenHighlightSlotId: view.nextTokenHighlightSlotId++,
    chunkKey: "",
    foldMarkerKey: "",
    foldCollapsed: false,
    displayKind: "text",
    element,
    gutterElement,
    gutterCells,
    leftSpacerElement,
    foldPlaceholderElement,
    textNode,
  };
}

function createGutterCells(
  view: VirtualizedTextViewInternal,
  document: Document,
): Map<string, HTMLElement> {
  const cells = new Map<string, HTMLElement>();
  for (const contribution of view.gutterContributions) {
    cells.set(contribution.id, createGutterCell(contribution, document));
  }

  return cells;
}

function createGutterCell(contribution: EditorGutterContribution, document: Document): HTMLElement {
  const cell = contribution.createCell(document);
  cell.classList.add(GUTTER_CELL_CLASS);
  if (contribution.className) cell.classList.add(contribution.className);
  cell.dataset.editorGutterContribution = contribution.id;
  return cell;
}

export function disposeGutterCells(view: VirtualizedTextViewInternal): void {
  const rows = [...view.rowElements.values(), ...view.rowPool];
  for (const row of rows) disposeRowGutterCells(view, row);
}

function disposeRowGutterCells(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): void {
  for (const contribution of view.gutterContributions) {
    const cell = row.gutterCells.get(contribution.id);
    if (cell) contribution.disposeCell?.(cell);
  }
  row.gutterCells.clear();
}

function updateRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  if (isRowCurrent(view, row, item, snapshot)) {
    updateGutterRowElement(view, row, item);
    return;
  }

  const bufferRow = bufferRowForVirtualRow(view, item.index);
  const text = lineText(view, item.index);
  const startOffset = lineStartOffset(view, item.index);
  const endOffset = lineEndOffset(view, item.index);
  const foldMarker = foldMarkerForVirtualRow(view, item.index);
  const rowKind = displayRowKind(view, item.index);

  updateRowElement(view, row, item, text, startOffset, snapshot);
  updateMutableRow(row, {
    bufferRow,
    endOffset,
    kind: rowKind,
    foldCollapsed: foldMarker?.collapsed ?? false,
    foldMarkerKey: foldMarker?.key ?? "",
    height: item.size,
    index: item.index,
    startOffset,
    text,
    textRevision: view.textRevision,
    top: item.start,
    chunkKey: rowChunkKey(view, text, snapshot),
    displayKind: rowKind,
  });
}

function updateRowElement(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  text: string,
  startOffset: number,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  if (row.index !== item.index) row.element.dataset.editorVirtualRow = String(item.index);
  updateGutterRowElement(view, row, item);
  if (row.top !== item.start) {
    row.element.style.transform = `translate3d(0, ${item.start}px, 0)`;
  }
  if (displayRowKind(view, item.index) === "block") {
    setBlockRowText(row, text, startOffset);
    updateRowFoldPresentation(view, row, item);
    return;
  }

  updateRowTextChunks(view, row, text, startOffset, snapshot);
  updateRowFoldPresentation(view, row, item);
}

export function updateMountedRowsAfterSameLineEdit(
  view: VirtualizedTextViewInternal,
  items: readonly FixedRowVirtualItem[],
  patch: SameLineEditPatch,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  for (const item of items) {
    const row = view.rowElements.get(item.index);
    if (!row) continue;
    updateRowAfterSameLineEdit(view, row, item, patch, snapshot);
  }
}

function updateRowAfterSameLineEdit(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  patch: SameLineEditPatch,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  const text = lineText(view, item.index);
  const startOffset = lineStartOffset(view, item.index);
  const endOffset = lineEndOffset(view, item.index);
  const foldMarker = foldMarkerForVirtualRow(view, item.index);
  const rowKind = displayRowKind(view, item.index);

  updateRowElementForSameLineEdit(view, row, item, text, patch, startOffset, snapshot);
  updateMutableRow(row, {
    bufferRow: bufferRowForVirtualRow(view, item.index),
    endOffset,
    kind: rowKind,
    foldCollapsed: foldMarker?.collapsed ?? false,
    foldMarkerKey: foldMarker?.key ?? "",
    height: item.size,
    index: item.index,
    startOffset,
    text,
    textRevision: view.textRevision,
    top: item.start,
    chunkKey: rowChunkKey(view, text, snapshot),
    displayKind: rowKind,
  });
}

function updateRowElementForSameLineEdit(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  text: string,
  patch: SameLineEditPatch,
  startOffset: number,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  if (row.index !== item.index) row.element.dataset.editorVirtualRow = String(item.index);
  updateGutterRowElement(view, row, item);
  if (row.top !== item.start) {
    row.element.style.transform = `translate3d(0, ${item.start}px, 0)`;
  }
  if (displayRowKind(view, item.index) === "block") {
    setBlockRowText(row, text, startOffset);
    updateRowFoldPresentation(view, row, item);
    return;
  }

  updateRowTextForSameLineEdit(view, row, item, text, patch, startOffset, snapshot);
  updateRowFoldPresentation(view, row, item);
}

function updateRowTextForSameLineEdit(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  text: string,
  patch: SameLineEditPatch,
  startOffset: number,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  if (item.index !== patch.rowIndex) {
    if (row.text !== text) updateRowTextChunks(view, row, text, startOffset, snapshot);
    if (row.text === text) syncRowChunkOffsets(row, startOffset);
    return;
  }

  if (row.textNode.data !== row.text) {
    updateRowTextChunks(view, row, text, startOffset, snapshot);
    return;
  }

  if (shouldChunkLine(view, text)) {
    updateRowTextChunks(view, row, text, startOffset, snapshot);
    return;
  }

  row.textNode.replaceData(patch.localFrom, patch.deleteLength, patch.text);
  syncDirectRowChunk(row, text, startOffset);
}

function syncRowChunkOffsets(row: MountedVirtualizedTextRow, startOffset: number): void {
  const chunks = row.chunks.map((chunk) => ({
    ...chunk,
    startOffset: startOffset + chunk.localStart,
    endOffset: startOffset + chunk.localEnd,
  }));
  updateMutableRowChunks(row, chunks);
}

function updateRowTextChunks(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  text: string,
  startOffset: number,
  snapshot = view.virtualizer.getSnapshot(),
): void {
  if (!shouldChunkLine(view, text)) {
    setDirectRowText(row, text, startOffset);
    return;
  }

  setChunkedRowText(view, row, text, startOffset, snapshot);
}

function setDirectRowText(row: MountedVirtualizedTextRow, text: string, startOffset: number): void {
  if (row.element.firstChild !== row.textNode) {
    row.element.replaceChildren(row.textNode);
  }
  if (row.textNode.data !== text) row.textNode.data = text;
  syncDirectRowChunk(row, text, startOffset);
}

function syncDirectRowChunk(
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

function setBlockRowText(row: MountedVirtualizedTextRow, text: string, startOffset: number): void {
  row.element.replaceChildren(row.textNode);
  if (row.textNode.data !== text) row.textNode.data = text;
  syncDirectRowChunk(row, text, startOffset);
}

function setChunkedRowText(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  text: string,
  startOffset: number,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  const window = horizontalChunkWindow(view, text.length, snapshot);
  const chunks = createRowChunks(view, text, window, startOffset);
  const elements = chunks
    .map((chunk) => chunk.element)
    .filter((element): element is HTMLSpanElement => element !== null);
  row.leftSpacerElement.style.width = `${Math.round(window.start * characterWidth(view))}px`;
  row.element.replaceChildren(row.leftSpacerElement, ...elements);
  updateMutableRowChunks(row, chunks);
}

function createRowChunks(
  view: VirtualizedTextViewInternal,
  text: string,
  window: HorizontalChunkWindow,
  startOffset: number,
): VirtualizedTextChunk[] {
  const chunks: VirtualizedTextChunk[] = [];

  for (
    let localStart = window.start;
    localStart < window.end;
    localStart += view.longLineChunkSize
  ) {
    chunks.push(createRowChunk(view, text, localStart, window.end, startOffset));
  }

  return chunks;
}

function createRowChunk(
  view: VirtualizedTextViewInternal,
  text: string,
  localStart: number,
  windowEnd: number,
  startOffset: number,
): VirtualizedTextChunk {
  const localEnd = Math.min(localStart + view.longLineChunkSize, windowEnd);
  const element = view.scrollElement.ownerDocument.createElement("span");
  const textNode = view.scrollElement.ownerDocument.createTextNode(
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

export function shouldChunkLine(view: VirtualizedTextViewInternal, text: string): boolean {
  if (view.wrapEnabled) return false;
  return text.length > view.longLineChunkThreshold;
}

function rowChunkKey(
  view: VirtualizedTextViewInternal,
  text: string,
  snapshot = view.virtualizer.getSnapshot(),
): string {
  if (!shouldChunkLine(view, text)) return "direct";

  const window = horizontalChunkWindow(view, text.length, snapshot);
  return `${window.start}:${window.end}:${snapshot.viewportWidth}:${snapshot.scrollLeft}`;
}

export function horizontalChunkWindow(
  view: VirtualizedTextViewInternal,
  textLength: number,
  snapshot = view.virtualizer.getSnapshot(),
): HorizontalChunkWindow {
  const viewportColumns = horizontalViewportColumns(view, snapshot.viewportWidth);
  const leftColumn = Math.max(
    0,
    Math.floor(horizontalTextScrollLeft(view, snapshot.scrollLeft) / characterWidth(view)),
  );
  const start = alignChunkStart(
    Math.max(0, leftColumn - view.horizontalOverscanColumns),
    view.longLineChunkSize,
  );
  const end = alignChunkEnd(
    Math.min(textLength, leftColumn + viewportColumns + view.horizontalOverscanColumns),
    view.longLineChunkSize,
  );

  return { start, end: clamp(end, start, textLength) };
}

export function horizontalViewportColumns(
  view: VirtualizedTextViewInternal,
  viewportWidth = view.virtualizer.getSnapshot().viewportWidth,
): number {
  const width = Math.max(0, viewportWidth - gutterWidth(view));
  return Math.max(1, Math.ceil(width / characterWidth(view)));
}

export function horizontalTextScrollLeft(
  view: VirtualizedTextViewInternal,
  scrollLeft = view.virtualizer.getSnapshot().scrollLeft,
): number {
  return Math.max(0, scrollLeft - gutterWidth(view));
}

function horizontalWindowKey(
  view: VirtualizedTextViewInternal,
  items: readonly FixedRowVirtualItem[],
  snapshot: FixedRowVirtualizerSnapshot,
): string {
  if (!hasHorizontalChunkedRows(view, items)) return "direct";

  const scrollLeft = Math.floor(snapshot.scrollLeft);
  return `${scrollLeft}:${snapshot.viewportWidth}:${view.longLineChunkSize}`;
}

function hasHorizontalChunkedRows(
  view: VirtualizedTextViewInternal,
  items: readonly FixedRowVirtualItem[],
): boolean {
  for (const item of items) {
    if (shouldChunkLine(view, lineText(view, item.index))) return true;
  }

  return false;
}

function updateRowFoldPresentation(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
): void {
  const marker = foldMarkerForVirtualRow(view, item.index);
  updateFoldPlaceholder(row, marker);
}

function updateFoldPlaceholder(
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

function updateGutterRowElement(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
): void {
  if (view.gutterContributions.length === 0) return;

  if (row.index !== item.index) {
    row.gutterElement.dataset.editorVirtualGutterRow = String(item.index);
  }
  if (row.top !== item.start) {
    row.gutterElement.style.transform = `translate3d(0, ${item.start}px, 0)`;
  }

  updateGutterContributionCells(view, row, item);
}

function updateGutterContributionCells(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
): void {
  const context = createGutterRowContext(view, item);
  const widthContext = gutterWidthContext(view);
  for (const contribution of view.gutterContributions) {
    const cell = row.gutterCells.get(contribution.id);
    if (!cell) continue;

    setStyleValue(cell, "width", `${gutterContributionWidth(contribution, widthContext)}px`);
    contribution.updateCell(cell, context);
  }
}

function createGutterRowContext(
  view: VirtualizedTextViewInternal,
  item: FixedRowVirtualItem,
): EditorGutterRowContext {
  const index = item.index;
  const bufferRow = bufferRowForVirtualRow(view, index);

  return {
    index,
    bufferRow,
    startOffset: lineStartOffset(view, index),
    endOffset: lineEndOffset(view, index),
    text: lineText(view, index),
    kind: displayRowKind(view, index),
    primaryText: isPrimaryTextRow(view, index),
    cursorLine: isCursorLineGutterRow(view, index, bufferRow),
    foldMarker: foldMarkerForVirtualRow(view, index),
    lineCount: view.lineStarts.length,
    toggleFold: (marker) => view.onFoldToggle?.(marker),
  };
}

export function cursorLineBufferRow(view: VirtualizedTextViewInternal): number | null {
  if (view.selectionHead === null) return null;

  return bufferRowForOffset(view, view.selectionHead);
}

export function refreshCursorLineGutterRows(
  view: VirtualizedTextViewInternal,
  previousBufferRow: number | null,
): void {
  if (view.gutterContributions.length === 0) return;

  const nextBufferRow = cursorLineBufferRow(view);
  if (previousBufferRow === nextBufferRow) return;

  for (const row of view.rowElements.values()) {
    if (row.bufferRow !== previousBufferRow && row.bufferRow !== nextBufferRow) continue;

    updateGutterContributionCells(view, row, {
      index: row.index,
      size: row.height,
      start: row.top,
    });
  }
}

function isCursorLineGutterRow(
  view: VirtualizedTextViewInternal,
  row: number,
  bufferRow: number,
): boolean {
  const cursorBufferRow = cursorLineBufferRow(view);
  if (cursorBufferRow === null) return false;
  if (!isPrimaryTextRow(view, row)) return false;

  return bufferRow === cursorBufferRow;
}

export function foldMarkerForVirtualRow(
  view: VirtualizedTextViewInternal,
  row: number,
): VirtualizedFoldMarker | null {
  if (!isPrimaryTextRow(view, row)) return null;

  const bufferRow = bufferRowForVirtualRow(view, row);
  return view.foldMarkerByStartRow.get(bufferRow) ?? null;
}

function isPrimaryTextRow(view: VirtualizedTextViewInternal, row: number): boolean {
  const displayRow = view.displayRows[row];
  if (displayRow?.kind !== "text") return false;
  return displayRow.sourceStartColumn === 0;
}

function isRowCurrent(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  snapshot: FixedRowVirtualizerSnapshot,
): boolean {
  if (row.index !== item.index) return false;
  if (row.top !== item.start) return false;
  if (row.height !== item.size) return false;
  if (row.textRevision !== view.textRevision) return false;

  const bufferRow = bufferRowForVirtualRow(view, item.index);
  if (row.bufferRow !== bufferRow) return false;

  const rowKind = displayRowKind(view, item.index);
  if (row.displayKind !== rowKind) return false;

  const text = lineText(view, item.index);
  if (row.text !== text) return false;
  if (row.chunkKey !== rowChunkKey(view, text, snapshot)) return false;

  const foldMarker = foldMarkerForVirtualRow(view, item.index);
  if (row.foldMarkerKey !== (foldMarker?.key ?? "")) return false;
  return row.foldCollapsed === (foldMarker?.collapsed ?? false);
}

function releaseRowsOutside(
  view: VirtualizedTextViewInternal,
  items: readonly FixedRowVirtualItem[],
): MountedVirtualizedTextRow[] {
  const start = items[0]?.index ?? 0;
  const end = (items[items.length - 1]?.index ?? -1) + 1;
  const reusableRows: MountedVirtualizedTextRow[] = [];
  for (const [index, row] of view.rowElements) {
    if (index >= start && index < end) continue;
    view.rowElements.delete(index);
    reusableRows.push(row);
  }

  return reusableRows;
}

function removeReusableRows(
  view: VirtualizedTextViewInternal,
  rows: readonly MountedVirtualizedTextRow[],
  onRemoveSlot: (rowSlotId: number) => void,
): void {
  if (rows.length === 0) return;

  for (const row of rows) {
    onRemoveSlot(row.tokenHighlightSlotId);
    view.rowTokenSignatures.delete(row.tokenHighlightSlotId);
  }

  retireRowElements(rows);
  view.rowPool.push(...rows);
}

export function resetContentWidthScan(view: VirtualizedTextViewInternal): void {
  view.contentWidth = 0;
  view.maxVisualColumnsSeen = 0;
  view.lastWidthScanStart = 0;
  view.lastWidthScanEnd = -1;
}

export function updateGutterWidthIfNeeded(view: VirtualizedTextViewInternal): void {
  if (!view.gutterWidthDirty) return;

  view.gutterWidthDirty = false;
  applyGutterWidth(view);
}

function applyGutterWidth(view: VirtualizedTextViewInternal): void {
  const nextWidth = gutterContributionsWidth(view);
  setStyleValue(view.scrollElement, "--editor-gutter-width", `${nextWidth}px`);
  if (nextWidth === view.currentGutterWidth) return;

  view.currentGutterWidth = nextWidth;
  applySpacerWidth(view);
}

function gutterContributionsWidth(view: VirtualizedTextViewInternal): number {
  if (view.gutterContributions.length === 0) return 0;

  const context = gutterWidthContext(view);
  return view.gutterContributions.reduce((width, contribution) => {
    return width + gutterContributionWidth(contribution, context);
  }, 0);
}

function gutterContributionWidth(
  contribution: EditorGutterContribution,
  context: ReturnType<typeof gutterWidthContext>,
): number {
  const width = contribution.width(context);
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.ceil(width);
}

function gutterWidthContext(view: VirtualizedTextViewInternal): EditorGutterWidthContext {
  return {
    lineCount: view.lineStarts.length,
    metrics: view.metrics,
  };
}

export function updateContentWidth(
  view: VirtualizedTextViewInternal,
  items: readonly FixedRowVirtualItem[],
): void {
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    applyContentWidth(view, 0);
    return;
  }

  scanVisualWidthRange(view, first.index, last.index);
  applyContentWidth(view, view.maxVisualColumnsSeen);
}

function scanVisualWidthRange(
  view: VirtualizedTextViewInternal,
  startIndex: number,
  endIndex: number,
): void {
  const overlapsLastScan = rangesIntersectInclusive(
    startIndex,
    endIndex,
    view.lastWidthScanStart,
    view.lastWidthScanEnd,
  );
  if (!overlapsLastScan) {
    scanVisualColumns(view, startIndex, endIndex);
    view.lastWidthScanStart = startIndex;
    view.lastWidthScanEnd = endIndex;
    return;
  }

  if (startIndex < view.lastWidthScanStart) {
    scanVisualColumns(view, startIndex, view.lastWidthScanStart - 1);
  }
  if (endIndex > view.lastWidthScanEnd) {
    scanVisualColumns(view, view.lastWidthScanEnd + 1, endIndex);
  }

  view.lastWidthScanStart = startIndex;
  view.lastWidthScanEnd = endIndex;
}

function scanVisualColumns(
  view: VirtualizedTextViewInternal,
  startIndex: number,
  endIndex: number,
): void {
  for (let row = startIndex; row <= endIndex; row += 1) {
    view.maxVisualColumnsSeen = Math.max(
      view.maxVisualColumnsSeen,
      visualColumnLength(lineText(view, row), DEFAULT_TAB_SIZE),
    );
  }
}

function applyContentWidth(view: VirtualizedTextViewInternal, visualColumns: number): void {
  const charWidth = characterWidth(view);
  const width = Math.ceil(Math.max(charWidth, visualColumns * charWidth));
  if (width === view.contentWidth) return;

  view.contentWidth = width;
  applySpacerWidth(view);
}

function applySpacerWidth(view: VirtualizedTextViewInternal): void {
  view.spacer.style.width = `${view.contentWidth + gutterWidth(view)}px`;
}

export function applyRowHeight(view: VirtualizedTextViewInternal, rowHeight: number): void {
  setStyleValue(view.scrollElement, "--editor-row-height", `${rowHeight}px`);
}

function applyTotalHeight(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  const height = `${scrollableHeight(view, snapshot)}px`;
  setStyleValue(view.spacer, "height", height);
  setStyleValue(view.gutterElement, "height", height);
}

export function getMountedRows(
  view: VirtualizedTextViewInternal,
): readonly MountedVirtualizedTextRow[] {
  return [...view.rowElements.values()].sort((a, b) => a.index - b.index);
}

export function textOffsetFromDomBoundary(
  view: VirtualizedTextViewInternal,
  node: Node,
  offset: number,
): number | null {
  const row = rowFromDomBoundary(view, node);
  if (!row) return null;
  if (node === row.element) return rowElementBoundaryToOffset(row, offset);
  const chunk = rowChunkFromDomBoundary(row, node);
  if (chunk) return rowChunkBoundaryToOffset(chunk, node, offset);
  if (!row.element.contains(node)) return null;
  return row.endOffset;
}

function rowFromDomBoundary(
  view: VirtualizedTextViewInternal,
  node: Node,
): VirtualizedTextRow | null {
  const element = rowElementFromNode(node, view.scrollElement);
  if (!element) return null;

  const rowIndex = Number(element.dataset.editorVirtualRow);
  if (!Number.isInteger(rowIndex)) return null;
  return view.rowElements.get(rowIndex) ?? null;
}

function rowElementBoundaryToOffset(row: VirtualizedTextRow, offset: number): number {
  if (offset <= 0) return row.startOffset;
  if (offset >= row.element.childNodes.length) return row.endOffset;

  const child = row.element.childNodes.item(offset);
  const chunk = child ? rowChunkFromDomBoundary(row, child) : null;
  if (chunk) return chunk.startOffset;
  return row.endOffset;
}

function rowChunkBoundaryToOffset(chunk: VirtualizedTextChunk, node: Node, offset: number): number {
  if (node === chunk.textNode) {
    return chunk.startOffset + clamp(offset, 0, chunk.textNode.length);
  }
  if (offset <= 0) return chunk.startOffset;
  return chunk.endOffset;
}

export function ensureOffsetMounted(view: VirtualizedTextViewInternal, offset: number): void {
  if (resolveMountedOffset(view, offset)) return;

  const row = rowForOffset(view, offset);
  scrollToRow(view, row);
  if (resolveMountedOffset(view, offset)) return;

  scrollHorizontallyToOffset(view, row, offset);
  syncVirtualizerMetricsFromScrollElement(view);
}

function scrollHorizontallyToOffset(
  view: VirtualizedTextViewInternal,
  row: number,
  offset: number,
): void {
  const text = lineText(view, row);
  if (!shouldChunkLine(view, text)) return;

  const snapshot = view.virtualizer.getSnapshot();
  const localOffset = clamp(offset - lineStartOffset(view, row), 0, text.length);
  const targetLeft = gutterWidth(view) + localOffset * characterWidth(view);
  const viewportRight = snapshot.scrollLeft + snapshot.viewportWidth;
  if (targetLeft >= snapshot.scrollLeft && targetLeft <= viewportRight) return;

  view.scrollElement.scrollLeft = Math.max(0, targetLeft - gutterWidth(view));
}

export function positionInputInViewport(
  view: VirtualizedTextViewInternal,
  scrollTop: number,
  scrollLeft: number,
): void {
  setStyleValue(view.inputElement, "top", `${scrollTop}px`);
  setStyleValue(view.inputElement, "left", `${scrollLeft}px`);
}

export function restoreScrollPosition(
  view: VirtualizedTextViewInternal,
  scrollTop: number,
  scrollLeft: number,
): void {
  if (view.scrollElement.scrollTop === scrollTop && view.scrollElement.scrollLeft === scrollLeft)
    return;

  view.scrollElement.scrollTop = scrollTop;
  view.scrollElement.scrollLeft = scrollLeft;
  syncVirtualizerMetricsFromScrollElement(view);
}

export function syncVirtualizerMetricsFromScrollElement(view: VirtualizedTextViewInternal): void {
  const snapshot = view.virtualizer.getSnapshot();
  view.virtualizer.setScrollMetrics({
    scrollTop: view.scrollElement.scrollTop,
    scrollLeft: view.scrollElement.scrollLeft,
    borderBoxHeight: snapshot.borderBoxHeight,
    borderBoxWidth: snapshot.borderBoxWidth,
    viewportHeight: snapshot.viewportHeight,
    viewportWidth: snapshot.viewportWidth,
  });
}

export function scrollOffsetIntoView(view: VirtualizedTextViewInternal, offset: number): void {
  const snapshot = view.virtualizer.getSnapshot();
  const row = rowForOffset(view, offset);
  const top = rowTop(view, row);
  const bottom = top + rowHeight(view, row);
  const scrollTop = scrollTopForVisibleRow(view, top, bottom, snapshot);
  const scrollLeft = scrollLeftForVisibleOffset(view, row, offset, snapshot);
  if (scrollTop === snapshot.scrollTop && scrollLeft === snapshot.scrollLeft) return;

  view.scrollElement.scrollTop = scrollTop;
  view.scrollElement.scrollLeft = scrollLeft;
  syncVirtualizerMetricsFromScrollElement(view);
}

export function scrollOffsetToViewportEnd(view: VirtualizedTextViewInternal, offset: number): void {
  const snapshot = view.virtualizer.getSnapshot();
  const row = rowForOffset(view, offset);
  const bottom = rowTop(view, row) + rowHeight(view, row);
  const scrollTop = scrollTopForRowBottom(bottom, snapshot);
  const scrollLeft = scrollLeftForVisibleOffset(view, row, offset, snapshot);
  if (scrollTop === snapshot.scrollTop && scrollLeft === snapshot.scrollLeft) return;

  view.scrollElement.scrollTop = scrollTop;
  view.scrollElement.scrollLeft = scrollLeft;
  syncVirtualizerMetricsFromScrollElement(view);
}

function scrollTopForRowBottom(rowBottom: number, snapshot: FixedRowVirtualizerSnapshot): number {
  const maxScrollTop = Math.max(0, snapshot.totalSize - snapshot.viewportHeight);
  return clamp(rowBottom - snapshot.viewportHeight, 0, maxScrollTop);
}

function scrollTopForVisibleRow(
  view: VirtualizedTextViewInternal,
  rowTopValue: number,
  rowBottom: number,
  snapshot: FixedRowVirtualizerSnapshot,
): number {
  const viewportTop = snapshot.scrollTop;
  const viewportBottom = viewportTop + snapshot.viewportHeight;
  const maxScrollTop = Math.max(0, scrollableHeight(view, snapshot) - snapshot.viewportHeight);

  if (rowTopValue < viewportTop) return clamp(rowTopValue, 0, maxScrollTop);
  if (rowBottom > viewportBottom)
    return clamp(rowBottom - snapshot.viewportHeight, 0, maxScrollTop);
  return viewportTop;
}

function scrollLeftForVisibleOffset(
  view: VirtualizedTextViewInternal,
  row: number,
  offset: number,
  snapshot: FixedRowVirtualizerSnapshot,
): number {
  const text = lineText(view, row);
  const localOffset = clamp(offset - lineStartOffset(view, row), 0, text.length);
  const caretLeft =
    gutterWidth(view) +
    bufferColumnToVisualColumn(text, localOffset, DEFAULT_TAB_SIZE) * characterWidth(view);
  const viewportLeft = snapshot.scrollLeft + gutterWidth(view);
  const viewportRight = snapshot.scrollLeft + snapshot.viewportWidth;
  if (caretLeft < viewportLeft) return Math.max(0, caretLeft - gutterWidth(view));
  if (caretLeft > viewportRight) return Math.max(0, caretLeft - snapshot.viewportWidth);
  return snapshot.scrollLeft;
}

export function resolveMountedOffset(
  view: VirtualizedTextViewInternal,
  offset: number,
): { readonly node: Text; readonly offset: number } | null {
  const clamped = clamp(offset, 0, view.text.length);
  const targetRow = rowForOffset(view, clamped);
  for (const row of getMountedRows(view)) {
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

export function viewportPointMetrics(
  view: VirtualizedTextViewInternal,
  clientX: number,
  clientY: number,
): { readonly x: number; readonly y: number; readonly verticalDirection: number } {
  const rect = view.scrollElement.getBoundingClientRect();
  const padding = scrollElementPadding(view.scrollElement);
  const left = rect.left + padding.left;
  const top = rect.top + padding.top;
  const right = Math.max(left, rect.right - padding.right);
  const bottom = Math.max(top, rect.bottom - padding.bottom);

  return {
    x: viewportTextX(view, clientX, left, right, view.virtualizer.getSnapshot().scrollLeft),
    y: clamp(clientY, top, Math.max(top, bottom - 1)) - top,
    verticalDirection: pointVerticalDirection(clientY, top, bottom),
  };
}

function viewportTextX(
  view: VirtualizedTextViewInternal,
  clientX: number,
  left: number,
  right: number,
  scrollLeft: number,
): number {
  const viewportX = clamp(clientX, left, right) - left;
  const scrolledX = viewportX + scrollLeft;
  return Math.max(0, scrolledX - gutterWidth(view));
}

function pointVerticalDirection(clientY: number, top: number, bottom: number): number {
  if (clientY < top) return -1;
  if (clientY >= bottom) return 1;
  return 0;
}

export function scrollToRow(view: VirtualizedTextViewInternal, row: number): void {
  const target = clamp(Math.floor(row), 0, visibleLineCount(view) - 1);
  view.scrollElement.scrollTop = rowTop(view, target);
  syncVirtualizerMetricsFromScrollElement(view);
}

export function characterWidth(view: VirtualizedTextViewInternal): number {
  return Math.max(1, view.metrics.characterWidth);
}

export function gutterWidth(view: VirtualizedTextViewInternal): number {
  return view.currentGutterWidth;
}

export function caretPosition(
  view: VirtualizedTextViewInternal,
  offset: number,
): {
  readonly left: number;
  readonly top: number;
  readonly height: number;
} | null {
  const rowIndex = rowForOffset(view, offset);
  const row = view.rowElements.get(rowIndex);
  if (!row) return null;

  const columnText = view.text.slice(row.startOffset, offset);
  return {
    left:
      gutterWidth(view) + visualColumnLength(columnText, DEFAULT_TAB_SIZE) * characterWidth(view),
    top: row.top,
    height: row.height,
  };
}

export function pageRowDelta(view: VirtualizedTextViewInternal): number {
  const { viewportHeight } = view.virtualizer.getSnapshot();
  return Math.max(1, Math.floor(viewportHeight / getRowHeight(view)) - 1);
}
