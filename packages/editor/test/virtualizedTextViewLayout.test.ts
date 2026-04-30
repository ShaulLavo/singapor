import { describe, expect, it } from "vitest";
import type { BlockRow, DisplayRow, DisplayTextRow } from "../src/displayTransforms";
import type { VirtualizedTextViewInternal } from "../src/virtualization/virtualizedTextViewInternals";
import {
  hasVariableRows,
  rowForOffset,
  rowSizes,
  virtualRowForBufferRow,
} from "../src/virtualization/virtualizedTextViewLayout";

describe("virtualized text view layout", () => {
  it("maps plain offsets without scanning every display row", () => {
    const lineCount = 100_000;
    const lineStarts = Array.from({ length: lineCount }, (_value, row) => row * 2);
    const displayRows = lineStarts.map((start, row) => textRow(row, row, start, start + 1));
    const view = layoutView({
      text: "x".repeat(lineStarts.at(-1)! + 1),
      lineStarts,
      displayRows,
      foldMap: null,
      blockRows: [],
      wrapEnabled: false,
    });

    const lastRow = lineCount - 1;
    const offsetRow = withThrowingArrayFind(() => rowForOffset(view, lineStarts[lastRow]!));
    const virtualRow = withThrowingArrayFind(() => virtualRowForBufferRow(view, lastRow));

    expect(offsetRow).toBe(lastRow);
    expect(virtualRow).toBe(lastRow);
  });

  it("keeps wrapped row boundary offsets on the preceding segment", () => {
    const sourceText = "abcdefghij";
    const view = layoutView({
      text: sourceText,
      lineStarts: [0],
      displayRows: [
        textRow(0, 0, 0, 5, "abcde", sourceText, 0),
        textRow(1, 0, 5, 10, "fghij", sourceText, 1),
      ],
      foldMap: null,
      blockRows: [],
      wrapEnabled: true,
    });

    expect(rowForOffset(view, 5)).toBe(0);
    expect(rowForOffset(view, 6)).toBe(1);
  });

  it("skips block rows when mapping an offset to text", () => {
    const blockRows: BlockRow[] = [
      { id: "before-first", anchorBufferRow: 0, placement: "before", heightRows: 1 },
    ];
    const view = layoutView({
      text: "abc",
      lineStarts: [0],
      displayRows: [blockRow(0, 0, "before"), textRow(1, 0, 0, 3, "abc")],
      foldMap: null,
      blockRows,
      wrapEnabled: false,
    });

    expect(rowForOffset(view, 0)).toBe(1);
    expect(virtualRowForBufferRow(view, 0)).toBe(1);
  });

  it("detects fixed row heights without scanning display rows", () => {
    const displayRows = throwingDisplayRows([textRow(0, 0, 0, 1)]);
    const view = layoutView({
      text: "x",
      lineStarts: [0],
      displayRows,
      foldMap: null,
      blockRows: [],
      wrapEnabled: false,
    });

    expect(hasVariableRows(view)).toBe(false);
    expect(rowSizes(view)).toBeUndefined();
  });

  it("detects variable block heights from block row config", () => {
    const blockRows: BlockRow[] = [
      { id: "panel", anchorBufferRow: 0, placement: "after", heightRows: 2 },
    ];
    const view = layoutView({
      text: "x",
      lineStarts: [0],
      displayRows: [textRow(0, 0, 0, 1), blockRow(1, 0, "after", 2)],
      foldMap: null,
      blockRows,
      wrapEnabled: false,
    });

    expect(hasVariableRows(view)).toBe(true);
    expect(rowSizes(view)).toEqual([20, 40]);
  });
});

type LayoutFields = Pick<
  VirtualizedTextViewInternal,
  "text" | "lineStarts" | "displayRows" | "foldMap" | "blockRows" | "wrapEnabled"
>;

function layoutView(fields: LayoutFields): VirtualizedTextViewInternal {
  return {
    ...fields,
    metrics: { rowHeight: 20, characterWidth: 8 },
  } as VirtualizedTextViewInternal;
}

function textRow(
  index: number,
  bufferRow: number,
  startOffset: number,
  endOffset: number,
  text = "x",
  sourceText = text,
  wrapSegment = 0,
): DisplayTextRow {
  return {
    kind: "text",
    index,
    bufferRow,
    startOffset,
    endOffset,
    text,
    sourceText,
    sourceStartColumn: startOffset,
    sourceEndColumn: endOffset,
    wrapSegment,
  };
}

function blockRow(
  index: number,
  anchorBufferRow: number,
  placement: "before" | "after",
  heightRows = 1,
): DisplayRow {
  return {
    kind: "block",
    id: `block-${index}`,
    index,
    anchorBufferRow,
    placement,
    unitIndex: 0,
    heightRows,
    startOffset: 0,
    endOffset: 0,
    text: "",
  };
}

function throwingDisplayRows(rows: DisplayRow[]): DisplayRow[] {
  return Object.assign(rows, {
    map: throwingDisplayRowScan,
    some: throwingDisplayRowScan,
  });
}

function throwingDisplayRowScan(): never {
  throw new Error("unexpected display row scan");
}

function withThrowingArrayFind<T>(run: () => T): T {
  const originalFind = Array.prototype.find;
  Array.prototype.find = throwingArrayFind as typeof Array.prototype.find;

  try {
    return run();
  } finally {
    Array.prototype.find = originalFind;
  }
}

function throwingArrayFind(): never {
  throw new Error("unexpected linear Array.find");
}
