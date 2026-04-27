import type {
  DocumentSession,
  DocumentSessionChange,
  EditorTimingMeasurement,
} from "./documentSession";
import { resolveSelection } from "./selections";
import type { EditorDocument, EditorToken, EditorTokenStyle, TextEdit } from "./tokens";
import { buildHighlightRule, clamp, normalizeTokenStyle, serializeTokenStyle } from "./style-utils";

let editorInstanceCount = 0;

type CaretPositionResult = {
  readonly offsetNode: Node;
  readonly offset: number;
};

type DocumentWithCaretHitTesting = Document & {
  readonly caretPositionFromPoint?: (x: number, y: number) => CaretPositionResult | null;
  readonly caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

export function resetEditorInstanceCount(): void {
  editorInstanceCount = 0;
}

/** Minimal interface for the CSS Custom Highlight API registry. */
export interface HighlightRegistry {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

export type EditorSessionChangeHandler = (change: DocumentSessionChange) => void;

export type EditorSessionOptions = {
  readonly onChange?: EditorSessionChangeHandler;
};

let highlightRegistry: HighlightRegistry | undefined;

/**
 * Override the HighlightRegistry used by all Editor instances.
 * Useful for testing environments where CSS.highlights is unavailable.
 * Pass `undefined` to revert to the default `CSS.highlights`.
 */
export function setHighlightRegistry(registry: HighlightRegistry | undefined): void {
  highlightRegistry = registry;
}

function getHighlightRegistry(): HighlightRegistry {
  return highlightRegistry ?? CSS.highlights;
}

export class Editor {
  private el: HTMLPreElement;
  private readonly textNode: Text;
  private readonly highlightPrefix: string;
  private readonly styleEl: HTMLStyleElement;
  private highlightNames: string[] = [];
  private nextGroupId = 0;
  private session: DocumentSession | null = null;
  private sessionOptions: EditorSessionOptions = {};
  private trackedTokens: Array<{ start: number; end: number; styleKey: string; range: Range }> = [];
  private groups = new Map<
    string,
    { name: string; highlight: Highlight; style: EditorTokenStyle }
  >();

  constructor(container: HTMLElement) {
    this.el = document.createElement("pre");
    this.el.className = "editor";
    this.textNode = document.createTextNode("");
    this.highlightPrefix = `editor-token-${editorInstanceCount++}`;
    this.styleEl = document.createElement("style");

    this.el.appendChild(this.textNode);
    this.el.tabIndex = 0;
    this.el.spellcheck = false;
    document.head.appendChild(this.styleEl);
    container.appendChild(this.el);
    this.installEditingHandlers();
  }

  setContent(text: string): void {
    this.clearHighlights();
    this.textNode.data = text;
  }

  setTokens(tokens: readonly EditorToken[]): void {
    this.clearHighlights();

    const textLength = this.textNode.length;
    if (textLength === 0 || tokens.length === 0) return;

    for (const token of tokens) this.addTokenHighlight(token, textLength);

    this.rebuildStyleRules();
  }

  applyEdit(edit: TextEdit, tokens: readonly EditorToken[]): void {
    const { from, to, text } = edit;
    const deleteCount = to - from;
    const delta = text.length - deleteCount;

    // Update text — browser auto-adjusts all live Range objects on this node
    this.textNode.replaceData(from, deleteCount, text);

    const newTextLength = this.textNode.length;
    const newEditEnd = from + text.length;

    // Remove tracked tokens that overlapped the old edit region
    const dirtyGroupKeys = new Set<string>();
    const kept: typeof this.trackedTokens = [];

    for (const tracked of this.trackedTokens) {
      if (tracked.start < to && tracked.end > from) {
        const group = this.groups.get(tracked.styleKey);
        if (group) group.highlight.delete(tracked.range);
        dirtyGroupKeys.add(tracked.styleKey);
      } else {
        if (tracked.start >= to) {
          tracked.start += delta;
          tracked.end += delta;
        }
        kept.push(tracked);
      }
    }

    this.trackedTokens = kept;

    // Add new tokens that cover the edited region
    for (const token of tokens) {
      const start = clamp(token.start, 0, newTextLength);
      const end = clamp(token.end, start, newTextLength);
      if (start === end || start >= newEditEnd || end <= from) continue;

      const styleKey = this.addTokenHighlight(token, newTextLength);
      if (styleKey) dirtyGroupKeys.add(styleKey);
    }

    // Remove groups that are now empty
    for (const key of dirtyGroupKeys) {
      const group = this.groups.get(key);
      if (group && group.highlight.size === 0) {
        getHighlightRegistry().delete(group.name);
        this.highlightNames = this.highlightNames.filter((n) => n !== group.name);
        this.groups.delete(key);
      }
    }

    this.rebuildStyleRules();
  }

  setDocument(document: EditorDocument): void {
    this.setContent(document.text);
    this.setTokens(document.tokens ?? []);
  }

  attachSession(session: DocumentSession, options: EditorSessionOptions = {}): void {
    this.session = session;
    this.sessionOptions = options;
    this.el.contentEditable = "plaintext-only";
    this.setDocument({ text: session.getText(), tokens: session.getTokens() });
    this.syncDomSelection();
  }

  detachSession(): void {
    this.session = null;
    this.sessionOptions = {};
    this.el.removeAttribute("contenteditable");
  }

  clear(): void {
    this.detachSession();
    this.setContent("");
  }

  dispose(): void {
    this.detachSession();
    this.clearHighlights();
    this.styleEl.remove();
    this.el.remove();
  }

  private installEditingHandlers(): void {
    this.el.addEventListener("mousedown", this.handleMouseDown);
    this.el.addEventListener("beforeinput", this.handleBeforeInput);
    this.el.addEventListener("paste", this.handlePaste);
    this.el.addEventListener("keydown", this.handleKeyDown);
    this.el.addEventListener("keyup", this.syncSessionSelectionFromDom);
    this.el.addEventListener("mouseup", this.syncSessionSelectionFromDom);
  }

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this.session) return;
    if (event.detail >= 4) {
      this.selectFullDocument(event, "input.quadClick");
      return;
    }

    const offset = this.textOffsetFromMouseEvent(event);
    if (offset === null) return;

    if (event.detail === 3) {
      this.selectLineAtOffset(event, offset);
      return;
    }

    if (event.detail !== 2) return;

    this.selectWordAtOffset(event, offset);
  };

  private selectFullDocument(event: MouseEvent, timingName: string): void {
    if (!this.session) return;

    const start = nowMs();
    event.preventDefault();
    const change = this.session.setSelection(0, this.session.getSnapshot().length);
    this.applySessionChange(change, timingName, start);
  }

  private selectLineAtOffset(event: MouseEvent, offset: number): void {
    if (!this.session) return;

    const range = lineRangeAtOffset(this.session.getText(), offset);
    this.selectRange(event, range, "input.tripleClick");
  }

  private selectWordAtOffset(event: MouseEvent, offset: number): void {
    if (!this.session) return;

    const range = wordRangeAtOffset(this.session.getText(), offset);
    if (range.start === range.end) return;

    this.selectRange(event, range, "input.doubleClick");
  }

  private selectRange(
    event: MouseEvent,
    range: { readonly start: number; readonly end: number },
    timingName: string,
  ): void {
    if (!this.session) return;

    const start = nowMs();
    event.preventDefault();
    const change = this.session.setSelection(range.start, range.end);
    this.applySessionChange(change, timingName, start);
  }

  private handleBeforeInput = (event: InputEvent): void => {
    if (!this.session) return;

    const text = event.data ?? "";
    if (event.inputType !== "insertText" && event.inputType !== "insertLineBreak") return;

    const start = nowMs();
    const selectionChange = this.updateSessionSelectionFromDom();
    event.preventDefault();
    const inserted = event.inputType === "insertLineBreak" ? "\n" : text;
    this.applySessionChange(
      mergeChangeTimings(this.session.applyText(inserted), selectionChange),
      "input.beforeinput",
      start,
    );
  };

  private handlePaste = (event: ClipboardEvent): void => {
    if (!this.session) return;

    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.length === 0) return;

    const start = nowMs();
    const selectionChange = this.updateSessionSelectionFromDom();
    event.preventDefault();
    this.applySessionChange(
      mergeChangeTimings(this.session.applyText(text), selectionChange),
      "input.paste",
      start,
    );
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.session) return;

    if (this.handleUndoRedo(event)) return;
    if (event.key === "Backspace") {
      const start = nowMs();
      const selectionChange = this.updateSessionSelectionFromDom();
      event.preventDefault();
      this.applySessionChange(
        mergeChangeTimings(this.session.backspace(), selectionChange),
        "input.backspace",
        start,
      );
      return;
    }

    if (event.key !== "Delete") return;

    const start = nowMs();
    const selectionChange = this.updateSessionSelectionFromDom();
    event.preventDefault();
    this.applySessionChange(
      mergeChangeTimings(this.session.deleteSelection(), selectionChange),
      "input.delete",
      start,
    );
  };

  private handleUndoRedo(event: KeyboardEvent): boolean {
    if (!this.session) return false;
    if (!isUndoRedoEvent(event)) return false;

    event.preventDefault();
    const start = nowMs();
    const change = event.shiftKey ? this.session.redo() : this.session.undo();
    this.applySessionChange(change, event.shiftKey ? "input.redo" : "input.undo", start);
    return true;
  }

  private syncSessionSelectionFromDom = (): void => {
    if (!this.session) return;

    const start = nowMs();
    const change = this.updateSessionSelectionFromDom();
    if (!change) return;

    this.sessionOptions.onChange?.(appendTiming(change, "input.selection", start));
  };

  private updateSessionSelectionFromDom(): DocumentSessionChange | null {
    if (!this.session) return null;

    const readStart = nowMs();
    const offsets = this.readDomSelectionOffsets();
    if (!offsets) return null;

    return appendTiming(
      this.session.setSelection(offsets.anchorOffset, offsets.headOffset),
      "editor.readDomSelection",
      readStart,
    );
  }

  private applySessionChange(
    change: DocumentSessionChange,
    totalName = "editor.change",
    totalStart = nowMs(),
  ): void {
    let timedChange = change;
    const renderStart = nowMs();
    this.renderSessionChange(change);
    timedChange = appendTiming(timedChange, "editor.render", renderStart);

    const selectionStart = nowMs();
    this.syncDomSelection();
    timedChange = appendTiming(timedChange, "editor.syncDomSelection", selectionStart);
    this.sessionOptions.onChange?.(appendTiming(timedChange, totalName, totalStart));
  }

  private renderSessionChange(change: DocumentSessionChange): void {
    const edit = change.edits[0];
    if (change.kind === "selection" || change.kind === "none") return;
    if (change.kind === "edit" && edit && change.edits.length === 1) {
      this.applyEdit(edit, []);
      return;
    }

    this.setDocument({ text: change.text, tokens: [] });
  }

  private syncDomSelection(): void {
    if (!this.session) return;

    const selection = this.session.getSelections().selections[0];
    if (!selection) return;

    const resolved = resolveSelection(this.session.getSnapshot(), selection);
    const start = clamp(resolved.startOffset, 0, this.textNode.length);
    const end = clamp(resolved.endOffset, start, this.textNode.length);
    const range = document.createRange();
    range.setStart(this.textNode, start);
    range.setEnd(this.textNode, end);

    const domSelection = window.getSelection();
    domSelection?.removeAllRanges();
    domSelection?.addRange(range);
  }

  private readDomSelectionOffsets(): { anchorOffset: number; headOffset: number } | null {
    const selection = window.getSelection();
    if (!selection?.anchorNode || !selection.focusNode) return null;

    const anchorOffset = this.domBoundaryToTextOffset(selection.anchorNode, selection.anchorOffset);
    const headOffset = this.domBoundaryToTextOffset(selection.focusNode, selection.focusOffset);
    if (anchorOffset === null || headOffset === null) return null;

    return { anchorOffset, headOffset };
  }

  private domBoundaryToTextOffset(node: Node, offset: number): number | null {
    if (node === this.textNode) return clamp(offset, 0, this.textNode.length);
    if (node === this.el) return elementBoundaryToTextOffset(offset, this.textNode.length);
    if (this.el.contains(node)) return this.internalBoundaryToTextOffset(node, offset);
    return this.externalBoundaryToTextOffset(node, offset);
  }

  private textOffsetFromMouseEvent(event: MouseEvent): number | null {
    const documentWithCaret = this.el.ownerDocument as DocumentWithCaretHitTesting;
    const position = documentWithCaret.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (position) return this.domBoundaryToTextOffset(position.offsetNode, position.offset);

    const range = documentWithCaret.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (range) return this.domBoundaryToTextOffset(range.startContainer, range.startOffset);

    return null;
  }

  private internalBoundaryToTextOffset(node: Node, offset: number): number | null {
    if (!node.contains(this.textNode)) return null;

    const child = childContainingNode(node, this.textNode);
    const childIndex = child ? childNodeIndex(node, child) : -1;
    if (childIndex === -1) return null;

    return elementBoundaryToTextOffset(offset <= childIndex ? 0 : 1, this.textNode.length);
  }

  private externalBoundaryToTextOffset(node: Node, offset: number): number | null {
    if (node.contains(this.el)) {
      const child = childContainingNode(node, this.el);
      const childIndex = child ? childNodeIndex(node, child) : -1;
      if (childIndex === -1) return null;
      return elementBoundaryToTextOffset(offset <= childIndex ? 0 : 1, this.textNode.length);
    }

    const position = node.compareDocumentPosition(this.el);
    if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return 0;
    if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return this.textNode.length;
    return null;
  }

  private addTokenHighlight(token: EditorToken, textLength: number): string | null {
    const start = clamp(token.start, 0, textLength);
    const end = clamp(token.end, start, textLength);
    if (start === end) return null;

    const style = normalizeTokenStyle(token.style);
    if (!style) return null;

    const styleKey = serializeTokenStyle(style);

    if (!this.groups.has(styleKey)) {
      const name = `${this.highlightPrefix}-${this.nextGroupId++}`;
      this.groups.set(styleKey, { name, highlight: new Highlight(), style });
      getHighlightRegistry().set(name, this.groups.get(styleKey)!.highlight);
      this.highlightNames.push(name);
    }

    const group = this.groups.get(styleKey)!;
    const range = document.createRange();
    range.setStart(this.textNode, start);
    range.setEnd(this.textNode, end);
    group.highlight.add(range);
    this.trackedTokens.push({ start, end, styleKey, range });
    return styleKey;
  }

  private clearHighlights() {
    for (const name of this.highlightNames) getHighlightRegistry().delete(name);

    this.highlightNames = [];
    this.trackedTokens = [];
    this.groups.clear();
    this.nextGroupId = 0;
    this.styleEl.textContent = "";
  }

  private rebuildStyleRules() {
    const rules: string[] = [];
    for (const { name, style } of this.groups.values()) rules.push(buildHighlightRule(name, style));
    this.styleEl.textContent = rules.join("\n");
  }
}

