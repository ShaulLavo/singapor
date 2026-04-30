import type {
  DocumentSessionChange,
  EditorToken,
  EditorViewSnapshot,
  TextEdit,
} from "@editor/core";
import { parseCssColor, RGBA_BLACK, RGBA_WHITE } from "./color";
import { findSectionHeaderDecorations } from "./sectionHeaders";
import type {
  MinimapBaseStyles,
  MinimapDocumentPayload,
  MinimapMetrics,
  MinimapSelection,
  MinimapToken,
  MinimapViewport,
  MinimapWorkerRequest,
  MinimapWorkerResponse,
  ResolvedMinimapOptions,
  RGBA8,
} from "./types";

export type MinimapHost = {
  readonly root: HTMLDivElement;
  readonly colorScope: HTMLElement;
  readonly mainCanvas: HTMLCanvasElement;
  readonly decorationsCanvas: HTMLCanvasElement;
  readonly slider: HTMLDivElement;
  readonly sliderHorizontal: HTMLDivElement;
  readonly shadow: HTMLDivElement;
};

export type MinimapWorkerClientOptions = {
  readonly host: MinimapHost;
  readonly options: ResolvedMinimapOptions;
  readonly snapshot: EditorViewSnapshot;
  readonly onLayoutWidth: (width: number) => void;
};

export class MinimapWorkerClient {
  private readonly host: MinimapHost;
  private readonly options: ResolvedMinimapOptions;
  private readonly worker: Worker;
  private readonly colorResolver: ColorResolver;
  private readonly onLayoutWidth: (width: number) => void;
  private sequence = 0;
  private latestRenderedSequence = 0;
  private pendingUpdate: PendingMinimapUpdate | null = null;
  private flushHandle = 0;
  private renderInFlight = false;
  private latestSliderHeight = 0;
  private latestSliderNeeded = false;
  private latestBaseStylesSignature = "";
  private disposed = false;

  public constructor(options: MinimapWorkerClientOptions) {
    this.host = options.host;
    this.options = options.options;
    this.onLayoutWidth = options.onLayoutWidth;
    this.colorResolver = new ColorResolver(options.host.colorScope);
    this.worker = new Worker(new URL("./minimap.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = this.handleWorkerMessage;
    this.worker.onerror = this.handleWorkerError;
    this.init(options.snapshot);
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: string,
    change?: DocumentSessionChange | null,
  ): void {
    if (this.disposed) return;
    this.applyImmediateViewport(snapshot, snapshot.viewport.scrollTop);
    this.pendingUpdate = mergePendingUpdate(this.pendingUpdate, { snapshot, kind, change });
    this.scheduleFlush();
  }

  public previewScrollTop(snapshot: EditorViewSnapshot, scrollTop: number): void {
    if (this.disposed) return;

    this.applyImmediateViewport(snapshot, scrollTop);
  }

  public dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.cancelScheduledFlush();
    this.post({ type: "dispose" });
    this.worker.terminate();
    this.colorResolver.dispose();
  }

  private init(snapshot: EditorViewSnapshot): void {
    const mainCanvas = this.host.mainCanvas.transferControlToOffscreen();
    const decorationsCanvas = this.host.decorationsCanvas.transferControlToOffscreen();
    const baseStyles = this.baseStyles();
    this.latestBaseStylesSignature = baseStylesSignature(baseStyles);
    const request: MinimapWorkerRequest = {
      type: "init",
      options: this.options,
      baseStyles,
      mainCanvas,
      decorationsCanvas,
    };

    this.worker.postMessage(request, [mainCanvas, decorationsCanvas]);
    this.post({ type: "openDocument", document: this.documentPayload(snapshot) });
    this.post({
      type: "updateLayout",
      metrics: this.metrics(snapshot),
      viewport: this.viewport(snapshot),
    });
    this.postRender(snapshot);
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== 0) return;

    this.flushHandle = requestFrame(() => {
      this.flushHandle = 0;
      this.flushPendingUpdate();
    });
  }

