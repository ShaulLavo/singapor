import type {
  DocumentSessionChange,
  EditorPlugin,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from "@editor/core";
import { resolveMinimapOptions } from "./options";
import type { EditorMinimapOptions, ResolvedMinimapOptions } from "./types";
import { canUseMinimapWorker, MinimapWorkerClient, type MinimapHost } from "./workerClient";

export function createMinimapPlugin(options: EditorMinimapOptions = {}): EditorPlugin {
  const resolved = resolveMinimapOptions(options);

  return {
    name: "minimap",
    activate(context) {
      return context.registerViewContribution({
        createContribution: (contributionContext) =>
          createMinimapContribution(contributionContext, resolved),
      });
    },
  };
}

function createMinimapContribution(
  context: EditorViewContributionContext,
  options: ResolvedMinimapOptions,
): EditorViewContribution | null {
  if (!options.enabled) return null;
  if (!canUseMinimapWorker()) return null;

  return new MinimapContribution(context, options);
}

class MinimapContribution implements EditorViewContribution {
  private readonly context: EditorViewContributionContext;
  private readonly options: ResolvedMinimapOptions;
  private readonly host: MinimapHost;
  private readonly client: MinimapWorkerClient;
  private latestSnapshot: EditorViewSnapshot;
  private activeSliderDrag: SliderDrag | null = null;
  private reservedWidth = 0;
  private verticalScrollbarWidth = -1;
  private horizontalScrollbarHeight = -1;
  private disposed = false;

  public constructor(context: EditorViewContributionContext, options: ResolvedMinimapOptions) {
    this.context = context;
    this.options = options;
    this.latestSnapshot = context.getSnapshot();
    this.host = createHost(context, options);
    this.updateNativeScrollbarGutter();
    this.client = new MinimapWorkerClient({
      host: this.host,
      options,
      snapshot: this.latestSnapshot,
      onLayoutWidth: this.reserveWidth,
    });
    this.installPointerHandlers();
    this.client.update(this.latestSnapshot, "document");
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void {
    if (this.disposed) return;

    this.latestSnapshot = snapshot;
    this.updateNativeScrollbarGutter();
    this.client.update(snapshot, kind, change);
  }

  public dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.stopSliderDrag();
    this.client.dispose();
    this.context.reserveOverlayWidth(this.options.side, 0);
    this.host.root.remove();
  }

  private installPointerHandlers(): void {
    this.host.root.addEventListener("pointerdown", this.handlePointerDown);
    this.host.slider.addEventListener("pointerdown", this.handleSliderPointerDown);
  }

  private readonly reserveWidth = (width: number): void => {
    const nextWidth = Math.ceil(width);
    if (nextWidth === this.reservedWidth) return;

    this.reservedWidth = nextWidth;
    this.updateNativeScrollbarGutter();
    this.context.reserveOverlayWidth(this.options.side, nextWidth);
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    if (event.target === this.host.slider || this.host.slider.contains(event.target as Node))
      return;

    event.preventDefault();
    const row = this.rowFromPointer(event);
    this.context.revealLine(row);
  };

  private readonly handleSliderPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;

    event.preventDefault();
    this.stopSliderDrag();
    const startY = event.clientY;
    const startScrollTop = this.latestSnapshot.viewport.scrollTop;
    const sliderHeight = Math.max(1, this.host.slider.getBoundingClientRect().height);
    const scrollable = Math.max(
      1,
      this.latestSnapshot.viewport.scrollHeight - this.latestSnapshot.viewport.clientHeight,
    );
    const trackHeight = Math.max(1, this.host.root.clientHeight - sliderHeight);
    const ratio = scrollable / trackHeight;

    const onMove = (move: PointerEvent): void => {
      const scrollTop = clamp(startScrollTop + (move.clientY - startY) * ratio, 0, scrollable);
      this.client.previewScrollTop(this.latestSnapshot, scrollTop);
      this.context.setScrollTop(scrollTop);
    };
    const onEnd = (): void => this.stopSliderDrag();

    this.captureSliderPointer(event.pointerId);
    this.host.slider.classList.add("active");
    this.activeSliderDrag = { pointerId: event.pointerId, onMove, onEnd };
    this.host.slider.ownerDocument.addEventListener("pointermove", onMove);
    this.host.slider.ownerDocument.addEventListener("pointerup", onEnd, { once: true });
    this.host.slider.ownerDocument.addEventListener("pointercancel", onEnd, { once: true });
    this.host.slider.addEventListener("lostpointercapture", onEnd, { once: true });
  };

  private captureSliderPointer(pointerId: number): void {
    try {
      this.host.slider.setPointerCapture(pointerId);
    } catch {
      return;
    }
  }

  private stopSliderDrag(): void {
    const drag = this.activeSliderDrag;
    if (!drag) return;

    this.activeSliderDrag = null;
    this.host.slider.ownerDocument.removeEventListener("pointermove", drag.onMove);
    this.host.slider.ownerDocument.removeEventListener("pointerup", drag.onEnd);
    this.host.slider.ownerDocument.removeEventListener("pointercancel", drag.onEnd);
    this.host.slider.removeEventListener("lostpointercapture", drag.onEnd);
    this.releaseSliderPointer(drag.pointerId);
    this.host.slider.classList.remove("active");
  }

  private releaseSliderPointer(pointerId: number): void {
    if (!this.host.slider.hasPointerCapture(pointerId)) return;

    try {
      this.host.slider.releasePointerCapture(pointerId);
    } catch {
      return;
    }
  }

  private rowFromPointer(event: PointerEvent): number {
    const rect = this.host.root.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
    return Math.floor(ratio * Math.max(1, this.latestSnapshot.lineCount));
  }

  private updateNativeScrollbarGutter(): void {
    const gutter = nativeScrollbarGutter(this.context.scrollElement);
    if (
      gutter.vertical === this.verticalScrollbarWidth &&
      gutter.horizontal === this.horizontalScrollbarHeight
    ) {
      return;
    }

    this.verticalScrollbarWidth = gutter.vertical;
    this.horizontalScrollbarHeight = gutter.horizontal;
    this.host.root.style.bottom = `${gutter.horizontal}px`;
    if (this.options.side === "right") {
      this.host.root.style.right = `${gutter.vertical}px`;
      this.host.root.style.left = "";
      return;
    }

    this.host.root.style.left = "0";
    this.host.root.style.right = "";
  }
}

