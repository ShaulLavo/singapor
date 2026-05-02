import { describe, expect, it } from "vitest";

import { styleForTreeSitterCapture, treeSitterCapturesToEditorTokens } from "../src";

describe("syntax capture conversion", () => {
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
});
