import type { PieceTableEdit, Point } from "./pieceTable/pieceTableTypes";

declare const tabPointBrand: unique symbol;
declare const wrapPointBrand: unique symbol;
declare const blockPointBrand: unique symbol;

export type TransformBias = "before" | "after" | "nearest";

export type InvalidatedRange<TPoint extends Point> = {
  readonly start: TPoint;
  readonly end: TPoint;
  readonly lineCountDelta: number;
};

export type InvalidationSet<TPoint extends Point> = readonly InvalidatedRange<TPoint>[];

export type TransformLayer<TInput extends Point, TOutput extends Point, TSnapshot> = {
  toOutput(point: TInput, bias?: TransformBias): TOutput;
  toInput(point: TOutput, bias?: TransformBias): TInput;
  update(edit: PieceTableEdit): InvalidationSet<TOutput>;
  snapshot(): TSnapshot;
};

export type TabPoint = Point & {
  readonly [tabPointBrand]: true;
};

export type WrapPoint = Point & {
  readonly [wrapPointBrand]: true;
};

export type BlockPoint = Point & {
  readonly [blockPointBrand]: true;
};

export type DisplayTextRow = {
  readonly kind: "text";
  readonly index: number;
  readonly bufferRow: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
  readonly sourceText: string;
  readonly sourceStartColumn: number;
  readonly sourceEndColumn: number;
  readonly wrapSegment: number;
};

export type DisplayBlockRow = {
  readonly kind: "block";
  readonly id: string;
  readonly index: number;
  readonly anchorBufferRow: number;
  readonly placement: BlockRowPlacement;
  readonly unitIndex: number;
  readonly heightRows: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
};

export type DisplayRow = DisplayTextRow | DisplayBlockRow;

export type BlockRowPlacement = "before" | "after";

export type BlockRow = {
  readonly id: string;
  readonly anchorBufferRow: number;
  readonly placement: BlockRowPlacement;
  readonly heightRows: number;
  readonly text?: string;
};

export type WrapSegment = {
  readonly inputRow: number;
  readonly outputRow: number;
  readonly segmentIndex: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly startVisualColumn: number;
  readonly endVisualColumn: number;
};

export type WrapMap = {
  readonly wrapColumn: number;
  readonly segments: readonly WrapSegment[];
};

export const DEFAULT_TAB_SIZE = 4;

export function bufferColumnToVisualColumn(
  text: string,
  column: number,
  tabSize = DEFAULT_TAB_SIZE,
): number {
  let visual = 0;
  const end = clampColumn(column, text.length);

  for (let index = 0; index < end; index += 1) {
    visual += visualWidthForChar(text[index]!, visual, tabSize);
  }

  return visual;
}

export function visualColumnToBufferColumn(
  text: string,
  visualColumn: number,
  bias: TransformBias = "nearest",
  tabSize = DEFAULT_TAB_SIZE,
): number {
  const target = Math.max(0, visualColumn);
  let visual = 0;

  for (let index = 0; index < text.length; index += 1) {
    const next = visual + visualWidthForChar(text[index]!, visual, tabSize);
    const column = columnForVisualTarget(index, visual, next, target, bias);
    if (column !== null) return column;
    visual = next;
  }

  return text.length;
}

export function visualColumnLength(text: string, tabSize = DEFAULT_TAB_SIZE): number {
  return bufferColumnToVisualColumn(text, text.length, tabSize);
}

export function bufferPointToTabPoint(
  text: string,
  point: Point,
  tabSize = DEFAULT_TAB_SIZE,
): TabPoint {
  return asTabPoint({
    row: point.row,
    column: bufferColumnToVisualColumn(text, point.column, tabSize),
  });
}

export function tabPointToBufferPoint(
  text: string,
  point: TabPoint,
  bias: TransformBias = "nearest",
  tabSize = DEFAULT_TAB_SIZE,
): Point {
  return {
    row: point.row,
    column: visualColumnToBufferColumn(text, point.column, bias, tabSize),
  };
}

export function createWrapMap(
  rows: readonly { readonly row: number; readonly text: string }[],
  wrapColumn: number,
  tabSize = DEFAULT_TAB_SIZE,
): WrapMap {
  const width = normalizeWrapColumn(wrapColumn);
  const segments: WrapSegment[] = [];

  for (const row of rows) {
    appendWrapSegments(segments, row.row, row.text, width, tabSize);
  }

  return { wrapColumn: width, segments };
}

export function tabPointToWrapPoint(map: WrapMap, point: TabPoint): WrapPoint {
  const segment = wrapSegmentForInput(map, point.row, point.column);
  if (!segment) return asWrapPoint(point);

  return asWrapPoint({
    row: segment.outputRow,
    column: point.column - segment.startVisualColumn,
  });
}

