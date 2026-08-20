import {
  isDocumentTextDisplayRow,
  isInjectedTextDisplayRow,
  bufferColumnToVisualColumn,
  visualColumnToBufferColumn,
  type DisplayBlockRow,
  type DisplayInjectedTextRow,
  type DisplayRow,
} from '../displayTransforms'
import { clamp } from '../style-utils'
import type {
  EditorGutterContribution,
  EditorGutterRowContext,
  EditorGutterWidthContext,
} from '../plugins'
import type { FixedRowVirtualItem, FixedRowVirtualizerSnapshot } from './fixedRowVirtualizer'
import {
  alignChunkEnd,
  alignChunkStart,
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
} from './virtualizedTextViewTypes'
import type { VirtualizedTextViewInternal } from './virtualizedTextViewInternals'
import {
  type RowInlineMapping,
  offsetForLocalIndex,
  rowInlineMappingForDisplayRow,
} from './virtualizedTextViewInlineMapping'
import {
  type RenderedChunkParts,
  createRenderedChunkParts,
  createTextChunkParts,
  domBoundaryForOffset,
  estimatedColumnToBufferColumn,
  estimatedDisplayCellForColumn,
  offsetFromDomBoundary,
  offsetToX,
  isSimpleRowText,
} from './virtualizedTextViewGeometry'
import {
  clearHiddenCharactersForRow,
  renderHiddenCharacters,
} from './virtualizedTextViewHiddenCharacters'
import {
  applyRowBlockLaneInset,
  estimatedDisplayRowWidthPx,
  rowBlockLaneInset,
} from './virtualizedTextViewBlockLanes'

const GUTTER_CELL_CLASS = 'editor-virtualized-gutter-cell'
const CURSOR_LINE_ROW_CLASS = 'editor-virtualized-cursor-line-row'
const CURSOR_LINE_GUTTER_CLASS = 'editor-virtualized-cursor-line-gutter'
const gutterCursorLineStates = new WeakMap<HTMLElement, boolean>()
const emptyBlockLaneInset = { left: 0, right: 0, key: '' }

type RowUpdatePass = {
  readonly cursorBufferRow: number | null
  readonly cursorVirtualRow: number | null
  readonly cursorLineHighlight: VirtualizedTextViewInternal['cursorLineHighlight']
  readonly foldMarkersAvailable: boolean
  readonly lineCount: number
  readonly toggleFold: EditorGutterRowContext['toggleFold']
}

type RowUpdateState = EditorGutterRowContext & {
  readonly blockRow: DisplayBlockRow | null
  readonly cursorVirtualLine: boolean
  readonly inlineMapping: RowInlineMapping | null
}

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
  const blockContainerElement = document.createElement('div')
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
  blockContainerElement.className = 'editor-virtualized-block-surface'
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
    displayKind: 'text',
    element,
    gutterElement,
    gutterCells,
    gutterCellList: Array.from(gutterCells.values()),
    leftSpacerElement,
    selectionLayerElement,
    foldPlaceholderElement,
    hiddenCharactersLayerElement,
    blockContainerElement,
    blockMountDisposable: null,
    blockMountKey: '',
    leftBlockLaneWidth: 0,
    rightBlockLaneWidth: 0,
    blockLaneKey: '',
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

export function disposeBlockRowMounts(view: VirtualizedTextViewInternal): void {
  for (const row of allRows(view)) disposeBlockRowMount(row)
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
    blockRow: displayRow?.kind === 'block' ? displayRow : null,
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
    blockRow: blockDisplayRowForIndex(view, row.index),
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
  if (displayRow?.kind === 'block') return displayRow.anchorBufferRow
  return bufferRowForVirtualRow(view, index)
}

function displayRowSource(row: DisplayRow | undefined): EditorGutterRowContext['source'] {
  if (!row) return 'document'
  if (row.kind === 'block') return 'block'
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
  kind: 'text' | 'block',
): void {
  if (row.index !== item.index) row.element.dataset.editorVirtualRow = String(item.index)
  if (row.element.dataset.editorVirtualRowKind !== kind)
    row.element.dataset.editorVirtualRowKind = kind
  if (row.top !== item.start) positionRowElement(view, row.element, item.start)

  const height = `${item.size}px`
  if (row.element.style.height !== height) row.element.style.height = height
  if (row.gutterElement.style.height !== height) row.gutterElement.style.height = height
  applyRowBlockLaneInset(
    row,
    kind === 'text' ? rowBlockLaneInset(view, item.index) : emptyBlockLaneInset,
  )
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
    leftBlockLaneWidth: row.leftBlockLaneWidth,
    rightBlockLaneWidth: row.rightBlockLaneWidth,
    blockLaneKey: row.blockLaneKey,
    source: state.source,
    startOffset: state.startOffset,
    text: state.text,
    inlineMapping: state.inlineMapping,
    textRevision: view.textRevision,
    top: item.start,
    chunkKey: rowChunkKey(view, state.text, snapshot),
    displayKind: state.kind,
  })
}

