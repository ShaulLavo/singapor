import { bufferPointToFoldPoint, foldPointToBufferPoint, type FoldMap } from '../foldMap'
import {
  bufferColumnToVisualColumn,
  isDocumentTextDisplayRow,
  visualColumnToBufferColumn,
  type DisplayRow,
  type DisplayTextRow,
  type InjectedTextRow,
} from '../displayTransforms'
import type { TextSnapshot } from '../documentTextSnapshot'
import type { TextEdit } from '../tokens'
import { clamp } from '../style-utils'
import { createLineStartOffsetIndex } from './lineStartIndex'
import {
  asFoldPoint,
  computeLineStarts,
  foldMapMatchesText,
  foldMarkersEqual,
  inlineMapMatchesText,
  indexFoldMarkersByKey,
  indexFoldMarkersByStartRow,
  normalizeFoldMarkers,
  normalizeRowHeight,
} from './virtualizedTextViewHelpers'
import type { FixedRowVirtualizerSnapshot } from './fixedRowVirtualizer'
import { createVirtualizedTextViewModel } from './virtualizedTextViewModel'
import type {
  MultiLineEditPatch,
  SameLineEditPatch,
  VirtualizedFoldMarker,
} from './virtualizedTextViewTypes'
import type { VirtualizedTextViewInternal } from './virtualizedTextViewInternals'
import {
  localIndexForOffset,
  offsetForLocalIndex,
  rowInlineMappingForDisplayRow,
} from './virtualizedTextViewInlineMapping'

export type FoldStateUpdate = {
  readonly foldMapChanged: boolean
  readonly foldMarkersChanged: boolean
  readonly changed: boolean
}

export function setTextLayoutState(
  view: VirtualizedTextViewInternal,
  text: string,
  textSnapshot: TextSnapshot,
): { readonly lineCountChanged: boolean } {
  const previousLineCount = view.lineStarts.length
  view.text = text
  view.model.textSnapshot = textSnapshot
  view.model.textLength = text.length
  view.textRevision += 1
  view.lineStarts = computeLineStarts(text)
  view.lineStartOffsetIndex = null
  view.model.lineCount = view.lineStarts.length
  view.model.foldMap = foldMapMatchesText(view.model.foldMap, view.model.textLength)
    ? view.model.foldMap
    : null
  view.model.inlineMap = inlineMapMatchesText(view.model.inlineMap, view.model.textLength)
    ? view.model.inlineMap
    : null
  return { lineCountChanged: previousLineCount !== view.lineStarts.length }
}

export function setTextSnapshotLayoutState(
  view: VirtualizedTextViewInternal,
  textSnapshot: TextSnapshot,
): { readonly lineCountChanged: boolean } {
  const previousLineCount = view.lineStarts.length
  view.text = ''
  view.model.textSnapshot = textSnapshot
  view.model.textLength = textSnapshot.length
  view.textRevision += 1
  view.lineStarts = computeLineStartsFromSnapshot(textSnapshot)
  view.lineStartOffsetIndex = null
  view.model.lineCount = view.lineStarts.length
  view.model.foldMap = foldMapMatchesText(view.model.foldMap, view.model.textLength)
    ? view.model.foldMap
    : null
  view.model.inlineMap = inlineMapMatchesText(view.model.inlineMap, view.model.textLength)
    ? view.model.inlineMap
    : null
  return { lineCountChanged: previousLineCount !== view.lineStarts.length }
}

export function applySameLineTextLayout(
  view: VirtualizedTextViewInternal,
  patch: SameLineEditPatch,
  textSnapshot: TextSnapshot,
): void {
  const delta = patch.text.length - patch.deleteLength
  view.model.textSnapshot = textSnapshot
  view.model.textLength = textSnapshot.length
  view.textRevision += 1
  view.model.foldMap = null
  view.model.inlineMap = null
  shiftLineStartsAfterRow(view, patch.rowIndex, delta)
  updateDisplayRowsAfterSameLineEdit(view, patch, delta)
  syncViewModelCounts(view)
}

