import type {
  DocumentSessionChange,
  EditorDisposable,
  EditorFeatureContribution,
  EditorFeatureContributionContext,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
  TextEdit,
  VirtualizedTextHighlightStyle,
} from "@editor/core";
import {
  createWorkerLspTransport,
  lspPositionToOffset,
  LspClient,
  LspWorkspace,
  offsetToLspPosition,
  type LspManagedTransport,
  type LspWorkerLike,
} from "@editor/lsp";
import type * as lsp from "vscode-languageserver-protocol";
import {
  diagnosticHighlightGroups,
  summarizeDiagnostics,
  type TypeScriptLspDiagnosticSeverity,
} from "./diagnostics";
import { renderTooltipMarkdown } from "./markdownTooltip";
import { documentUriToFileName, isTypeScriptFileName, pathOrUriToDocumentUri } from "./paths";
import type {
  TypeScriptLspDefinitionTarget,
  TypeScriptLspDiagnosticSummary,
  TypeScriptLspPlugin,
  TypeScriptLspPluginOptions,
  TypeScriptLspSourceFile,
  TypeScriptLspStatus,
} from "./types";

export type TypeScriptLspResolvedOptions = {
  readonly rootUri: lsp.DocumentUri | null;
  readonly compilerOptions: TypeScriptLspPluginOptions["compilerOptions"];
  readonly diagnosticDelayMs: number;
  readonly timeoutMs: number;
  readonly workerFactory: () => LspWorkerLike;
  readonly onStatusChange?: (status: TypeScriptLspStatus) => void;
  readonly onDiagnostics?: (summary: TypeScriptLspDiagnosticSummary) => void;
  readonly onOpenDefinition?: (target: TypeScriptLspDefinitionTarget) => void | boolean;
  readonly onError?: (error: unknown) => void;
};

type ActiveDocument = {
  readonly uri: lsp.DocumentUri;
  readonly languageId: string;
  readonly text: string;
  readonly textVersion: number;
  readonly lspVersion: number;
};

type DocumentDescriptor = {
  readonly uri: lsp.DocumentUri;
  readonly languageId: string;
  readonly text: string;
  readonly textVersion: number;
};

type OffsetRange = {
  readonly start: number;
  readonly end: number;
};

type TooltipAnchorNames = {
  readonly anchorName: string;
};

const DEFAULT_DIAGNOSTIC_DELAY_MS = 150;
const DEFAULT_TIMEOUT_MS = 15000;
const HOVER_DELAY_MS = 250;
const HOVER_HIDE_DELAY_MS = 180;
const COPY_BUTTON_RESET_DELAY_MS = 1200;
const TOOLTIP_GAP_PX = 8;
const TOOLTIP_VIEWPORT_MARGIN_PX = 12;
const SVG_NS = "http://www.w3.org/2000/svg";
let nextTooltipAnchorId = 0;
const LINK_HIGHLIGHT_STYLE: VirtualizedTextHighlightStyle = {
  backgroundColor: "transparent",
  color: "#60a5fa",
  textDecoration: "underline solid #60a5fa",
};
const DIAGNOSTIC_STYLES: Record<TypeScriptLspDiagnosticSeverity, VirtualizedTextHighlightStyle> = {
  error: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    textDecoration: "underline wavy rgba(248, 113, 113, 0.95)",
  },
  warning: { backgroundColor: "rgba(245, 158, 11, 0.26)" },
  information: { backgroundColor: "rgba(59, 130, 246, 0.22)" },
  hint: { backgroundColor: "rgba(148, 163, 184, 0.22)" },
};
const DIAGNOSTIC_SEVERITIES: readonly TypeScriptLspDiagnosticSeverity[] = [
  "error",
  "warning",
  "information",
  "hint",
];

export function createTypeScriptLspPlugin(
  options: TypeScriptLspPluginOptions = {},
): TypeScriptLspPlugin {
  const resolved = resolveOptions(options);
  const state = new TypeScriptLspPluginState();

  return {
    name: "editor.typescript-lsp",
    setWorkspaceFiles: (files) => state.setWorkspaceFiles(files),
    clearWorkspaceFiles: () => state.clearWorkspaceFiles(),
    activate(context) {
      return [
        context.registerViewContribution({
          createContribution: (contributionContext) =>
            new TypeScriptLspContribution(contributionContext, state, resolved),
        }),
        context.registerEditorFeatureContribution({
          createContribution: (contributionContext) =>
            new TypeScriptLspCommandContribution(contributionContext, state),
        }),
      ];
    },
  };
}

class TypeScriptLspPluginState {
  private readonly contributions = new Set<TypeScriptLspContribution>();
  private files: readonly TypeScriptLspSourceFile[] = [];

  public get workspaceFiles(): readonly TypeScriptLspSourceFile[] {
    return this.files;
  }

  public setWorkspaceFiles(files: readonly TypeScriptLspSourceFile[]): void {
    this.files = files.map((file) => ({ path: file.path, text: file.text }));
    this.notifyWorkspaceFilesChanged();
  }

  public clearWorkspaceFiles(): void {
    this.files = [];
    this.notifyWorkspaceFilesChanged();
  }

  public register(contribution: TypeScriptLspContribution): void {
    this.contributions.add(contribution);
  }

  public unregister(contribution: TypeScriptLspContribution): void {
    this.contributions.delete(contribution);
  }

