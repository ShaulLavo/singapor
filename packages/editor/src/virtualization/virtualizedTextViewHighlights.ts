import type { EditorToken, EditorTokenStyle } from '../tokens'
import {
  editorPerformanceDiagnosticsEnabled,
  recordEditorPerformanceDiagnostic,
} from '../editor/performanceDiagnostics'
import {
  copyTokenProjectionMetadata,
  sourceTokensForProjectedTokens,
  tokenProjectionLiveRangeStatus,
} from '../editor/tokenProjection'
import { getEditorTokenIndex, type EditorTokenIndex } from '../editor/tokenIndex'
import { clamp, normalizeTokenStyle, serializeTokenStyle } from '../style-utils'
import { lowerBound, upperBound } from './rowHeightIndex'
import { getSharedTokenHighlights } from './sharedTokenHighlights'
import { rowLocalIndexForOffset } from './virtualizedTextViewInlineMapping'
import { reregisterHighlights, scheduleHighlightRepaintNudge } from './geckoHighlightRepaint'
import {
  addTokenRangeToChunk,
  appendTokenRange,
  appendTokenSegmentForChunk,
  editorTokensEqual,
  getOrCreateTokenSegments,
  setElementHidden,
  setStyleValue,
  type TokenSegmentAppendResult,
  tokenRowSignature,
  tokenStylesEqual,
} from './virtualizedTextViewHelpers'
import {
  caretPosition,
  cursorLineBufferRow,
  cursorLineVirtualRow,
  getMountedRows,
  refreshCursorLineRows,
} from './virtualizedTextViewRows'
import { renderHiddenCharacters } from './virtualizedTextViewHiddenCharacters'
import { clearSelectionLayer, renderSelectionLayer } from './virtualizedTextViewSelectionLayer'
import { createDomRangeForChunkRange } from './virtualizedTextViewGeometry'
import type {
  MountedVirtualizedTextRow,
  TokenGroup,
  TokenRowSegment,
  HighlightRegistry,
  VirtualizedTextChunk,
} from './virtualizedTextViewTypes'
import type {
  SameLineTokenEdit,
  TokenRenderEntry,
  VirtualizedTextHighlightGroup,
  VirtualizedTextHighlightRange,
  VirtualizedTextHighlightStyle,
  VirtualizedStoredSelection,
  VirtualizedTextSelection,
  VirtualizedTextViewInternal,
} from './virtualizedTextViewInternals'

type TokenStyleSource = {
  readonly entriesByIndex: ReadonlyMap<number, TokenRenderEntry> | null
  readonly tokens: readonly EditorToken[]
}

type TokenSegmentBuildStats = {
  addedSegmentCount: number
  adjacentMergedSegmentCount: number
  chunkCount: number
  gapMergedSegmentCount: number
  mergedSegmentCount: number
  rawSegmentCount: number
  readonly rowCount: number
  tokenScanCount: number
}

type TokenRangeAddResult = {
  readonly addedRangeCount: number
  readonly liveRangeCount: number
  readonly staticRangeCount: number
  readonly styleRulesDirty: boolean
}

type TokenRangeReconcileStats = {
  addedRangeCount: number
  deletedRangeCount: number
  liveRangeCount: number
  readonly mountedRowCount: number
  rebuiltRowCount: number
  skippedRowCount: number
  staticRangeCount: number
  readonly tokenRenderIndexDirty: boolean
}

type RangeHighlightIndex = {
  readonly fingerprint: number
  /**
   * Running maximum of `end`. A range nested inside an earlier one leaves the raw ends out of
   * order even where the starts are sorted, and a bisection needs a key that only ever grows.
   */
  readonly maxEnds: readonly number[]
}

const SIGNATURE_HASH_PRIME = 0x01000193
const SIGNATURE_HASH_SEED = 0x811c9dc5

/**
 * Keyed by the range array rather than by the group, because a group holds one such array for as
 * long as the set it was given stays current — so identity is already the invalidation rule, and a
 * retired set takes its index with it.
 */
const rangeHighlightIndexes = new WeakMap<
  readonly VirtualizedTextHighlightRange[],
  RangeHighlightIndex
>()

export function setTokens(view: VirtualizedTextViewInternal, tokens: readonly EditorToken[]): void {
  const copiedTokens = [...tokens]
  copyTokenProjectionMetadata(tokens, copiedTokens)
  adoptTokens(view, copiedTokens)
}

export function adoptTokens(
  view: VirtualizedTextViewInternal,
  tokens: readonly EditorToken[],
): void {
  const projectionStatus = tokenProjectionLiveRangeStatus(view.tokens, tokens)
  if (projectionStatus === true && !view.sameLineTokenEdit) {
    view.tokens = tokens
    view.tokenRenderIndexDirty = true
    if (view.rowTokenRanges.size === 0 && tokens.length > 0) renderTokenHighlights(view)
    return
  }

  if (canKeepLiveTokenRanges(view, tokens, projectionStatus)) {
    const styleSource =
      projectionStatus === true ? tokenStyleSourceForProjection(view, tokens) : null
    view.tokens = tokens
    view.tokenRenderIndexDirty = true
    reconcileTokenHighlightsAfterSameLineEdit(view, styleSource)
    return
  }

  if (view.tokens === tokens) {
    if (view.rowTokenRanges.size === 0 && tokens.length > 0) renderTokenHighlights(view)
    return
  }

  if (projectionStatus !== null) {
    adoptChangedTokens(view, tokens)
    return
  }

  view.tokenProjectionDirtyStartRow = null
  if (editorTokensEqual(view.tokens, tokens)) {
    view.sameLineTokenEdit = null
    view.tokens = tokens
    renderTokenHighlights(view)
    return
  }

  adoptChangedTokens(view, tokens)
}

function adoptChangedTokens(
  view: VirtualizedTextViewInternal,
  tokens: readonly EditorToken[],
): void {
  const pendingEdit = takeSameLineTokenEdit(view)
  const dirtyStartRow = view.tokenProjectionDirtyStartRow
  view.tokens = tokens
  view.tokenRenderIndexDirty = true
  if (pendingEdit) {
    reconcileTokenHighlightsFromRow(
      view,
      dirtyTokenProjectionStartRow(dirtyStartRow, pendingEdit.rowIndex),
      dirtyStartRow !== null,
    )
    return
  }

  view.tokenProjectionDirtyStartRow = null
  renderTokenHighlights(view)
}