  private flushPendingUpdate(): void {
    if (this.disposed) return;
    if (this.renderInFlight) return;

    const pending = this.pendingUpdate;
    if (!pending) return;

    this.pendingUpdate = null;
    this.postUpdate(pending.snapshot, pending.kind, pending.change);
    this.post({
      type: "updateLayout",
      metrics: this.metrics(pending.snapshot),
      viewport: this.viewport(pending.snapshot),
    });
    this.postRender(pending.snapshot);
  }

  private postUpdate(
    snapshot: EditorViewSnapshot,
    kind: string,
    change: DocumentSessionChange | null | undefined,
  ): void {
    if (shouldRefreshColorCache(kind)) this.colorResolver.clear();
    this.syncBaseStyles();

    if (kind === "tokens") {
      this.post({ type: "updateTokens", tokens: this.tokens(snapshot.tokens) });
      return;
    }
    if (kind === "selection") {
      this.post({ type: "updateSelection", selections: selections(snapshot) });
      return;
    }
    if (kind === "viewport" || kind === "layout") {
      this.post({ type: "updateViewport", viewport: this.viewport(snapshot) });
      return;
    }
    if (singleLineEdit(change)) {
      this.post({
        type: "applyEdit",
        edit: change.edits[0]!,
        document: this.documentPayload(snapshot),
      });
      return;
    }

    this.post({ type: "replaceDocument", document: this.documentPayload(snapshot) });
  }

  private syncBaseStyles(): void {
    const styles = this.baseStyles();
    const signature = baseStylesSignature(styles);
    if (signature === this.latestBaseStylesSignature) return;

    this.latestBaseStylesSignature = signature;
    this.colorResolver.clear();
    this.post({ type: "updateBaseStyles", baseStyles: styles });
  }

  private postRender(snapshot: EditorViewSnapshot): void {
    this.sizeCanvasElements(snapshot);
    this.sequence += 1;
    this.renderInFlight = true;
    this.post({ type: "render", sequence: this.sequence });
  }

  private applyImmediateViewport(snapshot: EditorViewSnapshot, scrollTop: number): void {
    const slider = immediateSlider(
      snapshot,
      scrollTop,
      this.latestSliderHeight,
      this.latestSliderNeeded,
    );
    this.host.slider.style.display = slider.needed ? "block" : "none";
    this.host.slider.style.transform = `translate3d(0, ${slider.top}px, 0)`;
    this.host.slider.style.height = `${slider.height}px`;
    this.host.sliderHorizontal.style.height = `${slider.height}px`;
    this.host.shadow.className = shadowVisible(snapshot)
      ? "editor-minimap-shadow editor-minimap-shadow-visible"
      : "editor-minimap-shadow editor-minimap-shadow-hidden";
  }

  private documentPayload(snapshot: EditorViewSnapshot): MinimapDocumentPayload {
    const lines = splitLines(snapshot.text);
    const decorations = findSectionHeaderDecorations(lines, this.options);
    return {
      text: snapshot.text,
      lineStarts: snapshot.lineStarts,
      tokens: this.tokens(snapshot.tokens),
      selections: selections(snapshot),
      decorations,
    };
  }

  private tokens(tokens: readonly EditorToken[]): readonly MinimapToken[] {
    const foreground = this.baseStyles().foreground;
    return tokens.map((token) => ({
      start: token.start,
      end: token.end,
      color: this.colorResolver.resolve(token.style.color, foreground),
    }));
  }

  private metrics(snapshot: EditorViewSnapshot): MinimapMetrics {
    return {
      rowHeight: snapshot.metrics.rowHeight,
      characterWidth: snapshot.metrics.characterWidth,
      devicePixelRatio: globalThis.devicePixelRatio || 1,
    };
  }

