import type { EditorToken, EditorTokenStyle } from "../tokens";
import type { TreeSitterCapture } from "./treeSitter/types";

const EXACT_CAPTURE_STYLES: Record<string, EditorTokenStyle> = {
  comment: { color: "#71717a", fontStyle: "italic" },
  "constant.builtin": { color: "#f0abfc" },
  "function.method": { color: "#fecdd3" },
  "keyword.control": { color: "#6ee7b7" },
  "keyword.declaration": { color: "#a78bfa" },
  "keyword.import": { color: "#f9a8d4" },
  "keyword.type": { color: "#22d3ee" },
  "punctuation.bracket": { color: "#d4d4d8" },
  "type.builtin": { color: "#7dd3fc" },
  "type.definition": { color: "#38bdf8" },
  "type.parameter": { color: "#5eead4" },
  "variable.builtin": { color: "#fdba74" },
  "variable.parameter": { color: "#f9a8d4" },
};

const PREFIX_CAPTURE_STYLES: Record<string, EditorTokenStyle> = {
  attribute: { color: "#99f6e4" },
  constant: { color: "#f0abfc" },
  function: { color: "#fecdd3" },
  keyword: { color: "#6ee7b7" },
  namespace: { color: "#a5f3fc" },
  number: { color: "#c4b5fd" },
  operator: { color: "#d4d4d8" },
  property: { color: "#e9d5ff" },
  punctuation: { color: "#d4d4d8" },
  string: { color: "#fde68a" },
  type: { color: "#7dd3fc" },
  variable: { color: "#e4e4e7" },
};

export const styleForTreeSitterCapture = (captureName: string): EditorTokenStyle | null => {
  const exact = EXACT_CAPTURE_STYLES[captureName];
  if (exact) return { ...exact };

  const prefix = captureName.split(".")[0] ?? "";
  const prefixed = PREFIX_CAPTURE_STYLES[prefix];
  if (!prefixed) return null;

  return { ...prefixed };
};

export const treeSitterCapturesToEditorTokens = (
  captures: readonly TreeSitterCapture[],
): EditorToken[] => {
  const tokens: EditorToken[] = [];

  for (const capture of captures) {
    const token = captureToEditorToken(capture);
    if (token) tokens.push(token);
  }

  return tokens;
};

const captureToEditorToken = (capture: TreeSitterCapture): EditorToken | null => {
  if (capture.endIndex <= capture.startIndex) return null;

  const style = styleForTreeSitterCapture(capture.captureName);
  if (!style) return null;

  return {
    start: capture.startIndex,
    end: capture.endIndex,
    style,
  };
};
