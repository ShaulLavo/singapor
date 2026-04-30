import { bufferPointToFoldPoint, foldPointToBufferPoint, type FoldMap } from "../foldMap";
import {
  DEFAULT_TAB_SIZE,
  bufferColumnToVisualColumn,
  createDisplayRows,
  visualColumnToBufferColumn,
  type BlockRow,
  type DisplayRow,
  type DisplayTextRow,
} from "../displayTransforms";
import type { TextEdit } from "../tokens";
import { clamp } from "../style-utils";
import {
  DEFAULT_ROW_HEIGHT,
  asFoldPoint,
  computeLineStarts,
  foldMapMatchesText,
  foldMarkersEqual,
  normalizeFoldMarkers,
} from "./virtualizedTextViewHelpers";
import type { FixedRowVirtualizerSnapshot } from "./fixedRowVirtualizer";
import type { SameLineEditPatch, VirtualizedFoldMarker } from "./virtualizedTextViewTypes";
import type { VirtualizedTextViewInternal } from "./virtualizedTextViewInternals";

export type FoldStateUpdate = {
  readonly foldMapChanged: boolean;
  readonly foldMarkersChanged: boolean;
  readonly changed: boolean;
};

export function setTextLayoutState(
  view: VirtualizedTextViewInternal,
  text: string,
): { readonly lineCountChanged: boolean } {
  const previousLineCount = view.lineStarts.length;
  view.text = text;
  view.textRevision += 1;
  view.lineStarts = computeLineStarts(text);
  view.foldMap = foldMapMatchesText(view.foldMap, text) ? view.foldMap : null;
  return { lineCountChanged: previousLineCount !== view.lineStarts.length };
}

export function setFoldStateLayout(
  view: VirtualizedTextViewInternal,
  markers: readonly VirtualizedFoldMarker[],
  foldMap: FoldMap | null,
): FoldStateUpdate {
  const nextFoldMap = foldMapMatchesText(foldMap, view.text) ? foldMap : null;
  const foldMapChanged = view.foldMap !== nextFoldMap;
  if (!foldMapChanged && markers.length === 0 && view.foldMarkers.length === 0) {
    return { foldMapChanged: false, foldMarkersChanged: false, changed: false };
  }

  const nextFoldMarkers = normalizeFoldMarkers(markers, view.text.length);
  const foldMarkersChanged = !foldMarkersEqual(view.foldMarkers, nextFoldMarkers);
  if (!foldMapChanged && !foldMarkersChanged) {
    return { foldMapChanged: false, foldMarkersChanged: false, changed: false };
  }

  view.foldMarkers = nextFoldMarkers;
  view.foldMap = nextFoldMap;
  return { foldMapChanged, foldMarkersChanged, changed: true };
}

export function rebuildDisplayRows(
  view: VirtualizedTextViewInternal,
  viewportColumns: number | null,
): void {
  view.currentWrapColumn = view.wrapEnabled ? viewportColumns : null;
  view.displayRows = createDisplayRows({
    text: view.text,
    lineStarts: view.lineStarts,
    visibleLineCount: foldVisibleLineCount(view),
    bufferRowForVisibleRow: (row) => foldBufferRowForVisibleRow(view, row),
    wrapColumn: view.currentWrapColumn,
    blocks: view.blockRows,
    tabSize: DEFAULT_TAB_SIZE,
  });
}

export function refreshDisplayRowsForWrapWidth(
  view: VirtualizedTextViewInternal,
  viewportColumns: number,
): boolean {
  if (!view.wrapEnabled) return false;
  if (viewportColumns === view.currentWrapColumn) return false;

  rebuildDisplayRows(view, viewportColumns);
  return true;
}

export function setWrapEnabledLayout(
  view: VirtualizedTextViewInternal,
  enabled: boolean,
  viewportColumns: number | null,
): boolean {
  if (view.wrapEnabled === enabled) return false;

  view.wrapEnabled = enabled;
  view.currentWrapColumn = null;
  rebuildDisplayRows(view, viewportColumns);
  return true;
}

export function setBlockRowsLayout(
  view: VirtualizedTextViewInternal,
  blockRows: readonly BlockRow[],
  viewportColumns: number | null,
): void {
  view.blockRows = blockRows;
  rebuildDisplayRows(view, viewportColumns);
}

export function updateVirtualizerRows(view: VirtualizedTextViewInternal): void {
  view.virtualizer.updateOptions({
    count: visibleLineCount(view),
    rowSizes: rowSizes(view),
  });
}

export function rowSizes(view: VirtualizedTextViewInternal): readonly number[] | undefined {
  if (!hasVariableRows(view)) return undefined;

  const rowHeight = view.metrics.rowHeight;
  return view.displayRows.map((row) => {
    if (row.kind === "block") return row.heightRows * rowHeight;
    return rowHeight;
  });
}

export function hasVariableRows(view: VirtualizedTextViewInternal): boolean {
  for (const row of view.blockRows) {
    if (normalizeBlockHeightRows(row.heightRows) !== 1) return true;
  }

  return false;
}

