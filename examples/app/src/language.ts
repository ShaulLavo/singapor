import type { EditorSyntaxLanguageId } from "@editor/core";

const fileExtensionToLanguage = new Map<string, EditorSyntaxLanguageId>([
  [".cjs", "javascript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "tsx"],
  [".mjs", "javascript"],
  [".mts", "typescript"],
  [".ts", "typescript"],
  [".tsx", "tsx"],
]);

export function inferLanguage(fileName: string): EditorSyntaxLanguageId | null {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const ext = fileName.slice(dotIndex).toLowerCase();
  return fileExtensionToLanguage.get(ext) ?? null;
}
