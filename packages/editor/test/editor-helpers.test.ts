import { describe, expect, it, vi } from "vitest";
import type { EditorOptions, HighlightRegistry } from "../src/editor/types";
import {
  childContainingNode,
  childNodeIndex,
  elementBoundaryToTextOffset,
} from "../src/editor/domBoundary";
import { EditorFoldState } from "../src/editor/foldState";
import {
  foldMarkerFromRange,
  foldRangeKey,
  foldRangesEqual,
  projectSyntaxFoldsThroughLineEdit,
} from "../src/editor/folds";
import { mouseSelectionAutoScrollDelta } from "../src/editor/mouseSelection";
import { nextWordOffset, previousWordOffset } from "../src/editor/navigation";
import { lineRangeAtOffset, wordRangeAtOffset } from "../src/editor/textRanges";
import { appendTiming, eventStartMs, mergeChangeTimings } from "../src/editor/timing";
import { createDocumentSession, type DocumentSessionChange } from "../src/documentSession";
import {
  projectTokensThroughEdit,
  tokenProjectionLiveRangeStatus,
} from "../src/editor/tokenProjection";
import { createPieceTableSnapshot } from "../src/pieceTable/pieceTable";
import type { FoldRange } from "../src/syntax";

describe("editor DOM boundary helpers", () => {
  it("maps element boundaries and child nodes to text positions", () => {
    const parent = document.createElement("div");
    const first = document.createElement("span");
    const second = document.createElement("span");
    const nested = document.createElement("strong");
    second.appendChild(nested);
    parent.append(first, second);

    expect(elementBoundaryToTextOffset(-1, 10)).toBe(0);
    expect(elementBoundaryToTextOffset(1, 10)).toBe(10);
    expect(childContainingNode(parent, nested)).toBe(second);
    expect(childNodeIndex(parent, second)).toBe(1);
  });
});

describe("editor fold helpers", () => {
  it("creates stable marker keys and compares fold ranges", () => {
    const fold = foldRange({ startIndex: 4, endIndex: 20, startLine: 1, endLine: 5 });

    expect(foldRangeKey(fold)).toBe("typescript:block:4:20");
    expect(foldMarkerFromRange(fold, new Set([foldRangeKey(fold)]))).toMatchObject({
      key: "typescript:block:4:20",
      startOffset: 4,
      endOffset: 20,
      collapsed: true,
    });
    expect(foldRangesEqual([fold], [{ ...fold }])).toBe(true);
    expect(foldRangesEqual([fold], [{ ...fold, endLine: 6 }])).toBe(false);
  });

  it("projects folds through line edits and records key remaps", () => {
    const fold = foldRange({ startIndex: 10, endIndex: 30, startLine: 2, endLine: 6 });
    const projection = projectSyntaxFoldsThroughLineEdit(
      [fold],
      { from: 0, to: 0, text: "a\n" },
      "function f() {\n  return 1;\n}\n",
    );

    expect(projection?.folds[0]).toMatchObject({
      startIndex: 12,
      endIndex: 32,
      startLine: 3,
      endLine: 7,
    });
    expect(projection?.keyMap.get(foldRangeKey(fold))).toBe("typescript:block:12:32");
  });
});

describe("EditorFoldState", () => {
  it("syncs markers and remaps collapsed fold keys through projections", () => {
    const setFoldState = vi.fn();
    const state = new EditorFoldState({ setFoldState }, () =>
      createPieceTableSnapshot("function f() {\n  return 1;\n}\n"),
    );
    const fold = foldRange({ startIndex: 0, endIndex: 28, startLine: 0, endLine: 2 });

    state.setSyntaxFolds([fold]);
    state.toggle(foldMarkerFromRange(fold, new Set()));
    state.applyProjection({
      folds: [{ ...fold, startIndex: 2, endIndex: 30, startLine: 1, endLine: 3 }],
      keyMap: new Map([[foldRangeKey(fold), "typescript:block:2:30"]]),
    });

    const [markers, foldMap] = setFoldState.mock.lastCall ?? [];
    expect(markers?.[0]).toMatchObject({ key: "typescript:block:2:30", collapsed: true });
    expect(foldMap).not.toBeNull();
  });
});