function tokenStyleSourceForProjection(
  view: VirtualizedTextViewInternal,
  tokens: readonly EditorToken[],
): TokenStyleSource | null {
  const sourceTokens = sourceTokensForProjectedTokens(tokens)
  if (!sourceTokens) return null

  return {
    entriesByIndex: tokenRenderEntriesBySourceIndex(view.tokenRenderEntries),
    tokens: sourceTokens,
  }
}

function tokenRenderEntriesBySourceIndex(
  entries: readonly TokenRenderEntry[],
): ReadonlyMap<number, TokenRenderEntry> | null {
  if (entries.length === 0) return null

  const byIndex = new Map<number, TokenRenderEntry>()
  for (const entry of entries) byIndex.set(entry.sourceIndex, entry)
  return byIndex
}

export function setSelection(
  view: VirtualizedTextViewInternal,
  anchorOffset: number,
  headOffset: number,
): void {
  setSelections(view, [{ anchorOffset, headOffset }])
}

export function setSelections(
  view: VirtualizedTextViewInternal,
  selections: readonly VirtualizedTextSelection[],
): void {
  const previousCursorLine = cursorLineBufferRow(view)
  const previousCursorRow = cursorLineVirtualRow(view)
  const stored = selections.map((selection) => clampSelection(view, selection))
  view.selections = stored
  setPrimarySelection(view, stored[0] ?? null)
  renderSelectionHighlight(view)
  renderHiddenCharacters(view)
  refreshCursorLineRows(view, previousCursorLine, previousCursorRow)
}

export function clearSelection(view: VirtualizedTextViewInternal): void {
  const previousCursorLine = cursorLineBufferRow(view)
  const previousCursorRow = cursorLineVirtualRow(view)
  view.selectionStart = null
  view.selectionEnd = null
  view.selectionHead = null
  view.selections = []
  clearSelectionHighlight(view)
  renderHiddenCharacters(view)
  renderCaret(view)
  refreshCursorLineRows(view, previousCursorLine, previousCursorRow)
}

export function renderSelectionHighlight(view: VirtualizedTextViewInternal): void {
  renderCaret(view)
  if (!hasSelectionRanges(view.selections)) {
    clearSelectionHighlight(view)
    return
  }
  renderSelectionLayer(view)
}

export function clearSelectionHighlight(view: VirtualizedTextViewInternal): void {
  clearSelectionLayer(view)
  view.lastSelectionHighlightSignature = ''
  if (!view.selectionHighlightRegistered || !view.highlightRegistry) return

  view.highlightRegistry.delete(view.selectionHighlightName)
  view.selectionHighlightRegistered = false
}

export function setRangeHighlight(
  view: VirtualizedTextViewInternal,
  name: string,
  ranges: readonly VirtualizedTextHighlightRange[],
  style: VirtualizedTextHighlightStyle,
): void {
  if (ranges.length === 0) {
    clearRangeHighlight(view, name)
    return
  }

  const nextRanges = sortedRangeHighlights(view, ranges)
  const group = getOrCreateRangeHighlightGroup(view, name, style)
  // Equal-priority highlights paint in registry order, which we cannot keep stable across mount
  // cycles, so the declared stacking is mirrored onto the Highlight itself.
  group.highlight.priority = style.zIndex ?? 0
  if (canSkipRangeHighlightUpdate(view, group, nextRanges, style)) return

  group.ranges = nextRanges
  group.style = style
  group.signature = staleRangeHighlightSignature()
  renderRangeHighlight(view, name)
  rebuildStyleRules(view)
}

export function renderRangeHighlight(view: VirtualizedTextViewInternal, name: string): void {
  const group = view.rangeHighlightGroups.get(name)
  if (!group || !view.highlightRegistry) return

  const signature = rangeHighlightSignature(view, group)
  if (signature === group.signature) return

  group.signature = signature
  group.highlight.clear()
  addMountedRangeHighlightRanges(view, group)
  // Find/diagnostic range highlights swap StaticRanges over recycled rows the
  // same way token highlights do, so they need the same Gecko repaint nudge.
  scheduleHighlightRepaintNudge(view.highlightRegistry)
  // A group whose ranges have all scrolled out stays registered with an empty Highlight. Dropping
  // it and re-registering on the way back would move it to the end of the registry, which is
  // where paint order comes from once priorities tie.
  ensureRangeHighlightRegistered(view, group)
}

export function clearRangeHighlight(view: VirtualizedTextViewInternal, name: string): void {
  const group = view.rangeHighlightGroups.get(name)
  if (!group) return

  group.highlight.clear()
  unregisterRangeHighlight(view, group)
  view.rangeHighlightGroups.delete(name)
  rebuildStyleRules(view)
  scheduleHighlightRepaintNudge(view.highlightRegistry)
}

function renderCaret(view: VirtualizedTextViewInternal): void {
  const selections = view.selections
  ensureCaretElementCount(view, selections.length)

  if (selections.length === 0) {
    hideCaretElement(view.caretElement)
    hideSecondaryCaretElements(view, 0)
    return
  }

  renderCaretElement(view, view.caretElement, selections[0]!)
  renderSecondaryCaretElements(view, selections)
}

function renderSecondaryCaretElements(
  view: VirtualizedTextViewInternal,
  selections: readonly VirtualizedStoredSelection[],
): void {
  for (let index = 1; index < selections.length; index += 1) {
    renderCaretElement(view, view.secondaryCaretElements[index - 1]!, selections[index]!)
  }

  hideSecondaryCaretElements(view, Math.max(0, selections.length - 1))
}

function renderCaretElement(
  view: VirtualizedTextViewInternal,
  element: HTMLElement,
  selection: VirtualizedStoredSelection,
): void {
  const position = caretPosition(view, selection.head)
  if (!position) {
    hideCaretElement(element)
    return
  }

  setElementHidden(element, false)
  setStyleValue(element, 'height', `${position.height}px`)
  setStyleValue(element, 'transform', `translate(${position.left}px, ${position.top}px)`)
}

export function clampStoredSelection(view: VirtualizedTextViewInternal): void {
  if (view.selections.length === 0) return

  view.selections = view.selections.map((selection) => clampStoredSelectionRange(view, selection))
  setPrimarySelection(view, view.selections[0] ?? null)
}