  private notifyWorkspaceFilesChanged(): void {
    for (const contribution of this.contributions) contribution.syncWorkspaceFiles();
  }

  public goToDefinitionFromSelection(): boolean {
    for (const contribution of this.contributions) {
      if (contribution.goToDefinitionFromSelection()) return true;
    }

    return false;
  }
}

class TypeScriptLspCommandContribution implements EditorFeatureContribution {
  private readonly command: EditorDisposable;

  public constructor(
    _context: EditorFeatureContributionContext,
    private readonly state: TypeScriptLspPluginState,
  ) {
    this.command = _context.registerCommand("goToDefinition", () =>
      this.state.goToDefinitionFromSelection(),
    );
  }

  public dispose(): void {
    this.command.dispose();
  }
}

class TypeScriptLspContribution implements EditorViewContribution {
  private readonly workspace = new LspWorkspace();
  private readonly worker: LspWorkerLike;
  private readonly transport: LspManagedTransport;
  private readonly client: LspClient;
  private readonly highlightNames: Record<TypeScriptLspDiagnosticSeverity, string>;
  private readonly linkHighlightName: string;
  private activeDocument: ActiveDocument | null = null;
  private activeDiagnostics: readonly lsp.Diagnostic[] = [];
  private disposed = false;
  private status: TypeScriptLspStatus = "idle";
  private readonly tooltip: HTMLDivElement;
  private readonly tooltipAnchor: HTMLDivElement;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverHideTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverAbort: AbortController | null = null;
  private hoverRequestId = 0;
  private definitionRequestId = 0;
  private definitionHoverRequestId = 0;
  private lastPointerOffset: number | null = null;
  private linkRange: OffsetRange | null = null;
  private tooltipPointerDown = false;

  public constructor(
    private readonly context: EditorViewContributionContext,
    private readonly state: TypeScriptLspPluginState,
    private readonly options: TypeScriptLspResolvedOptions,
  ) {
    const prefix = context.highlightPrefix ?? "editor-typescript-lsp";
    this.highlightNames = createHighlightNames(prefix);
    this.linkHighlightName = `${prefix}-typescript-lsp-definition-link`;
    const tooltipNames = nextTooltipAnchorNames();
    this.worker = options.workerFactory();
    this.transport = createWorkerLspTransport(this.worker, {
      messageFormat: "json",
      terminateOnClose: true,
    });
    this.client = this.createClient();
    this.tooltipAnchor = createTooltipAnchorElement(
      context.container.ownerDocument,
      tooltipNames.anchorName,
    );
    this.tooltip = createTooltipElement(context.container.ownerDocument, tooltipNames);
    context.container.ownerDocument.body.append(this.tooltipAnchor, this.tooltip);
    this.installPointerHandlers();
    this.state.register(this);
    this.connect();
    this.update(context.getSnapshot(), "document", null);
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void {
    if (this.disposed) return;
    if (kind === "content" || kind === "document" || kind === "clear" || kind === "viewport") {
      this.hideHover();
      this.clearDefinitionLink();
    }
    if (!shouldSyncDocument(kind, snapshot, this.activeDocument)) return;

    this.syncDocument(snapshot, change ?? null);
  }

  public dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.state.unregister(this);
    this.uninstallPointerHandlers();
    this.hideHover();
    this.clearDefinitionLink();
    this.tooltipAnchor.remove();
    this.tooltip.remove();
    this.clearDiagnosticHighlights();
    this.closeActiveDocument();
    this.client.disconnect();
    this.transport.close();
    this.setStatus("idle");
  }

  public syncWorkspaceFiles(): void {
    if (this.disposed) return;
    if (!this.client.connected) return;

    void this.client
      .notify("editor/typescript/setWorkspaceFiles", { files: this.state.workspaceFiles })
      .catch((error: unknown) => this.handleError(error));
  }

  public goToDefinitionFromSelection(): boolean {
    const active = this.activeDocument;
    if (!active) return false;

    const selection = this.context.getSnapshot().selections[0];
    if (!selection) return false;
    return this.goToDefinitionAtOffset(selection.headOffset);
  }

  private createClient(): LspClient {
    return new LspClient({
      rootUri: this.options.rootUri,
      workspaceFolders: null,
      workspace: this.workspace,
      timeoutMs: this.options.timeoutMs,
      initializationOptions: {
        compilerOptions: this.options.compilerOptions,
        diagnosticDelayMs: this.options.diagnosticDelayMs,
      },
      notificationHandlers: {
        "textDocument/publishDiagnostics": (_client, params) => {
          this.handlePublishDiagnostics(params);
          return true;
        },
      },
    });
  }

  private connect(): void {
    this.setStatus("loading");
    void this.client
      .connect(this.transport)
      .then(() => this.handleConnected())
      .catch((error: unknown) => this.handleConnectError(error));
  }

  private handleConnected(): void {
    if (this.disposed) return;
    this.setStatus("ready");
    this.syncWorkspaceFiles();
  }

  private handleConnectError(error: unknown): void {
    if (this.disposed) return;
    this.setStatus("error");
    this.handleError(error);
  }

  private syncDocument(snapshot: EditorViewSnapshot, change: DocumentSessionChange | null): void {
    const descriptor = documentDescriptor(snapshot);
    if (!descriptor) {
      this.closeActiveDocument();
      return;
    }

    this.openOrUpdateDocument(descriptor, change);
  }

