import { describe, expect, it } from "vitest";

import { styleForTreeSitterCapture, treeSitterCapturesToEditorTokens } from "../src/syntax";
import { createTreeSitterEditPayload } from "../src/syntax/session";

describe("Tree-sitter syntax capture conversion", () => {
  it("maps known capture names to editor token styles", () => {
    expect(styleForTreeSitterCapture("keyword.declaration")).toEqual({ color: "#a78bfa" });
    expect(styleForTreeSitterCapture("string")).toEqual({ color: "#fde68a" });
    expect(styleForTreeSitterCapture("unknown.scope")).toBeNull();
  });

  it("converts non-empty captures to editor tokens", () => {
    const tokens = treeSitterCapturesToEditorTokens([
      { startIndex: 0, endIndex: 5, captureName: "keyword.declaration" },
      { startIndex: 6, endIndex: 6, captureName: "string" },
      { startIndex: 7, endIndex: 10, captureName: "not.mapped" },
    ]);

    expect(tokens).toEqual([{ start: 0, end: 5, style: { color: "#a78bfa" } }]);
  });

  it("builds single-edit payloads for incremental reparsing", () => {
    const payload = createTreeSitterEditPayload({
      documentId: "file.ts",
      languageId: "typescript",
      snapshotVersion: 2,
      previousText: "const a = 1;\n",
      nextText: "const answer = 1;\n",
      edits: [{ from: 6, to: 7, text: "answer" }],
    });

    expect(payload).toMatchObject({
      documentId: "file.ts",
      snapshotVersion: 2,
      languageId: "typescript",
      startIndex: 6,
      oldEndIndex: 7,
      newEndIndex: 12,
      startPosition: { row: 0, column: 6 },
      oldEndPosition: { row: 0, column: 7 },
      newEndPosition: { row: 0, column: 12 },
      insertedText: "answer",
    });
  });

  it("skips incremental payloads for multi-edits", () => {
    const payload = createTreeSitterEditPayload({
      documentId: "file.ts",
      languageId: "typescript",
      snapshotVersion: 2,
      previousText: "ab",
      nextText: "xy",
      edits: [
        { from: 0, to: 1, text: "x" },
        { from: 1, to: 2, text: "y" },
      ],
    });

    expect(payload).toBeNull();
  });
});