export function renderTokenHighlights(view: VirtualizedTextViewInternal): void {
  const pendingEdit = view.sameLineTokenEdit
  if (!view.highlightRegistry || view.tokens.length === 0 || view.model.textLength === 0) {
    clearTokenHighlights(view)
    return
  }

  if (pendingEdit) return

  // TODO: Smooth first syntax paint without forcing CSS Highlight API color animation.
  // Highlight pseudo styles do not reliably animate color, so this likely needs a
  // separate transition/overlay strategy that preserves the current range model.
  const mountedRows = getMountedRows(view)
  const reconcileStats = createTokenRangeReconcileStats(view, mountedRows)
  const reconcileStartedAt = reconcileStats ? performanceNow() : 0
  const segmentsByRow = tokenSegmentsForRows(view, mountedRows)
  let styleRulesDirty = false
  for (const row of mountedRows) {
    styleRulesDirty =
      reconcileTokenHighlightsForRow(
        view,
        row,
        segmentsByRow.get(row.tokenHighlightSlotId) ?? [],
        shouldForceTokenRowRebuild(row, null),
        reconcileStats,
      ) || styleRulesDirty
  }
  recordTokenRangeReconcileStats(reconcileStats, reconcileStartedAt)
  if (styleRulesDirty) rebuildStyleRules(view)
}

function reconcileTokenHighlightsForRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  segments: readonly TokenRowSegment[],
  force = false,
  stats: TokenRangeReconcileStats | null = null,
): boolean {
  const signature = tokenRowSignature(row, segments)
  const previousSignature = view.rowTokenSignatures.get(row.tokenHighlightSlotId)
  if (!force && previousSignature === signature) {
    if (stats) stats.skippedRowCount += 1
    return false
  }

  const deletedRangeCount = deleteTokenRangesForRow(view, row.tokenHighlightSlotId)
  if (stats) {
    stats.rebuiltRowCount += 1
    stats.deletedRangeCount += deletedRangeCount
  }

  const result = addTokenSegmentsForRow(view, row, segments)
  if (stats) {
    stats.addedRangeCount += result.addedRangeCount
    stats.liveRangeCount += result.liveRangeCount
    stats.staticRangeCount += result.staticRangeCount
  }
  view.rowTokenSignatures.set(row.tokenHighlightSlotId, signature)
  scheduleHighlightRepaintNudge(view.highlightRegistry)
  return result.styleRulesDirty
}

function reconcileTokenHighlightsAfterSameLineEdit(
  view: VirtualizedTextViewInternal,
  styleSource: TokenStyleSource | null = null,
): void {
  const edit = takeSameLineTokenEdit(view)
  if (!edit) return

  reconcileTokenHighlightsAfterEdit(view, edit, styleSource)
}

function reconcileTokenHighlightsAfterEdit(
  view: VirtualizedTextViewInternal,
  edit: SameLineTokenEdit,
  styleSource: TokenStyleSource | null = null,
): void {
  if (edit.kind === 'multi-line') {
    reconcileTokenHighlightsFromRow(view, edit.rowIndex)
    view.tokenProjectionDirtyStartRow = null
    return
  }

  if (view.tokenProjectionDirtyStartRow !== null) {
    reconcileSameLineTokenRows(view, edit, styleSource)
    return
  }

  reconcileSameLineTokenRows(view, edit, styleSource)
}

function reconcileSameLineTokenRows(
  view: VirtualizedTextViewInternal,
  edit: SameLineTokenEdit,
  styleSource: TokenStyleSource | null,
): void {
  const rows = rowsNeedingSameLineProjectionReconcile(view, edit)
  if (rows.length === 0) return

  const segmentsByRow = tokenSegmentsForRows(view, rows, styleSource)
  let styleRulesDirty = false
  for (const row of rows) {
    styleRulesDirty =
      reconcileTokenHighlightsForRow(
        view,
        row,
        segmentsByRow.get(row.tokenHighlightSlotId) ?? [],
        true,
      ) || styleRulesDirty
  }
  if (styleRulesDirty) rebuildStyleRules(view)
}

function reconcileTokenHighlightsFromRow(
  view: VirtualizedTextViewInternal,
  startRow: number,
  force = false,
): void {
  const rows = getMountedRows(view).filter((row) => row.index >= startRow)
  if (rows.length === 0) return

  const segmentsByRow = tokenSegmentsForRows(view, rows)
  let styleRulesDirty = false
  for (const row of rows) {
    styleRulesDirty =
      reconcileTokenHighlightsForRow(
        view,
        row,
        segmentsByRow.get(row.tokenHighlightSlotId) ?? [],
        force,
      ) || styleRulesDirty
  }
  if (styleRulesDirty) rebuildStyleRules(view)
}

function takeSameLineTokenEdit(view: VirtualizedTextViewInternal): SameLineTokenEdit | null {
  const edit = view.sameLineTokenEdit
  view.sameLineTokenEdit = null
  return edit
}

function dirtyTokenProjectionStartRow(current: number | null, row: number): number {
  if (current === null) return row
  return Math.min(current, row)
}

function rowsNeedingSameLineProjectionReconcile(
  view: VirtualizedTextViewInternal,
  edit: SameLineTokenEdit,
): readonly MountedVirtualizedTextRow[] {
  const rows = getMountedRows(view)
  const needed: MountedVirtualizedTextRow[] = []
  const seen = new Set<number>()

  const editedRow = rows.find((row) => row.index === edit.rowIndex)
  if (editedRow) {
    needed.push(editedRow)
    seen.add(editedRow.tokenHighlightSlotId)
  }

  for (const row of rows) {
    if (seen.has(row.tokenHighlightSlotId)) continue
    if (view.rowTokenSignatures.has(row.tokenHighlightSlotId)) continue

    needed.push(row)
    seen.add(row.tokenHighlightSlotId)
  }

  return needed
}

function shouldForceTokenRowRebuild(
  row: MountedVirtualizedTextRow,
  edit: SameLineTokenEdit | null,
): boolean {
  if (!edit) return false
  if (edit.kind === 'multi-line') return row.index >= edit.rowIndex
  if (edit.editedRowPatchedInPlace) return false
  return row.index === edit.rowIndex
}

