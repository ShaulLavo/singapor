import type { DocumentSession, DocumentSessionChange } from "../documentSession";
import { createDocumentSession } from "../documentSession";
import { childContainingNode, childNodeIndex, elementBoundaryToTextOffset } from "./domBoundary";
import { projectSyntaxFoldsThroughLineEdit } from "./folds";
import { EditorFoldState } from "./foldState";
import { keyboardFallbackText } from "./input";
import { EditorKeymapController } from "./keymap";
import { LatestAsyncRequest } from "./latestAsyncRequest";
import {
  cancelFrame,
  mouseSelectionAutoScrollDelta,
  requestFrame,
  type MouseSelectionDrag,
} from "./mouseSelection";
import { lineRangeAtOffset, wordRangeAtOffset } from "./textRanges";
import { appendTiming, eventStartMs, mergeChangeTimings, nowMs } from "./timing";
import { copyTokenProjectionMetadata, projectTokensThroughEdit } from "./tokenProjection";
import type { EditorCommandContext, EditorCommandId } from "./commands";
import { normalizeEditorEditInput } from "./editInput";
import { navigationTargetForCommand, type NavigationTarget } from "./navigationTargets";
import {
  getEditorSyntaxSessionFactory,
  getHighlightRegistry,
  nextEditorHighlightPrefix,
  resetEditorInstanceCount,
  setEditorSyntaxSessionFactory,
  setHighlightRegistry,
} from "./runtime";
import {
  DOCUMENT_START_SCROLL_POSITION,
  normalizeScrollOffset,
  preservedScrollPosition,
} from "./scroll";
import type {
  EditorEditInput,
  EditorEditOptions,
  EditorOptions,
  EditorOpenDocumentOptions,
  EditorScrollPosition,
  EditorSetTextOptions,
  EditorSessionOptions,
  EditorState,
  EditorSyntaxStatus,
} from "./types";
import { EditorViewContributionController } from "./viewContributions";
import type { FoldMap } from "../foldMap";
import { offsetToPoint } from "../pieceTable/positions";
import { getPieceTableText } from "../pieceTable/reads";
import {
  EditorPluginHost,
  type EditorHighlightResult,
  type EditorHighlighterSession,
  type EditorOverlaySide,
  type EditorResolvedSelection,
  type EditorViewContributionContext,
  type EditorViewContributionUpdateKind,
  type EditorViewSnapshot,
} from "../plugins";
import { SelectionGoal, resolveSelection, type ResolvedSelection } from "../selections";
import {
  type EditorSyntaxLanguageId,
  type EditorSyntaxResult,
  type EditorSyntaxSession,
} from "../syntax/session";
import type { FoldRange } from "../syntax/treeSitter/types";
import type { EditorTheme } from "../theme";
import { mergeEditorThemes } from "../theme";
import type { EditorDocument, EditorToken, TextEdit } from "../tokens";
import { clamp } from "../style-utils";
import {
  VirtualizedTextView,
  type VirtualizedFoldMarker,
} from "../virtualization/virtualizedTextView";

const SYNTAX_EDIT_DEBOUNCE_MS = 75;
export { resetEditorInstanceCount, setEditorSyntaxSessionFactory, setHighlightRegistry };

const syntaxRefreshDelay = (change: DocumentSessionChange | null): number => {
  if (!change || change.edits.length === 0) return 0;
  return SYNTAX_EDIT_DEBOUNCE_MS;
};

type SessionChangeOptions = {
  readonly syncDomSelection?: boolean;
  readonly revealOffset?: number;
  readonly revealBlock?: "nearest" | "end";
};

type ResetOwnedDocumentOptions = {
  readonly documentId: string | null;
  readonly persistentIdentity: boolean;
  readonly scrollPosition?: EditorScrollPosition;
};

