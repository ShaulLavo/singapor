import { describe, expect, it, vi } from "vitest";

import { createPieceTableSnapshot, type EditorPluginContext } from "@editor/core";
import {
  TREE_SITTER_LANGUAGE_CONTRIBUTIONS,
  css,
  html,
  javaScript,
  json,
  markdown,
  typeScript,
} from "../src";

describe("Tree-sitter language contributions", () => {
  it("exports the first-party language descriptors", () => {
    expect(TREE_SITTER_LANGUAGE_CONTRIBUTIONS.map((contribution) => contribution.id)).toEqual([
      "javascript",
      "typescript",
      "html",
      "css",
      "json",
      "markdown",
      "markdown_inline",
    ]);
    expect(TREE_SITTER_LANGUAGE_CONTRIBUTIONS.every((contribution) => "load" in contribution)).toBe(
      true,
    );
  });

  it("exports one configurable plugin per language", () => {
    const plugins = [
      javaScript({ jsx: true }),
      typeScript({ replace: true, tsx: true }),
      html(),
      css(),
      json(),
      markdown(),
    ];
    const context = pluginContext();
    const registerSyntaxProvider = vi.mocked(context.registerSyntaxProvider);

    for (const plugin of plugins) plugin.activate(context);

    expect(plugins.map((plugin) => plugin.name)).toEqual([
      "tree-sitter-javascript",
      "tree-sitter-typescript",
      "tree-sitter-html",
      "tree-sitter-css",
      "tree-sitter-json",
      "tree-sitter-markdown",
    ]);
    expect(registerSyntaxProvider).toHaveBeenCalledTimes(1);
    expect(registerSyntaxProvider).toHaveBeenCalledWith(
      expect.objectContaining({ createSession: expect.any(Function) }),
    );
    expect(
      registerSyntaxProvider.mock.calls[0]?.[0].createSession({
        documentId: "main.ts",
        languageId: "typescript",
        includeHighlights: true,
        text: "const a = 1;",
        snapshot: createPieceTableSnapshot("const a = 1;"),
      }),
    ).not.toBeNull();
  });
});

function pluginContext(): EditorPluginContext {
  return {
    registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
    registerSyntaxProvider: vi.fn<EditorPluginContext["registerSyntaxProvider"]>(() => ({
      dispose: vi.fn(),
    })),
    registerViewContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerEditorFeatureContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
  };
}