export function clearTokenHighlightsFromRow(
  view: VirtualizedTextViewInternal,
  startRow: number,
): void {
  for (const row of getMountedRows(view)) {
    if (row.index < startRow) continue

    deleteTokenRangesForRow(view, row.tokenHighlightSlotId)
    view.rowTokenSignatures.delete(row.tokenHighlightSlotId)
  }
  scheduleHighlightRepaintNudge(view.highlightRegistry)
}

export function restoreHighlightsAfterBrowserResume(view: VirtualizedTextViewInternal): void {
  const registry = view.highlightRegistry
  if (!registry) return
  if (!view.scrollElement.isConnected) return

  const restoredTokenHighlights = restoreTokenHighlightGroups(view, registry)
  const restoredRangeHighlights = restoreRangeHighlightGroups(view, registry)
  restoreStyleRuleElements(view)
  if (!restoredTokenHighlights && !restoredRangeHighlights) return

  reregisterHighlights(registry)
}

function restoreTokenHighlightGroups(
  view: VirtualizedTextViewInternal,
  registry: HighlightRegistry,
): boolean {
  let restored = false
  for (const group of view.tokenGroups.values()) {
    registry.set(group.name, group.highlight)
    restored = true
  }

  return restored
}

function restoreRangeHighlightGroups(
  view: VirtualizedTextViewInternal,
  registry: HighlightRegistry,
): boolean {
  let restored = false
  for (const group of view.rangeHighlightGroups.values()) {
    if (!group.registered) continue

    registry.set(group.name, group.highlight)
    restored = true
  }

  return restored
}

function restoreStyleRuleElements(view: VirtualizedTextViewInternal): void {
  getSharedTokenHighlights(view.scrollElement.ownerDocument, view.highlightRegistry)?.restore()
  syncStyleElementConnection(view, view.styleEl.textContent ?? '')
}

function ensureTokenRenderIndex(view: VirtualizedTextViewInternal): void {
  if (!view.tokenRenderIndexDirty) return

  rebuildTokenRenderIndex(view)
  syncTokenGroupsToStyles(view, view.tokenRenderStyles)
  view.tokenRenderIndexDirty = false
}

function rebuildTokenRenderIndex(view: VirtualizedTextViewInternal): void {
  const entries: TokenRenderEntry[] = []
  const styles = new Map<string, EditorTokenStyle>()
  let previousEntry: TokenRenderEntry | undefined
  let sorted = true
  for (let index = 0; index < view.tokens.length; index += 1) {
    const token = view.tokens[index]!
    const entry = tokenRenderEntry(view, token, index)
    if (!entry) continue
    if (previousEntry && previousEntry.start > entry.start) sorted = false
    entries.push(entry)
    styles.set(entry.styleKey, entry.style)
    previousEntry = entry
  }

  if (!sorted) entries.sort(compareTokenRenderEntries)
  view.tokenRenderEntries = entries
  view.tokenRenderEntryMaxEnds = tokenRenderEntryMaxEnds(entries)
  view.tokenRenderStyles = styles
}

function tokenRenderEntry(
  view: VirtualizedTextViewInternal,
  token: EditorToken,
  sourceIndex: number,
  styleSource: TokenStyleSource | null = null,
): TokenRenderEntry | null {
  const sourceEntry = styleSource?.entriesByIndex?.get(sourceIndex)
  const sourceStyle = styleSource?.tokens[sourceIndex]?.style ?? token.style
  const style = sourceEntry?.style ?? normalizeTokenStyle(sourceStyle)
  if (!style) return null
  const styleKey = sourceEntry?.styleKey ?? serializeTokenStyle(style)

  const start = clamp(token.start, 0, view.model.textLength)
  const end = clamp(token.end, start, view.model.textLength)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (end <= start) return null

  return {
    start,
    end,
    style,
    styleKey,
    sourceIndex,
  }
}

function firstStartingAtOrAfter(
  spans: readonly { readonly start: number }[],
  offset: number,
): number {
  return lowerBound(spans.length, (index) => spans[index]!.start, offset)
}

function firstEndingAfter(maxEnds: readonly number[], offset: number, endIndex: number): number {
  return upperBound(endIndex, (index) => maxEnds[index] ?? 0, offset)
}

function tokenSegmentsForRows(
  view: VirtualizedTextViewInternal,
  rows: readonly MountedVirtualizedTextRow[],
  styleSource: TokenStyleSource | null = null,
): Map<number, TokenRowSegment[]> {
  const segmentsByRow = new Map<number, TokenRowSegment[]>()
  const stats = createTokenSegmentBuildStats(rows)
  const startedAt = stats ? performanceNow() : 0

  appendTokenSegmentsForRows(view, segmentsByRow, rows, styleSource, stats)
  recordTokenSegmentBuildStats(stats, segmentsByRow, startedAt)
  return segmentsByRow
}

function appendTokenSegmentsForRows(
  view: VirtualizedTextViewInternal,
  segmentsByRow: Map<number, TokenRowSegment[]>,
  rows: readonly MountedVirtualizedTextRow[],
  styleSource: TokenStyleSource | null,
  stats: TokenSegmentBuildStats | null,
): void {
  if (rows.length === 0) return
  if (appendIndexedTokenSegmentsForRows(view, segmentsByRow, rows, styleSource, stats)) return

  ensureTokenRenderIndex(view)
  if (view.tokenRenderEntries.length === 0) return

  for (const row of rows) {
    appendTokenSegmentsForMountedRow(view, segmentsByRow, row, stats)
  }
}

function appendIndexedTokenSegmentsForRows(
  view: VirtualizedTextViewInternal,
  segmentsByRow: Map<number, TokenRowSegment[]>,
  rows: readonly MountedVirtualizedTextRow[],
  styleSource: TokenStyleSource | null,
  stats: TokenSegmentBuildStats | null,
): boolean {
  const tokenIndex = getEditorTokenIndex(view.tokens)
  if (!tokenIndex?.sortedByStart) return false

  for (const row of rows) {
    appendIndexedTokenSegmentsForMountedRow(
      view,
      tokenIndex,
      segmentsByRow,
      row,
      styleSource,
      stats,
    )
  }

  return true
}