export class Editor {
  private readonly view: VirtualizedTextView;
  private readonly foldState: EditorFoldState;
  private readonly el: HTMLDivElement;
  private readonly options: EditorOptions;
  private readonly pluginHost: EditorPluginHost;
  private readonly keymap: EditorKeymapController;
  private readonly viewContributions: EditorViewContributionController;
  private readonly highlightPrefix: string;
  private text = "";
  private session: DocumentSession | null = null;
  private sessionOptions: EditorSessionOptions = {};
  private documentId: string | null = null;
  private languageId: EditorSyntaxLanguageId | null = null;
  private syntaxStatus: EditorSyntaxStatus = "plain";
  private syntaxSession: EditorSyntaxSession | null = null;
  private highlighterSession: EditorHighlighterSession | null = null;
  private configuredTheme: EditorTheme | null = null;
  private providerHighlighterTheme: EditorTheme | null = null;
  private highlighterTheme: EditorTheme | null = null;
  private readonly syntaxRequests = new LatestAsyncRequest<EditorSyntaxResult>();
  private readonly highlightRequests = new LatestAsyncRequest<EditorHighlightResult>();
  private readonly highlighterThemeRequests = new LatestAsyncRequest<
    EditorTheme | null | undefined
  >();
  private tokens: readonly EditorToken[] = [];
  private documentVersion = 0;
  private mouseSelectionDrag: MouseSelectionDrag | null = null;
  private mouseSelectionAutoScrollFrame = 0;
  private useSessionSelectionForNextInput = false;
  private nativeInputGeneration = 0;

  constructor(container: HTMLElement, options: EditorOptions = {}) {
    this.options = options;
    this.configuredTheme = options.theme ?? null;
    this.pluginHost = new EditorPluginHost(options.plugins);
    this.highlightPrefix = nextEditorHighlightPrefix();
    this.view = new VirtualizedTextView(container, {
      className: "editor",
      highlightRegistry: getHighlightRegistry(),
      gutterContributions: [...this.pluginHost.getGutterContributions()],
      onFoldToggle: this.handleFoldToggle,
      onViewportChange: this.handleViewportChange,
      selectionHighlightName: `${this.highlightPrefix}-selection`,
    });
    this.foldState = new EditorFoldState(this.view, () => this.session?.getSnapshot() ?? null);
    this.el = this.view.scrollElement;
    this.applyResolvedTheme();
    this.refreshHighlighterTheme();
    this.keymap = new EditorKeymapController({
      target: this.el,
      keymap: options.keymap,
      dispatch: (command, context) => this.dispatchCommand(command, context),
    });
    this.viewContributions = new EditorViewContributionController(
      this.pluginHost.createViewContributions(this.createViewContributionContext(container)),
      () => this.createViewSnapshot(),
    );
    this.installEditingHandlers();
    this.initializeDefaultText();
  }

  setContent(text: string): void {
    this.text = text;
    this.view.setText(text);
    this.setTokens([]);
    this.clearSyntaxFolds();
    this.notifyViewContributions("content", null);
  }

