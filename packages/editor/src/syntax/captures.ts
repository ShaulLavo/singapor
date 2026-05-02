import type { EditorToken, EditorTokenStyle } from "../tokens";
import {
  appendEditorTokenIndexEntry,
  createEditorTokenIndexBuilder,
  finishEditorTokenIndex,
} from "../editor/tokenIndex";
import type { EditorSyntaxCapture } from "./session";

const SYNTAX_COLOR = {
  attribute: "var(--editor-syntax-attribute)",
  bracket: "var(--editor-syntax-bracket)",
  comment: "var(--editor-syntax-comment)",
  constant: "var(--editor-syntax-constant)",
  function: "var(--editor-syntax-function)",
  keyword: "var(--editor-syntax-keyword)",
  keywordDeclaration: "var(--editor-syntax-keyword-declaration)",
  keywordImport: "var(--editor-syntax-keyword-import)",
  namespace: "var(--editor-syntax-namespace)",
  number: "var(--editor-syntax-number)",
  property: "var(--editor-syntax-property)",
  string: "var(--editor-syntax-string)",
  tag: "var(--editor-syntax-keyword)",
  type: "var(--editor-syntax-type)",
  typeDefinition: "var(--editor-syntax-type-definition)",
  typeParameter: "var(--editor-syntax-type-parameter)",
  variable: "var(--editor-syntax-variable)",
  variableBuiltin: "var(--editor-syntax-variable-builtin)",
} as const;

const EXACT_CAPTURE_STYLES: Record<string, EditorTokenStyle> = {
  comment: { color: SYNTAX_COLOR.comment, fontStyle: "italic" },
  "constant.builtin": { color: SYNTAX_COLOR.constant },
  "function.method": { color: SYNTAX_COLOR.function },
  "keyword.control": { color: SYNTAX_COLOR.keyword },
  "keyword.declaration": { color: SYNTAX_COLOR.keywordDeclaration },
  "keyword.import": { color: SYNTAX_COLOR.keywordImport },
  "keyword.type": { color: SYNTAX_COLOR.typeParameter },
  "punctuation.bracket": { color: SYNTAX_COLOR.bracket },
  "type.builtin": { color: SYNTAX_COLOR.type },
  "type.definition": { color: SYNTAX_COLOR.typeDefinition },
  "type.parameter": { color: SYNTAX_COLOR.typeParameter },
  "text.emphasis": { fontStyle: "italic" },
  "text.literal": { color: SYNTAX_COLOR.string },
  "text.reference": { color: SYNTAX_COLOR.property },
  "text.strong": { fontWeight: 700 },
  "text.title": { color: SYNTAX_COLOR.keywordDeclaration, fontWeight: 700 },
  "text.uri": { color: SYNTAX_COLOR.string, textDecoration: "underline" },
  "variable.builtin": { color: SYNTAX_COLOR.variableBuiltin },
  "variable.parameter": { color: SYNTAX_COLOR.keywordImport },
};

const PREFIX_CAPTURE_STYLES: Record<string, EditorTokenStyle> = {
  attribute: { color: SYNTAX_COLOR.attribute },
  constant: { color: SYNTAX_COLOR.constant },
  function: { color: SYNTAX_COLOR.function },
  keyword: { color: SYNTAX_COLOR.keyword },
  namespace: { color: SYNTAX_COLOR.namespace },
  number: { color: SYNTAX_COLOR.number },
  operator: { color: SYNTAX_COLOR.bracket },
  property: { color: SYNTAX_COLOR.property },
  punctuation: { color: SYNTAX_COLOR.bracket },
  string: { color: SYNTAX_COLOR.string },
  tag: { color: SYNTAX_COLOR.tag },
  type: { color: SYNTAX_COLOR.type },
  variable: { color: SYNTAX_COLOR.variable },
};

export const styleForTreeSitterCapture = (captureName: string): EditorTokenStyle | null => {
  const style = sharedStyleForTreeSitterCapture(captureName);
  return style ? { ...style } : null;
};

const sharedStyleForTreeSitterCapture = (captureName: string): EditorTokenStyle | null => {
  const exact = EXACT_CAPTURE_STYLES[captureName];
  if (exact) return exact;

  const prefix = captureName.split(".")[0] ?? "";
  const prefixed = PREFIX_CAPTURE_STYLES[prefix];
  if (!prefixed) return null;

  return prefixed;
};

export const treeSitterCapturesToEditorTokens = (
  captures: readonly EditorSyntaxCapture[],
): EditorToken[] => {
  const tokens: EditorToken[] = [];
  const indexBuilder = createEditorTokenIndexBuilder();

  for (const capture of captures) {
    const token = captureToEditorToken(capture);
    if (!token) continue;

    tokens.push(token);
    appendEditorTokenIndexEntry(indexBuilder, token);
  }

  finishEditorTokenIndex(tokens, indexBuilder);
  return tokens;
};

const captureToEditorToken = (capture: EditorSyntaxCapture): EditorToken | null => {
  if (capture.endIndex <= capture.startIndex) return null;

  const style = sharedStyleForTreeSitterCapture(capture.captureName);
  if (!style) return null;

  return {
    start: capture.startIndex,
    end: capture.endIndex,
    style,
  };
};