function appendIndexedTokenSegmentsForMountedRow(
  view: VirtualizedTextViewInternal,
  tokenIndex: EditorTokenIndex,
  segmentsByRow: Map<number, TokenRowSegment[]>,
  row: MountedVirtualizedTextRow,
  styleSource: TokenStyleSource | null,
  stats: TokenSegmentBuildStats | null,
): void {
  if (row.kind !== 'text') return

  for (const chunk of row.chunks) {
    appendIndexedTokenSegmentsForChunk(
      view,
      tokenIndex,
      segmentsByRow,
      row,
      chunk,
      styleSource,
      stats,
    )
  }
}

function appendIndexedTokenSegmentsForChunk(
  view: VirtualizedTextViewInternal,
  tokenIndex: EditorTokenIndex,
  segmentsByRow: Map<number, TokenRowSegment[]>,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  styleSource: TokenStyleSource | null,
  stats: TokenSegmentBuildStats | null,
): void {
  if (chunk.endOffset <= chunk.startOffset) return
  if (stats) stats.chunkCount += 1

  const endIndex = firstStartingAtOrAfter(view.tokens, chunk.endOffset)
  const startIndex = firstEndingAfter(tokenIndex.maxEnds, chunk.startOffset, endIndex)
  if (startIndex >= endIndex) return

  const segments = getOrCreateTokenSegments(segmentsByRow, row.tokenHighlightSlotId)
  for (let index = startIndex; index < endIndex; index += 1) {
    if (stats) stats.tokenScanCount += 1

    const token = tokenRenderEntry(view, view.tokens[index]!, index, styleSource)
    if (!token) continue
    if (token.end <= chunk.startOffset) continue
    const result = appendTokenSegmentForChunk(
      segments,
      row,
      chunk,
      token,
      token.style,
      token.styleKey,
    )
    recordTokenSegmentAppend(stats, result)
  }
}

function appendTokenSegmentsForMountedRow(
  view: VirtualizedTextViewInternal,
  segmentsByRow: Map<number, TokenRowSegment[]>,
  row: MountedVirtualizedTextRow,
  stats: TokenSegmentBuildStats | null,
): void {
  if (row.kind !== 'text') return

  for (const chunk of row.chunks) {
    appendTokenSegmentsForChunk(view, segmentsByRow, row, chunk, stats)
  }
}

function appendTokenSegmentsForChunk(
  view: VirtualizedTextViewInternal,
  segmentsByRow: Map<number, TokenRowSegment[]>,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  stats: TokenSegmentBuildStats | null,
): void {
  if (chunk.endOffset <= chunk.startOffset) return
  if (stats) stats.chunkCount += 1

  const endIndex = firstStartingAtOrAfter(view.tokenRenderEntries, chunk.endOffset)
  const startIndex = firstEndingAfter(view.tokenRenderEntryMaxEnds, chunk.startOffset, endIndex)
  if (startIndex >= endIndex) return

  const segments = getOrCreateTokenSegments(segmentsByRow, row.tokenHighlightSlotId)
  for (let index = startIndex; index < endIndex; index += 1) {
    if (stats) stats.tokenScanCount += 1

    const token = view.tokenRenderEntries[index]!
    if (token.end <= chunk.startOffset) continue
    const result = appendTokenSegmentForChunk(
      segments,
      row,
      chunk,
      token,
      token.style,
      token.styleKey,
    )
    recordTokenSegmentAppend(stats, result)
  }
}

function createTokenSegmentBuildStats(
  rows: readonly MountedVirtualizedTextRow[],
): TokenSegmentBuildStats | null {
  if (!editorPerformanceDiagnosticsEnabled()) return null

  return {
    addedSegmentCount: 0,
    adjacentMergedSegmentCount: 0,
    chunkCount: 0,
    gapMergedSegmentCount: 0,
    mergedSegmentCount: 0,
    rawSegmentCount: 0,
    rowCount: rows.length,
    tokenScanCount: 0,
  }
}

function recordTokenSegmentAppend(
  stats: TokenSegmentBuildStats | null,
  result: TokenSegmentAppendResult,
): void {
  if (!stats) return
  if (result === 'skipped') return

  stats.rawSegmentCount += 1
  if (result === 'merged-adjacent') {
    stats.adjacentMergedSegmentCount += 1
    stats.mergedSegmentCount += 1
    return
  }

  if (result === 'merged-gap') {
    stats.gapMergedSegmentCount += 1
    stats.mergedSegmentCount += 1
    return
  }

  stats.addedSegmentCount += 1
}

function recordTokenSegmentBuildStats(
  stats: TokenSegmentBuildStats | null,
  segmentsByRow: ReadonlyMap<number, readonly TokenRowSegment[]>,
  startedAt: number,
): void {
  if (!stats) return

  const finalSegmentCount = tokenSegmentCount(segmentsByRow)
  recordEditorPerformanceDiagnostic(
    'editor.tokenHighlights.segments',
    {
      addedSegmentCount: stats.addedSegmentCount,
      adjacentMergedSegmentCount: stats.adjacentMergedSegmentCount,
      chunkCount: stats.chunkCount,
      finalSegmentCount,
      gapMergedSegmentCount: stats.gapMergedSegmentCount,
      mergedSegmentCount: stats.mergedSegmentCount,
      rawSegmentCount: stats.rawSegmentCount,
      rowCount: stats.rowCount,
      rowSlotCount: segmentsByRow.size,
      tokenScanCount: stats.tokenScanCount,
    },
    performanceNow() - startedAt,
  )
}

function tokenSegmentCount(segmentsByRow: ReadonlyMap<number, readonly TokenRowSegment[]>): number {
  let count = 0
  for (const segments of segmentsByRow.values()) count += segments.length
  return count
}

function performanceNow(): number {
  return globalThis.performance?.now() ?? Date.now()
}

function createTokenRangeReconcileStats(
  view: VirtualizedTextViewInternal,
  mountedRows: readonly MountedVirtualizedTextRow[],
): TokenRangeReconcileStats | null {
  if (!editorPerformanceDiagnosticsEnabled()) return null

  return {
    addedRangeCount: 0,
    deletedRangeCount: 0,
    liveRangeCount: 0,
    mountedRowCount: mountedRows.length,
    rebuiltRowCount: 0,
    skippedRowCount: 0,
    staticRangeCount: 0,
    tokenRenderIndexDirty: view.tokenRenderIndexDirty,
  }
}

