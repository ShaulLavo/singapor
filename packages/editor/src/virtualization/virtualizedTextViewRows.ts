import {
  isDocumentTextDisplayRow,
  isInjectedTextDisplayRow,
  bufferColumnToVisualColumn,
  visualColumnToBufferColumn,
  visualColumnLength,
  type DisplayInjectedTextRow,
  type DisplayRow,
  type InlineReplacementRender,
  type InlineRow,
} from '../displayTransforms'
import { clamp } from '../style-utils'
import type { InlineMap } from '../inlineMap'
import type { SelectionAffinity } from '../selections'
import type {
  EditorGutterContribution,
  EditorGutterRowContext,
  EditorGutterWidthContext,
} from '../plugins'
import { segmentGraphemes } from '../graphemes'
import type { FixedRowVirtualItem, FixedRowVirtualizerSnapshot } from './fixedRowVirtualizer'
import {
  alignChunkEnd,
  alignChunkStart,
  createRowResizeObserver,
  elementMeasuredSize,
  hideFoldPlaceholder,
  rangesIntersectInclusive,
  restoreRowElements,
  retireRowElements,
  rowElementFromNode,
  scrollElementPadding,
  setStyleValue,
  showFoldPlaceholder,
  snapshotRowsKey,
  updateMutableRow,
  updateMutableRowChunks,
} from './virtualizedTextViewHelpers'
import {
  bufferRowForOffset,
  bufferRowForVirtualRow,
  getRowHeight,
  lineEndOffset,
  lineStartOffset,
  lineText,
  rowForOffset,
  rowTop,
  scrollableHeight,
  updateVirtualizerRows,
  visibleLineCount,
} from './virtualizedTextViewLayout'
import type {
  HorizontalChunkWindow,
  MountedVirtualizedTextRow,
  SameLineEditPatch,
  VirtualizedFoldMarker,
  VirtualizedTextChunk,
  VirtualizedTextChunkPart,
  VirtualizedTextRowDecoration,
  VirtualizedTextRenderMode,
  VirtualizedCaretPosition,
  VirtualizedCaretPositions,
} from './virtualizedTextViewTypes'
import type { VirtualizedTextViewInternal } from './virtualizedTextViewInternals'
import {
  type RowInlineMapping,
  offsetForLocalIndex,
  rowInlineMappingForDisplayRow,
} from './virtualizedTextViewInlineMapping'
import {
  type InlineWidgetPlacement,
  type RenderedChunkParts,
  boundaryPositionXsForAffinity,
  clearRowGeometryCaches,
  createRenderedChunkParts,
  createTextChunkParts,
  domBoundaryForOffset,
  estimatedColumnToBufferColumn,
  estimatedDisplayCellForColumn,
  offsetFromDomBoundary,
  offsetToX,
  isSimpleRowText,
  setInlineWidgetMeasuredWidth,
} from './virtualizedTextViewGeometry'
import {
  clearHiddenCharactersForRow,
  renderHiddenCharacters,
} from './virtualizedTextViewHiddenCharacters'
import { memoizedContainsRTL } from './virtualizedTextViewBidi'

const GUTTER_CELL_CLASS = 'editor-virtualized-gutter-cell'
const CURSOR_LINE_ROW_CLASS = 'editor-virtualized-cursor-line-row'
const CURSOR_LINE_GUTTER_CLASS = 'editor-virtualized-cursor-line-gutter'
const gutterCursorLineStates = new WeakMap<HTMLElement, boolean>()
const MAX_ROW_TEXT_NODE_LENGTH = 50
const MAX_SINGLE_NODE_ROW_LENGTH = 512
/** Above this, the row shows a fixed endpoint-only placeholder instead of laying out unbounded text. */
export const BIDI_LINE_MEASUREMENT_CEILING = 32_000

type BidiMeasurementRefusal = 'line-length' | 'grapheme-length'
const INLINE_WIDGET_CLASS = 'editor-inline-widget'
const inlineWidgetsByView = new WeakMap<VirtualizedTextViewInternal, InlineWidgets>()
const pendingInlineWidgetRepaints = new WeakMap<VirtualizedTextViewInternal, () => void>()

type RowUpdatePass = {
  readonly cursorBufferRow: number | null
  readonly cursorVirtualRow: number | null
  readonly cursorLineHighlight: VirtualizedTextViewInternal['cursorLineHighlight']
  readonly foldMarkersAvailable: boolean
  readonly lineCount: number
  readonly toggleFold: EditorGutterRowContext['toggleFold']
}

type RowUpdateState = EditorGutterRowContext & {
  readonly cursorVirtualLine: boolean
  readonly inlineMapping: RowInlineMapping | null
}

/** Fills the span an inline replacement renders into; the return value tears that content down. */

type InlineWidgets = {
  readonly hosts: Map<string, InlineWidgetHost>
  /** The map the live ids were last taken from; a different one is what retires a mount. */
  inlineMap: InlineMap | null
}

type InlineWidgetHost = {
  readonly element: HTMLSpanElement
  readonly mountDisposable: { dispose(): void } | null
  readonly observer: ResizeObserver | null
}

type InlineWidgetRun = {
  readonly id: string
  readonly localStart: number
  readonly localEnd: number
  readonly render: InlineReplacementRender
  readonly className?: string
}

/** A run that stays the text it stands for, boxed so it can be styled apart from that text. */
type InlineClassRun = {
  readonly id: string
  readonly localStart: number
  readonly localEnd: number
  readonly className: string
}

type InlineRowRuns = {
  readonly widgets: readonly InlineWidgetRun[]
  readonly classes: readonly InlineClassRun[]
}

const NO_INLINE_ROW_RUNS: InlineRowRuns = { widgets: [], classes: [] }

export function rowsKey(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
): string {
  return snapshotRowsKey(snapshot, horizontalWindowKey(view, snapshot.virtualItems, snapshot))
}

export function renderRows(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
  onRemoveSlot: (rowSlotId: number) => void,
): void {
  const updatePass = createRowUpdatePass(view)
  applyTotalHeight(view, snapshot)
  updateContentWidth(view, snapshot.virtualItems)
  retireInlineWidgets(view)
  reconcileRows(view, snapshot.virtualItems, snapshot, updatePass, onRemoveSlot)
  renderHiddenCharacters(view)
}

function reconcileRows(
  view: VirtualizedTextViewInternal,
  items: readonly FixedRowVirtualItem[],
  snapshot: FixedRowVirtualizerSnapshot,
  updatePass: RowUpdatePass,
  onRemoveSlot: (rowSlotId: number) => void,
): void {
  const reusableRows = releaseRowsOutside(view, items)
  for (const item of items) {
    mountOrUpdateRow(view, item, reusableRows, snapshot, updatePass)
  }

  removeReusableRows(view, reusableRows, onRemoveSlot)
}

function mountOrUpdateRow(
  view: VirtualizedTextViewInternal,
  item: FixedRowVirtualItem,
  reusableRows: MountedVirtualizedTextRow[],
  snapshot: FixedRowVirtualizerSnapshot,
  updatePass: RowUpdatePass,
): void {
  const existing = view.rowElements.get(item.index)
  if (existing) {
    updateRow(view, existing, item, snapshot, updatePass)
    return
  }

  const row = reusableRows.pop() ?? view.rowPool.pop() ?? createRow(view)
  const gutterParent = view.gutterContributions.length > 0 ? view.gutterElement : null
  restoreRowElements(row, view.spacer, gutterParent)
  updateRow(view, row, item, snapshot, updatePass)
  view.rowElements.set(item.index, row)
}

function createRow(view: VirtualizedTextViewInternal): MountedVirtualizedTextRow {
  const document = view.scrollElement.ownerDocument
  const element = document.createElement('div')
  const gutterElement = document.createElement('div')
  const leftSpacerElement = document.createElement('span')
  const selectionLayerElement = document.createElement('div')
  const foldPlaceholderElement = document.createElement('span')
  const hiddenCharactersLayerElement = document.createElement('div')
  const textNode = document.createTextNode('')
  const gutterCells = createGutterCells(view, document)

  element.className = 'editor-virtualized-row'
  gutterElement.className = 'editor-virtualized-gutter-row'
  leftSpacerElement.className = 'editor-virtualized-row-spacer'
  selectionLayerElement.className = 'editor-virtualized-selection-layer'
  selectionLayerElement.setAttribute('aria-hidden', 'true')
  foldPlaceholderElement.className = 'editor-virtualized-fold-placeholder'
  hiddenCharactersLayerElement.className = 'editor-virtualized-hidden-character-layer'
  hiddenCharactersLayerElement.setAttribute('aria-hidden', 'true')
  foldPlaceholderElement.textContent = '...'
  foldPlaceholderElement.hidden = true
  for (const cell of gutterCells.values()) gutterElement.appendChild(cell)
  element.appendChild(textNode)
  if (view.gutterContributions.length > 0) view.gutterElement.appendChild(gutterElement)
  view.spacer.appendChild(element)

  return {
    index: -1,
    bufferRow: -1,
    source: 'document',
    startOffset: 0,
    endOffset: 0,
    text: '',
    kind: 'text',
    chunks: [],
    top: Number.NaN,
    height: Number.NaN,
    textRevision: -1,
    tokenHighlightSlotId: view.nextTokenHighlightSlotId++,
    chunkKey: '',
    foldMarkerKey: '',
    foldCollapsed: false,
    element,
    gutterElement,
    gutterCells,
    gutterCellList: Array.from(gutterCells.values()),
    leftSpacerElement,
    selectionLayerElement,
    foldPlaceholderElement,
    hiddenCharactersLayerElement,
    textNode,
    selectionLayerKey: '',
    hiddenCharactersKey: '',
    rowDecorationClassName: '',
    rowDecorationGutterClassName: '',
    rowDecorationKey: '',
    inlineKindsClassName: '',
    cursorLineContentActive: false,
    textRenderMode: 'simple',
    geometryCache: null,
  }
}

function createGutterCells(
  view: VirtualizedTextViewInternal,
  document: Document,
): Map<string, HTMLElement> {
  const cells = new Map<string, HTMLElement>()
  for (const contribution of view.gutterContributions) {
    cells.set(contribution.id, createGutterCell(view, contribution, document))
  }

  return cells
}

function createGutterCell(
  view: VirtualizedTextViewInternal,
  contribution: EditorGutterContribution,
  document: Document,
): HTMLElement {
  const cell = contribution.createCell(document)
  cell.classList.add(GUTTER_CELL_CLASS)
  if (contribution.className) cell.classList.add(contribution.className)
  cell.dataset.editorGutterContribution = contribution.id
  setCachedGutterCellWidth(view, cell, contribution.id)
  return cell
}

export function disposeGutterCells(view: VirtualizedTextViewInternal): void {
  const rows = Array.from(view.rowElements.values()).concat(view.rowPool)
  for (const row of rows) disposeRowGutterCells(view, row)
}