export function rowTop(view: VirtualizedTextViewInternal, row: number): number {
  const sizes = rowSizes(view);
  if (!sizes) return row * getRowHeight(view);

  let top = 0;
  for (let index = 0; index < row; index += 1) top += sizes[index] ?? 0;
  return top;
}

export function rowHeight(view: VirtualizedTextViewInternal, row: number): number {
  return rowSizes(view)?.[row] ?? getRowHeight(view);
}

export function scrollPastEndPadding(
  view: VirtualizedTextViewInternal,
  viewportHeight: number,
): number {
  const lastRow = visibleLineCount(view) - 1;
  return Math.max(0, viewportHeight - rowHeight(view, lastRow));
}

export function scrollableHeight(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
): number {
  return snapshot.totalSize + scrollPastEndPadding(view, snapshot.viewportHeight);
}

export function displayRowKind(view: VirtualizedTextViewInternal, row: number): "text" | "block" {
  return view.displayRows[row]?.kind ?? "text";
}

export function visualColumnForOffset(view: VirtualizedTextViewInternal, offset: number): number {
  const row = rowForOffset(view, offset);
  const displayRow = view.displayRows[row];
  if (!displayRow || displayRow.kind === "block") return 0;

  const localOffset = clamp(offset - displayRow.startOffset, 0, displayRow.text.length);
  return bufferColumnToVisualColumn(displayRow.text, localOffset, DEFAULT_TAB_SIZE);
}

export function offsetForViewportColumn(
  view: VirtualizedTextViewInternal,
  row: number,
  visualColumn: number,
): number {
  const displayRow = view.displayRows[row];
  if (!displayRow) return view.text.length;
  if (displayRow.kind === "block") return displayRow.startOffset;

  const bufferColumn = visualColumnToBufferColumn(
    displayRow.text,
    visualColumn,
    "nearest",
    DEFAULT_TAB_SIZE,
  );
  return displayRow.startOffset + clamp(bufferColumn, 0, displayRow.text.length);
}

export function lineStartOffset(view: VirtualizedTextViewInternal, row: number): number {
  return view.displayRows[row]?.startOffset ?? view.text.length;
}

export function lineEndOffset(view: VirtualizedTextViewInternal, row: number): number {
  return view.displayRows[row]?.endOffset ?? view.text.length;
}

export function bufferLineStartOffset(view: VirtualizedTextViewInternal, row: number): number {
  return view.lineStarts[row] ?? view.text.length;
}

export function lineText(view: VirtualizedTextViewInternal, row: number): string {
  return view.displayRows[row]?.text ?? "";
}

export function sameLineEditPatch(
  view: VirtualizedTextViewInternal,
  edit: TextEdit,
): SameLineEditPatch | null {
  if (view.foldMap) return null;
  if (view.wrapEnabled || view.blockRows.length > 0) return null;
  if (edit.from < 0 || edit.to < edit.from || edit.to > view.text.length) return null;
  if (edit.text.includes("\n")) return null;
  if (view.text.slice(edit.from, edit.to).includes("\n")) return null;

  const rowIndex = rowForOffset(view, edit.from);
  if (lineText(view, rowIndex).length > view.longLineChunkThreshold) return null;
  return {
    rowIndex,
    localFrom: edit.from - lineStartOffset(view, rowIndex),
    deleteLength: edit.to - edit.from,
    text: edit.text,
  };
}

export function rowForOffset(view: VirtualizedTextViewInternal, offset: number): number {
  const bufferRow = bufferRowForOffset(view, offset);
  if (!usesDisplayRowTransforms(view)) return foldVirtualRowForBufferRow(view, bufferRow);

  const displayRow = textDisplayRowForOffset(view, clamp(offset, 0, view.text.length));
  if (displayRow) return displayRow.index;

  return virtualRowForBufferRow(view, bufferRow);
}

export function bufferRowForOffset(view: VirtualizedTextViewInternal, offset: number): number {
  const clamped = clamp(offset, 0, view.text.length);
  let low = 0;
  let high = view.lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = bufferLineStartOffset(view, middle);
    const next = bufferLineStartOffset(view, middle + 1);
    if (clamped < start) {
      high = middle - 1;
      continue;
    }
    if (clamped >= next && middle + 1 < view.lineStarts.length) {
      low = middle + 1;
      continue;
    }
    return middle;
  }

  return view.lineStarts.length - 1;
}

export function rowForViewportY(view: VirtualizedTextViewInternal, y: number): number {
  const offset = view.scrollElement.scrollTop + y;
  const sizes = rowSizes(view);
  if (!sizes) return clamp(Math.floor(offset / getRowHeight(view)), 0, visibleLineCount(view) - 1);

  let top = 0;
  for (let row = 0; row < sizes.length; row += 1) {
    top += sizes[row] ?? 0;
    if (offset < top) return row;
  }

  return visibleLineCount(view) - 1;
}

export function visibleLineCount(view: VirtualizedTextViewInternal): number {
  return Math.max(1, view.displayRows.length);
}