function recordTokenRangeReconcileStats(
  stats: TokenRangeReconcileStats | null,
  startedAt: number,
): void {
  if (!stats) return

  recordEditorPerformanceDiagnostic(
    'editor.tokenHighlights.ranges',
    {
      addedRangeCount: stats.addedRangeCount,
      deletedRangeCount: stats.deletedRangeCount,
      liveRangeCount: stats.liveRangeCount,
      mountedRowCount: stats.mountedRowCount,
      rebuiltRowCount: stats.rebuiltRowCount,
      skippedRowCount: stats.skippedRowCount,
      staticRangeCount: stats.staticRangeCount,
      tokenRenderIndexDirty: stats.tokenRenderIndexDirty,
    },
    performanceNow() - startedAt,
  )
}

function addTokenSegmentsForRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  segments: readonly TokenRowSegment[],
): TokenRangeAddResult {
  const rangesByStyle = new Map<string, AbstractRange[]>()
  const document = view.scrollElement.ownerDocument
  let addedRangeCount = 0
  let liveRangeCount = 0
  let staticRangeCount = 0
  let styleRulesDirty = false
  for (const segment of segments) {
    const result = ensureTokenGroup(view, segment.styleKey, segment.style)
    const group = result.group
    if (!group) continue

    const range = addTokenRangeToChunk(
      document,
      group.highlight,
      row,
      segment.chunk,
      segment.start,
      segment.end,
    )
    if (!range) continue

    addedRangeCount += 1
    if (isLiveRange(document, range)) liveRangeCount += 1
    else staticRangeCount += 1
    styleRulesDirty = styleRulesDirty || result.created
    appendTokenRange(rangesByStyle, segment.styleKey, range)
  }

  if (rangesByStyle.size > 0) {
    view.rowTokenRanges.set(row.tokenHighlightSlotId, rangesByStyle)
  }

  return { addedRangeCount, liveRangeCount, staticRangeCount, styleRulesDirty }
}

function isLiveRange(document: Document, range: AbstractRange): boolean {
  const RangeConstructor = document.defaultView?.Range
  return RangeConstructor ? range instanceof RangeConstructor : false
}

function ensureTokenGroup(
  view: VirtualizedTextViewInternal,
  styleKey: string,
  style: EditorTokenStyle,
): { readonly group: TokenGroup | null; readonly created: boolean } {
  const existing = view.tokenGroups.get(styleKey)
  if (existing) return { group: existing, created: false }

  const shared = getSharedTokenHighlights(view.scrollElement.ownerDocument, view.highlightRegistry)
  if (!shared) return { group: null, created: false }

  const handle = shared.acquire(styleKey, style)
  const group = {
    name: handle.name,
    highlight: handle.highlight,
    style,
    styleKey,
  }
  view.tokenGroups.set(styleKey, group)
  return { group, created: true }
}

export function clearTokenHighlights(view: VirtualizedTextViewInternal): void {
  if (view.tokenGroups.size === 0 && view.rowTokenRanges.size === 0) return

  // Deletes this view's ranges out of the (shared) Highlight objects via tokenGroups,
  // so it must run before tokenGroups is cleared.
  clearRowTokenState(view)

  const shared = getSharedTokenHighlights(view.scrollElement.ownerDocument, view.highlightRegistry)
  for (const group of view.tokenGroups.values()) shared?.release(group.styleKey)

  view.tokenGroups.clear()
  rebuildStyleRules(view)
}

function syncTokenGroupsToStyles(
  view: VirtualizedTextViewInternal,
  styles: ReadonlyMap<string, EditorTokenStyle>,
): void {
  if (view.model.textLength === 0) {
    clearTokenHighlights(view)
    return
  }

  if (styles.size === 0) {
    clearTokenHighlights(view)
    return
  }

  const added = ensureTokenGroupsForStyles(view, styles)
  const removed = removeUnusedTokenGroups(view, new Set(styles.keys()))
  if (added || removed) rebuildStyleRules(view)
}

function ensureTokenGroupsForStyles(
  view: VirtualizedTextViewInternal,
  styles: ReadonlyMap<string, EditorTokenStyle>,
): boolean {
  let added = false
  for (const [styleKey, style] of styles) {
    const result = ensureTokenGroup(view, styleKey, style)
    added = added || result.created
  }

  return added
}

function removeUnusedTokenGroups(
  view: VirtualizedTextViewInternal,
  styleKeys: ReadonlySet<string>,
): boolean {
  const shared = getSharedTokenHighlights(view.scrollElement.ownerDocument, view.highlightRegistry)
  let removed = false
  for (const [key, group] of view.tokenGroups) {
    if (styleKeys.has(key)) continue

    deleteViewTokenRangesForStyle(view, key, group.highlight)
    shared?.release(key)
    view.tokenGroups.delete(key)
    removed = true
  }

  if (!removed) return false

  clearRowTokenState(view)
  return true
}

function deleteViewTokenRangesForStyle(
  view: VirtualizedTextViewInternal,
  styleKey: string,
  highlight: Highlight,
): void {
  for (const rangesByStyle of view.rowTokenRanges.values()) {
    const ranges = rangesByStyle.get(styleKey)
    if (!ranges) continue

    for (const range of ranges) highlight.delete(range)
    rangesByStyle.delete(styleKey)
  }
}

function canKeepLiveTokenRanges(
  view: VirtualizedTextViewInternal,
  tokens: readonly EditorToken[],
  projectionStatus: boolean | null,
): boolean {
  if (!view.sameLineTokenEdit) return false
  if (projectionStatus !== null) return projectionStatus
  if (view.tokens.length !== tokens.length) return false

  return view.tokens.every((token, index) => {
    const nextToken = tokens[index]
    return nextToken ? tokenStylesEqual(token, nextToken) : false
  })
}

export function deleteTokenRangesForRow(
  view: VirtualizedTextViewInternal,
  rowSlotId: number,
): number {
  const rangesByStyle = view.rowTokenRanges.get(rowSlotId)
  if (!rangesByStyle) return 0

  let deletedRangeCount = 0
  for (const [styleKey, capturedRanges] of rangesByStyle) {
    const group = view.tokenGroups.get(styleKey)
    if (!group) continue

    for (const range of capturedRanges) {
      group.highlight.delete(range)
    }
    deletedRangeCount += capturedRanges.length
  }

  view.rowTokenRanges.delete(rowSlotId)
  // Covers release-only paths (fold collapse, viewport shrink) where rows are
  // dropped without any row rebuild scheduling the nudge.
  if (deletedRangeCount > 0) {
    scheduleHighlightRepaintNudge(view.highlightRegistry)
  }
  return deletedRangeCount
}