export function updateGutterContributions(
  view: VirtualizedTextViewInternal,
  contributions: readonly EditorGutterContribution[],
): boolean {
  if (sameGutterContributions(view.gutterContributions, contributions)) return false

  const previousContributions = contributionMap(view.gutterContributions)
  view.gutterContributions = contributions
  syncGutterHostElement(view)
  syncGutterRows(view, previousContributions)
  view.gutterWidthDirty = true
  view.lastRenderedRowsKey = ''
  return true
}

function disposeRowGutterCells(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): void {
  for (const contribution of view.gutterContributions) {
    const cell = row.gutterCells.get(contribution.id)
    if (cell) contribution.disposeCell?.(cell)
  }
  row.gutterCells.clear()
  setGutterCellList(row, [])
}

function sameGutterContributions(
  left: readonly EditorGutterContribution[],
  right: readonly EditorGutterContribution[],
): boolean {
  if (left.length !== right.length) return false

  return left.every((contribution, index) => contribution === right[index])
}

function contributionMap(
  contributions: readonly EditorGutterContribution[],
): ReadonlyMap<string, EditorGutterContribution> {
  return new Map(contributions.map((contribution) => [contribution.id, contribution]))
}

function syncGutterHostElement(view: VirtualizedTextViewInternal): void {
  if (!gutterHostEnabled(view)) {
    view.gutterElement.remove()
    return
  }

  if (view.gutterElement.isConnected) return

  view.spacer.insertBefore(view.gutterElement, view.caretLayerElement)
}

function gutterHostEnabled(view: VirtualizedTextViewInternal): boolean {
  return view.gutterContributions.length > 0 || view.gutterWidthProvider !== null
}

function syncGutterRows(
  view: VirtualizedTextViewInternal,
  previousContributions: ReadonlyMap<string, EditorGutterContribution>,
): void {
  const currentContributions = contributionMap(view.gutterContributions)
  for (const row of allRows(view)) {
    syncGutterRow(view, row, previousContributions, currentContributions)
  }
}

function allRows(view: VirtualizedTextViewInternal): readonly MountedVirtualizedTextRow[] {
  return Array.from(view.rowElements.values()).concat(view.rowPool)
}

function syncGutterRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  previousContributions: ReadonlyMap<string, EditorGutterContribution>,
  currentContributions: ReadonlyMap<string, EditorGutterContribution>,
): void {
  removeStaleGutterCells(row, previousContributions, currentContributions)
  addCurrentGutterCells(view, row)
  syncGutterRowElement(view, row)
}

function removeStaleGutterCells(
  row: MountedVirtualizedTextRow,
  previousContributions: ReadonlyMap<string, EditorGutterContribution>,
  currentContributions: ReadonlyMap<string, EditorGutterContribution>,
): void {
  for (const [id, cell] of row.gutterCells) {
    if (currentContributions.get(id) === previousContributions.get(id)) continue

    previousContributions.get(id)?.disposeCell?.(cell)
    cell.remove()
    row.gutterCells.delete(id)
  }
}

function addCurrentGutterCells(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): void {
  const document = view.scrollElement.ownerDocument
  const cells: HTMLElement[] = []
  for (const contribution of view.gutterContributions) {
    const cell =
      row.gutterCells.get(contribution.id) ?? createGutterCell(view, contribution, document)
    row.gutterCells.set(contribution.id, cell)
    row.gutterElement.appendChild(cell)
    cells.push(cell)
  }
  setGutterCellList(row, cells)
}

function syncGutterRowElement(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): void {
  if (view.gutterContributions.length === 0) {
    row.gutterElement.remove()
    return
  }
  if (!view.rowElements.has(row.index)) return
  if (row.gutterElement.isConnected) return

  view.gutterElement.appendChild(row.gutterElement)
}

const noopToggleFold: EditorGutterRowContext['toggleFold'] = () => {}

function createRowUpdatePass(view: VirtualizedTextViewInternal): RowUpdatePass {
  return {
    cursorBufferRow: cursorLineBufferRow(view),
    cursorVirtualRow: cursorLineVirtualRow(view),
    cursorLineHighlight: view.cursorLineHighlight,
    foldMarkersAvailable: view.foldMarkerByStartRow.size > 0,
    lineCount: view.lineStarts.length,
    toggleFold: view.onFoldToggle ?? noopToggleFold,
  }
}

function rowUpdateState(
  view: VirtualizedTextViewInternal,
  index: number,
  updatePass: RowUpdatePass,
): RowUpdateState {
  const displayRow = view.model.rows[index]
  const bufferRow = bufferRowForDisplayRow(view, index)
  const primaryText = isDocumentTextDisplayRow(displayRow) && displayRow.sourceStartColumn === 0

  return {
    index,
    bufferRow,
    source: displayRowSource(displayRow),
    injectedTextRowId: injectedTextRowId(displayRow),
    metadata: displayRowMetadata(displayRow),
    startOffset: lineStartOffset(view, index),
    endOffset: lineEndOffset(view, index),
    text: displayRow?.text ?? '',
    inlineMapping: rowInlineMappingForDisplayRow(displayRow),
    kind: displayRow?.kind ?? 'text',
    primaryText,
    cursorLine: primaryText && bufferRow === updatePass.cursorBufferRow,
    cursorLineHighlight: updatePass.cursorLineHighlight,
    cursorVirtualLine: index === updatePass.cursorVirtualRow,
    foldMarker:
      primaryText && updatePass.foldMarkersAvailable
        ? (view.foldMarkerByStartRow.get(bufferRow) ?? null)
        : null,
    lineCount: updatePass.lineCount,
    toggleFold: updatePass.toggleFold,
  }
}

function mountedRowUpdateState(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  updatePass: RowUpdatePass,
): RowUpdateState {
  const primaryText = isPrimaryTextRow(view, row.index)
  return {
    index: row.index,
    bufferRow: row.bufferRow,
    source: row.source,
    injectedTextRowId: row.injectedTextRowId,
    metadata: row.metadata,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    text: row.text,
    inlineMapping: row.inlineMapping ?? null,
    kind: row.kind,
    primaryText,
    cursorLine: primaryText && row.bufferRow === updatePass.cursorBufferRow,
    cursorLineHighlight: updatePass.cursorLineHighlight,
    cursorVirtualLine: row.index === updatePass.cursorVirtualRow,
    foldMarker:
      primaryText && updatePass.foldMarkersAvailable
        ? (view.foldMarkerByStartRow.get(row.bufferRow) ?? null)
        : null,
    lineCount: updatePass.lineCount,
    toggleFold: updatePass.toggleFold,
  }
}

function bufferRowForDisplayRow(view: VirtualizedTextViewInternal, index: number): number {
  const displayRow = view.model.rows[index]
  if (displayRow?.kind === 'text') return displayRow.bufferRow
  return bufferRowForVirtualRow(view, index)
}

function inlineRowForDisplayRow(row: DisplayRow | undefined): InlineRow | undefined {
  return isDocumentTextDisplayRow(row) ? row.inlineRow : undefined
}

function displayRowSource(row: DisplayRow | undefined): EditorGutterRowContext['source'] {
  if (!row) return 'document'
  return row.source
}

function injectedTextRowId(row: DisplayRow | undefined): string | undefined {
  if (!isInjectedTextDisplayRow(row)) return undefined
  return row.id
}

function displayRowMetadata(row: DisplayRow | undefined): unknown {
  if (!isInjectedTextDisplayRow(row)) return undefined
  return row.metadata
}

function updateRowFrame(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
): void {
  if (row.index !== item.index) row.element.dataset.editorVirtualRow = String(item.index)
  if (row.top !== item.start) positionRowElement(view, row.element, item.start)

  const height = `${item.size}px`
  if (row.element.style.height !== height) row.element.style.height = height
  if (row.gutterElement.style.height !== height) row.gutterElement.style.height = height
}

function updateRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  snapshot: FixedRowVirtualizerSnapshot,
  updatePass: RowUpdatePass,
): void {
  if (isRowCurrent(view, row, item, snapshot)) {
    updateGutterRowElement(view, row, item, mountedRowUpdateState(view, row, updatePass))
    return
  }

  const state = rowUpdateState(view, item.index, updatePass)

  updateRowElement(view, row, item, state, snapshot)
  updateMutableRow(row, {
    bufferRow: state.bufferRow,
    endOffset: state.endOffset,
    injectedTextRowId: state.injectedTextRowId,
    kind: state.kind,
    metadata: state.metadata,
    foldCollapsed: state.foldMarker?.collapsed ?? false,
    foldMarkerKey: state.foldMarker?.key ?? '',
    height: item.size,
    index: item.index,
    source: state.source,
    startOffset: state.startOffset,
    text: state.text,
    inlineMapping: state.inlineMapping,
    textRevision: view.textRevision,
    top: item.start,
    chunkKey: rowChunkKey(view, state.text, snapshot),
  })
}

function updateRowElement(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  state: RowUpdateState,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  updateRowFrame(view, row, item)
  applyRowDecoration(view, row, item.index)
  updateCursorLineContentClass(view, row, state.cursorVirtualLine)
  updateRowInlineKindClasses(row, state.kind === 'text' ? state.inlineMapping : null)
  updateGutterRowElement(view, row, item, state)
  updateRowTextChunks(view, row, state.text, state.startOffset, state.inlineMapping, snapshot)
  updateRowFoldPresentation(row, state.foldMarker)
}

export function updateMountedRowsAfterSameLineEdit(
  view: VirtualizedTextViewInternal,
  items: readonly FixedRowVirtualItem[],
  patch: SameLineEditPatch,
  snapshot: FixedRowVirtualizerSnapshot,
): boolean {
  const updatePass = createRowUpdatePass(view)
  let editedRowPatchedInPlace = false
  for (const item of items) {
    const row = view.rowElements.get(item.index)
    if (!row) continue
    if (updateRowAfterSameLineEdit(view, row, item, patch, snapshot, updatePass)) {
      editedRowPatchedInPlace = true
    }
  }

  return editedRowPatchedInPlace
}

function updateRowAfterSameLineEdit(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  patch: SameLineEditPatch,
  snapshot: FixedRowVirtualizerSnapshot,
  updatePass: RowUpdatePass,
): boolean {
  const state = rowUpdateState(view, item.index, updatePass)

  const editedRowPatchedInPlace = updateRowElementForSameLineEdit(
    view,
    row,
    item,
    state,
    patch,
    snapshot,
  )
  updateMutableRow(row, {
    bufferRow: state.bufferRow,
    endOffset: state.endOffset,
    injectedTextRowId: state.injectedTextRowId,
    kind: state.kind,
    metadata: state.metadata,
    foldCollapsed: state.foldMarker?.collapsed ?? false,
    foldMarkerKey: state.foldMarker?.key ?? '',
    height: item.size,
    index: item.index,
    source: state.source,
    startOffset: state.startOffset,
    text: state.text,
    inlineMapping: state.inlineMapping,
    textRevision: view.textRevision,
    top: item.start,
    chunkKey: rowChunkKey(view, state.text, snapshot),
  })
  return editedRowPatchedInPlace
}