export function foldVisibleLineCount(view: VirtualizedTextViewInternal): number {
  if (!view.foldMap) return view.lineStarts.length;

  const hidden = view.foldMap.ranges.reduce((count, range) => {
    return count + Math.max(0, range.endPoint.row - range.startPoint.row);
  }, 0);
  return Math.max(1, view.lineStarts.length - hidden);
}

export function bufferRowForVirtualRow(view: VirtualizedTextViewInternal, row: number): number {
  const displayRow = view.displayRows[row];
  if (displayRow?.kind === "text") return displayRow.bufferRow;
  if (displayRow?.kind === "block") return displayRow.anchorBufferRow;
  return foldBufferRowForVisibleRow(view, row);
}

export function foldBufferRowForVisibleRow(view: VirtualizedTextViewInternal, row: number): number {
  if (!view.foldMap) return clamp(row, 0, view.lineStarts.length - 1);
  const point = foldPointToBufferPoint(view.foldMap, asFoldPoint({ row, column: 0 }));
  return clamp(point.row, 0, view.lineStarts.length - 1);
}

export function virtualRowForBufferRow(view: VirtualizedTextViewInternal, row: number): number {
  if (!usesDisplayRowTransforms(view)) return foldVirtualRowForBufferRow(view, row);

  const match = textDisplayRowForBufferRow(view.displayRows, row);
  if (match) return match.index;

  return transformedRowForProjectedBufferRow(view, row);
}

export function foldVirtualRowForBufferRow(view: VirtualizedTextViewInternal, row: number): number {
  if (!view.foldMap) return clamp(row, 0, visibleLineCount(view) - 1);

  const point = bufferPointToFoldPoint(view.foldMap, { row, column: 0 });
  return clamp(point.row, 0, visibleLineCount(view) - 1);
}

export function getRowHeight(view: VirtualizedTextViewInternal): number {
  const row = view.virtualizer.getSnapshot().virtualItems[0];
  return row?.size ?? DEFAULT_ROW_HEIGHT;
}

export function rowForSnapshotOffset(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
  y: number,
): number {
  const offset = snapshot.scrollTop + y;
  const sizes = rowSizes(view);
  if (!sizes) return clamp(Math.floor(offset / getRowHeight(view)), 0, visibleLineCount(view) - 1);

  let top = 0;
  for (let row = 0; row < sizes.length; row += 1) {
    top += sizes[row] ?? 0;
    if (offset < top) return row;
  }

  return visibleLineCount(view) - 1;
}

function usesDisplayRowTransforms(view: VirtualizedTextViewInternal): boolean {
  if (view.wrapEnabled) return true;
  return view.blockRows.length > 0;
}

function normalizeBlockHeightRows(heightRows: number): number {
  if (!Number.isFinite(heightRows) || heightRows <= 0) return 1;
  return Math.max(1, Math.floor(heightRows));
}

function textDisplayRowForOffset(
  view: VirtualizedTextViewInternal,
  offset: number,
): DisplayTextRow | null {
  const rows = view.displayRows;
  const start = firstDisplayRowEndingAtOrAfter(rows, offset);
  if (start === -1) return null;

  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.startOffset > offset) return null;
    if (row.kind !== "text") continue;
    if (offset <= row.endOffset) return row;
  }

  return null;
}

function firstDisplayRowEndingAtOrAfter(rows: readonly DisplayRow[], offset: number): number {
  let low = 0;
  let high = rows.length - 1;
  let result = rows.length;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle]!.endOffset >= offset) {
      result = middle;
      high = middle - 1;
      continue;
    }

    low = middle + 1;
  }

  if (result === rows.length) return -1;
  return result;
}

function textDisplayRowForBufferRow(
  rows: readonly DisplayRow[],
  bufferRow: number,
): DisplayTextRow | null {
  const start = firstDisplayRowAtOrAfterBufferRow(rows, bufferRow);
  if (start === -1) return null;

  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index]!;
    const orderRow = displayRowBufferOrder(row);
    if (orderRow > bufferRow) return null;
    if (row.kind === "text" && row.bufferRow === bufferRow) return row;
  }

  return null;
}

function firstDisplayRowAtOrAfterBufferRow(rows: readonly DisplayRow[], bufferRow: number): number {
  let low = 0;
  let high = rows.length - 1;
  let result = rows.length;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (displayRowBufferOrder(rows[middle]!) >= bufferRow) {
      result = middle;
      high = middle - 1;
      continue;
    }

    low = middle + 1;
  }

  if (result === rows.length) return -1;
  return result;
}

function displayRowBufferOrder(row: DisplayRow): number {
  if (row.kind === "text") return row.bufferRow;
  return row.anchorBufferRow;
}

function transformedRowForProjectedBufferRow(
  view: VirtualizedTextViewInternal,
  row: number,
): number {
  const foldedRow = foldVirtualRowForBufferRow(view, row);
  const bufferRow = foldBufferRowForVisibleRow(view, foldedRow);
  const match = textDisplayRowForBufferRow(view.displayRows, bufferRow);
  if (match) return match.index;

  return foldedRow;
}