  private openOrUpdateDocument(
    descriptor: DocumentDescriptor,
    change: DocumentSessionChange | null,
  ): void {
    const active = this.activeDocument;
    if (!active || active.uri !== descriptor.uri || active.languageId !== descriptor.languageId) {
      this.openDocument(descriptor);
      return;
    }

    if (active.textVersion === descriptor.textVersion && active.text === descriptor.text) return;
    this.updateDocument(descriptor, change);
  }

  private openDocument(descriptor: DocumentDescriptor): void {
    this.closeActiveDocument();
    const document = this.workspace.openDocument(descriptor);
    this.activeDocument = { ...descriptor, lspVersion: document.version };
  }

  private updateDocument(
    descriptor: DocumentDescriptor,
    change: DocumentSessionChange | null,
  ): void {
    const document = this.workspace.updateDocument(descriptor.uri, descriptor.text, {
      edits: editsForChange(change),
    });
    this.activeDocument = { ...descriptor, lspVersion: document.version };
  }

  private closeActiveDocument(): void {
    const active = this.activeDocument;
    this.activeDocument = null;
    this.activeDiagnostics = [];
    if (!active) return;

    this.clearDiagnosticHighlights();
    this.workspace.closeDocument(active.uri);
    this.options.onDiagnostics?.(summarizeDiagnostics(active.uri, active.lspVersion, []));
  }

  private handlePublishDiagnostics(params: unknown): void {
    const diagnostics = publishDiagnosticsParams(params);
    if (!diagnostics) return;

    const active = this.activeDocument;
    if (!active) return;
    if (diagnostics.uri !== active.uri) return;
    if (diagnostics.version !== null && diagnostics.version !== active.lspVersion) return;

    this.activeDiagnostics = diagnostics.diagnostics;
    this.renderDiagnostics(active.text, diagnostics.diagnostics);
    this.options.onDiagnostics?.(
      summarizeDiagnostics(active.uri, diagnostics.version, diagnostics.diagnostics),
    );
  }

  private renderDiagnostics(text: string, diagnostics: readonly lsp.Diagnostic[]): void {
    if (!this.context.setRangeHighlight) return;

    const groups = diagnosticHighlightGroups(text, diagnostics);
    for (const severity of DIAGNOSTIC_SEVERITIES) {
      this.context.setRangeHighlight(
        this.highlightNames[severity],
        groups[severity],
        DIAGNOSTIC_STYLES[severity],
      );
    }
  }

  private clearDiagnosticHighlights(): void {
    if (!this.context.clearRangeHighlight) return;

    for (const name of Object.values(this.highlightNames)) this.context.clearRangeHighlight(name);
  }

  private setStatus(status: TypeScriptLspStatus): void {
    if (this.status === status) return;

    this.status = status;
    this.options.onStatusChange?.(status);
  }

  private handleError(error: unknown): void {
    this.options.onError?.(error);
  }

  private installPointerHandlers(): void {
    this.context.scrollElement.addEventListener("pointermove", this.handlePointerMove);
    this.context.scrollElement.addEventListener("pointerleave", this.handlePointerLeave);
    this.context.scrollElement.addEventListener("mousedown", this.handleMouseDown, {
      capture: true,
    });
    this.tooltip.addEventListener("pointerenter", this.handleTooltipPointerEnter);
    this.tooltip.addEventListener("pointerleave", this.handleTooltipPointerLeave);
    this.tooltip.addEventListener("pointerdown", this.handleTooltipPointerDown);
    this.context.container.ownerDocument.addEventListener(
      "pointerdown",
      this.handleDocumentPointerDown,
      {
        capture: true,
      },
    );
    this.context.container.ownerDocument.addEventListener(
      "pointerup",
      this.handleDocumentPointerUp,
    );
    this.context.container.ownerDocument.addEventListener(
      "pointercancel",
      this.handleDocumentPointerUp,
    );
    this.context.container.ownerDocument.addEventListener("keydown", this.handleKeyDown);
    this.context.container.ownerDocument.addEventListener("keyup", this.handleKeyUp);
  }

  private uninstallPointerHandlers(): void {
    this.context.scrollElement.removeEventListener("pointermove", this.handlePointerMove);
    this.context.scrollElement.removeEventListener("pointerleave", this.handlePointerLeave);
    this.context.scrollElement.removeEventListener("mousedown", this.handleMouseDown, {
      capture: true,
    });
    this.tooltip.removeEventListener("pointerenter", this.handleTooltipPointerEnter);
    this.tooltip.removeEventListener("pointerleave", this.handleTooltipPointerLeave);
    this.tooltip.removeEventListener("pointerdown", this.handleTooltipPointerDown);
    this.context.container.ownerDocument.removeEventListener(
      "pointerdown",
      this.handleDocumentPointerDown,
      { capture: true },
    );
    this.context.container.ownerDocument.removeEventListener(
      "pointerup",
      this.handleDocumentPointerUp,
    );
    this.context.container.ownerDocument.removeEventListener(
      "pointercancel",
      this.handleDocumentPointerUp,
    );
    this.context.container.ownerDocument.removeEventListener("keydown", this.handleKeyDown);
    this.context.container.ownerDocument.removeEventListener("keyup", this.handleKeyUp);
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (event.buttons !== 0) return this.clearPointerUi();
    if (this.pointInTooltipHoverZone(event.clientX, event.clientY)) {
      this.lastPointerOffset = null;
      this.clearDefinitionLink();
      this.cancelHoverHide();
      return;
    }
    if (!this.activeDocument) return this.clearPointerUi();

    const offset = this.context.textOffsetFromPoint(event.clientX, event.clientY);
    if (offset === null) return this.clearPointerUi();

    this.lastPointerOffset = offset;
    if (isNavigationModifier(event)) {
      this.requestDefinitionLink(offset);
    } else {
      this.clearDefinitionLink();
    }

    this.scheduleHover(offset);
  };

