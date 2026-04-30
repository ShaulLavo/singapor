import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectTokensThroughEdit } from "../src/editor/tokenProjection";
import { createFoldGutterContribution, createLineGutterContribution } from "../src/gutters";
import {
  createFoldMap,
  createPieceTableSnapshot,
  measureBrowserTextMetrics,
  treeSitterCapturesToEditorTokens,
  VirtualizedTextView,
  type VirtualizedFoldMarker,
  type VirtualizedTextHighlightRegistry,
} from "../src";

const highlightsMap = new Map<string, Highlight>();
let registrySets = 0;
let registryDeletes = 0;
let highlightClears = 0;
let highlightAdds = 0;
let highlightDeletes = 0;
const mockRegistry: VirtualizedTextHighlightRegistry = {
  set: (name, highlight) => {
    registrySets += 1;
    highlightsMap.set(name, highlight);
  },
  delete: (name) => {
    registryDeletes += 1;
    return highlightsMap.delete(name);
  },
};

class MockHighlight extends Set<Range> {
  add(range: Range): this {
    highlightAdds += 1;
    return super.add(range);
  }

  delete(range: Range): boolean {
    highlightDeletes += 1;
    return super.delete(range);
  }

  clear(): void {
    highlightClears += 1;
    super.clear();
  }
}

