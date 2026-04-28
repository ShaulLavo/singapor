import type {
  DocumentSession,
  DocumentSessionChange,
  EditorTimingMeasurement,
} from "./documentSession";
import { createDocumentSession } from "./documentSession";
import { offsetToPoint } from "./pieceTable";
import { resolveSelection } from "./selections";
import {
  createEditorSyntaxSession,
  inferEditorSyntaxLanguage,
  type EditorSyntaxLanguageId,
  type EditorSyntaxResult,
  type EditorSyntaxSession,
  type EditorSyntaxSessionOptions,
} from "./syntax";
import type { EditorDocument, EditorToken, TextEdit } from "./tokens";
import { clamp } from "./style-utils";
import { VirtualizedTextView } from "./virtualization";

let editorInstanceCount = 0;

type MouseSelectionDrag = {
  readonly anchorOffset: number;
  headOffset: number;
  clientX: number;
  clientY: number;
};

const MOUSE_SELECTION_SCROLL_ZONE_PX = 40;
const MOUSE_SELECTION_MAX_SCROLL_PX = 24;
const MOUSE_SELECTION_MIN_SCROLL_PX = 2;

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

export type EditorSyntaxStatus = "plain" | "loading" | "ready" | "error";

export type EditorState = {
  readonly documentId: string | null;
  readonly languageId: EditorSyntaxLanguageId | null;
  readonly syntaxStatus: EditorSyntaxStatus;
  readonly cursor: {
    readonly row: number;
    readonly column: number;
  };
  readonly length: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
};

export type EditorChangeHandler = (
  state: EditorState,
  change: DocumentSessionChange | null,
) => void;

export type EditorOptions = {
  readonly onChange?: EditorChangeHandler;
};

export type EditorOpenDocumentOptions = {
  readonly text: string;
  readonly documentId?: string;
  readonly languageId?: EditorSyntaxLanguageId | null;
};

export type EditorSyntaxSessionFactory = (
  options: EditorSyntaxSessionOptions,
) => EditorSyntaxSession;

let editorSyntaxSessionFactory: EditorSyntaxSessionFactory = createEditorSyntaxSession;

let highlightRegistry: HighlightRegistry | undefined;

/**
 * Override the HighlightRegistry used by all Editor instances.
 * Useful for testing environments where CSS.highlights is unavailable.
 * Pass `undefined` to revert to the default `CSS.highlights`.
 */
export function setHighlightRegistry(registry: HighlightRegistry | undefined): void {
  highlightRegistry = registry;
}

export function setEditorSyntaxSessionFactory(
  factory: EditorSyntaxSessionFactory | undefined,
): void {
  editorSyntaxSessionFactory = factory ?? createEditorSyntaxSession;
}

function getHighlightRegistry(): HighlightRegistry | undefined {
  return highlightRegistry ?? globalThis.CSS?.highlights;
}

export class Editor {
  private readonly view: VirtualizedTextView;
  private readonly el: HTMLDivElement;
  private readonly options: EditorOptions;
  private readonly highlightPrefix: string;
  private text = "";
  private session: DocumentSession | null = null;
  private sessionOptions: EditorSessionOptions = {};
  private documentId: string | null = null;
  private languageId: EditorSyntaxLanguageId | null = null;
  private syntaxStatus: EditorSyntaxStatus = "plain";
  private syntaxSession: EditorSyntaxSession | null = null;
  private tokens: readonly EditorToken[] = [];
  private documentVersion = 0;
  private syntaxVersion = 0;
  private mouseSelectionDrag: MouseSelectionDrag | null = null;
  private mouseSelectionAutoScrollFrame = 0;
  private useSessionSelectionForNextInput = false;
  private nativeInputGeneration = 0;

  constructor(container: HTMLElement, options: EditorOptions = {}) {
    this.options = options;
    this.highlightPrefix = `editor-token-${editorInstanceCount++}`;
    this.view = new VirtualizedTextView(container, {
      className: "editor",
      highlightRegistry: getHighlightRegistry(),
      selectionHighlightName: `${this.highlightPrefix}-selection`,
    });
    this.el = this.view.scrollElement;
    this.installEditingHandlers();
  }

  setContent(text: string): void {
    this.text = text;
    this.view.setText(text);
    this.setTokens([]);
  }

