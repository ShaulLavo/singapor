import { getPieceTableText, type PieceTableSnapshot } from "../pieceTable";
import type {
  PosttextLayout,
  PosttextLayoutMetrics,
  PosttextLineLayout,
  PosttextRangeBox,
  PosttextRect,
  PosttextViewport,
  PosttextViewportLine,
  PosttextViewportResult,
  PosttextXY,
} from "./types";

type InlineBoundary = {
  offset: number;
  x: number;
};

type InlineVisibleRange = {
  startOffset: number;
  endOffset: number;
};

const assertPositiveMetric = (name: string, value: number) => {
  if (Number.isFinite(value) && value > 0) return;
  throw new RangeError(`${name} must be a positive finite number`);
};

const normalizeMetrics = (metrics: PosttextLayoutMetrics): PosttextLayoutMetrics => {
  assertPositiveMetric("charWidth", metrics.charWidth);
  assertPositiveMetric("lineHeight", metrics.lineHeight);
  assertPositiveMetric("tabSize", metrics.tabSize);
  return metrics;
};

const tabAdvanceColumns = (visualColumn: number, tabSize: number): number => {
  const remainder = visualColumn % tabSize;
  if (remainder === 0) return tabSize;
  return tabSize - remainder;
};

const characterAdvanceColumns = (
  character: string,
  visualColumn: number,
  tabSize: number,
): number => {
  if (character === "\t") return tabAdvanceColumns(visualColumn, tabSize);
  return 1;
};

const scanLineBoundaries = (
  text: string,
  startOffset: number,
  metrics: PosttextLayoutMetrics,
): InlineBoundary[] => {
  const boundaries: InlineBoundary[] = [{ offset: startOffset, x: 0 }];
  let visualColumn = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    visualColumn += characterAdvanceColumns(character, visualColumn, metrics.tabSize);
    boundaries.push({ offset: startOffset + index + 1, x: visualColumn * metrics.charWidth });
  }

  return boundaries;
};

const lineWidth = (text: string, startOffset: number, metrics: PosttextLayoutMetrics): number => {
  const boundaries = scanLineBoundaries(text, startOffset, metrics);
  return boundaries[boundaries.length - 1]?.x ?? 0;
};

const pushLine = (
  lines: PosttextLineLayout[],
  row: number,
  startOffset: number,
  endOffset: number,
  text: string,
  metrics: PosttextLayoutMetrics,
) => {
  lines.push({
    row,
    startOffset,
    endOffset,
    text,
    y: row * metrics.lineHeight,
    height: metrics.lineHeight,
    width: lineWidth(text, startOffset, metrics),
  });
};

const buildLines = (
  snapshot: PieceTableSnapshot,
  metrics: PosttextLayoutMetrics,
): PosttextLineLayout[] => {
  const text = getPieceTableText(snapshot);
  const lines: PosttextLineLayout[] = [];
  let row = 0;
  let lineStart = 0;

  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] !== "\n") continue;
    pushLine(lines, row, lineStart, offset, text.slice(lineStart, offset), metrics);
    row += 1;
    lineStart = offset + 1;
  }

  pushLine(lines, row, lineStart, text.length, text.slice(lineStart), metrics);
  return lines;
};

const clampOffset = (layout: PosttextLayout, offset: number): number => {
  if (offset < 0) return 0;
  if (offset > layout.snapshot.length) return layout.snapshot.length;
  return offset;
};

const lineForOffset = (layout: PosttextLayout, offset: number): PosttextLineLayout => {
  const clampedOffset = clampOffset(layout, offset);

  for (const line of layout.lines) {
    if (clampedOffset < line.startOffset) continue;
    if (clampedOffset <= line.endOffset) return line;
  }

  return layout.lines[layout.lines.length - 1] as PosttextLineLayout;
};

const lineForRow = (layout: PosttextLayout, row: number): PosttextLineLayout => {
  const clampedRow = Math.max(0, Math.min(row, layout.lines.length - 1));
  return layout.lines[clampedRow] as PosttextLineLayout;
};

const xForOffsetInLine = (line: PosttextLineLayout, offset: number, layout: PosttextLayout) => {
  const clampedOffset = Math.max(line.startOffset, Math.min(offset, line.endOffset));
  const boundaries = scanLineBoundaries(line.text, line.startOffset, layout.metrics);
  const boundary = boundaries.find((candidate) => candidate.offset === clampedOffset);
  return boundary?.x ?? line.width;
};

const offsetForXInLine = (line: PosttextLineLayout, x: number, layout: PosttextLayout): number => {
  if (x <= 0) return line.startOffset;
  if (x >= line.width) return line.endOffset;

  const boundaries = scanLineBoundaries(line.text, line.startOffset, layout.metrics);
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index] as InlineBoundary;
    const end = boundaries[index + 1] as InlineBoundary;
    if (x > start.x && x < end.x) return offsetInsideCell(x, start, end);
    if (x === start.x) return start.offset;
  }

  return line.endOffset;
};

const offsetInsideCell = (x: number, start: InlineBoundary, end: InlineBoundary): number => {
  const midpoint = start.x + (end.x - start.x) / 2;
  if (x < midpoint) return start.offset;
  return end.offset;
};

const firstVisibleBoundary = (boundaries: readonly InlineBoundary[], x: number): InlineBoundary => {
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index] as InlineBoundary;
    const end = boundaries[index + 1] as InlineBoundary;
    if (end.x <= x) continue;
    return start;
  }

  return boundaries[boundaries.length - 1] as InlineBoundary;
};