describe("VirtualizedTextView", () => {
  let container: HTMLElement;
  let view: VirtualizedTextView;

  beforeEach(() => {
    highlightsMap.clear();
    registrySets = 0;
    registryDeletes = 0;
    highlightClears = 0;
    highlightAdds = 0;
    highlightDeletes = 0;
    // @ts-expect-error happy-dom does not provide Highlight.
    globalThis.Highlight = MockHighlight;
    container = document.createElement("div");
    document.body.appendChild(container);
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 2,
      highlightRegistry: mockRegistry,
      selectionHighlightName: "test-selection",
    });
  });

  afterEach(() => {
    view.dispose();
    container.remove();
    Reflect.deleteProperty(globalThis, "Highlight");
  });

  it("mounts only visible and overscanned rows for large documents without default gutters", () => {
    view.setText(createLines(100_000));
    view.setScrollMetrics(0, 100);

    const rows = container.querySelectorAll("[data-editor-virtual-row]");
    const gutterRows = container.querySelectorAll("[data-editor-virtual-gutter-row]");
    expect(rows).toHaveLength(7);
    expect(gutterRows).toHaveLength(0);
    expect(view.scrollElement.style.getPropertyValue("--editor-gutter-width")).toBe("0px");
    expect(view.getState()).toMatchObject({
      lineCount: 100_000,
      totalHeight: 2_000_000,
      visibleRange: { start: 0, end: 5 },
    });
  });

  it("adds bottom scroll padding so the final row can align with the viewport top", () => {
    view.setText(createLines(10));
    view.setScrollMetrics(0, 100);

    const spacer = container.querySelector(".editor-virtualized-spacer") as HTMLElement;
    expect(view.getState().totalHeight).toBe(200);
    expect(spacer.style.height).toBe("280px");

    view.setScrollMetrics(180, 100);

    expect(view.getState().visibleRange).toEqual({ start: 9, end: 10 });
    expect(view.getState().mountedRows.at(-1)).toMatchObject({
      index: 9,
      top: 180,
    });
  });

  it("renders gutter rows with CSS counter line numbers", () => {
    view.dispose();
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 2,
      highlightRegistry: mockRegistry,
      selectionHighlightName: "test-selection",
      gutterContributions: [createLineGutterContribution()],
    });
    view.setText("alpha\nbeta\ngamma");
    view.setScrollMetrics(0, 80);

    const firstLabel = container.querySelector(
      '[data-editor-virtual-gutter-row="0"] .editor-virtualized-line-number',
    ) as HTMLSpanElement;

    expect(firstLabel).not.toBeNull();
    expect(firstLabel.textContent).toBe("");
    expect(firstLabel.style.counterSet).toBe("editor-line 1");
    expect(firstLabel.style.getPropertyValue("--editor-line-gutter-counter-style")).toBe("decimal");
  });

  it("passes raw CSS counter styles through the line gutter", () => {
    view.dispose();
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      highlightRegistry: mockRegistry,
      selectionHighlightName: "test-selection",
      gutterContributions: [createLineGutterContribution({ counterStyle: 'symbols("*" "+")' })],
    });
    view.setText("alpha");
    view.setScrollMetrics(0, 20);

    const firstLabel = container.querySelector(
      '[data-editor-virtual-gutter-row="0"] .editor-virtualized-line-number',
    ) as HTMLSpanElement;

    expect(firstLabel.style.getPropertyValue("--editor-line-gutter-counter-style")).toBe(
      'symbols("*" "+")',
    );
  });

  it("highlights the line gutter number for the cursor row", () => {
    view.dispose();
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      highlightRegistry: mockRegistry,
      selectionHighlightName: "test-selection",
      gutterContributions: [createLineGutterContribution()],
    });
    view.setText("alpha\nbeta\ngamma");
    view.setScrollMetrics(0, 80);

    const firstLabel = container.querySelector(
      '[data-editor-virtual-gutter-row="0"] .editor-virtualized-line-number',
    ) as HTMLSpanElement;
    const secondLabel = container.querySelector(
      '[data-editor-virtual-gutter-row="1"] .editor-virtualized-line-number',
    ) as HTMLSpanElement;

    view.setSelection(0, 0);
    expect(firstLabel.classList.contains("editor-virtualized-line-number-active")).toBe(true);
    expect(secondLabel.classList.contains("editor-virtualized-line-number-active")).toBe(false);

    view.setSelection(6, 6);
    expect(firstLabel.classList.contains("editor-virtualized-line-number-active")).toBe(false);
    expect(secondLabel.classList.contains("editor-virtualized-line-number-active")).toBe(true);
  });

  it("sizes the gutter from deterministic CSS columns", () => {
    view.dispose();
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      highlightRegistry: mockRegistry,
      selectionHighlightName: "test-selection",
      gutterContributions: [createLineGutterContribution(), createFoldGutterContribution()],
    });
    view.setText(createLines(1_500));
    view.setScrollMetrics(1_499 * 20, 20);

    const spacer = container.querySelector(".editor-virtualized-spacer") as HTMLElement;
    expect(view.scrollElement.style.getPropertyValue("--editor-gutter-width")).toBe("50px");
    expect(spacer.style.width).toBe("122px");
  });

  it("updates mounted rows when scrolling", () => {
    view.setText(createLines(200));
    view.setScrollMetrics(2_000, 60);

    const indexes = view.getState().mountedRows.map((row) => row.index);
    expect(indexes).toEqual([98, 99, 100, 101, 102, 103, 104]);
  });

  it("recycles row elements that leave the mounted window", () => {
    view.setText(createLines(200));
    view.setScrollMetrics(0, 100);

    const firstRowElement = container.querySelector(
      '[data-editor-virtual-row="0"]',
    ) as HTMLDivElement;

    view.setScrollMetrics(60, 100);

    expect(firstRowElement.isConnected).toBe(true);
    expect(firstRowElement.dataset.editorVirtualRow).toBe("7");
  });

  it("parks surplus rows outside the active row set for reuse", () => {
    view.setText(createLines(200));
    view.setScrollMetrics(0, 100);
    const initialRows = Array.from(
      container.querySelectorAll<HTMLDivElement>(".editor-virtualized-row"),
    );

    view.setScrollMetrics(0, 20);

    const parkedRow = initialRows.find((row) => row.dataset.editorVirtualRow === undefined);
    expect(parkedRow?.isConnected).toBe(true);
    expect(parkedRow?.hidden).toBe(true);
    expect(container.querySelectorAll("[data-editor-virtual-row]")).toHaveLength(
      view.getState().mountedRows.length,
    );

    view.setScrollMetrics(0, 100);

    expect(parkedRow?.dataset.editorVirtualRow).not.toBeUndefined();
    expect(parkedRow?.hidden).toBe(false);
  });

  it("keeps horizontal content width independent from recycled row text", () => {
    view.setText([`${"x".repeat(100)}`, ...Array.from({ length: 20 }, () => "x")].join("\n"));
    view.setScrollMetrics(0, 40);
    const widthAfterLongLine = view.getState().contentWidth;

    view.setScrollMetrics(200, 20);

    expect(view.getState().contentWidth).toBe(widthAfterLongLine);
  });

  it("mounts only horizontal chunks around the viewport for very long lines", () => {
    view.dispose();
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      highlightRegistry: mockRegistry,
      selectionHighlightName: "test-selection",
      longLineChunkSize: 1_000,
      longLineChunkThreshold: 1_000,
      horizontalOverscanColumns: 0,
    });
    view.setText("x".repeat(5_000));
    view.setScrollMetrics(0, 20, 80);
    const firstChunk = view.getState().mountedRows[0]?.chunks[0];

    expect(firstChunk?.localStart).toBe(0);
    expect(firstChunk?.textNode.length).toBe(1_000);
    expect(container.querySelector(".editor-virtualized-row")?.textContent?.length).toBe(1_000);

    const scrollLeft = 2_400 * view.getState().metrics.characterWidth;
    view.setScrollMetrics(0, 20, 80, scrollLeft);
    const scrolledChunk = view.getState().mountedRows[0]?.chunks[0];

    expect(scrolledChunk?.localStart).toBeGreaterThan(0);
    expect(scrolledChunk?.textNode.length).toBeLessThanOrEqual(1_000);
  });

  it("mounts wrapped text segments as virtual rows when wrapping is enabled", () => {
    view.dispose();
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      highlightRegistry: mockRegistry,
      selectionHighlightName: "test-selection",
      wrap: true,
      gutterContributions: [createLineGutterContribution()],
    });
    mockViewport(view.scrollElement, 72, 80);

    view.setText("abcdefghij");
    view.setScrollMetrics(0, 80, 72);

    expect(view.getState().wrapActive).toBe(true);
    expect(view.getState().totalHeight).toBe(40);
    expect(view.getState().mountedRows.map((row) => row.text)).toEqual(["abcde", "fghij"]);
    const labels = container.querySelectorAll<HTMLSpanElement>(".editor-virtualized-line-number");
    expect(labels[0]?.style.counterSet).toBe("editor-line 1");
    expect(labels[1]?.hidden).toBe(true);
    expect(view.textOffsetFromViewportPoint(64, 25)).toBe(9);
  });

  it("mounts internal block rows with row-unit height", () => {
    view.setText("abc\ndef");
    view.setBlockRows([
      { id: "after-first", anchorBufferRow: 0, placement: "after", heightRows: 2, text: "panel" },
    ]);
    view.setScrollMetrics(0, 80);

    const rows = view.getState().mountedRows;
    expect(view.getState().blockRowCount).toBe(1);
    expect(view.getState().totalHeight).toBe(80);
    expect(rows.map((row) => row.kind)).toEqual(["text", "block", "text"]);
    expect(rows[1]).toMatchObject({ text: "panel", height: 40, startOffset: 3, endOffset: 3 });
    expect(view.textOffsetFromViewportPoint(100, 25)).toBe(3);
  });

  it("maps chunked DOM boundaries back to document offsets", () => {
    view.dispose();
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      highlightRegistry: mockRegistry,
      selectionHighlightName: "test-selection",
      longLineChunkSize: 1_000,
      longLineChunkThreshold: 1_000,
      horizontalOverscanColumns: 0,
    });
    const scrollLeft = 2_400 * view.getState().metrics.characterWidth;
    view.setText("x".repeat(5_000));
    view.setScrollMetrics(0, 20, 80, scrollLeft);

    const chunk = view.getState().mountedRows[0]?.chunks[0];

    expect(chunk).toBeDefined();
    expect(view.textOffsetFromDomBoundary(chunk!.textNode, 5)).toBe(chunk!.startOffset + 5);
  });

  it("maps mounted DOM text boundaries back to document offsets", () => {
    view.setText("abc\ndef\nxyz");
    view.setScrollMetrics(0, 80);

    const row = view.getState().mountedRows.find((mounted) => mounted.index === 1);
    expect(row).toBeDefined();
    expect(view.textOffsetFromDomBoundary(row!.textNode, 2)).toBe(6);
  });

  it("patches same-line edits without replacing the whole row text node", () => {
    view.setText("abc\ndef");
    view.setScrollMetrics(0, 40);
    const rowZeroBefore = view.getState().mountedRows.find((row) => row.index === 0)!;
    const rowOneBefore = view.getState().mountedRows.find((row) => row.index === 1)!;
    const replaceData = vi.spyOn(rowZeroBefore.textNode, "replaceData");

    view.applyEdit({ from: 1, to: 1, text: "X" }, "aXbc\ndef");

    const rowZeroAfter = view.getState().mountedRows.find((row) => row.index === 0)!;
    const rowOneAfter = view.getState().mountedRows.find((row) => row.index === 1)!;
    expect(rowZeroAfter.textNode).toBe(rowZeroBefore.textNode);
    expect(rowZeroAfter.text).toBe("aXbc");
    expect(rowZeroAfter.textNode.data).toBe("aXbc");
    expect(rowOneAfter.textNode).toBe(rowOneBefore.textNode);
    expect(rowOneAfter.startOffset).toBe(5);
    expect(view.textOffsetFromDomBoundary(rowOneAfter.textNode, 1)).toBe(6);
    expect(replaceData).toHaveBeenCalledWith(1, 0, "X");
  });

  it("does not read horizontal scroll while re-rendering direct rows", () => {
    view.setText("abc\ndef");
    view.setScrollMetrics(0, 40);
    withThrowingScrollLeft(view.scrollElement, () => {
      view.applyEdit({ from: 3, to: 3, text: "\n" }, "abc\n\ndef");
    });

    expect(view.getState().mountedRows.map((row) => row.text)).toEqual(["abc", "", "def"]);
  });

  it("does not read layout while rendering seeded long-line metrics", () => {
    view.dispose();
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      highlightRegistry: mockRegistry,
      selectionHighlightName: "test-selection",
      longLineChunkSize: 1_000,
      longLineChunkThreshold: 1_000,
      horizontalOverscanColumns: 0,
    });
    view.setText("x".repeat(5_000));

    withThrowingRenderLayoutReads(view.scrollElement, () => {
      view.setScrollMetrics(0, 20, 80, 0);
      view.setScrollMetrics(0, 20, 80, 2_400 * view.getState().metrics.characterWidth);
    });

    expect(view.getState().mountedRows[0]?.chunks[0]?.localStart).toBeGreaterThan(0);
  });

  it("snaps viewport fallback points outside vertical bounds to visible line edges", () => {
    view.setText("alpha\nbeta\ngamma");
    view.setScrollMetrics(0, 40);
    mockViewport(view.scrollElement, 80, 40);

    expect(view.textOffsetFromViewportPoint(8, -5)).toBe(0);
    expect(view.textOffsetFromViewportPoint(8, 45)).toBe(10);
  });

  it("maps viewport fallback points in the gutter to the line start", () => {
    view.dispose();
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 2,
      highlightRegistry: mockRegistry,
      selectionHighlightName: "test-selection",
      gutterContributions: [createLineGutterContribution()],
    });
    view.setText("abc\ndef");
    view.setScrollMetrics(0, 40);
    mockViewport(view.scrollElement, 120, 40);

    expect(view.textOffsetFromViewportPoint(8, 25)).toBe(4);
  });

  it("returns null for DOM boundaries outside mounted rows", () => {
    view.setText("abc\ndef");
    view.setScrollMetrics(0, 20);

    expect(view.textOffsetFromDomBoundary(container, 0)).toBeNull();
  });

  it("paints selections only across mounted row ranges", () => {
    view.setText("abc\ndef\nxyz");
    view.setScrollMetrics(0, 80);
    view.setSelection(1, 7);

    expect(highlightsMap.get("test-selection")?.size).toBe(2);
  });

  it("does not rebuild unchanged mounted selection ranges", () => {
    view.setText("abc\ndef\nxyz");
    view.setScrollMetrics(0, 80);
    view.setSelection(1, 7);

    const addCount = highlightAdds;
    const clearCount = highlightClears;
    view.setSelection(1, 7);

    expect(highlightAdds).toBe(addCount);
    expect(highlightClears).toBe(clearCount);
  });

  it("positions a collapsed caret without native range measurement", () => {
    const originalGetClientRects = Range.prototype.getClientRects;
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => {
        throw new Error("unexpected native range measurement");
      },
    });

    try {
      view.setText("abcd\ndef");
      view.setScrollMetrics(0, 40);
      view.setSelection(2, 2);
    } finally {
      restoreRangeGetClientRects(originalGetClientRects);
    }

    const caret = container.querySelector(".editor-virtualized-caret") as HTMLElement;
    expect(caret.hidden).toBe(false);
    expect(caret.style.transform).toBe("translate(16px, 0px)");
  });

  it("paints selections only across mounted horizontal chunks", () => {
    view.dispose();
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      highlightRegistry: mockRegistry,
      selectionHighlightName: "test-selection",
      longLineChunkSize: 1_000,
      longLineChunkThreshold: 1_000,
      horizontalOverscanColumns: 0,
    });
    view.setText("x".repeat(5_000));
    view.setScrollMetrics(0, 20, 80);
    view.setSelection(0, 5_000);

    expect(highlightsMap.get("test-selection")?.size).toBe(1);
  });

  it("repaints stored selections when new rows mount", () => {
    view.setText(createLines(200));
    view.setScrollMetrics(0, 40);
    view.setSelection(900, 930);

    expect(highlightsMap.has("test-selection")).toBe(false);

    view.setScrollMetrics(2_200, 80);

    expect(highlightsMap.get("test-selection")?.size).toBeGreaterThan(0);
  });

  it("creates token highlights for mounted token intersections", () => {
    view.setText("const x = 1;\nconst y = 2;");
    view.setScrollMetrics(0, 40);
    view.setTokens([{ start: 0, end: 5, style: { color: "#ff0000" } }]);

    const tokenHighlight = [...highlightsMap.keys()].find((name) => name.includes("-token-"));
    expect(tokenHighlight).toBeDefined();
    expect(highlightsMap.get(tokenHighlight!)?.size).toBe(1);
  });

  it("splits token highlights across intersecting mounted rows", () => {
    view.setText("alpha\nbeta\ngamma");
    view.setScrollMetrics(0, 80);
    view.setTokens([{ start: 2, end: 10, style: { color: "#ff0000" } }]);

    const ranges = tokenHighlightRanges();
    const rows = view.getState().mountedRows;

    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.startContainer).toBe(rows[0]!.textNode);
    expect(ranges[0]!.startOffset).toBe(2);
    expect(ranges[0]!.endOffset).toBe(5);
    expect(ranges[1]!.startContainer).toBe(rows[1]!.textNode);
    expect(ranges[1]!.startOffset).toBe(0);
    expect(ranges[1]!.endOffset).toBe(4);
  });

  it("renders token highlights from unsorted token input", () => {
    view.setText("first\nsecond");
    view.setScrollMetrics(0, 40);
    view.setTokens([
      { start: 6, end: 12, style: { color: "#00ff00" } },
      { start: 0, end: 5, style: { color: "#ff0000" } },
    ]);

    const rows = view.getState().mountedRows;
    const first = tokenHighlightRangeForNode(rows[0]!.textNode);
    const second = tokenHighlightRangeForNode(rows[1]!.textNode);

    expect(first?.range.startOffset).toBe(0);
    expect(first?.range.endOffset).toBe(5);
    expect(second?.range.startOffset).toBe(0);
    expect(second?.range.endOffset).toBe(6);
  });

  it("does not scan offscreen Tree-sitter token styles while rendering the viewport", () => {
    const lines = createLines(10_000).split("\n");
    const captures = lineStartOffsets(lines).map((offset) => ({
      captureName: "variable",
      endIndex: offset + 4,
      startIndex: offset,
    }));
    const tokens = treeSitterCapturesToEditorTokens(captures);

    Object.defineProperty(tokens[5_000]!, "style", {
      configurable: true,
      get: () => {
        throw new Error("unexpected offscreen token style scan");
      },
    });

    view.setText(lines.join("\n"));
    view.setScrollMetrics(0, 20);

    expect(() => view.setTokens(tokens)).not.toThrow();
    expect(tokenHighlightRanges().length).toBeGreaterThan(0);
  });

  it("skips token highlight work when same-line edits only move existing token ranges", () => {
    view.setText("world");
    view.setScrollMetrics(0, 20);
    view.setTokens([{ start: 0, end: 5, style: { color: "#ff0000" } }]);

    const tokenHighlightName = tokenHighlightNames()[0]!;
    const tokenHighlight = highlightsMap.get(tokenHighlightName)!;
    const addCount = highlightAdds;
    const deleteCount = highlightDeletes;
    highlightClears = 0;

    view.applyEdit({ from: 2, to: 2, text: "X" }, "woXrld");
    view.setTokens([{ start: 0, end: 6, style: { color: "#ff0000" } }]);

    const ranges = [...tokenHighlight];
    expect(highlightsMap.get(tokenHighlightName)).toBe(tokenHighlight);
    expect(highlightClears).toBe(0);
    expect(highlightAdds).toBe(addCount);
    expect(highlightDeletes).toBe(deleteCount);
    expect(ranges).toHaveLength(1);
  });

  it("does not rescan token styles when same-line edits keep live token ranges", () => {
    view.setText("world");
    view.setScrollMetrics(0, 20);
    const tokens = [{ start: 0, end: 5, style: { color: "#ff0000" } }];
    view.adoptTokens(tokens);
    const stringify = vi.spyOn(JSON, "stringify");

    try {
      view.applyEdit({ from: 2, to: 2, text: "X" }, "woXrld");
      const projected = projectTokensThroughEdit(tokens, { from: 2, to: 2, text: "X" }, "world");
      Object.defineProperty(projected[0]!, "style", {
        configurable: true,
        get: () => {
          throw new Error("unexpected token style scan");
        },
      });

      view.setTokens(projected);

      const tokenStyleCalls = stringify.mock.calls.filter(([value]) =>
        isTokenStyleSerializationInput(value),
      );
      expect(tokenStyleCalls).toHaveLength(0);
    } finally {
      stringify.mockRestore();
    }
  });

  it("repaints token highlights only for rows with changed local segments", () => {
    view.setText("aa\nbb");
    view.setScrollMetrics(0, 40);
    view.setTokens([
      { start: 0, end: 2, style: { color: "#ff0000" } },
      { start: 3, end: 5, style: { color: "#ff0000" } },
    ]);

    const rowOne = view.getState().mountedRows.find((row) => row.index === 1)!;
    const preserved = tokenHighlightRangeForNode(rowOne.textNode);
    expect(preserved).toBeDefined();

    view.applyEdit({ from: 1, to: 1, text: "X" }, "aXa\nbb");
    view.setTokens([
      { start: 0, end: 1, style: { color: "#ff0000" } },
      { start: 1, end: 3, style: { color: "#00ff00" } },
      { start: 4, end: 6, style: { color: "#ff0000" } },
    ]);

    expect([...preserved!.highlight]).toContain(preserved!.range);
    expect(preserved!.range.startContainer).toBe(rowOne.textNode);
    expect(preserved!.range.startOffset).toBe(0);
    expect(preserved!.range.endOffset).toBe(2);
  });

  it("does not repaint when the token list is unchanged", () => {
    const tokens = [{ start: 0, end: 5, style: { color: "#ff0000" } }];
    view.setText("world");
    view.setScrollMetrics(0, 20);
    view.setTokens(tokens);

    const addCount = highlightAdds;
    const deleteCount = highlightDeletes;
    highlightClears = 0;
    view.setTokens([{ start: 0, end: 5, style: { color: "#ff0000" } }]);

    expect(highlightClears).toBe(0);
    expect(highlightAdds).toBe(addCount);
    expect(highlightDeletes).toBe(deleteCount);
  });

  it("treats empty token style fields as unchanged", () => {
    view.setText("world");
    view.setScrollMetrics(0, 20);
    view.setTokens([{ start: 0, end: 5, style: { color: "#ff0000", textDecoration: "" } }]);

    const addCount = highlightAdds;
    const deleteCount = highlightDeletes;
    highlightClears = 0;
    view.setTokens([{ start: 0, end: 5, style: { color: "#ff0000" } }]);

    expect(highlightClears).toBe(0);
    expect(highlightAdds).toBe(addCount);
    expect(highlightDeletes).toBe(deleteCount);
  });

  it("keeps token highlight registry entries stable while scrolling recycled rows", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line-${index}`);
    const offsets = lineStartOffsets(lines);
    view.setText(lines.join("\n"));
    view.setScrollMetrics(0, 100);
    view.setTokens([
      { start: offsets[0]!, end: offsets[0]! + 4, style: { color: "#ff0000" } },
      { start: offsets[7]!, end: offsets[7]! + 4, style: { color: "#ff0000" } },
    ]);

    const tokenHighlightName = tokenHighlightNames()[0];
    const tokenHighlight = highlightsMap.get(tokenHighlightName!);
    const recycledElement = container.querySelector(
      '[data-editor-virtual-row="0"]',
    ) as HTMLDivElement;
    const styleText = document.head.querySelector("style")?.textContent;
    const setCount = registrySets;
    const deleteCount = registryDeletes;

    view.setScrollMetrics(60, 100);

    const rowSeven = view.getState().mountedRows.find((row) => row.index === 7);
    const ranges = [...tokenHighlight!];
    expect(highlightsMap.get(tokenHighlightName!)).toBe(tokenHighlight);
    expect(document.head.querySelector("style")?.textContent).toBe(styleText);
    expect(registrySets).toBe(setCount);
    expect(registryDeletes).toBe(deleteCount);
    expect(rowSeven?.element).toBe(recycledElement);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.startContainer).toBe(rowSeven?.textNode);
    expect(ranges[0]!.startOffset).toBe(0);
    expect(ranges[0]!.endOffset).toBe(4);
  });

  it("does not create token groups while scrolling to a newly visible style", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line-${index}`);
    const offsets = lineStartOffsets(lines);
    view.setText(lines.join("\n"));
    view.setScrollMetrics(0, 100);
    view.setTokens([
      { start: offsets[0]!, end: offsets[0]! + 4, style: { color: "#ff0000" } },
      { start: offsets[7]!, end: offsets[7]! + 4, style: { color: "#00ff00" } },
    ]);

    const styleText = document.head.querySelector("style")?.textContent;
    const setCount = registrySets;
    view.setScrollMetrics(60, 100);

    const rowSeven = view.getState().mountedRows.find((row) => row.index === 7);
    const rowSevenRange = tokenHighlightRangeForNode(rowSeven!.textNode);
    expect(rowSevenRange).toBeDefined();
    expect(registrySets).toBe(setCount);
    expect(document.head.querySelector("style")?.textContent).toBe(styleText);
  });

  it("keeps a registered selection highlight stable while scrolling offscreen and back", () => {
    view.setText(createLines(40));
    view.setScrollMetrics(0, 100);
    view.setSelection(0, 4);

    const selectionHighlight = highlightsMap.get("test-selection");
    const setCount = registrySets;
    const deleteCount = registryDeletes;
    expect(selectionHighlight?.size).toBe(1);

    view.setScrollMetrics(400, 100);

    expect(highlightsMap.get("test-selection")).toBe(selectionHighlight);
    expect(selectionHighlight?.size).toBe(0);
    expect(registrySets).toBe(setCount);
    expect(registryDeletes).toBe(deleteCount);

    view.setScrollMetrics(0, 100);

    expect(highlightsMap.get("test-selection")).toBe(selectionHighlight);
    expect(selectionHighlight?.size).toBe(1);
    expect(registrySets).toBe(setCount);
    expect(registryDeletes).toBe(deleteCount);
  });

  it("uses FoldMap to mount folded virtual rows without changing buffer offsets", () => {
    view.dispose();
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 2,
      highlightRegistry: mockRegistry,
      selectionHighlightName: "test-selection",
      gutterContributions: [createLineGutterContribution()],
    });
    const text = "a\nb\nc\nd";
    const snapshot = createPieceTableSnapshot(text);
    const map = createFoldMap(snapshot, [
      { startIndex: 2, endIndex: 4, startLine: 1, endLine: 2, type: "block" },
    ]);

    view.setText(text);
    view.setFoldMap(map);
    view.setScrollMetrics(0, 80);

    const rows = view.getState().mountedRows;
    expect(view.getState().foldMapActive).toBe(true);
    expect(view.getState().totalHeight).toBe(60);
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2]);
    expect(rows.map((row) => row.bufferRow)).toEqual([0, 1, 3]);
    expect(rows.map((row) => row.text)).toEqual(["a", "b", "d"]);
    expect(
      [...container.querySelectorAll<HTMLSpanElement>(".editor-virtualized-line-number")].map(
        (label) => label.style.counterSet,
      ),
    ).toEqual(["editor-line 1", "editor-line 2", "editor-line 4"]);

    const hiddenOffsetRange = view.createRange(4, 4);
    expect(hiddenOffsetRange?.startContainer).toBe(rows[1]!.textNode);
    expect(hiddenOffsetRange?.startOffset).toBe(1);
  });

  it("renders fold controls from a large indexed marker set", () => {
    const lines = Array.from({ length: 2_000 }, (_, index) => `line ${index}`);
    view.setText(lines.join("\n"));
    view.setFoldMarkers(createEveryOtherFoldMarkers(lines, 1_000));
    view.setScrollMetrics(400 * 20, 100);

    expect(container.querySelector(".editor-virtualized-fold-toggle")).toBeNull();

    view.dispose();
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 2,
      highlightRegistry: mockRegistry,
      selectionHighlightName: "test-selection",
      gutterContributions: [createFoldGutterContribution()],
    });
    view.setText(lines.join("\n"));
    view.setFoldMarkers(createEveryOtherFoldMarkers(lines, 1_000));
    view.setScrollMetrics(400 * 20, 100);

    const gutterRow = container.querySelector<HTMLDivElement>(
      '[data-editor-virtual-gutter-row="400"]',
    );
    const button = gutterRow?.querySelector<HTMLButtonElement>(".editor-virtualized-fold-toggle");

    expect(button).toBeDefined();
    expect(button?.hidden).toBe(false);
    expect(button?.dataset.editorFoldKey).toBe("fold-400");
  });

  it("renders legacy fold indicators inside the fold icon element", () => {
    view.dispose();
    view = createFoldGutterTestView(
      container,
      createFoldGutterContribution({ expandedIndicator: "open", collapsedIndicator: "closed" }),
    );

    mountFoldMarker(view, createSingleFoldMarker({ collapsed: false }));

    expect(visibleFoldButton(container).dataset.editorFoldIndicator).toBe("open");
    expect(foldIconElement(container).textContent).toBe("open");

    view.setFoldMarkers([createSingleFoldMarker({ collapsed: true })]);

    expect(visibleFoldButton(container).dataset.editorFoldIndicator).toBe("closed");
    expect(foldIconElement(container).textContent).toBe("closed");
  });

  it("keeps shared fold icons mounted across state changes for CSS rotation", () => {
    const iconFactory = vi.fn(({ document }: { readonly document: Document }) => {
      const icon = document.createElement("span");
      icon.dataset.testFoldIcon = "shared";
      icon.textContent = ">";
      return icon;
    });

    view.dispose();
    view = createFoldGutterTestView(container, createFoldGutterContribution({ icon: iconFactory }));
    mountFoldMarker(view, createSingleFoldMarker({ collapsed: false }));

    const firstIcon = foldIconElement(container);
    const firstCustomIcon = firstIcon.querySelector("[data-test-fold-icon='shared']");
    view.setFoldMarkers([createSingleFoldMarker({ collapsed: true })]);

    const button = visibleFoldButton(container);
    expect(iconFactory).toHaveBeenCalledTimes(1);
    expect(foldIconElement(container)).toBe(firstIcon);
    expect(firstIcon.querySelector("[data-test-fold-icon='shared']")).toBe(firstCustomIcon);
    expect(button.dataset.editorFoldState).toBe("collapsed");
    expect(button.dataset.editorFoldTransition).toBe("collapse");
  });

  it("lets state-specific fold icons override a shared icon", () => {
    view.dispose();
    view = createFoldGutterTestView(
      container,
      createFoldGutterContribution({
        icon: "shared",
        expandedIcon: "expanded",
        collapsedIcon: "collapsed",
      }),
    );

    mountFoldMarker(view, createSingleFoldMarker({ collapsed: false }));

    expect(foldIconElement(container).textContent).toBe("expanded");

    view.setFoldMarkers([createSingleFoldMarker({ collapsed: true })]);

    expect(foldIconElement(container).textContent).toBe("collapsed");
  });

  it("renders DOM factory fold icons without parsing string icons as HTML", () => {
    view.dispose();
    view = createFoldGutterTestView(
      container,
      createFoldGutterContribution({
        icon: ({ document }) => document.createElementNS("http://www.w3.org/2000/svg", "svg"),
      }),
    );
    mountFoldMarker(view);

    expect(foldIconElement(container).querySelector("svg")).not.toBeNull();

    view.dispose();
    view = createFoldGutterTestView(
      container,
      createFoldGutterContribution({ icon: "<svg><path /></svg>" }),
    );
    mountFoldMarker(view);

    expect(foldIconElement(container).textContent).toBe("<svg><path /></svg>");
    expect(foldIconElement(container).querySelector("svg")).toBeNull();
  });

  it("applies user fold icon class names", () => {
    view.dispose();
    view = createFoldGutterTestView(
      container,
      createFoldGutterContribution({
        icon: ">",
        buttonClassName: "custom-fold-button custom-fold-trigger",
        iconClassName: "custom-fold-icon",
      }),
    );
    mountFoldMarker(view);

    const button = visibleFoldButton(container);
    expect(button.classList.contains("custom-fold-button")).toBe(true);
    expect(button.classList.contains("custom-fold-trigger")).toBe(true);
    expect(foldIconElement(container).classList.contains("custom-fold-icon")).toBe(true);
  });

  it("sets fold transition hooks only for same-marker state changes", () => {
    view.dispose();
    view = createFoldGutterTestView(container, createFoldGutterContribution({ icon: ">" }));
    mountFoldMarker(view, createSingleFoldMarker({ key: "fold-a", collapsed: false }));

    expect(visibleFoldButton(container).dataset.editorFoldTransition).toBeUndefined();

    view.setFoldMarkers([createSingleFoldMarker({ key: "fold-b", collapsed: false })]);

    expect(visibleFoldButton(container).dataset.editorFoldTransition).toBeUndefined();

    view.setFoldMarkers([createSingleFoldMarker({ key: "fold-b", collapsed: true })]);

    const button = visibleFoldButton(container);
    expect(button.dataset.editorFoldTransition).toBe("collapse");

    button.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(button.dataset.editorFoldTransition).toBeUndefined();

    view.setFoldMarkers([createSingleFoldMarker({ key: "fold-b", collapsed: false })]);

    expect(button.dataset.editorFoldTransition).toBe("expand");

    button.dispatchEvent(new Event("animationcancel", { bubbles: true }));
    expect(button.dataset.editorFoldTransition).toBeUndefined();
  });

  it("validates native geometry ranges over mounted rows", () => {
    view.setText("abc\ndef");
    view.setScrollMetrics(0, 40);

    expect(view.validateMountedNativeGeometry()).toMatchObject({
      caretChecks: 2,
      selectionChecks: 2,
      failures: [],
      ok: true,
    });
  });

  it("measures browser row and character metrics from a DOM probe", () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.classList.contains("editor-virtualized-metric-probe")) {
        return mockRect(0, 0, 160, 24);
      }

      return original.call(this);
    };

    const metrics = measureBrowserTextMetrics(container);
    HTMLElement.prototype.getBoundingClientRect = original;

    expect(metrics.rowHeight).toBe(24);
    expect(metrics.characterWidth).toBe(10);
  });
});

function createLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");
}

function createFoldGutterTestView(
  container: HTMLElement,
  contribution: ReturnType<typeof createFoldGutterContribution>,
): VirtualizedTextView {
  return new VirtualizedTextView(container, {
    rowHeight: 20,
    overscan: 2,
    highlightRegistry: mockRegistry,
    selectionHighlightName: "test-selection",
    gutterContributions: [contribution],
  });
}

function mountFoldMarker(
  view: VirtualizedTextView,
  marker: VirtualizedFoldMarker = createSingleFoldMarker(),
): void {
  view.setText("line 0\nline 1\nline 2");
  view.setFoldMarkers([marker]);
  view.setScrollMetrics(0, 80);
}

function createSingleFoldMarker(
  options: { readonly key?: string; readonly collapsed?: boolean } = {},
): VirtualizedFoldMarker {
  return {
    key: options.key ?? "fold-0",
    startOffset: 0,
    endOffset: 13,
    startRow: 0,
    endRow: 1,
    collapsed: options.collapsed ?? false,
  };
}

function visibleFoldButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    ".editor-virtualized-fold-toggle:not([hidden])",
  );
  expect(button).not.toBeNull();
  return button!;
}

function foldIconElement(container: HTMLElement): HTMLSpanElement {
  const icon = visibleFoldButton(container).querySelector<HTMLSpanElement>(
    ".editor-virtualized-fold-icon",
  );
  expect(icon).not.toBeNull();
  return icon!;
}

function lineStartOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  return offsets;
}

function createEveryOtherFoldMarkers(
  lines: readonly string[],
  count: number,
): VirtualizedFoldMarker[] {
  const offsets = lineStartOffsets(lines);
  const markers: VirtualizedFoldMarker[] = [];
  for (let index = 0; index < count; index += 1) {
    const startRow = index * 2;
    const endRow = startRow + 1;
    markers.push({
      key: `fold-${startRow}`,
      startOffset: offsets[startRow]!,
      endOffset: offsets[endRow]!,
      startRow,
      endRow,
      collapsed: false,
    });
  }

  return markers;
}

function tokenHighlightNames(): string[] {
  return [...highlightsMap.keys()].filter((name) => name.includes("-token-"));
}

function tokenHighlightRanges(): AbstractRange[] {
  return tokenHighlightNames().flatMap((name) => [...highlightsMap.get(name)!]);
}

function tokenHighlightRangeForNode(
  node: Text,
): { readonly highlight: Highlight; readonly range: AbstractRange } | undefined {
  for (const name of tokenHighlightNames()) {
    const highlight = highlightsMap.get(name)!;
    const range = [...highlight].find((candidate) => candidate.startContainer === node);
    if (range) return { highlight, range };
  }

  return undefined;
}

function isTokenStyleSerializationInput(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;

  const keys = new Set(Object.keys(value));
  if (!keys.has("color")) return false;
  if (!keys.has("backgroundColor")) return false;
  if (!keys.has("fontStyle")) return false;
  if (!keys.has("fontWeight")) return false;
  return keys.has("textDecoration");
}