export function applyMultiLineTextLayout(
  view: VirtualizedTextViewInternal,
  patch: MultiLineEditPatch,
  edit: TextEdit,
  textSnapshot: TextSnapshot,
): void {
  view.model.textSnapshot = textSnapshot
  view.model.textLength = textSnapshot.length
  view.textRevision += 1
  view.model.foldMap = null
  view.model.inlineMap = null
  view.lineStarts = lineStartsAfterMultiLineEdit(view.lineStarts, edit)
  view.lineStartOffsetIndex = null
  updateDisplayRowsAfterMultiLineEdit(view, patch)
  syncViewModelCounts(view)
}

export function setFoldStateLayout(
  view: VirtualizedTextViewInternal,
  markers: readonly VirtualizedFoldMarker[],
  foldMap: FoldMap | null,
): FoldStateUpdate {
  const nextFoldMap = foldMapMatchesText(foldMap, view.model.textLength) ? foldMap : null
  const foldMapChanged = view.model.foldMap !== nextFoldMap
  if (!foldMapChanged && markers.length === 0 && view.foldMarkers.length === 0) {
    return { foldMapChanged: false, foldMarkersChanged: false, changed: false }
  }

  const nextFoldMarkers = normalizeFoldMarkers(markers, view.model.textLength)
  const foldMarkersChanged = !foldMarkersEqual(view.foldMarkers, nextFoldMarkers)
  if (!foldMapChanged && !foldMarkersChanged) {
    return { foldMapChanged: false, foldMarkersChanged: false, changed: false }
  }

  if (foldMarkersChanged) {
    view.foldMarkers = nextFoldMarkers
    view.foldMarkerByStartRow = indexFoldMarkersByStartRow(nextFoldMarkers)
    view.foldMarkerByKey = indexFoldMarkersByKey(nextFoldMarkers)
  }

  view.model.foldMap = nextFoldMap
  return { foldMapChanged, foldMarkersChanged, changed: true }
}

export function rebuildDisplayRows(
  view: VirtualizedTextViewInternal,
  viewportColumns: number | null,
): void {
  materializeLineStarts(view)
  const model = createVirtualizedTextViewModel({
    textSnapshot: view.model.textSnapshot,
    lineStarts: view.lineStarts,
    foldMap: view.model.foldMap,
    inlineMap: view.model.inlineMap,
    injectedTextRows: view.model.injectedTextRows,
    wrapColumn: view.wrapEnabled ? viewportColumns : null,
    tabSize: view.tabSize,
  })
  view.model = model
}

export function refreshDisplayRowsForWrapWidth(
  view: VirtualizedTextViewInternal,
  viewportColumns: number,
): boolean {
  if (!view.wrapEnabled) return false
  if (viewportColumns === view.model.wrapColumn) return false

  rebuildDisplayRows(view, viewportColumns)
  return true
}

export function setWrapEnabledLayout(
  view: VirtualizedTextViewInternal,
  enabled: boolean,
  viewportColumns: number | null,
): boolean {
  if (view.wrapEnabled === enabled) return false

  view.wrapEnabled = enabled
  view.model.wrapColumn = null
  rebuildDisplayRows(view, viewportColumns)
  return true
}

export function setInjectedTextRowsLayout(
  view: VirtualizedTextViewInternal,
  injectedTextRows: readonly InjectedTextRow[],
  viewportColumns: number | null,
): void {
  view.model.injectedTextRows = injectedTextRows
  rebuildDisplayRows(view, viewportColumns)
}

export function updateVirtualizerRows(view: VirtualizedTextViewInternal): void {
  const changed = view.virtualizer.updateOptions({
    count: visibleLineCount(view),
    rowGap: view.rowGap,
    rowHeight: getRowHeight(view),
  })
  if (!changed && view.lastRenderedRowsKey === '') view.virtualizer.refresh()
}

export function rowTop(view: VirtualizedTextViewInternal, row: number): number {
  return row * rowStride(view)
}

export function scrollableHeight(
  _view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
): number {
  return snapshot.scrollHeight
}