export function wrapPointToTabPoint(
  map: WrapMap,
  point: WrapPoint,
  bias: TransformBias = "nearest",
): TabPoint {
  const segment = wrapSegmentForOutput(map, point.row);
  if (!segment) return asTabPoint(point);

  const column = segment.startVisualColumn + clampWrapColumn(point.column, segment, bias);
  return asTabPoint({ row: segment.inputRow, column });
}

export function blockPointToBufferPoint(
  rows: readonly DisplayRow[],
  point: BlockPoint,
  bias: TransformBias = "nearest",
): Point {
  const row = rows[clampColumn(point.row, Math.max(0, rows.length - 1))];
  if (!row) return { row: 0, column: 0 };
  if (row.kind === "text") return { row: row.bufferRow, column: point.column };
  return blockRowFallbackPoint(row, bias);
}

export function createDisplayRows(options: {
  readonly lineStarts: readonly number[];
  readonly text: string;
  readonly bufferRowForVisibleRow: (row: number) => number;
  readonly visibleLineCount: number;
  readonly wrapColumn?: number | null;
  readonly blocks?: readonly BlockRow[];
  readonly tabSize?: number;
}): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const blocks = normalizeBlockRows(options.blocks ?? []);
  const tabSize = options.tabSize ?? DEFAULT_TAB_SIZE;

  for (let visibleRow = 0; visibleRow < options.visibleLineCount; visibleRow += 1) {
    appendDisplayRowsForVisibleRow(rows, visibleRow, blocks, options, tabSize);
  }

  return rows.map((row, index) => withDisplayRowIndex(row, index));
}

export const asTabPoint = (point: Point): TabPoint => point as TabPoint;
export const asWrapPoint = (point: Point): WrapPoint => point as WrapPoint;
export const asBlockPoint = (point: Point): BlockPoint => point as BlockPoint;

const appendDisplayRowsForVisibleRow = (
  rows: DisplayRow[],
  visibleRow: number,
  blocks: readonly BlockRow[],
  options: {
    readonly lineStarts: readonly number[];
    readonly text: string;
    readonly bufferRowForVisibleRow: (row: number) => number;
    readonly wrapColumn?: number | null;
  },
  tabSize: number,
): void => {
  const bufferRow = options.bufferRowForVisibleRow(visibleRow);
  const text = lineText(options.text, options.lineStarts, bufferRow);
  const startOffset = lineStartOffset(options.text, options.lineStarts, bufferRow);
  appendBlockRows(rows, blocks, bufferRow, "before", startOffset);
  appendTextDisplayRows(rows, bufferRow, text, startOffset, options.wrapColumn, tabSize);
  appendBlockRows(
    rows,
    blocks,
    bufferRow,
    "after",
    lineEndOffset(options.text, options.lineStarts, bufferRow),
  );
};

const appendTextDisplayRows = (
  rows: DisplayRow[],
  bufferRow: number,
  text: string,
  startOffset: number,
  wrapColumn: number | null | undefined,
  tabSize: number,
): void => {
  const segments = textSegments(text, wrapColumn, tabSize);
  for (const segment of segments) {
    rows.push({
      kind: "text",
      index: -1,
      bufferRow,
      startOffset: startOffset + segment.startColumn,
      endOffset: startOffset + segment.endColumn,
      text: text.slice(segment.startColumn, segment.endColumn),
      sourceText: text,
      sourceStartColumn: segment.startColumn,
      sourceEndColumn: segment.endColumn,
      wrapSegment: segment.segmentIndex,
    });
  }
};

const appendBlockRows = (
  rows: DisplayRow[],
  blocks: readonly BlockRow[],
  bufferRow: number,
  placement: BlockRowPlacement,
  offset: number,
): void => {
  for (const block of blocks) {
    if (block.anchorBufferRow !== bufferRow || block.placement !== placement) continue;
    appendBlockRowUnits(rows, block, offset);
  }
};

const appendBlockRowUnits = (rows: DisplayRow[], block: BlockRow, offset: number): void => {
  const heightRows = normalizeHeightRows(block.heightRows);
  rows.push({
    kind: "block",
    id: block.id,
    index: -1,
    anchorBufferRow: block.anchorBufferRow,
    placement: block.placement,
    unitIndex: 0,
    heightRows,
    startOffset: offset,
    endOffset: offset,
    text: block.text ?? "",
  });
};

const textSegments = (
  text: string,
  wrapColumn: number | null | undefined,
  tabSize: number,
): readonly Omit<WrapSegment, "inputRow" | "outputRow">[] => {
  const width = wrapColumn ? normalizeWrapColumn(wrapColumn) : 0;
  if (width <= 0) return [fullTextSegment(text, tabSize)];

  const segments: Omit<WrapSegment, "inputRow" | "outputRow">[] = [];
  let segmentStartColumn = 0;
  let segmentStartVisual = 0;
  let segmentVisual = 0;
  let visual = 0;

  for (let column = 0; column < text.length; column += 1) {
    const charWidth = visualWidthForChar(text[column]!, visual, tabSize);
    if (segmentVisual > 0 && segmentVisual + charWidth > width) {
      segments.push(segmentForColumns(segments.length, text, segmentStartColumn, column, tabSize));
      segmentStartColumn = column;
      segmentStartVisual = visual;
      segmentVisual = 0;
    }

    segmentVisual += charWidth;
    visual += charWidth;
  }

  segments.push({
    segmentIndex: segments.length,
    startColumn: segmentStartColumn,
    endColumn: text.length,
    startVisualColumn: segmentStartVisual,
    endVisualColumn: visual,
  });
  return segments;
};