export function clearRowTokenState(view: VirtualizedTextViewInternal): void {
  for (const rowSlotId of view.rowTokenRanges.keys()) {
    deleteTokenRangesForRow(view, rowSlotId)
  }

  view.rowTokenSignatures.clear()
  view.rowTokenRanges.clear()
}

function getOrCreateRangeHighlightGroup(
  view: VirtualizedTextViewInternal,
  name: string,
  style: VirtualizedTextHighlightStyle,
): VirtualizedTextHighlightGroup {
  const existing = view.rangeHighlightGroups.get(name)
  if (existing) return existing

  const group: VirtualizedTextHighlightGroup = {
    name,
    highlight: new Highlight(),
    ranges: [],
    style,
    registered: false,
    signature: '',
  }
  view.rangeHighlightGroups.set(name, group)
  return group
}

function canSkipRangeHighlightUpdate(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
  ranges: readonly VirtualizedTextHighlightRange[],
  style: VirtualizedTextHighlightStyle,
): boolean {
  if (!sameRangeHighlight(group, ranges, style)) return false

  return rangeHighlightSignature(view, group) === group.signature
}

function sameRangeHighlight(
  group: VirtualizedTextHighlightGroup,
  ranges: readonly VirtualizedTextHighlightRange[],
  style: VirtualizedTextHighlightStyle,
): boolean {
  if (!sameHighlightStyle(group.style, style)) return false
  if (group.ranges.length !== ranges.length) return false

  return group.ranges.every((range, index) => {
    const next = ranges[index]
    return next ? sameHighlightRange(range, next) : false
  })
}

function sameHighlightStyle(
  left: VirtualizedTextHighlightStyle,
  right: VirtualizedTextHighlightStyle,
): boolean {
  if (left.backgroundColor !== right.backgroundColor) return false
  if (left.color !== right.color) return false
  if (left.zIndex !== right.zIndex) return false

  return left.textDecoration === right.textDecoration
}

function sameHighlightRange(
  left: VirtualizedTextHighlightRange,
  right: VirtualizedTextHighlightRange,
): boolean {
  if (left.start !== right.start) return false

  return left.end === right.end
}

/**
 * Painting seeks into this array once per mounted row, so it has to be ordered, and a caller on
 * the far side of the plugin boundary hands its ranges over in whatever order it produced them.
 * Ordering costs a sort per set rather than a scan per frame, and a set can be large: a search for
 * a common letter in a big file arrives as tens of thousands of ranges.
 */
function sortedRangeHighlights(
  view: VirtualizedTextViewInternal,
  ranges: readonly VirtualizedTextHighlightRange[],
): readonly VirtualizedTextHighlightRange[] {
  const clamped = ranges.map((range) => ({
    start: clamp(range.start, 0, view.model.textLength),
    end: clamp(range.end, 0, view.model.textLength),
  }))

  return clamped.sort(compareRangeHighlights)
}

function compareRangeHighlights(
  left: VirtualizedTextHighlightRange,
  right: VirtualizedTextHighlightRange,
): number {
  return left.start - right.start || left.end - right.end
}

function rangeHighlightIndex(
  ranges: readonly VirtualizedTextHighlightRange[],
): RangeHighlightIndex {
  const cached = rangeHighlightIndexes.get(ranges)
  if (cached) return cached

  const maxEnds: number[] = []
  let maxEnd = 0
  let fingerprint = SIGNATURE_HASH_SEED
  for (const range of ranges) {
    maxEnd = Math.max(maxEnd, range.end)
    maxEnds.push(maxEnd)
    fingerprint = mixSignatureHash(mixSignatureHash(fingerprint, range.start), range.end)
  }

  const index: RangeHighlightIndex = { fingerprint, maxEnds }
  rangeHighlightIndexes.set(ranges, index)
  return index
}

function addMountedRangeHighlightRanges(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
): void {
  const index = rangeHighlightIndex(group.ranges)
  for (const row of getMountedRows(view)) {
    addMountedRangeHighlightRangesForRow(view, group, row, index)
  }
}

function addMountedRangeHighlightRangesForRow(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
  row: MountedVirtualizedTextRow,
  index: RangeHighlightIndex,
): void {
  const endIndex = firstStartingAtOrAfter(group.ranges, row.endOffset)
  const startIndex = firstEndingAfter(index.maxEnds, row.startOffset, endIndex)
  for (let position = startIndex; position < endIndex; position += 1) {
    addMountedRangeHighlightRange(view, group, row, group.ranges[position]!)
  }
}

function addMountedRangeHighlightRange(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
  row: MountedVirtualizedTextRow,
  range: VirtualizedTextHighlightRange,
): void {
  if (range.start === range.end) return
  if (range.end <= row.startOffset || range.start >= row.endOffset) return

  for (const chunk of row.chunks) {
    addRangeHighlightToChunk(view, group, row, chunk, range)
  }
}

function addRangeHighlightToChunk(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  range: VirtualizedTextHighlightRange,
): void {
  const domRange = createDomRangeForChunkRange(
    view.scrollElement.ownerDocument,
    row,
    chunk,
    range.start,
    range.end,
  )
  if (!domRange) return

  group.highlight.add(domRange)
}

function ensureRangeHighlightRegistered(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
): void {
  if (group.registered) return
  if (!view.highlightRegistry) return

  view.highlightRegistry.set(group.name, group.highlight)
  group.registered = true
}

function unregisterRangeHighlight(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
): void {
  if (!group.registered) return

  view.highlightRegistry?.delete(group.name)
  group.registered = false
}

function staleRangeHighlightSignature(): string {
  return '\0'
}

/**
 * Guards the repaint, so it has to tell apart any two viewports that would paint differently
 * without costing what the repaint costs: the ranges the mounted window reaches fold into one
 * number, and the set as a whole rides along as the fingerprint the index already carries.
 */
function rangeHighlightSignature(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
): string {
  const index = rangeHighlightIndex(group.ranges)
  let hash = index.fingerprint
  for (const row of getMountedRows(view)) {
    hash = mixRangeHighlightRowSignature(hash, row, group, index)
  }

  return String(hash)
}