export function visualColumnForOffset(view: VirtualizedTextViewInternal, offset: number): number {
  const row = rowForOffset(view, offset)
  const displayRow = view.model.rows[row]
  if (!isDocumentTextDisplayRow(displayRow)) return 0

  const localOffset = clamp(
    localIndexForOffset(
      rowInlineMappingForDisplayRow(displayRow),
      displayRowStartOffset(view, row),
      offset,
    ),
    0,
    displayRow.text.length,
  )
  return bufferColumnToVisualColumn(displayRow.text, localOffset, view.tabSize)
}

export function offsetForViewportColumn(
  view: VirtualizedTextViewInternal,
  row: number,
  visualColumn: number,
): number {
  const displayRow = view.model.rows[row]
  if (!displayRow) return view.model.textLength
  const startOffset = displayRowStartOffset(view, row)
  if (!isDocumentTextDisplayRow(displayRow)) return startOffset

  const bufferColumn = visualColumnToBufferColumn(
    displayRow.text,
    visualColumn,
    'nearest',
    view.tabSize,
  )
  return offsetForLocalIndex(
    rowInlineMappingForDisplayRow(displayRow),
    startOffset,
    clamp(bufferColumn, 0, displayRow.text.length),
  )
}

export function lineStartOffset(view: VirtualizedTextViewInternal, row: number): number {
  if (usesPlainDisplayRows(view)) return bufferLineStartOffset(view, row)
  return displayRowStartOffset(view, row)
}

export function lineEndOffset(view: VirtualizedTextViewInternal, row: number): number {
  if (usesPlainDisplayRows(view)) return bufferLineEndOffset(view, row)
  return displayRowEndOffset(view, row)
}

export function bufferLineStartOffset(view: VirtualizedTextViewInternal, row: number): number {
  if (row < 0 || row >= view.lineStarts.length) return view.model.textLength
  const offset = view.lineStartOffsetIndex?.offsetAt(row) ?? 0
  return (view.lineStarts[row] ?? 0) + offset
}

export function lineText(view: VirtualizedTextViewInternal, row: number): string {
  return view.model.rows[row]?.text ?? ''
}

function bufferLineEndOffset(view: VirtualizedTextViewInternal, row: number): number {
  if (row < 0) return view.model.textLength
  if (row >= view.lineStarts.length - 1) return view.model.textLength

  return Math.max(bufferLineStartOffset(view, row), bufferLineStartOffset(view, row + 1) - 1)
}

// indexOf rather than a per-character compare, matching computeLineStarts:
// indexing a string allocates a one-character string per character, which on a
// large document costs more than the scan itself.
function computeLineStartsFromSnapshot(snapshot: TextSnapshot): number[] {
  const lineStarts = [0]
  snapshot.forEachTextChunk((text, chunkStart) => {
    let index = text.indexOf('\n')
    while (index !== -1) {
      lineStarts.push(chunkStart + index + 1)
      index = text.indexOf('\n', index + 1)
    }
  })
  return lineStarts
}

export function materializeLineStarts(view: VirtualizedTextViewInternal): readonly number[] {
  const offsetIndex = view.lineStartOffsetIndex
  if (!offsetIndex?.dirty) return view.lineStarts

  view.lineStarts = offsetIndex.materialize(view.lineStarts)
  view.lineStartOffsetIndex = null
  return view.lineStarts
}

function shiftLineStartsAfterRow(
  view: VirtualizedTextViewInternal,
  rowIndex: number,
  delta: number,
): void {
  if (delta === 0) return

  const offsetIndex =
    view.lineStartOffsetIndex ?? createLineStartOffsetIndex(view.lineStarts.length)
  offsetIndex.addSuffix(rowIndex + 1, delta)
  view.lineStartOffsetIndex = offsetIndex.dirty ? offsetIndex : null
}

function updateDisplayRowsAfterSameLineEdit(
  view: VirtualizedTextViewInternal,
  patch: SameLineEditPatch,
  delta: number,
): void {
  const row = view.model.rows[patch.rowIndex]
  if (!row) return
  if (row.kind !== 'text') return

  view.model.rows[patch.rowIndex] = updateTextDisplayRow(row, patch, delta)
}

