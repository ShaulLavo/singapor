import { describe, expect, it } from "vitest";

import {
  applyBatchToPieceTable,
  applyNoWrapPosttextLayoutEdits,
  createNoWrapPosttextLayout,
  createPieceTableSnapshot,
  getPosttextRangeBoxes,
  posttextOffsetToXY,
  posttextXYToOffset,
  queryNoWrapPosttextViewport,
  type PosttextLayoutMetrics,
} from "../src/index.ts";

const metrics: PosttextLayoutMetrics = {
  charWidth: 10,
  lineHeight: 20,
  tabSize: 4,
  fontKey: "test-monospace-10",
};

describe("Posttext no-wrap layout", () => {
  it("prepares reusable per-line offset and x boundaries", () => {
    const layout = createNoWrapPosttextLayout(createPieceTableSnapshot("ab\n\tcd"), metrics);

    expect(layout.lines[1]?.boundaries).toEqual([
      { offset: 3, x: 0 },
      { offset: 4, x: 40 },
      { offset: 5, x: 50 },
      { offset: 6, x: 60 },
    ]);
  });

  it("converts offsets to XY positions with logical lines and tab stops", () => {
    const layout = createNoWrapPosttextLayout(createPieceTableSnapshot("ab\n\tcd"), metrics);

    expect(posttextOffsetToXY(layout, 0)).toEqual({ x: 0, y: 0 });
    expect(posttextOffsetToXY(layout, 2)).toEqual({ x: 20, y: 0 });
    expect(posttextOffsetToXY(layout, 3)).toEqual({ x: 0, y: 20 });
    expect(posttextOffsetToXY(layout, 4)).toEqual({ x: 40, y: 20 });
    expect(posttextOffsetToXY(layout, 6)).toEqual({ x: 60, y: 20 });
  });

  it("converts XY positions to offsets and clamps outside document bounds", () => {
    const layout = createNoWrapPosttextLayout(createPieceTableSnapshot("ab\n\tcd"), metrics);

    expect(posttextXYToOffset(layout, { x: -10, y: 0 })).toBe(0);
    expect(posttextXYToOffset(layout, { x: 14, y: 0 })).toBe(1);
    expect(posttextXYToOffset(layout, { x: 15, y: 0 })).toBe(2);
    expect(posttextXYToOffset(layout, { x: 10, y: 20 })).toBe(3);
    expect(posttextXYToOffset(layout, { x: 25, y: 20 })).toBe(4);
    expect(posttextXYToOffset(layout, { x: 999, y: 20 })).toBe(6);
    expect(posttextXYToOffset(layout, { x: 0, y: 999 })).toBe(3);
  });

  it("queries no-wrap viewport line fragments in both axes", () => {
    const layout = createNoWrapPosttextLayout(
      createPieceTableSnapshot("abcde\n\txy\nlonger"),
      metrics,
    );

    const result = queryNoWrapPosttextViewport(layout, {
      x1: 15,
      y1: 0,
      x2: 45,
      y2: 40,
    });

    expect(result.lines).toEqual([
      {
        row: 0,
        startOffset: 0,
        endOffset: 5,
        visibleStartOffset: 1,
        visibleEndOffset: 5,
        rect: { x: 10, y: 0, width: 40, height: 20 },
      },
      {
        row: 1,
        startOffset: 6,
        endOffset: 9,
        visibleStartOffset: 6,
        visibleEndOffset: 8,
        rect: { x: 0, y: 20, width: 50, height: 20 },
      },
    ]);
  });

  it("omits rows with no horizontal viewport intersection", () => {
    const layout = createNoWrapPosttextLayout(createPieceTableSnapshot("abc\n\nxyz"), metrics);

    expect(queryNoWrapPosttextViewport(layout, { x1: 40, y1: 0, x2: 80, y2: 60 }).lines).toEqual(
      [],
    );
    expect(queryNoWrapPosttextViewport(layout, { x1: -5, y1: 20, x2: 5, y2: 40 }).lines).toEqual([
      {
        row: 1,
        startOffset: 4,
        endOffset: 4,
        visibleStartOffset: 4,
        visibleEndOffset: 4,
        rect: { x: 0, y: 20, width: 0, height: 20 },
      },
    ]);
  });

  it("returns range boxes per logical line without assigning width to newlines", () => {
    const layout = createNoWrapPosttextLayout(createPieceTableSnapshot("abc\nde\n\tz"), metrics);

    expect(getPosttextRangeBoxes(layout, 1, 8)).toEqual([
      {
        row: 0,
        startOffset: 1,
        endOffset: 3,
        rect: { x: 10, y: 0, width: 20, height: 20 },
      },
      {
        row: 1,
        startOffset: 4,
        endOffset: 6,
        rect: { x: 0, y: 20, width: 20, height: 20 },
      },
      {
        row: 2,
        startOffset: 7,
        endOffset: 8,
        rect: { x: 0, y: 40, width: 40, height: 20 },
      },
    ]);
  });

  it("supports trailing newline rows and empty ranges", () => {
    const layout = createNoWrapPosttextLayout(createPieceTableSnapshot("a\n"), metrics);

    expect(layout.lines).toHaveLength(2);
    expect(layout.height).toBe(40);
    expect(posttextOffsetToXY(layout, 2)).toEqual({ x: 0, y: 20 });
    expect(getPosttextRangeBoxes(layout, 1, 1)).toEqual([]);
  });

  it("applies line-local edits without rebuilding unaffected prepared lines", () => {
    const snapshot = createPieceTableSnapshot("aa\nbb\ncc");
    const layout = createNoWrapPosttextLayout(snapshot, metrics);
    const edit = { from: 4, to: 5, text: "B" };
    const nextSnapshot = applyBatchToPieceTable(snapshot, [edit]);
    const next = applyNoWrapPosttextLayoutEdits(layout, nextSnapshot, [edit]);

    expect(next.lines[0]).toBe(layout.lines[0]);
    expect(next.lines[2]).toBe(layout.lines[2]);
    expect(next.lines[1]?.text).toBe("bB");
    expect(posttextOffsetToXY(next, 5)).toEqual({ x: 20, y: 20 });
    expect(posttextXYToOffset(next, { x: 15, y: 20 })).toBe(5);
  });

  it("applies newline edits and keeps query results aligned with a fresh layout", () => {
    const snapshot = createPieceTableSnapshot("ab\n\tcd\nxy");
    const layout = createNoWrapPosttextLayout(snapshot, metrics);
    const edit = { from: 2, to: 3, text: "" };
    const nextSnapshot = applyBatchToPieceTable(snapshot, [edit]);
    const next = applyNoWrapPosttextLayoutEdits(layout, nextSnapshot, [edit]);
    const rebuilt = createNoWrapPosttextLayout(nextSnapshot, metrics);

    expect(next).toEqual(rebuilt);
    expect(posttextOffsetToXY(next, 3)).toEqual({ x: 40, y: 0 });
    expect(posttextXYToOffset(next, { x: 30, y: 0 })).toBe(3);
    expect(queryNoWrapPosttextViewport(next, { x1: 0, y1: 0, x2: 45, y2: 20 }).lines).toEqual([
      {
        row: 0,
        startOffset: 0,
        endOffset: 5,
        visibleStartOffset: 0,
        visibleEndOffset: 4,
        rect: { x: 0, y: 0, width: 50, height: 20 },
      },
    ]);
  });
});
