import { describe, expect, it, vi } from "vitest";
import type {
  EditorPluginContext,
  EditorViewContributionProvider,
  EditorViewContributionContext,
  EditorViewSnapshot,
} from "@editor/core";
import { createMinimapPlugin } from "../src/plugin";

describe("createMinimapPlugin", () => {
  it("registers a view contribution factory", () => {
    const registerViewContribution = vi.fn<EditorPluginContext["registerViewContribution"]>(() => ({
      dispose: vi.fn(),
    }));
    const plugin = createMinimapPlugin({ enabled: false });

    const disposable = plugin.activate({
      registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
      registerViewContribution,
    });

    expect(plugin.name).toBe("minimap");
    expect(disposable).toBeDefined();
    expect(registerViewContribution).toHaveBeenCalledOnce();
  });

  it("returns no contribution when disabled", () => {
    let registration: EditorViewContributionProvider | undefined;
    const registerViewContribution: EditorPluginContext["registerViewContribution"] = (
      provider,
    ) => {
      registration = provider;
      return { dispose: vi.fn() };
    };
    const plugin = createMinimapPlugin({ enabled: false });

    plugin.activate({
      registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
      registerViewContribution,
    });

    expect(registration?.createContribution(context())).toBeNull();
  });
});

function context(): EditorViewContributionContext {
  const container = document.createElement("div");
  const scrollElement = document.createElement("div");
  container.appendChild(scrollElement);
  return {
    container,
    scrollElement,
    getSnapshot: () => snapshot(),
    reserveOverlayWidth: vi.fn(),
    revealLine: vi.fn(),
    setScrollTop: vi.fn(),
  };
}

function snapshot(): EditorViewSnapshot {
  return {
    documentId: "minimap-test",
    languageId: "typescript",
    text: "",
    textVersion: 1,
    lineStarts: [0],
    tokens: [],
    selections: [],
    metrics: { rowHeight: 20, characterWidth: 8 },
    lineCount: 1,
    contentWidth: 0,
    totalHeight: 20,
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 20,
      scrollWidth: 0,
      clientHeight: 20,
      clientWidth: 80,
      visibleRange: { start: 0, end: 1 },
    },
  };
}