const appendWrapSegments = (
  segments: WrapSegment[],
  row: number,
  text: string,
  wrapColumn: number,
  tabSize: number,
): void => {
  const rowSegments = textSegments(text, wrapColumn, tabSize);
  for (const segment of rowSegments) {
    segments.push({
      ...segment,
      inputRow: row,
      outputRow: segments.length,
    });
  }
};

const fullTextSegment = (
  text: string,
  tabSize: number,
): Omit<WrapSegment, "inputRow" | "outputRow"> => ({
  segmentIndex: 0,
  startColumn: 0,
  endColumn: text.length,
  startVisualColumn: 0,
  endVisualColumn: visualColumnLength(text, tabSize),
});

const segmentForColumns = (
  index: number,
  text: string,
  startColumn: number,
  endColumn: number,
  tabSize: number,
): Omit<WrapSegment, "inputRow" | "outputRow"> => ({
  segmentIndex: index,
  startColumn,
  endColumn,
  startVisualColumn: bufferColumnToVisualColumn(text, startColumn, tabSize),
  endVisualColumn: bufferColumnToVisualColumn(text, endColumn, tabSize),
});

const wrapSegmentForInput = (map: WrapMap, row: number, column: number): WrapSegment | undefined =>
  map.segments.find((segment) => {
    if (segment.inputRow !== row) return false;
    if (column < segment.startVisualColumn) return false;
    return column <= segment.endVisualColumn;
  });

const wrapSegmentForOutput = (map: WrapMap, row: number): WrapSegment | undefined =>
  map.segments.find((segment) => segment.outputRow === row);

const clampWrapColumn = (column: number, segment: WrapSegment, bias: TransformBias): number => {
  const length = segment.endVisualColumn - segment.startVisualColumn;
  if (bias === "after") return clampColumn(column, length);
  return clampColumn(column, length);
};

const columnForVisualTarget = (
  index: number,
  visual: number,
  next: number,
  target: number,
  bias: TransformBias,
): number | null => {
  if (target < visual || target > next) return null;
  if (target === visual) return index;
  if (target === next) return index + 1;
  if (bias === "before") return index;
  if (bias === "after") return index + 1;
  return target - visual <= next - target ? index : index + 1;
};

const visualWidthForChar = (char: string, column: number, tabSize: number): number => {
  if (char !== "\t") return 1;
  return tabSize - (column % tabSize);
};

const blockRowFallbackPoint = (row: DisplayBlockRow, bias: TransformBias): Point => {
  const nextRow = row.placement === "before" && bias === "after";
  return { row: row.anchorBufferRow + (nextRow ? 1 : 0), column: 0 };
};

const normalizeBlockRows = (blocks: readonly BlockRow[]): readonly BlockRow[] =>
  blocks
    .filter((block) => block.id.length > 0)
    .filter((block) => block.anchorBufferRow >= 0)
    .toSorted((left, right) => {
      return (
        left.anchorBufferRow - right.anchorBufferRow ||
        placementOrder(left.placement) - placementOrder(right.placement) ||
        left.id.localeCompare(right.id)
      );
    });

const placementOrder = (placement: BlockRowPlacement): number => (placement === "before" ? 0 : 1);

const withDisplayRowIndex = (row: DisplayRow, index: number): DisplayRow => ({ ...row, index });

const lineText = (text: string, lineStarts: readonly number[], row: number): string =>
  text.slice(lineStartOffset(text, lineStarts, row), lineEndOffset(text, lineStarts, row));

const lineStartOffset = (text: string, lineStarts: readonly number[], row: number): number =>
  lineStarts[row] ?? text.length;

const lineEndOffset = (text: string, lineStarts: readonly number[], row: number): number => {
  const nextLineStart = lineStarts[row + 1];
  if (nextLineStart === undefined) return text.length;
  return Math.max(lineStartOffset(text, lineStarts, row), nextLineStart - 1);
};

const normalizeWrapColumn = (wrapColumn: number): number => {
  if (!Number.isFinite(wrapColumn) || wrapColumn <= 0) return 0;
  return Math.max(1, Math.floor(wrapColumn));
};

const normalizeHeightRows = (heightRows: number): number => {
  if (!Number.isFinite(heightRows) || heightRows <= 0) return 1;
  return Math.max(1, Math.floor(heightRows));
};

const clampColumn = (value: number, max: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.floor(value)), Math.max(0, max));
};
