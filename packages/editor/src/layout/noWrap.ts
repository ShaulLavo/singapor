import { getPieceTableText, type PieceTableSnapshot } from "../pieceTable";
import type {
  PosttextLayout,
  PosttextLineBoundary,
  PosttextLayoutMetrics,
  PosttextLineLayout,
  PosttextRangeBox,
  PosttextRect,
  PosttextTextEdit,
  PosttextViewport,
  PosttextViewportLine,
  PosttextViewportResult,
  PosttextXY,
} from "./types";

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
): PosttextLineBoundary[] => {
  const boundaries: PosttextLineBoundary[] = [{ offset: startOffset, x: 0 }];
  let visualColumn = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    visualColumn += characterAdvanceColumns(character, visualColumn, metrics.tabSize);
    boundaries.push({ offset: startOffset + index + 1, x: visualColumn * metrics.charWidth });
  }

  return boundaries;
};

const pushLine = (
  lines: PosttextLineLayout[],
  row: number,
  startOffset: number,
  endOffset: number,
  text: string,
  metrics: PosttextLayoutMetrics,
) => {
  const boundaries = scanLineBoundaries(text, startOffset, metrics);

  lines.push({
    row,
    startOffset,
    endOffset,
    text,
    boundaries,
    y: row * metrics.lineHeight,
    height: metrics.lineHeight,
    width: boundaries[boundaries.length - 1]?.x ?? 0,
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

const layoutFromLines = (
  snapshot: PieceTableSnapshot,
  metrics: PosttextLayoutMetrics,
  lines: readonly PosttextLineLayout[],
): PosttextLayout => {
  const width = lines.reduce((maxWidth, line) => Math.max(maxWidth, line.width), 0);

  return {
    snapshot,
    metrics,
    lines,
    width,
    height: lines.length * metrics.lineHeight,
  };
};

const createLinesFromPreparedText = (
  text: string,
  row: number,
  startOffset: number,
  metrics: PosttextLayoutMetrics,
): PosttextLineLayout[] => {
  const lines: PosttextLineLayout[] = [];
  const lineTexts = text.split("\n");
  let offset = startOffset;

  for (let index = 0; index < lineTexts.length; index += 1) {
    const lineText = lineTexts[index] ?? "";
    pushLine(lines, row + index, offset, offset + lineText.length, lineText, metrics);
    offset += lineText.length + 1;
  }

  return lines;
};

const shiftedBoundaries = (
  boundaries: readonly PosttextLineBoundary[],
  offsetDelta: number,
): readonly PosttextLineBoundary[] => {
  if (offsetDelta === 0) return boundaries;
  return boundaries.map((boundary) => ({
    offset: boundary.offset + offsetDelta,
    x: boundary.x,
  }));
};

const shiftLine = (
  line: PosttextLineLayout,
  rowDelta: number,
  offsetDelta: number,
  metrics: PosttextLayoutMetrics,
): PosttextLineLayout => {
  if (rowDelta === 0 && offsetDelta === 0) return line;

  const row = line.row + rowDelta;
  return {
    ...line,
    row,
    startOffset: line.startOffset + offsetDelta,
    endOffset: line.endOffset + offsetDelta,
    boundaries: shiftedBoundaries(line.boundaries, offsetDelta),
    y: row * metrics.lineHeight,
  };
};

const shiftLines = (
  lines: readonly PosttextLineLayout[],
  rowDelta: number,
  offsetDelta: number,
  metrics: PosttextLayoutMetrics,
): PosttextLineLayout[] => lines.map((line) => shiftLine(line, rowDelta, offsetDelta, metrics));

const clampOffset = (layout: PosttextLayout, offset: number): number => {
  if (offset < 0) return 0;
  if (offset > layout.snapshot.length) return layout.snapshot.length;
  return offset;
};

const lineIndexForOffset = (layout: PosttextLayout, offset: number): number => {
  const clampedOffset = clampOffset(layout, offset);
  let low = 0;
  let high = layout.lines.length - 1;
  let candidate = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const line = layout.lines[middle] as PosttextLineLayout;

    if (line.startOffset <= clampedOffset) {
      candidate = middle;
      low = middle + 1;
      continue;
    }

    high = middle - 1;
  }

  return candidate;
};

const lineForOffset = (layout: PosttextLayout, offset: number): PosttextLineLayout => {
  return layout.lines[lineIndexForOffset(layout, offset)] as PosttextLineLayout;
};

const lineForRow = (layout: PosttextLayout, row: number): PosttextLineLayout => {
  const clampedRow = Math.max(0, Math.min(row, layout.lines.length - 1));
  return layout.lines[clampedRow] as PosttextLineLayout;
};

const xForOffsetInLine = (line: PosttextLineLayout, offset: number) => {
  const clampedOffset = Math.max(line.startOffset, Math.min(offset, line.endOffset));
  const boundary = line.boundaries[clampedOffset - line.startOffset];
  return boundary?.x ?? line.width;
};

const offsetForXInLine = (line: PosttextLineLayout, x: number): number => {
  if (x <= 0) return line.startOffset;
  if (x >= line.width) return line.endOffset;

  const endIndex = firstBoundaryIndexWithXGreaterThan(line.boundaries, x);
  const start = line.boundaries[endIndex - 1] as PosttextLineBoundary;
  const end = line.boundaries[endIndex] as PosttextLineBoundary;
  return offsetInsideCell(x, start, end);
};

const offsetInsideCell = (
  x: number,
  start: PosttextLineBoundary,
  end: PosttextLineBoundary,
): number => {
  const midpoint = start.x + (end.x - start.x) / 2;
  if (x < midpoint) return start.offset;
  return end.offset;
};

const firstBoundaryIndexWithXGreaterThan = (
  boundaries: readonly PosttextLineBoundary[],
  x: number,
): number => {
  let low = 0;
  let high = boundaries.length - 1;
  let result = boundaries.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = boundaries[middle] as PosttextLineBoundary;

    if (boundary.x > x) {
      result = middle;
      high = middle - 1;
      continue;
    }

    low = middle + 1;
  }

  return result;
};

const firstBoundaryIndexWithXAtLeast = (
  boundaries: readonly PosttextLineBoundary[],
  x: number,
): number => {
  let low = 0;
  let high = boundaries.length - 1;
  let result = boundaries.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = boundaries[middle] as PosttextLineBoundary;

    if (boundary.x >= x) {
      result = middle;
      high = middle - 1;
      continue;
    }

    low = middle + 1;
  }

  return result;
};