function updateRowElementForSameLineEdit(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  state: RowUpdateState,
  patch: SameLineEditPatch,
  snapshot: FixedRowVirtualizerSnapshot,
): boolean {
  updateRowFrame(view, row, item)
  applyRowDecoration(view, row, item.index)
  updateGutterRowElement(view, row, item, state)
  const editedRowPatchedInPlace = updateRowTextForSameLineEdit(
    view,
    row,
    item,
    state.text,
    patch,
    state.startOffset,
    state.inlineMapping,
    snapshot,
  )
  updateRowFoldPresentation(row, state.foldMarker)
  return editedRowPatchedInPlace
}

function updateRowTextForSameLineEdit(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  text: string,
  patch: SameLineEditPatch,
  startOffset: number,
  mapping: RowInlineMapping | null,
  snapshot: FixedRowVirtualizerSnapshot,
): boolean {
  if (bidiMeasurementRefusal(view, text)) {
    updateRowTextChunks(view, row, text, startOffset, mapping, snapshot)
    return false
  }

  if (item.index !== patch.rowIndex) {
    if (row.text !== text) updateRowTextChunks(view, row, text, startOffset, mapping, snapshot)
    if (row.text === text) syncRowChunkOffsets(row, startOffset, mapping)
    return false
  }

  if (memoizedContainsRTL(view, text)) {
    updateRowTextChunks(view, row, text, startOffset, mapping, snapshot)
    return false
  }

  if (row.textNode.data !== row.text) {
    updateRowTextChunks(view, row, text, startOffset, mapping, snapshot)
    return false
  }

  if (shouldChunkLine(view, text)) {
    updateRowTextChunks(view, row, text, startOffset, mapping, snapshot)
    return false
  }

  row.textNode.replaceData(patch.localFrom, patch.deleteLength, patch.text)
  if (row.textRenderMode === 'simple') {
    syncSimpleDirectRowChunk(row, text, startOffset, mapping)
    return true
  }

  syncDirectRowChunk(row, text, startOffset, mapping)
  return true
}

function syncRowChunkOffsets(
  row: MountedVirtualizedTextRow,
  startOffset: number,
  mapping: RowInlineMapping | null,
): void {
  const chunks = row.chunks.map((chunk) => ({
    ...chunk,
    startOffset: offsetForLocalIndex(mapping, startOffset, chunk.localStart, 'before'),
    endOffset: offsetForLocalIndex(mapping, startOffset, chunk.localEnd, 'after'),
  }))
  updateMutableRowChunks(row, chunks)
}

function updateRowTextChunks(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  text: string,
  startOffset: number,
  mapping: RowInlineMapping | null,
  snapshot = view.virtualizer.getSnapshot(),
): void {
  const runs = inlineRowRuns(mapping, text)
  const refusal = bidiMeasurementRefusal(view, text)
  if (refusal) {
    setUnmeasurableBidiRowText(row, text, startOffset, mapping, refusal)
    return
  }
  if (runs.widgets.length > 0 || runs.classes.length > 0) {
    setInlineRunRowText(view, row, text, startOffset, mapping, runs)
    return
  }

  if (!shouldChunkLine(view, text)) {
    setDirectRowText(view, row, text, startOffset, mapping)
    return
  }

  setChunkedRowText(view, row, text, startOffset, mapping, snapshot)
}

function setDirectRowText(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  text: string,
  startOffset: number,
  mapping: RowInlineMapping | null,
): void {
  if (reuseDirectRowText(row, text, startOffset, mapping)) return
  row.leftSpacerElement.style.width = '0px'

  // Splitting costs the row the in-place `Text.data` patch it lives on while the user types, so a
  // row short enough to be scanned cheaply keeps its single node and pays nothing.
  if (!isSimpleRowText(text) || text.length > MAX_SINGLE_NODE_ROW_LENGTH) {
    setRenderedDirectRowText(view, row, text, startOffset, mapping)
    return
  }

  if (row.textRenderMode !== 'simple' || rowHasInlineAttachments(row)) {
    if (!isSoleRowChild(row, row.textNode)) row.element.replaceChildren(row.textNode)
    setTextRenderMode(row, 'simple')
  }
  if (row.textNode.data !== text) row.textNode.data = text
  syncSimpleDirectRowChunk(row, text, startOffset, mapping)
}

function setRenderedDirectRowText(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  text: string,
  startOffset: number,
  mapping: RowInlineMapping | null,
): void {
  const simple = isSimpleRowText(text)
  const maxTextNodeLength = simple ? Number.POSITIVE_INFINITY : bidiTextNodeLength(view, text)
  const rendered = simple
    ? createSplitTextChunkParts(row.element.ownerDocument, text, 0)
    : createRenderedChunkParts(
        row.element.ownerDocument,
        text,
        0,
        characterWidth(view),
        [],
        maxTextNodeLength,
      )
  if (rendered.oversizedGrapheme) {
    setUnmeasurableBidiRowText(row, text, startOffset, mapping, 'grapheme-length')
    return
  }

  if (!adoptRenderedSingleTextPart(row, rendered)) {
    row.element.replaceChildren(...rendered.nodes)
  }
  setTextRenderMode(row, 'rendered')
  syncDirectRowChunk(row, text, startOffset, mapping, rendered.parts, rendered.textNode)
}

/**
 * Most non-simple lines still render as a single text part (no
 * control-character spans). When the row's current DOM is already exactly one
 * text node, adopt it: write `Text.data` in place and point the fresh parts at
 * the retained node. `replaceChildren` would tear down and rebuild the row's
 * layout objects on every recycle, for DOM-identical output.
 */
function adoptRenderedSingleTextPart(
  row: MountedVirtualizedTextRow,
  rendered: RenderedChunkParts,
): boolean {
  const part = rendered.parts[0]
  if (rendered.parts.length !== 1 || part?.kind !== 'text') return false
  if (!isSoleRowChild(row, row.textNode)) return false

  const existing = row.textNode
  if (existing.data !== rendered.textNode.data) existing.data = rendered.textNode.data

  const mutablePart = part as { node: Text }
  mutablePart.node = existing
  const mutableRendered = rendered as { textNode: Text }
  mutableRendered.textNode = existing
  return true
}

function isSoleRowChild(row: MountedVirtualizedTextRow, node: Text): boolean {
  if (node.parentNode !== row.element) return false
  return node.previousSibling === null && node.nextSibling === null
}

function reuseDirectRowText(
  row: MountedVirtualizedTextRow,
  text: string,
  startOffset: number,
  mapping: RowInlineMapping | null,
): boolean {
  if (row.text !== text) return false
  if (row.textRenderMode === 'simple') {
    syncSimpleDirectRowChunk(row, text, startOffset, mapping)
    return true
  }

  if (row.textRenderMode !== 'rendered') return false

  const chunk = row.chunks[0]
  if (!isReusableRenderedDirectChunk(row, chunk)) return false

  syncDirectRowChunk(row, text, startOffset, mapping, chunk.parts, chunk.textNode)
  return true
}

function syncDirectRowChunk(
  row: MountedVirtualizedTextRow,
  text: string,
  startOffset: number,
  mapping: RowInlineMapping | null,
  parts: readonly VirtualizedTextChunkPart[] = createTextChunkParts(row.textNode, 0, text.length),
  textNode = row.textNode,
): void {
  const chunk = {
    startOffset,
    endOffset: offsetForLocalIndex(mapping, startOffset, text.length, 'after'),
    localStart: 0,
    localEnd: text.length,
    text,
    element: null,
    textNode,
    parts,
  }
  updateMutableRowChunks(row, [chunk])
}

function syncSimpleDirectRowChunk(
  row: MountedVirtualizedTextRow,
  text: string,
  startOffset: number,
  mapping: RowInlineMapping | null,
): void {
  const chunk = row.chunks[0]
  if (!isReusableSimpleDirectChunk(row, chunk)) {
    syncDirectRowChunk(row, text, startOffset, mapping)
    return
  }

  const mutableChunk = chunk as {
    startOffset: number
    endOffset: number
    localEnd: number
    text: string
  }
  mutableChunk.startOffset = startOffset
  // Chunk offsets are buffer offsets; with an inline mapping the display text is shorter than the
  // buffer span, and `startOffset + text.length` silently clips every token range to the display
  // length before the boundary math ever maps it.
  mutableChunk.endOffset = offsetForLocalIndex(mapping, startOffset, text.length, 'after')
  mutableChunk.localEnd = text.length
  mutableChunk.text = text

  const part = chunk.parts[0] as { localEnd: number }
  part.localEnd = text.length
  updateMutableRowChunks(row, row.chunks)
}

function isReusableSimpleDirectChunk(
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk | undefined,
): chunk is VirtualizedTextChunk {
  if (!chunk) return false
  if (row.chunks.length !== 1) return false
  if (chunk.element !== null || chunk.textNode !== row.textNode) return false

  const part = chunk.parts[0]
  if (chunk.parts.length !== 1 || !part) return false
  return part.kind === 'text' && part.localStart === 0 && part.node === row.textNode
}

function isReusableRenderedDirectChunk(
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk | undefined,
): chunk is VirtualizedTextChunk {
  if (!chunk) return false
  if (row.chunks.length !== 1) return false
  if (chunk.element !== null) return false
  if (chunk.localStart !== 0) return false
  return chunk.localEnd === row.text.length
}

function rowHasInlineAttachments(row: MountedVirtualizedTextRow): boolean {
  if (row.foldCollapsed) return true
  return row.hiddenCharactersKey.length > 0
}

/**
 * Which of the row's replacements need a box of their own — one that renders itself, one that only
 * asks to be styled apart from the text around it. The row's display columns are line-absolute in
 * the mapping, so a wrapped row only claims the runs that fall inside the slice it renders: a run
 * cut by a wrap boundary has no single box to be, and stays the text it stands for.
 */
function inlineRowRuns(mapping: RowInlineMapping | null, text: string): InlineRowRuns {
  if (!mapping) return NO_INLINE_ROW_RUNS

  const widgets: InlineWidgetRun[] = []
  const classes: InlineClassRun[] = []
  for (const segment of mapping.line.segments) {
    if (segment.kind !== 'replacement' || segment.id === undefined) continue
    const { className, render } = segment
    if (!render && className === undefined) continue

    const localStart = segment.displayStartColumn - mapping.displayStartColumn
    const localEnd = segment.displayEndColumn - mapping.displayStartColumn
    // A run with no display column of its own would put both its boundaries on one x, leaving the
    // caret no side to stop on and the measured advance nothing to span.
    if (localStart < 0 || localEnd > text.length || localEnd <= localStart) continue

    const id = segment.id
    const styling = className === undefined ? {} : { className }
    if (render) widgets.push({ id, localStart, localEnd, render, ...styling })
    else if (className !== undefined) classes.push({ id, localStart, localEnd, className })
  }

  return { widgets, classes }
}

/**
 * Rows carrying a run never take the chunked path: a chunk boundary falls on a fixed column stride,
 * which would cut a replacement's columns in two, and the box it paints into is one or nothing.
 */
