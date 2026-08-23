import type { FoldMap } from '../foldMap'
import { nextGraphemeBoundary, previousGraphemeBoundary } from '../graphemes'
import type { ResolvedSuspiciousCharactersOptions } from '../unicodeHighlight'
import { type InlineMap, revealInlineMap } from '../inlineMap'
import {
  normalizeTabSize,
  isDocumentTextDisplayRow,
  type InjectedTextRow,
} from '../displayTransforms'
import { createStringTextSnapshot, type TextSnapshot } from '../documentTextSnapshot'
import type { EditorTheme } from '../theme'
import type { EditorGutterContribution, EditorGutterWidthContext } from '../plugins'
import type { SelectionAffinity, SelectionGoal } from '../selections'
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
  hitTestBoundaryFromPoint,
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
  rowForCaretPosition,
  rowForOffset,
  rowForViewportY,
  sameLineEditPatch,
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
  boundaryAffinityForX,
  boundaryPositionXs,
  boundaryPositionXsForAffinity,
  clearRowGeometryCaches,
  isBidiMeasurementRefusalRow,
  knownRowContentWidth,
  measureRowContentWidth,
  offsetFromDomBoundary,
  rowLocalXFromClientPoint,
  rowMightContainRTL,
  rowTextExtent,
  unitRectForOffset,
  visualCaretAtRowEdge,
  visualCaretMoveInRow,
  xToOffset,
  type VisualCaretTarget,
} from './virtualizedTextViewGeometry'
import { rowLocalIndexForOffset, rowOffsetForLocalIndex } from './virtualizedTextViewInlineMapping'
import {
  applyRowHeight,
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
  DocumentWithCaretHitTesting,
  MountedVirtualizedTextRow,
  VirtualizedBidiSelectionAnchor,
  VirtualizedTextHitPosition,
} from './virtualizedTextViewTypes'

type VerticalSelectionGoal = Exclude<SelectionGoal, { readonly kind: 'none' }>

type BidiExtremalBoundaryCache = {
  readonly geometry: unknown
  readonly left: number
  readonly right: number
}

type BidiVisualOrientationCache = {
  readonly geometry: unknown
  readonly startOnLeft: boolean
}

const bidiExtremalBoundaryCaches = new WeakMap<HTMLElement, BidiExtremalBoundaryCache>()
const bidiVisualOrientationCaches = new WeakMap<HTMLElement, BidiVisualOrientationCache>()
const AUXILIARY_CARET_HIT_SELECTOR = [
  '.editor-virtualized-caret',
  '.editor-virtualized-caret-layer',
  '.editor-virtualized-selection-layer',
  '.editor-virtualized-hidden-character-layer',
  '.editor-virtualized-fold-placeholder',
].join(',')

