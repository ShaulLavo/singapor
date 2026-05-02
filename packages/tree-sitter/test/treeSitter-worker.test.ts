import { describe, expect, it } from "vitest";
import type { Node } from "web-tree-sitter";

import {
  applyBatchToPieceTable,
  createPieceTableSnapshot,
  getPieceTableText,
  insertIntoPieceTable,
} from "@editor/core";
import {
  createTreeSitterSourceDescriptor,
  readTreeSitterInputRange,
  resolveTreeSitterSourceDescriptor,
  type TreeSitterSourceCache,
} from "../src/treeSitter/source.ts";
import { __treeSitterWorkerInternalsForTests } from "../src/treeSitter/treeSitter.worker.ts";

const {
  applyTextEdit,
  applyTextEdits,
  collectBracket,
  collectError,
  readTreeSitterPieceTableInput,
} = __treeSitterWorkerInternalsForTests;

describe("tree-sitter worker internals", () => {
  it("applies text edits by replacing the old range", () => {
    expect(applyTextEdit("const a = 1;", 6, 7, "answer")).toBe("const answer = 1;");
    expect(applyTextEdit("abcdef", 2, 4, "")).toBe("abef");
    expect(applyTextEdit("abef", 2, 2, "cd")).toBe("abcdef");
  });

  it("applies batch text edits from the original offsets", () => {
    expect(
      applyTextEdits("ab\ncd", [
        { from: 0, to: 1, text: "x" },
        { from: 3, to: 5, text: "yz" },
      ]),
    ).toBe("xb\nyz");
  });

  it("reads parser input from piece-table chunks without flattening", () => {
    const snapshot = insertIntoPieceTable(createPieceTableSnapshot("a😀\n"), 4, "tail");
    const descriptor = createTreeSitterSourceDescriptor(snapshot, { useSharedBuffers: false });
    const input = resolveTreeSitterSourceDescriptor(new Map(), "doc", descriptor);

    expect(input.chunks.length).toBeGreaterThan(1);
    expect(readTreeSitterPieceTableInput(input, 0)).toBe("a😀\n");
    expect(readTreeSitterPieceTableInput(input, 4)).toBe("tail");
    expect(readTreeSitterPieceTableInput(input, snapshot.length)).toBeUndefined();
  });

  it("builds full descriptors with only unsent chunk payloads", () => {
    const snapshot = createPieceTableSnapshot("const answer = 1;\n");
    const first = createTreeSitterSourceDescriptor(snapshot, { useSharedBuffers: false });
    const sent = new Set(first.chunks.map((chunk) => chunk.chunkId));
    const second = createTreeSitterSourceDescriptor(snapshot, {
      sentChunkIds: sent,
      useSharedBuffers: false,
    });

    expect(first.length).toBe(snapshot.length);
    expect(first.pieces.map((piece) => piece.length).reduce((sum, length) => sum + length, 0)).toBe(
      snapshot.length,
    );
    expect(first.chunks.length).toBeGreaterThan(0);
    expect(second.pieces).toEqual(first.pieces);
    expect(second.chunks).toEqual([]);
  });

  it("sends only new chunks after edits while preserving current ordered spans", () => {
    const previous = createPieceTableSnapshot("ab\ncd");
    const first = createTreeSitterSourceDescriptor(previous, { useSharedBuffers: false });
    const sent = new Set(first.chunks.map((chunk) => chunk.chunkId));
    const next = applyBatchToPieceTable(previous, [{ from: 3, to: 5, text: "xyz" }]);
    const edited = createTreeSitterSourceDescriptor(next, {
      sentChunkIds: sent,
      useSharedBuffers: false,
    });
    const input = resolveTreeSitterSourceDescriptor(cacheWith("doc", first), "doc", edited);

    expect(edited.length).toBe(next.length);
    expect(edited.chunks).toHaveLength(1);
    expect(readTreeSitterInputRange(input, 0, next.length)).toBe(getPieceTableText(next));
  });

  it("reads string and shared UTF-16 source chunks across piece boundaries", () => {
    const snapshot = insertIntoPieceTable(createPieceTableSnapshot("a😀\n"), 4, "tail");
    const stringInput = resolveTreeSitterSourceDescriptor(
      new Map(),
      "strings",
      createTreeSitterSourceDescriptor(snapshot, { useSharedBuffers: false }),
    );
    const sharedInput = resolveTreeSitterSourceDescriptor(
      new Map(),
      "shared",
      createTreeSitterSourceDescriptor(snapshot, { useSharedBuffers: true }),
    );

    expect(readTreeSitterInputRange(stringInput, 0, snapshot.length)).toBe("a😀\ntail");
    expect(readTreeSitterInputRange(sharedInput, 0, snapshot.length)).toBe("a😀\ntail");
    expect(readTreeSitterPieceTableInput(sharedInput, 1)).toBe("😀\n");
  });

  it("resolves empty descriptors", () => {
    const snapshot = createPieceTableSnapshot("");
    const descriptor = createTreeSitterSourceDescriptor(snapshot, { useSharedBuffers: false });
    const input = resolveTreeSitterSourceDescriptor(new Map(), "empty", descriptor);

    expect(descriptor).toEqual({ length: 0, pieces: [], chunks: [] });
    expect(readTreeSitterPieceTableInput(input, 0)).toBeUndefined();
  });

  it("tracks bracket depth while walking open and close nodes", () => {
    const stack: { char: string; index: number }[] = [];

    expect(collectBracket(node("(", 0), stack)).toEqual({ index: 0, char: "(", depth: 1 });
    expect(collectBracket(node("{", 1), stack)).toEqual({ index: 1, char: "{", depth: 2 });
    expect(collectBracket(node("}", 2), stack)).toEqual({ index: 2, char: "}", depth: 2 });
    expect(collectBracket(node(")", 3), stack)).toEqual({ index: 3, char: ")", depth: 1 });
    expect(stack).toEqual([]);
  });

  it("reports tree-sitter error and missing nodes", () => {
    expect(collectError(node("ERROR", 4, 9, { isError: true }))).toEqual({
      startIndex: 4,
      endIndex: 9,
      isMissing: false,
      message: "ERROR",
    });

    expect(collectError(node("identifier", 10, 10, { isMissing: true }))).toEqual({
      startIndex: 10,
      endIndex: 10,
      isMissing: true,
      message: "identifier",
    });

    expect(collectError(node("identifier", 0, 10))).toBeNull();
  });
});

function cacheWith(
  documentId: string,
  descriptor: ReturnType<typeof createTreeSitterSourceDescriptor>,
): TreeSitterSourceCache {
  const cache: TreeSitterSourceCache = new Map();
  resolveTreeSitterSourceDescriptor(cache, documentId, descriptor);
  return cache;
}

function node(
  type: string,
  startIndex: number,
  endIndex = startIndex + 1,
  flags: Partial<Pick<Node, "isError" | "isMissing">> = {},
): Node {
  return {
    type,
    startIndex,
    endIndex,
    isError: flags.isError ?? false,
    isMissing: flags.isMissing ?? false,
  } as Node;
}
