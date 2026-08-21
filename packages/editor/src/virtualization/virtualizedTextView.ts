import type { FoldMap } from '../foldMap'
import type { ResolvedSuspiciousCharactersOptions } from '../unicodeHighlight'
import { type InlineMap, revealInlineMap } from '../inlineMap'
import {
  normalizeTabSize,
  isDocumentTextDisplayRow,
  type BlockLane,
  type BlockRow,
  type InjectedTextRow,
} from '../displayTransforms'
import { createStringTextSnapshot, type TextSnapshot } from '../documentTextSnapshot'
import type { EditorTheme } from '../theme'
import type { EditorGutterContribution, EditorGutterWidthContext } from '../plugins'
import type { EditorToken, TextEdit } from '../tokens'
import { applyEditorTheme } from '../theme'
import { measureBrowserTextMetrics, type BrowserTextMetrics } from './browserMetrics'
import { FixedRowVirtualizer, type FixedRowVirtualizerSnapshot } from './fixedRowVirtualizer'
import {
  DEFAULT_OVERSCAN,
  DEFAULT_SELECTION_HIGHLIGHT,
  countValidCaretChecks,
  countValidHitTestChecks,
  countValidSelectionChecks,
  createInputElement,
  createScrollElement,
  createVirtualizerOptions,
  getDefaultHighlightRegistry,
  indexFoldMarkersByKey,
  indexFoldMarkersByStartRow,
  inlineMapMatchesText,
  normalizeChunkSize,
  normalizeChunkThreshold,
  normalizeHorizontalOverscan,
  normalizeRowGap,
  normalizeRowHeight,
  normalizeScrollMode,
} from './virtualizedTextViewHelpers'
import {
  adoptTokens as adoptViewTokens,
  clampStoredSelection,
  clearRangeHighlight,
  clearRowTokenState,
  clearSelection,
  clearSelectionHighlight,
  clearTokenHighlights,
  clearTokenHighlightsFromRow,
  deleteTokenRangesForRow,
  rebuildStyleRules,
  renderRangeHighlight,
  renderSelectionHighlight,
  renderTokenHighlights,
  restoreHighlightsAfterBrowserResume,
  setRangeHighlight,
  setSelection,
  setSelections,
  setTokens as setViewTokens,
} from './virtualizedTextViewHighlights'
import {
  DEFAULT_SUSPICIOUS_SETTINGS,
  normalizeHiddenCharactersMode,
  renderHiddenCharacters,
  setSuspiciousCharacters,
} from './virtualizedTextViewHiddenCharacters'
import { setCompositionPreedit } from './virtualizedTextViewComposition'
import { createVirtualizedTextViewModel } from './virtualizedTextViewModel'
import {
  applyMultiLineTextLayout,
  applySameLineTextLayout,
  lineEndOffset,
  lineStartOffset,
  offsetForViewportColumn,
  rebuildDisplayRows,
  refreshDisplayRowsForWrapWidth,
  rowForOffset,
  rowForViewportY,
  sameLineEditPatch,
  setBlockRowsLayout,
  setFoldStateLayout,
  setInjectedTextRowsLayout,
  materializeLineStarts,
  multiLineEditPatch,
  setTextLayoutState,
  setTextSnapshotLayoutState,
  setWrapEnabledLayout,
  updateVirtualizerRows,
  visibleLineCount,
  visualColumnForOffset,
} from './virtualizedTextViewLayout'
import { LineStartsView } from './lineStartIndex'
import {
  clearRowGeometryCaches,
  knownRowContentWidth,
  measureRowContentWidth,
  xToOffset,
} from './virtualizedTextViewGeometry'
import {
  disposeAllMountedBlockLanes,
  renderBlockLanes,
  setBlockLanesLayout,
} from './virtualizedTextViewBlockLanes'
import {
  applyRowHeight,
  disposeBlockRowMounts,
  disposeGutterCells,
  disposeInlineWidgets,
  ensureOffsetMounted,
  getMountedRows,
  gutterWidth,
  horizontalViewportColumns,
  pageRowDelta,
  positionInputAtCaret,
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
  updateGutterContributions,
  updateGutterWidthIfNeeded,
  updateMountedRowsAfterSameLineEdit,
  updateSpacerHeight,
  updateSpacerWidth,
  viewportPointMetrics,
} from './virtualizedTextViewRows'
import type {
  CreateRangeOptions,
  RevealBlock,
  VirtualizedTextHighlightRange,
  VirtualizedTextHighlightStyle,
  VirtualizedTextSelection,
  VirtualizedTextViewInternal,
} from './virtualizedTextViewInternals'
import type {
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
  MultiLineEditPatch,
  NativeGeometryValidation,
  SameLineEditPatch,
  VirtualizedFoldMarker,
  VirtualizedTextRowDecoration,
  VirtualizedTextViewOptions,
  VirtualizedTextViewScrollMode,
  VirtualizedTextViewState,
} from './virtualizedTextViewTypes'

export type {
  HiddenCharactersMode,
  NativeGeometryValidation,
  VirtualizedFoldMarker,
  VirtualizedTextRowDecoration,
  VirtualizedTextViewOptions,
  VirtualizedTextViewScrollMode,
  VirtualizedTextViewState,
} from './virtualizedTextViewTypes'