  setTokens(tokens: readonly EditorToken[]): void {
    this.tokens = [...tokens];
    this.view.setTokens(this.tokens);
  }

  applyEdit(edit: TextEdit, tokens: readonly EditorToken[]): void {
    const { from, to, text } = edit;
    this.text = `${this.text.slice(0, from)}${text}${this.text.slice(to)}`;
    this.view.applyEdit(edit, this.text);
    this.setTokens(tokens);
  }

  setDocument(document: EditorDocument): void {
    this.setContent(document.text);
    this.setTokens(document.tokens ?? []);
  }

  openDocument(document: EditorOpenDocumentOptions): void {
    const documentVersion = this.resetOwnedDocument(document);
    this.notifyChange(null);
    this.refreshSyntax(documentVersion, null);
  }

  clearDocument(): void {
    this.clear();
    this.notifyChange(null);
  }

  getState(): EditorState {
    const snapshot = this.session?.getSnapshot();
    const length = snapshot?.length ?? this.text.length;
    const selection = this.session?.getSelections().selections[0];
    const resolved = snapshot && selection ? resolveSelection(snapshot, selection) : null;
    const point = snapshot ? offsetToPoint(snapshot, resolved?.headOffset ?? length) : null;

    return {
      documentId: this.documentId,
      languageId: this.languageId,
      syntaxStatus: this.syntaxStatus,
      cursor: {
        row: point?.row ?? 0,
        column: point?.column ?? 0,
      },
      length,
      canUndo: this.session?.canUndo() ?? false,
      canRedo: this.session?.canRedo() ?? false,
    };
  }

  getText(): string {
    return this.session?.getText() ?? this.text;
  }

  focus(): void {
    this.view.focusInput();
  }

  attachSession(session: DocumentSession, options: EditorSessionOptions = {}): void {
    this.documentVersion += 1;
    this.documentId = null;
    this.languageId = null;
    this.syntaxStatus = "plain";
    this.disposeSyntaxSession();
    this.session = session;
    this.sessionOptions = options;
    this.view.setEditable(true);
    this.setDocument({ text: session.getText(), tokens: session.getTokens() });
    this.syncDomSelection();
  }

  detachSession(): void {
    this.session = null;
    this.sessionOptions = {};
    this.clearSelectionHighlight();
    this.view.setEditable(false);
  }

  clear(): void {
    this.documentVersion += 1;
    this.documentId = null;
    this.languageId = null;
    this.syntaxStatus = "plain";
    this.disposeSyntaxSession();
    this.detachSession();
    this.setContent("");
  }

  dispose(): void {
    this.uninstallEditingHandlers();
    this.disposeSyntaxSession();
    this.detachSession();
    this.view.dispose();
  }

  private resetOwnedDocument(document: EditorOpenDocumentOptions): number {
    this.documentVersion += 1;
    const documentVersion = this.documentVersion;
    this.documentId = document.documentId ?? null;
    this.languageId =
      document.languageId === undefined
        ? inferEditorSyntaxLanguage(document.documentId)
        : document.languageId;
    this.syntaxStatus = this.languageId ? "loading" : "plain";
    this.disposeSyntaxSession();

    const documentId = this.documentId ?? `${this.highlightPrefix}-${documentVersion}`;
    this.session = createDocumentSession(document.text);
    this.sessionOptions = {};
    this.syntaxSession = this.languageId
      ? editorSyntaxSessionFactory({
          documentId,
          languageId: this.languageId,
          text: document.text,
          snapshot: this.session.getSnapshot(),
        })
      : null;
    this.view.setEditable(true);
    this.setDocument({ text: this.session.getText(), tokens: [] });
    this.syncDomSelection();
    return documentVersion;
  }

  private disposeSyntaxSession(): void {
    this.syntaxVersion += 1;
    this.syntaxSession?.dispose();
    this.syntaxSession = null;
  }

  private installEditingHandlers(): void {
    this.el.addEventListener("mousedown", this.handleMouseDown);
    this.el.addEventListener("beforeinput", this.handleBeforeInput);
    this.view.inputElement.addEventListener(
      "beforeinput",
      this.handleNativeInputBeforeInputCapture,
      {
        capture: true,
      },
    );
    this.view.inputElement.addEventListener("input", this.handleNativeInputInputCapture, {
      capture: true,
    });
    this.el.addEventListener("paste", this.handlePaste);
    this.el.addEventListener("keydown", this.handleKeyDown);
    this.el.addEventListener("keyup", this.syncSessionSelectionFromDom);
    this.el.addEventListener("mouseup", this.syncSessionSelectionFromDom);
    this.el.ownerDocument.addEventListener("selectionchange", this.syncCustomSelectionFromDom);
  }

