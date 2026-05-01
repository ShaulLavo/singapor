import type { EditorToken, EditorTokenStyle } from "../tokens";
import {
  copyTokenProjectionMetadata,
  tokenProjectionLiveRangeStatus,
} from "../editor/tokenProjection";
import { getEditorTokenIndex, type EditorTokenIndex } from "../editor/tokenIndex";
import {
  buildHighlightRule,
  clamp,
  normalizeTokenStyle,
  serializeTokenStyle,
} from "../style-utils";
import {
  addTokenRangeToChunk,
  appendTokenRange,
  appendTokenSegmentForChunk,
  editorTokensEqual,
  getOrCreateTokenSegments,
  setElementHidden,
  setStyleValue,
  tokenRowSignature,
  tokenStylesEqual,
} from "./virtualizedTextViewHelpers";
import {
  caretPosition,
  cursorLineBufferRow,
  cursorLineVirtualRow,
  getMountedRows,
  refreshCursorLineRows,
} from "./virtualizedTextViewRows";
import { renderHiddenCharacters } from "./virtualizedTextViewHiddenCharacters";
import type {
  MountedVirtualizedTextRow,
  TokenGroup,
  TokenRowSegment,
  VirtualizedTextChunk,
  VirtualizedTextRow,
} from "./virtualizedTextViewTypes";
import type {
  TokenRenderEntry,
  VirtualizedTextHighlightGroup,
  VirtualizedTextHighlightRange,
  VirtualizedTextHighlightStyle,
  VirtualizedStoredSelection,
  VirtualizedTextSelection,
  VirtualizedTextViewInternal,
} from "./virtualizedTextViewInternals";

export function setTokens(view: VirtualizedTextViewInternal, tokens: readonly EditorToken[]): void {
  const copiedTokens = [...tokens];
  copyTokenProjectionMetadata(tokens, copiedTokens);
  adoptTokens(view, copiedTokens);
}

export function adoptTokens(
  view: VirtualizedTextViewInternal,
  tokens: readonly EditorToken[],
): void {
  if (canKeepLiveTokenRanges(view, tokens)) {
    view.tokens = tokens;
    view.tokenRangesFollowLastTextEdit = false;
    view.tokenRenderIndexDirty = true;
    return;
  }

  if (editorTokensEqual(view.tokens, tokens)) {
    view.tokens = tokens;
    view.tokenRangesFollowLastTextEdit = false;
    renderTokenHighlights(view);
    return;
  }

  view.tokenRangesFollowLastTextEdit = false;
  view.tokens = tokens;
  view.tokenRenderIndexDirty = true;
  renderTokenHighlights(view);
}

export function setSelection(
  view: VirtualizedTextViewInternal,
  anchorOffset: number,
  headOffset: number,
): void {
  setSelections(view, [{ anchorOffset, headOffset }]);
}

export function setSelections(
  view: VirtualizedTextViewInternal,
  selections: readonly VirtualizedTextSelection[],
): void {
  const previousCursorLine = cursorLineBufferRow(view);
  const previousCursorRow = cursorLineVirtualRow(view);
  const stored = selections.map((selection) => clampSelection(view, selection));
  view.selections = stored;
  setPrimarySelection(view, stored[0] ?? null);
  renderSelectionHighlight(view);
  renderHiddenCharacters(view);
  refreshCursorLineRows(view, previousCursorLine, previousCursorRow);
}

export function clearSelection(view: VirtualizedTextViewInternal): void {
  const previousCursorLine = cursorLineBufferRow(view);
  const previousCursorRow = cursorLineVirtualRow(view);
  view.selectionStart = null;
  view.selectionEnd = null;
  view.selectionHead = null;
  view.selections = [];
  clearSelectionHighlight(view);
  renderHiddenCharacters(view);
  renderCaret(view);
  refreshCursorLineRows(view, previousCursorLine, previousCursorRow);
}