  private readonly handlePointerLeave = (event: PointerEvent): void => {
    this.lastPointerOffset = null;
    this.clearDefinitionLink();
    if (targetInsideElement(this.tooltip, event.relatedTarget)) {
      this.cancelHoverHide();
      return;
    }

    this.scheduleHoverHide();
  };

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (!isNavigationModifier(event)) return;

    const offset = this.context.textOffsetFromPoint(event.clientX, event.clientY);
    if (offset === null) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    this.context.focusEditor();
    this.goToDefinitionAtOffset(offset);
  };

  private readonly handleTooltipPointerEnter = (): void => {
    this.cancelHoverHide();
  };

  private readonly handleTooltipPointerLeave = (event: PointerEvent): void => {
    if (this.tooltipPointerDown) return;
    if (targetInsideElement(this.context.scrollElement, event.relatedTarget)) return;

    this.scheduleHoverHide();
  };

  private readonly handleTooltipPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;

    this.tooltipPointerDown = true;
    this.cancelHoverHide();
  };

  private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    if (targetInsideElement(this.tooltip, event.target)) return;

    this.tooltipPointerDown = false;
    this.clearPointerUi();
  };

  private readonly handleDocumentPointerUp = (): void => {
    this.tooltipPointerDown = false;
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!isNavigationModifier(event)) return;
    if (this.lastPointerOffset === null) return;

    this.requestDefinitionLink(this.lastPointerOffset);
    this.scheduleHover(this.lastPointerOffset);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== "Meta" && event.key !== "Control") return;

    this.clearDefinitionLink();
  };

  private scheduleHover(offset: number): void {
    this.cancelHoverHide();
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      void this.requestHover(offset);
    }, HOVER_DELAY_MS);
  }

  private async requestHover(offset: number): Promise<void> {
    const active = this.activeDocument;
    if (!active) return;
    if (!this.client.connected) return;

    this.hoverAbort?.abort();
    const requestId = this.hoverRequestId + 1;
    const abort = new AbortController();
    this.hoverRequestId = requestId;
    this.hoverAbort = abort;

    try {
      const hover = await this.client.request<lsp.Hover | null>("textDocument/hover", {
        textDocument: { uri: active.uri },
        position: offsetToLspPosition(active.text, offset),
      } satisfies lsp.TextDocumentPositionParams, { signal: abort.signal });
      this.renderHoverResult(requestId, active, offset, hover);
    } catch (error) {
      this.handleRequestError(error);
    }
  }

  private renderHoverResult(
    requestId: number,
    active: ActiveDocument,
    offset: number,
    hover: lsp.Hover | null,
  ): void {
    if (requestId !== this.hoverRequestId) return;
    if (active !== this.activeDocument) return;

    const diagnostics = diagnosticsAtOffset(active.text, offset, this.activeDiagnostics);
    if (!hover && diagnostics.length === 0) {
      this.hideHover();
      return;
    }

    const range = hoverRangeOffsets(active.text, hover) ?? visibleRangeAtOffset(active.text, offset);
    const rect = this.context.getRangeClientRect(range.start, range.end);
    if (!rect) return this.hideHover();

    positionTooltip(this.tooltipAnchor, rect);
    renderTooltip(this.tooltip, {
      hoverText: hoverText(hover),
      diagnostics,
    });
    placeTooltip(this.tooltip, rect);
  }

  private goToDefinitionAtOffset(offset: number): boolean {
    const active = this.activeDocument;
    if (!active) return false;
    if (!this.client.connected) return false;

    this.hideHover();
    this.clearDefinitionLink();
    const requestId = this.definitionRequestId + 1;
    this.definitionRequestId = requestId;
    void this.client
      .request<lsp.Location[] | lsp.Location | lsp.LocationLink[] | null>(
        "textDocument/definition",
        {
          textDocument: { uri: active.uri },
          position: offsetToLspPosition(active.text, offset),
        } satisfies lsp.TextDocumentPositionParams,
      )
      .then((result) => this.handleDefinitionResult(requestId, active, result))
      .catch((error: unknown) => this.handleRequestError(error));
    return true;
  }

  private requestDefinitionLink(offset: number): void {
    const active = this.activeDocument;
    if (!active) return this.clearDefinitionLink();
    if (!this.client.connected) return this.clearDefinitionLink();

    const range = identifierRangeAtOffset(active.text, offset);
    if (!range) return this.clearDefinitionLink();
    if (sameRange(this.linkRange, range)) return;

    const requestId = this.definitionHoverRequestId + 1;
    this.definitionHoverRequestId = requestId;
    void this.client
      .request<lsp.Location[] | lsp.Location | lsp.LocationLink[] | null>(
        "textDocument/definition",
        {
          textDocument: { uri: active.uri },
          position: offsetToLspPosition(active.text, offset),
        } satisfies lsp.TextDocumentPositionParams,
      )
      .then((result) => this.renderDefinitionLink(requestId, active, range, result))
      .catch((error: unknown) => this.handleRequestError(error));
  }

  private renderDefinitionLink(
    requestId: number,
    active: ActiveDocument,
    range: OffsetRange,
    result: lsp.Location[] | lsp.Location | lsp.LocationLink[] | null,
  ): void {
    if (requestId !== this.definitionHoverRequestId) return;
    if (active !== this.activeDocument) return;
    if (!preferredJumpableDefinitionTarget(active, range, result)) return this.clearDefinitionLink();

    this.linkRange = range;
    this.context.setRangeHighlight?.(this.linkHighlightName, [range], LINK_HIGHLIGHT_STYLE);
    this.context.scrollElement.style.cursor = "pointer";
  }

  private handleDefinitionResult(
    requestId: number,
    active: ActiveDocument,
    result: lsp.Location[] | lsp.Location | lsp.LocationLink[] | null,
  ): void {
    if (requestId !== this.definitionRequestId) return;
    if (active !== this.activeDocument) return;

    const target = preferredDefinitionTarget(active.uri, result);
    if (!target) return;
    if (target.uri === active.uri) {
      this.navigateWithinActiveDocument(active.text, target.range);
      return;
    }

    this.options.onOpenDefinition?.(target);
  }

  private navigateWithinActiveDocument(text: string, range: lsp.Range): void {
    const start = lspPositionToOffset(text, range.start);
    const end = lspPositionToOffset(text, range.end);
    this.context.setSelection(start, end, "typescriptLsp.goToDefinition", start);
    this.context.focusEditor();
  }

  private hideHover(): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (this.hoverHideTimer) clearTimeout(this.hoverHideTimer);
    this.hoverTimer = null;
    this.hoverHideTimer = null;
    this.hoverAbort?.abort();
    this.hoverAbort = null;
    this.hoverRequestId += 1;
    this.tooltipPointerDown = false;
    this.tooltip.hidden = true;
    this.tooltipAnchor.style.display = "none";
    this.tooltip.replaceChildren();
  }

  private scheduleHoverHide(): void {
    if (this.tooltipPointerDown) return;
    if (this.hoverHideTimer) clearTimeout(this.hoverHideTimer);

    this.hoverHideTimer = setTimeout(() => {
      this.hoverHideTimer = null;
      this.hideHover();
    }, HOVER_HIDE_DELAY_MS);
  }

  private cancelHoverHide(): void {
    if (!this.hoverHideTimer) return;

    clearTimeout(this.hoverHideTimer);
    this.hoverHideTimer = null;
  }

  private clearPointerUi(): void {
    this.hideHover();
    this.clearDefinitionLink();
  }

  private clearDefinitionLink(): void {
    this.definitionHoverRequestId += 1;
    this.linkRange = null;
    this.context.clearRangeHighlight?.(this.linkHighlightName);
    this.context.scrollElement.style.cursor = "";
  }

  private handleRequestError(error: unknown): void {
    if (isAbortError(error)) return;
    this.handleError(error);
  }

  private pointInTooltipHoverZone(clientX: number, clientY: number): boolean {
    if (this.tooltip.hidden) return false;

    const tooltipRect = this.tooltip.getBoundingClientRect();
    const anchorRect = this.tooltipAnchor.getBoundingClientRect();
    const hoverZone = expandRect(unionRects(tooltipRect, anchorRect), TOOLTIP_GAP_PX);
    return rectContainsPoint(hoverZone, clientX, clientY);
  }
}