const DEFAULT_CURSOR_LINE_HIGHLIGHT: Required<EditorCursorLineHighlightOptions> = {
  gutterNumber: false,
  gutterBackground: true,
  rowBackground: true,
}

function normalizeGutterWidthProvider(
  gutterWidth: VirtualizedTextViewOptions['gutterWidth'],
): ((context: EditorGutterWidthContext) => number) | null {
  if (typeof gutterWidth === 'function') return gutterWidth
  if (gutterWidth === undefined) return null

  return () => gutterWidth
}

function selectionOffsetRanges(
  view: VirtualizedTextViewInternal,
): readonly { readonly start: number; readonly end: number }[] {
  return view.selections.map((selection) => ({ start: selection.start, end: selection.end }))
}

function setScrollModeAttribute(
  element: HTMLElement,
  scrollMode: VirtualizedTextViewScrollMode,
): void {
  element.dataset.editorScrollMode = scrollMode
}

export class VirtualizedTextView {
  public readonly scrollElement: HTMLDivElement
  public readonly inputElement: HTMLTextAreaElement
  private readonly view: VirtualizedTextViewInternal
  private readonly disposeForegroundHighlightRestore: () => void
  private cancelContentWidthMeasurement: (() => void) | null = null

  public constructor(container: HTMLElement, options: VirtualizedTextViewOptions = {}) {
    const overscan = options.overscan ?? DEFAULT_OVERSCAN
    const gutterContributions = options.gutterContributions ?? []
    const gutterWidthProvider = normalizeGutterWidthProvider(options.gutterWidth)

    const styleEl = container.ownerDocument.createElement('style')
    const scrollElement = createScrollElement(container, options.className)
    const textMetrics = options.textMetrics ?? null
    const measuredMetrics = textMetrics ?? measureBrowserTextMetrics(scrollElement)
    const lineHeightOverride = options.lineHeight ?? options.rowHeight ?? null
    const rowHeight = normalizeRowHeight(lineHeightOverride ?? measuredMetrics.rowHeight)
    const rowGap = normalizeRowGap(options.rowGap)
    const scrollMode = normalizeScrollMode(options.scrollMode)
    const rowPositioning = options.rowPositioning ?? 'transform'
    const inputElement = createInputElement(container)
    const spacer = container.ownerDocument.createElement('div')
    const gutterElement = container.ownerDocument.createElement('div')
    const blockLaneLayerElement = container.ownerDocument.createElement('div')
    const caretLayerElement = container.ownerDocument.createElement('div')
    const caretElement = container.ownerDocument.createElement('div')
    const longLineChunkSize = normalizeChunkSize(options.longLineChunkSize)
    const longLineChunkThreshold = normalizeChunkThreshold(
      options.longLineChunkThreshold,
      longLineChunkSize,
    )
    const tabSize = normalizeTabSize(options.tabSize)
    const virtualizer = new FixedRowVirtualizer(
      createVirtualizerOptions(rowHeight, overscan, rowGap, scrollMode),
    )
    const initialTextSnapshot = createStringTextSnapshot('')
    const initialBlockRows = options.blockRows ?? []
    const initialInjectedTextRows = options.injectedTextRows ?? []
    const initialModel = createVirtualizedTextViewModel({
      textSnapshot: initialTextSnapshot,
      lineStarts: [0],
      foldMap: null,
      inlineMap: null,
      blockRows: initialBlockRows,
      injectedTextRows: initialInjectedTextRows,
      wrapColumn: null,
      tabSize,
    })

    this.scrollElement = scrollElement
    this.inputElement = inputElement
    this.view = {
      scrollElement,
      inputElement,
      spacer,
      gutterElement,
      gutterContributions,
      gutterWidthProvider,
      caretLayerElement,
      caretElement,
      secondaryCaretElements: [],
      styleEl,
      virtualizer,
      scrollMode,
      rowPositioning,
      longLineChunkSize,
      longLineChunkThreshold,
      horizontalOverscanColumns: normalizeHorizontalOverscan(options.horizontalOverscanColumns),
      onFoldToggle: options.onFoldToggle ?? null,
      onViewportChange: options.onViewportChange ?? null,
      blockRowMount: options.blockRowMount ?? null,
      blockLaneMount: options.blockLaneMount ?? null,
      blockLaneLayerElement,
      cursorLineHighlight: normalizeCursorLineHighlight(options.cursorLineHighlight),
      rowElements: new Map(),
      rowPool: [],
      highlightRegistry: options.highlightRegistry ?? getDefaultHighlightRegistry(),
      selectionHighlightName: options.selectionHighlightName ?? DEFAULT_SELECTION_HIGHLIGHT,
      selectionHighlight: null,
      rangeHighlightGroups: new Map(),
      selectionHighlightRegistered: false,
      model: initialModel,
      text: '',
      textRevision: 0,
      tokens: [],
      tokenRenderEntries: [],
      tokenRenderEntryMaxEnds: [],
      tokenRenderStyles: new Map(),
      tokenRenderIndexDirty: true,
      lineStarts: [0],
      lineStartOffsetIndex: null,
      foldMarkers: [],
      rowDecorations: new Map(),
      foldMarkerByStartRow: new Map(),
      foldMarkerByKey: new Map(),
      rowHeightIndex: null,
      rowHeightIndexDisplayRows: null,
      rowHeightIndexRowHeight: rowHeight,
      rowHeightIndexRowGap: rowGap,
      rowHeightIndexVariable: null,
      blockLanes: [],
      blockLaneElements: new Map(),
      wrapEnabled: options.wrap ?? false,
      tabSize,
      tokenGroups: new Map(),
      rowTokenSignatures: new Map(),
      rowTokenRanges: new Map(),
      tokenProjectionDirtyStartRow: null,
      nextTokenHighlightSlotId: 0,
      selectionStart: null,
      selectionEnd: null,
      selectionHead: null,
      selections: [],
      inlineMapBase: null,
      lastSelectionHighlightSignature: '',
      lastRenderedRowsKey: '',
      lastSpacerHeight: '',
      lastSpacerTransform: '',
      lastSpacerWidth: '',
      gutterContributionWidths: new Map(),
      gutterWidthDirty: true,
      currentGutterWidth: 0,
      contentWidth: 0,
      maxVisualColumnsSeen: 0,
      lastWidthScanStart: 0,
      lastWidthScanEnd: -1,
      sameLineTokenEdit: null,
      lineHeightOverride,
      rowGap,
      metrics: { ...measuredMetrics, rowHeight },
      textMetrics,
      hiddenCharacters: normalizeHiddenCharactersMode(options.hiddenCharacters),
      suspiciousCharacters: DEFAULT_SUSPICIOUS_SETTINGS,
    }

    scrollElement.style.setProperty('--editor-gutter-width', '0px')
    scrollElement.style.setProperty('--editor-tab-size', String(tabSize))
    setScrollModeAttribute(scrollElement, scrollMode)
    scrollElement.dataset.editorRowPositioning = rowPositioning
    setBlockLanesLayout(this.view, options.blockLanes ?? [])
    applyRowHeight(this.view, rowHeight)
    spacer.className = 'editor-virtualized-spacer'
    gutterElement.className = 'editor-virtualized-gutter'
    blockLaneLayerElement.className = 'editor-virtualized-horizontal-block-layer'
    caretLayerElement.className = 'editor-virtualized-caret-layer'
    caretElement.className = 'editor-virtualized-caret'
    caretElement.hidden = true
    caretLayerElement.appendChild(caretElement)
    if (gutterContributions.length > 0 || gutterWidthProvider) spacer.appendChild(gutterElement)
    spacer.appendChild(blockLaneLayerElement)
    spacer.appendChild(caretLayerElement)
    scrollElement.appendChild(spacer)
    scrollElement.appendChild(inputElement)

    virtualizer.attachScrollElement(
      scrollElement,
      (snapshot) => {
        this.renderSnapshot(snapshot)
      },
      { readInitialScrollPosition: false },
    )
    this.disposeForegroundHighlightRestore = subscribeToForegroundHighlightRestore(this.view)
    rebuildStyleRules(this.view)
  }