export function renderSelectionHighlight(view: VirtualizedTextViewInternal): void {
  renderCaret(view);
  if (!hasSelectionRanges(view.selections)) {
    clearSelectionHighlight(view);
    return;
  }
  if (!view.selectionHighlight || !view.highlightRegistry) return;

  const signature = selectionHighlightSignature(view, view.selections);
  if (signature === view.lastSelectionHighlightSignature) return;

  view.lastSelectionHighlightSignature = signature;
  clearSelectionHighlightRanges(view);
  addMountedSelectionRanges(view, view.selections);
  if (view.selectionHighlight.size === 0) return;

  ensureSelectionHighlightRegistered(view);
}

function addMountedSelectionRanges(
  view: VirtualizedTextViewInternal,
  selections: readonly VirtualizedStoredSelection[],
): void {
  for (const row of getMountedRows(view)) {
    addMountedSelectionRangesForRow(view, row, selections);
  }
}

function addMountedSelectionRangesForRow(
  view: VirtualizedTextViewInternal,
  row: VirtualizedTextRow,
  selections: readonly VirtualizedStoredSelection[],
): void {
  for (const selection of selections) {
    addMountedSelectionRange(view, row, selection.start, selection.end);
  }
}

function addMountedSelectionRange(
  view: VirtualizedTextViewInternal,
  row: VirtualizedTextRow,
  start: number,
  end: number,
): void {
  if (!view.selectionHighlight) return;
  if (start === end) return;
  if (end <= row.startOffset || start >= row.endOffset) return;

  for (const chunk of row.chunks) {
    addSelectionRangeToChunk(view, chunk, start, end);
  }
}

function addSelectionRangeToChunk(
  view: VirtualizedTextViewInternal,
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): void {
  if (!view.selectionHighlight) return;
  if (end <= chunk.startOffset || start >= chunk.endOffset) return;

  const range = view.scrollElement.ownerDocument.createRange();
  range.setStart(chunk.textNode, clamp(start - chunk.startOffset, 0, chunk.textNode.length));
  range.setEnd(chunk.textNode, clamp(end - chunk.startOffset, 0, chunk.textNode.length));
  view.selectionHighlight.add(range);
}

export function clearSelectionHighlight(view: VirtualizedTextViewInternal): void {
  clearSelectionHighlightRanges(view);
  view.lastSelectionHighlightSignature = "";
  if (!view.selectionHighlightRegistered || !view.highlightRegistry) return;

  view.highlightRegistry.delete(view.selectionHighlightName);
  view.selectionHighlightRegistered = false;
}

export function setRangeHighlight(
  view: VirtualizedTextViewInternal,
  name: string,
  ranges: readonly VirtualizedTextHighlightRange[],
  style: VirtualizedTextHighlightStyle,
): void {
  const group = getOrCreateRangeHighlightGroup(view, name, style);
  group.ranges = ranges.map((range) => ({
    start: clamp(range.start, 0, view.text.length),
    end: clamp(range.end, 0, view.text.length),
  }));
  group.style = style;
  group.signature = "";
  renderRangeHighlight(view, name);
  rebuildStyleRules(view);
}

export function renderRangeHighlight(view: VirtualizedTextViewInternal, name: string): void {
  const group = view.rangeHighlightGroups.get(name);
  if (!group || !view.highlightRegistry) return;

  const signature = rangeHighlightSignature(view, group);
  if (signature === group.signature) return;

  group.signature = signature;
  group.highlight.clear();
  addMountedRangeHighlightRanges(view, group);
  if (group.highlight.size === 0) return;

  ensureRangeHighlightRegistered(view, group);
}

export function clearRangeHighlight(view: VirtualizedTextViewInternal, name: string): void {
  const group = view.rangeHighlightGroups.get(name);
  if (!group) return;

  group.highlight.clear();
  if (group.registered) view.highlightRegistry?.delete(name);
  view.rangeHighlightGroups.delete(name);
  rebuildStyleRules(view);
}