function setInlineRunRowText(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  text: string,
  startOffset: number,
  mapping: RowInlineMapping | null,
  runs: InlineRowRuns,
): void {
  row.leftSpacerElement.style.width = '0px'
  const placements = runs.widgets.map((run) => inlineWidgetPlacement(view, run))
  const maxTextNodeLength = bidiTextNodeLength(view, text)
  const chunk = row.chunks[0]
  if (chunk && reusesInlineRunRowText(row, chunk, text, placements, runs.classes)) {
    syncDirectRowChunk(row, text, startOffset, mapping, chunk.parts, chunk.textNode)
    return
  }

  const rendered = createInlineRunParts(
    row.element.ownerDocument,
    text,
    characterWidth(view),
    placements,
    runs.classes,
    maxTextNodeLength,
  )
  if (rendered.oversizedGrapheme) {
    setUnmeasurableBidiRowText(row, text, startOffset, mapping, 'grapheme-length')
    return
  }

  row.element.replaceChildren(...rendered.nodes)
  setTextRenderMode(row, 'widget')
  syncDirectRowChunk(row, text, startOffset, mapping, rendered.parts, rendered.textNode)
}

/**
 * The row's text, with every styled run boxed in a span of its own. The parts still point at the
 * text nodes inside those boxes, so a column inside a run measures, hit-tests and paints exactly as
 * one outside it does — the box changes what the run looks like, not what it is.
 */
function createInlineRunParts(
  document: Document,
  text: string,
  cellWidth: number,
  placements: readonly InlineWidgetPlacement[],
  classes: readonly InlineClassRun[],
  maxTextNodeLength: number,
): RenderedChunkParts {
  if (hasOversizedGrapheme(text, maxTextNodeLength)) {
    return {
      nodes: [],
      parts: [],
      textNode: document.createTextNode(''),
      oversizedGrapheme: true,
    }
  }

  const nodes: Node[] = []
  const parts: VirtualizedTextChunkPart[] = []
  let cursor = 0

  for (const run of classes) {
    appendInlineRunSlice(
      document,
      nodes,
      parts,
      text,
      cursor,
      run.localStart,
      cellWidth,
      placements,
      maxTextNodeLength,
    )
    appendInlineClassRun(document, nodes, parts, text, run, cellWidth, maxTextNodeLength)
    cursor = run.localEnd
  }

  appendInlineRunSlice(
    document,
    nodes,
    parts,
    text,
    cursor,
    text.length,
    cellWidth,
    placements,
    maxTextNodeLength,
  )
  return {
    nodes,
    parts,
    textNode: firstRowTextNode(parts) ?? document.createTextNode(''),
    oversizedGrapheme: false,
  }
}

function appendInlineRunSlice(
  document: Document,
  nodes: Node[],
  parts: VirtualizedTextChunkPart[],
  text: string,
  localStart: number,
  localEnd: number,
  cellWidth: number,
  placements: readonly InlineWidgetPlacement[],
  maxTextNodeLength: number,
): void {
  if (localEnd <= localStart) return

  const rendered = createRenderedChunkParts(
    document,
    text.slice(localStart, localEnd),
    localStart,
    cellWidth,
    placements.filter(
      (placement) => placement.localStart >= localStart && placement.localEnd <= localEnd,
    ),
    maxTextNodeLength,
  )
  nodes.push(...rendered.nodes)
  parts.push(...rendered.parts)
}

function appendInlineClassRun(
  document: Document,
  nodes: Node[],
  parts: VirtualizedTextChunkPart[],
  text: string,
  run: InlineClassRun,
  cellWidth: number,
  maxTextNodeLength: number,
): void {
  const boxed = createRenderedChunkParts(
    document,
    text.slice(run.localStart, run.localEnd),
    run.localStart,
    cellWidth,
    [],
    maxTextNodeLength,
  )
  const element = document.createElement('span')
  element.className = run.className
  element.dataset.editorInlineRun = run.id
  element.append(...boxed.nodes)

  nodes.push(element)
  parts.push(...boxed.parts)
}

function firstRowTextNode(parts: readonly VirtualizedTextChunkPart[]): Text | null {
  for (const part of parts) {
    if (part.kind === 'text') return part.node
  }

  return null
}

/**
 * Reuse is what keeps a widget out of the DOM churn a scroll frame otherwise causes, so it asks the
 * row itself rather than a key: the mounted nodes are still where this row put them, in the columns
 * these runs claim. A node another row has since taken fails on its parent.
 */
function reusesInlineRunRowText(
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  text: string,
  placements: readonly InlineWidgetPlacement[],
  classes: readonly InlineClassRun[],
): boolean {
  if (row.text !== text || row.textRenderMode !== 'widget' || row.chunks.length !== 1) return false

  const mounted = chunk.parts.filter((part) => part.kind === 'widget')
  if (mounted.length !== placements.length) return false

  const reused = placements.every((placement, index) => {
    const part = mounted[index]
    if (!part || part.element !== placement.element) return false
    if (part.localStart !== placement.localStart || part.localEnd !== placement.localEnd)
      return false
    return part.element.parentNode === row.element
  })

  return reused && reusesInlineClassRuns(row, chunk, classes)
}

/**
 * A box is rebuilt rather than remounted, so all that has to still hold is which run it was built
 * for: everything else about it is the text the row has already been found to be painting.
 */
function reusesInlineClassRuns(
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  classes: readonly InlineClassRun[],
): boolean {
  const boxes = inlineClassRunElements(row, chunk)
  if (boxes.length !== classes.length) return false

  return classes.every((run, index) => {
    const box = boxes[index]
    if (!box) return false
    return box.dataset.editorInlineRun === run.id && box.className === run.className
  })
}

/** The boxes the row's text parts sit in, in the order the row paints them. */
function inlineClassRunElements(
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
): readonly HTMLElement[] {
  const boxes: HTMLElement[] = []

  for (const part of chunk.parts) {
    if (part.kind !== 'text') continue
    const parent = part.node.parentElement
    if (!parent || parent === row.element) continue
    if (boxes.at(-1) !== parent) boxes.push(parent)
  }

  return boxes
}

/**
 * A replacement id owns its mount for as long as the replacement lives, across every row the run is
 * painted into. Re-rendering per row would tear the node down and build it again on every scroll
 * frame that recycles the row under it, which for anything stateful — a loading image, a spinner,
 * an input — is visible.
 */
function inlineWidgetPlacement(
  view: VirtualizedTextViewInternal,
  run: InlineWidgetRun,
): InlineWidgetPlacement {
  const widgets = inlineWidgets(view)
  const host = widgets.hosts.get(run.id) ?? mountInlineWidget(view, widgets, run)
  applyInlineWidgetClass(host.element, run.className)
  return { localStart: run.localStart, localEnd: run.localEnd, element: host.element }
}

/** The run's own class rides alongside the mount's, and is re-read because the mount outlives it. */
function applyInlineWidgetClass(element: HTMLSpanElement, className: string | undefined): void {
  const next = className === undefined ? INLINE_WIDGET_CLASS : `${INLINE_WIDGET_CLASS} ${className}`
  if (element.className !== next) element.className = next
}

function inlineWidgets(view: VirtualizedTextViewInternal): InlineWidgets {
  const existing = inlineWidgetsByView.get(view)
  if (existing) return existing

  const widgets = { hosts: new Map<string, InlineWidgetHost>(), inlineMap: view.model.inlineMap }
  inlineWidgetsByView.set(view, widgets)
  return widgets
}

function mountInlineWidget(
  view: VirtualizedTextViewInternal,
  widgets: InlineWidgets,
  run: InlineWidgetRun,
): InlineWidgetHost {
  const element = view.scrollElement.ownerDocument.createElement('span')
  applyInlineWidgetClass(element, run.className)
  element.dataset.editorInlineWidget = run.id
  // Nothing in the row is editable, but a browser still finds caret positions inside any node it can
  // descend into, and the replacement is one indivisible stop.
  element.setAttribute('contenteditable', 'false')

  const mountDisposable = run.render(element) ?? null
  // The callback is only the signal that something moved: re-reading the element keeps a resize and
  // the measurement below on the same box, rather than the content box without its border. It is
  // also the first real width, since nothing has laid this node out until a row paints it in.
  const observer = createRowResizeObserver(() => measureInlineWidget(view, element))
  observer?.observe(element)

  const host = { element, mountDisposable, observer }
  widgets.hosts.set(run.id, host)
  measureInlineWidget(view, element)
  return host
}

function measureInlineWidget(view: VirtualizedTextViewInternal, element: HTMLSpanElement): void {
  applyInlineWidgetWidth(view, element, elementMeasuredSize(element, 'width'))
}

function applyInlineWidgetWidth(
  view: VirtualizedTextViewInternal,
  element: HTMLSpanElement,
  width: number,
): void {
  // A node that measures nothing has not been laid out yet — off-screen, or a host that answers no
  // rects at all. The columns it stands on are a better guess than collapsing it to nothing.
  if (!Number.isFinite(width) || width <= 0) return
  if (!setInlineWidgetMeasuredWidth(element, width)) return

  // Row geometry is cached against the row's text and classes, none of which move when the node a
  // replacement rendered does. An image that finished loading would otherwise keep the columns
  // after it where they were laid out at its placeholder size.
  clearRowGeometryCaches(view)
  // Dropping the caches is only half of it. Every other place that drops them is inside a pass that
  // goes on to repaint; this one is reached from a resize delivery with nothing behind it, so the
  // caret and the horizontal extent would keep the numbers they were last painted with until the
  // next keystroke happened to ask for them again.
  scheduleInlineWidgetRepaint(view)
}

/**
 * Coalesced and deferred, because the width arrives either inside a resize delivery — where
 * repainting immediately re-enters the observer that is still running — or inside the row paint
 * that mounted the node, which would re-enter the render pass writing that row. A burst of
 * replacements settling together is one pass either way.
 */
function scheduleInlineWidgetRepaint(view: VirtualizedTextViewInternal): void {
  if (pendingInlineWidgetRepaints.has(view)) return

  const win = view.scrollElement.ownerDocument.defaultView
  if (!win) return

  /**
   * @justification Leaving the current frame is the entire content of this delay: it is what keeps
   * the repaint out of the resize delivery and out of the row paint that ask for it. The one
   * outstanding handle per view makes a second request in the same frame a no-op, and
   * `cancelInlineWidgetRepaint` withdraws it when the view goes away.
   */
  const handle = win.setTimeout(() => {
    pendingInlineWidgetRepaints.delete(view)
    resetContentWidthScan(view)
    view.lastRenderedRowsKey = ''
    updateVirtualizerRows(view)
  }, 0)
  pendingInlineWidgetRepaints.set(view, () => win.clearTimeout(handle))
}

function cancelInlineWidgetRepaint(view: VirtualizedTextViewInternal): void {
  pendingInlineWidgetRepaints.get(view)?.()
  pendingInlineWidgetRepaints.delete(view)
}

/**
 * A mount lives as long as its replacement does, not as long as the row showing it: scrolling away
 * keeps it, and only the replacement leaving the map — dropped by its provider, or revealed under
 * the caret — takes it down.
 */
