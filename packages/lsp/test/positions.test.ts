import { describe, expect, it } from "vitest";

import {
  createLspContentChanges,
  lspPositionToOffset,
  offsetToLspPosition,
  textEditsToLspContentChanges,
} from "../src/index.ts";

describe("LSP position helpers", () => {
  it("converts offsets and positions in empty text", () => {
    expect(offsetToLspPosition("", 0)).toEqual({ line: 0, character: 0 });
    expect(lspPositionToOffset("", { line: 10, character: 5 })).toBe(0);
  });

  it("converts offsets and positions at line boundaries", () => {
    const text = "ab\ncde\n";

    expect(offsetToLspPosition(text, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToLspPosition(text, 2)).toEqual({ line: 0, character: 2 });
    expect(offsetToLspPosition(text, 3)).toEqual({ line: 1, character: 0 });
    expect(offsetToLspPosition(text, 7)).toEqual({ line: 2, character: 0 });
    expect(lspPositionToOffset(text, { line: 0, character: 99 })).toBe(2);
    expect(lspPositionToOffset(text, { line: 1, character: 2 })).toBe(5);
    expect(lspPositionToOffset(text, { line: 99, character: 1 })).toBe(7);
  });

  it("counts UTF-16 code units", () => {
    const text = "😀a";

    expect(text.length).toBe(3);
    expect(offsetToLspPosition(text, 2)).toEqual({ line: 0, character: 2 });
    expect(lspPositionToOffset(text, { line: 0, character: 2 })).toBe(2);
  });

  it("treats CRLF as one line break and clamps positions before the break", () => {
    const text = "ab\r\nc";

    expect(offsetToLspPosition(text, 2)).toEqual({ line: 0, character: 2 });
    expect(offsetToLspPosition(text, 3)).toEqual({ line: 0, character: 2 });
    expect(offsetToLspPosition(text, 4)).toEqual({ line: 1, character: 0 });
    expect(lspPositionToOffset(text, { line: 0, character: 99 })).toBe(2);
    expect(lspPositionToOffset(text, { line: 1, character: 1 })).toBe(5);
  });
});

describe("LSP content change helpers", () => {
  it("creates sequential incremental changes from editor text edits", () => {
    const changes = textEditsToLspContentChanges("abcdef", [
      { from: 1, to: 2, text: "B" },
      { from: 4, to: 6, text: "EF" },
    ]);

    expect(changes).toEqual([
      {
        range: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 6 },
        },
        text: "EF",
      },
      {
        range: {
          start: { line: 0, character: 1 },
          end: { line: 0, character: 2 },
        },
        text: "B",
      },
    ]);
  });

  it("falls back to full content when incremental edits do not produce the target text", () => {
    const changes = createLspContentChanges("abc", "abX", {
      incremental: true,
      edits: [{ from: 2, to: 3, text: "Y" }],
    });

    expect(changes).toEqual([{ text: "abX" }]);
  });

  it("uses full content when incremental mode is disabled", () => {
    expect(
      createLspContentChanges("abc", "abcd", {
        edits: [{ from: 3, to: 3, text: "d" }],
      }),
    ).toEqual([{ text: "abcd" }]);
  });
});