  private uninstallEditingHandlers(): void {
    this.el.removeEventListener("mousedown", this.handleMouseDown);
    this.el.removeEventListener("beforeinput", this.handleBeforeInput);
    this.view.inputElement.removeEventListener(
      "beforeinput",
      this.handleNativeInputBeforeInputCapture,
      { capture: true },
    );
    this.view.inputElement.removeEventListener("input", this.handleNativeInputInputCapture, {
      capture: true,
    });
    this.el.removeEventListener("paste", this.handlePaste);
    this.el.removeEventListener("keydown", this.handleKeyDown);
    this.el.removeEventListener("keyup", this.syncSessionSelectionFromDom);
    this.el.removeEventListener("mouseup", this.syncSessionSelectionFromDom);
    this.el.ownerDocument.removeEventListener("selectionchange", this.syncCustomSelectionFromDom);
    this.stopMouseSelectionDrag();
  }

  private handleNativeInputBeforeInputCapture = (_event: InputEvent): void => {
    this.nativeInputGeneration += 1;
  };

  private handleNativeInputInputCapture = (_event: InputEvent): void => {
    this.nativeInputGeneration += 1;
  };

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this.session) return;

    this.view.focusInput();
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

    if (event.detail === 2) {
      this.selectWordAtOffset(event, offset);
      return;
    }

    this.startMouseSelectionDrag(event, offset);
  };

  private startMouseSelectionDrag(event: MouseEvent, offset: number): void {
    if (event.button !== 0) return;
    if (event.detail !== 1) return;

    event.preventDefault();
    this.view.focusInput();
    this.mouseSelectionDrag = {
      anchorOffset: offset,
      headOffset: offset,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    this.syncCustomSelectionHighlight(offset, offset);
    this.el.ownerDocument.addEventListener("mousemove", this.updateMouseSelectionDrag);
    this.el.ownerDocument.addEventListener("mouseup", this.finishMouseSelectionDrag);
  }

  private updateMouseSelectionDrag = (event: MouseEvent): void => {
    if (!this.mouseSelectionDrag) return;
    if (!this.session) return;

    event.preventDefault();
    this.mouseSelectionDrag.clientX = event.clientX;
    this.mouseSelectionDrag.clientY = event.clientY;
    this.updateMouseSelectionFromDragPoint();
    this.updateMouseSelectionAutoScroll();
  };

  private finishMouseSelectionDrag = (event: MouseEvent): void => {
    const drag = this.mouseSelectionDrag;
    if (!drag || !this.session) {
      this.stopMouseSelectionDrag();
      return;
    }

    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    const offset = this.mouseSelectionOffsetFromPoint(drag.clientX, drag.clientY);
    event.preventDefault();
    this.stopMouseSelectionDrag();

    const start = nowMs();
    const change = this.session.setSelection(drag.anchorOffset, offset);
    const syncDomSelection = drag.anchorOffset === offset;
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, "input.selection", start, { syncDomSelection });
  };

  private stopMouseSelectionDrag(): void {
    this.mouseSelectionDrag = null;
    this.stopMouseSelectionAutoScroll();
    this.el.ownerDocument.removeEventListener("mousemove", this.updateMouseSelectionDrag);
    this.el.ownerDocument.removeEventListener("mouseup", this.finishMouseSelectionDrag);
  }

  private updateMouseSelectionFromDragPoint(): void {
    const drag = this.mouseSelectionDrag;
    if (!drag || !this.session) return;

    const offset = this.mouseSelectionOffsetFromPoint(drag.clientX, drag.clientY);
    drag.headOffset = offset;
    this.syncCustomSelectionHighlight(drag.anchorOffset, offset);
    this.session.setSelection(drag.anchorOffset, offset);
    this.useSessionSelectionForNextInput = drag.anchorOffset !== offset;
  }

  private mouseSelectionOffsetFromPoint(clientX: number, clientY: number): number {
    return (
      this.view.textOffsetFromPoint(clientX, clientY) ??
      this.view.textOffsetFromViewportPoint(clientX, clientY)
    );
  }

  private updateMouseSelectionAutoScroll(): void {
    const delta = this.mouseSelectionAutoScrollDelta();
    if (delta === 0 || !this.canMouseSelectionAutoScroll(delta)) {
      this.stopMouseSelectionAutoScroll();
      return;
    }

    this.scrollMouseSelection(delta);
    this.scheduleMouseSelectionAutoScroll();
  }

  private mouseSelectionAutoScrollDelta(): number {
    const drag = this.mouseSelectionDrag;
    if (!drag) return 0;

    const rect = this.el.getBoundingClientRect();
    return mouseSelectionAutoScrollDelta(drag.clientY, rect);
  }

  private canMouseSelectionAutoScroll(delta: number): boolean {
    const maxScrollTop = Math.max(0, this.el.scrollHeight - this.el.clientHeight);
    if (delta < 0) return this.el.scrollTop > 0;
    if (delta > 0) return this.el.scrollTop < maxScrollTop;
    return false;
  }

  private scrollMouseSelection(delta: number): void {
    const maxScrollTop = Math.max(0, this.el.scrollHeight - this.el.clientHeight);
    const nextScrollTop = clamp(this.el.scrollTop + delta, 0, maxScrollTop);
    if (nextScrollTop === this.el.scrollTop) return;

    this.el.scrollTop = nextScrollTop;
    this.view.setScrollMetrics(this.el.scrollTop, this.el.clientHeight);
    this.updateMouseSelectionFromDragPoint();
  }

  private scheduleMouseSelectionAutoScroll(): void {
    if (this.mouseSelectionAutoScrollFrame !== 0) return;

    this.mouseSelectionAutoScrollFrame = requestFrame(() => {
      this.mouseSelectionAutoScrollFrame = 0;
      if (!this.mouseSelectionDrag) return;
      this.updateMouseSelectionAutoScroll();
    });
  }

  private stopMouseSelectionAutoScroll(): void {
    if (this.mouseSelectionAutoScrollFrame === 0) return;

    cancelFrame(this.mouseSelectionAutoScrollFrame);
    this.mouseSelectionAutoScrollFrame = 0;
  }

  private selectFullDocument(event: MouseEvent, timingName: string): void {
    if (!this.session) return;

    const start = eventStartMs(event);
    event.preventDefault();
    const change = this.session.setSelection(0, this.session.getSnapshot().length);
    this.syncCustomSelectionHighlight(0, this.session.getSnapshot().length);
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, timingName, start, { syncDomSelection: false });
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

    const start = eventStartMs(event);
    event.preventDefault();
    const change = this.session.setSelection(range.start, range.end);
    this.syncCustomSelectionHighlight(range.start, range.end);
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, timingName, start, { syncDomSelection: false });
  }

  private handleBeforeInput = (event: InputEvent): void => {
    if (!this.session) return;

    const text = event.data ?? "";
    if (event.inputType !== "insertText" && event.inputType !== "insertLineBreak") return;

    const start = eventStartMs(event);
    const selectionChange = this.selectionChangeBeforeEdit();
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

    const start = eventStartMs(event);
    const selectionChange = this.selectionChangeBeforeEdit();
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
      const start = eventStartMs(event);
      const selectionChange = this.selectionChangeBeforeEdit();
      event.preventDefault();
      this.applySessionChange(
        mergeChangeTimings(this.session.backspace(), selectionChange),
        "input.backspace",
        start,
      );
      return;
    }

    if (event.key === "Delete") {
      const start = eventStartMs(event);
      const selectionChange = this.selectionChangeBeforeEdit();
      event.preventDefault();
      this.applySessionChange(
        mergeChangeTimings(this.session.deleteSelection(), selectionChange),
        "input.delete",
        start,
      );
      return;
    }

    const fallbackText = keyboardFallbackText(event);
    if (fallbackText === null) return;

    this.scheduleKeyboardTextFallback(event, fallbackText);
  };

  private scheduleKeyboardTextFallback(event: KeyboardEvent, text: string): void {
    const start = eventStartMs(event);
    const nativeInputGeneration = this.nativeInputGeneration;

    this.el.ownerDocument.defaultView?.setTimeout(() => {
      if (!this.session) return;
      if (this.nativeInputGeneration !== nativeInputGeneration) return;

      const selectionChange = this.selectionChangeBeforeEdit();
      this.view.inputElement.value = "";
      this.applySessionChange(
        mergeChangeTimings(this.session.applyText(text), selectionChange),
        "input.keydownFallback",
        start,
      );
    }, 0);
  }

  private handleUndoRedo(event: KeyboardEvent): boolean {
    if (!this.session) return false;
    if (!isUndoRedoEvent(event)) return false;

    event.preventDefault();
    const start = eventStartMs(event);
    const change = event.shiftKey ? this.session.redo() : this.session.undo();
    this.applySessionChange(change, event.shiftKey ? "input.redo" : "input.undo", start);
    return true;
  }

  private syncSessionSelectionFromDom = (_event: Event): void => {
    if (!this.session) return;
    if (this.mouseSelectionDrag) return;
    if (this.useSessionSelectionForNextInput) return;
    if (this.isInputFocused()) return;

    const start = nowMs();
    const change = this.updateSessionSelectionFromDom();
    if (!change) return;

    this.useSessionSelectionForNextInput = false;
    const timedChange = appendTiming(change, "input.selection", start);
    this.sessionOptions.onChange?.(timedChange);
    this.notifyChangeWithTiming(timedChange);
  };

  private updateSessionSelectionFromDom(): DocumentSessionChange | null {
    if (!this.session) return null;

    const readStart = nowMs();
    const offsets = this.readDomSelectionOffsets();
    if (!offsets) return null;

    this.syncCustomSelectionHighlight(offsets.anchorOffset, offsets.headOffset);
    return appendTiming(
      this.session.setSelection(offsets.anchorOffset, offsets.headOffset),
      "editor.readDomSelection",
      readStart,
    );
  }

  private selectionChangeBeforeEdit(): DocumentSessionChange | null {
    if (this.isInputFocused()) {
      this.useSessionSelectionForNextInput = false;
      return null;
    }
    if (!this.useSessionSelectionForNextInput) return this.updateSessionSelectionFromDom();

    this.useSessionSelectionForNextInput = false;
    return null;
  }

  private applySessionChange(
    change: DocumentSessionChange,
    totalName = "editor.change",
    totalStart = nowMs(),
    options: { readonly syncDomSelection?: boolean } = {},
  ): void {
    let timedChange = change;
    const renderStart = nowMs();
    this.renderSessionChange(change);
    timedChange = appendTiming(timedChange, "editor.render", renderStart);

    if (options.syncDomSelection !== false) {
      const selectionStart = nowMs();
      this.syncDomSelection();
      timedChange = appendTiming(timedChange, "editor.syncDomSelection", selectionStart);
    }
    const finalChange = appendTiming(timedChange, totalName, totalStart);
    this.sessionOptions.onChange?.(finalChange);
    this.refreshSyntax(this.documentVersion, finalChange);
    this.notifyChangeWithTiming(finalChange);
  }

  private renderSessionChange(change: DocumentSessionChange): void {
    const edit = change.edits[0];
    if (change.kind === "selection" || change.kind === "none") return;

    if (change.kind === "edit" && edit && change.edits.length === 1) {
      this.applyEdit(edit, projectTokensThroughEdit(this.tokens, edit, this.text));
      return;
    }

    this.setDocument({ text: change.text, tokens: [] });
  }

  private notifyChange(change: DocumentSessionChange | null): void {
    this.options.onChange?.(this.getState(), change);
  }

  private notifyChangeWithTiming(change: DocumentSessionChange): void {
    const notifyStart = nowMs();
    const state = this.getState();
    const timedChange = appendTiming(change, "editor.notify", notifyStart);
    this.options.onChange?.(state, timedChange);
  }

  private refreshSyntax(documentVersion: number, change: DocumentSessionChange | null): void {
    if (!this.syntaxSession || !this.session || !this.languageId) return;
    if (change && (change.kind === "none" || change.kind === "selection")) return;

    const text = this.session.getText();
    const startedAt = nowMs();
    const syntaxVersion = ++this.syntaxVersion;
    this.syntaxStatus = "loading";

    void this.loadSyntaxResult(change, text)
      .then((result) => {
        this.applySyntaxResult(result, documentVersion, syntaxVersion, startedAt);
      })
      .catch(() => {
        this.applySyntaxError(documentVersion, syntaxVersion);
      });
  }

  private loadSyntaxResult(
    change: DocumentSessionChange | null,
    text: string,
  ): Promise<EditorSyntaxResult> {
    if (!this.syntaxSession) return Promise.reject(new Error("No syntax session"));
    if (!change) {
      const snapshot = this.session?.getSnapshot();
      if (!snapshot) return Promise.reject(new Error("No document snapshot"));
      return this.syntaxSession.refresh(snapshot, text);
    }
    return this.syntaxSession.applyChange(change);
  }

  private applySyntaxResult(
    result: EditorSyntaxResult,
    documentVersion: number,
    syntaxVersion: number,
    startedAt: number,
  ): void {
    if (!this.session || documentVersion !== this.documentVersion) return;
    if (syntaxVersion !== this.syntaxVersion) return;

    this.syntaxStatus = "ready";
    const tokenChange = this.session.setTokens(result.tokens);
    const timedChange = appendTiming(tokenChange, "editor.syntax", startedAt);
    this.setTokens(result.tokens);
    this.notifyChange(timedChange);
  }

  private applySyntaxError(documentVersion: number, syntaxVersion: number): void {
    if (documentVersion !== this.documentVersion) return;
    if (syntaxVersion !== this.syntaxVersion) return;

    this.syntaxStatus = "error";
    this.notifyChange(null);
  }

  private syncDomSelection(): void {
    if (!this.session) return;

    const selection = this.session.getSelections().selections[0];
    if (!selection) return;

    const resolved = resolveSelection(this.session.getSnapshot(), selection);
    const start = clamp(resolved.startOffset, 0, this.text.length);
    const end = clamp(resolved.endOffset, start, this.text.length);
    const range = this.view.createRange(start, end);

    if (this.isInputFocused()) {
      this.syncCustomSelectionHighlight(start, end);
      return;
    }

    const domSelection = window.getSelection();
    domSelection?.removeAllRanges();
    if (range) domSelection?.addRange(range);
    this.syncCustomSelectionHighlight(start, end);
  }

  private readDomSelectionOffsets(): { anchorOffset: number; headOffset: number } | null {
    const selection = window.getSelection();
    if (!selection?.anchorNode || !selection.focusNode) return null;

    const anchorOffset = this.domBoundaryToTextOffset(selection.anchorNode, selection.anchorOffset);
    const headOffset = this.domBoundaryToTextOffset(selection.focusNode, selection.focusOffset);
    if (anchorOffset === null || headOffset === null) return null;

    return { anchorOffset, headOffset };
  }

  private syncCustomSelectionFromDom = (): void => {
    if (!this.session) return;
    if (this.useSessionSelectionForNextInput) return;
    if (this.isInputFocused()) return;

    const offsets = this.readDomSelectionOffsets();
    if (!offsets) return;

    this.syncCustomSelectionHighlight(offsets.anchorOffset, offsets.headOffset);
  };

  private syncCustomSelectionHighlight(anchorOffset: number, headOffset: number): void {
    this.view.setSelection(anchorOffset, headOffset);
  }

  private clearSelectionHighlight(): void {
    this.view.clearSelection();
  }

  private isInputFocused(): boolean {
    return this.el.ownerDocument.activeElement === this.view.inputElement;
  }

  private domBoundaryToTextOffset(node: Node, offset: number): number | null {
    const viewOffset = this.view.textOffsetFromDomBoundary(node, offset);
    if (viewOffset !== null) return viewOffset;

    if (node === this.el) return elementBoundaryToTextOffset(offset, this.text.length);
    return this.externalBoundaryToTextOffset(node, offset);
  }

  private textOffsetFromMouseEvent(event: MouseEvent): number | null {
    return (
      this.view.textOffsetFromPoint(event.clientX, event.clientY) ??
      this.view.textOffsetFromViewportPoint(event.clientX, event.clientY)
    );
  }

  private externalBoundaryToTextOffset(node: Node, offset: number): number | null {
    if (node.contains(this.el)) {
      const child = childContainingNode(node, this.el);
      const childIndex = child ? childNodeIndex(node, child) : -1;
      if (childIndex === -1) return null;
      return elementBoundaryToTextOffset(offset <= childIndex ? 0 : 1, this.text.length);
    }

    const position = node.compareDocumentPosition(this.el);
    if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return 0;
    if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return this.text.length;
    return null;
  }
}