function retireInlineWidgets(view: VirtualizedTextViewInternal): void {
  const widgets = inlineWidgetsByView.get(view)
  if (!widgets || widgets.inlineMap === view.model.inlineMap) return

  widgets.inlineMap = view.model.inlineMap
  const live = new Set<string>()
  for (const range of view.model.inlineMap?.ranges ?? []) live.add(range.id)

  for (const [id, host] of widgets.hosts) {
    if (live.has(id)) continue

    disposeInlineWidget(host)
    widgets.hosts.delete(id)
  }
}

export function disposeInlineWidgets(view: VirtualizedTextViewInternal): void {
  cancelInlineWidgetRepaint(view)
  const widgets = inlineWidgetsByView.get(view)
  if (!widgets) return

  for (const host of widgets.hosts.values()) disposeInlineWidget(host)
  widgets.hosts.clear()
  inlineWidgetsByView.delete(view)
}

function disposeInlineWidget(host: InlineWidgetHost): void {
  host.observer?.disconnect()
  host.mountDisposable?.dispose()
  host.element.remove()
}

function setChunkedRowText(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  text: string,
  startOffset: number,
  mapping: RowInlineMapping | null,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  const window = horizontalChunkWindow(view, text, snapshot)
  const chunks = createRowChunks(view, text, window, startOffset, mapping)
  const elements = chunks
    .map((chunk) => chunk.element)
    .filter((element): element is HTMLSpanElement => element !== null)
  row.leftSpacerElement.style.width = `${Math.round(
    estimatedDisplayCellForColumn(text, window.start, view.tabSize) * characterWidth(view),
  )}px`
  row.element.replaceChildren(row.leftSpacerElement, ...elements)
  setTextRenderMode(row, 'chunked')
  updateMutableRowChunks(row, chunks)
}

function createRowChunks(
  view: VirtualizedTextViewInternal,
  text: string,
  window: HorizontalChunkWindow,
  startOffset: number,
  mapping: RowInlineMapping | null,
): VirtualizedTextChunk[] {
  const chunks: VirtualizedTextChunk[] = []

  for (
    let localStart = window.start;
    localStart < window.end;
    localStart += view.longLineChunkSize
  ) {
    chunks.push(createRowChunk(view, text, localStart, window.end, startOffset, mapping))
  }

  return chunks
}

function createRowChunk(
  view: VirtualizedTextViewInternal,
  text: string,
  localStart: number,
  windowEnd: number,
  startOffset: number,
  mapping: RowInlineMapping | null,
): VirtualizedTextChunk {
  const localEnd = Math.min(localStart + view.longLineChunkSize, windowEnd)
  const element = view.scrollElement.ownerDocument.createElement('span')
  const chunkText = text.slice(localStart, localEnd)
  const rendered = isSimpleRowText(chunkText)
    ? createSplitTextChunkParts(view.scrollElement.ownerDocument, chunkText, localStart)
    : createRenderedChunkParts(
        view.scrollElement.ownerDocument,
        chunkText,
        localStart,
        characterWidth(view),
      )

  element.className = 'editor-virtualized-row-chunk'
  element.dataset.editorVirtualChunkStart = String(localStart)
  element.append(...rendered.nodes)

  return {
    startOffset: offsetForLocalIndex(mapping, startOffset, localStart, 'before'),
    endOffset: offsetForLocalIndex(mapping, startOffset, localEnd, 'after'),
    localStart,
    localEnd,
    text: chunkText,
    element,
    textNode: rendered.textNode,
    parts: rendered.parts,
  }
}

/**
 * Reading a character position out of a text node costs the browser a scan of that node, and the
 * scan does not stay linear in its length — so caret placement, hit testing and every highlight
 * range painted over a very long line get steadily more expensive the more text one node holds.
 * Spreading the text over several nodes bounds each of those scans and changes nothing about what
 * renders or what the parts describe: adjacent text nodes lay out as one, and the parts still cover
 * the same local span end to end.
 *
 * Callers must have established that the text is simple. A fixed stride can cut a grapheme cluster
 * in two, and each half then measures — and stops the caret — as a character of its own.
 */
function createSplitTextChunkParts(
  document: Document,
  text: string,
  localStart: number,
): RenderedChunkParts {
  const nodeCount = Math.max(1, Math.ceil(text.length / MAX_ROW_TEXT_NODE_LENGTH))
  const nodes: Text[] = []
  const parts: VirtualizedTextChunkPart[] = []

  for (let index = 0; index < nodeCount; index += 1) {
    const start = index * MAX_ROW_TEXT_NODE_LENGTH
    const end = Math.min(start + MAX_ROW_TEXT_NODE_LENGTH, text.length)
    const node = document.createTextNode(text.slice(start, end))
    nodes.push(node)
    parts.push({
      kind: 'text',
      localStart: localStart + start,
      localEnd: localStart + end,
      node,
    })
  }

  return { nodes, parts, textNode: nodes[0]!, oversizedGrapheme: false }
}

function shouldChunkLine(view: VirtualizedTextViewInternal, text: string): boolean {
  if (view.wrapEnabled) return false
  if (text.length <= view.longLineChunkThreshold) return false
  return !memoizedContainsRTL(view, text)
}

function bidiTextNodeLength(view: VirtualizedTextViewInternal, text: string): number {
  if (memoizedContainsRTL(view, text)) return MAX_ROW_TEXT_NODE_LENGTH
  return Number.POSITIVE_INFINITY
}

function bidiMeasurementRefusal(
  view: VirtualizedTextViewInternal,
  text: string,
): BidiMeasurementRefusal | null {
  if (text.length <= MAX_ROW_TEXT_NODE_LENGTH) return null
  if (!memoizedContainsRTL(view, text)) return null
  if (text.length >= BIDI_LINE_MEASUREMENT_CEILING) return 'line-length'
  return null
}

function hasOversizedGrapheme(text: string, maxLength: number): boolean {
  if (!Number.isFinite(maxLength)) return false

  for (const segment of segmentGraphemes(text)) {
    if (segment.segment.length > maxLength) return true
  }
  return false
}

function setUnmeasurableBidiRowText(
  row: MountedVirtualizedTextRow,
  text: string,
  startOffset: number,
  mapping: RowInlineMapping | null,
  refusal: BidiMeasurementRefusal,
): void {
  const document = row.element.ownerDocument
  const element = document.createElement('span')
  const startEndpoint = document.createElement('span')
  const endEndpoint = document.createElement('span')
  element.className = 'editor-virtualized-bidi-ceiling'
  element.dataset.editorBidiLineLength = String(text.length)
  element.dataset.editorBidiMeasurementRefusal = refusal
  startEndpoint.dataset.editorBidiEndpoint = 'start'
  startEndpoint.textContent = '…'
  endEndpoint.dataset.editorBidiEndpoint = 'end'
  endEndpoint.textContent = bidiMeasurementRefusalLabel(refusal)
  element.append(startEndpoint, endEndpoint)
  row.leftSpacerElement.style.width = '0px'
  row.element.replaceChildren(element)
  setTextRenderMode(row, 'widget')
  syncDirectRowChunk(
    row,
    text,
    startOffset,
    mapping,
    [
      {
        kind: 'widget',
        localStart: 0,
        localEnd: 0,
        element: startEndpoint,
      },
      {
        kind: 'widget',
        localStart: text.length,
        localEnd: text.length,
        element: endEndpoint,
      },
    ],
    document.createTextNode(''),
  )
}

function bidiMeasurementRefusalLabel(refusal: BidiMeasurementRefusal): string {
  if (refusal === 'grapheme-length') {
    return ` BiDi grapheme exceeds the ${MAX_ROW_TEXT_NODE_LENGTH}-unit geometry ceiling`
  }
  return ` BiDi line exceeds the ${BIDI_LINE_MEASUREMENT_CEILING}-unit geometry ceiling`
}

function rowChunkKey(
  view: VirtualizedTextViewInternal,
  text: string,
  snapshot = view.virtualizer.getSnapshot(),
): string {
  if (!shouldChunkLine(view, text)) return 'direct'

  // Only the aligned window bounds describe what the row rendered. Folding the raw scroll position
  // or viewport width in would invalidate the row — and the geometry measured for it — on every
  // pixel of horizontal scroll, even though the mounted chunks are identical.
  const window = horizontalChunkWindow(view, text, snapshot)
  return `${window.start}:${window.end}`
}

function horizontalChunkWindow(
  view: VirtualizedTextViewInternal,
  text: string,
  snapshot = view.virtualizer.getSnapshot(),
): HorizontalChunkWindow {
  const viewportColumns = horizontalViewportColumns(view, snapshot.viewportWidth)
  const leftColumn = Math.max(
    0,
    Math.floor(horizontalTextScrollLeft(view, snapshot.scrollLeft) / characterWidth(view)),
  )
  const startColumn = Math.max(0, leftColumn - view.horizontalOverscanColumns)
  const endColumn = leftColumn + viewportColumns + view.horizontalOverscanColumns
  const startBufferColumn = bufferColumnForEstimatedColumn(
    text,
    startColumn,
    'before',
    view.tabSize,
  )
  const endBufferColumn = bufferColumnForEstimatedColumn(text, endColumn, 'after', view.tabSize)
  const start = alignChunkStart(startBufferColumn, view.longLineChunkSize)
  const end = alignChunkEnd(Math.min(text.length, endBufferColumn), view.longLineChunkSize)

  return { start, end: clamp(end, start, text.length) }
}

function bufferColumnForEstimatedColumn(
  text: string,
  visualColumn: number,
  bias: 'before' | 'after',
  tabSize: number,
): number {
  if (isSimpleRowText(text)) return visualColumnToBufferColumn(text, visualColumn, bias, tabSize)
  return estimatedColumnToBufferColumn(text, visualColumn, bias, tabSize)
}

export function horizontalViewportColumns(
  view: VirtualizedTextViewInternal,
  viewportWidth = view.virtualizer.getSnapshot().viewportWidth,
): number {
  const width = Math.max(0, viewportWidth - gutterWidth(view))
  return Math.max(1, Math.ceil(width / characterWidth(view)))
}

function horizontalTextScrollLeft(
  view: VirtualizedTextViewInternal,
  scrollLeft = view.virtualizer.getSnapshot().scrollLeft,
): number {
  return Math.max(0, scrollLeft - gutterWidth(view))
}

function horizontalWindowKey(
  view: VirtualizedTextViewInternal,
  items: readonly FixedRowVirtualItem[],
  snapshot: FixedRowVirtualizerSnapshot,
): string {
  // Same reasoning as `rowChunkKey`: the render pass only has work to do once a chunked row's
  // window actually shifts, so the key is the windows themselves rather than the scroll offset
  // they were derived from. Rows that are not chunked contribute nothing — horizontal scroll never
  // changes what they render.
  let key = ''
  for (const item of items) {
    const text = lineText(view, item.index)
    if (!shouldChunkLine(view, text)) continue

    const window = horizontalChunkWindow(view, text, snapshot)
    key += `${item.index}:${window.start}:${window.end}|`
  }

  return key === '' ? 'direct' : key
}

