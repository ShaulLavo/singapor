import { parseCssColor, relativeLuminance, rgbaToCss, transparent } from "./color";
import {
  computeFrameLayout,
  computeRenderLayout,
  type MinimapFrameLayout,
  MINIMAP_GUTTER_WIDTH,
  yForLineNumber,
} from "./layout";
import { MinimapCharRendererFactory } from "./minimapCharRendererFactory";
import { Constants } from "./minimapCharSheet";
import type {
  EditorMinimapDecoration,
  MinimapBaseStyles,
  MinimapDocumentPayload,
  MinimapMetrics,
  MinimapRenderLayout,
  MinimapSelection,
  MinimapToken,
  MinimapViewport,
  ResolvedMinimapOptions,
  RGBA8,
} from "./types";
import { RenderMinimap } from "./types";

type RendererState = {
  readonly mainCanvas: OffscreenCanvas;
  readonly decorationsCanvas: OffscreenCanvas;
  readonly mainContext: OffscreenCanvasRenderingContext2D;
  readonly decorationsContext: OffscreenCanvasRenderingContext2D;
  options: ResolvedMinimapOptions;
  styles: MinimapBaseStyles;
  document: MinimapDocumentPayload;
  metrics: MinimapMetrics;
  viewport: MinimapViewport;
  layout: MinimapRenderLayout | null;
  previousFrame: MinimapFrameLayout | null;
  linesDirty: boolean;
  decorationsDirty: boolean;
};

const EMPTY_DOCUMENT: MinimapDocumentPayload = {
  text: "",
  lineStarts: [0],
  tokens: [],
  selections: [],
  decorations: [],
};

export class MinimapWorkerRenderer {
  private state: RendererState | null = null;

  public init(options: {
    readonly mainCanvas: OffscreenCanvas;
    readonly decorationsCanvas: OffscreenCanvas;
    readonly options: ResolvedMinimapOptions;
    readonly styles: MinimapBaseStyles;
  }): void {
    const mainContext = options.mainCanvas.getContext("2d");
    const decorationsContext = options.decorationsCanvas.getContext("2d");
    if (!mainContext || !decorationsContext)
      throw new Error("Unable to create minimap canvas context");

    this.state = {
      mainCanvas: options.mainCanvas,
      decorationsCanvas: options.decorationsCanvas,
      mainContext,
      decorationsContext,
      options: options.options,
      styles: options.styles,
      document: EMPTY_DOCUMENT,
      metrics: defaultMetrics(),
      viewport: defaultViewport(),
      layout: null,
      previousFrame: null,
      linesDirty: true,
      decorationsDirty: true,
    };
  }

  public setDocument(document: MinimapDocumentPayload): void {
    if (!this.state) return;
    this.state.document = document;
    this.state.previousFrame = null;
    this.state.linesDirty = true;
    this.state.decorationsDirty = true;
  }

  public setBaseStyles(styles: MinimapBaseStyles): void {
    if (!this.state) return;
    this.state.styles = styles;
    this.state.linesDirty = true;
    this.state.decorationsDirty = true;
  }

  public setTokens(tokens: readonly MinimapToken[]): void {
    if (!this.state) return;
    this.state.document = { ...this.state.document, tokens };
    this.state.linesDirty = true;
  }

  public setSelections(selections: readonly MinimapSelection[]): void {
    if (!this.state) return;
    this.state.document = { ...this.state.document, selections };
    this.state.decorationsDirty = true;
  }

  public setDecorations(decorations: readonly EditorMinimapDecoration[]): void {
    if (!this.state) return;
    this.state.document = { ...this.state.document, decorations };
    this.state.decorationsDirty = true;
  }

  public updateLayout(
    metrics: MinimapMetrics,
    viewport: MinimapViewport,
  ): MinimapRenderLayout | null {
    if (!this.state) return null;
    this.state.metrics = metrics;
    this.state.viewport = viewport;
    const nextLayout = this.createRenderLayout();
    const layoutChanged = !this.state.layout || !renderLayoutsEqual(this.state.layout, nextLayout);
    this.state.layout = nextLayout;
    if (layoutChanged) {
      this.state.linesDirty = true;
      this.state.decorationsDirty = true;
      this.state.previousFrame = null;
    }
    this.resizeCanvases(this.state.layout);
    return this.state.layout;
  }

  public updateViewport(viewport: MinimapViewport): void {
    if (!this.state) return;
    this.state.viewport = viewport;
  }