describe("mouse selection helpers", () => {
  it("returns signed auto-scroll deltas near the vertical edges", () => {
    const rect = { top: 100, bottom: 300, height: 200 } as DOMRect;

    expect(mouseSelectionAutoScrollDelta(99, rect)).toBeLessThan(0);
    expect(mouseSelectionAutoScrollDelta(301, rect)).toBeGreaterThan(0);
    expect(mouseSelectionAutoScrollDelta(200, rect)).toBe(0);
  });
});

describe("navigation helpers", () => {
  it("moves by word boundaries without splitting surrogate pairs", () => {
    const text = "alpha 😀 beta";

    expect(nextWordOffset(text, 0)).toBe(6);
    expect(nextWordOffset(text, 6)).toBe(9);
    expect(previousWordOffset(text, text.length)).toBe(9);
  });
});

describe("text range helpers", () => {
  it("finds line and word ranges at clamped offsets", () => {
    const text = "one two\nthree";

    expect(lineRangeAtOffset(text, 5)).toEqual({ start: 0, end: 7 });
    expect(lineRangeAtOffset(text, 99)).toEqual({ start: 8, end: 13 });
    expect(wordRangeAtOffset(text, 4)).toEqual({ start: 4, end: 7 });
    expect(wordRangeAtOffset(text, 7)).toEqual({ start: 4, end: 7 });
  });
});

describe("timing helpers", () => {
  it("appends and merges timing measurements", () => {
    const change = createEmptyChange();
    const withTiming = appendTiming(change, "apply", eventStartMs(new Event("input")));
    const merged = mergeChangeTimings(
      { ...change, timings: [{ name: "render", durationMs: 1 }] },
      withTiming,
    );

    expect(withTiming.timings[0]?.name).toBe("apply");
    expect(merged.timings.map((timing) => timing.name)).toEqual(["apply", "render"]);
  });
});

function createEmptyChange(): DocumentSessionChange {
  return { ...createDocumentSession("a").applyText(""), timings: [] };
}

describe("token projection", () => {
  it("shifts, expands, and drops tokens across edits", () => {
    const style = { color: "red" };
    const tokens = [
      { start: 0, end: 5, style },
      { start: 6, end: 10, style },
      { start: 11, end: 16, style },
    ];

    expect(
      projectTokensThroughEdit(tokens, { from: 5, to: 5, text: "Name" }, "alpha beta gamma"),
    ).toEqual([
      { start: 0, end: 9, style },
      { start: 10, end: 14, style },
      { start: 15, end: 20, style },
    ]);
    expect(
      projectTokensThroughEdit(tokens, { from: 7, to: 9, text: "\n" }, "alpha beta gamma"),
    ).toEqual([
      { start: 0, end: 5, style },
      { start: 10, end: 15, style },
    ]);
  });

  it("records whether projected tokens can keep live ranges", () => {
    const style = { color: "red" };
    const tokens = [
      { start: 0, end: 5, style },
      { start: 6, end: 10, style },
    ];

    const shifted = projectTokensThroughEdit(tokens, { from: 5, to: 5, text: "X" }, "alpha beta");
    const dropped = projectTokensThroughEdit(tokens, { from: 7, to: 9, text: "\n" }, "alpha beta");

    expect(tokenProjectionLiveRangeStatus(tokens, shifted)).toBe(true);
    expect(tokenProjectionLiveRangeStatus(tokens, dropped)).toBe(false);
    expect(tokenProjectionLiveRangeStatus([], shifted)).toBe(false);
  });
});

describe("editor public helper types", () => {
  it("keeps public option and highlight registry contracts assignable", () => {
    const registry: HighlightRegistry = {
      set: vi.fn(),
      delete: vi.fn(() => true),
    };
    const options: EditorOptions = { plugins: [], keymap: {}, onChange: vi.fn() };

    registry.set("editor-test", {} as Highlight);
    expect(options.plugins).toEqual([]);
    expect(registry.delete("editor-test")).toBe(true);
  });
});

function foldRange(overrides: Partial<FoldRange> = {}): FoldRange {
  return {
    startIndex: 0,
    endIndex: 10,
    startLine: 0,
    endLine: 1,
    type: "block",
    languageId: "typescript",
    ...overrides,
  };
}
