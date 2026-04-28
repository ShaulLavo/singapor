import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualizedTextView, type VirtualizedTextHighlightRegistry } from "../src";

const highlightsMap = new Map<string, Highlight>();
let registrySets = 0;
let registryDeletes = 0;
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

class MockHighlight extends Set<Range> {}

describe("VirtualizedTextView", () => {
  let container: HTMLElement;
  let view: VirtualizedTextView;

  beforeEach(() => {
    highlightsMap.clear();
    registrySets = 0;
    registryDeletes = 0;
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

  it("maps mounted DOM text boundaries back to document offsets", () => {
    view.setText("abc\ndef\nxyz");
    view.setScrollMetrics(0, 80);

    const row = view.getState().mountedRows.find((mounted) => mounted.index === 1);
    expect(row).toBeDefined();
    expect(view.textOffsetFromDomBoundary(row!.textNode, 2)).toBe(6);
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
    const setCount = registrySets;
    const deleteCount = registryDeletes;

    view.setScrollMetrics(60, 100);

    const rowSeven = view.getState().mountedRows.find((row) => row.index === 7);
    const ranges = [...tokenHighlight!];
    expect(highlightsMap.get(tokenHighlightName!)).toBe(tokenHighlight);
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
