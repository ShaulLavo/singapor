import { describe, expect, it, vi } from "vitest";
import type {
  EditorPluginContext,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewSnapshot,
  VirtualizedFoldMarker,
} from "@editor/core";
import { createScopeLinesPlugin } from "../src/index";

describe("createScopeLinesPlugin", () => {
  it("registers a view contribution factory", () => {
    const registerViewContribution = vi.fn<EditorPluginContext["registerViewContribution"]>(
      () => ({ dispose: vi.fn() }),
    );
    const plugin = createScopeLinesPlugin();

    const disposable = plugin.activate(createContext(registerViewContribution));

    expect(plugin.name).toBe("scope-lines");
    expect(disposable).toBeDefined();
    expect(registerViewContribution).toHaveBeenCalledOnce();
  });

  it("returns no contribution when disabled", () => {
    const registration = registeredProvider(createScopeLinesPlugin({ enabled: false }));

    expect(registration?.createContribution(context())).toBeNull();
  });

  it("renders mounted fold scopes and active scope state", () => {
    const registration = registeredProvider(createScopeLinesPlugin());
    const testContext = context(
      snapshot({
        selections: [{ anchorOffset: 29, headOffset: 29, startOffset: 29, endOffset: 29 }],
      }),
    );

    const contribution = registration?.createContribution(testContext);
    const lines = [...testContext.scrollElement.querySelectorAll<HTMLElement>(".editor-scope-line")];

    expect(contribution).not.toBeNull();
    expect(lines).toHaveLength(2);
    expect(lines[0]?.style.left).toBe("0px");
    expect(lines[0]?.style.top).toBe("21px");
    expect(lines[0]?.style.height).toBe("56px");
    expect(lines[0]?.dataset.editorScopeLineLevel).toBe("1");
    expect(lines[0]?.classList.contains("editor-scope-line-active")).toBe(true);
    expect(lines[1]?.style.left).toBe("16px");
    expect(lines[1]?.style.top).toBe("41px");
    expect(lines[1]?.style.height).toBe("16px");
    expect(lines[1]?.dataset.editorScopeLineLevel).toBe("2");
    expect(lines[1]?.classList.contains("editor-scope-line-active")).toBe(true);

    contribution?.dispose();
    expect(testContext.scrollElement.querySelector(".editor-scope-lines")).toBeNull();
  });

  it("skips collapsed scopes", () => {
    const registration = registeredProvider(createScopeLinesPlugin());
    const marker = foldMarkers()[0]!;
    const testContext = context(
      snapshot({
        foldMarkers: [{ ...marker, collapsed: true }],
      }),
    );

    registration?.createContribution(testContext);

    expect(testContext.scrollElement.querySelectorAll(".editor-scope-line")).toHaveLength(0);
  });

  it("updates active scope after selection changes", () => {
    const registration = registeredProvider(createScopeLinesPlugin());
    const inactive = snapshot({
      selections: [{ anchorOffset: 0, headOffset: 0, startOffset: 0, endOffset: 0 }],
    });
    const testContext = context(inactive);
    const contribution = registration?.createContribution(testContext);

    expect(testContext.scrollElement.querySelector(".editor-scope-line-active")).toBeNull();

    contribution?.update(
      snapshot({
        selections: [{ anchorOffset: 29, headOffset: 29, startOffset: 29, endOffset: 29 }],
      }),
      "selection",
    );

    expect(testContext.scrollElement.querySelectorAll(".editor-scope-line-active")).toHaveLength(2);
  });
});

function registeredProvider(plugin: ReturnType<typeof createScopeLinesPlugin>) {
  let registration: EditorViewContributionProvider | undefined;
  plugin.activate(
    createContext((provider) => {
      registration = provider;
      return { dispose: vi.fn() };
    }),
  );
  return registration;
}

function createContext(
  registerViewContribution: EditorPluginContext["registerViewContribution"],
): EditorPluginContext {
  return {
    registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
    registerSyntaxProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerViewContribution,
    registerEditorFeatureContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

function context(viewSnapshot = snapshot()): EditorViewContributionContext {
  const container = document.createElement("div");
  const scrollElement = document.createElement("div");
  container.appendChild(scrollElement);
  return {
    container,
    scrollElement,
    getSnapshot: () => viewSnapshot,
    reserveOverlayWidth: vi.fn(),
    revealLine: vi.fn(),
    focusEditor: vi.fn(),
    setSelection: vi.fn(),
    setScrollTop: vi.fn(),
    textOffsetFromPoint: vi.fn(() => null),
    getRangeClientRect: vi.fn(() => null),
  };
}

function snapshot(overrides: Partial<EditorViewSnapshot> = {}): EditorViewSnapshot {
  const text = "function f() {\n  if (x) {\n    y()\n  }\n}\n";
  return {
    documentId: "scope-test",
    languageId: "typescript",
    text,
    textVersion: 1,
    lineStarts: lineStarts(text),
    tokens: [],
    selections: [],
    metrics: { rowHeight: 20, characterWidth: 8 },
    lineCount: 6,
    contentWidth: 160,
    totalHeight: 120,
    tabSize: 2,
    foldMarkers: foldMarkers(),
    visibleRows: visibleRows(text),
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 120,
      scrollWidth: 160,
      clientHeight: 80,
      clientWidth: 120,
      borderBoxHeight: 80,
      borderBoxWidth: 120,
      visibleRange: { start: 0, end: 6 },
    },
    ...overrides,
  };
}

function foldMarkers(): readonly VirtualizedFoldMarker[] {
  return [
    {
      key: "function:0:40",
      startOffset: 0,
      endOffset: 40,
      startRow: 0,
      endRow: 4,
      collapsed: false,
    },
    {
      key: "if:15:38",
      startOffset: 15,
      endOffset: 38,
      startRow: 1,
      endRow: 3,
      collapsed: false,
    },
  ];
}

function visibleRows(text: string): EditorViewSnapshot["visibleRows"] {
  const starts = lineStarts(text);
  return starts.map((start, index) => {
    const nextStart = starts[index + 1] ?? text.length + 1;
    const end = Math.max(start, Math.min(text.length, nextStart - 1));
    return {
      index,
      bufferRow: index,
      startOffset: start,
      endOffset: end,
      text: text.slice(start, end),
      kind: "text",
      primaryText: true,
      top: index * 20,
      height: 20,
    };
  });
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}
