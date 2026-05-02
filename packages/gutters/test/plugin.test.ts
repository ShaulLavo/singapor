import { describe, expect, it, vi } from "vitest";
import type { EditorPluginContext } from "@editor/core";
import {
  createFoldGutterContribution,
  createFoldGutterPlugin,
  createLineGutterContribution,
  createLineGutterPlugin,
} from "../src/index";

describe("gutter plugins", () => {
  it("registers the line gutter contribution", () => {
    const registerGutterContribution = vi.fn<EditorPluginContext["registerGutterContribution"]>(
      () => ({ dispose: vi.fn() }),
    );
    const plugin = createLineGutterPlugin();

    const disposable = plugin.activate(createContext(registerGutterContribution));

    expect(plugin.name).toBe("line-gutter");
    expect(disposable).toBeDefined();
    expect(registerGutterContribution).toHaveBeenCalledOnce();
    expect(registerGutterContribution.mock.calls[0]?.[0].id).toBe("line-gutter");
  });

  it("registers the fold gutter contribution", () => {
    const registerGutterContribution = vi.fn<EditorPluginContext["registerGutterContribution"]>(
      () => ({ dispose: vi.fn() }),
    );
    const plugin = createFoldGutterPlugin();

    const disposable = plugin.activate(createContext(registerGutterContribution));

    expect(plugin.name).toBe("fold-gutter");
    expect(disposable).toBeDefined();
    expect(registerGutterContribution).toHaveBeenCalledOnce();
    expect(registerGutterContribution.mock.calls[0]?.[0].id).toBe("fold-gutter");
  });

  it("updates line gutter cells with CSS counters", () => {
    const contribution = createLineGutterContribution({ counterStyle: "decimal-leading-zero" });
    const cell = contribution.createCell(document);

    contribution.updateCell(cell, {
      index: 0,
      bufferRow: 4,
      startOffset: 0,
      endOffset: 0,
      text: "",
      kind: "text",
      primaryText: true,
      cursorLine: true,
      cursorLineHighlight: {
        gutterBackground: true,
        gutterNumber: true,
        rowBackground: true,
      },
      foldMarker: null,
      lineCount: 10,
      toggleFold: vi.fn(),
    });

    expect(cell.style.counterSet).toBe("editor-line 5");
    expect(cell.style.getPropertyValue("--editor-line-gutter-counter-style")).toBe(
      "decimal-leading-zero",
    );
    expect(cell.classList.contains("editor-virtualized-line-number-active")).toBe(true);
  });

  it("renders fold gutter icons from DOM factories", () => {
    const contribution = createFoldGutterContribution({
      icon: ({ document }) => {
        const icon = document.createElement("span");
        icon.dataset.testFoldIcon = "custom";
        return icon;
      },
    });
    const cell = contribution.createCell(document);
    const toggleFold = vi.fn();

    contribution.updateCell(cell, {
      index: 0,
      bufferRow: 0,
      startOffset: 0,
      endOffset: 0,
      text: "",
      kind: "text",
      primaryText: true,
      cursorLine: false,
      cursorLineHighlight: {
        gutterBackground: true,
        gutterNumber: false,
        rowBackground: true,
      },
      foldMarker: {
        key: "fold-0",
        startRow: 0,
        endRow: 3,
        startOffset: 0,
        endOffset: 12,
        collapsed: false,
      },
      lineCount: 4,
      toggleFold,
    });

    expect(cell.hidden).toBe(false);
    expect(cell.dataset.editorFoldKey).toBe("fold-0");
    expect(cell.querySelector("[data-test-fold-icon='custom']")).not.toBeNull();
    cell.click();
    expect(toggleFold).toHaveBeenCalledOnce();
  });
});

function createContext(
  registerGutterContribution: EditorPluginContext["registerGutterContribution"],
): EditorPluginContext {
  return {
    registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
    registerSyntaxProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerViewContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerEditorFeatureContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerGutterContribution,
  };
}
