import { describe, expect, it } from "vitest";

import {
  bufferColumnToVisualColumn,
  bufferPointToTabPoint,
  blockPointToBufferPoint,
  createDisplayRows,
  createWrapMap,
  tabPointToBufferPoint,
  tabPointToWrapPoint,
  visualColumnToBufferColumn,
  wrapPointToTabPoint,
  type BlockRow,
} from "../src";
import { computeLineStarts } from "../src/virtualization/virtualizedTextViewHelpers";

describe("display transform core", () => {
  it("round-trips tab-expanded columns", () => {
    const text = "\tab\tc";

    expect(bufferColumnToVisualColumn(text, 0)).toBe(0);
    expect(bufferColumnToVisualColumn(text, 1)).toBe(4);
    expect(bufferColumnToVisualColumn(text, 3)).toBe(6);
    expect(visualColumnToBufferColumn(text, 5)).toBe(2);

    const tabPoint = bufferPointToTabPoint(text, { row: 2, column: 3 });
    expect(tabPoint).toEqual({ row: 2, column: 6 });
    expect(tabPointToBufferPoint(text, tabPoint)).toEqual({ row: 2, column: 3 });
  });

  it("maps wrapped rows between tab and wrap coordinates", () => {
    const map = createWrapMap([{ row: 0, text: "abcdefghij" }], 4);

    expect(map.segments).toMatchObject([
      { inputRow: 0, outputRow: 0, startColumn: 0, endColumn: 4 },
      { inputRow: 0, outputRow: 1, startColumn: 4, endColumn: 8 },
      { inputRow: 0, outputRow: 2, startColumn: 8, endColumn: 10 },
    ]);
    expect(tabPointToWrapPoint(map, { row: 0, column: 6 } as never)).toEqual({
      row: 1,
      column: 2,
    });
    expect(wrapPointToTabPoint(map, { row: 1, column: 2 } as never)).toEqual({
      row: 0,
      column: 6,
    });
  });

  it("creates display rows for wrapped text and block rows", () => {
    const text = "abcdefghij\nxy";
    const blocks: BlockRow[] = [
      { id: "before", anchorBufferRow: 0, placement: "before", heightRows: 1, text: "B" },
      { id: "after", anchorBufferRow: 0, placement: "after", heightRows: 2, text: "A" },
    ];
    const rows = createDisplayRows({
      text,
      lineStarts: computeLineStarts(text),
      visibleLineCount: 2,
      bufferRowForVisibleRow: (row) => row,
      wrapColumn: 4,
      blocks,
    });

    expect(rows.map((row) => row.kind)).toEqual(["block", "text", "text", "text", "block", "text"]);
    expect(rows.filter((row) => row.kind === "text").map((row) => row.text)).toEqual([
      "abcd",
      "efgh",
      "ij",
      "xy",
    ]);
  });

  it("maps block rows back to nearby buffer rows", () => {
    const text = "abc\ndef";
    const rows = createDisplayRows({
      text,
      lineStarts: computeLineStarts(text),
      visibleLineCount: 2,
      bufferRowForVisibleRow: (row) => row,
      blocks: [{ id: "block", anchorBufferRow: 0, placement: "after", heightRows: 1 }],
    });

    expect(blockPointToBufferPoint(rows, { row: 1, column: 0 } as never)).toEqual({
      row: 0,
      column: 0,
    });
  });
});