function selectionHighlightSignature(
  view: VirtualizedTextViewInternal,
  selections: readonly VirtualizedStoredSelection[],
): string {
  const parts = selections.map((selection) => {
    return `${selection.start}:${selection.end}:${selection.head}`;
  });
  for (const row of getMountedRows(view)) {
    appendSelectionRowSignature(parts, row, selections);
  }

  return parts.join("|");
}

function appendSelectionRowSignature(
  parts: string[],
  row: VirtualizedTextRow,
  selections: readonly VirtualizedStoredSelection[],
): void {
  for (const selection of selections) {
    appendSelectionRangeRowSignature(parts, row, selection.start, selection.end);
  }
}

function appendSelectionRangeRowSignature(
  parts: string[],
  row: VirtualizedTextRow,
  start: number,
  end: number,
): void {
  if (start === end) return;
  if (end <= row.startOffset || start >= row.endOffset) return;

  for (const chunk of row.chunks) {
    const signature = selectionChunkSignature(row, chunk, start, end);
    if (signature) parts.push(signature);
  }
}

function renderCaret(view: VirtualizedTextViewInternal): void {
  const selections = view.selections;
  ensureCaretElementCount(view, selections.length);

  if (selections.length === 0) {
    hideCaretElement(view.caretElement);
    hideSecondaryCaretElements(view, 0);
    return;
  }

  renderCaretElement(view, view.caretElement, selections[0]!);
  renderSecondaryCaretElements(view, selections);
}

function renderSecondaryCaretElements(
  view: VirtualizedTextViewInternal,
  selections: readonly VirtualizedStoredSelection[],
): void {
  for (let index = 1; index < selections.length; index += 1) {
    renderCaretElement(view, view.secondaryCaretElements[index - 1]!, selections[index]!);
  }

  hideSecondaryCaretElements(view, Math.max(0, selections.length - 1));
}

function renderCaretElement(
  view: VirtualizedTextViewInternal,
  element: HTMLElement,
  selection: VirtualizedStoredSelection,
): void {
  const position = caretPosition(view, selection.head);
  if (!position) {
    hideCaretElement(element);
    return;
  }

  setElementHidden(element, false);
  setStyleValue(element, "height", `${position.height}px`);
  setStyleValue(element, "transform", `translate(${position.left}px, ${position.top}px)`);
}

export function clampStoredSelection(view: VirtualizedTextViewInternal): void {
  if (view.selections.length === 0) return;

  view.selections = view.selections.map((selection) => clampStoredSelectionRange(view, selection));
  setPrimarySelection(view, view.selections[0] ?? null);
}

export function renderTokenHighlights(view: VirtualizedTextViewInternal): void {
  if (!view.highlightRegistry || view.tokens.length === 0 || view.text.length === 0) {
    clearTokenHighlights(view);
    return;
  }

  const mountedRows = getMountedRows(view);
  const segmentsByRow = tokenSegmentsForRows(view, mountedRows);
  for (const row of mountedRows) {
    reconcileTokenHighlightsForRow(view, row, segmentsByRow.get(row.tokenHighlightSlotId) ?? []);
  }
}

function reconcileTokenHighlightsForRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  segments: readonly TokenRowSegment[],
): void {
  const signature = tokenRowSignature(row, segments);
  if (view.rowTokenSignatures.get(row.tokenHighlightSlotId) === signature) return;

  deleteTokenRangesForRow(view, row.tokenHighlightSlotId);
  addTokenSegmentsForRow(view, row, segments);
  view.rowTokenSignatures.set(row.tokenHighlightSlotId, signature);
}

function ensureTokenRenderIndex(view: VirtualizedTextViewInternal): void {
  if (!view.tokenRenderIndexDirty) return;

  rebuildTokenRenderIndex(view);
  syncTokenGroupsToStyles(view, view.tokenRenderStyles);
  view.tokenRenderIndexDirty = false;
}

