import { lspPositionToOffset } from "@editor/lsp";
import type * as lsp from "vscode-languageserver-protocol";

export type TypeScriptLspDiagnosticSeverity = "error" | "warning" | "information" | "hint";

export type TypeScriptLspDiagnosticHighlightGroups = Readonly<
  Record<TypeScriptLspDiagnosticSeverity, readonly DiagnosticHighlightRange[]>
>;

type DiagnosticHighlightRange = {
  readonly start: number;
  readonly end: number;
};

const ERROR = 1;
const WARNING = 2;
const INFORMATION = 3;
const HINT = 4;

export function summarizeDiagnostics(
  uri: lsp.DocumentUri | null,
  version: number | null,
  diagnostics: readonly lsp.Diagnostic[],
): {
  readonly uri: lsp.DocumentUri | null;
  readonly version: number | null;
  readonly diagnostics: readonly lsp.Diagnostic[];
  readonly counts: {
    readonly error: number;
    readonly warning: number;
    readonly information: number;
    readonly hint: number;
    readonly total: number;
  };
} {
  const counts = { error: 0, warning: 0, information: 0, hint: 0 };
  for (const diagnostic of diagnostics) counts[severityForDiagnostic(diagnostic)] += 1;
  return {
    uri,
    version,
    diagnostics: [...diagnostics],
    counts: {
      ...counts,
      total: diagnostics.length,
    },
  };
}

export function diagnosticHighlightGroups(
  text: string,
  diagnostics: readonly lsp.Diagnostic[],
): TypeScriptLspDiagnosticHighlightGroups {
  const groups = emptyHighlightGroups();

  for (const diagnostic of diagnostics) {
    const range = highlightRangeForDiagnostic(text, diagnostic);
    if (!range) continue;
    groups[severityForDiagnostic(diagnostic)].push(range);
  }

  return groups;
}

function highlightRangeForDiagnostic(
  text: string,
  diagnostic: lsp.Diagnostic,
): DiagnosticHighlightRange | null {
  const start = lspPositionToOffset(text, diagnostic.range.start);
  const end = lspPositionToOffset(text, diagnostic.range.end);
  if (end > start) return { start, end };
  return expandEmptyRange(text, start);
}

function expandEmptyRange(text: string, offset: number): DiagnosticHighlightRange | null {
  if (text.length === 0) return null;
  if (offset < text.length) return { start: offset, end: offset + 1 };
  if (offset > 0) return { start: offset - 1, end: offset };
  return null;
}

function emptyHighlightGroups(): Record<
  TypeScriptLspDiagnosticSeverity,
  DiagnosticHighlightRange[]
> {
  return {
    error: [],
    warning: [],
    information: [],
    hint: [],
  };
}

function severityForDiagnostic(diagnostic: lsp.Diagnostic): TypeScriptLspDiagnosticSeverity {
  if (diagnostic.severity === WARNING) return "warning";
  if (diagnostic.severity === INFORMATION) return "information";
  if (diagnostic.severity === HINT) return "hint";
  if (diagnostic.severity === ERROR) return "error";
  return "error";
}