const firstVisibleBoundary = (
  boundaries: readonly PosttextLineBoundary[],
  x: number,
): PosttextLineBoundary => {
  const index = Math.max(0, firstBoundaryIndexWithXGreaterThan(boundaries, x) - 1);
  return boundaries[index] as PosttextLineBoundary;
};

const lastVisibleBoundary = (
  boundaries: readonly PosttextLineBoundary[],
  x: number,
): PosttextLineBoundary => {
  const index = firstBoundaryIndexWithXAtLeast(boundaries, x);
  return boundaries[index] as PosttextLineBoundary;
};

const visibleInlineRange = (
  line: PosttextLineLayout,
  viewport: PosttextViewport,
): InlineVisibleRange => {
  const start = firstVisibleBoundary(line.boundaries, viewport.x1);
  const end = lastVisibleBoundary(line.boundaries, viewport.x2);

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

const lineIntersectsViewportX = (line: PosttextLineLayout, viewport: PosttextViewport): boolean => {
  if (viewport.x2 <= 0) return false;
  if (line.width === 0) return viewport.x1 <= 0;
  return viewport.x1 < line.width;
};

const viewportLineForLine = (
  line: PosttextLineLayout,
  viewport: PosttextViewport,
): PosttextViewportLine | null => {
  if (!lineIntersectsViewport(line, viewport)) return null;
  if (!lineIntersectsViewportX(line, viewport)) return null;
  const range = visibleInlineRange(line, viewport);
  const rect = rectForLineRange(line, range.startOffset, range.endOffset);

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
): PosttextRect => {
  const x = xForOffsetInLine(line, startOffset);
  const endX = xForOffsetInLine(line, endOffset);
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

const compareEditsAscending = (left: PosttextTextEdit, right: PosttextTextEdit): number => {
  if (left.from !== right.from) return left.from - right.from;
  return left.to - right.to;
};

const compareEditsDescending = (left: PosttextTextEdit, right: PosttextTextEdit): number => {
  if (left.from !== right.from) return right.from - left.from;
  return right.to - left.to;
};

const validateLayoutEdits = (layout: PosttextLayout, edits: readonly PosttextTextEdit[]): void => {
  let previousEnd = -1;
  const sorted = [...edits].sort(compareEditsAscending);

  for (const edit of sorted) {
    if (edit.from < 0 || edit.to < edit.from || edit.to > layout.snapshot.length) {
      throw new RangeError("invalid layout edit range");
    }

    if (edit.from < previousEnd) throw new RangeError("layout edits must not overlap");
    previousEnd = edit.to;
  }
};

const linePrefix = (line: PosttextLineLayout, offset: number): string => {
  const end = Math.max(0, Math.min(offset - line.startOffset, line.text.length));
  return line.text.slice(0, end);
};

const lineSuffix = (line: PosttextLineLayout, offset: number): string => {
  const start = Math.max(0, Math.min(offset - line.startOffset, line.text.length));
  return line.text.slice(start);
};

const applySingleLayoutEdit = (layout: PosttextLayout, edit: PosttextTextEdit): PosttextLayout => {
  const startIndex = lineIndexForOffset(layout, edit.from);
  const endIndex = lineIndexForOffset(layout, edit.to);
  const startLine = layout.lines[startIndex] as PosttextLineLayout;
  const endLine = layout.lines[endIndex] as PosttextLineLayout;
  const preparedText = `${linePrefix(startLine, edit.from)}${edit.text}${lineSuffix(
    endLine,
    edit.to,
  )}`;
  const preparedLines = createLinesFromPreparedText(
    preparedText,
    startLine.row,
    startLine.startOffset,
    layout.metrics,
  );
  const removedLineCount = endIndex - startIndex + 1;
  const rowDelta = preparedLines.length - removedLineCount;
  const offsetDelta = edit.text.length - (edit.to - edit.from);
  const before = layout.lines.slice(0, startIndex);
  const after = shiftLines(layout.lines.slice(endIndex + 1), rowDelta, offsetDelta, layout.metrics);
  return layoutFromLines(layout.snapshot, layout.metrics, [...before, ...preparedLines, ...after]);
};

const rangeBoxForLine = (
  line: PosttextLineLayout,
  startOffset: number,
  endOffset: number,
): PosttextRangeBox | null => {
  const lineStart = Math.max(startOffset, line.startOffset);
  const lineEnd = Math.min(endOffset, line.endOffset);
  if (lineEnd <= lineStart) return null;

  return {
    row: line.row,
    startOffset: lineStart,
    endOffset: lineEnd,
    rect: rectForLineRange(line, lineStart, lineEnd),
  };
};

export const createNoWrapPosttextLayout = (
  snapshot: PieceTableSnapshot,
  metrics: PosttextLayoutMetrics,
): PosttextLayout => {
  const normalizedMetrics = normalizeMetrics(metrics);
  const lines = buildLines(snapshot, normalizedMetrics);
  return layoutFromLines(snapshot, normalizedMetrics, lines);
};

export const applyNoWrapPosttextLayoutEdits = (
  layout: PosttextLayout,
  snapshot: PieceTableSnapshot,
  edits: readonly PosttextTextEdit[],
): PosttextLayout => {
  const normalizedMetrics = normalizeMetrics(layout.metrics);
  if (edits.length === 0 && snapshot === layout.snapshot) return layout;
  if (edits.length === 0) return createNoWrapPosttextLayout(snapshot, normalizedMetrics);

  validateLayoutEdits(layout, edits);

  let next = layoutFromLines(layout.snapshot, normalizedMetrics, layout.lines);
  const sorted = [...edits].sort(compareEditsDescending);

  for (const edit of sorted) {
    next = applySingleLayoutEdit(next, edit);
  }

  return {
    ...next,
    snapshot,
    height: next.lines.length * normalizedMetrics.lineHeight,
  };
};

export const posttextOffsetToXY = (layout: PosttextLayout, offset: number): PosttextXY => {
  const line = lineForOffset(layout, offset);
  return {
    x: xForOffsetInLine(line, offset),
    y: line.y,
  };
};

export const posttextXYToOffset = (layout: PosttextLayout, point: PosttextXY): number => {
  const row = Math.floor(point.y / layout.metrics.lineHeight);
  const line = lineForRow(layout, row);
  return offsetForXInLine(line, point.x);
};

export const queryNoWrapPosttextViewport = (
  layout: PosttextLayout,
  viewport: PosttextViewport,
): PosttextViewportResult => {
  const lines: PosttextViewportLine[] = [];
  const startRow = Math.max(0, Math.floor(viewport.y1 / layout.metrics.lineHeight));
  const endRow = Math.min(
    layout.lines.length - 1,
    Math.ceil(viewport.y2 / layout.metrics.lineHeight) - 1,
  );

  for (let row = startRow; row <= endRow; row += 1) {
    const line = layout.lines[row] as PosttextLineLayout;
    const viewportLine = viewportLineForLine(line, viewport);
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
  const startIndex = lineIndexForOffset(layout, start);
  const endIndex = lineIndexForOffset(layout, Math.max(start, end - 1));

  for (let index = startIndex; index <= endIndex; index += 1) {
    const line = layout.lines[index] as PosttextLineLayout;
    const box = rangeBoxForLine(line, start, end);
    if (!box) continue;
    boxes.push(box);
  }

  return boxes;
};