function rebuildTokenRenderIndex(view: VirtualizedTextViewInternal): void {
  const entries: TokenRenderEntry[] = [];
  const styles = new Map<string, EditorTokenStyle>();
  let previousEntry: TokenRenderEntry | undefined;
  let sorted = true;
  for (let index = 0; index < view.tokens.length; index += 1) {
    const token = view.tokens[index]!;
    const entry = tokenRenderEntry(view, token, index);
    if (!entry) continue;
    if (previousEntry && previousEntry.start > entry.start) sorted = false;
    entries.push(entry);
    styles.set(entry.styleKey, entry.style);
    previousEntry = entry;
  }

  if (!sorted) entries.sort(compareTokenRenderEntries);
  view.tokenRenderEntries = entries;
  view.tokenRenderEntryMaxEnds = tokenRenderEntryMaxEnds(entries);
  view.tokenRenderStyles = styles;
}

function tokenRenderEntry(
  view: VirtualizedTextViewInternal,
  token: EditorToken,
  sourceIndex: number,
): TokenRenderEntry | null {
  const style = normalizeTokenStyle(token.style);
  if (!style) return null;

  const start = clamp(token.start, 0, view.text.length);
  const end = clamp(token.end, start, view.text.length);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) return null;

  return {
    start,
    end,
    style,
    styleKey: serializeTokenStyle(style),
    sourceIndex,
  };
}

function firstTokenRenderEntryStartingAtOrAfter(
  view: VirtualizedTextViewInternal,
  offset: number,
): number {
  let low = 0;
  let high = view.tokenRenderEntries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const token = view.tokenRenderEntries[middle]!;
    if (token.start >= offset) {
      high = middle;
      continue;
    }

    low = middle + 1;
  }

  return low;
}

function firstTokenRenderEntryEndingAfter(
  view: VirtualizedTextViewInternal,
  offset: number,
  endIndex: number,
): number {
  let low = 0;
  let high = endIndex;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const maxEnd = view.tokenRenderEntryMaxEnds[middle] ?? 0;
    if (maxEnd > offset) {
      high = middle;
      continue;
    }

    low = middle + 1;
  }

  return low;
}

function firstIndexedTokenStartingAtOrAfter(
  tokens: readonly EditorToken[],
  offset: number,
): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (tokens[middle]!.start >= offset) {
      high = middle;
      continue;
    }

    low = middle + 1;
  }

  return low;
}

function firstIndexedTokenEndingAfter(
  tokenIndex: EditorTokenIndex,
  offset: number,
  endIndex: number,
): number {
  let low = 0;
  let high = endIndex;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const maxEnd = tokenIndex.maxEnds[middle] ?? 0;
    if (maxEnd > offset) {
      high = middle;
      continue;
    }

    low = middle + 1;
  }

  return low;
}

function tokenSegmentsForRows(
  view: VirtualizedTextViewInternal,
  rows: readonly MountedVirtualizedTextRow[],
): Map<number, TokenRowSegment[]> {
  const segmentsByRow = new Map<number, TokenRowSegment[]>();
  if (rows.length === 0) return segmentsByRow;

  if (appendIndexedTokenSegmentsForRows(view, segmentsByRow, rows)) return segmentsByRow;

  ensureTokenRenderIndex(view);
  if (view.tokenRenderEntries.length === 0) return segmentsByRow;

  for (const row of rows) {
    appendTokenSegmentsForMountedRow(view, segmentsByRow, row);
  }

  return segmentsByRow;
}

function appendIndexedTokenSegmentsForRows(
  view: VirtualizedTextViewInternal,
  segmentsByRow: Map<number, TokenRowSegment[]>,
  rows: readonly MountedVirtualizedTextRow[],
): boolean {
  const tokenIndex = getEditorTokenIndex(view.tokens);
  if (!tokenIndex?.sortedByStart) return false;

  for (const row of rows) {
    appendIndexedTokenSegmentsForMountedRow(view, tokenIndex, segmentsByRow, row);
  }

  return true;
}