function mixRangeHighlightRowSignature(
  hash: number,
  row: MountedVirtualizedTextRow,
  group: VirtualizedTextHighlightGroup,
  index: RangeHighlightIndex,
): number {
  const endIndex = firstStartingAtOrAfter(group.ranges, row.endOffset)
  const startIndex = firstEndingAfter(index.maxEnds, row.startOffset, endIndex)
  let mixed = hash
  for (let position = startIndex; position < endIndex; position += 1) {
    mixed = mixRangeHighlightRangeSignature(mixed, row, group.ranges[position]!)
  }

  return mixed
}

function mixRangeHighlightRangeSignature(
  hash: number,
  row: MountedVirtualizedTextRow,
  range: VirtualizedTextHighlightRange,
): number {
  if (range.start === range.end) return hash
  if (range.end <= row.startOffset || range.start >= row.endOffset) return hash

  let mixed = hash
  for (const chunk of row.chunks) {
    mixed = mixRangeHighlightChunkSignature(mixed, row, chunk, range.start, range.end)
  }

  return mixed
}

function clampSelection(
  view: VirtualizedTextViewInternal,
  selection: VirtualizedTextSelection,
): VirtualizedStoredSelection {
  const anchor = clamp(selection.anchorOffset, 0, view.model.textLength)
  const head = clamp(selection.headOffset, 0, view.model.textLength)
  return {
    start: Math.min(anchor, head),
    end: Math.max(anchor, head),
    head,
  }
}

function clampStoredSelectionRange(
  view: VirtualizedTextViewInternal,
  selection: VirtualizedStoredSelection,
): VirtualizedStoredSelection {
  const start = clamp(selection.start, 0, view.model.textLength)
  return {
    start,
    end: clamp(selection.end, start, view.model.textLength),
    head: clamp(selection.head, 0, view.model.textLength),
  }
}

function setPrimarySelection(
  view: VirtualizedTextViewInternal,
  selection: VirtualizedStoredSelection | null,
): void {
  view.selectionStart = selection?.start ?? null
  view.selectionEnd = selection?.end ?? null
  view.selectionHead = selection?.head ?? null
}

function hasSelectionRanges(selections: readonly VirtualizedStoredSelection[]): boolean {
  return selections.some((selection) => selection.start !== selection.end)
}

function ensureCaretElementCount(view: VirtualizedTextViewInternal, selectionCount: number): void {
  const neededSecondaryCount = Math.max(0, selectionCount - 1)
  while (view.secondaryCaretElements.length < neededSecondaryCount) {
    view.secondaryCaretElements.push(createSecondaryCaretElement(view))
  }
}

function createSecondaryCaretElement(view: VirtualizedTextViewInternal): HTMLDivElement {
  const element = view.scrollElement.ownerDocument.createElement('div')
  element.className = 'editor-virtualized-caret editor-virtualized-caret-secondary'
  element.hidden = true
  view.caretLayerElement.appendChild(element)
  return element
}

function hideCaretElement(element: HTMLElement): void {
  setElementHidden(element, true)
}

function hideSecondaryCaretElements(view: VirtualizedTextViewInternal, startIndex: number): void {
  for (let index = startIndex; index < view.secondaryCaretElements.length; index += 1) {
    hideCaretElement(view.secondaryCaretElements[index]!)
  }
}

export function rebuildStyleRules(view: VirtualizedTextViewInternal): void {
  // Token highlight rules live in the shared per-document stylesheet
  // (sharedTokenHighlights), written once here per batch. The per-view style element only
  // carries range/decoration highlight rules, which are specific to this view's ranges.
  getSharedTokenHighlights(view.scrollElement.ownerDocument, view.highlightRegistry)?.flush()

  const rules: string[] = []
  for (const group of view.rangeHighlightGroups.values()) {
    const rule = rangeHighlightRule(group.name, group.style)
    if (rule) rules.push(rule)
  }

  const nextRules = rules.join('\n')
  if (view.styleEl.textContent === nextRules) {
    syncStyleElementConnection(view, nextRules)
    return
  }

  view.styleEl.textContent = nextRules
  syncStyleElementConnection(view, nextRules)
}

function syncStyleElementConnection(view: VirtualizedTextViewInternal, rules: string): void {
  if (rules.length === 0) {
    view.styleEl.remove()
    return
  }

  if (view.styleEl.isConnected) return

  view.scrollElement.ownerDocument.head.appendChild(view.styleEl)
}

function rangeHighlightRule(name: string, style: VirtualizedTextHighlightStyle): string | null {
  const declarations = []
  if (style.backgroundColor) declarations.push(`background-color: ${style.backgroundColor};`)
  if (style.color) declarations.push(`color: ${style.color};`)
  if (style.textDecoration) declarations.push(`text-decoration: ${style.textDecoration};`)
  if (declarations.length === 0) return null

  return `::highlight(${name}) { ${declarations.join(' ')} }`
}

function mixRangeHighlightChunkSignature(
  hash: number,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): number {
  if (end <= chunk.startOffset || start >= chunk.endOffset) return hash

  const localStart = clamp(
    rowLocalIndexForOffset(row, start, 'before') - chunk.localStart,
    0,
    chunk.text.length,
  )
  const localEnd = clamp(
    rowLocalIndexForOffset(row, end, 'after') - chunk.localStart,
    0,
    chunk.text.length,
  )
  let mixed = mixSignatureHash(hash, row.index)
  mixed = mixSignatureHash(mixed, chunk.localStart)
  mixed = mixSignatureHash(mixed, chunk.startOffset)
  mixed = mixSignatureHash(mixed, localStart)
  return mixSignatureHash(mixed, localEnd)
}

function mixSignatureHash(hash: number, value: number): number {
  return Math.imul(hash ^ (value | 0), SIGNATURE_HASH_PRIME) >>> 0
}

function compareTokenRenderEntries(left: TokenRenderEntry, right: TokenRenderEntry): number {
  return left.start - right.start || left.sourceIndex - right.sourceIndex
}

function tokenRenderEntryMaxEnds(entries: readonly TokenRenderEntry[]): number[] {
  const maxEnds: number[] = []
  let maxEnd = 0

  for (const entry of entries) {
    maxEnd = Math.max(maxEnd, entry.end)
    maxEnds.push(maxEnd)
  }

  return maxEnds
}