const lastVisibleBoundary = (boundaries: readonly InlineBoundary[], x: number): InlineBoundary => {
  for (let index = boundaries.length - 2; index >= 0; index -= 1) {
    const start = boundaries[index] as InlineBoundary;
    const end = boundaries[index + 1] as InlineBoundary;
    if (start.x >= x) continue;
    return end;
  }

  return boundaries[0] as InlineBoundary;
};

const visibleInlineRange = (
  line: PosttextLineLayout,
  viewport: PosttextViewport,
  layout: PosttextLayout,
): InlineVisibleRange => {
  const boundaries = scanLineBoundaries(line.text, line.startOffset, layout.metrics);
  const start = firstVisibleBoundary(boundaries, viewport.x1);
  const end = lastVisibleBoundary(boundaries, viewport.x2);

  if (end.offset >= start.offset) {
    return {
      startOffset: start.offset,
      endOffset: end.offset,
    };
  }

  return {
    startOffset: line.startOffset,
    endOffset: line.startOffset,
  };
};

const lineIntersectsViewport = (line: PosttextLineLayout, viewport: PosttextViewport): boolean => {
  if (viewport.y2 <= line.y) return false;
  return viewport.y1 < line.y + line.height;
};

const lineIntersectsViewportX = (
  line: PosttextLineLayout,
  viewport: PosttextViewport,
): boolean => {
  if (viewport.x2 <= 0) return false;
  if (line.width === 0) return viewport.x1 <= 0;
  return viewport.x1 < line.width;
};

const viewportLineForLine = (
  line: PosttextLineLayout,
  viewport: PosttextViewport,
  layout: PosttextLayout,
): PosttextViewportLine | null => {
  if (!lineIntersectsViewport(line, viewport)) return null;
  if (!lineIntersectsViewportX(line, viewport)) return null;
  const range = visibleInlineRange(line, viewport, layout);
  const rect = rectForLineRange(line, range.startOffset, range.endOffset, layout);

  return {
    row: line.row,
    startOffset: line.startOffset,
    endOffset: line.endOffset,
    visibleStartOffset: range.startOffset,
    visibleEndOffset: range.endOffset,
    rect,
  };
};

const rectForLineRange = (
  line: PosttextLineLayout,
  startOffset: number,
  endOffset: number,
  layout: PosttextLayout,
): PosttextRect => {
  const x = xForOffsetInLine(line, startOffset, layout);
  const endX = xForOffsetInLine(line, endOffset, layout);
  return {
    x,
    y: line.y,
    width: endX - x,
    height: line.height,
  };
};

const normalizeRange = (
  layout: PosttextLayout,
  startOffset: number,
  endOffset: number,
): [number, number] => {
  const start = clampOffset(layout, Math.min(startOffset, endOffset));
  const end = clampOffset(layout, Math.max(startOffset, endOffset));
  return [start, end];
};

const rangeBoxForLine = (
  line: PosttextLineLayout,
  startOffset: number,
  endOffset: number,
  layout: PosttextLayout,
): PosttextRangeBox | null => {
  const lineStart = Math.max(startOffset, line.startOffset);
  const lineEnd = Math.min(endOffset, line.endOffset);
  if (lineEnd <= lineStart) return null;

  return {
    row: line.row,
    startOffset: lineStart,
    endOffset: lineEnd,
    rect: rectForLineRange(line, lineStart, lineEnd, layout),
  };
};

export const createNoWrapPosttextLayout = (
  snapshot: PieceTableSnapshot,
  metrics: PosttextLayoutMetrics,
): PosttextLayout => {
  const normalizedMetrics = normalizeMetrics(metrics);
  const lines = buildLines(snapshot, normalizedMetrics);
  const width = lines.reduce((maxWidth, line) => Math.max(maxWidth, line.width), 0);

  return {
    snapshot,
    metrics: normalizedMetrics,
    lines,
    width,
    height: lines.length * normalizedMetrics.lineHeight,
  };
};

export const posttextOffsetToXY = (layout: PosttextLayout, offset: number): PosttextXY => {
  const line = lineForOffset(layout, offset);
  return {
    x: xForOffsetInLine(line, offset, layout),
    y: line.y,
  };
};

export const posttextXYToOffset = (layout: PosttextLayout, point: PosttextXY): number => {
  const row = Math.floor(point.y / layout.metrics.lineHeight);
  const line = lineForRow(layout, row);
  return offsetForXInLine(line, point.x, layout);
};

export const queryNoWrapPosttextViewport = (
  layout: PosttextLayout,
  viewport: PosttextViewport,
): PosttextViewportResult => {
  const lines: PosttextViewportLine[] = [];

  for (const line of layout.lines) {
    const viewportLine = viewportLineForLine(line, viewport, layout);
    if (!viewportLine) continue;
    lines.push(viewportLine);
  }

  return { viewport, lines };
};

export const getPosttextRangeBoxes = (
  layout: PosttextLayout,
  startOffset: number,
  endOffset: number,
): PosttextRangeBox[] => {
  const [start, end] = normalizeRange(layout, startOffset, endOffset);
  if (start === end) return [];

  const boxes: PosttextRangeBox[] = [];
  for (const line of layout.lines) {
    const box = rangeBoxForLine(line, start, end, layout);
    if (!box) continue;
    boxes.push(box);
  }

  return boxes;
};