function updateRowElement(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  state: RowUpdateState,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  updateRowFrame(view, row, item, state.kind)
  applyRowDecoration(view, row, item.index)
  updateCursorLineContentClass(view, row, state.cursorVirtualLine)
  updateRowInlineKindClasses(row, state.kind === 'text' ? state.inlineMapping : null)
  updateGutterRowElement(view, row, item, state)
  if (state.kind === 'block') {
    setBlockRowContent(view, row, item, state)
    updateRowFoldPresentation(row, state.foldMarker)
    return
  }

  disposeBlockRowMount(row)
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
    leftBlockLaneWidth: row.leftBlockLaneWidth,
    rightBlockLaneWidth: row.rightBlockLaneWidth,
    blockLaneKey: row.blockLaneKey,
    source: state.source,
    startOffset: state.startOffset,
    text: state.text,
    inlineMapping: state.inlineMapping,
    textRevision: view.textRevision,
    top: item.start,
    chunkKey: rowChunkKey(view, state.text, snapshot),
    displayKind: state.kind,
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
  updateRowFrame(view, row, item, state.kind)
  applyRowDecoration(view, row, item.index)
  updateGutterRowElement(view, row, item, state)
  if (state.kind === 'block') {
    setBlockRowContent(view, row, item, state)
    updateRowFoldPresentation(row, state.foldMarker)
    return false
  }

  disposeBlockRowMount(row)
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

function setBlockRowContent(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  item: FixedRowVirtualItem,
  state: RowUpdateState,
): void {
  const blockRow = state.blockRow
  if (!blockRow || !view.blockRowMount) {
    setBlockRowText(row, state.text, state.startOffset)
    return
  }

  if (row.element.firstChild !== row.blockContainerElement || row.element.childNodes.length !== 1)
    row.element.replaceChildren(row.blockContainerElement)
  syncBlockContainerHeight(row.blockContainerElement, item.size, blockRow.heightMeasured === true)

  syncBlockRowMount(view, row, blockRow)
  updateMutableRowChunks(row, [])
}

function syncBlockContainerHeight(element: HTMLDivElement, size: number, measured: boolean): void {
  if (measured) {
    if (element.style.height !== '') element.style.height = ''
    return
  }

  const height = `${size}px`
  if (element.style.height !== height) element.style.height = height
}

function syncBlockRowMount(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  blockRow: DisplayBlockRow,
): void {
  if (row.blockMountKey === blockRow.id) return

  disposeBlockRowMount(row)
  const disposable = view.blockRowMount?.(row.blockContainerElement, {
    id: blockRow.id,
    anchorBufferRow: blockRow.anchorBufferRow,
    placement: blockRow.placement,
    startOffset: blockRow.startOffset,
    endOffset: blockRow.endOffset,
  })
  setBlockRowMount(row, blockRow.id, disposable ?? null)
}

function disposeBlockRowMount(row: MountedVirtualizedTextRow): void {
  row.blockMountDisposable?.dispose()
  resetBlockContainerElement(row.blockContainerElement)
  setBlockRowMount(row, '', null)
}

function resetBlockContainerElement(element: HTMLDivElement): void {
  const height = element.style.height
  element.replaceChildren()
  while (element.attributes.length > 0) element.removeAttribute(element.attributes[0]!.name)
  element.className = 'editor-virtualized-block-surface'
  if (height) element.style.height = height
}

function setBlockRowMount(
  row: MountedVirtualizedTextRow,
  key: string,
  disposable: MountedVirtualizedTextRow['blockMountDisposable'],
): void {
  const mutable = row as {
    blockMountDisposable: MountedVirtualizedTextRow['blockMountDisposable']
    blockMountKey: string
  }
  mutable.blockMountDisposable = disposable
  mutable.blockMountKey = key
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
  if (item.index !== patch.rowIndex) {
    if (row.text !== text) updateRowTextChunks(view, row, text, startOffset, mapping, snapshot)
    if (row.text === text) syncRowChunkOffsets(row, startOffset, mapping)
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

  if (!isSimpleRowText(text)) {
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
  const rendered = createRenderedChunkParts(
    row.element.ownerDocument,
    text,
    0,
    characterWidth(view),
  )
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
  if (row.element.firstChild === row.blockContainerElement) return true
  if (row.foldCollapsed) return true
  return row.hiddenCharactersKey.length > 0
}

function setBlockRowText(row: MountedVirtualizedTextRow, text: string, startOffset: number): void {
  disposeBlockRowMount(row)
  if (shouldReplaceBlockTextChildren(row)) {
    row.element.replaceChildren(row.textNode)
    setTextRenderMode(row, 'simple')
  }
  if (row.textNode.data !== text) row.textNode.data = text
  syncSimpleDirectRowChunk(row, text, startOffset, null)
}

function shouldReplaceBlockTextChildren(row: MountedVirtualizedTextRow): boolean {
  if (row.textRenderMode !== 'simple') return true
  if (rowHasInlineAttachments(row)) return true
  return row.element.firstChild !== row.textNode || row.element.childNodes.length !== 1
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
    ? null
    : createRenderedChunkParts(
        view.scrollElement.ownerDocument,
        chunkText,
        localStart,
        characterWidth(view),
      )
  const textNode = rendered?.textNode ?? view.scrollElement.ownerDocument.createTextNode(chunkText)

  element.className = 'editor-virtualized-row-chunk'
  element.dataset.editorVirtualChunkStart = String(localStart)
  element.append(...(rendered?.nodes ?? [textNode]))

  return {
    startOffset: offsetForLocalIndex(mapping, startOffset, localStart, 'before'),
    endOffset: offsetForLocalIndex(mapping, startOffset, localEnd, 'after'),
    localStart,
    localEnd,
    text: chunkText,
    element,
    textNode,
    parts: rendered?.parts ?? createTextChunkParts(textNode, localStart, localEnd),
  }
}

function shouldChunkLine(view: VirtualizedTextViewInternal, text: string): boolean {
  if (view.wrapEnabled) return false
  return text.length > view.longLineChunkThreshold
}

function rowChunkKey(
  view: VirtualizedTextViewInternal,
  text: string,
  snapshot = view.virtualizer.getSnapshot(),
): string {
  if (!shouldChunkLine(view, text)) return 'direct'

  const window = horizontalChunkWindow(view, text, snapshot)
  return `${window.start}:${window.end}:${snapshot.viewportWidth}:${snapshot.scrollLeft}`
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
  if (!hasHorizontalChunkedRows(view, items)) return 'direct'

  const scrollLeft = Math.floor(snapshot.scrollLeft)
  return `${scrollLeft}:${snapshot.viewportWidth}:${view.longLineChunkSize}`
}

function hasHorizontalChunkedRows(
  view: VirtualizedTextViewInternal,
  items: readonly FixedRowVirtualItem[],
): boolean {
  for (const item of items) {
    if (shouldChunkLine(view, lineText(view, item.index))) return true
  }

  return false
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

  const rowKind = displayRowKind(view, item.index)
  if (row.displayKind !== rowKind) return false
  const displayRow = view.model.rows[item.index]
  if (row.source !== displayRowSource(displayRow)) return false
  if (row.injectedTextRowId !== injectedTextRowId(displayRow)) return false
  if (row.metadata !== displayRowMetadata(displayRow)) return false
  if (row.blockMountKey !== blockMountKeyForIndex(view, item.index)) return false
  if (row.blockLaneKey !== rowBlockLaneInset(view, item.index).key) return false

  const text = lineText(view, item.index)
  if (row.text !== text) return false
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

function blockDisplayRowForIndex(
  view: VirtualizedTextViewInternal,
  index: number,
): DisplayBlockRow | null {
  const displayRow = view.model.rows[index]
  if (displayRow?.kind !== 'block') return null
  return displayRow
}

function blockMountKeyForIndex(view: VirtualizedTextViewInternal, index: number): string {
  if (!view.blockRowMount) return ''
  return blockDisplayRowForIndex(view, index)?.id ?? ''
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
    disposeBlockRowMount(row)
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

export function updateGutterWidthIfNeeded(view: VirtualizedTextViewInternal): boolean {
  if (!view.gutterWidthDirty) return false

  view.gutterWidthDirty = false
  return applyGutterWidth(view)
}

function applyGutterWidth(view: VirtualizedTextViewInternal): boolean {
  const widths = gutterContributionWidthMap(view)
  updateGutterContributionWidths(view, widths)

  const nextWidth = fixedGutterWidth(view) + totalGutterContributionWidth(widths)
  setStyleValue(view.scrollElement, '--editor-gutter-width', `${nextWidth}px`)
  if (nextWidth === view.currentGutterWidth) return false

  view.currentGutterWidth = nextWidth
  applySpacerWidth(view)
  return true
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
      estimatedDisplayRowWidthPx(view, row) / characterWidth(view),
    )
  }
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

export function positionInputInViewport(
  view: VirtualizedTextViewInternal,
  scrollTop: number,
  scrollLeft: number,
): void {
  setStyleValue(view.inputElement, 'top', `${scrollTop}px`)
  setStyleValue(view.inputElement, 'left', `${scrollLeft}px`)
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
  const bottom = top + rowHeight(view, row)
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
  const bottom = rowTop(view, row) + rowHeight(view, row)
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
  return rowBlockLaneInset(view, rowIndex).left + column * characterWidth(view)
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
): { readonly x: number; readonly y: number; readonly verticalDirection: number } {
  const rect = view.scrollElement.getBoundingClientRect()
  const padding = scrollElementPadding(view.scrollElement)
  const left = rect.left + padding.left
  const top = rect.top + padding.top
  const right = Math.max(left, rect.right - padding.right)
  const bottom = Math.max(top, rect.bottom - padding.bottom)

  return {
    x: viewportTextX(view, clientX, left, right, view.virtualizer.getSnapshot().scrollLeft),
    y: clamp(clientY, top, Math.max(top, bottom - 1)) - top,
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
): {
  readonly left: number
  readonly top: number
  readonly height: number
} | null {
  const rowIndex = rowForOffset(view, offset)
  const row = view.rowElements.get(rowIndex)
  if (!row) return null

  return {
    left: gutterWidth(view) + offsetToX(view, row, offset),
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