function appendIndexedTokenSegmentsForMountedRow(
  view: VirtualizedTextViewInternal,
  tokenIndex: EditorTokenIndex,
  segmentsByRow: Map<number, TokenRowSegment[]>,
  row: MountedVirtualizedTextRow,
): void {
  if (row.kind !== "text") return;

  for (const chunk of row.chunks) {
    appendIndexedTokenSegmentsForChunk(view, tokenIndex, segmentsByRow, row, chunk);
  }
}

function appendIndexedTokenSegmentsForChunk(
  view: VirtualizedTextViewInternal,
  tokenIndex: EditorTokenIndex,
  segmentsByRow: Map<number, TokenRowSegment[]>,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
): void {
  if (chunk.endOffset <= chunk.startOffset) return;

  const endIndex = firstIndexedTokenStartingAtOrAfter(view.tokens, chunk.endOffset);
  const startIndex = firstIndexedTokenEndingAfter(tokenIndex, chunk.startOffset, endIndex);
  if (startIndex >= endIndex) return;

  const segments = getOrCreateTokenSegments(segmentsByRow, row.tokenHighlightSlotId);
  for (let index = startIndex; index < endIndex; index += 1) {
    const token = tokenRenderEntry(view, view.tokens[index]!, index);
    if (!token) continue;
    if (token.end <= chunk.startOffset) continue;
    appendTokenSegmentForChunk(segments, chunk, token, token.style, token.styleKey);
  }
}

function appendTokenSegmentsForMountedRow(
  view: VirtualizedTextViewInternal,
  segmentsByRow: Map<number, TokenRowSegment[]>,
  row: MountedVirtualizedTextRow,
): void {
  if (row.kind !== "text") return;

  for (const chunk of row.chunks) {
    appendTokenSegmentsForChunk(view, segmentsByRow, row, chunk);
  }
}

function appendTokenSegmentsForChunk(
  view: VirtualizedTextViewInternal,
  segmentsByRow: Map<number, TokenRowSegment[]>,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
): void {
  if (chunk.endOffset <= chunk.startOffset) return;

  const endIndex = firstTokenRenderEntryStartingAtOrAfter(view, chunk.endOffset);
  const startIndex = firstTokenRenderEntryEndingAfter(view, chunk.startOffset, endIndex);
  if (startIndex >= endIndex) return;

  const segments = getOrCreateTokenSegments(segmentsByRow, row.tokenHighlightSlotId);
  for (let index = startIndex; index < endIndex; index += 1) {
    const token = view.tokenRenderEntries[index]!;
    if (token.end <= chunk.startOffset) continue;
    appendTokenSegmentForChunk(segments, chunk, token, token.style, token.styleKey);
  }
}

function addTokenSegmentsForRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  segments: readonly TokenRowSegment[],
): void {
  const rangesByStyle = new Map<string, AbstractRange[]>();
  const document = view.scrollElement.ownerDocument;
  let styleRulesDirty = false;
  for (const segment of segments) {
    const result = ensureTokenGroup(view, segment.styleKey, segment.style);
    const group = result.group;
    if (!group) continue;

    const range = addTokenRangeToChunk(
      document,
      group.highlight,
      segment.chunk,
      segment.start,
      segment.end,
    );
    if (!range) continue;

    styleRulesDirty = styleRulesDirty || result.created;
    appendTokenRange(rangesByStyle, segment.styleKey, range);
  }

  if (rangesByStyle.size > 0) {
    view.rowTokenRanges.set(row.tokenHighlightSlotId, rangesByStyle);
  }

  if (styleRulesDirty) rebuildStyleRules(view);
}