function resolveOptions(options: TypeScriptLspPluginOptions): TypeScriptLspResolvedOptions {
  return {
    rootUri: options.rootUri ?? "file:///",
    compilerOptions: options.compilerOptions,
    diagnosticDelayMs: options.diagnosticDelayMs ?? DEFAULT_DIAGNOSTIC_DELAY_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    workerFactory: options.workerFactory ?? defaultWorkerFactory,
    onStatusChange: options.onStatusChange,
    onDiagnostics: options.onDiagnostics,
    onOpenDefinition: options.onOpenDefinition,
    onError: options.onError,
  };
}

function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./typescriptLsp.worker.ts", import.meta.url), { type: "module" });
}

function shouldSyncDocument(
  kind: EditorViewContributionUpdateKind,
  snapshot: EditorViewSnapshot,
  active: ActiveDocument | null,
): boolean {
  if (kind === "document" || kind === "content" || kind === "clear") return true;
  if (!active) return false;
  return active.textVersion !== snapshot.textVersion;
}

function documentDescriptor(snapshot: EditorViewSnapshot): DocumentDescriptor | null {
  if (!snapshot.documentId) return null;
  if (!snapshot.languageId) return null;
  if (!isTypeScriptLanguage(snapshot.languageId)) return null;

  const uri = pathOrUriToDocumentUri(snapshot.documentId);
  if (!isTypeScriptFileName(uri)) return null;
  return {
    uri,
    languageId: snapshot.languageId,
    text: snapshot.text,
    textVersion: snapshot.textVersion,
  };
}

function isTypeScriptLanguage(languageId: string): boolean {
  return languageId === "typescript" || languageId === "typescriptreact";
}

function editsForChange(change: DocumentSessionChange | null): readonly TextEdit[] {
  if (!change) return [];
  return change.edits;
}

function publishDiagnosticsParams(params: unknown): {
  readonly uri: lsp.DocumentUri;
  readonly version: number | null;
  readonly diagnostics: readonly lsp.Diagnostic[];
} | null {
  if (!isRecord(params)) return null;
  if (typeof params.uri !== "string") return null;
  if (!Array.isArray(params.diagnostics)) return null;

  return {
    uri: params.uri,
    version: typeof params.version === "number" ? params.version : null,
    diagnostics: params.diagnostics as lsp.Diagnostic[],
  };
}