type SliderDrag = {
  readonly pointerId: number;
  readonly onMove: (event: PointerEvent) => void;
  readonly onEnd: () => void;
};

function createHost(
  context: EditorViewContributionContext,
  options: ResolvedMinimapOptions,
): MinimapHost {
  const document = context.container.ownerDocument;
  const root = document.createElement("div");
  const shadow = document.createElement("div");
  const mainCanvas = document.createElement("canvas");
  const decorationsCanvas = document.createElement("canvas");
  const slider = document.createElement("div");
  const sliderHorizontal = document.createElement("div");

  root.className = hostClassName(options);
  shadow.className = "editor-minimap-shadow editor-minimap-shadow-hidden";
  mainCanvas.className = "editor-minimap-canvas";
  decorationsCanvas.className = "editor-minimap-canvas editor-minimap-decorations";
  slider.className = "editor-minimap-slider";
  sliderHorizontal.className = "editor-minimap-slider-horizontal";
  slider.appendChild(sliderHorizontal);
  root.append(shadow, mainCanvas, decorationsCanvas, slider);
  if (getComputedStyle(context.container).position === "static") {
    context.container.style.position = "relative";
  }
  context.container.appendChild(root);

  return {
    root,
    colorScope: context.scrollElement,
    shadow,
    mainCanvas,
    decorationsCanvas,
    slider,
    sliderHorizontal,
  };
}

function hostClassName(options: ResolvedMinimapOptions): string {
  const classes = ["editor-minimap", `editor-minimap-${options.side}`];
  if (options.showSlider === "always") classes.push("slider-always");
  if (options.showSlider === "mouseover") classes.push("slider-mouseover");
  if (options.autohide !== "none") classes.push(`editor-minimap-autohide-${options.autohide}`);
  return classes.join(" ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nativeScrollbarGutter(element: HTMLElement): {
  readonly vertical: number;
  readonly horizontal: number;
} {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const borderX = cssPixels(style?.borderLeftWidth) + cssPixels(style?.borderRightWidth);
  const borderY = cssPixels(style?.borderTopWidth) + cssPixels(style?.borderBottomWidth);
  const vertical =
    element.scrollHeight > element.clientHeight
      ? Math.max(0, element.offsetWidth - element.clientWidth - borderX)
      : 0;
  const horizontal =
    element.scrollWidth > element.clientWidth
      ? Math.max(0, element.offsetHeight - element.clientHeight - borderY)
      : 0;

  return { vertical, horizontal };
}

function cssPixels(value: string | undefined): number {
  if (!value) return 0;

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}