function ensureTokenGroup(
  view: VirtualizedTextViewInternal,
  styleKey: string,
  style: EditorTokenStyle,
): { readonly group: TokenGroup | null; readonly created: boolean } {
  const existing = view.tokenGroups.get(styleKey);
  if (existing) return { group: existing, created: false };

  const name = `${view.selectionHighlightName}-token-${view.nextTokenGroupId++}`;
  const highlight = new Highlight();
  if (!highlight) return { group: null, created: false };

  const group = {
    name,
    highlight,
    style,
    styleKey,
  };
  view.tokenGroups.set(styleKey, group);
  view.highlightRegistry?.set(name, group.highlight);
  return { group, created: true };
}

export function clearTokenHighlights(view: VirtualizedTextViewInternal): void {
  if (view.tokenGroups.size === 0 && view.rowTokenRanges.size === 0) return;

  for (const group of view.tokenGroups.values()) {
    view.highlightRegistry?.delete(group.name);
  }

  view.tokenGroups.clear();
  clearRowTokenState(view);
  view.nextTokenGroupId = 0;
  rebuildStyleRules(view);
}

function syncTokenGroupsToStyles(
  view: VirtualizedTextViewInternal,
  styles: ReadonlyMap<string, EditorTokenStyle>,
): void {
  if (view.text.length === 0) {
    clearTokenHighlights(view);
    return;
  }

  if (styles.size === 0) {
    clearTokenHighlights(view);
    return;
  }

  const added = ensureTokenGroupsForStyles(view, styles);
  const removed = removeUnusedTokenGroups(view, new Set(styles.keys()));
  if (added || removed) rebuildStyleRules(view);
}

function ensureTokenGroupsForStyles(
  view: VirtualizedTextViewInternal,
  styles: ReadonlyMap<string, EditorTokenStyle>,
): boolean {
  let added = false;
  for (const [styleKey, style] of styles) {
    const result = ensureTokenGroup(view, styleKey, style);
    added = added || result.created;
  }

  return added;
}

function removeUnusedTokenGroups(
  view: VirtualizedTextViewInternal,
  styleKeys: ReadonlySet<string>,
): boolean {
  let removed = false;
  for (const [key, group] of view.tokenGroups) {
    if (styleKeys.has(key)) continue;

    view.highlightRegistry?.delete(group.name);
    view.tokenGroups.delete(key);
    removed = true;
  }

  if (!removed) return false;

  clearRowTokenState(view);
  return true;
}

function canKeepLiveTokenRanges(
  view: VirtualizedTextViewInternal,
  tokens: readonly EditorToken[],
): boolean {
  if (!view.tokenRangesFollowLastTextEdit) return false;
  const projectionStatus = tokenProjectionLiveRangeStatus(view.tokens, tokens);
  if (projectionStatus !== null) return projectionStatus;
  if (view.tokens.length !== tokens.length) return false;

  return view.tokens.every((token, index) => {
    const nextToken = tokens[index];
    return nextToken ? tokenStylesEqual(token, nextToken) : false;
  });
}

export function deleteTokenRangesForRow(
  view: VirtualizedTextViewInternal,
  rowSlotId: number,
): void {
  const rangesByStyle = view.rowTokenRanges.get(rowSlotId);
  if (!rangesByStyle) return;

  for (const [styleKey, capturedRanges] of rangesByStyle) {
    const group = view.tokenGroups.get(styleKey);
    if (!group) continue;

    for (const range of capturedRanges) {
      group.highlight.delete(range);
    }
  }

  view.rowTokenRanges.delete(rowSlotId);
}

export function clearRowTokenState(view: VirtualizedTextViewInternal): void {
  for (const rowSlotId of view.rowTokenRanges.keys()) {
    deleteTokenRangesForRow(view, rowSlotId);
  }

  view.rowTokenSignatures.clear();
  view.rowTokenRanges.clear();
}