  public dispose(): void {
    const view = this.view
    this.cancelContentWidthMeasurement?.()
    this.cancelContentWidthMeasurement = null
    this.disposeForegroundHighlightRestore()
    clearSelectionHighlight(view)
    for (const name of view.rangeHighlightGroups.keys()) clearRangeHighlight(view, name)
    clearTokenHighlights(view)
    view.virtualizer.dispose()
    disposeBlockRowMounts(view)
    disposeInlineWidgets(view)
    disposeAllMountedBlockLanes(view)
    disposeGutterCells(view)
    this.scrollElement.remove()
    view.styleEl.remove()
    view.rowElements.clear()
    view.rowPool.length = 0
  }

  public setText(text: string, textSnapshot = createStringTextSnapshot(text)): void {
    const view = this.view
    view.sameLineTokenEdit = null
    view.tokenProjectionDirtyStartRow = null
    view.tokenRenderIndexDirty = true
    const { lineCountChanged } = setTextLayoutState(view, text, textSnapshot)
    this.finishTextReplacement(lineCountChanged)
  }

  public refreshGutterWidth(): void {
    const view = this.view
    view.gutterWidthDirty = true
    this.renderSnapshot(view.virtualizer.getSnapshot())
  }

  public setFoldMap(foldMap: FoldMap | null): void {
    this.setFoldState(this.view.foldMarkers, foldMap)
  }

  public setInlineMap(inlineMap: InlineMap | null): void {
    const view = this.view
    view.inlineMapBase = inlineMapMatchesText(inlineMap, view.model.textLength) ? inlineMap : null
    this.refreshInlineReveal()
  }

  /**
   * Re-derives the rendered inline map from the supplied one by revealing whatever the selections
   * touch, then rebuilds rows only if the result actually differs. Rendering and coordinate mapping
   * both read `model.inlineMap`, so they always agree on what is currently hidden.
   */
  private refreshInlineReveal(): void {
    const view = this.view
    const base = view.inlineMapBase
    const next = base ? revealInlineMap(base, selectionOffsetRanges(view)) : null
    if (view.model.inlineMap === next) return

    view.model.inlineMap = next
    clearRowTokenState(view)
    rebuildDisplayRows(view, horizontalViewportColumns(view))
    view.lastRenderedRowsKey = ''
    updateVirtualizerRows(view)
  }

  public setFoldMarkers(markers: readonly VirtualizedFoldMarker[]): void {
    this.setFoldState(markers, this.view.model.foldMap)
  }