  public render(): RenderResult | null {
    if (!this.state) return null;

    const layout = this.state.layout ?? this.createRenderLayout();
    this.state.layout = layout;
    this.resizeCanvases(layout);
    if (layout.renderMinimap === RenderMinimap.None) return emptyRenderResult();

    const frame = computeFrameLayout({
      renderLayout: layout,
      viewport: this.state.viewport,
      lineCount: this.minimapLineCount(layout),
      realLineCount: this.state.document.lineStarts.length,
      previous: this.state.previousFrame,
    });
    const frameChanged =
      !this.state.previousFrame || !framesPaintSameWindow(this.state.previousFrame, frame);

    if (this.state.linesDirty || frameChanged) this.renderLines(layout, frame);
    if (this.state.decorationsDirty || frameChanged) this.renderDecorations(layout, frame);
    this.state.previousFrame = frame;
    this.state.linesDirty = false;
    this.state.decorationsDirty = false;
    return {
      sliderNeeded: frame.sliderNeeded,
      sliderTop: frame.sliderTop,
      sliderHeight: frame.sliderHeight,
      shadowVisible:
        this.state.viewport.scrollLeft + this.state.viewport.clientWidth <
        this.state.viewport.scrollWidth,
    };
  }

  public dispose(): void {
    this.state = null;
  }

  private createRenderLayout(): MinimapRenderLayout {
    const state = this.requireState();
    return computeRenderLayout({
      minimap: state.options,
      metrics: state.metrics,
      viewport: state.viewport,
      lineCount: state.document.lineStarts.length,
      contentWidth: Math.max(state.viewport.scrollWidth, state.viewport.clientWidth),
    });
  }

  private renderLines(layout: MinimapRenderLayout, frame: FrameLike): void {
    const state = this.requireState();
    const imageData = createBackgroundImageData(
      state.mainContext,
      layout.canvasInnerWidth,
      layout.canvasInnerHeight,
      state.styles.minimapBackground,
    );
    const charRenderer = MinimapCharRendererFactory.create(layout.scale, state.styles.fontFamily);
    const useLighterFont = relativeLuminance(state.styles.background) >= 0.5;
    const renderBackground = state.styles.background;
    let tokenCursor = 0;

    for (let line = frame.startLineNumber; line <= frame.endLineNumber; line += 1) {
      const text = this.lineText(line);
      const lineStart = this.lineStartOffset(line);
      const lineEnd = lineStart + text.length;
      const lineTokens = tokensForLineFromCursor(
        state.document.tokens,
        lineStart,
        lineEnd,
        tokenCursor,
      );
      tokenCursor = lineTokens.cursor;
      this.renderLine({
        imageData,
        layout,
        frame,
        line,
        text,
        lineStart,
        tokens: lineTokens.tokens,
        charRenderer,
        useLighterFont,
        renderBackground,
      });
    }

    state.mainContext.putImageData(imageData, 0, 0);
  }

  private renderLine(options: RenderLineOptions): void {
    const state = this.requireState();
    const y = yForLineNumber(options.frame, options.line, options.layout.lineHeight);
    let dx = MINIMAP_GUTTER_WIDTH;

    for (const segment of tokenSegments(
      options.text,
      options.lineStart,
      options.tokens,
      state.styles.foreground,
    )) {
      dx = renderSegment({ ...options, text: segment.text, color: segment.color, dx, y });
      if (dx > options.imageData.width - options.layout.charWidth) return;
    }
  }

  private renderDecorations(layout: MinimapRenderLayout, frame: FrameLike): void {
    const state = this.requireState();
    state.decorationsContext.clearRect(0, 0, layout.canvasInnerWidth, layout.canvasInnerHeight);
    this.renderSelectionHighlights(layout, frame);
    this.renderMinimapDecorations(layout, frame);
    this.renderSectionHeaders(layout, frame);
  }

  private renderSelectionHighlights(layout: MinimapRenderLayout, frame: FrameLike): void {
    const state = this.requireState();
    const color = transparent(state.styles.selection, 0.5);
    state.decorationsContext.fillStyle = rgbaToCss(color);

    for (const selection of state.document.selections) {
      const range = this.offsetRangeToLineRange(selection.startOffset, selection.endOffset);
      fillLineRange(state.decorationsContext, layout, frame, range.start, range.end);
    }
  }

  private renderMinimapDecorations(layout: MinimapRenderLayout, frame: FrameLike): void {
    const state = this.requireState();
    const decorations = state.document.decorations
      .filter((decoration) => !decoration.sectionHeaderStyle)
      .toSorted((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0));

    for (const decoration of decorations) {
      const color = parseCssColor(decoration.color, state.styles.selection);
      state.decorationsContext.fillStyle = rgbaToCss(transparent(color, 0.5));
      fillLineRange(
        state.decorationsContext,
        layout,
        frame,
        decoration.startLineNumber,
        decoration.endLineNumber,
      );
    }
  }