function isUndoRedoEvent(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== "z") return false;
  return event.metaKey || event.ctrlKey;
}

function elementBoundaryToTextOffset(offset: number, textLength: number): number {
  if (offset <= 0) return 0;
  return textLength;
}

function childContainingNode(ancestor: Node, node: Node): ChildNode | null {
  for (const child of ancestor.childNodes) {
    if (child === node || child.contains(node)) return child;
  }

  return null;
}

function childNodeIndex(parent: Node, child: ChildNode): number {
  return Array.prototype.indexOf.call(parent.childNodes, child) as number;
}

function lineRangeAtOffset(text: string, rawOffset: number): { start: number; end: number } {
  const offset = clamp(rawOffset, 0, text.length);
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const nextLineBreak = text.indexOf("\n", offset);
  const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak;
  return { start: lineStart, end: lineEnd };
}

function wordRangeAtOffset(text: string, rawOffset: number): { start: number; end: number } {
  const offset = clamp(rawOffset, 0, text.length);
  const probeOffset = wordProbeOffset(text, offset);
  if (probeOffset === null) return { start: offset, end: offset };

  let start = probeOffset;
  let end = probeOffset + codePointSizeAt(text, probeOffset);

  while (start > 0) {
    const previous = previousCodePointStart(text, start);
    if (previous === null || !isWordCodePointAt(text, previous)) break;
    start = previous;
  }

  while (end < text.length && isWordCodePointAt(text, end)) end += codePointSizeAt(text, end);

  return { start, end };
}