  public setFoldState(markers: readonly VirtualizedFoldMarker[], foldMap: FoldMap | null): void {
    const view = this.view
    const update = setFoldStateLayout(view, markers, foldMap)
    if (!update.changed) return

    if (update.foldMapChanged) clearRowTokenState(view)
    if (update.foldMapChanged) rebuildDisplayRows(view, horizontalViewportColumns(view))

    view.lastRenderedRowsKey = ''
    if (update.foldMapChanged) {
      updateVirtualizerRows(view)
      return
    }

    this.renderSnapshot(view.virtualizer.getSnapshot())
  }

  public refreshMetrics(): BrowserTextMetrics {
    const view = this.view
    const measured = view.textMetrics ?? measureBrowserTextMetrics(this.scrollElement)
    const rowHeightValue = normalizeRowHeight(view.lineHeightOverride ?? measured.rowHeight)
    this.applyMetrics({ rowHeight: rowHeightValue, characterWidth: measured.characterWidth })
    return view.metrics
  }

  public setLineHeight(lineHeight: number): boolean {
    const view = this.view
    const rowHeightValue = normalizeRowHeight(lineHeight)
    view.lineHeightOverride = rowHeightValue
    if (view.metrics.rowHeight === rowHeightValue) return false

    this.applyMetrics({ ...view.metrics, rowHeight: rowHeightValue })
    return true
  }

  public setRowHeight(rowHeight: number): boolean {
    return this.setLineHeight(rowHeight)
  }

  public setRowGap(rowGap: number): boolean {
    const view = this.view
    const nextRowGap = normalizeRowGap(rowGap)
    if (view.rowGap === nextRowGap) return false

    view.rowGap = nextRowGap
    clearRowGeometryCaches(view)
    view.lastRenderedRowsKey = ''
    updateVirtualizerRows(view)
    return true
  }

  public setScrollMode(scrollMode: VirtualizedTextViewScrollMode | undefined): boolean {
    const view = this.view
    const nextScrollMode = normalizeScrollMode(scrollMode)
    if (view.scrollMode === nextScrollMode) return false

    view.scrollMode = nextScrollMode
    setScrollModeAttribute(view.scrollElement, nextScrollMode)
    view.lastRenderedRowsKey = ''
    view.virtualizer.updateOptions({ scrollMode: nextScrollMode })
    return true
  }

  private applyMetrics(metrics: BrowserTextMetrics): void {
    const view = this.view
    view.metrics = metrics
    clearRowGeometryCaches(view)
    const rowHeightValue = metrics.rowHeight
    applyRowHeight(view, rowHeightValue)
    view.gutterWidthDirty = true
    this.refreshWrapWidth()
    view.lastRenderedRowsKey = ''
    updateVirtualizerRows(view)
  }

  public applyEdit(edit: TextEdit, nextText: TextSnapshot | string): void {
    const view = this.view
    const textSnapshot =
      typeof nextText === 'string' ? createStringTextSnapshot(nextText) : nextText
    const sameLinePatch = sameLineEditPatch(view, edit)
    if (sameLinePatch) {
      this.applySameLineEdit(sameLinePatch, textSnapshot)
      return
    }

    const multiLinePatch = multiLineEditPatch(view, edit)
    if (multiLinePatch) {
      this.applyMultiLineEdit(multiLinePatch, edit, textSnapshot)
      return
    }

    this.setTextSnapshot(textSnapshot)
  }

  public setTokens(tokens: readonly EditorToken[]): void {
    setViewTokens(this.view, tokens)
  }

  public adoptTokens(tokens: readonly EditorToken[]): void {
    adoptViewTokens(this.view, tokens)
  }

  public setTheme(theme: EditorTheme | null | undefined): void {
    applyEditorTheme(this.scrollElement, theme)
  }

  public setEditable(editable: boolean): void {
    if (editable) {
      this.inputElement.readOnly = false
      return
    }

    this.inputElement.readOnly = true
  }

  /** The text an IME is still assembling, drawn at the caret; empty text takes it back down. */
  public setCompositionPreedit(text: string): void {
    setCompositionPreedit(this.view, text)
  }

  public focusInput(): void {
    const view = this.view
    const snapshot = view.virtualizer.getSnapshot()
    const scrollTop = snapshot.scrollTop
    const scrollLeft = this.scrollElement.scrollLeft
    positionInputAtCaret(view)
    // Focus and nothing more: the value and the caret inside it belong to whoever knows the
    // document, and are rewritten from it on every selection change. Emptying them here would take
    // the screen reader's only view of the text away on each click, and leave an edit deduced from
    // the element nothing to be deduced against.
    this.inputElement.focus({ preventScroll: true })
    restoreScrollPosition(view, scrollTop, scrollLeft)
  }

  public setScrollMetrics(
    scrollTop: number,
    viewportHeight: number,
    viewportWidth?: number,
    scrollLeft?: number,
  ): void {
    const width = viewportWidth ?? this.view.virtualizer.getSnapshot().viewportWidth
    this.refreshWrapWidth(width)
    this.view.virtualizer.setScrollMetrics({
      scrollTop,
      viewportHeight,
      viewportWidth,
      scrollLeft,
    })
  }

  public isWrapEnabled(): boolean {
    return this.view.wrapEnabled
  }