type HiddenCaretHitElement = {
  readonly element: HTMLElement
  readonly visibility: string
}

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
    const initialInjectedTextRows = options.injectedTextRows ?? []
    const initialModel = createVirtualizedTextViewModel({
      textSnapshot: initialTextSnapshot,
      lineStarts: [0],
      foldMap: null,
      inlineMap: null,
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
      rangeHighlightRuleVersion: 0,
      // Behind the live version, so the first rebuild always writes.
      renderedRangeHighlightRuleVersion: -1,
      virtualizer,
      scrollMode,
      rowPositioning,
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
      selectionHighlight: null,
      rangeHighlightGroups: new Map(),
      selectionHighlightRegistered: false,
      model: initialModel,
      text: '',
      textRevision: 0,
      displayProjectionRevision: 0,
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
    applyRowHeight(this.view, rowHeight)
    spacer.className = 'editor-virtualized-spacer'
    gutterElement.className = 'editor-virtualized-gutter'
    caretLayerElement.className = 'editor-virtualized-caret-layer'
    caretElement.className = 'editor-virtualized-caret'
    caretElement.hidden = true
    caretLayerElement.appendChild(caretElement)
    if (gutterContributions.length > 0 || gutterWidthProvider) spacer.appendChild(gutterElement)
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
    disposeInlineWidgets(view)
    disposeGutterCells(view)
    this.scrollElement.remove()
    view.styleEl.remove()
    view.rowElements.clear()
    view.rowPool.length = 0
  }

  /** The offset the next text replacement should render at, so a restore costs one pass, not two. */
  public requestScrollTop(value: number): void {
    this.view.virtualizer.requestScrollTop(value)
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

  public setInjectedTextRows(injectedTextRows: readonly InjectedTextRow[]): void {
    const view = this.view
    setInjectedTextRowsLayout(view, injectedTextRows, horizontalViewportColumns(view))
    resetContentWidthScan(view)
    clearRowGeometryCaches(view)
    view.lastRenderedRowsKey = ''
    view.gutterWidthDirty = true
    updateVirtualizerRows(view)
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

  public revealCaret(offset: number, affinity: SelectionAffinity): void {
    const view = this.view
    ensureOffsetMounted(view, offset, affinity)
    scrollOffsetIntoView(view, offset, affinity)
  }

  public visualHorizontalTarget(
    offset: number,
    affinity: SelectionAffinity,
    direction: 'left' | 'right',
  ): VisualCaretTarget | null {
    return visualHorizontalTarget(this.view, offset, affinity, direction)
  }

  public caretXForOffset(offset: number, affinity: SelectionAffinity): number {
    return caretXForOffset(this.view, offset, affinity)
  }

  public verticalCaretTarget(
    offset: number,
    affinity: SelectionAffinity,
    rowDelta: number,
    goal: VerticalSelectionGoal,
  ): VisualCaretTarget {
    return verticalCaretTarget(this.view, offset, affinity, rowDelta, goal)
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
    return this.textPositionFromPoint(clientX, clientY)?.offset ?? null
  }

  public textOffsetFromViewportPoint(clientX: number, clientY: number): number | null {
    return this.textPositionFromViewportPoint(clientX, clientY)?.offset ?? null
  }

  public textPositionFromPoint(
    clientX: number,
    clientY: number,
  ): VirtualizedTextHitPosition | null {
    return this.textPositionFromViewportPoint(clientX, clientY)
  }

  public textPositionFromViewportPoint(
    clientX: number,
    clientY: number,
  ): VirtualizedTextHitPosition | null {
    const view = this.view
    const metrics = viewportPointMetrics(view, clientX, clientY)
    const row = rowForViewportY(view, metrics.y)
    if (metrics.verticalDirection < 0) {
      return textHitPosition(lineStartOffset(view, row), 'after', row, metrics.x)
    }
    if (metrics.verticalDirection > 0) {
      return textHitPosition(lineEndOffset(view, row), 'before', row, metrics.x)
    }
    if (!isDocumentTextDisplayRow(view.model.rows[row])) return null

    const mounted = view.rowElements.get(row)
    if (mounted?.kind === 'text' && rowMightContainRTL(view, mounted)) {
      return bidiTextHitPosition(view, mounted, metrics)
    }
    if (mounted?.kind === 'text') {
      const offset = xToOffset(view, mounted, metrics.x)
      return textHitPosition(offset, endpointAffinity(mounted, offset), row, metrics.x)
    }

    const column = Math.floor(metrics.x / Math.max(1, view.metrics.characterWidth))
    const offset = offsetForViewportColumn(view, row, column)
    const affinity = offset === lineEndOffset(view, row) ? 'before' : 'after'
    return textHitPosition(offset, affinity, row, metrics.x)
  }

  public createBidiSelectionAnchor(
    position: VirtualizedTextHitPosition,
  ): VirtualizedBidiSelectionAnchor | null {
    const view = this.view
    const row = view.rowElements.get(position.displayRow)
    if (row?.kind !== 'text') return null
    if (!rowMightContainRTL(view, row)) return null

    const positions = boundaryPositionXs(view, row, position.offset)
    if (positions.length !== 2) return null
    if (positions[1]! - positions[0]! <= 1) return null

    const alternate = alternateBoundaryOffset(view, row, position.offset, positions)
    if (alternate === null) return null

    const intervalStart = Math.min(position.offset, alternate)
    const intervalEnd = Math.max(position.offset, alternate)
    const direction = bidiTwinIntervalDirection(view, row, intervalStart, intervalEnd)
    if (!direction) return null

    const anchorAtLeft = closestPositionX(positions, position.rowX) === positions[0]
    const mappings = bidiTwinAnchorMappings(intervalStart, intervalEnd, direction, anchorAtLeft)
    return {
      displayRow: position.displayRow,
      displayProjectionRevision: view.displayProjectionRevision,
      textRevision: view.textRevision,
      rawOffset: position.offset,
      rawAffinity: position.affinity,
      intervalStart,
      intervalEnd,
      ...mappings,
    }
  }

  public resolveBidiSelectionAnchor(
    anchor: VirtualizedBidiSelectionAnchor,
    head: VirtualizedTextHitPosition,
  ): number {
    if (anchor.textRevision !== this.view.textRevision) return anchor.rawOffset
    if (anchor.displayProjectionRevision !== this.view.displayProjectionRevision) {
      return anchor.rawOffset
    }
    if (head.displayRow < anchor.displayRow) return anchor.rightOffset
    if (head.displayRow > anchor.displayRow) return anchor.leftOffset
    if (head.offset === anchor.rawOffset && head.affinity === anchor.rawAffinity) {
      return anchor.rawOffset
    }
    if (bidiHeadInsideTwinInterval(anchor, head)) return anchor.insideOffset
    return anchor.outsideOffset
  }

  public textOffsetFromDomBoundary(node: Node, offset: number): number | null {
    return textOffsetFromDomBoundary(this.view, node, offset)
  }

  public setSelection(
    anchorOffset: number,
    headOffset: number,
    affinity: SelectionAffinity = 'after',
  ): void {
    setSelection(this.view, anchorOffset, headOffset, affinity)
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
    updateGutterWidthIfNeeded(view)
    updateSpacerHeight(view, snapshot)
    updateSpacerWidth(view, snapshot.viewportWidth)
    const key = rowsKey(view, snapshot)
    if (key === view.lastRenderedRowsKey) {
      view.onViewportChange?.()
      return
    }

    view.lastRenderedRowsKey = key
    renderRows(view, snapshot, (rowSlotId) => deleteTokenRangesForRow(view, rowSlotId))
    this.applyKnownContentWidths(snapshot)
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

type ViewportPointMetrics = ReturnType<typeof viewportPointMetrics>

function textHitPosition(
  offset: number,
  affinity: SelectionAffinity,
  displayRow: number,
  rowX: number,
): VirtualizedTextHitPosition {
  return { offset, affinity, displayRow, rowX }
}

function textHitPositionAtRowX(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  rowX: number,
): VirtualizedTextHitPosition | null {
  if (rowMightContainRTL(view, row)) return bidiTextHitPositionAtRowX(view, row, rowX)

  const offset = closestTextOffsetAtRowX(view, row, rowX)
  return textHitPosition(offset, endpointAffinity(row, offset), row.index, rowX)
}

function closestTextOffsetAtRowX(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  rowX: number,
): number {
  const hit = xToOffset(view, row, rowX)
  const localHit = rowLocalIndexForOffset(row, hit)
  let closest = hit
  let distance = closestBoundaryDistance(view, row, hit, rowX)
  for (const local of candidateGraphemeOffsets(row.text, localHit)) {
    const candidate = rowOffsetForLocalIndex(row, local)
    const candidateDistance = closestBoundaryDistance(view, row, candidate, rowX)
    if (candidateDistance >= distance) continue

    closest = candidate
    distance = candidateDistance
  }
  return closest
}

function bidiTextHitPosition(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  point: ViewportPointMetrics,
): VirtualizedTextHitPosition | null {
  const offset = bidiOffsetFromViewportPoint(view, row, point)
  const rowX = rowLocalXFromClientPoint(row, point.clientX)
  return bidiTextHitPositionForOffset(view, row, offset, rowX)
}

function bidiTextHitPositionAtRowX(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  rowX: number,
): VirtualizedTextHitPosition | null {
  const offset = bidiOffsetFromRowX(view, row, rowX)
  return bidiTextHitPositionForOffset(view, row, offset, rowX)
}

function bidiTextHitPositionForOffset(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  offset: number | null,
  rowX: number,
): VirtualizedTextHitPosition | null {
  if (offset === null) return null

  const affinity = bidiPointAffinity(view, row, offset, rowX)
  return textHitPosition(offset, affinity, row.index, rowX)
}

function bidiPointAffinity(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  offset: number,
  rowX: number,
): SelectionAffinity {
  const positions = boundaryPositionXs(view, row, offset)
  const boundaryX = closestPositionX(positions, rowX)
  return boundaryAffinityForX(view, row, offset, boundaryX, positions)
}

function endpointAffinity(row: MountedVirtualizedTextRow, offset: number): SelectionAffinity {
  return offset >= row.endOffset ? 'before' : 'after'
}

function closestPositionX(positions: readonly number[], target: number): number {
  let closest = positions[0] ?? target
  let distance = Math.abs(closest - target)
  for (const position of positions.slice(1)) {
    const candidateDistance = Math.abs(position - target)
    if (candidateDistance >= distance) continue

    closest = position
    distance = candidateDistance
  }
  return closest
}

function alternateBoundaryOffset(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  offset: number,
  positions: readonly number[],
): number | null {
  for (const position of positions) {
    const candidate = hitTestRowOffsetAtLocalX(row, position)
    if (candidate === null || candidate === offset) continue
    if (!boundarySharesPositions(view, row, candidate, positions)) continue
    return candidate
  }
  return null
}

function boundarySharesPositions(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  offset: number,
  expected: readonly number[],
): boolean {
  const actual = boundaryPositionXs(view, row, offset)
  if (actual.length !== expected.length) return false
  return expected.every((position) =>
    actual.some((candidate) => Math.abs(candidate - position) <= 1),
  )
}

type BidiTwinIntervalDirection = 'ltr' | 'rtl'

function bidiTwinIntervalDirection(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  intervalStart: number,
  intervalEnd: number,
): BidiTwinIntervalDirection | null {
  const next = nextRowUnitOffset(row, intervalStart)
  if (next <= intervalStart || next > intervalEnd) return null

  const rect = unitRectForOffset(view, row, intervalStart)
  if (!rect || rect.width <= 1) return null

  const left = hitTestRowOffsetAtLocalX(row, rect.left + rect.width * 0.25)
  const right = hitTestRowOffsetAtLocalX(row, rect.left + rect.width * 0.75)
  const leftAtStart = hitRepresentsBoundary(view, row, left, intervalStart)
  const leftAtNext = hitRepresentsBoundary(view, row, left, next)
  const rightAtStart = hitRepresentsBoundary(view, row, right, intervalStart)
  const rightAtNext = hitRepresentsBoundary(view, row, right, next)
  if (leftAtStart && rightAtNext) return 'ltr'
  if (leftAtNext && rightAtStart) return 'rtl'
  return null
}

function hitRepresentsBoundary(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  hit: number | null,
  expected: number,
): boolean {
  if (hit === expected) return true
  if (hit === null) return false
  return boundarySharesPositions(view, row, hit, boundaryPositionXs(view, row, expected))
}

function nextRowUnitOffset(row: MountedVirtualizedTextRow, offset: number): number {
  const local = rowLocalIndexForOffset(row, offset, 'after')
  const next = nextGraphemeBoundary(row.text, local)
  return rowOffsetForLocalIndex(row, next, 'after')
}

function bidiTwinAnchorMappings(
  intervalStart: number,
  intervalEnd: number,
  direction: BidiTwinIntervalDirection,
  anchorAtLeft: boolean,
): Pick<
  VirtualizedBidiSelectionAnchor,
  'insideOffset' | 'outsideOffset' | 'leftOffset' | 'rightOffset'
> {
  if (direction === 'ltr') {
    return anchorAtLeft
      ? {
          insideOffset: intervalStart,
          outsideOffset: intervalEnd,
          leftOffset: intervalEnd,
          rightOffset: intervalStart,
        }
      : {
          insideOffset: intervalEnd,
          outsideOffset: intervalStart,
          leftOffset: intervalEnd,
          rightOffset: intervalStart,
        }
  }

  return anchorAtLeft
    ? {
        insideOffset: intervalEnd,
        outsideOffset: intervalStart,
        leftOffset: intervalStart,
        rightOffset: intervalEnd,
      }
    : {
        insideOffset: intervalStart,
        outsideOffset: intervalEnd,
        leftOffset: intervalStart,
        rightOffset: intervalEnd,
      }
}

function bidiHeadInsideTwinInterval(
  anchor: VirtualizedBidiSelectionAnchor,
  head: VirtualizedTextHitPosition,
): boolean {
  if (head.offset > anchor.intervalStart && head.offset < anchor.intervalEnd) return true
  if (head.offset === anchor.intervalStart) return head.affinity === 'after'
  if (head.offset === anchor.intervalEnd) return head.affinity === 'before'
  return false
}

function bidiOffsetFromViewportPoint(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  point: ViewportPointMetrics,
): number | null {
  const offset = hitTestRowOffset(row, point.clientX, point.clientY)
  const localX = rowLocalXFromClientPoint(row, point.clientX)
  return bidiOffsetAtRowX(view, row, localX, offset)
}

function bidiOffsetFromRowX(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  rowX: number,
): number | null {
  const offset = hitTestRowOffsetAtLocalX(row, rowX)
  return bidiOffsetAtRowX(view, row, rowX, offset)
}

function bidiOffsetAtRowX(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  rowX: number,
  offset: number | null,
): number | null {
  const advance = rowCharacterAdvance(view, row)
  const edgeOffset = bidiEdgeOffset(view, row, rowX, advance)
  if (edgeOffset !== null) return edgeOffset
  if (offset !== null) return offset

  const interpolated = interpolatedBidiOffset(view, row, rowX, advance)
  return interpolated ?? xToOffset(view, row, rowX)
}

function bidiEdgeOffset(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  x: number,
  advance: number,
): number | null {
  const extent = rowTextExtent(view, row)
  const halfAdvance = advance / 2
  if (x > extent.left + halfAdvance && x < extent.right - halfAdvance) return null

  const extremal = bidiExtremalBoundaries(view, row, advance)
  if (x <= extent.left + halfAdvance) return extremal.left
  return extremal.right
}

function bidiExtremalBoundaries(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  advance: number,
): { readonly left: number; readonly right: number } {
  const cached = bidiExtremalBoundaryCaches.get(row.element)
  if (cached && row.geometryCache !== null && cached.geometry === row.geometryCache) return cached

  const extent = rowTextExtent(view, row)
  const left = resolveExtremalBoundary(view, row, extent.left, extent.left + advance * 0.75)
  const right = resolveExtremalBoundary(view, row, extent.right, extent.right - advance * 0.75)
  const geometry = row.geometryCache
  if (geometry !== null) bidiExtremalBoundaryCaches.set(row.element, { geometry, left, right })
  return { left, right }
}

function resolveExtremalBoundary(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  edge: number,
  sampleX: number,
): number {
  const offset = hitTestRowOffsetAtLocalX(row, sampleX)
  if (offset === null) return closestRowEndpointToX(view, row, edge)

  const candidates = [offset, offset - 1, offset + 1]
  for (const candidate of candidates) {
    if (candidate < row.startOffset || candidate > row.endOffset) continue
    const positions = boundaryPositionXs(view, row, candidate)
    if (positions.some((x) => Math.abs(x - edge) <= 1)) return candidate
  }
  return offset
}

function closestRowEndpointToX(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  x: number,
): number {
  const startDistance = closestBoundaryDistance(view, row, row.startOffset, x)
  const endDistance = closestBoundaryDistance(view, row, row.endOffset, x)
  return startDistance <= endDistance ? row.startOffset : row.endOffset
}

function closestBoundaryDistance(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  offset: number,
  x: number,
): number {
  const positions = boundaryPositionXs(view, row, offset)
  return Math.min(...positions.map((position) => Math.abs(position - x)))
}

function hitTestRowOffsetAtLocalX(row: MountedVirtualizedTextRow, localX: number): number | null {
  const rect = row.element.getBoundingClientRect()
  const scale = row.element.offsetWidth > 0 ? rect.width / row.element.offsetWidth : 1
  return hitTestRowOffset(row, rect.left + localX * scale, rect.top + rect.height / 2)
}

function hitTestRowOffset(
  row: MountedVirtualizedTextRow,
  clientX: number,
  clientY: number,
): number | null {
  const documentWithCaret = row.element.ownerDocument as DocumentWithCaretHitTesting
  const hit = hitTestBoundaryFromPoint(documentWithCaret, clientX, clientY)
  if (!hit) return null

  const offset = rowOffsetFromCaretHit(row, hit)
  if (offset !== null) return offset
  return hitTestBelowAuxiliaryElement(row, hit.node, clientX, clientY)
}

function hitTestBelowAuxiliaryElement(
  row: MountedVirtualizedTextRow,
  node: Node,
  clientX: number,
  clientY: number,
): number | null {
  const first = auxiliaryCaretHitElement(node)
  if (!first) return null

  const hidden = [hideCaretHitElement(first)]
  try {
    return hitTestWithAuxiliaryElementsHidden(row, clientX, clientY, hidden)
  } finally {
    for (const entry of hidden) restoreCaretHitElement(entry)
  }
}

function hitTestWithAuxiliaryElementsHidden(
  row: MountedVirtualizedTextRow,
  clientX: number,
  clientY: number,
  hidden: HiddenCaretHitElement[],
): number | null {
  const documentWithCaret = row.element.ownerDocument as DocumentWithCaretHitTesting
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const hit = hitTestBoundaryFromPoint(documentWithCaret, clientX, clientY)
    if (!hit) return null

    const offset = rowOffsetFromCaretHit(row, hit)
    if (offset !== null) return offset

    const auxiliary = auxiliaryCaretHitElement(hit.node)
    if (!auxiliary || hidden.some((entry) => entry.element === auxiliary)) return null
    hidden.push(hideCaretHitElement(auxiliary))
  }
  return null
}

function interpolatedBidiOffset(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  x: number,
  advance: number,
): number | null {
  const extent = rowTextExtent(view, row)
  const width = extent.right - extent.left
  if (width <= 0 || row.text.length === 0) return null

  const startOnLeft = rowStartsOnVisualLeft(view, row, extent.left)
  const visualFraction = Math.max(0, Math.min(1, (x - extent.left) / width))
  const logicalFraction = startOnLeft ? visualFraction : 1 - visualFraction
  const localGuess = Math.round(logicalFraction * row.text.length)
  let closest: number | null = null
  let closestDistance = Number.POSITIVE_INFINITY
  for (const local of candidateGraphemeOffsets(row.text, localGuess)) {
    const candidate = fallbackBidiOffsetForLocalIndex(row, local)
    const distance = closestBoundaryDistance(view, row, candidate, x)
    if (distance >= closestDistance) continue

    closest = candidate
    closestDistance = distance
  }
  return closestDistance <= advance ? closest : null
}

function fallbackBidiOffsetForLocalIndex(
  row: MountedVirtualizedTextRow,
  localIndex: number,
): number {
  const local = clampNumber(localIndex, 0, row.text.length)
  const mapped = rowOffsetForLocalIndex(row, local, 'nearest')
  return clampNumber(mapped, row.startOffset, row.endOffset)
}

function rowStartsOnVisualLeft(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  left: number,
): boolean {
  const cached = bidiVisualOrientationCaches.get(row.element)
  if (cached && row.geometryCache !== null && cached.geometry === row.geometryCache) {
    return cached.startOnLeft
  }

  const startOnLeft =
    closestBoundaryDistance(view, row, row.startOffset, left) <=
    closestBoundaryDistance(view, row, row.endOffset, left)
  const geometry = row.geometryCache
  if (geometry !== null) bidiVisualOrientationCaches.set(row.element, { geometry, startOnLeft })
  return startOnLeft
}

function candidateGraphemeOffsets(text: string, localGuess: number): ReadonlySet<number> {
  const offsets = new Set<number>()
  const local = Math.max(0, Math.min(text.length, localGuess))
  const previous = previousGraphemeBoundary(text, local)
  offsets.add(previous)
  const current = nextGraphemeBoundary(text, previous)
  offsets.add(current)
  if (current !== local) return offsets

  offsets.add(nextGraphemeBoundary(text, local))
  return offsets
}

function rowOffsetFromCaretHit(
  row: MountedVirtualizedTextRow,
  hit: { readonly node: Node; readonly offset: number },
): number | null {
  if (!row.element.contains(hit.node)) return null
  return offsetFromDomBoundary(row, hit.node, hit.offset)
}

function auxiliaryCaretHitElement(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest<HTMLElement>(AUXILIARY_CARET_HIT_SELECTOR) ?? null
}

function hideCaretHitElement(element: HTMLElement): HiddenCaretHitElement {
  const visibility = element.style.visibility
  element.style.visibility = 'hidden'
  return { element, visibility }
}

function restoreCaretHitElement(entry: HiddenCaretHitElement): void {
  entry.element.style.visibility = entry.visibility
}

function rowCharacterAdvance(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): number {
  const rect = row.element.getBoundingClientRect()
  const scale = row.element.offsetWidth > 0 ? rect.width / row.element.offsetWidth : 1
  if (!Number.isFinite(scale) || scale <= 0) return Math.max(1, view.metrics.characterWidth)
  return Math.max(1, view.metrics.characterWidth / scale)
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

function caretXForOffset(
  view: VirtualizedTextViewInternal,
  offset: number,
  affinity: SelectionAffinity,
): number {
  const rowIndex = rowForCaretPosition(view, offset, affinity)
  const row = view.rowElements.get(rowIndex)
  const measured = row?.source === 'document' ? mountedCaretX(view, row, offset, affinity) : null
  if (measured !== null) return measured

  const column = visualColumnForOffset(view, offset, affinity)
  return column * Math.max(1, view.metrics.characterWidth)
}

function mountedCaretX(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  offset: number,
  affinity: SelectionAffinity,
): number | null {
  if (!rowSupportsVerticalGeometry(view, row)) return null
  return boundaryPositionXsForAffinity(view, row, offset, affinity)[0] ?? null
}

function verticalCaretTarget(
  view: VirtualizedTextViewInternal,
  offset: number,
  affinity: SelectionAffinity,
  rowDelta: number,
  goal: VerticalSelectionGoal,
): VisualCaretTarget {
  const sourceRow = rowForCaretPosition(view, offset, affinity)
  const targetRowIndex = documentTextRowByDisplayDelta(view, sourceRow, rowDelta)
  if (targetRowIndex === sourceRow) return { offset, affinity }
  if (goal.kind === 'lineEnd') {
    return { offset: lineEndOffset(view, targetRowIndex), affinity: 'before' }
  }

  const row = view.rowElements.get(targetRowIndex)
  if (row?.source === 'document' && rowSupportsVerticalGeometry(view, row)) {
    const measured = textHitPositionAtRowX(view, row, goal.x)
    if (measured) return { offset: measured.offset, affinity: measured.affinity }
  }

  return fallbackVerticalCaretTarget(view, targetRowIndex, goal.x)
}

function rowSupportsVerticalGeometry(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): boolean {
  if (!rowMightContainRTL(view, row)) return true
  return !isBidiMeasurementRefusalRow(view, row)
}

function fallbackVerticalCaretTarget(
  view: VirtualizedTextViewInternal,
  row: number,
  x: number,
): VisualCaretTarget {
  const column = x / Math.max(1, view.metrics.characterWidth)
  const offset = offsetForViewportColumn(view, row, column)
  const affinity = offset >= lineEndOffset(view, row) ? 'before' : 'after'
  return { offset, affinity }
}

function visualHorizontalTarget(
  view: VirtualizedTextViewInternal,
  offset: number,
  affinity: SelectionAffinity,
  direction: 'left' | 'right',
): VisualCaretTarget | null {
  const rowIndex = rowForCaretPosition(view, offset, affinity)
  const row = view.rowElements.get(rowIndex)
  if (!row || row.source !== 'document') return null

  const move = visualCaretMoveInRow(view, row, offset, affinity, direction)
  if (!move) return null
  if (!('kind' in move)) return move

  return visualTargetAcrossDisplayRows(view, rowIndex, { offset, affinity }, direction)
}

function visualTargetAcrossDisplayRows(
  view: VirtualizedTextViewInternal,
  sourceRow: number,
  origin: VisualCaretTarget,
  direction: 'left' | 'right',
): VisualCaretTarget | null {
  const rowDelta = direction === 'left' ? -1 : 1
  const targetRowIndex = documentTextRowByDisplayDelta(view, sourceRow, rowDelta)
  if (targetRowIndex === sourceRow) return origin

  const targetRow = view.rowElements.get(targetRowIndex)
  if (!targetRow || targetRow.source !== 'document') return null

  const edge = direction === 'left' ? 'right' : 'left'
  const edgeTarget = visualCaretAtRowEdge(view, targetRow, edge)
  if (!edgeTarget) return null
  if (!displayRowsShareBoundary(view, sourceRow, targetRowIndex, direction)) return edgeTarget

  const move = visualCaretMoveInRow(
    view,
    targetRow,
    edgeTarget.offset,
    edgeTarget.affinity,
    direction,
  )
  if (!move) return null
  return 'kind' in move ? edgeTarget : move
}

function displayRowsShareBoundary(
  view: VirtualizedTextViewInternal,
  sourceRow: number,
  targetRow: number,
  direction: 'left' | 'right',
): boolean {
  if (direction === 'right') {
    return lineEndOffset(view, sourceRow) === lineStartOffset(view, targetRow)
  }
  return lineStartOffset(view, sourceRow) === lineEndOffset(view, targetRow)
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
    if (row <= patch.startRow) {
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