function isUndoRedoEvent(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== "z") return false;
  return event.metaKey || event.ctrlKey;
}

function keyboardFallbackText(event: KeyboardEvent): string | null {
  if (event.defaultPrevented) return null;
  if (event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "Enter") return "\n";
  if (event.key.length !== 1) return null;

  return event.key;
}

function projectTokensThroughEdit(
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: string,
): readonly EditorToken[] {
  const delta = edit.text.length - (edit.to - edit.from);
  const projected: EditorToken[] = [];

  for (const token of tokens) {
    const next = projectTokenThroughEdit(token, edit, previousText, delta);
    if (!next || next.end <= next.start) continue;
    projected.push(next);
  }

  return projected;
}

function projectTokenThroughEdit(
  token: EditorToken,
  edit: TextEdit,
  previousText: string,
  delta: number,
): EditorToken | null {
  if (edit.from === edit.to) return projectTokenThroughInsertion(token, edit, previousText);
  if (token.end <= edit.from) return token;
  if (token.start >= edit.to) return shiftToken(token, delta);
  if (!canResizeTokenAcrossEdit(token, edit)) return null;

  return { ...token, end: token.end + delta };
}

function projectTokenThroughInsertion(
  token: EditorToken,
  edit: TextEdit,
  previousText: string,
): EditorToken {
  if (shouldExpandTokenForInsertion(token, edit, previousText)) {
    return { ...token, end: token.end + edit.text.length };
  }
  if (token.start >= edit.from) return shiftToken(token, edit.text.length);

  return token;
}