function clearSelectionHighlightRanges(view: VirtualizedTextViewInternal): void {
  if (!view.selectionHighlight || view.selectionHighlight.size === 0) return;

  view.selectionHighlight?.clear();
}

function ensureSelectionHighlightRegistered(view: VirtualizedTextViewInternal): void {
  if (view.selectionHighlightRegistered) return;
  if (!view.selectionHighlight || !view.highlightRegistry) return;

  view.highlightRegistry.set(view.selectionHighlightName, view.selectionHighlight);
  view.selectionHighlightRegistered = true;
}

function getOrCreateRangeHighlightGroup(
  view: VirtualizedTextViewInternal,
  name: string,
  style: VirtualizedTextHighlightStyle,
): VirtualizedTextHighlightGroup {
  const existing = view.rangeHighlightGroups.get(name);
  if (existing) return existing;

  const group: VirtualizedTextHighlightGroup = {
    name,
    highlight: new Highlight(),
    ranges: [],
    style,
    registered: false,
    signature: "",
  };
  view.rangeHighlightGroups.set(name, group);
  return group;
}

function addMountedRangeHighlightRanges(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
): void {
  for (const row of getMountedRows(view)) {
    addMountedRangeHighlightRangesForRow(view, group, row);
  }
}

function addMountedRangeHighlightRangesForRow(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
  row: VirtualizedTextRow,
): void {
  for (const range of group.ranges) {
    addMountedRangeHighlightRange(view, group, row, range);
  }
}

function addMountedRangeHighlightRange(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
  row: VirtualizedTextRow,
  range: VirtualizedTextHighlightRange,
): void {
  if (range.start === range.end) return;
  if (range.end <= row.startOffset || range.start >= row.endOffset) return;

  for (const chunk of row.chunks) {
    addRangeHighlightToChunk(view, group, chunk, range);
  }
}

function addRangeHighlightToChunk(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
  chunk: VirtualizedTextChunk,
  range: VirtualizedTextHighlightRange,
): void {
  if (range.end <= chunk.startOffset || range.start >= chunk.endOffset) return;

  const domRange = view.scrollElement.ownerDocument.createRange();
  domRange.setStart(
    chunk.textNode,
    clamp(range.start - chunk.startOffset, 0, chunk.textNode.length),
  );
  domRange.setEnd(chunk.textNode, clamp(range.end - chunk.startOffset, 0, chunk.textNode.length));
  group.highlight.add(domRange);
}

function ensureRangeHighlightRegistered(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
): void {
  if (group.registered) return;
  if (!view.highlightRegistry) return;

  view.highlightRegistry.set(group.name, group.highlight);
  group.registered = true;
}

function rangeHighlightSignature(
  view: VirtualizedTextViewInternal,
  group: VirtualizedTextHighlightGroup,
): string {
  const parts = group.ranges.map((range) => `${range.start}:${range.end}`);
  for (const row of getMountedRows(view)) appendRangeHighlightRowSignature(parts, row, group);
  return parts.join("|");
}

function appendRangeHighlightRowSignature(
  parts: string[],
  row: VirtualizedTextRow,
  group: VirtualizedTextHighlightGroup,
): void {
  for (const range of group.ranges) {
    appendRangeHighlightRangeSignature(parts, row, range);
  }
}

function appendRangeHighlightRangeSignature(
  parts: string[],
  row: VirtualizedTextRow,
  range: VirtualizedTextHighlightRange,
): void {
  if (range.start === range.end) return;
  if (range.end <= row.startOffset || range.start >= row.endOffset) return;

  for (const chunk of row.chunks) {
    const signature = selectionChunkSignature(row, chunk, range.start, range.end);
    if (signature) parts.push(signature);
  }
}

function clampSelection(
  view: VirtualizedTextViewInternal,
  selection: VirtualizedTextSelection,
): VirtualizedStoredSelection {
  const anchor = clamp(selection.anchorOffset, 0, view.text.length);
  const head = clamp(selection.headOffset, 0, view.text.length);
  return {
    start: Math.min(anchor, head),
    end: Math.max(anchor, head),
    head,
  };
}