function updateDisplayRowsAfterMultiLineEdit(
  view: VirtualizedTextViewInternal,
  patch: MultiLineEditPatch,
): void {
  const replacementRows = createPlainDisplayRowsForRange(
    view,
    patch.startRow,
    patch.startRow + patch.insertedLineBreaks,
  )
  const suffix = shiftPlainDisplayRows(
    view.model.rows.slice(patch.endRow + 1),
    patch.insertedLineBreaks - (patch.endRow - patch.startRow),
    patch.delta,
  )

  view.model.rows = view.model.rows.slice(0, patch.startRow).concat(replacementRows, suffix)
}

function createPlainDisplayRowsForRange(
  view: VirtualizedTextViewInternal,
  startRow: number,
  endRow: number,
): DisplayRow[] {
  const rows: DisplayRow[] = []
  const lastRow = view.lineStarts.length - 1
  for (let rowIndex = startRow; rowIndex <= endRow && rowIndex <= lastRow; rowIndex += 1) {
    const startOffset = bufferLineStartOffset(view, rowIndex)
    const endOffset = bufferLineEndOffset(view, rowIndex)
    const text = view.model.textSnapshot.readRange(startOffset, endOffset)
    rows.push({
      kind: 'text',
      source: 'document',
      index: rowIndex,
      bufferRow: rowIndex,
      startOffset,
      endOffset,
      text,
      sourceText: text,
      sourceStartColumn: 0,
      sourceEndColumn: text.length,
      displayStartColumn: 0,
      displayEndColumn: text.length,
      wrapSegment: 0,
    })
  }

  return rows
}

function shiftPlainDisplayRows(
  rows: readonly DisplayRow[],
  rowDelta: number,
  offsetDelta: number,
): DisplayRow[] {
  if (rowDelta === 0 && offsetDelta === 0) return [...rows]

  return rows.map((row) => {
    if (row.kind !== 'text' || row.source !== 'document') return row
    return {
      ...row,
      index: row.index + rowDelta,
      bufferRow: row.bufferRow + rowDelta,
      startOffset: row.startOffset + offsetDelta,
      endOffset: row.endOffset + offsetDelta,
    }
  })
}

function updateTextDisplayRow(
  row: DisplayTextRow,
  patch: SameLineEditPatch,
  delta: number,
): DisplayTextRow {
  const suffixStart = patch.localFrom + patch.deleteLength
  const text = `${row.text.slice(0, patch.localFrom)}${patch.text}${row.text.slice(suffixStart)}`
  return {
    ...row,
    endOffset: row.endOffset + delta,
    text,
    sourceText: text,
    sourceEndColumn: row.sourceEndColumn + delta,
    displayEndColumn: row.displayEndColumn + delta,
  }
}

function lineStartsAfterMultiLineEdit(lineStarts: readonly number[], edit: TextEdit): number[] {
  const delta = edit.text.length - (edit.to - edit.from)
  const next: number[] = []
  for (const start of lineStarts) {
    if (start <= edit.from) next.push(start)
  }

  forEachInsertedLineStart(edit, (start) => next.push(start))

  for (const start of lineStarts) {
    if (start > edit.to) next.push(start + delta)
  }

  return next.length > 0 ? next : [0]
}

function forEachInsertedLineStart(edit: TextEdit, visit: (start: number) => void): void {
  for (let index = 0; index < edit.text.length; index += 1) {
    if (edit.text[index] !== '\n') continue
    visit(edit.from + index + 1)
  }
}

function lineBreakCount(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') count += 1
  }
  return count
}

export function sameLineEditPatch(
  view: VirtualizedTextViewInternal,
  edit: TextEdit,
): SameLineEditPatch | null {
  if (view.model.foldMap) return null
  if (view.wrapEnabled || hasModelRowProjections(view)) return null
  if (edit.from < 0 || edit.to < edit.from || edit.to > view.model.textLength) return null
  if (edit.text.includes('\n')) return null

  const rowIndex = bufferRowForOffset(view, edit.from)
  if (rowIndex !== bufferRowForOffset(view, edit.to)) return null
  if (lineText(view, rowIndex).length > view.longLineChunkThreshold) return null
  return {
    rowIndex,
    localFrom: edit.from - lineStartOffset(view, rowIndex),
    deleteLength: edit.to - edit.from,
    text: edit.text,
  }
}