function createHighlightNames(prefix: string): Record<TypeScriptLspDiagnosticSeverity, string> {
  return {
    error: `${prefix}-typescript-lsp-error`,
    warning: `${prefix}-typescript-lsp-warning`,
    information: `${prefix}-typescript-lsp-information`,
    hint: `${prefix}-typescript-lsp-hint`,
  };
}

function nextTooltipAnchorNames(): TooltipAnchorNames {
  nextTooltipAnchorId += 1;
  return {
    anchorName: `--editor-typescript-lsp-hover-${nextTooltipAnchorId}`,
  };
}

function createTooltipAnchorElement(document: Document, anchorName: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "editor-typescript-lsp-hover-anchor";
  Object.assign(element.style, {
    position: "fixed",
    display: "none",
    opacity: "0",
    pointerEvents: "none",
  });
  element.style.setProperty("anchor-name", anchorName);
  return element;
}

function createTooltipElement(document: Document, names: TooltipAnchorNames): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "editor-typescript-lsp-hover";
  element.hidden = true;
  Object.assign(element.style, {
    position: "fixed",
    zIndex: "1000",
    width: "max-content",
    maxWidth: "min(520px, calc(100vw - 24px))",
    overflow: "visible",
    padding: "8px 10px",
    border: "1px solid rgba(82, 82, 91, 0.95)",
    borderRadius: "6px",
    boxSizing: "border-box",
    background: "rgba(24, 24, 27, 0.98)",
    color: "#e4e4e7",
    boxShadow: "0 12px 34px rgba(0, 0, 0, 0.36)",
    display: "grid",
    gap: "6px",
    font: "12px/1.45 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    whiteSpace: "normal",
    pointerEvents: "auto",
    userSelect: "text",
    cursor: "text",
  });
  applyCssAnchorPosition(element, names);
  return element;
}

function renderTooltip(
  element: HTMLDivElement,
  content: {
    readonly hoverText: string | null;
    readonly diagnostics: readonly lsp.Diagnostic[];
  },
): void {
  element.replaceChildren();
  const body = element.ownerDocument.createElement("div");
  body.style.minWidth = "0";
  if (content.hoverText) {
    body.append(renderTooltipMarkdown(element.ownerDocument, content.hoverText));
  }
  if (content.diagnostics.length > 0) {
    body.append(diagnosticSection(element.ownerDocument, content.diagnostics));
  }

  element.append(createCopyButton(element.ownerDocument, tooltipCopyText(content)), body);
  element.hidden = false;
}

function createCopyButton(document: Document, copyText: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "editor-typescript-lsp-hover-copy";
  Object.assign(button.style, {
    display: "inline-grid",
    placeItems: "center",
    justifySelf: "end",
    width: "22px",
    height: "22px",
    margin: "-2px -3px 0 0",
    border: "1px solid transparent",
    borderRadius: "4px",
    padding: "0",
    background: "transparent",
    color: "#a1a1aa",
    cursor: "pointer",
    opacity: "0.72",
    userSelect: "none",
  });
  setCopyButtonState(button, "idle");
  button.addEventListener("mouseenter", () => styleCopyButtonHover(button, true));
  button.addEventListener("mouseleave", () => styleCopyButtonHover(button, false));
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void handleCopyButtonClick(button, copyText);
  });
  return button;
}

type CopyButtonState = "idle" | "copied" | "failed";

function setCopyButtonState(button: HTMLButtonElement, state: CopyButtonState): void {
  button.title = copyButtonLabel(state);
  button.setAttribute("aria-label", copyButtonLabel(state));
  button.style.color = copyButtonColor(state);
  button.replaceChildren(copyButtonIcon(button.ownerDocument, state));
}

function styleCopyButtonHover(button: HTMLButtonElement, active: boolean): void {
  Object.assign(button.style, {
    background: active ? "rgba(82, 82, 91, 0.28)" : "transparent",
    borderColor: active ? "rgba(113, 113, 122, 0.34)" : "transparent",
    opacity: active ? "1" : "0.72",
  });
}

function copyButtonLabel(state: CopyButtonState): string {
  if (state === "copied") return "Copied hover text";
  if (state === "failed") return "Copy failed";
  return "Copy hover text";
}

function copyButtonColor(state: CopyButtonState): string {
  if (state === "copied") return "#86efac";
  if (state === "failed") return "#f87171";
  return "#a1a1aa";
}

function copyButtonIcon(document: Document, state: CopyButtonState): SVGSVGElement {
  const icon = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "14");
  icon.setAttribute("height", "14");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");

  for (const pathData of copyButtonIconPaths(state)) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", pathData);
    icon.append(path);
  }

  return icon;
}

function copyButtonIconPaths(state: CopyButtonState): readonly string[] {
  if (state === "copied") return ["M20 6 9 17l-5-5"];
  if (state === "failed") return ["M12 8v5", "M12 17h.01", "M10.3 4h3.4L22 19H2L10.3 4Z"];
  return ["M8 8h12v12H8Z", "M4 4h12v2", "M4 4v12h2"];
}