function canResizeTokenAcrossEdit(token: EditorToken, edit: TextEdit): boolean {
  if (edit.text.includes("\n")) return false;
  return token.start < edit.from && edit.to < token.end;
}

function shouldExpandTokenForInsertion(
  token: EditorToken,
  edit: TextEdit,
  previousText: string,
): boolean {
  if (edit.text.length === 0) return false;
  if (edit.text.includes("\n")) return false;
  if (token.start < edit.from && edit.from < token.end) return true;
  if (!isWordLikeText(edit.text)) return false;
  if (token.end === edit.from) return isWordBeforeOffset(previousText, edit.from);
  if (token.start === edit.from) {
    return (
      !isWordBeforeOffset(previousText, edit.from) && isWordCodePointAt(previousText, edit.from)
    );
  }

  return false;
}

function shiftToken(token: EditorToken, delta: number): EditorToken {
  return {
    ...token,
    start: token.start + delta,
    end: token.end + delta,
  };
}

function isWordLikeText(text: string): boolean {
  return /^[\p{L}\p{N}_]+$/u.test(text);
}

function isWordBeforeOffset(text: string, offset: number): boolean {
  const previous = previousCodePointStart(text, offset);
  if (previous === null) return false;
  return isWordCodePointAt(text, previous);
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

function mouseSelectionAutoScrollDelta(clientY: number, rect: DOMRect): number {
  if (rect.height <= 0) return 0;
  if (clientY < rect.top + MOUSE_SELECTION_SCROLL_ZONE_PX) {
    return -mouseSelectionScrollStep(rect.top + MOUSE_SELECTION_SCROLL_ZONE_PX - clientY);
  }
  if (clientY > rect.bottom - MOUSE_SELECTION_SCROLL_ZONE_PX) {
    return mouseSelectionScrollStep(clientY - (rect.bottom - MOUSE_SELECTION_SCROLL_ZONE_PX));
  }

  return 0;
}

function mouseSelectionScrollStep(distance: number): number {
  const ratio = distance / MOUSE_SELECTION_SCROLL_ZONE_PX;
  const scaled = Math.ceil(ratio * MOUSE_SELECTION_MAX_SCROLL_PX);
  return clamp(scaled, MOUSE_SELECTION_MIN_SCROLL_PX, MOUSE_SELECTION_MAX_SCROLL_PX);
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(() => callback(nowMs()), 0) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
    return;
  }

  clearTimeout(handle);
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function eventStartMs(event: Event): number {
  const start = event.timeStamp;
  if (!Number.isFinite(start) || start <= 0) return nowMs();

  const now = nowMs();
  if (start <= now + 1_000) return start;

  const wallClockDelta = Date.now() - start;
  if (!Number.isFinite(wallClockDelta) || wallClockDelta < 0) return now;

  return Math.max(0, now - wallClockDelta);
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