export function multiLineEditPatch(
  view: VirtualizedTextViewInternal,
  edit: TextEdit,
): MultiLineEditPatch | null {
  if (view.model.foldMap) return null
  if (view.wrapEnabled || hasModelRowProjections(view)) return null
  if (edit.from < 0 || edit.to < edit.from || edit.to > view.model.textLength) return null

  materializeLineStarts(view)
  const startRow = bufferRowForOffset(view, edit.from)
  const endRow = bufferRowForOffset(view, edit.to)
  if (!edit.text.includes('\n') && startRow === endRow) return null
  return {
    startRow,
    endRow,
    insertedLineBreaks: lineBreakCount(edit.text),
    delta: edit.text.length - (edit.to - edit.from),
  }
}

export function rowForOffset(view: VirtualizedTextViewInternal, offset: number): number {
  const bufferRow = bufferRowForOffset(view, offset)
  if (!usesDisplayRowTransforms(view)) return foldVirtualRowForBufferRow(view, bufferRow)

  const displayRow = textDisplayRowForOffset(view, clamp(offset, 0, view.model.textLength))
  if (displayRow) return displayRow.index

  return virtualRowForBufferRow(view, bufferRow)
}

export function bufferRowForOffset(view: VirtualizedTextViewInternal, offset: number): number {
  const clamped = clamp(offset, 0, view.model.textLength)
  let low = 0
  let high = view.lineStarts.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const start = bufferLineStartOffset(view, middle)
    const next = bufferLineStartOffset(view, middle + 1)
    if (clamped < start) {
      high = middle - 1
      continue
    }
    if (clamped >= next && middle + 1 < view.lineStarts.length) {
      low = middle + 1
      continue
    }
    return middle
  }

  return view.lineStarts.length - 1
}

export function rowForViewportY(view: VirtualizedTextViewInternal, y: number): number {
  return fixedRowForOffset(view, view.scrollElement.scrollTop + y)
}

export function visibleLineCount(view: VirtualizedTextViewInternal): number {
  return Math.max(1, view.model.visibleLineCount)
}

export function bufferRowForVirtualRow(view: VirtualizedTextViewInternal, row: number): number {
  const displayRow = view.model.rows[row]
  if (displayRow?.kind === 'text') return displayRow.bufferRow
  return foldBufferRowForVisibleRow(view, row)
}

function foldBufferRowForVisibleRow(view: VirtualizedTextViewInternal, row: number): number {
  if (!view.model.foldMap) return clamp(row, 0, view.lineStarts.length - 1)
  const point = foldPointToBufferPoint(view.model.foldMap, asFoldPoint({ row, column: 0 }))
  return clamp(point.row, 0, view.lineStarts.length - 1)
}

export function virtualRowForBufferRow(view: VirtualizedTextViewInternal, row: number): number {
  if (!usesDisplayRowTransforms(view)) return foldVirtualRowForBufferRow(view, row)

  const match = textDisplayRowForBufferRow(view.model.rows, row)
  if (match) return match.index

  return transformedRowForProjectedBufferRow(view, row)
}

function foldVirtualRowForBufferRow(view: VirtualizedTextViewInternal, row: number): number {
  if (!view.model.foldMap) return clamp(row, 0, visibleLineCount(view) - 1)

  const point = bufferPointToFoldPoint(view.model.foldMap, { row, column: 0 })
  return clamp(point.row, 0, visibleLineCount(view) - 1)
}

export function getRowHeight(view: VirtualizedTextViewInternal): number {
  return normalizeRowHeight(view.metrics.rowHeight)
}

function rowStride(view: VirtualizedTextViewInternal): number {
  return getRowHeight(view) + view.rowGap
}