async function handleCopyButtonClick(button: HTMLButtonElement, copyText: string): Promise<void> {
  const copied = await copyTextToClipboard(button.ownerDocument, copyText);
  showCopyButtonStatus(button, copied);
}

function showCopyButtonStatus(button: HTMLButtonElement, copied: boolean): void {
  setCopyButtonState(button, copied ? "copied" : "failed");
  setTimeout(() => {
    if (!button.isConnected) return;
    setCopyButtonState(button, "idle");
  }, COPY_BUTTON_RESET_DELAY_MS);
}

async function copyTextToClipboard(document: Document, text: string): Promise<boolean> {
  const clipboard = document.defaultView?.navigator.clipboard;
  if (!clipboard) return copyTextWithTextarea(document, text);

  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return copyTextWithTextarea(document, text);
  }
}

function copyTextWithTextarea(document: Document, text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  Object.assign(textarea.style, {
    position: "fixed",
    top: "-9999px",
    left: "-9999px",
    opacity: "0",
  });
  document.body.append(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function tooltipCopyText(content: {
  readonly hoverText: string | null;
  readonly diagnostics: readonly lsp.Diagnostic[];
}): string {
  const parts = [
    plainHoverText(content.hoverText),
    ...content.diagnostics.map(diagnosticCopyText),
  ].filter((part) => part.length > 0);
  return parts.join("\n\n");
}

function plainHoverText(markdown: string | null): string {
  if (!markdown) return "";
  return markdown
    .replace(/^```[^\n]*\n/gm, "")
    .replace(/^```\s*$/gm, "")
    .trim();
}

function diagnosticCopyText(diagnostic: lsp.Diagnostic): string {
  return `${severityForDiagnostic(diagnostic)}: ${diagnostic.message}`.trim();
}

function diagnosticSection(
  document: Document,
  diagnostics: readonly lsp.Diagnostic[],
): HTMLElement {
  const section = document.createElement("div");
  section.style.marginTop = "8px";
  section.style.paddingTop = "8px";
  section.style.borderTop = "1px solid rgba(82, 82, 91, 0.7)";
  for (const diagnostic of diagnostics) section.append(diagnosticRow(document, diagnostic));
  return section;
}

function diagnosticRow(document: Document, diagnostic: lsp.Diagnostic): HTMLElement {
  const row = document.createElement("div");
  row.style.display = "grid";
  row.style.gridTemplateColumns = "auto 1fr";
  row.style.gap = "8px";
  row.style.alignItems = "baseline";

  const label = document.createElement("span");
  label.textContent = severityForDiagnostic(diagnostic);
  label.style.color = diagnosticColor(diagnostic);

  const message = document.createElement("span");
  message.textContent = diagnostic.message;

  row.append(label, message);
  return row;
}

function positionTooltip(anchorElement: HTMLDivElement, anchor: DOMRect): void {
  positionTooltipAnchor(anchorElement, anchor);
}

function positionTooltipAnchor(element: HTMLDivElement, anchor: DOMRect): void {
  Object.assign(element.style, {
    display: "block",
    left: `${anchor.left}px`,
    top: `${anchor.top}px`,
    width: `${Math.max(1, anchor.width)}px`,
    height: `${Math.max(1, anchor.height)}px`,
  });
}

function applyCssAnchorPosition(element: HTMLDivElement, names: TooltipAnchorNames): void {
  element.style.setProperty("position-anchor", names.anchorName);
  element.style.setProperty("inset", "auto");
  applyTooltipPlacement(element, "top");
}

function placeTooltip(element: HTMLDivElement, anchor: DOMRect): void {
  const tooltipHeight = element.getBoundingClientRect().height;
  const topY = anchor.top - tooltipHeight - TOOLTIP_GAP_PX;
  const placement = topY >= TOOLTIP_VIEWPORT_MARGIN_PX ? "top" : "bottom";
  applyTooltipPlacement(element, placement);
}

function applyTooltipPlacement(element: HTMLDivElement, placement: "top" | "bottom"): void {
  element.style.setProperty("position-area", `${placement} center`);
  element.style.setProperty("margin-top", placement === "bottom" ? `${TOOLTIP_GAP_PX}px` : "0");
  element.style.setProperty("margin-bottom", placement === "top" ? `${TOOLTIP_GAP_PX}px` : "0");
}

function hoverText(hover: lsp.Hover | null): string | null {
  if (!hover) return null;

  const text = hoverContentsText(hover.contents).trim();
  if (!text) return null;
  return text;
}

function hoverContentsText(contents: lsp.Hover["contents"]): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(markedStringText).join("\n\n");
  if ("kind" in contents) return contents.value;
  return markedStringText(contents);
}

function markedStringText(value: lsp.MarkedString): string {
  if (typeof value === "string") return value;
  return ["```" + value.language, value.value, "```"].join("\n");
}

function hoverRangeOffsets(
  text: string,
  hover: lsp.Hover | null,
): { readonly start: number; readonly end: number } | null {
  if (!hover?.range) return null;

  const start = lspPositionToOffset(text, hover.range.start);
  const end = lspPositionToOffset(text, hover.range.end);
  if (end > start) return { start, end };
  return null;
}

function visibleRangeAtOffset(
  text: string,
  offset: number,
): OffsetRange {
  const start = Math.max(0, Math.min(offset, Math.max(0, text.length - 1)));
  return { start, end: Math.min(text.length, start + 1) };
}

function identifierRangeAtOffset(text: string, offset: number): OffsetRange | null {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const index = identifierIndexAtOffset(text, clamped);
  if (index === null) return null;

  let start = index;
  while (start > 0 && isIdentifierCharacter(text[start - 1] ?? "")) start -= 1;

  let end = index + 1;
  while (end < text.length && isIdentifierCharacter(text[end] ?? "")) end += 1;

  if (end <= start) return null;
  return { start, end };
}

function identifierIndexAtOffset(text: string, offset: number): number | null {
  if (isIdentifierCharacter(text[offset] ?? "")) return offset;
  if (offset > 0 && isIdentifierCharacter(text[offset - 1] ?? "")) return offset - 1;
  return null;
}

function isIdentifierCharacter(value: string): boolean {
  return /^[A-Za-z0-9_$]$/.test(value);
}

function sameRange(left: OffsetRange | null, right: OffsetRange): boolean {
  return left?.start === right.start && left.end === right.end;
}

function diagnosticsAtOffset(
  text: string,
  offset: number,
  diagnostics: readonly lsp.Diagnostic[],
): readonly lsp.Diagnostic[] {
  return diagnostics.filter((diagnostic) => diagnosticContainsOffset(text, diagnostic, offset));
}

function diagnosticContainsOffset(
  text: string,
  diagnostic: lsp.Diagnostic,
  offset: number,
): boolean {
  const start = lspPositionToOffset(text, diagnostic.range.start);
  const end = lspPositionToOffset(text, diagnostic.range.end);
  if (end > start) return offset >= start && offset <= end;
  return offset === start;
}

function preferredDefinitionTarget(
  activeUri: lsp.DocumentUri,
  result: lsp.Location[] | lsp.Location | lsp.LocationLink[] | null,
): TypeScriptLspDefinitionTarget | null {
  return preferredTarget(activeUri, definitionTargets(result));
}

function preferredJumpableDefinitionTarget(
  active: ActiveDocument,
  sourceRange: OffsetRange,
  result: lsp.Location[] | lsp.Location | lsp.LocationLink[] | null,
): TypeScriptLspDefinitionTarget | null {
  const targets = definitionTargets(result).filter(
    (target) => !targetIsSourceRange(active, sourceRange, target),
  );
  return preferredTarget(active.uri, targets);
}

function preferredTarget(
  activeUri: lsp.DocumentUri,
  targets: readonly TypeScriptLspDefinitionTarget[],
): TypeScriptLspDefinitionTarget | null {
  return (
    targets.find((target) => target.uri === activeUri) ??
    targets.find((target) => !target.path.includes("/node_modules/")) ??
    targets[0] ??
    null
  );
}

function targetIsSourceRange(
  active: ActiveDocument,
  sourceRange: OffsetRange,
  target: TypeScriptLspDefinitionTarget,
): boolean {
  if (target.uri !== active.uri) return false;

  const targetStart = lspPositionToOffset(active.text, target.range.start);
  const targetEnd = lspPositionToOffset(active.text, target.range.end);
  return rangesOverlap(sourceRange, { start: targetStart, end: targetEnd });
}

function rangesOverlap(left: OffsetRange, right: OffsetRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function definitionTargets(
  result: lsp.Location[] | lsp.Location | lsp.LocationLink[] | null,
): readonly TypeScriptLspDefinitionTarget[] {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  return items.flatMap(definitionTarget);
}

function definitionTarget(
  item: lsp.Location | lsp.LocationLink,
): readonly TypeScriptLspDefinitionTarget[] {
  const uri = "targetUri" in item ? item.targetUri : item.uri;
  const range = "targetSelectionRange" in item ? item.targetSelectionRange : item.range;
  const fileName = documentUriToFileName(uri);
  if (!fileName) return [];

  return [
    {
      uri,
      path: fileName.replace(/^\/+/, ""),
      range,
    },
  ];
}

function severityForDiagnostic(diagnostic: lsp.Diagnostic): string {
  if (diagnostic.severity === 2) return "warning";
  if (diagnostic.severity === 3) return "info";
  if (diagnostic.severity === 4) return "hint";
  return "error";
}

function diagnosticColor(diagnostic: lsp.Diagnostic): string {
  if (diagnostic.severity === 2) return "#fbbf24";
  if (diagnostic.severity === 3) return "#60a5fa";
  if (diagnostic.severity === 4) return "#a1a1aa";
  return "#f87171";
}

function isNavigationModifier(event: { readonly metaKey: boolean; readonly ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey;
}

function targetInsideElement(element: Element, target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  return element.contains(target);
}

function unionRects(left: DOMRect, right: DOMRect): DOMRect {
  const x = Math.min(left.left, right.left);
  const y = Math.min(left.top, right.top);
  const rightEdge = Math.max(left.right, right.right);
  const bottomEdge = Math.max(left.bottom, right.bottom);
  return new DOMRect(x, y, Math.max(0, rightEdge - x), Math.max(0, bottomEdge - y));
}

function expandRect(rect: DOMRect, amount: number): DOMRect {
  return new DOMRect(
    rect.left - amount,
    rect.top - amount,
    rect.width + amount * 2,
    rect.height + amount * 2,
  );
}

function rectContainsPoint(rect: DOMRect, clientX: number, clientY: number): boolean {
  if (clientX < rect.left) return false;
  if (clientX > rect.right) return false;
  if (clientY < rect.top) return false;
  return clientY <= rect.bottom;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!isRecord(error)) return false;
  return error.name === "LspRequestCancelledError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
