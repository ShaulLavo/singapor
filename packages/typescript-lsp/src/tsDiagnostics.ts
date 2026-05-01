import { offsetToLspPosition } from "@editor/lsp";
import ts from "typescript";
import type * as lsp from "vscode-languageserver-protocol";

const WARNING = 2;
const INFORMATION = 3;
const HINT = 4;

export function tsDiagnosticToLspDiagnostic(diagnostic: ts.Diagnostic): lsp.Diagnostic {
  const text = diagnostic.file?.text ?? "";
  const start = clampDiagnosticOffset(diagnostic.start ?? 0, text);
  const end = clampDiagnosticOffset(start + (diagnostic.length ?? 0), text);

  return {
    range: {
      start: offsetToLspPosition(text, start),
      end: offsetToLspPosition(text, end),
    },
    severity: lspSeverityForTsDiagnostic(diagnostic),
    code: diagnostic.code,
    source: "typescript",
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  };
}

function lspSeverityForTsDiagnostic(diagnostic: ts.Diagnostic): lsp.DiagnosticSeverity {
  if (diagnostic.category === ts.DiagnosticCategory.Warning) return WARNING;
  if (diagnostic.category === ts.DiagnosticCategory.Suggestion) return HINT;
  if (diagnostic.category === ts.DiagnosticCategory.Message) return INFORMATION;
  return 1;
}

function clampDiagnosticOffset(offset: number, text: string): number {
  return Math.min(text.length, Math.max(0, offset));
}
