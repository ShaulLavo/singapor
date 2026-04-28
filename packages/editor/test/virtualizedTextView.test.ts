import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFoldMap,
  createPieceTableSnapshot,
  measureBrowserTextMetrics,
  VirtualizedTextView,
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

  it("mounts only visible and overscanned rows for large documents", () => {
    view.setText(createLines(100_000));
    view.setScrollMetrics(0, 100);

    const rows = container.querySelectorAll("[data-editor-virtual-row]");
    const gutterRows = container.querySelectorAll("[data-editor-virtual-gutter-row]");
    expect(rows).toHaveLength(7);
    expect(gutterRows).toHaveLength(7);
    expect(view.getState()).toMatchObject({
      lineCount: 100_000,
      totalHeight: 2_000_000,
      visibleRange: { start: 0, end: 5 },
    });
  });

  it("renders gutter rows with CSS counter line numbers", () => {
    view.setText("alpha\nbeta\ngamma");
    view.setScrollMetrics(0, 80);

    const firstLabel = container.querySelector(
      '[data-editor-virtual-gutter-row="0"] .editor-virtualized-line-number',
    ) as HTMLSpanElement;

    expect(firstLabel).not.toBeNull();
    expect(firstLabel.textContent).toBe("");
    expect(firstLabel.style.counterSet).toBe("editor-line 1");
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
    mockClientWidth(view.scrollElement, 80);

    view.setText("x".repeat(5_000));
    view.setScrollMetrics(0, 20);
    const firstChunk = view.getState().mountedRows[0]?.chunks[0];

    expect(firstChunk?.localStart).toBe(0);
    expect(firstChunk?.textNode.length).toBe(1_000);
    expect(container.querySelector(".editor-virtualized-row")?.textContent?.length).toBe(1_000);

    view.scrollElement.scrollLeft = 2_400 * view.getState().metrics.characterWidth;
    view.setScrollMetrics(0, 20);
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
    });
    mockClientWidth(view.scrollElement, 76);
    mockViewport(view.scrollElement, 76, 80);

    view.setText("abcdefghij");
    view.setScrollMetrics(0, 80);

    expect(view.getState().wrapActive).toBe(true);
    expect(view.getState().totalHeight).toBe(40);
    expect(view.getState().mountedRows.map((row) => row.text)).toEqual(["abcde", "fghij"]);
    expect(view.textOffsetFromViewportPoint(100, 25)).toBe(10);
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
    mockClientWidth(view.scrollElement, 80);
    view.scrollElement.scrollLeft = 2_400 * view.getState().metrics.characterWidth;
    view.setText("x".repeat(5_000));
    view.setScrollMetrics(0, 20);

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

  it("snaps viewport fallback points outside vertical bounds to visible line edges", () => {
    view.setText("alpha\nbeta\ngamma");
    view.setScrollMetrics(0, 40);
    mockViewport(view.scrollElement, 80, 40);

    expect(view.textOffsetFromViewportPoint(8, -5)).toBe(0);
    expect(view.textOffsetFromViewportPoint(8, 45)).toBe(10);
  });

  it("maps viewport fallback points in the gutter to the line start", () => {
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
    expect(caret.style.transform).toBe("translate(52px, 0px)");
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
    mockClientWidth(view.scrollElement, 80);
    view.setText("x".repeat(5_000));
    view.setScrollMetrics(0, 20);
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

    const hiddenOffsetRange = view.createRange(4, 4);
    expect(hiddenOffsetRange?.startContainer).toBe(rows[1]!.textNode);
    expect(hiddenOffsetRange?.startOffset).toBe(1);
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

function lineStartOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  return offsets;
}

function tokenHighlightNames(): string[] {
  return [...highlightsMap.keys()].filter((name) => name.includes("-token-"));
}

function tokenHighlightRanges(): Range[] {
  return tokenHighlightNames().flatMap((name) => [...highlightsMap.get(name)!]);
}

function tokenHighlightRangeForNode(
  node: Text,
): { readonly highlight: Highlight; readonly range: Range } | undefined {
  for (const name of tokenHighlightNames()) {
    const highlight = highlightsMap.get(name)!;
    const range = [...highlight].find((candidate) => candidate.startContainer === node);
    if (range) return { highlight, range };
  }

  return undefined;
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

function mockClientWidth(element: HTMLElement, width: number): void {
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    value: width,
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

function restoreScrollLeft(element: HTMLElement, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(element, "scrollLeft", descriptor);
    return;
  }

  Reflect.deleteProperty(element, "scrollLeft");
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