function updateRowFoldPresentation(
  row: MountedVirtualizedTextRow,
  marker: VirtualizedFoldMarker | null,
): void {
  updateFoldPlaceholder(row, marker)
}

function updateFoldPlaceholder(
  row: MountedVirtualizedTextRow,
  marker: VirtualizedFoldMarker | null,
): void {
  const show = marker?.collapsed === true
  if (!show) {
    hideFoldPlaceholder(row.foldPlaceholderElement)
    return
  }

  showFoldPlaceholder(row.foldPlaceholderElement, marker.key)
  if (row.foldPlaceholderElement.isConnected) return
  row.element.appendChild(row.foldPlaceholderElement)
}

function updateGutterRowElement(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  state: RowUpdateState,
): void {
  if (view.gutterContributions.length === 0) return

  if (row.index !== item.index) {
    row.gutterElement.dataset.editorVirtualGutterRow = String(item.index)
  }
  if (row.top !== item.start) {
    positionRowElement(view, row.gutterElement, item.start)
  }

  updateGutterContributionCells(view, row, state)
}

function positionRowElement(
  view: VirtualizedTextViewInternal,
  element: HTMLElement,
  top: number,
): void {
  if (view.rowPositioning === 'top') {
    element.style.transform = ''
    element.style.top = `${top}px`
    return
  }

  element.style.top = '0px'
  element.style.transform = `translateY(${top}px)`
}

function updateGutterContributionCells(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  state: RowUpdateState,
): void {
  const contributions = view.gutterContributions
  const cells = row.gutterCellList

  for (let index = 0; index < contributions.length; index += 1) {
    const contribution = contributions[index]!
    const cell = cells[index] ?? row.gutterCells.get(contribution.id)
    if (!cell) continue

    contribution.updateCell(cell, state)
    updateCursorLineGutterCellClass(view, cell, contribution.id, state.cursorLine)
  }
}

function setCachedGutterCellWidth(
  view: VirtualizedTextViewInternal,
  cell: HTMLElement,
  contributionId: string,
): void {
  const width = view.gutterContributionWidths.get(contributionId)
  if (width === undefined) return

  setStyleValue(cell, 'width', `${width}px`)
}

export function cursorLineBufferRow(view: VirtualizedTextViewInternal): number | null {
  if (!hasCollapsedSelection(view)) return null

  return bufferRowForOffset(view, view.selectionHead!)
}

export function cursorLineVirtualRow(view: VirtualizedTextViewInternal): number | null {
  if (!hasCollapsedSelection(view)) return null

  return rowForOffset(view, view.selectionHead!)
}

function hasCollapsedSelection(view: VirtualizedTextViewInternal): boolean {
  if (view.selectionHead === null) return false
  if (view.selectionStart === null || view.selectionEnd === null) return false

  return view.selectionStart === view.selectionEnd
}

export function refreshCursorLineRows(
  view: VirtualizedTextViewInternal,
  previousBufferRow: number | null,
  previousVirtualRow: number | null,
): void {
  const nextBufferRow = cursorLineBufferRow(view)
  const nextVirtualRow = cursorLineVirtualRow(view)
  if (previousBufferRow === nextBufferRow && previousVirtualRow === nextVirtualRow) return

  const updatePass = createRowUpdatePass(view)
  for (const row of view.rowElements.values()) {
    if (
      !shouldRefreshCursorLineRow(
        row,
        previousBufferRow,
        nextBufferRow,
        previousVirtualRow,
        nextVirtualRow,
      )
    ) {
      continue
    }

    updateCursorLineContentClass(view, row, row.index === nextVirtualRow)
    refreshCursorLineGutterCells(view, row, updatePass)
  }
}

function shouldRefreshCursorLineRow(
  row: MountedVirtualizedTextRow,
  previousBufferRow: number | null,
  nextBufferRow: number | null,
  previousVirtualRow: number | null,
  nextVirtualRow: number | null,
): boolean {
  if (row.index === previousVirtualRow || row.index === nextVirtualRow) return true

  return row.bufferRow === previousBufferRow || row.bufferRow === nextBufferRow
}

function refreshCursorLineGutterCells(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  updatePass = createRowUpdatePass(view),
): void {
  if (view.gutterContributions.length === 0) return

  updateGutterContributionCells(view, row, mountedRowUpdateState(view, row, updatePass))
}

function updateCursorLineContentClass(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  active: boolean,
): void {
  const enabled = view.cursorLineHighlight.rowBackground && active
  if (row.cursorLineContentActive === enabled) return

  setCursorLineContentActive(row, enabled)
  row.element.classList.toggle(CURSOR_LINE_ROW_CLASS, enabled)
}

function updateCursorLineGutterCellClass(
  view: VirtualizedTextViewInternal,
  element: HTMLElement,
  contributionId: string,
  active: boolean,
): void {
  const enabled = active && cursorLineGutterBackgroundEnabled(view, contributionId)
  if ((gutterCursorLineStates.get(element) ?? false) === enabled) return

  gutterCursorLineStates.set(element, enabled)
  element.classList.toggle(CURSOR_LINE_GUTTER_CLASS, enabled)
}

function cursorLineGutterBackgroundEnabled(
  view: VirtualizedTextViewInternal,
  contributionId: string,
): boolean {
  const setting = view.cursorLineHighlight.gutterBackground
  if (typeof setting === 'boolean') return setting

  return setting.includes(contributionId)
}

function foldMarkerForVirtualRow(
  view: VirtualizedTextViewInternal,
  row: number,
): VirtualizedFoldMarker | null {
  if (!isPrimaryTextRow(view, row)) return null

  const bufferRow = bufferRowForVirtualRow(view, row)
  return view.foldMarkerByStartRow.get(bufferRow) ?? null
}

function isPrimaryTextRow(view: VirtualizedTextViewInternal, row: number): boolean {
  const displayRow = view.model.rows[row]
  if (!isDocumentTextDisplayRow(displayRow)) return false
  return displayRow.sourceStartColumn === 0
}

function isRowCurrent(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  snapshot: FixedRowVirtualizerSnapshot,
): boolean {
  if (row.index !== item.index) return false
  if (row.top !== item.start) return false
  if (row.height !== item.size) return false
  if (row.textRevision !== view.textRevision) return false

  const bufferRow = bufferRowForVirtualRow(view, item.index)
  if (row.bufferRow !== bufferRow) return false

  const displayRow = view.model.rows[item.index]
  if (row.source !== displayRowSource(displayRow)) return false
  if (row.injectedTextRowId !== injectedTextRowId(displayRow)) return false
  if (row.metadata !== displayRowMetadata(displayRow)) return false

  const text = lineText(view, item.index)
  if (row.text !== text) return false
  // Display text alone does not say what is behind it: a run that changed only how it paints — the
  // box it asks for, the node it renders — leaves every column of the row exactly where it was.
  if (row.inlineMapping?.line !== inlineRowForDisplayRow(displayRow)) return false
  if (row.chunkKey !== rowChunkKey(view, text, snapshot)) return false
  if (row.rowDecorationKey !== rowDecorationKey(view, item.index)) return false

  const foldMarker = foldMarkerForVirtualRow(view, item.index)
  if (row.foldMarkerKey !== (foldMarker?.key ?? '')) return false
  return row.foldCollapsed === (foldMarker?.collapsed ?? false)
}

function applyRowDecoration(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  virtualRow: number,
): void {
  const decoration = rowDecorationForVirtualRow(view, virtualRow)
  if (!decoration) {
    clearRowDecoration(row)
    return
  }

  setRowDecorationClass(row, decoration.className ?? '')
  setRowDecorationGutterClass(row, decoration.gutterClassName ?? '')
  setRowDecorationKey(row, rowDecorationKeyForDecoration(decoration))
}

function rowDecorationKey(view: VirtualizedTextViewInternal, virtualRow: number): string {
  return rowDecorationKeyForDecoration(rowDecorationForVirtualRow(view, virtualRow))
}

function rowDecorationForVirtualRow(
  view: VirtualizedTextViewInternal,
  virtualRow: number,
): VirtualizedTextRowDecoration | undefined {
  const displayRow = view.model.rows[virtualRow]
  if (isInjectedTextDisplayRow(displayRow)) return injectedRowDecoration(displayRow)

  return view.rowDecorations.get(bufferRowForVirtualRow(view, virtualRow))
}

function injectedRowDecoration(
  row: DisplayInjectedTextRow,
): VirtualizedTextRowDecoration | undefined {
  if (!row.className && !row.gutterClassName) return undefined

  return {
    className: row.className,
    gutterClassName: row.gutterClassName,
  }
}

function rowDecorationKeyForDecoration(
  decoration: VirtualizedTextRowDecoration | undefined,
): string {
  if (!decoration) return ''

  return `${decoration.className ?? ''}|${decoration.gutterClassName ?? ''}`
}

function clearRowDecoration(row: MountedVirtualizedTextRow): void {
  if (row.rowDecorationKey === '') return

  setRowDecorationClass(row, '')
  setRowDecorationGutterClass(row, '')
  setRowDecorationKey(row, '')
}

function setRowDecorationClass(row: MountedVirtualizedTextRow, className: string): void {
  if (row.rowDecorationClassName === className) return

  removeClassNames(row.element, row.rowDecorationClassName)
  addClassNames(row.element, className)
  setRowDecorationClassName(row, className)
}

function setRowDecorationGutterClass(row: MountedVirtualizedTextRow, className: string): void {
  if (row.rowDecorationGutterClassName === className) return

  removeClassNames(row.gutterElement, row.rowDecorationGutterClassName)
  addClassNames(row.gutterElement, className)
  setRowDecorationGutterClassName(row, className)
}

function setGutterCellList(
  row: MountedVirtualizedTextRow,
  gutterCellList: readonly HTMLElement[],
): void {
  const mutable = row as { gutterCellList: readonly HTMLElement[] }
  mutable.gutterCellList = gutterCellList
}

function setTextRenderMode(
  row: MountedVirtualizedTextRow,
  textRenderMode: VirtualizedTextRenderMode,
): void {
  const mutable = row as { textRenderMode: VirtualizedTextRenderMode }
  mutable.textRenderMode = textRenderMode
}

function setCursorLineContentActive(
  row: MountedVirtualizedTextRow,
  cursorLineContentActive: boolean,
): void {
  const mutable = row as { cursorLineContentActive: boolean }
  mutable.cursorLineContentActive = cursorLineContentActive
}

function setRowDecorationClassName(
  row: MountedVirtualizedTextRow,
  rowDecorationClassName: string,
): void {
  const mutable = row as { rowDecorationClassName: string }
  mutable.rowDecorationClassName = rowDecorationClassName
}

function setRowDecorationGutterClassName(
  row: MountedVirtualizedTextRow,
  rowDecorationGutterClassName: string,
): void {
  const mutable = row as { rowDecorationGutterClassName: string }
  mutable.rowDecorationGutterClassName = rowDecorationGutterClassName
}