  setTokens(tokens: readonly EditorToken[]): void {
    const copiedTokens = [...tokens];
    copyTokenProjectionMetadata(tokens, copiedTokens);
    this.adoptTokens(copiedTokens);
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

  setFoldMap(foldMap: FoldMap | null): void {
    this.view.setFoldMap(foldMap);
  }

  setSyntaxFolds(folds: readonly FoldRange[]): void {
    this.foldState.setSyntaxFolds(folds);
  }

  setText(text: string, options: EditorSetTextOptions = {}): void {
    const currentScrollPosition = this.getScrollPosition();
    const documentVersion = this.resetOwnedDocument(
      { text, languageId: options.languageId },
      {
        documentId: null,
        persistentIdentity: false,
        scrollPosition: preservedScrollPosition(currentScrollPosition, options.scrollPosition),
      },
    );
    this.notifyChange(null);
    this.refreshSyntax(documentVersion, null);
  }

  edit(editOrEdits: EditorEditInput, options: EditorEditOptions = {}): void {
    this.ensureAnonymousSession();
    if (!this.session) return;

    const edits = normalizeEditorEditInput(editOrEdits);
    const change = this.session.applyEdits(edits, options);
    if (change.kind === "none") return;

    this.applySessionChange(change, "editor.edit", nowMs());
  }

  openDocument(document: EditorOpenDocumentOptions): void {
    const documentVersion = this.resetOwnedDocument(document, {
      documentId: document.documentId ?? null,
      persistentIdentity: true,
      scrollPosition: document.scrollPosition,
    });
    this.notifyChange(null);
    this.refreshSyntax(documentVersion, null);
  }

  private ensureAnonymousSession(): void {
    if (this.session) return;

    this.resetOwnedDocument(
      { text: "", languageId: null },
      {
        documentId: null,
        persistentIdentity: false,
        scrollPosition: DOCUMENT_START_SCROLL_POSITION,
      },
    );
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

  getScrollPosition(): Required<EditorScrollPosition> {
    const viewState = this.view.getState();
    return {
      top: viewState.scrollTop,
      left: viewState.scrollLeft,
    };
  }

  setScrollPosition(scrollPosition: EditorScrollPosition): void {
    this.applyScrollPosition(scrollPosition);
  }

  setTheme(theme: EditorTheme | null | undefined): void {
    this.configuredTheme = theme ?? null;
    this.applyResolvedTheme();
    this.notifyViewContributions("tokens", null);
  }

  dispatchCommand(command: EditorCommandId, context: EditorCommandContext = {}): boolean {
    if (command === "undo") return this.applyHistoryCommand("undo", context);
    if (command === "redo") return this.applyHistoryCommand("redo", context);
    if (command === "selectAll") return this.applySelectAllCommand(context);
    if (command === "deleteBackward") return this.applyDeleteCommand("backward", context);
    if (command === "deleteForward") return this.applyDeleteCommand("forward", context);
    return this.applyNavigationCommand(command, context);
  }

  attachSession(session: DocumentSession, options: EditorSessionOptions = {}): void {
    this.documentVersion += 1;
    this.documentId = null;
    this.languageId = null;
    this.syntaxStatus = "plain";
    this.disposeSyntaxSession();
    this.disposeHighlighterSession();
    this.session = session;
    this.sessionOptions = options;
    this.view.setEditable(true);
    this.setDocument({ text: session.getText(), tokens: session.getTokens() });
    this.applyDocumentScrollPosition(options.scrollPosition);
    this.syncDomSelection();
    this.notifyViewContributions("document", null);
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
    this.disposeHighlighterSession();
    this.detachSession();
    this.setContent("");
    this.applyDocumentScrollPosition();
    this.notifyViewContributions("clear", null);
  }

  dispose(): void {
    this.uninstallEditingHandlers();
    this.keymap.dispose();
    this.highlighterThemeRequests.dispose();
    this.disposeSyntaxSession();
    this.disposeHighlighterSession();
    this.detachSession();
    this.pluginHost.dispose();
    this.view.dispose();
  }

  private resetOwnedDocument(
    document: EditorOpenDocumentOptions,
    options: ResetOwnedDocumentOptions,
  ): number {
    this.documentVersion += 1;
    const documentVersion = this.documentVersion;
    this.documentId =
      options.documentId ??
      (options.persistentIdentity ? this.generatedDocumentId(documentVersion) : null);
    this.languageId = document.languageId ?? null;
    this.syntaxStatus = this.languageId ? "loading" : "plain";
    this.disposeSyntaxSession();
    this.disposeHighlighterSession();

    const internalDocumentId = this.documentId ?? this.generatedOpenSessionId(documentVersion);
    this.session = createDocumentSession(document.text);
    this.sessionOptions = {};
    this.highlighterSession = this.pluginHost.createHighlighterSession({
      documentId: internalDocumentId,
      languageId: this.languageId,
      text: document.text,
      snapshot: this.session.getSnapshot(),
    });
    this.syntaxSession = this.languageId
      ? getEditorSyntaxSessionFactory()({
          documentId: internalDocumentId,
          languageId: this.languageId,
          languageResolver: this.pluginHost,
          includeHighlights: !this.highlighterSession,
          text: document.text,
          snapshot: this.session.getSnapshot(),
        })
      : null;
    this.view.setEditable(true);
    this.setDocument({ text: this.session.getText(), tokens: [] });
    this.applyDocumentScrollPosition(options.scrollPosition);
    this.syncDomSelection();
    this.notifyViewContributions("document", null);
    return documentVersion;
  }

  private initializeDefaultText(): void {
    if (this.options.defaultText === undefined) return;

    this.resetOwnedDocument(
      { text: this.options.defaultText, languageId: null },
      {
        documentId: null,
        persistentIdentity: false,
        scrollPosition: DOCUMENT_START_SCROLL_POSITION,
      },
    );
  }

  private applyDocumentScrollPosition(scrollPosition?: EditorScrollPosition): void {
    this.applyScrollPosition({
      top: scrollPosition?.top ?? DOCUMENT_START_SCROLL_POSITION.top,
      left: scrollPosition?.left ?? DOCUMENT_START_SCROLL_POSITION.left,
    });
  }

  private applyScrollPosition(scrollPosition: EditorScrollPosition): void {
    const viewState = this.view.getState();
    const scrollTop = normalizeScrollOffset(
      scrollPosition.top,
      viewState.scrollTop,
      viewState.scrollHeight - viewState.viewportHeight,
    );
    const scrollLeft = normalizeScrollOffset(
      scrollPosition.left,
      viewState.scrollLeft,
      viewState.scrollWidth - viewState.viewportWidth,
    );

    this.el.scrollTop = scrollTop;
    this.el.scrollLeft = scrollLeft;
    this.view.setScrollMetrics(
      scrollTop,
      viewState.viewportHeight,
      viewState.viewportWidth,
      scrollLeft,
    );
  }

  private generatedDocumentId(documentVersion: number): string {
    return `${this.highlightPrefix}-document-${documentVersion}`;
  }

  private generatedOpenSessionId(documentVersion: number): string {
    return `${this.highlightPrefix}-open-${documentVersion}`;
  }

  private disposeSyntaxSession(): void {
    this.syntaxRequests.cancel();
    this.syntaxSession?.dispose();
    this.syntaxSession = null;
  }

  private disposeHighlighterSession(): void {
    this.highlightRequests.cancel();
    this.highlighterSession?.dispose();
    this.highlighterSession = null;
    this.setHighlighterTheme(null);
  }

  private refreshHighlighterTheme(): void {
    this.highlighterThemeRequests.schedule({
      run: () => this.pluginHost.loadHighlighterTheme(),
      apply: (theme) => this.setProviderHighlighterTheme(theme),
      fail: () => this.setProviderHighlighterTheme(null),
    });
  }

  private createViewContributionContext(container: HTMLElement): EditorViewContributionContext {
    return {
      container,
      scrollElement: this.el,
      getSnapshot: () => this.createViewSnapshot(),
      revealLine: (row) => this.view.scrollToRow(row),
      reserveOverlayWidth: (side, width) => this.reserveOverlayWidth(side, width),
      setScrollTop: (scrollTop) => this.setScrollTop(scrollTop),
    };
  }

  private createViewSnapshot(): EditorViewSnapshot {
    const viewState = this.view.getState();
    const viewport = {
      scrollTop: viewState.scrollTop,
      scrollLeft: viewState.scrollLeft,
      scrollHeight: viewState.scrollHeight,
      scrollWidth: viewState.scrollWidth,
      clientHeight: viewState.viewportHeight,
      clientWidth: viewState.viewportWidth,
      borderBoxHeight: viewState.borderBoxHeight,
      borderBoxWidth: viewState.borderBoxWidth,
      visibleRange: viewState.visibleRange,
    };

    return {
      documentId: this.documentId,
      languageId: this.languageId,
      text: this.text,
      textVersion: this.documentVersion,
      lineStarts: this.view.getLineStarts(),
      tokens: this.tokens,
      selections: this.resolveViewSelections(),
      metrics: viewState.metrics,
      lineCount: viewState.lineCount,
      contentWidth: viewState.contentWidth,
      totalHeight: viewState.totalHeight,
      viewport,
    };
  }

  private resolveViewSelections(): readonly EditorResolvedSelection[] {
    const snapshot = this.session?.getSnapshot();
    const selections = this.session?.getSelections().selections ?? [];
    if (!snapshot) return [];

    return selections.map((selection) => {
      const resolved = resolveSelection(snapshot, selection);
      return {
        anchorOffset: resolved.anchorOffset,
        headOffset: resolved.headOffset,
        startOffset: resolved.startOffset,
        endOffset: resolved.endOffset,
      };
    });
  }

  private notifyViewContributions(
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void {
    this.viewContributions.notify(kind, change ?? null);
  }

  private reserveOverlayWidth(side: EditorOverlaySide, width: number): void {
    if (!this.view.reserveOverlayWidth(side, width)) return;

    this.notifyViewContributions("layout", null);
  }

  private setScrollTop(scrollTop: number): void {
    const maxScrollTop = Math.max(0, this.el.scrollHeight - this.el.clientHeight);
    this.el.scrollTop = clamp(scrollTop, 0, maxScrollTop);
  }

  private readonly handleViewportChange = (): void => {
    this.notifyViewContributions("viewport", null);
  };

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
    this.el.addEventListener("copy", this.handleCopy);
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
    this.el.removeEventListener("copy", this.handleCopy);
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

  private handleNativeInputInputCapture = (): void => {
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
    this.notifyViewContributions("selection", null);
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
    const change = mergeChangeTimings(this.session.applyText(text), selectionChange);
    this.applySessionChange(change, "input.paste", start, {
      revealBlock: "end",
      revealOffset: this.primarySelectionHeadOffset(change),
    });
  };

  private handleCopy = (event: ClipboardEvent): void => {
    const text = this.selectedTextForClipboard();
    if (text === null) return;
    if (!event.clipboardData) return;

    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.session) return;

    const fallbackText = keyboardFallbackText(event);
    if (fallbackText === null) return;

    this.preventBrowserTextKeyDefault(event, fallbackText);
    this.scheduleKeyboardTextFallback(event, fallbackText);
  };

  private preventBrowserTextKeyDefault(event: KeyboardEvent, text: string): void {
    if (event.target === this.view.inputElement && text !== " ") return;

    event.preventDefault();
  }

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

  private applyHistoryCommand(command: "undo" | "redo", context: EditorCommandContext): boolean {
    if (!this.session) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = command === "undo" ? this.session.undo() : this.session.redo();
    this.applySessionChange(change, command === "undo" ? "input.undo" : "input.redo", start);
    return true;
  }

  private applyDeleteCommand(
    direction: "backward" | "forward",
    context: EditorCommandContext,
  ): boolean {
    if (!this.session) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const selectionChange = this.selectionChangeBeforeEdit();
    const change =
      direction === "backward" ? this.session.backspace() : this.session.deleteSelection();
    this.applySessionChange(
      mergeChangeTimings(change, selectionChange),
      direction === "backward" ? "input.backspace" : "input.delete",
      start,
    );
    return true;
  }

  private applySelectAllCommand(context: EditorCommandContext): boolean {
    if (!this.session) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = this.session.setSelection(0, this.session.getSnapshot().length);
    this.syncCustomSelectionHighlight(0, this.session.getSnapshot().length);
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, "input.selectAll", start, { syncDomSelection: false });
    return true;
  }

  private applyNavigationCommand(command: EditorCommandId, context: EditorCommandContext): boolean {
    const resolved = this.currentResolvedSelection();
    if (!resolved) return false;

    const target = navigationTargetForCommand({
      command,
      resolved,
      text: this.session?.getText() ?? this.text,
      documentLength: this.session?.getSnapshot().length ?? this.text.length,
      view: this.view,
    });
    if (!target) return false;

    this.applyNavigationTarget(target, resolved, context);
    return true;
  }

  private currentResolvedSelection(): ResolvedSelection | null {
    if (!this.session) return null;

    const selection = this.session.getSelections().selections[0];
    if (!selection) return null;

    return resolveSelection(this.session.getSnapshot(), selection);
  }

  private selectedTextForClipboard(): string | null {
    if (!this.session) return null;

    const selection = this.session.getSelections().selections[0];
    if (!selection) return null;

    const snapshot = this.session.getSnapshot();
    const resolved = resolveSelection(snapshot, selection);
    if (resolved.collapsed) return null;

    return getPieceTableText(snapshot, resolved.startOffset, resolved.endOffset);
  }

  private primarySelectionHeadOffset(change: DocumentSessionChange): number | undefined {
    const selection = change.selections.selections[0];
    if (!selection) return undefined;

    return resolveSelection(change.snapshot, selection).headOffset;
  }

  private applyNavigationTarget(
    target: NavigationTarget,
    resolved: ResolvedSelection,
    context: EditorCommandContext,
  ): void {
    if (!this.session) return;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const anchorOffset = target.extend ? resolved.anchorOffset : target.offset;
    const change = this.session.setSelection(anchorOffset, target.offset, {
      goal: target.goal ?? SelectionGoal.none(),
    });
    this.useSessionSelectionForNextInput = true;
    this.view.revealOffset(target.offset);
    this.applySessionChange(change, target.timingName, start);
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
    this.notifyViewContributions("selection", null);
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
    options: SessionChangeOptions = {},
  ): void {
    let timedChange = change;
    const renderStart = nowMs();
    this.renderSessionChange(change);
    timedChange = appendTiming(timedChange, "editor.render", renderStart);

    if (options.revealOffset !== undefined) {
      const revealStart = nowMs();
      this.view.revealOffset(options.revealOffset, options.revealBlock);
      timedChange = appendTiming(timedChange, "editor.reveal", revealStart);
    }

    if (options.syncDomSelection !== false) {
      const selectionStart = nowMs();
      this.syncDomSelection();
      timedChange = appendTiming(timedChange, "editor.syncDomSelection", selectionStart);
    }
    const finalChange = appendTiming(timedChange, totalName, totalStart);
    this.sessionOptions.onChange?.(finalChange);
    this.refreshSyntax(this.documentVersion, finalChange);
    this.notifyViewContributions(viewContributionKindForChange(finalChange), finalChange);
    this.notifyChangeWithTiming(finalChange);
  }

  private renderSessionChange(change: DocumentSessionChange): void {
    const edit = change.edits[0];
    if (change.kind === "selection" || change.kind === "none") return;

    if (edit && change.edits.length === 1) {
      const foldProjection = projectSyntaxFoldsThroughLineEdit(
        this.foldState.folds,
        edit,
        this.text,
      );
      this.applyEdit(edit, projectTokensThroughEdit(this.tokens, edit, this.text));
      this.foldState.applyProjection(foldProjection);
      return;
    }

    this.clearSyntaxFolds();
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
    if (!this.session) return;
    if (change && (change.kind === "none" || change.kind === "selection")) return;

    this.refreshStructuralSyntax(documentVersion, change);
    this.refreshHighlightTokens(documentVersion, change);
  }

  private refreshStructuralSyntax(
    documentVersion: number,
    change: DocumentSessionChange | null,
  ): void {
    if (!this.syntaxSession || !this.session || !this.languageId) return;

    const text = this.session.getText();
    this.syntaxStatus = "loading";

    this.syntaxRequests.schedule({
      delayMs: syntaxRefreshDelay(change),
      run: () => this.loadSyntaxResult(change, text),
      apply: (result, startedAt) => this.applySyntaxResult(result, documentVersion, startedAt),
      fail: () => this.applySyntaxError(documentVersion),
    });
  }

  private refreshHighlightTokens(
    documentVersion: number,
    change: DocumentSessionChange | null,
  ): void {
    if (!this.highlighterSession || !this.session) return;

    const text = this.session.getText();
    this.highlightRequests.schedule({
      delayMs: syntaxRefreshDelay(change),
      run: () => this.loadHighlightResult(change, text),
      apply: (result, startedAt) => this.applyHighlightResult(result, documentVersion, startedAt),
      fail: (_error, startedAt) => this.applyHighlightError(documentVersion, startedAt),
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

  private loadHighlightResult(
    change: DocumentSessionChange | null,
    text: string,
  ): Promise<EditorHighlightResult> {
    if (!this.highlighterSession) return Promise.reject(new Error("No highlighter session"));
    if (!change) {
      const snapshot = this.session?.getSnapshot();
      if (!snapshot) return Promise.reject(new Error("No document snapshot"));
      return this.highlighterSession.refresh(snapshot, text);
    }

    return this.highlighterSession.applyChange(change);
  }

  private applySyntaxResult(
    result: EditorSyntaxResult,
    documentVersion: number,
    startedAt: number,
  ): void {
    if (!this.session || documentVersion !== this.documentVersion) return;

    this.syntaxStatus = "ready";
    const nextTokens = this.highlighterSession ? this.tokens : result.tokens;
    const tokenChange = this.session.adoptTokens(nextTokens);
    const timedChange = appendTiming(tokenChange, "editor.syntax", startedAt);
    if (!this.highlighterSession) this.adoptTokens(result.tokens);
    this.setSyntaxFolds(result.folds);
    this.notifyChange(timedChange);
  }

  private applyHighlightResult(
    result: EditorHighlightResult,
    documentVersion: number,
    startedAt: number,
  ): void {
    if (!this.session || documentVersion !== this.documentVersion) return;

    if (result.theme !== undefined) this.setHighlighterTheme(result.theme);
    const tokenChange = this.session.adoptTokens(result.tokens);
    const timedChange = appendTiming(tokenChange, "editor.highlight", startedAt);
    this.adoptTokens(result.tokens);
    this.notifyChange(timedChange);
  }

  private handleFoldToggle = (marker: VirtualizedFoldMarker): void => {
    this.foldState.toggle(marker);
  };

  private clearSyntaxFolds(): void {
    this.foldState.clear();
  }

  private adoptTokens(tokens: readonly EditorToken[]): void {
    this.tokens = tokens;
    this.view.adoptTokens(tokens);
    this.notifyViewContributions("tokens", null);
  }

  private applySyntaxError(documentVersion: number): void {
    if (documentVersion !== this.documentVersion) return;

    this.syntaxStatus = "error";
    this.notifyChange(null);
  }

  private applyHighlightError(documentVersion: number, startedAt: number): void {
    if (!this.session || documentVersion !== this.documentVersion) return;

    this.setHighlighterTheme(null);
    const tokenChange = this.session.adoptTokens([]);
    const timedChange = appendTiming(tokenChange, "editor.highlightError", startedAt);
    this.adoptTokens([]);
    this.notifyChange(timedChange);
  }

  private setHighlighterTheme(theme: EditorTheme | null | undefined): void {
    this.highlighterTheme = theme ?? null;
    this.applyResolvedTheme();
  }

  private setProviderHighlighterTheme(theme: EditorTheme | null | undefined): void {
    this.providerHighlighterTheme = theme ?? null;
    this.applyResolvedTheme();
  }

  private applyResolvedTheme(): void {
    this.view.setTheme(
      mergeEditorThemes(this.configuredTheme, this.providerHighlighterTheme, this.highlighterTheme),
    );
  }

  private syncDomSelection(): void {
    if (!this.session) return;

    const selection = this.session.getSelections().selections[0];
    if (!selection) return;

    const resolved = resolveSelection(this.session.getSnapshot(), selection);
    const start = clamp(resolved.startOffset, 0, this.text.length);
    const end = clamp(resolved.endOffset, start, this.text.length);

    if (this.isInputFocused()) {
      this.syncCustomSelectionHighlight(start, end);
      this.notifyViewContributions("selection", null);
      return;
    }

    const range = this.view.createRange(start, end, { scrollIntoView: false });
    const domSelection = window.getSelection();
    domSelection?.removeAllRanges();
    if (range) domSelection?.addRange(range);
    this.syncCustomSelectionHighlight(start, end);
    this.notifyViewContributions("selection", null);
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

function viewContributionKindForChange(
  change: DocumentSessionChange,
): EditorViewContributionUpdateKind {
  if (change.kind === "selection") return "selection";
  return "content";
}
