import type { EditorToken, EditorTokenStyle } from "../tokens";
import {
  buildHighlightRule,
  clamp,
  normalizeTokenStyle,
  serializeTokenStyle,
} from "../style-utils";
import {
  FixedRowVirtualizer,
  type FixedRowVirtualItem,
  type FixedRowVirtualizerOptions,
  type FixedRowVirtualizerSnapshot,
  type FixedRowVisibleRange,
} from "./fixedRowVirtualizer";

type CaretPositionResult = {
  readonly offsetNode: Node;
  readonly offset: number;
};

type DocumentWithCaretHitTesting = Document & {
  readonly caretPositionFromPoint?: (x: number, y: number) => CaretPositionResult | null;
  readonly caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

export type VirtualizedTextViewOptions = {
  readonly rowHeight?: number;
  readonly overscan?: number;
  readonly className?: string;
  readonly gutterWidth?: number;
  readonly selectionHighlightName?: string;
  readonly highlightRegistry?: HighlightRegistry;
};

export type VirtualizedTextRow = {
  readonly index: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
  readonly element: HTMLDivElement;
  readonly textNode: Text;
};

export type VirtualizedTextViewState = {
  readonly lineCount: number;
  readonly contentWidth: number;
  readonly totalHeight: number;
  readonly visibleRange: FixedRowVisibleRange;
  readonly mountedRows: readonly VirtualizedTextRow[];
};

export interface HighlightRegistry {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

type TokenGroup = {
  readonly name: string;
  readonly highlight: Highlight;
  readonly style: EditorTokenStyle;
};

type MountedVirtualizedTextRow = VirtualizedTextRow & {
  readonly gutterElement: HTMLDivElement;
  readonly gutterLabelElement: HTMLSpanElement;
  readonly top: number;
  readonly height: number;
  readonly textRevision: number;
};

const DEFAULT_ROW_HEIGHT = 20;
const DEFAULT_OVERSCAN = 24;
// TODO: Size the gutter to the widest visible row marker instead of a constant.
const DEFAULT_GUTTER_WIDTH = 36;
const DEFAULT_SELECTION_HIGHLIGHT = "editor-virtualized-selection";

export class VirtualizedTextView {
  public readonly scrollElement: HTMLDivElement;
  public readonly inputElement: HTMLTextAreaElement;

  private readonly spacer: HTMLDivElement;
  private readonly gutterElement: HTMLDivElement;
  private readonly caretElement: HTMLDivElement;
  private readonly styleEl: HTMLStyleElement;
  private readonly virtualizer: FixedRowVirtualizer;
  private readonly rowElements = new Map<number, MountedVirtualizedTextRow>();
  private readonly highlightRegistry: HighlightRegistry | null;
  private readonly selectionHighlightName: string;
  private readonly selectionHighlight: Highlight | null;
  private selectionHighlightRegistered = false;
  private text = "";
  private textRevision = 0;
  private tokens: readonly EditorToken[] = [];
  private lineStarts: number[] = [0];
  private tokenGroups = new Map<string, TokenGroup>();
  private tokenHighlightNames: string[] = [];
  private nextTokenGroupId = 0;
  private selectionStart: number | null = null;
  private selectionEnd: number | null = null;
  private lastRenderedRowsKey = "";
  private contentWidth = 0;
  private maxVisualColumnsSeen = 0;
  private lastWidthScanStart = 0;
  private lastWidthScanEnd = -1;

  public constructor(container: HTMLElement, options: VirtualizedTextViewOptions = {}) {
    const rowHeight = options.rowHeight ?? DEFAULT_ROW_HEIGHT;
    const overscan = options.overscan ?? DEFAULT_OVERSCAN;
    const gutterWidth = normalizeGutterWidth(options.gutterWidth);

    this.highlightRegistry = options.highlightRegistry ?? getDefaultHighlightRegistry();
    this.selectionHighlightName = options.selectionHighlightName ?? DEFAULT_SELECTION_HIGHLIGHT;
    this.selectionHighlight = createHighlight();
    this.styleEl = container.ownerDocument.createElement("style");
    this.scrollElement = createScrollElement(container, options.className);
    this.inputElement = createInputElement(container);
    this.spacer = container.ownerDocument.createElement("div");
    this.gutterElement = container.ownerDocument.createElement("div");
    this.caretElement = container.ownerDocument.createElement("div");
    this.virtualizer = new FixedRowVirtualizer(createVirtualizerOptions(rowHeight, overscan));

    this.scrollElement.style.setProperty("--editor-gutter-width", `${gutterWidth}px`);
    this.spacer.className = "editor-virtualized-spacer";
    this.gutterElement.className = "editor-virtualized-gutter";
    this.caretElement.className = "editor-virtualized-caret";
    this.caretElement.hidden = true;
    this.spacer.appendChild(this.gutterElement);
    this.spacer.appendChild(this.caretElement);
    this.scrollElement.appendChild(this.spacer);
    this.scrollElement.appendChild(this.inputElement);
    container.ownerDocument.head.appendChild(this.styleEl);

    this.virtualizer.attachScrollElement(this.scrollElement, (snapshot) => {
      this.renderSnapshot(snapshot);
    });
    this.rebuildStyleRules();
  }

  public dispose(): void {
    this.clearSelectionHighlight();
    this.clearTokenHighlights();
    this.virtualizer.dispose();
    this.scrollElement.remove();
    this.styleEl.remove();
    this.rowElements.clear();
  }

  public setText(text: string): void {
    this.text = text;
    this.textRevision += 1;
    this.lineStarts = computeLineStarts(text);
    this.clampStoredSelection();
    this.lastRenderedRowsKey = "";
    this.resetContentWidthScan();
    this.virtualizer.updateOptions({ count: this.lineStarts.length });
  }

  public setTokens(tokens: readonly EditorToken[]): void {
    this.tokens = [...tokens];
    this.syncTokenGroupsToTokenSet();
    this.renderTokenHighlights();
  }

  public setEditable(editable: boolean): void {
    if (editable) {
      this.inputElement.readOnly = false;
      return;
    }

    this.inputElement.readOnly = true;
  }

  public focusInput(): void {
    if (this.inputElement.readOnly) return;

    this.inputElement.value = "";
    this.inputElement.focus({ preventScroll: true });
  }

  public setScrollMetrics(scrollTop: number, viewportHeight: number): void {
    this.virtualizer.setScrollMetrics({ scrollTop, viewportHeight });
  }

  public scrollToRow(row: number): void {
    const target = clamp(Math.floor(row), 0, this.lineStarts.length - 1);
    this.scrollElement.scrollTop = target * this.getRowHeight();
    this.virtualizer.setScrollMetrics({
      scrollTop: this.scrollElement.scrollTop,
      viewportHeight: this.scrollElement.clientHeight,
    });
  }

  public createRange(startOffset: number, endOffset: number): Range | null {
    this.ensureOffsetMounted(startOffset);

    const start = this.resolveMountedOffset(startOffset);
    const end = this.resolveMountedOffset(endOffset);
    if (!start || !end) return null;

    const range = this.scrollElement.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  public getState(): VirtualizedTextViewState {
    const snapshot = this.virtualizer.getSnapshot();
    return {
      lineCount: this.lineStarts.length,
      contentWidth: this.contentWidth,
      totalHeight: snapshot.totalSize,
      visibleRange: snapshot.visibleRange,
      mountedRows: this.getMountedRows(),
    };
  }

  public textOffsetFromPoint(clientX: number, clientY: number): number | null {
    const documentWithCaret = this.scrollElement.ownerDocument as DocumentWithCaretHitTesting;
    const position = documentWithCaret.caretPositionFromPoint?.(clientX, clientY);
    if (position) return this.textOffsetFromDomBoundary(position.offsetNode, position.offset);

    const range = documentWithCaret.caretRangeFromPoint?.(clientX, clientY);
    if (!range) return null;
    return this.textOffsetFromDomBoundary(range.startContainer, range.startOffset);
  }

  public textOffsetFromViewportPoint(clientX: number, clientY: number): number {
    const metrics = this.viewportPointMetrics(clientX, clientY);
    if (metrics.verticalDirection < 0) return this.lineStartOffset(this.rowForViewportY(metrics.y));
    if (metrics.verticalDirection > 0) return this.lineEndOffset(this.rowForViewportY(metrics.y));

    const row = this.rowForViewportY(metrics.y);
    const column = Math.floor(metrics.x / this.estimatedCharacterWidth());
    return this.lineStartOffset(row) + clamp(column, 0, this.lineText(row).length);
  }

  public textOffsetFromDomBoundary(node: Node, offset: number): number | null {
    const row = this.rowFromDomBoundary(node);
    if (!row) return null;
    if (node === row.element) return this.rowElementBoundaryToOffset(row, offset);
    if (node === row.textNode) return this.rowTextBoundaryToOffset(row, offset);
    if (!row.element.contains(node)) return null;
    return this.rowTextBoundaryToOffset(row, row.textNode.length);
  }

  public setSelection(anchorOffset: number, headOffset: number): void {
    this.selectionStart = clamp(Math.min(anchorOffset, headOffset), 0, this.text.length);
    this.selectionEnd = clamp(
      Math.max(anchorOffset, headOffset),
      this.selectionStart,
      this.text.length,
    );
    this.renderSelectionHighlight();
  }

  public clearSelection(): void {
    this.selectionStart = null;
    this.selectionEnd = null;
    this.clearSelectionHighlight();
    this.renderCaret();
  }

  private renderSnapshot(snapshot: FixedRowVirtualizerSnapshot): void {
    const rowsKey = snapshotRowsKey(snapshot);
    if (rowsKey === this.lastRenderedRowsKey) return;

    this.lastRenderedRowsKey = rowsKey;
    this.spacer.style.height = `${snapshot.totalSize}px`;
    this.gutterElement.style.height = `${snapshot.totalSize}px`;
    this.updateContentWidth(snapshot.virtualItems);
    this.clearMountedHighlightRanges();
    this.reconcileRows(snapshot.virtualItems);
    this.renderTokenHighlights();
    this.renderSelectionHighlight();
    this.renderCaret();
  }

  private reconcileRows(items: readonly FixedRowVirtualItem[]): void {
    const reusableRows = this.releaseRowsOutside(items);
    for (const item of items) {
      this.mountOrUpdateRow(item, reusableRows);
    }

    this.removeReusableRows(reusableRows);
  }

  private mountOrUpdateRow(
    item: FixedRowVirtualItem,
    reusableRows: MountedVirtualizedTextRow[],
  ): void {
    const existing = this.rowElements.get(item.index);
    if (existing) {
      this.updateRow(existing, item);
      return;
    }

    const row = reusableRows.shift() ?? this.createRow();
    this.updateRow(row, item);
    this.rowElements.set(item.index, row);
  }

  private createRow(): MountedVirtualizedTextRow {
    const document = this.scrollElement.ownerDocument;
    const element = document.createElement("div");
    const gutterElement = document.createElement("div");
    const gutterLabelElement = document.createElement("span");
    const textNode = document.createTextNode("");

    element.className = "editor-virtualized-row";
    gutterElement.className = "editor-virtualized-gutter-row";
    gutterLabelElement.className = "editor-virtualized-gutter-label editor-virtualized-line-number";
    gutterLabelElement.setAttribute("aria-hidden", "true");
    gutterElement.appendChild(gutterLabelElement);
    element.appendChild(textNode);
    this.gutterElement.appendChild(gutterElement);
    this.spacer.appendChild(element);

    return {
      index: -1,
      startOffset: 0,
      endOffset: 0,
      text: "",
      top: Number.NaN,
      height: Number.NaN,
      textRevision: -1,
      element,
      gutterElement,
      gutterLabelElement,
      textNode,
    };
  }

  private updateRow(row: MountedVirtualizedTextRow, item: FixedRowVirtualItem): void {
    if (this.isRowCurrent(row, item)) return;

    const text = this.lineText(item.index);
    const startOffset = this.lineStartOffset(item.index);
    const endOffset = this.lineEndOffset(item.index);

    this.updateRowElement(row, item, text);
    updateMutableRow(row, {
      endOffset,
      height: item.size,
      index: item.index,
      startOffset,
      text,
      textRevision: this.textRevision,
      top: item.start,
    });
  }

  private updateRowElement(
    row: MountedVirtualizedTextRow,
    item: FixedRowVirtualItem,
    text: string,
  ): void {
    if (row.index !== item.index) row.element.dataset.editorVirtualRow = String(item.index);
    this.updateGutterRowElement(row, item);
    if (row.height !== item.size) {
      row.element.style.height = `${item.size}px`;
      row.element.style.lineHeight = `${item.size}px`;
    }
    if (row.top !== item.start) {
      row.element.style.transform = `translate3d(0, ${item.start}px, 0)`;
    }
    if (row.text !== text) row.textNode.data = text;
  }

  private updateGutterRowElement(row: MountedVirtualizedTextRow, item: FixedRowVirtualItem): void {
    if (row.index !== item.index) {
      row.gutterElement.dataset.editorVirtualGutterRow = String(item.index);
      row.gutterLabelElement.style.counterSet = `editor-line ${item.index + 1}`;
    }
    if (row.height !== item.size) {
      row.gutterElement.style.height = `${item.size}px`;
      row.gutterElement.style.lineHeight = `${item.size}px`;
    }
    if (row.top !== item.start) {
      row.gutterElement.style.transform = `translate3d(0, ${item.start}px, 0)`;
    }
  }

  private isRowCurrent(row: MountedVirtualizedTextRow, item: FixedRowVirtualItem): boolean {
    return (
      row.index === item.index &&
      row.top === item.start &&
      row.height === item.size &&
      row.textRevision === this.textRevision
    );
  }

  private releaseRowsOutside(items: readonly FixedRowVirtualItem[]): MountedVirtualizedTextRow[] {
    const mounted = new Set(items.map((item) => item.index));
    const reusableRows: MountedVirtualizedTextRow[] = [];
    for (const [index, row] of this.rowElements) {
      if (mounted.has(index)) continue;
      this.rowElements.delete(index);
      reusableRows.push(row);
    }

    return reusableRows;
  }

  private removeReusableRows(rows: readonly MountedVirtualizedTextRow[]): void {
    for (const row of rows) removeRowElements(row);
  }

  private resetContentWidthScan(): void {
    this.contentWidth = 0;
    this.maxVisualColumnsSeen = 0;
    this.lastWidthScanStart = 0;
    this.lastWidthScanEnd = -1;
  }

  private updateContentWidth(items: readonly FixedRowVirtualItem[]): void {
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) {
      this.applyContentWidth(0);
      return;
    }

    this.scanVisualWidthRange(first.index, last.index);
    this.applyContentWidth(this.maxVisualColumnsSeen);
  }

  private scanVisualWidthRange(startIndex: number, endIndex: number): void {
    const overlapsLastScan = rangesIntersectInclusive(
      startIndex,
      endIndex,
      this.lastWidthScanStart,
      this.lastWidthScanEnd,
    );
    if (!overlapsLastScan) {
      this.scanVisualColumns(startIndex, endIndex);
      this.lastWidthScanStart = startIndex;
      this.lastWidthScanEnd = endIndex;
      return;
    }

    if (startIndex < this.lastWidthScanStart) {
      this.scanVisualColumns(startIndex, this.lastWidthScanStart - 1);
    }
    if (endIndex > this.lastWidthScanEnd) {
      this.scanVisualColumns(this.lastWidthScanEnd + 1, endIndex);
    }

    this.lastWidthScanStart = startIndex;
    this.lastWidthScanEnd = endIndex;
  }

  private scanVisualColumns(startIndex: number, endIndex: number): void {
    for (let row = startIndex; row <= endIndex; row += 1) {
      this.maxVisualColumnsSeen = Math.max(
        this.maxVisualColumnsSeen,
        visualColumn(this.lineText(row)),
      );
    }
  }

  private applyContentWidth(visualColumns: number): void {
    const charWidth = this.estimatedCharacterWidth();
    const width = Math.ceil(Math.max(charWidth, visualColumns * charWidth));
    if (width === this.contentWidth) return;

    this.contentWidth = width;
    this.spacer.style.width = `${width + this.gutterWidth()}px`;
  }

  private getMountedRows(): readonly VirtualizedTextRow[] {
    return [...this.rowElements.values()].sort((a, b) => a.index - b.index);
  }

  private rowFromDomBoundary(node: Node): VirtualizedTextRow | null {
    const element = rowElementFromNode(node, this.scrollElement);
    if (!element) return null;

    const rowIndex = Number(element.dataset.editorVirtualRow);
    if (!Number.isInteger(rowIndex)) return null;
    return this.rowElements.get(rowIndex) ?? null;
  }

  private rowElementBoundaryToOffset(row: VirtualizedTextRow, offset: number): number {
    if (offset <= 0) return row.startOffset;
    return row.endOffset;
  }

  private rowTextBoundaryToOffset(row: VirtualizedTextRow, offset: number): number {
    return row.startOffset + clamp(offset, 0, row.textNode.length);
  }

  private ensureOffsetMounted(offset: number): void {
    if (this.resolveMountedOffset(offset)) return;
    this.scrollToRow(this.rowForOffset(offset));
  }

  private resolveMountedOffset(
    offset: number,
  ): { readonly node: Text; readonly offset: number } | null {
    const clamped = clamp(offset, 0, this.text.length);
    for (const row of this.getMountedRows()) {
      if (clamped < row.startOffset || clamped > row.endOffset) continue;
      return {
        node: row.textNode,
        offset: clamp(clamped - row.startOffset, 0, row.textNode.length),
      };
    }

    return null;
  }

  private addMountedSelectionRanges(start: number, end: number): void {
    for (const row of this.getMountedRows()) {
      this.addMountedSelectionRange(row, start, end);
    }
  }

  private addMountedSelectionRange(row: VirtualizedTextRow, start: number, end: number): void {
    if (!this.selectionHighlight) return;
    if (end <= row.startOffset || start >= row.endOffset) return;

    const range = this.scrollElement.ownerDocument.createRange();
    range.setStart(row.textNode, clamp(start - row.startOffset, 0, row.textNode.length));
    range.setEnd(row.textNode, clamp(end - row.startOffset, 0, row.textNode.length));
    this.selectionHighlight.add(range);
  }

  private clearSelectionHighlight(): void {
    this.selectionHighlight?.clear();
    if (!this.selectionHighlightRegistered || !this.highlightRegistry) return;

    this.highlightRegistry.delete(this.selectionHighlightName);
    this.selectionHighlightRegistered = false;
  }

  private renderSelectionHighlight(): void {
    const selectionRange = this.selectionRange();

    this.clearSelectionHighlightRanges();
    this.renderCaret();
    if (!selectionRange) {
      this.clearSelectionHighlight();
      return;
    }
    if (!this.selectionHighlight || !this.highlightRegistry) return;

    this.addMountedSelectionRanges(selectionRange.start, selectionRange.end);
    if (this.selectionHighlight.size === 0) return;

    this.ensureSelectionHighlightRegistered();
  }

  private renderCaret(): void {
    if (this.selectionEnd === null || this.selectionStart !== this.selectionEnd) {
      this.caretElement.hidden = true;
      return;
    }

    const position = this.caretPosition(this.selectionEnd);
    if (!position) {
      this.caretElement.hidden = true;
      return;
    }

    this.caretElement.hidden = false;
    this.caretElement.style.height = `${position.height}px`;
    this.caretElement.style.transform = `translate(${position.left}px, ${position.top}px)`;
  }

  private clampStoredSelection(): void {
    if (this.selectionStart === null || this.selectionEnd === null) return;

    this.selectionStart = clamp(this.selectionStart, 0, this.text.length);
    this.selectionEnd = clamp(this.selectionEnd, this.selectionStart, this.text.length);
  }

  private renderTokenHighlights(): void {
    this.clearTokenHighlightRanges();
    if (!this.highlightRegistry) return;
    if (this.tokens.length === 0) return;
    if (this.text.length === 0) return;

    const mountedRange = this.mountedOffsetRange();
    if (!mountedRange) return;

    for (const token of this.tokens) {
      if (!rangesIntersect(token.start, token.end, mountedRange.start, mountedRange.end)) continue;
      this.addTokenRanges(token);
    }

    this.rebuildStyleRules();
  }

  private addTokenRanges(token: EditorToken): void {
    const style = normalizeTokenStyle(token.style);
    if (!style) return;

    const rows = this.mountedRowsIntersecting(token.start, token.end);
    if (rows.length === 0) return;

    const group = this.ensureTokenGroup(style);
    if (!group) return;

    for (const row of rows) {
      this.addTokenRangeToRow(group.highlight, token, row);
    }
  }

  private mountedRowsIntersecting(start: number, end: number): readonly VirtualizedTextRow[] {
    const normalizedStart = clamp(start, 0, this.text.length);
    const normalizedEnd = clamp(end, normalizedStart, this.text.length);
    return this.getMountedRows().filter((row) => {
      return normalizedEnd > row.startOffset && normalizedStart < row.endOffset;
    });
  }

  private addTokenRangeToRow(
    highlight: Highlight,
    token: EditorToken,
    row: VirtualizedTextRow,
  ): void {
    const start = clamp(token.start, 0, this.text.length);
    const end = clamp(token.end, start, this.text.length);
    if (end <= row.startOffset || start >= row.endOffset) return;

    const range = this.scrollElement.ownerDocument.createRange();
    range.setStart(row.textNode, clamp(start - row.startOffset, 0, row.textNode.length));
    range.setEnd(row.textNode, clamp(end - row.startOffset, 0, row.textNode.length));
    highlight.add(range);
  }

  private ensureTokenGroup(style: EditorTokenStyle): TokenGroup | null {
    const styleKey = serializeTokenStyle(style);
    const existing = this.tokenGroups.get(styleKey);
    if (existing) return existing;

    const name = `${this.selectionHighlightName}-token-${this.nextTokenGroupId++}`;
    const highlight = createHighlight();
    if (!highlight) return null;

    const group = { name, highlight, style };
    this.tokenGroups.set(styleKey, group);
    this.tokenHighlightNames.push(name);
    this.highlightRegistry?.set(name, group.highlight);
    return group;
  }

  private clearTokenHighlights(): void {
    for (const name of this.tokenHighlightNames) {
      this.highlightRegistry?.delete(name);
    }

    this.tokenGroups.clear();
    this.tokenHighlightNames = [];
    this.nextTokenGroupId = 0;
    this.rebuildStyleRules();
  }

  private syncTokenGroupsToTokenSet(): void {
    const styleKeys = this.currentTokenStyleKeys();
    if (styleKeys.size === 0 || this.text.length === 0) {
      this.clearTokenHighlights();
      return;
    }

    this.removeUnusedTokenGroups(styleKeys);
  }

  private currentTokenStyleKeys(): Set<string> {
    const styleKeys = new Set<string>();
    for (const token of this.tokens) {
      const style = normalizeTokenStyle(token.style);
      if (!style) continue;
      styleKeys.add(serializeTokenStyle(style));
    }

    return styleKeys;
  }

  private removeUnusedTokenGroups(styleKeys: ReadonlySet<string>): void {
    let removed = false;
    for (const [styleKey, group] of this.tokenGroups) {
      if (styleKeys.has(styleKey)) continue;

      this.highlightRegistry?.delete(group.name);
      this.tokenGroups.delete(styleKey);
      removed = true;
    }

    if (!removed) return;

    this.tokenHighlightNames = this.tokenHighlightNames.filter((name) => {
      return [...this.tokenGroups.values()].some((group) => group.name === name);
    });
    this.rebuildStyleRules();
  }

  private clearMountedHighlightRanges(): void {
    this.clearTokenHighlightRanges();
    this.clearSelectionHighlightRanges();
  }

  private clearTokenHighlightRanges(): void {
    for (const group of this.tokenGroups.values()) {
      group.highlight.clear();
    }
  }

  private clearSelectionHighlightRanges(): void {
    this.selectionHighlight?.clear();
  }

  private ensureSelectionHighlightRegistered(): void {
    if (this.selectionHighlightRegistered) return;
    if (!this.selectionHighlight || !this.highlightRegistry) return;

    this.highlightRegistry.set(this.selectionHighlightName, this.selectionHighlight);
    this.selectionHighlightRegistered = true;
  }

  private selectionRange(): { readonly start: number; readonly end: number } | null {
    if (this.selectionStart === null || this.selectionEnd === null) return null;
    if (this.selectionStart === this.selectionEnd) return null;

    return {
      start: this.selectionStart,
      end: this.selectionEnd,
    };
  }

  private rebuildStyleRules(): void {
    const rules = [
      `::highlight(${this.selectionHighlightName}) { background-color: rgba(56, 189, 248, 0.35); }`,
    ];
    for (const group of this.tokenGroups.values()) {
      rules.push(buildHighlightRule(group.name, group.style));
    }

    this.styleEl.textContent = rules.join("\n");
  }

  private lineStartOffset(row: number): number {
    return this.lineStarts[row] ?? this.text.length;
  }

  private lineEndOffset(row: number): number {
    const nextLineStart = this.lineStarts[row + 1];
    if (nextLineStart === undefined) return this.text.length;
    return Math.max(this.lineStartOffset(row), nextLineStart - 1);
  }

  private lineText(row: number): string {
    return this.text.slice(this.lineStartOffset(row), this.lineEndOffset(row));
  }

  private rowForOffset(offset: number): number {
    const clamped = clamp(offset, 0, this.text.length);
    let low = 0;
    let high = this.lineStarts.length - 1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const start = this.lineStartOffset(middle);
      const next = this.lineStartOffset(middle + 1);
      if (clamped < start) {
        high = middle - 1;
        continue;
      }
      if (clamped >= next && middle + 1 < this.lineStarts.length) {
        low = middle + 1;
        continue;
      }
      return middle;
    }

    return this.lineStarts.length - 1;
  }

  private rowForViewportY(y: number): number {
    const row = Math.floor((this.scrollElement.scrollTop + y) / this.getRowHeight());
    return clamp(row, 0, this.lineStarts.length - 1);
  }

  private viewportPointMetrics(
    clientX: number,
    clientY: number,
  ): { readonly x: number; readonly y: number; readonly verticalDirection: number } {
    const rect = this.scrollElement.getBoundingClientRect();
    const padding = scrollElementPadding(this.scrollElement);
    const left = rect.left + padding.left;
    const top = rect.top + padding.top;
    const right = Math.max(left, rect.right - padding.right);
    const bottom = Math.max(top, rect.bottom - padding.bottom);

    return {
      x: this.viewportTextX(clientX, left, right),
      y: clamp(clientY, top, Math.max(top, bottom - 1)) - top,
      verticalDirection: pointVerticalDirection(clientY, top, bottom),
    };
  }

  private viewportTextX(clientX: number, left: number, right: number): number {
    const viewportX = clamp(clientX, left, right) - left;
    const scrolledX = viewportX + this.scrollElement.scrollLeft;
    return Math.max(0, scrolledX - this.gutterWidth());
  }

  private estimatedCharacterWidth(): number {
    const style = this.scrollElement.ownerDocument.defaultView?.getComputedStyle(
      this.scrollElement,
    );
    const fontSize = parseCssPixels(style?.fontSize) ?? 13;
    return Math.max(1, fontSize * 0.6);
  }

  private getRowHeight(): number {
    const row = this.virtualizer.getSnapshot().virtualItems[0];
    return row?.size ?? DEFAULT_ROW_HEIGHT;
  }

  private gutterWidth(): number {
    const value = this.scrollElement.style.getPropertyValue("--editor-gutter-width");
    return parseCssPixels(value) ?? DEFAULT_GUTTER_WIDTH;
  }

  private mountedOffsetRange(): { readonly start: number; readonly end: number } | null {
    const rows = this.getMountedRows();
    const first = rows[0];
    const last = rows.at(-1);
    if (!first || !last) return null;

    return {
      start: first.startOffset,
      end: last.endOffset,
    };
  }

  private caretPosition(offset: number): {
    readonly left: number;
    readonly top: number;
    readonly height: number;
  } | null {
    const rowIndex = this.rowForOffset(offset);
    const row = this.rowElements.get(rowIndex);
    if (!row) return null;

    const columnText = this.text.slice(row.startOffset, offset);
    return {
      left: this.gutterWidth() + visualColumn(columnText) * this.estimatedCharacterWidth(),
      top: rowIndex * this.getRowHeight(),
      height: this.getRowHeight(),
    };
  }
}

function normalizeGutterWidth(width: number | undefined): number {
  if (width === undefined) return DEFAULT_GUTTER_WIDTH;
  if (!Number.isFinite(width) || width < 0) return DEFAULT_GUTTER_WIDTH;
  return width;
}

function createVirtualizerOptions(rowHeight: number, overscan: number): FixedRowVirtualizerOptions {
  return {
    count: 1,
    rowHeight,
    overscan,
    enabled: true,
  };
}

function snapshotRowsKey(snapshot: FixedRowVirtualizerSnapshot): string {
  const first = snapshot.virtualItems[0];
  const last = snapshot.virtualItems.at(-1);
  return `${snapshot.totalSize}:${first?.index ?? -1}:${last?.index ?? -1}:${snapshot.virtualItems.length}`;
}

function createScrollElement(
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

function createInputElement(container: HTMLElement): HTMLTextAreaElement {
  const input = container.ownerDocument.createElement("textarea");
  input.className = "editor-virtualized-input";
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.readOnly = true;
  input.spellcheck = false;
  input.setAttribute("aria-label", "Editor input");
  return input;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  let index = text.indexOf("\n");

  while (index !== -1) {
    starts.push(index + 1);
    index = text.indexOf("\n", index + 1);
  }

  return starts;
}

function rowElementFromNode(node: Node, boundary: HTMLElement): HTMLDivElement | null {
  if (node instanceof HTMLDivElement && node.dataset.editorVirtualRow !== undefined) return node;
  if (!(node.parentElement instanceof HTMLElement)) return null;

  const element = node.parentElement.closest<HTMLDivElement>("[data-editor-virtual-row]");
  if (!element || !boundary.contains(element)) return null;
  return element;
}

function updateMutableRow(
  row: MountedVirtualizedTextRow,
  values: {
    readonly index: number;
    readonly startOffset: number;
    readonly endOffset: number;
    readonly text: string;
    readonly top: number;
    readonly height: number;
    readonly textRevision: number;
  },
): void {
  const mutable = row as {
    index: number;
    startOffset: number;
    endOffset: number;
    text: string;
    top: number;
    height: number;
    textRevision: number;
  };
  mutable.index = values.index;
  mutable.startOffset = values.startOffset;
  mutable.endOffset = values.endOffset;
  mutable.text = values.text;
  mutable.top = values.top;
  mutable.height = values.height;
  mutable.textRevision = values.textRevision;
}

function removeRowElements(row: MountedVirtualizedTextRow): void {
  row.element.remove();
  row.gutterElement.remove();
}

function scrollElementPadding(element: HTMLElement): {
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

function parseCssPixels(value: string | undefined): number | null {
  if (!value) return null;

  const pixels = Number.parseFloat(value);
  if (!Number.isFinite(pixels)) return null;
  return pixels;
}

function pointVerticalDirection(clientY: number, top: number, bottom: number): number {
  if (clientY < top) return -1;
  if (clientY >= bottom) return 1;
  return 0;
}

function getDefaultHighlightRegistry(): HighlightRegistry | null {
  const css = globalThis.CSS as { highlights?: HighlightRegistry } | undefined;
  return css?.highlights ?? null;
}

function createHighlight(): Highlight | null {
  if (typeof Highlight === "undefined") return null;
  return new Highlight();
}

function rangesIntersect(startA: number, endA: number, startB: number, endB: number): boolean {
  return endA > startB && startA < endB;
}

function rangesIntersectInclusive(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): boolean {
  return endA >= startB && startA <= endB;
}

function visualColumn(text: string): number {
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