  public setWrapEnabled(enabled: boolean): void {
    const view = this.view
    if (!setWrapEnabledLayout(view, enabled, horizontalViewportColumns(view))) return

    resetContentWidthScan(view)
    clearRowGeometryCaches(view)
    view.lastRenderedRowsKey = ''
    updateVirtualizerRows(view)
  }

  public setSuspiciousCharacters(options: ResolvedSuspiciousCharactersOptions): boolean {
    return setSuspiciousCharacters(this.view, options)
  }

  public setHiddenCharacters(mode: HiddenCharactersMode): void {
    const view = this.view
    const next = normalizeHiddenCharactersMode(mode)
    if (view.hiddenCharacters === next) return

    view.hiddenCharacters = next
    renderHiddenCharacters(view)
  }

  public setBlockRows(blockRows: readonly BlockRow[]): void {
    const view = this.view
    setBlockRowsLayout(view, blockRows, horizontalViewportColumns(view))
    resetContentWidthScan(view)
    clearRowGeometryCaches(view)
    view.lastRenderedRowsKey = ''
    updateVirtualizerRows(view)
  }

  public setInjectedTextRows(injectedTextRows: readonly InjectedTextRow[]): void {
    const view = this.view
    setInjectedTextRowsLayout(view, injectedTextRows, horizontalViewportColumns(view))
    resetContentWidthScan(view)
    clearRowGeometryCaches(view)
    view.lastRenderedRowsKey = ''
    view.gutterWidthDirty = true
    updateVirtualizerRows(view)
  }

  public setBlockLanes(blockLanes: readonly BlockLane[]): void {
    const view = this.view
    setBlockLanesLayout(view, blockLanes)
    resetContentWidthScan(view)
    clearRowGeometryCaches(view)
    view.lastRenderedRowsKey = ''
    this.renderSnapshot(view.virtualizer.getSnapshot())
  }

  public setRowDecorations(decorations: ReadonlyMap<number, VirtualizedTextRowDecoration>): void {
    const view = this.view
    view.rowDecorations = decorations
    clearRowGeometryCaches(view)
    view.lastRenderedRowsKey = ''
    this.renderSnapshot(view.virtualizer.getSnapshot())
  }

  public setGutterContributions(contributions: readonly EditorGutterContribution[]): boolean {
    if (!updateGutterContributions(this.view, contributions)) return false

    this.renderSnapshot(this.view.virtualizer.getSnapshot())
    return true
  }

  public reserveOverlayWidth(side: 'left' | 'right', width: number): boolean {
    const value = width > 0 && Number.isFinite(width) ? `${Math.ceil(width)}px` : ''
    const property = overlayPaddingProperty(side)
    if (this.scrollElement.style[property] === value) return false

    this.scrollElement.style[property] = value
    return true
  }

  public reservedOverlayWidth(side: 'left' | 'right'): number {
    const width = Number.parseFloat(this.scrollElement.style[overlayPaddingProperty(side)])
    return Number.isFinite(width) ? width : 0
  }

  public scrollToRow(row: number): void {
    scrollToRow(this.view, row)
  }

  public revealOffset(offset: number, block: RevealBlock = 'nearest'): void {
    const view = this.view
    if (block === 'end') {
      scrollOffsetToViewportEnd(view, offset)
      ensureOffsetMounted(view, offset)
      return
    }

    ensureOffsetMounted(view, offset)
    scrollOffsetIntoView(view, offset)
  }

  public visualColumnForOffset(offset: number): number {
    return visualColumnForOffset(this.view, offset)
  }

  public offsetByDisplayRows(offset: number, rowDelta: number, visualColumn: number): number {
    const view = this.view
    const row = rowForOffset(view, offset)
    const targetRow = documentTextRowByDisplayDelta(view, row, rowDelta)
    return offsetForViewportColumn(view, targetRow, visualColumn)
  }

  public offsetAtLineBoundary(offset: number, boundary: 'start' | 'end'): number {
    const view = this.view
    const row = rowForOffset(view, offset)
    if (boundary === 'start') return lineStartOffset(view, row)
    return lineEndOffset(view, row)
  }

  public pageRowDelta(): number {
    return pageRowDelta(this.view)
  }

  public getLineStarts(): readonly number[] {
    return materializeLineStarts(this.view)
  }

  // Snapshot view over the current line starts without forcing the pending
  // suffix deltas to materialize into a fresh array.
  public getLineStartsView(): LineStartsView {
    const offsetIndex = this.view.lineStartOffsetIndex
    if (!offsetIndex?.dirty) return new LineStartsView(this.view.lineStarts, [])

    const revision = offsetIndex.revision
    return new LineStartsView(
      this.view.lineStarts,
      offsetIndex.snapshotDeltas(),
      (materialized) => {
        // Adopt the materialized array as the new base while no further edits
        // have landed, so internal consumers skip their own materialization.
        if (this.view.lineStartOffsetIndex !== offsetIndex) return
        if (offsetIndex.revision !== revision) return

        // Freshly built by toArray when deltas exist; never the shared base.
        this.view.lineStarts = materialized as number[]
        this.view.lineStartOffsetIndex = null
      },
    )
  }

  public getLineCount(): number {
    return this.view.lineStarts.length
  }