  private viewport(snapshot: EditorViewSnapshot): MinimapViewport {
    return {
      scrollTop: snapshot.viewport.scrollTop,
      scrollLeft: snapshot.viewport.scrollLeft,
      scrollHeight: snapshot.viewport.scrollHeight,
      scrollWidth: snapshot.viewport.scrollWidth,
      clientHeight: snapshot.viewport.clientHeight,
      clientWidth: snapshot.viewport.clientWidth,
      visibleStart: snapshot.viewport.visibleRange.start,
      visibleEnd: snapshot.viewport.visibleRange.end,
    };
  }

  private baseStyles(): MinimapBaseStyles {
    const style = getComputedStyle(this.host.colorScope);
    const foreground = this.colorResolver.resolve(style.color, RGBA_WHITE);
    const background = this.colorResolver.resolve(style.backgroundColor, RGBA_BLACK);

    return {
      foreground,
      background,
      minimapBackground: this.colorResolver.resolve(
        style.getPropertyValue("--editor-minimap-background"),
        background,
      ),
      foregroundOpacity: 255,
      selection: this.colorResolver.resolve(
        style.getPropertyValue("--editor-minimap-selection-highlight"),
        { r: 56, g: 189, b: 248, a: 128 },
      ),
      slider:
        style.getPropertyValue("--editor-minimap-slider-background") || "rgba(121,121,121,.2)",
      sliderHover:
        style.getPropertyValue("--editor-minimap-slider-hover-background") ||
        "rgba(121,121,121,.35)",
      sliderActive:
        style.getPropertyValue("--editor-minimap-slider-active-background") ||
        "rgba(121,121,121,.5)",
      fontFamily: style.fontFamily || "monospace",
    };
  }

  private sizeCanvasElements(snapshot: EditorViewSnapshot): void {
    const height = `${Math.max(0, snapshot.viewport.clientHeight)}px`;
    this.host.root.style.height = height;
    this.host.mainCanvas.style.height = height;
    this.host.decorationsCanvas.style.height = height;
  }

  private handleWorkerMessage = (event: MessageEvent<MinimapWorkerResponse>): void => {
    const response = event.data;
    if (response.type === "layout") {
      this.applyLayout(
        response.layout.width,
        response.layout.canvasOuterWidth,
        response.layout.canvasOuterHeight,
      );
      return;
    }
    if (response.type === "rendered") {
      this.applyRenderedResponse(response);
      this.renderInFlight = false;
      if (this.pendingUpdate) this.scheduleFlush();
      return;
    }
    if (response.type === "error") console.warn(response.message);
  };

  private applyLayout(width: number, canvasWidth: number, canvasHeight: number): void {
    this.onLayoutWidth(width);
    this.host.root.style.width = `${width}px`;
    this.host.mainCanvas.style.width = `${canvasWidth}px`;
    this.host.decorationsCanvas.style.width = `${canvasWidth}px`;
    this.host.mainCanvas.style.height = `${canvasHeight}px`;
    this.host.decorationsCanvas.style.height = `${canvasHeight}px`;
  }

  private applyRenderedResponse(
    response: Extract<MinimapWorkerResponse, { type: "rendered" }>,
  ): void {
    if (response.sequence < this.latestRenderedSequence) return;

    this.latestRenderedSequence = response.sequence;
    this.latestSliderHeight = response.sliderHeight;
    this.latestSliderNeeded = response.sliderNeeded;
    this.host.slider.style.display = response.sliderNeeded ? "block" : "none";
    this.host.slider.style.transform = `translate3d(0, ${response.sliderTop}px, 0)`;
    this.host.slider.style.height = `${response.sliderHeight}px`;
    this.host.sliderHorizontal.style.height = `${response.sliderHeight}px`;
    this.host.shadow.className = response.shadowVisible
      ? "editor-minimap-shadow editor-minimap-shadow-visible"
      : "editor-minimap-shadow editor-minimap-shadow-hidden";
  }

  private handleWorkerError = (event: ErrorEvent): void => {
    console.warn(event.message || "Minimap worker failed");
  };

  private post(request: MinimapWorkerRequest): void {
    this.worker.postMessage(request);
  }

  private cancelScheduledFlush(): void {
    if (this.flushHandle === 0) return;

    cancelFrame(this.flushHandle);
    this.flushHandle = 0;
  }
}

