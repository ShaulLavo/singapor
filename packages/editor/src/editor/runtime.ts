import { createEditorSyntaxSession } from "../syntax/session";
import type { EditorSyntaxSessionFactory, HighlightRegistry } from "./types";

let editorInstanceCount = 0;
let editorSyntaxSessionFactory: EditorSyntaxSessionFactory = createEditorSyntaxSession;
let highlightRegistry: HighlightRegistry | undefined;

export function nextEditorHighlightPrefix(): string {
  return `editor-token-${editorInstanceCount++}`;
}

export function resetEditorInstanceCount(): void {
  editorInstanceCount = 0;
}

/**
 * Override the HighlightRegistry used by all Editor instances.
 * Useful for testing environments where CSS.highlights is unavailable.
 * Pass `undefined` to revert to the default `CSS.highlights`.
 */
export function setHighlightRegistry(registry: HighlightRegistry | undefined): void {
  highlightRegistry = registry;
}

export function getHighlightRegistry(): HighlightRegistry | undefined {
  return highlightRegistry ?? globalThis.CSS?.highlights;
}

export function setEditorSyntaxSessionFactory(
  factory: EditorSyntaxSessionFactory | undefined,
): void {
  editorSyntaxSessionFactory = factory ?? createEditorSyntaxSession;
}

export function getEditorSyntaxSessionFactory(): EditorSyntaxSessionFactory {
  return editorSyntaxSessionFactory;
}