  public createRange(
    startOffset: number,
    endOffset: number,
    options: CreateRangeOptions = {},
  ): Range | null {
    const view = this.view
    if (options.scrollIntoView !== false) ensureOffsetMounted(view, startOffset)

    const start = resolveMountedOffset(view, startOffset)
    const end = resolveMountedOffset(view, endOffset)
    if (!start || !end) return null

    const range = this.scrollElement.ownerDocument.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    return range
  }

  public getState(): VirtualizedTextViewState {
    const view = this.view
    const snapshot = view.virtualizer.getSnapshot()
    return {
      lineCount: view.lineStarts.length,
      contentWidth: view.contentWidth,
      foldMapActive: view.model.foldMap !== null,
      metrics: view.metrics,
      scrollHeight: Math.max(snapshot.viewportHeight, snapshot.scrollHeight),
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
      blockRowCount: view.model.blockRows.length,
      blockLaneCount: view.blockLanes.length,
      tabSize: view.tabSize,
    }
  }

  public validateMountedNativeGeometry(): NativeGeometryValidation {
    const rows = getMountedRows(this.view)
    const failures: string[] = []
    const caretChecks = countValidCaretChecks(rows, failures)
    const selectionChecks = countValidSelectionChecks(rows, failures)
    const hitTestChecks = countValidHitTestChecks(this.scrollElement, rows, failures)

    return {
      mountedRows: rows.length,
      caretChecks,
      selectionChecks,
      hitTestChecks,
      failures,
      ok: failures.length === 0,
    }
  }

  public textOffsetFromPoint(clientX: number, clientY: number): number | null {
    return this.textOffsetFromViewportPoint(clientX, clientY)
  }

  public textOffsetFromViewportPoint(clientX: number, clientY: number): number | null {
    const view = this.view
    const metrics = viewportPointMetrics(view, clientX, clientY)
    if (metrics.verticalDirection < 0)
      return lineStartOffset(view, rowForViewportY(view, metrics.y))
    if (metrics.verticalDirection > 0) return lineEndOffset(view, rowForViewportY(view, metrics.y))

    const row = rowForViewportY(view, metrics.y)
    if (!isDocumentTextDisplayRow(view.model.rows[row])) return null

    const mounted = view.rowElements.get(row)
    if (mounted?.kind === 'text') return xToOffset(view, mounted, metrics.x)

    const column = Math.floor(metrics.x / Math.max(1, view.metrics.characterWidth))
    return offsetForViewportColumn(view, row, column)
  }

  public textOffsetFromDomBoundary(node: Node, offset: number): number | null {
    return textOffsetFromDomBoundary(this.view, node, offset)
  }

  public setSelection(anchorOffset: number, headOffset: number): void {
    setSelection(this.view, anchorOffset, headOffset)
    this.refreshInlineReveal()
  }

  public setSelections(selections: readonly VirtualizedTextSelection[]): void {
    setSelections(this.view, selections)
    this.refreshInlineReveal()
  }

  public clearSelection(): void {
    clearSelection(this.view)
    this.refreshInlineReveal()
  }

  public setRangeHighlight(
    name: string,
    ranges: readonly VirtualizedTextHighlightRange[],
    style: VirtualizedTextHighlightStyle,
  ): void {
    setRangeHighlight(this.view, name, ranges, style)
  }

  public clearRangeHighlight(name: string): void {
    clearRangeHighlight(this.view, name)
  }

  private renderSnapshot(snapshot: FixedRowVirtualizerSnapshot): void {
    const view = this.view
    const gutterWidthChanged = updateGutterWidthIfNeeded(view)
    updateSpacerHeight(view, snapshot)
    updateSpacerWidth(view, snapshot.viewportWidth)
    const key = rowsKey(view, snapshot)
    if (key === view.lastRenderedRowsKey) {
      if (gutterWidthChanged) renderBlockLanes(view, snapshot)
      view.onViewportChange?.()
      return
    }

    view.lastRenderedRowsKey = key
    renderRows(view, snapshot, (rowSlotId) => deleteTokenRangesForRow(view, rowSlotId))
    this.applyKnownContentWidths(snapshot)
    renderBlockLanes(view, snapshot)
    renderTokenHighlights(view)
    for (const name of view.rangeHighlightGroups.keys()) renderRangeHighlight(view, name)
    renderSelectionHighlight(view)
    view.onViewportChange?.()
  }

  /**
   * The horizontal scroll extent is a column-count estimate, and a wide glyph advances further than
   * the one cell it is counted as — so a CJK or emoji line reaches past the extent and its end
   * cannot be scrolled to. Rows that already know their rendered width correct it here for free;
   * the rest are measured off the critical path, because finding out costs a layout read and the
   * render pass has just finished writing to the DOM.
   */
  private applyKnownContentWidths(snapshot: FixedRowVirtualizerSnapshot): void {
    const view = this.view
    let unmeasured = false
    for (const row of view.rowElements.values()) {
      if (row.kind !== 'text') continue

      const width = knownRowContentWidth(view, row)
      if (width === null) {
        unmeasured = true
        continue
      }

      raiseVisualColumnsSeen(view, width)
    }

    updateContentWidth(view, snapshot.virtualItems)
    if (unmeasured) this.scheduleContentWidthMeasurement()
  }