type PendingMinimapUpdate = {
  readonly snapshot: EditorViewSnapshot;
  readonly kind: string;
  readonly change?: DocumentSessionChange | null;
};

export function canUseMinimapWorker(): boolean {
  if (typeof Worker === "undefined") return false;
  if (typeof OffscreenCanvas === "undefined") return false;
  return (
    typeof HTMLCanvasElement !== "undefined" &&
    "transferControlToOffscreen" in HTMLCanvasElement.prototype
  );
}

function selections(snapshot: EditorViewSnapshot): readonly MinimapSelection[] {
  return snapshot.selections.map((selection) => ({
    startOffset: selection.startOffset,
    endOffset: selection.endOffset,
  }));
}

function singleLineEdit(
  change: DocumentSessionChange | null | undefined,
): change is DocumentSessionChange & {
  readonly edits: readonly [TextEdit];
} {
  if (!change || change.kind !== "edit" || change.edits.length !== 1) return false;
  const edit = change.edits[0]!;
  if (edit.text.includes("\n")) return false;
  return !change.text.slice(edit.from, edit.to).includes("\n");
}

function splitLines(text: string): readonly string[] {
  return text.split("\n");
}

function immediateSlider(
  snapshot: EditorViewSnapshot,
  scrollTop: number,
  sliderHeight: number,
  sliderNeeded: boolean,
): {
  readonly needed: boolean;
  readonly top: number;
  readonly height: number;
} {
  const viewport = snapshot.viewport;
  const scrollable = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const trackHeight = Math.max(1, viewport.clientHeight);
  const height = Math.max(0, sliderHeight);
  const maxTop = Math.max(0, trackHeight - height);
  const top = scrollable > 0 ? (clamp(scrollTop, 0, scrollable) / scrollable) * maxTop : 0;

  return { needed: sliderNeeded && maxTop > 0, top, height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function shadowVisible(snapshot: EditorViewSnapshot): boolean {
  const viewport = snapshot.viewport;
  return viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth;
}

function baseStylesSignature(styles: MinimapBaseStyles): string {
  return JSON.stringify(styles);
}

function mergePendingUpdate(
  current: PendingMinimapUpdate | null,
  next: PendingMinimapUpdate,
): PendingMinimapUpdate {
  if (!current) return next;
  if (canUseLatestKind(current.kind, next.kind)) return next;

  return {
    snapshot: next.snapshot,
    kind: "content",
    change: next.change ?? null,
  };
}

function canUseLatestKind(currentKind: string, nextKind: string): boolean {
  if (currentKind === nextKind) return true;
  if (isViewportOnly(currentKind) && isViewportOnly(nextKind)) return true;
  return false;
}

function isViewportOnly(kind: string): boolean {
  return kind === "viewport" || kind === "layout";
}

function shouldRefreshColorCache(kind: string): boolean {
  if (kind === "tokens") return true;
  if (kind === "document") return true;
  if (kind === "content") return true;
  return kind === "clear";
}

function requestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(callback, 16) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
    return;
  }

  clearTimeout(handle);
}

class ColorResolver {
  private readonly probe: HTMLSpanElement;
  private readonly cache = new Map<string, RGBA8>();

  public constructor(root: HTMLElement) {
    this.probe = root.ownerDocument.createElement("span");
    this.probe.style.position = "absolute";
    this.probe.style.visibility = "hidden";
    this.probe.textContent = ".";
    root.appendChild(this.probe);
  }

  public resolve(value: string | undefined, fallback: RGBA8): RGBA8 {
    if (!value) return fallback;
    const cached = this.cache.get(value);
    if (cached) return cached;

    this.probe.style.color = value;
    const resolved = parseCssColor(getComputedStyle(this.probe).color, fallback);
    this.cache.set(value, resolved);
    return resolved;
  }

  public clear(): void {
    this.cache.clear();
  }

  public dispose(): void {
    this.clear();
    this.probe.remove();
  }
}