function mockViewport(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: height,
      height,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

function withThrowingScrollLeft(element: HTMLElement, callback: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(element, "scrollLeft");
  Object.defineProperty(element, "scrollLeft", {
    configurable: true,
    get: () => {
      throw new Error("unexpected horizontal scroll read");
    },
  });

  try {
    callback();
  } finally {
    restoreScrollLeft(element, descriptor);
  }
}

function withThrowingRenderLayoutReads(element: HTMLElement, callback: () => void): void {
  const clientWidth = Object.getOwnPropertyDescriptor(element, "clientWidth");
  const clientHeight = Object.getOwnPropertyDescriptor(element, "clientHeight");
  const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    get: () => {
      throw new Error("unexpected clientWidth read");
    },
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => {
      throw new Error("unexpected clientHeight read");
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function throwingGetBoundingClientRect() {
    throw new Error("unexpected layout read");
  };

  try {
    callback();
  } finally {
    restorePropertyDescriptor(element, "clientWidth", clientWidth);
    restorePropertyDescriptor(element, "clientHeight", clientHeight);
    HTMLElement.prototype.getBoundingClientRect = getBoundingClientRect;
  }
}

function restoreScrollLeft(element: HTMLElement, descriptor: PropertyDescriptor | undefined): void {
  restorePropertyDescriptor(element, "scrollLeft", descriptor);
}

function restorePropertyDescriptor(
  element: HTMLElement,
  property: "clientHeight" | "clientWidth" | "scrollLeft",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(element, property, descriptor);
    return;
  }

  Reflect.deleteProperty(element, property);
}

function mockRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function restoreRangeGetClientRects(original: Range["getClientRects"]): void {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: original,
  });
}
