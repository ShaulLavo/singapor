import { describe, expect, it } from "vitest";
import ts from "typescript";
import { tsDiagnosticToLspDiagnostic } from "../src/tsDiagnostics";

describe("TypeScript diagnostic conversion", () => {
  it("converts TypeScript offsets and categories to LSP diagnostics", () => {
    const text = "const value: string = 1;\n";
    const file = ts.createSourceFile("/src/index.ts", text, ts.ScriptTarget.ESNext);
    const start = text.indexOf("1");

    expect(
      tsDiagnosticToLspDiagnostic({
        file,
        start,
        length: 1,
        category: ts.DiagnosticCategory.Error,
        code: 2322,
        messageText: "Type 'number' is not assignable to type 'string'.",
      }),
    ).toEqual({
      range: {
        start: { line: 0, character: start },
        end: { line: 0, character: start + 1 },
      },
      severity: 1,
      code: 2322,
      source: "typescript",
      message: "Type 'number' is not assignable to type 'string'.",
    });
  });
});
