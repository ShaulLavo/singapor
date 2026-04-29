import type { FoldMap, FoldPoint } from "../foldMap";
import type { EditorToken, EditorTokenStyle } from "../tokens";
import { clamp } from "../style-utils";
import type {
  FixedRowVirtualizerOptions,
  FixedRowVirtualizerSnapshot,
} from "./fixedRowVirtualizer";
import type {
  DocumentWithCaretHitTesting,
  HighlightRegistry,
  MountedVirtualizedTextRow,
  OffsetRange,
  TokenRowSegment,
  VirtualizedFoldMarker,
  VirtualizedTextChunk,
  VirtualizedTextRow,
} from "./virtualizedTextViewTypes";

export const DEFAULT_ROW_HEIGHT = 20;
export const DEFAULT_OVERSCAN = 12;
export const DEFAULT_GUTTER_WIDTH = 36;
export const DEFAULT_SELECTION_HIGHLIGHT = "editor-virtualized-selection";
export const DEFAULT_LONG_LINE_CHUNK_SIZE = 2048;
export const DEFAULT_LONG_LINE_CHUNK_THRESHOLD = 4096;
export const DEFAULT_HORIZONTAL_OVERSCAN_COLUMNS = 256;

export function normalizeGutterWidth(width: number | undefined): number {
  if (width === undefined) return DEFAULT_GUTTER_WIDTH;
  if (!Number.isFinite(width) || width < 0) return DEFAULT_GUTTER_WIDTH;
  return width;
}

export function normalizeRowHeight(rowHeight: number): number {
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) return DEFAULT_ROW_HEIGHT;
  return rowHeight;
}

export function normalizeChunkSize(size: number | undefined): number {
  if (!Number.isFinite(size) || size === undefined || size <= 0) {
    return DEFAULT_LONG_LINE_CHUNK_SIZE;
  }

  return Math.floor(size);
}

export function normalizeChunkThreshold(threshold: number | undefined, chunkSize: number): number {
  if (!Number.isFinite(threshold) || threshold === undefined || threshold <= 0) {
    return Math.max(DEFAULT_LONG_LINE_CHUNK_THRESHOLD, chunkSize);
  }

  return Math.max(Math.floor(threshold), chunkSize);
}

export function normalizeHorizontalOverscan(overscan: number | undefined): number {
  if (!Number.isFinite(overscan) || overscan === undefined || overscan < 0) {
    return DEFAULT_HORIZONTAL_OVERSCAN_COLUMNS;
  }

  return Math.floor(overscan);
}