function clampStoredSelectionRange(
  view: VirtualizedTextViewInternal,
  selection: VirtualizedStoredSelection,
): VirtualizedStoredSelection {
  const start = clamp(selection.start, 0, view.text.length);
  return {
    start,
    end: clamp(selection.end, start, view.text.length),
    head: clamp(selection.head, 0, view.text.length),
  };
}

function setPrimarySelection(
  view: VirtualizedTextViewInternal,
  selection: VirtualizedStoredSelection | null,
): void {
  view.selectionStart = selection?.start ?? null;
  view.selectionEnd = selection?.end ?? null;
  view.selectionHead = selection?.head ?? null;
}

function hasSelectionRanges(selections: readonly VirtualizedStoredSelection[]): boolean {
  return selections.some((selection) => selection.start !== selection.end);
}

function ensureCaretElementCount(view: VirtualizedTextViewInternal, selectionCount: number): void {
  const neededSecondaryCount = Math.max(0, selectionCount - 1);
  while (view.secondaryCaretElements.length < neededSecondaryCount) {
    view.secondaryCaretElements.push(createSecondaryCaretElement(view));
  }
}

function createSecondaryCaretElement(view: VirtualizedTextViewInternal): HTMLDivElement {
  const element = view.scrollElement.ownerDocument.createElement("div");
  element.className = "editor-virtualized-caret editor-virtualized-caret-secondary";
  element.hidden = true;
  view.caretLayerElement.appendChild(element);
  return element;
}

function hideCaretElement(element: HTMLElement): void {
  setElementHidden(element, true);
}

function hideSecondaryCaretElements(view: VirtualizedTextViewInternal, startIndex: number): void {
  for (let index = startIndex; index < view.secondaryCaretElements.length; index += 1) {
    hideCaretElement(view.secondaryCaretElements[index]!);
  }
}

export function rebuildStyleRules(view: VirtualizedTextViewInternal): void {
  const rules = [
    `::highlight(${view.selectionHighlightName}) { background-color: rgba(56, 189, 248, 0.35); }`,
  ];
  for (const group of view.rangeHighlightGroups.values()) {
    rules.push(rangeHighlightRule(group.name, group.style));
  }
  for (const group of view.tokenGroups.values()) {
    rules.push(buildHighlightRule(group.name, group.style));
  }

  const nextRules = rules.join("\n");
  if (view.styleEl.textContent === nextRules) return;

  view.styleEl.textContent = nextRules;
}

function rangeHighlightRule(name: string, style: VirtualizedTextHighlightStyle): string {
  const declarations = [`background-color: ${style.backgroundColor};`];
  if (style.color) declarations.push(`color: ${style.color};`);
  return `::highlight(${name}) { ${declarations.join(" ")} }`;
}

function selectionChunkSignature(
  row: VirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): string | null {
  if (end <= chunk.startOffset || start >= chunk.endOffset) return null;

  const localStart = clamp(start - chunk.startOffset, 0, chunk.textNode.length);
  const localEnd = clamp(end - chunk.startOffset, 0, chunk.textNode.length);
  return `${row.index}:${chunk.localStart}:${chunk.startOffset}:${localStart}:${localEnd}`;
}

function compareTokenRenderEntries(left: TokenRenderEntry, right: TokenRenderEntry): number {
  return left.start - right.start || left.sourceIndex - right.sourceIndex;
}

function tokenRenderEntryMaxEnds(entries: readonly TokenRenderEntry[]): number[] {
  const maxEnds: number[] = [];
  let maxEnd = 0;

  for (const entry of entries) {
    maxEnd = Math.max(maxEnd, entry.end);
    maxEnds.push(maxEnd);
  }

  return maxEnds;
}
