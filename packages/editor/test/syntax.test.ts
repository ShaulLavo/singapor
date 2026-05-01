import { describe, expect, expectTypeOf, it } from "vitest";

import {
  applyBatchToPieceTable,
  createPieceTableSnapshot,
  createTreeSitterLanguagePlugin,
  EditorPluginHost,
  TreeSitterLanguageRegistry,
  type TreeSitterLanguageContribution,
} from "../src";
import {
  resolveTreeSitterLanguageAlias,
  resolveTreeSitterLanguageContribution,
  styleForTreeSitterCapture,
  treeSitterCapturesToEditorTokens,
} from "../src/syntax";
import { createTextDiffEdit, createTreeSitterEditPayload } from "../src/syntax/session";
import { createTreeSitterSourceDescriptor } from "../src/syntax/treeSitter/source";
import type { TreeSitterEditRequest, TreeSitterParseRequest } from "../src/syntax/treeSitter/types";

describe("Tree-sitter syntax capture conversion", () => {
  it("maps known capture names to editor token styles", () => {
    expect(styleForTreeSitterCapture("keyword.declaration")).toEqual({
      color: "var(--editor-syntax-keyword-declaration)",
    });
    expect(styleForTreeSitterCapture("string")).toEqual({
      color: "var(--editor-syntax-string)",
    });
    expect(styleForTreeSitterCapture("text.title")).toEqual({
      color: "var(--editor-syntax-keyword-declaration)",
      fontWeight: 700,
    });
    expect(styleForTreeSitterCapture("text.uri")).toEqual({
      color: "var(--editor-syntax-string)",
      textDecoration: "underline",
    });
    expect(styleForTreeSitterCapture("unknown.scope")).toBeNull();
  });

  it("resolves registered aliases and descriptors", async () => {
    const registry = createTestLanguageRegistry();
    const descriptor = await registry.resolveTreeSitterLanguage("ts");

    expect(descriptor).toMatchObject({
      id: "typescript",
      wasmUrl: "/typescript.wasm",
      extensions: [".ts", ".cts", ".mts", ".tsx"],
      aliases: ["typescript", "ts", "tsx"],
      highlightQuerySource: "(identifier) @variable",
    });
    expect(resolveTreeSitterLanguageAlias("js", registry)).toBe("javascript");
    expect(resolveTreeSitterLanguageAlias("css", registry)).toBeNull();
    expect(resolveTreeSitterLanguageAlias("sql", registry)).toBeNull();
  });

  it("supports async language asset loaders", async () => {
    const descriptor = await resolveTreeSitterLanguageContribution({
      id: "rust",
      extensions: ["rs"],
      aliases: ["rust"],
      load: async () => ({
        wasmUrl: "/rust.wasm",
        highlightQuerySource: "(identifier) @variable",
      }),
    });

    expect(descriptor).toMatchObject({
      id: "rust",
      extensions: [".rs"],
      aliases: ["rust"],
      wasmUrl: "/rust.wasm",
    });
  });

  it("rejects duplicate language ids unless replacement is explicit", async () => {
    const registry = new TreeSitterLanguageRegistry();
    const original = registry.registerLanguage(testLanguage("typescript", [".ts"]));

    expect(() => registry.registerLanguage(testLanguage("typescript", [".tsx"]))).toThrow(
      /already registered/,
    );

    const replacement = registry.registerLanguage(testLanguage("typescript", [".mts"]), {
      replace: true,
    });
    await expect(registry.resolveTreeSitterLanguage("typescript")).resolves.toMatchObject({
      extensions: [".mts"],
    });

    replacement.dispose();
    await expect(registry.resolveTreeSitterLanguage("typescript")).resolves.toMatchObject({
      extensions: [".ts"],
    });

    original.dispose();
    await expect(registry.resolveTreeSitterLanguage("typescript")).resolves.toBeNull();
  });

  it("registers language contributions through editor plugins", async () => {
    const host = new EditorPluginHost([
      createTreeSitterLanguagePlugin([testLanguage("sql", [".sql"])], { name: "sql-language" }),
    ]);

    await expect(host.resolveTreeSitterLanguage("sql")).resolves.toMatchObject({
      id: "sql",
      wasmUrl: "/sql.wasm",
    });
    host.dispose();
    await expect(host.resolveTreeSitterLanguage("sql")).resolves.toBeNull();
  });

  it("converts non-empty captures to editor tokens", () => {
    const tokens = treeSitterCapturesToEditorTokens([
      { startIndex: 0, endIndex: 5, captureName: "keyword.declaration" },
      { startIndex: 6, endIndex: 6, captureName: "string" },
      { startIndex: 7, endIndex: 10, captureName: "not.mapped" },
    ]);

    expect(tokens).toEqual([
      {
        start: 0,
        end: 5,
        style: { color: "var(--editor-syntax-keyword-declaration)" },
      },
    ]);
  });

  it("builds single-edit payloads for incremental reparsing", () => {
    const previousSnapshot = createPieceTableSnapshot("const a = 1;\n");
    const edits = [{ from: 6, to: 7, text: "answer" }];
    const nextSnapshot = applyBatchToPieceTable(previousSnapshot, edits);
    const payload = createTreeSitterEditPayload({
      documentId: "file.ts",
      languageId: "typescript",
      snapshotVersion: 2,
      previousSnapshot,
      nextSnapshot,
      edits,
    });

    expect(payload).toMatchObject({
      documentId: "file.ts",
      snapshotVersion: 2,
      languageId: "typescript",
      inputEdits: [
        {
          startIndex: 6,
          oldEndIndex: 7,
          newEndIndex: 12,
          startPosition: { row: 0, column: 6 },
          oldEndPosition: { row: 0, column: 7 },
          newEndPosition: { row: 0, column: 12 },
        },
      ],
    });
  });

  it("keeps worker parse and edit requests source-based", () => {
    const snapshot = createPieceTableSnapshot("const a = 1;\n");
    const source = createTreeSitterSourceDescriptor(snapshot, { useSharedBuffers: false });
    const parseRequest: TreeSitterParseRequest = {
      type: "parse",
      documentId: "file.ts",
      snapshotVersion: 1,
      languageId: "typescript",
      includeHighlights: true,
      source,
      generation: 1,
    };
    const editRequest: TreeSitterEditRequest = {
      type: "edit",
      documentId: "file.ts",
      snapshotVersion: 2,
      languageId: "typescript",
      includeHighlights: true,
      source,
      edits: [],
      inputEdits: [],
      generation: 2,
    };

    expect("source" in parseRequest).toBe(true);
    expect("snapshot" in parseRequest).toBe(false);
    expect("text" in parseRequest).toBe(false);
    expect("source" in editRequest).toBe(true);
    expect("snapshot" in editRequest).toBe(false);
    expect("text" in editRequest).toBe(false);
    expectTypeOf<"snapshot">().not.toMatchTypeOf<keyof TreeSitterParseRequest>();
    expectTypeOf<"text">().not.toMatchTypeOf<keyof TreeSitterParseRequest>();
    expectTypeOf<"snapshot">().not.toMatchTypeOf<keyof TreeSitterEditRequest>();
    expectTypeOf<"text">().not.toMatchTypeOf<keyof TreeSitterEditRequest>();
  });

  it("builds incremental payloads for multi-edits", () => {
    const previousSnapshot = createPieceTableSnapshot("ab\ncd");
    const edits = [
      { from: 0, to: 1, text: "x" },
      { from: 3, to: 5, text: "yz" },
    ];
    const nextSnapshot = applyBatchToPieceTable(previousSnapshot, edits);
    const payload = createTreeSitterEditPayload({
      documentId: "file.ts",
      languageId: "typescript",
      snapshotVersion: 2,
      previousSnapshot,
      nextSnapshot,
      edits,
    });

    expect(payload?.inputEdits).toMatchObject([
      {
        startIndex: 3,
        oldEndIndex: 5,
        newEndIndex: 5,
        startPosition: { row: 1, column: 0 },
        oldEndPosition: { row: 1, column: 2 },
        newEndPosition: { row: 1, column: 2 },
      },
      {
        startIndex: 0,
        oldEndIndex: 1,
        newEndIndex: 1,
        startPosition: { row: 0, column: 0 },
        oldEndPosition: { row: 0, column: 1 },
        newEndPosition: { row: 0, column: 1 },
      },
    ]);
  });

  it("diffs skipped typing edits against the cached syntax text", () => {
    const previousText = "const a = 1;";
    const nextText = "const a = 1;!?";
    const previousSnapshot = createPieceTableSnapshot(previousText);
    const nextSnapshot = createPieceTableSnapshot(nextText);
    const edit = createTextDiffEdit(previousText, nextText);

    expect(edit).toEqual({ from: 12, to: 12, text: "!?" });

    const payload = createTreeSitterEditPayload({
      documentId: "file.ts",
      languageId: "typescript",
      snapshotVersion: 2,
      previousSnapshot,
      nextSnapshot,
      edits: edit ? [edit] : [],
    });

    expect(payload?.inputEdits).toMatchObject([
      {
        startIndex: 12,
        oldEndIndex: 12,
        newEndIndex: 14,
        startPosition: { row: 0, column: 12 },
        oldEndPosition: { row: 0, column: 12 },
        newEndPosition: { row: 0, column: 14 },
      },
    ]);
  });
});

function createTestLanguageRegistry(): TreeSitterLanguageRegistry {
  const registry = new TreeSitterLanguageRegistry();
  registry.registerLanguage(
    testLanguage("javascript", [".js", ".cjs", ".jsx", ".mjs"], ["javascript", "js", "jsx"]),
  );
  registry.registerLanguage(
    testLanguage("typescript", [".ts", ".cts", ".mts", ".tsx"], ["typescript", "ts", "tsx"]),
  );
  return registry;
}

function testLanguage(
  id: string,
  extensions: readonly string[],
  aliases: readonly string[] = [id],
): TreeSitterLanguageContribution {
  return {
    id,
    extensions,
    aliases,
    wasmUrl: `/${id}.wasm`,
    highlightQuerySource: "(identifier) @variable",
  };
}