  private renderSectionHeaders(layout: MinimapRenderLayout, frame: FrameLike): void {
    const state = this.requireState();
    const context = state.decorationsContext;
    const fontSize = state.options.sectionHeaderFontSize * state.metrics.devicePixelRatio;
    context.font = `500 ${fontSize}px ${state.styles.fontFamily}`;
    context.fillStyle = rgbaToCss(transparent(state.styles.minimapBackground, 0.7));
    context.strokeStyle = rgbaToCss(state.styles.foreground);
    context.lineWidth = 0.4;

    for (const decoration of state.document.decorations) {
      if (!decoration.sectionHeaderStyle) continue;
      renderSectionHeader(context, decoration, layout, frame, fontSize, state.styles.foreground);
    }
  }

  private minimapLineCount(layout: MinimapRenderLayout): number {
    const state = this.requireState();
    if (!layout.isSampling) return state.document.lineStarts.length;
    return Math.max(1, Math.min(state.document.lineStarts.length, layout.canvasInnerHeight));
  }

  private lineText(lineNumber: number): string {
    const state = this.requireState();
    const start = this.lineStartOffset(lineNumber);
    const next = state.document.lineStarts[lineNumber];
    const end = next === undefined ? state.document.text.length : Math.max(start, next - 1);
    return state.document.text.slice(start, end);
  }

  private lineStartOffset(lineNumber: number): number {
    const state = this.requireState();
    return state.document.lineStarts[lineNumber - 1] ?? state.document.text.length;
  }

  private offsetRangeToLineRange(startOffset: number, endOffset: number): LineRange {
    return {
      start: this.lineNumberForOffset(startOffset),
      end: this.lineNumberForOffset(endOffset),
    };
  }

  private lineNumberForOffset(offset: number): number {
    const state = this.requireState();
    let low = 0;
    let high = state.document.lineStarts.length - 1;
    const clamped = Math.max(0, Math.min(offset, state.document.text.length));

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const start = state.document.lineStarts[middle] ?? 0;
      const next = state.document.lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;
      if (clamped < start) high = middle - 1;
      else if (clamped >= next) low = middle + 1;
      else return middle + 1;
    }

    return state.document.lineStarts.length;
  }

  private resizeCanvases(layout: MinimapRenderLayout): void {
    const state = this.requireState();
    resizeCanvas(state.mainCanvas, layout.canvasInnerWidth, layout.canvasInnerHeight);
    resizeCanvas(state.decorationsCanvas, layout.canvasInnerWidth, layout.canvasInnerHeight);
  }

  private requireState(): RendererState {
    if (!this.state) throw new Error("Minimap renderer is not initialized");
    return this.state;
  }
}

type RenderResult = {
  readonly sliderNeeded: boolean;
  readonly sliderTop: number;
  readonly sliderHeight: number;
  readonly shadowVisible: boolean;
};

type FrameLike = {
  readonly startLineNumber: number;
  readonly endLineNumber: number;
  readonly topPaddingLineCount: number;
};

type LineRange = {
  readonly start: number;
  readonly end: number;
};

type RenderLineOptions = {
  readonly imageData: ImageData;
  readonly layout: MinimapRenderLayout;
  readonly frame: FrameLike;
  readonly line: number;
  readonly text: string;
  readonly lineStart: number;
  readonly tokens: readonly MinimapToken[];
  readonly charRenderer: ReturnType<typeof MinimapCharRendererFactory.create>;
  readonly useLighterFont: boolean;
  readonly renderBackground: RGBA8;
};

type Segment = {
  readonly text: string;
  readonly color: RGBA8;
};

function renderSegment(
  options: RenderLineOptions & {
    readonly text: string;
    readonly color: RGBA8;
    dx: number;
    y: number;
  },
): number {
  let dx = options.dx;
  for (let index = 0; index < options.text.length; index += 1) {
    dx = renderCharacter(options, dx, options.text.charCodeAt(index));
  }
  return dx;
}

function renderCharacter(
  options: RenderLineOptions & { readonly color: RGBA8; y: number },
  dx: number,
  code: number,
): number {
  if (code === 9) return dx + 4 * options.layout.charWidth;
  if (code === 32) return dx + options.layout.charWidth;

  if (options.layout.renderMinimap === RenderMinimap.Blocks) {
    options.charRenderer.blockRenderChar(
      options.imageData,
      dx,
      options.y,
      options.color,
      255,
      options.renderBackground,
      255,
      options.layout.lineHeight === 1,
    );
    return dx + options.layout.charWidth;
  }

  options.charRenderer.renderChar(
    options.imageData,
    dx,
    options.y,
    code,
    options.color,
    255,
    options.renderBackground,
    255,
    options.layout.scale,
    options.useLighterFont,
    options.layout.lineHeight === 1,
  );
  return dx + options.layout.charWidth;
}