function setRowDecorationKey(row: MountedVirtualizedTextRow, rowDecorationKey: string): void {
  const mutable = row as { rowDecorationKey: string }
  mutable.rowDecorationKey = rowDecorationKey
}

/** Class names may only be built from kinds that are safe as CSS class fragments. */
const CLASS_SAFE_REPLACEMENT_KIND = /^[a-z0-9-]+$/

/**
 * Mirrors the row's inline replacement kinds onto its element as `editor-inline-<kind>` classes, so
 * a replacement provider's stylesheet can restyle whole rows — a markdown heading row turning bold
 * and larger — without the editor knowing any provider's vocabulary. Reveal drops the row's
 * replacements, which drops the classes with them, so a revealed heading renders as plain source.
 */
function updateRowInlineKindClasses(
  row: MountedVirtualizedTextRow,
  mapping: RowInlineMapping | null,
): void {
  const nextClassName = inlineKindClassNames(mapping)
  if (nextClassName === row.inlineKindsClassName) return

  removeClassNames(row.element, row.inlineKindsClassName)
  addClassNames(row.element, nextClassName)
  const mutable = row as { inlineKindsClassName: string }
  mutable.inlineKindsClassName = nextClassName
}

function inlineKindClassNames(mapping: RowInlineMapping | null): string {
  if (!mapping) return ''

  const names = new Set<string>()
  for (const segment of mapping.line.segments) {
    if (segment.kind !== 'replacement') continue
    const replacementKind = segment.replacementKind
    if (!replacementKind || !CLASS_SAFE_REPLACEMENT_KIND.test(replacementKind)) continue
    names.add(`editor-inline-${replacementKind}`)
  }

  return [...names].join(' ')
}

function addClassNames(element: HTMLElement, className: string): void {
  const names = splitClassNames(className)
  if (names.length === 0) return

  element.classList.add(...names)
}

function removeClassNames(element: HTMLElement, className: string): void {
  const names = splitClassNames(className)
  if (names.length === 0) return

  element.classList.remove(...names)
}

function splitClassNames(className: string): string[] {
  return className.split(/\s+/).filter(Boolean)
}

function releaseRowsOutside(
  view: VirtualizedTextViewInternal,
  items: readonly FixedRowVirtualItem[],
): MountedVirtualizedTextRow[] {
  const start = items[0]?.index ?? 0
  const end = (items[items.length - 1]?.index ?? -1) + 1
  const reusableRows: MountedVirtualizedTextRow[] = []
  for (const [index, row] of view.rowElements) {
    if (index >= start && index < end) continue
    view.rowElements.delete(index)
    reusableRows.push(row)
  }

  return reusableRows
}

function removeReusableRows(
  view: VirtualizedTextViewInternal,
  rows: readonly MountedVirtualizedTextRow[],
  onRemoveSlot: (rowSlotId: number) => void,
): void {
  if (rows.length === 0) return

  for (const row of rows) {
    onRemoveSlot(row.tokenHighlightSlotId)
    view.rowTokenSignatures.delete(row.tokenHighlightSlotId)
    clearHiddenCharactersForRow(row)
  }

  retireRowElements(rows)
  view.rowPool.push(...rows)
}

export function resetContentWidthScan(view: VirtualizedTextViewInternal): void {
  view.contentWidth = 0
  view.maxVisualColumnsSeen = 0
  view.lastWidthScanStart = 0
  view.lastWidthScanEnd = -1
}

export function updateGutterWidthIfNeeded(view: VirtualizedTextViewInternal): void {
  if (!view.gutterWidthDirty) return

  view.gutterWidthDirty = false
  applyGutterWidth(view)
}

function applyGutterWidth(view: VirtualizedTextViewInternal): void {
  const widths = gutterContributionWidthMap(view)
  updateGutterContributionWidths(view, widths)

  const nextWidth = fixedGutterWidth(view) + totalGutterContributionWidth(widths)
  setStyleValue(view.scrollElement, '--editor-gutter-width', `${nextWidth}px`)
  if (nextWidth === view.currentGutterWidth) return

  view.currentGutterWidth = nextWidth
  applySpacerWidth(view)
}

function fixedGutterWidth(view: VirtualizedTextViewInternal): number {
  const width = view.gutterWidthProvider?.(gutterWidthContext(view)) ?? 0
  if (!Number.isFinite(width) || width <= 0) return 0
  return Math.ceil(width)
}

function gutterContributionWidthMap(
  view: VirtualizedTextViewInternal,
): ReadonlyMap<string, number> {
  const widths = new Map<string, number>()
  if (view.gutterContributions.length === 0) return widths

  const context = gutterWidthContext(view)
  for (const contribution of view.gutterContributions) {
    widths.set(contribution.id, gutterContributionWidth(contribution, context))
  }
  return widths
}

function updateGutterContributionWidths(
  view: VirtualizedTextViewInternal,
  widths: ReadonlyMap<string, number>,
): void {
  if (sameGutterContributionWidths(view.gutterContributionWidths, widths)) return

  view.gutterContributionWidths = widths
  applyGutterContributionWidths(view)
}

function sameGutterContributionWidths(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): boolean {
  if (left.size !== right.size) return false

  for (const [id, width] of right) {
    if (left.get(id) !== width) return false
  }
  return true
}

function applyGutterContributionWidths(view: VirtualizedTextViewInternal): void {
  for (const row of allRows(view)) {
    for (const [id, cell] of row.gutterCells) setCachedGutterCellWidth(view, cell, id)
  }
}

function totalGutterContributionWidth(widths: ReadonlyMap<string, number>): number {
  let total = 0
  for (const width of widths.values()) total += width
  return total
}

function gutterContributionWidth(
  contribution: EditorGutterContribution,
  context: ReturnType<typeof gutterWidthContext>,
): number {
  const width = contribution.width(context)
  if (!Number.isFinite(width) || width <= 0) return 0
  return Math.ceil(width)
}

function gutterWidthContext(view: VirtualizedTextViewInternal): EditorGutterWidthContext {
  return {
    lineCount: view.lineStarts.length,
    metrics: view.metrics,
  }
}

export function updateContentWidth(
  view: VirtualizedTextViewInternal,
  items: readonly FixedRowVirtualItem[],
): void {
  const first = items[0]
  const last = items.at(-1)
  if (!first || !last) {
    applyContentWidth(view, 0)
    return
  }

  scanVisualWidthRange(view, first.index, last.index)
  applyContentWidth(view, view.maxVisualColumnsSeen)
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
  )
  if (!overlapsLastScan) {
    scanVisualColumns(view, startIndex, endIndex)
    view.lastWidthScanStart = startIndex
    view.lastWidthScanEnd = endIndex
    return
  }

  if (startIndex < view.lastWidthScanStart) {
    scanVisualColumns(view, startIndex, view.lastWidthScanStart - 1)
  }
  if (endIndex > view.lastWidthScanEnd) {
    scanVisualColumns(view, view.lastWidthScanEnd + 1, endIndex)
  }

  view.lastWidthScanStart = startIndex
  view.lastWidthScanEnd = endIndex
}

function scanVisualColumns(
  view: VirtualizedTextViewInternal,
  startIndex: number,
  endIndex: number,
): void {
  for (let row = startIndex; row <= endIndex; row += 1) {
    view.maxVisualColumnsSeen = Math.max(
      view.maxVisualColumnsSeen,
      estimatedDisplayRowColumns(view, row),
    )
  }
}

// Only document text contributes to the horizontal extent; injected rows are measured for real
// once they mount.
function estimatedDisplayRowColumns(view: VirtualizedTextViewInternal, rowIndex: number): number {
  const displayRow = view.model.rows[rowIndex]
  if (!isDocumentTextDisplayRow(displayRow)) return 0
  return visualColumnLength(displayRow.text, view.tabSize)
}

function applyContentWidth(view: VirtualizedTextViewInternal, visualColumns: number): void {
  const charWidth = characterWidth(view)
  const width = Math.ceil(Math.max(charWidth, visualColumns * charWidth))
  if (width !== view.contentWidth) view.contentWidth = width

  applySpacerWidth(view)
}

function applySpacerWidth(
  view: VirtualizedTextViewInternal,
  viewportWidth = view.virtualizer.getSnapshot().viewportWidth,
): void {
  const width = `${spacerWidth(view, viewportWidth)}px`
  if (view.lastSpacerWidth === width) return

  view.lastSpacerWidth = width
  view.spacer.style.width = width
}

export function updateSpacerWidth(view: VirtualizedTextViewInternal, viewportWidth?: number): void {
  applySpacerWidth(view, viewportWidth)
}

export function updateSpacerHeight(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  applyTotalHeight(view, snapshot)
}

function spacerWidth(view: VirtualizedTextViewInternal, viewportWidth: number): number {
  return Math.max(viewportWidth, view.contentWidth + gutterWidth(view))
}

export function applyRowHeight(view: VirtualizedTextViewInternal, rowHeight: number): void {
  setStyleValue(view.scrollElement, '--editor-row-height', `${rowHeight}px`)
}

function applyTotalHeight(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  const height = `${snapshot.nativeScrollHeight}px`
  const offset = snapshot.nativeScrollTop - snapshot.scrollTop
  const transform = offset === 0 ? '' : `translateY(${offset}px)`
  setSpacerHeight(view, height)
  setSpacerTransform(view, transform)
}

function setSpacerHeight(view: VirtualizedTextViewInternal, height: string): void {
  if (view.lastSpacerHeight === height) return

  view.lastSpacerHeight = height
  view.spacer.style.height = height
}

function setSpacerTransform(view: VirtualizedTextViewInternal, transform: string): void {
  if (view.lastSpacerTransform === transform) return

  view.lastSpacerTransform = transform
  view.spacer.style.transform = transform
}

export function getMountedRows(
  view: VirtualizedTextViewInternal,
): readonly MountedVirtualizedTextRow[] {
  return Array.from(view.rowElements.values()).toSorted((a, b) => a.index - b.index)
}

export function textOffsetFromDomBoundary(
  view: VirtualizedTextViewInternal,
  node: Node,
  offset: number,
): number | null {
  const row = rowFromDomBoundary(view, node)
  if (!row) return null
  if (row.source === 'injected') return null
  const mapped = offsetFromDomBoundary(row, node, offset)
  if (mapped !== null) return mapped
  if (!row.element.contains(node)) return null
  return row.endOffset
}

function rowFromDomBoundary(
  view: VirtualizedTextViewInternal,
  node: Node,
): MountedVirtualizedTextRow | null {
  const element = rowElementFromNode(node, view.scrollElement)
  if (!element) return null

  const rowIndex = Number(element.dataset.editorVirtualRow)
  if (!Number.isInteger(rowIndex)) return null
  return view.rowElements.get(rowIndex) ?? null
}

export function ensureOffsetMounted(view: VirtualizedTextViewInternal, offset: number): void {
  if (resolveMountedOffset(view, offset)) return

  const row = rowForOffset(view, offset)
  scrollToRow(view, row)
  if (resolveMountedOffset(view, offset)) return

  scrollHorizontallyToOffset(view, row, offset)
  syncVirtualizerMetricsFromScrollElement(view)
}