  private scheduleContentWidthMeasurement(): void {
    if (this.cancelContentWidthMeasurement) return

    const win = this.scrollElement.ownerDocument.defaultView
    if (!win) return

    const run = () => {
      this.cancelContentWidthMeasurement = null
      this.measureContentWidths()
    }

    if (typeof win.requestIdleCallback === 'function') {
      /**
       * @justification Measuring every row's width is the work the horizontal scroll extent needs
       * and nothing on screen is waiting for, so it is deliberately given whatever the frame has
       * left rather than a place in the queue. `cancelContentWidthMeasurement` withdraws it when
       * the content it would measure has already changed.
       */
      const handle = win.requestIdleCallback(run)
      this.cancelContentWidthMeasurement = () => win.cancelIdleCallback(handle)
      return
    }

    /**
     * @justification The same deferral for an engine with no idle callback. Zero rather than a
     * delay, because the point is only to leave the current frame, and the same cancel withdraws it.
     */
    const handle = win.setTimeout(run, 0)
    this.cancelContentWidthMeasurement = () => win.clearTimeout(handle)
  }

  private measureContentWidths(): void {
    const view = this.view
    let raised = false
    for (const row of view.rowElements.values()) {
      if (row.kind !== 'text') continue

      raised = raiseVisualColumnsSeen(view, measureRowContentWidth(view, row)) || raised
    }

    if (!raised) return
    updateContentWidth(view, view.virtualizer.getSnapshot().virtualItems)
  }

  private applySameLineEdit(patch: SameLineEditPatch, nextText: TextSnapshot): void {
    const view = this.view
    const snapshot = view.virtualizer.getSnapshot()
    view.tokenRenderIndexDirty = true
    applySameLineTextLayout(view, patch, nextText)
    clampStoredSelection(view)
    resetContentWidthScan(view)
    clearRowGeometryCaches(view)
    updateContentWidth(view, snapshot.virtualItems)
    const editedRowPatchedInPlace = updateMountedRowsAfterSameLineEdit(
      view,
      snapshot.virtualItems,
      patch,
      snapshot,
    )
    view.sameLineTokenEdit = {
      rowIndex: patch.rowIndex,
      editedRowPatchedInPlace,
      kind: 'same-line',
    }
    renderHiddenCharacters(view)
  }

  private applyMultiLineEdit(
    patch: MultiLineEditPatch,
    edit: TextEdit,
    nextText: TextSnapshot,
  ): void {
    const view = this.view
    view.tokenRenderIndexDirty = true
    applyMultiLineTextLayout(view, patch, edit, nextText)
    clampStoredSelection(view)
    resetContentWidthScan(view)
    clearRowGeometryCaches(view)
    if (patch.insertedLineBreaks !== patch.endRow - patch.startRow) view.gutterWidthDirty = true
    view.lastRenderedRowsKey = ''
    view.sameLineTokenEdit = {
      rowIndex: patch.startRow,
      editedRowPatchedInPlace: false,
      kind: 'multi-line',
    }
    view.tokenProjectionDirtyStartRow = dirtyTokenProjectionStartRow(
      view.tokenProjectionDirtyStartRow,
      patch.startRow,
    )
    projectFoldMarkersThroughMultiLineEdit(view, patch, edit)
    projectRowDecorationsThroughMultiLineEdit(view, patch)
    clearTokenHighlightsFromRow(view, patch.startRow)
    updateVirtualizerRows(view)
    renderHiddenCharacters(view)
  }

  private setTextSnapshot(textSnapshot: TextSnapshot): void {
    const view = this.view
    view.sameLineTokenEdit = null
    view.tokenProjectionDirtyStartRow = null
    view.tokenRenderIndexDirty = true
    const { lineCountChanged } = setTextSnapshotLayoutState(view, textSnapshot)
    this.finishTextReplacement(lineCountChanged)
  }

  private finishTextReplacement(lineCountChanged: boolean): void {
    const view = this.view
    if (lineCountChanged) view.gutterWidthDirty = true
    rebuildDisplayRows(view, horizontalViewportColumns(view))
    clampStoredSelection(view)
    clearRowTokenState(view)
    view.lastRenderedRowsKey = ''
    resetContentWidthScan(view)
    updateVirtualizerRows(view)
  }

  private refreshWrapWidth(
    viewportWidth = this.view.virtualizer.getSnapshot().viewportWidth,
  ): void {
    const view = this.view
    const changed = refreshDisplayRowsForWrapWidth(
      view,
      horizontalViewportColumns(view, viewportWidth),
    )
    if (!changed) return

    resetContentWidthScan(view)
    view.lastRenderedRowsKey = ''
    updateVirtualizerRows(view)
  }
}

function raiseVisualColumnsSeen(view: VirtualizedTextViewInternal, width: number): boolean {
  const columns = width / Math.max(1, view.metrics.characterWidth)
  if (columns <= view.maxVisualColumnsSeen) return false

  view.maxVisualColumnsSeen = columns
  return true
}

function subscribeToForegroundHighlightRestore(view: VirtualizedTextViewInternal): () => void {
  const doc = view.scrollElement.ownerDocument
  const win = doc.defaultView
  if (!win) return () => {}

  const restore = () => restoreHighlightsAfterBrowserResume(view)
  const restoreWhenVisible = () => {
    if (doc.visibilityState === 'hidden') return

    restore()
  }

  win.addEventListener('focus', restore)
  win.addEventListener('pageshow', restore)
  doc.addEventListener('visibilitychange', restoreWhenVisible)

  return () => {
    win.removeEventListener('focus', restore)
    win.removeEventListener('pageshow', restore)
    doc.removeEventListener('visibilitychange', restoreWhenVisible)
  }
}