export function normalizeFoldMarkers(
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

export function preventFoldButtonMouseDown(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

export function hideFoldButton(button: HTMLButtonElement): void {
  setElementHidden(button, true);
  if (!button.disabled) button.disabled = true;
  if (button.tabIndex !== -1) button.tabIndex = -1;
  deleteDatasetValue(button, "editorFoldKey");
  deleteDatasetValue(button, "editorFoldState");
  removeAttributeValue(button, "aria-label");
}

export function showFoldButton(
  button: HTMLButtonElement,
  key: string,
  state: "collapsed" | "expanded",
): void {
  const label = state === "collapsed" ? "Expand folded region" : "Collapse foldable region";
  setElementHidden(button, false);
  if (button.disabled) button.disabled = false;
  if (button.tabIndex !== 0) button.tabIndex = 0;
  setDatasetValue(button, "editorFoldKey", key);
  setDatasetValue(button, "editorFoldState", state);
  setAttributeValue(button, "aria-label", label);
}

export function hideFoldPlaceholder(element: HTMLSpanElement): void {
  setElementHidden(element, true);
  deleteDatasetValue(element, "editorFoldPlaceholder");
  if (element.isConnected) element.remove();
}

export function showFoldPlaceholder(element: HTMLSpanElement, key: string): void {
  setElementHidden(element, false);
  setDatasetValue(element, "editorFoldPlaceholder", key);
}

export function createVirtualizerOptions(
  rowHeight: number,
  overscan: number,
): FixedRowVirtualizerOptions {
  return {
    count: 1,
    rowHeight,
    overscan,
    enabled: true,
  };
}

export function snapshotRowsKey(
  snapshot: FixedRowVirtualizerSnapshot,
  horizontalKey: string,
): string {
  const first = snapshot.virtualItems[0];
  const last = snapshot.virtualItems.at(-1);
  return `${snapshot.totalSize}:${first?.index ?? -1}:${last?.index ?? -1}:${snapshot.virtualItems.length}:${horizontalKey}`;
}

export function createScrollElement(
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

export function createInputElement(container: HTMLElement): HTMLTextAreaElement {
  const input = container.ownerDocument.createElement("textarea");
  input.className = "editor-virtualized-input";
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.readOnly = true;
  input.spellcheck = false;
  input.setAttribute("aria-label", "Editor input");
  return input;
}

export function editorTokensEqual(
  left: readonly EditorToken[],
  right: readonly EditorToken[],
): boolean {
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

export function foldMarkersEqual(
  left: readonly VirtualizedFoldMarker[],
  right: readonly VirtualizedFoldMarker[],
): boolean {
  if (left === right) return true;

  const length = left.length;
  if (length !== right.length) return false;

  for (let index = 0; index < length; index += 1) {
    if (!foldMarkerEqual(left[index]!, right[index]!)) return false;
  }

  return true;
}

function foldMarkerEqual(left: VirtualizedFoldMarker, right: VirtualizedFoldMarker): boolean {
  return (
    left.key === right.key &&
    left.startOffset === right.startOffset &&
    left.endOffset === right.endOffset &&
    left.startRow === right.startRow &&
    left.endRow === right.endRow &&
    left.collapsed === right.collapsed
  );
}

export function tokenStylesEqual(left: EditorToken, right: EditorToken): boolean {
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

export function computeLineStarts(text: string): number[] {
  const starts = [0];
  let index = text.indexOf("\n");

  while (index !== -1) {
    starts.push(index + 1);
    index = text.indexOf("\n", index + 1);
  }

  return starts;
}

export function rowElementFromNode(node: Node, boundary: HTMLElement): HTMLDivElement | null {
  if (node instanceof HTMLDivElement && node.dataset.editorVirtualRow !== undefined) return node;
  if (!(node.parentElement instanceof HTMLElement)) return null;

  const element = node.parentElement.closest<HTMLDivElement>("[data-editor-virtual-row]");
  if (!element || !boundary.contains(element)) return null;
  return element;
}

export function rowChunkFromDomBoundary(
  row: VirtualizedTextRow,
  node: Node,
): VirtualizedTextChunk | null {
  for (const chunk of row.chunks) {
    if (node === chunk.textNode || node === chunk.element) return chunk;
    if (chunk.element?.contains(node)) return chunk;
  }

  return null;
}

export function mountedChunkForOffset(
  row: VirtualizedTextRow,
  offset: number,
): VirtualizedTextChunk | null {
  for (const chunk of row.chunks) {
    if (offset < chunk.startOffset || offset > chunk.endOffset) continue;
    return chunk;
  }

  return null;
}

export function mountedOffsetRange(rows: readonly VirtualizedTextRow[]): OffsetRange | null {
  const first = rows[0];
  const last = rows.at(-1);
  if (!first || !last) return null;

  return {
    start: first.startOffset,
    end: last.endOffset,
  };
}

export function firstIntersectingMountedRow(
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

export function getOrCreateTokenSegments(
  segmentsByRow: Map<number, TokenRowSegment[]>,
  rowSlotId: number,
): TokenRowSegment[] {
  const existing = segmentsByRow.get(rowSlotId);
  if (existing) return existing;

  const segments: TokenRowSegment[] = [];
  segmentsByRow.set(rowSlotId, segments);
  return segments;
}

export function appendTokenSegmentForChunk(
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

export function tokenRowSignature(
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

export function addTokenRangeToChunk(
  document: Document,
  highlight: Highlight,
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): Range | null {
  if (end <= chunk.startOffset || start >= chunk.endOffset) return null;

  const range = document.createRange();
  range.setStart(chunk.textNode, clamp(start - chunk.startOffset, 0, chunk.textNode.length));
  range.setEnd(chunk.textNode, clamp(end - chunk.startOffset, 0, chunk.textNode.length));
  highlight.add(range);
  return range;
}

export function appendTokenRange(
  rangesByStyle: Map<string, AbstractRange[]>,
  styleKey: string,
  range: AbstractRange,
): void {
  const ranges = rangesByStyle.get(styleKey);
  if (ranges) {
    ranges.push(range);
    return;
  }

  rangesByStyle.set(styleKey, [range]);
}

export function firstRangeRect(range: Range): DOMRect | null {
  const rects = range.getClientRects();
  const first = rects.item(0);
  if (first) return first;

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return rect;
}

export function countValidCaretChecks(
  rows: readonly VirtualizedTextRow[],
  failures: string[],
): number {
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

export function countValidSelectionChecks(
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

export function countValidHitTestChecks(
  scrollElement: HTMLElement,
  rows: readonly VirtualizedTextRow[],
  failures: string[],
): number {
  const documentWithCaret = scrollElement.ownerDocument as DocumentWithCaretHitTesting;
  const probe = hitTestProbePoint(rows);
  if (!probe) return 0;

  const node = hitTestNodeFromPoint(documentWithCaret, probe.x, probe.y);
  if (!node) return 0;
  if (!rows.some((row) => row.element.contains(node))) {
    failures.push("hit test missed mounted rows");
  }
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

export function updateMutableRow(
  row: MountedVirtualizedTextRow,
  values: {
    readonly index: number;
    readonly bufferRow: number;
    readonly startOffset: number;
    readonly endOffset: number;
    readonly text: string;
    readonly kind: "text" | "block";
    readonly top: number;
    readonly height: number;
    readonly textRevision: number;
    readonly chunkKey: string;
    readonly foldMarkerKey: string;
    readonly foldCollapsed: boolean;
    readonly displayKind: "text" | "block";
  },
): void {
  const mutable = row as {
    index: number;
    bufferRow: number;
    startOffset: number;
    endOffset: number;
    text: string;
    kind: "text" | "block";
    top: number;
    height: number;
    textRevision: number;
    chunkKey: string;
    foldMarkerKey: string;
    foldCollapsed: boolean;
    displayKind: "text" | "block";
  };
  mutable.index = values.index;
  mutable.bufferRow = values.bufferRow;
  mutable.startOffset = values.startOffset;
  mutable.endOffset = values.endOffset;
  mutable.text = values.text;
  mutable.kind = values.kind;
  mutable.top = values.top;
  mutable.height = values.height;
  mutable.textRevision = values.textRevision;
  mutable.chunkKey = values.chunkKey;
  mutable.foldMarkerKey = values.foldMarkerKey;
  mutable.foldCollapsed = values.foldCollapsed;
  mutable.displayKind = values.displayKind;
}

export function updateMutableRowChunks(
  row: MountedVirtualizedTextRow,
  chunks: readonly VirtualizedTextChunk[],
): void {
  const mutable = row as { chunks: readonly VirtualizedTextChunk[]; textNode: Text };
  mutable.chunks = chunks;
  mutable.textNode = chunks[0]?.textNode ?? row.textNode;
}

export function removeRowElements(row: MountedVirtualizedTextRow): void {
  row.element.remove();
  row.gutterElement.remove();
}

export function scrollElementPadding(element: HTMLElement): {
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

export function setElementHidden(element: HTMLElement, hidden: boolean): void {
  if (element.hidden === hidden) return;
  element.hidden = hidden;
}

export function setStyleValue(element: HTMLElement, property: string, value: string): void {
  if (element.style.getPropertyValue(property) === value) return;
  element.style.setProperty(property, value);
}

export function setCounterSet(element: HTMLElement, value: string): void {
  if (element.style.counterSet === value) return;
  element.style.counterSet = value;
}

function setDatasetValue(element: HTMLElement, key: string, value: string): void {
  if (element.dataset[key] === value) return;
  element.dataset[key] = value;
}

function deleteDatasetValue(element: HTMLElement, key: string): void {
  if (element.dataset[key] === undefined) return;
  delete element.dataset[key];
}

function setAttributeValue(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) === value) return;
  element.setAttribute(name, value);
}

function removeAttributeValue(element: HTMLElement, name: string): void {
  if (!element.hasAttribute(name)) return;
  element.removeAttribute(name);
}

export function parseCssPixels(value: string | undefined): number | null {
  if (!value) return null;

  const pixels = Number.parseFloat(value);
  if (!Number.isFinite(pixels)) return null;
  return pixels;
}

export function pointVerticalDirection(clientY: number, top: number, bottom: number): number {
  if (clientY < top) return -1;
  if (clientY >= bottom) return 1;
  return 0;
}

export function alignChunkStart(value: number, chunkSize: number): number {
  return Math.floor(value / chunkSize) * chunkSize;
}

export function alignChunkEnd(value: number, chunkSize: number): number {
  return Math.ceil(value / chunkSize) * chunkSize;
}

export function foldMapMatchesText(foldMap: FoldMap | null, text: string): boolean {
  if (!foldMap) return false;
  return foldMap.snapshot.length === text.length;
}

export function asFoldPoint(point: { readonly row: number; readonly column: number }): FoldPoint {
  return point as FoldPoint;
}

export function getDefaultHighlightRegistry(): HighlightRegistry | null {
  const css = globalThis.CSS as { highlights?: HighlightRegistry } | undefined;
  return css?.highlights ?? null;
}

export function rangesIntersect(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): boolean {
  return endA > startB && startA < endB;
}

export function rangesIntersectInclusive(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): boolean {
  return endA >= startB && startA <= endB;
}

export function visualColumn(text: string): number {
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