function scrollHorizontallyToOffset(
  view: VirtualizedTextViewInternal,
  row: number,
  offset: number,
): void {
  const text = lineText(view, row)
  if (!shouldChunkLine(view, text)) return

  const snapshot = view.virtualizer.getSnapshot()
  const targetLeft = gutterWidth(view) + rowTextLeftForOffset(view, row, offset)
  const viewportRight = snapshot.scrollLeft + snapshot.viewportWidth
  if (targetLeft >= snapshot.scrollLeft && targetLeft <= viewportRight) return

  view.scrollElement.scrollLeft = Math.max(0, targetLeft - gutterWidth(view))
}

/**
 * Moves the hidden input under the caret.
 *
 * An IME anchors its candidate window on the box of the element being typed into, not on the text
 * the reader can see, so an input parked in a corner of the viewport takes the candidate list there
 * with it — as do the accent and emoji pickers, which never announce themselves through a
 * composition event at all. A caret nobody can see has no box worth pointing at, and an input moved
 * outside the viewport invites the browser to scroll it back into view, so the corner stands in.
 */
export function positionInputAtCaret(
  view: VirtualizedTextViewInternal,
  knownPosition?: VirtualizedCaretPosition | null,
): void {
  // The virtualizer's copy of the scroll offsets, never the element's: this runs inside the render
  // pass, where reading scroll back off the DOM is what forces the layout it has just written.
  const snapshot = view.virtualizer.getSnapshot()
  const caret = visibleCaretPosition(view, snapshot, knownPosition)
  // The input hangs off the scroll element rather than the spacer, so it does not come with the
  // offset the spacer is translated by on a document taller than the browser will scroll.
  const spacerOffset = snapshot.nativeScrollTop - snapshot.scrollTop

  setStyleValue(
    view.inputElement,
    'top',
    `${caret ? caret.top + spacerOffset : snapshot.nativeScrollTop}px`,
  )
  setStyleValue(view.inputElement, 'left', `${caret ? caret.left : snapshot.scrollLeft}px`)
}

/** Null for a caret outside the rows that are mounted, or behind the gutter or the right edge. */
function visibleCaretPosition(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
  knownPosition?: VirtualizedCaretPosition | null,
): { readonly left: number; readonly top: number } | null {
  const position = knownPosition === undefined ? primaryCaretPosition(view) : knownPosition
  if (!position) return null
  if (position.left < snapshot.scrollLeft + gutterWidth(view)) return null
  if (position.left > snapshot.scrollLeft + snapshot.viewportWidth) return null

  return position
}

function primaryCaretPosition(view: VirtualizedTextViewInternal): VirtualizedCaretPosition | null {
  const selection = view.selections[0]
  if (!selection) return null
  return caretPosition(view, selection.head, selection.affinity)?.[0] ?? null
}

export function restoreScrollPosition(
  view: VirtualizedTextViewInternal,
  scrollTop: number,
  scrollLeft: number,
): void {
  if (view.scrollElement.scrollTop === scrollTop && view.scrollElement.scrollLeft === scrollLeft)
    return

  view.scrollElement.scrollTop = scrollTop
  view.scrollElement.scrollLeft = scrollLeft
  syncVirtualizerMetricsFromScrollElement(view)
}

function syncVirtualizerMetricsFromScrollElement(view: VirtualizedTextViewInternal): void {
  const snapshot = view.virtualizer.getSnapshot()
  view.virtualizer.setScrollMetrics({
    scrollTop: view.scrollElement.scrollTop,
    scrollLeft: view.scrollElement.scrollLeft,
    borderBoxHeight: snapshot.borderBoxHeight,
    borderBoxWidth: snapshot.borderBoxWidth,
    viewportHeight: snapshot.viewportHeight,
    viewportWidth: snapshot.viewportWidth,
  })
}

export function scrollOffsetIntoView(view: VirtualizedTextViewInternal, offset: number): void {
  const snapshot = view.virtualizer.getSnapshot()
  const row = rowForOffset(view, offset)
  const top = rowTop(view, row)
  const bottom = top + getRowHeight(view)
  const scrollTop = scrollTopForVisibleRow(view, top, bottom, snapshot)
  const scrollLeft = scrollLeftForVisibleOffset(view, row, offset, snapshot)
  if (scrollTop === snapshot.scrollTop && scrollLeft === snapshot.scrollLeft) return

  view.scrollElement.scrollTop = scrollTop
  view.scrollElement.scrollLeft = scrollLeft
  syncVirtualizerMetricsFromScrollElement(view)
}

export function scrollOffsetToViewportEnd(view: VirtualizedTextViewInternal, offset: number): void {
  const snapshot = view.virtualizer.getSnapshot()
  const row = rowForOffset(view, offset)
  const bottom = rowTop(view, row) + getRowHeight(view)
  const scrollTop = scrollTopForRowBottom(bottom, snapshot)
  const scrollLeft = scrollLeftForVisibleOffset(view, row, offset, snapshot)
  if (scrollTop === snapshot.scrollTop && scrollLeft === snapshot.scrollLeft) return

  view.scrollElement.scrollTop = scrollTop
  view.scrollElement.scrollLeft = scrollLeft
  syncVirtualizerMetricsFromScrollElement(view)
}

function scrollTopForRowBottom(rowBottom: number, snapshot: FixedRowVirtualizerSnapshot): number {
  const maxScrollTop = Math.max(0, snapshot.totalSize - snapshot.viewportHeight)
  return clamp(rowBottom - snapshot.viewportHeight, 0, maxScrollTop)
}

function scrollTopForVisibleRow(
  view: VirtualizedTextViewInternal,
  rowTopValue: number,
  rowBottom: number,
  snapshot: FixedRowVirtualizerSnapshot,
): number {
  const viewportTop = snapshot.scrollTop
  const viewportBottom = viewportTop + snapshot.viewportHeight
  const maxScrollTop = Math.max(0, scrollableHeight(view, snapshot) - snapshot.viewportHeight)

  if (rowTopValue < viewportTop) return clamp(rowTopValue, 0, maxScrollTop)
  if (rowBottom > viewportBottom) return clamp(rowBottom - snapshot.viewportHeight, 0, maxScrollTop)
  return viewportTop
}

function scrollLeftForVisibleOffset(
  view: VirtualizedTextViewInternal,
  row: number,
  offset: number,
  snapshot: FixedRowVirtualizerSnapshot,
): number {
  const caretLeft = gutterWidth(view) + rowTextLeftForOffset(view, row, offset)
  const viewportLeft = snapshot.scrollLeft + gutterWidth(view)
  const viewportRight = snapshot.scrollLeft + snapshot.viewportWidth
  if (caretLeft < viewportLeft) return Math.max(0, caretLeft - gutterWidth(view))
  if (caretLeft > viewportRight) return Math.max(0, caretLeft - snapshot.viewportWidth)
  return snapshot.scrollLeft
}

function rowTextLeftForOffset(
  view: VirtualizedTextViewInternal,
  rowIndex: number,
  offset: number,
): number {
  const mounted = view.rowElements.get(rowIndex)
  if (mounted?.kind === 'text') return offsetToX(view, mounted, offset)

  const text = lineText(view, rowIndex)
  const localOffset = clamp(offset - lineStartOffset(view, rowIndex), 0, text.length)
  const column = isSimpleRowText(text)
    ? bufferColumnToVisualColumn(text, localOffset, view.tabSize)
    : estimatedDisplayCellForColumn(text, localOffset, view.tabSize)
  return column * characterWidth(view)
}

export function resolveMountedOffset(
  view: VirtualizedTextViewInternal,
  offset: number,
): { readonly node: Node; readonly offset: number } | null {
  const clamped = clamp(offset, 0, view.model.textLength)
  const targetRow = rowForOffset(view, clamped)
  for (const row of getMountedRows(view)) {
    if (row.index !== targetRow) continue
    const rowOffset = clamp(clamped, row.startOffset, row.endOffset)
    return domBoundaryForOffset(row, rowOffset)
  }

  return null
}

export function viewportPointMetrics(
  view: VirtualizedTextViewInternal,
  clientX: number,
  clientY: number,
): {
  readonly x: number
  readonly y: number
  readonly clientX: number
  readonly clientY: number
  readonly verticalDirection: number
} {
  const rect = view.scrollElement.getBoundingClientRect()
  const padding = scrollElementPadding(view.scrollElement)
  const left = rect.left + padding.left
  const top = rect.top + padding.top
  const right = Math.max(left, rect.right - padding.right)
  const bottom = Math.max(top, rect.bottom - padding.bottom)

  return {
    x: viewportTextX(view, clientX, left, right, view.virtualizer.getSnapshot().scrollLeft),
    y: clamp(clientY, top, Math.max(top, bottom - 1)) - top,
    clientX,
    clientY,
    verticalDirection: pointVerticalDirection(clientY, top, bottom),
  }
}

function viewportTextX(
  view: VirtualizedTextViewInternal,
  clientX: number,
  left: number,
  right: number,
  scrollLeft: number,
): number {
  const viewportX = clamp(clientX, left, right) - left
  const scrolledX = viewportX + scrollLeft
  return Math.max(0, scrolledX - gutterWidth(view))
}

function pointVerticalDirection(clientY: number, top: number, bottom: number): number {
  if (clientY < top) return -1
  if (clientY >= bottom) return 1
  return 0
}

export function scrollToRow(view: VirtualizedTextViewInternal, row: number): void {
  const target = clamp(Math.floor(row), 0, visibleLineCount(view) - 1)
  view.scrollElement.scrollTop = rowTop(view, target)
  syncVirtualizerMetricsFromScrollElement(view)
}

function characterWidth(view: VirtualizedTextViewInternal): number {
  return Math.max(1, view.metrics.characterWidth)
}

export function gutterWidth(view: VirtualizedTextViewInternal): number {
  return view.currentGutterWidth
}

export function caretPosition(
  view: VirtualizedTextViewInternal,
  offset: number,
  affinity: SelectionAffinity,
): VirtualizedCaretPositions | null {
  const rowIndex = rowForOffset(view, offset)
  const row = view.rowElements.get(rowIndex)
  if (!row) return null

  const xs = boundaryPositionXsForAffinity(view, row, offset, affinity)
  const primary = caretPositionAtX(view, row, xs[0] ?? offsetToX(view, row, offset))
  const secondaryX = xs[1]
  if (secondaryX === undefined) return [primary]
  return [primary, caretPositionAtX(view, row, secondaryX)]
}

function caretPositionAtX(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  x: number,
): VirtualizedCaretPosition {
  return {
    left: gutterWidth(view) + x,
    top: row.top,
    height: row.height,
  }
}

export function pageRowDelta(view: VirtualizedTextViewInternal): number {
  const { viewportHeight } = view.virtualizer.getSnapshot()
  return Math.max(1, Math.floor(viewportHeight / rowStride(view)) - 1)
}

function rowStride(view: VirtualizedTextViewInternal): number {
  return getRowHeight(view) + view.rowGap
}