function wordProbeOffset(text: string, offset: number): number | null {
  if (offset < text.length && isWordCodePointAt(text, offset)) return offset;

  const previous = previousCodePointStart(text, offset);
  if (previous !== null && isWordCodePointAt(text, previous)) return previous;

  return null;
}

function isWordCodePointAt(text: string, offset: number): boolean {
  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined) return false;
  return /^[\p{L}\p{N}_]$/u.test(String.fromCodePoint(codePoint));
}

function previousCodePointStart(text: string, offset: number): number | null {
  if (offset <= 0) return null;

  const previous = offset - 1;
  const codeUnit = text.charCodeAt(previous);
  const beforePrevious = previous - 1;
  const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
  if (!isLowSurrogate || beforePrevious < 0) return previous;

  const previousCodeUnit = text.charCodeAt(beforePrevious);
  const isHighSurrogate = previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff;
  return isHighSurrogate ? beforePrevious : previous;
}

function codePointSizeAt(text: string, offset: number): number {
  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined) return 0;
  return codePoint > 0xffff ? 2 : 1;
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function appendTiming(
  change: DocumentSessionChange,
  name: string,
  startMs: number,
): DocumentSessionChange {
  return {
    ...change,
    timings: [...change.timings, createTiming(name, startMs)],
  };
}

function mergeChangeTimings(
  change: DocumentSessionChange,
  earlierChange: DocumentSessionChange | null,
): DocumentSessionChange {
  if (!earlierChange) return change;
  return {
    ...change,
    timings: [...earlierChange.timings, ...change.timings],
  };
}

function createTiming(name: string, startMs: number): EditorTimingMeasurement {
  return { name, durationMs: nowMs() - startMs };
}