function tokenSegments(
  text: string,
  lineStart: number,
  tokens: readonly MinimapToken[],
  fallback: RGBA8,
): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const start = Math.max(0, token.start - lineStart);
    const end = Math.min(text.length, token.end - lineStart);
    if (start > cursor) segments.push({ text: text.slice(cursor, start), color: fallback });
    if (end > start) segments.push({ text: text.slice(start, end), color: token.color });
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), color: fallback });
  return segments;
}

function tokensForLineFromCursor(
  tokens: readonly MinimapToken[],
  lineStart: number,
  lineEnd: number,
  cursor: number,
): { readonly tokens: readonly MinimapToken[]; readonly cursor: number } {
  let index = cursor;
  while (index < tokens.length && tokens[index]!.end <= lineStart) index += 1;

  const start = index;
  while (index < tokens.length && tokens[index]!.start < lineEnd) index += 1;

  return { tokens: tokens.slice(start, index), cursor: start };
}

function createBackgroundImageData(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  background: RGBA8,
): ImageData {
  const imageData = context.createImageData(Math.max(1, width), Math.max(1, height));
  for (let index = 0; index < imageData.data.length; index += Constants.RGBA_CHANNELS_CNT) {
    imageData.data[index] = background.r;
    imageData.data[index + 1] = background.g;
    imageData.data[index + 2] = background.b;
    imageData.data[index + 3] = background.a;
  }
  return imageData;
}

function fillLineRange(
  context: OffscreenCanvasRenderingContext2D,
  layout: MinimapRenderLayout,
  frame: FrameLike,
  startLineNumber: number,
  endLineNumber: number,
): void {
  const start = Math.max(frame.startLineNumber, startLineNumber);
  const end = Math.min(frame.endLineNumber, endLineNumber);
  if (start > end) return;

  const y = yForLineNumber(frame, start, layout.lineHeight);
  const height = Math.max(
    layout.lineHeight,
    yForLineNumber(frame, end, layout.lineHeight) - y + layout.lineHeight,
  );
  context.fillRect(MINIMAP_GUTTER_WIDTH, y, layout.canvasInnerWidth, height);
}

function renderSectionHeader(
  context: OffscreenCanvasRenderingContext2D,
  decoration: EditorMinimapDecoration,
  layout: MinimapRenderLayout,
  frame: FrameLike,
  fontSize: number,
  color: RGBA8,
): void {
  if (
    decoration.startLineNumber < frame.startLineNumber ||
    decoration.startLineNumber > frame.endLineNumber
  ) {
    return;
  }

  const y = yForLineNumber(frame, decoration.startLineNumber, layout.lineHeight) + fontSize;
  context.fillRect(0, y - fontSize, layout.canvasInnerWidth, fontSize * 1.5);
  context.fillStyle = rgbaToCss(color);
  if (decoration.sectionHeaderText) {
    context.fillText(
      decoration.sectionHeaderText,
      MINIMAP_GUTTER_WIDTH,
      y,
      layout.canvasInnerWidth,
    );
  }
  if (decoration.sectionHeaderStyle === "underlined") {
    context.beginPath();
    context.moveTo(0, y - fontSize + 2);
    context.lineTo(layout.canvasInnerWidth, y - fontSize + 2);
    context.stroke();
  }
}

function resizeCanvas(canvas: OffscreenCanvas, width: number, height: number): void {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  if (canvas.width !== safeWidth) canvas.width = safeWidth;
  if (canvas.height !== safeHeight) canvas.height = safeHeight;
}

function renderLayoutsEqual(left: MinimapRenderLayout, right: MinimapRenderLayout): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.canvasInnerWidth === right.canvasInnerWidth &&
    left.canvasInnerHeight === right.canvasInnerHeight &&
    left.lineHeight === right.lineHeight &&
    left.charWidth === right.charWidth &&
    left.scale === right.scale &&
    left.isSampling === right.isSampling &&
    left.heightIsEditorHeight === right.heightIsEditorHeight &&
    left.renderMinimap === right.renderMinimap
  );
}

function framesPaintSameWindow(left: MinimapFrameLayout, right: MinimapFrameLayout): boolean {
  return (
    left.startLineNumber === right.startLineNumber &&
    left.endLineNumber === right.endLineNumber &&
    left.topPaddingLineCount === right.topPaddingLineCount
  );
}

function defaultMetrics(): MinimapMetrics {
  return { rowHeight: 20, characterWidth: 8, devicePixelRatio: 1 };
}

function defaultViewport(): MinimapViewport {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    clientHeight: 0,
    clientWidth: 0,
    visibleStart: 0,
    visibleEnd: 1,
  };
}

function emptyRenderResult(): RenderResult {
  return { sliderNeeded: false, sliderTop: 0, sliderHeight: 0, shadowVisible: false };
}