function fixedRowForOffset(view: VirtualizedTextViewInternal, offset: number): number {
  const rowHeight = getRowHeight(view)
  const stride = rowHeight + view.rowGap
  const row = clamp(Math.floor(offset / stride), 0, visibleLineCount(view) - 1)
  const rowBottom = row * stride + rowHeight
  if (offset < rowBottom) return row

  return Math.min(row + 1, visibleLineCount(view) - 1)
}

function usesDisplayRowTransforms(view: VirtualizedTextViewInternal): boolean {
  if (view.wrapEnabled) return true
  return hasModelRowProjections(view)
}

function usesPlainDisplayRows(view: VirtualizedTextViewInternal): boolean {
  if (view.model.foldMap) return false
  return !usesDisplayRowTransforms(view)
}

function displayRowStartOffset(view: VirtualizedTextViewInternal, row: number): number {
  const displayRow = view.model.rows[row]
  if (!displayRow) return view.model.textLength
  if (usesPlainDisplayRows(view) && isDocumentTextDisplayRow(displayRow))
    return bufferLineStartOffset(view, displayRow.bufferRow)

  return displayRow.startOffset
}

function displayRowEndOffset(view: VirtualizedTextViewInternal, row: number): number {
  const displayRow = view.model.rows[row]
  if (!displayRow) return view.model.textLength
  if (usesPlainDisplayRows(view) && isDocumentTextDisplayRow(displayRow))
    return bufferLineEndOffset(view, displayRow.bufferRow)

  return displayRow.endOffset
}

function textDisplayRowForOffset(
  view: VirtualizedTextViewInternal,
  offset: number,
): DisplayTextRow | null {
  const rows = view.model.rows
  const start = firstDisplayRowEndingAtOrAfter(rows, offset)
  if (start === -1) return null

  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index]!
    if (row.startOffset > offset) return null
    if (!isDocumentTextDisplayRow(row)) continue
    if (offset <= row.endOffset) return row
  }

  return null
}

function firstDisplayRowEndingAtOrAfter(rows: readonly DisplayRow[], offset: number): number {
  let low = 0
  let high = rows.length - 1
  let result = rows.length

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (rows[middle]!.endOffset >= offset) {
      result = middle
      high = middle - 1
      continue
    }

    low = middle + 1
  }

  if (result === rows.length) return -1
  return result
}

function textDisplayRowForBufferRow(
  rows: readonly DisplayRow[],
  bufferRow: number,
): DisplayTextRow | null {
  const start = firstDisplayRowAtOrAfterBufferRow(rows, bufferRow)
  if (start === -1) return null

  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index]!
    const orderRow = displayRowBufferOrder(row)
    if (orderRow > bufferRow) return null
    if (isDocumentTextDisplayRow(row) && row.bufferRow === bufferRow) return row
  }

  return null
}

function firstDisplayRowAtOrAfterBufferRow(rows: readonly DisplayRow[], bufferRow: number): number {
  let low = 0
  let high = rows.length - 1
  let result = rows.length

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (displayRowBufferOrder(rows[middle]!) >= bufferRow) {
      result = middle
      high = middle - 1
      continue
    }

    low = middle + 1
  }

  if (result === rows.length) return -1
  return result
}

function displayRowBufferOrder(row: DisplayRow): number {
  return row.bufferRow
}

function transformedRowForProjectedBufferRow(
  view: VirtualizedTextViewInternal,
  row: number,
): number {
  const foldedRow = foldVirtualRowForBufferRow(view, row)
  const bufferRow = foldBufferRowForVisibleRow(view, foldedRow)
  const match = textDisplayRowForBufferRow(view.model.rows, bufferRow)
  if (match) return match.index

  return foldedRow
}

function syncViewModelCounts(view: VirtualizedTextViewInternal): void {
  view.model.lineCount = Math.max(1, view.lineStarts.length)
  view.model.visibleLineCount = Math.max(1, view.model.rows.length)
}

function hasModelRowProjections(view: VirtualizedTextViewInternal): boolean {
  // An inline map makes row text diverge from buffer text, so the same-line and plain-row fast paths
  // — which patch row text using buffer-space offsets — must fall back to a full rebuild.
  if (view.model.inlineMap) return true
  return view.model.injectedTextRows.length > 0
}