function documentTextRowByDisplayDelta(
  view: VirtualizedTextViewInternal,
  row: number,
  rowDelta: number,
): number {
  if (rowDelta === 0) return row

  const step = rowDelta > 0 ? 1 : -1
  let remaining = Math.abs(rowDelta)
  let current = row
  while (remaining > 0) {
    const next = nextDocumentTextRow(view, current, step)
    if (next === current) return current

    current = next
    remaining -= 1
  }

  return current
}

function nextDocumentTextRow(view: VirtualizedTextViewInternal, row: number, step: 1 | -1): number {
  const end = step > 0 ? visibleLineCount(view) - 1 : 0
  let current = row
  while (current !== end) {
    current += step
    if (isDocumentTextDisplayRow(view.model.rows[current])) return current
  }

  return row
}

function normalizeCursorLineHighlight(
  options: EditorCursorLineHighlightOptions | undefined,
): Required<EditorCursorLineHighlightOptions> {
  return {
    gutterNumber: options?.gutterNumber ?? DEFAULT_CURSOR_LINE_HIGHLIGHT.gutterNumber,
    gutterBackground: options?.gutterBackground ?? DEFAULT_CURSOR_LINE_HIGHLIGHT.gutterBackground,
    rowBackground: options?.rowBackground ?? DEFAULT_CURSOR_LINE_HIGHLIGHT.rowBackground,
  }
}

function projectFoldMarkersThroughMultiLineEdit(
  view: VirtualizedTextViewInternal,
  patch: MultiLineEditPatch,
  edit: TextEdit,
): void {
  if (view.foldMarkers.length === 0) return

  const rowDelta = multiLineEditRowDelta(patch)
  const offsetDelta = patch.delta
  const markers = view.foldMarkers.map((marker) =>
    projectFoldMarkerThroughEdit(marker, edit, offsetDelta, rowDelta, view.model.textLength),
  )
  view.foldMarkers = markers
  view.foldMarkerByStartRow = indexFoldMarkersByStartRow(markers)
  view.foldMarkerByKey = indexFoldMarkersByKey(markers)
}

function projectFoldMarkerThroughEdit(
  marker: VirtualizedFoldMarker,
  edit: TextEdit,
  offsetDelta: number,
  rowDelta: number,
  textLength: number,
): VirtualizedFoldMarker {
  if (edit.to <= marker.startOffset) {
    return shiftFoldMarker(marker, offsetDelta, rowDelta, textLength)
  }
  if (edit.from >= marker.endOffset) return marker
  if (edit.from > marker.startOffset && edit.to < marker.endOffset) {
    return resizeFoldMarkerEnd(marker, offsetDelta, rowDelta, textLength)
  }

  return marker
}

function shiftFoldMarker(
  marker: VirtualizedFoldMarker,
  offsetDelta: number,
  rowDelta: number,
  textLength: number,
): VirtualizedFoldMarker {
  return {
    ...marker,
    startOffset: clampNumber(marker.startOffset + offsetDelta, 0, textLength),
    endOffset: clampNumber(marker.endOffset + offsetDelta, 0, textLength),
    startRow: Math.max(0, marker.startRow + rowDelta),
    endRow: Math.max(0, marker.endRow + rowDelta),
  }
}

function resizeFoldMarkerEnd(
  marker: VirtualizedFoldMarker,
  offsetDelta: number,
  rowDelta: number,
  textLength: number,
): VirtualizedFoldMarker {
  const endOffset = clampNumber(marker.endOffset + offsetDelta, marker.startOffset + 1, textLength)
  return {
    ...marker,
    endOffset,
    endRow: Math.max(marker.startRow + 1, marker.endRow + rowDelta),
  }
}

function projectRowDecorationsThroughMultiLineEdit(
  view: VirtualizedTextViewInternal,
  patch: MultiLineEditPatch,
): void {
  if (view.rowDecorations.size === 0) return

  const rowDelta = multiLineEditRowDelta(patch)
  if (rowDelta === 0) return

  const decorations = new Map<number, VirtualizedTextRowDecoration>()
  for (const [row, decoration] of view.rowDecorations) {
    if (row < patch.startRow) {
      decorations.set(row, decoration)
      continue
    }

    if (row === patch.startRow) {
      decorations.set(row, decoration)
      continue
    }

    if (row > patch.endRow) {
      decorations.set(Math.max(0, row + rowDelta), decoration)
    }
  }

  view.rowDecorations = decorations
}

function multiLineEditRowDelta(patch: MultiLineEditPatch): number {
  return patch.insertedLineBreaks - (patch.endRow - patch.startRow)
}

function dirtyTokenProjectionStartRow(current: number | null, row: number): number {
  if (current === null) return row
  return Math.min(current, row)
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// A reservation is stored as scroll-element padding and has no other record.
function overlayPaddingProperty(side: 'left' | 'right'): 'paddingLeft' | 'paddingRight' {
  return side === 'left' ? 'paddingLeft' : 'paddingRight'
}
