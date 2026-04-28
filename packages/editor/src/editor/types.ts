import type { DocumentSessionChange } from "../documentSession";
import type {
  EditorSyntaxLanguageId,
  EditorSyntaxSession,
  EditorSyntaxSessionOptions,
} from "../syntax/session";
import type { EditorPlugin } from "../plugins";
import type { EditorKeymapOptions } from "./keymap";

/** Minimal interface for the CSS Custom Highlight API registry. */
export interface HighlightRegistry {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

export type EditorSessionChangeHandler = (change: DocumentSessionChange) => void;

export type EditorSessionOptions = {
  readonly onChange?: EditorSessionChangeHandler;
};

export type EditorSyntaxStatus = "plain" | "loading" | "ready" | "error";

export type EditorState = {
  readonly documentId: string | null;
  readonly languageId: EditorSyntaxLanguageId | null;
  readonly syntaxStatus: EditorSyntaxStatus;
  readonly cursor: {
    readonly row: number;
    readonly column: number;
  };
  readonly length: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
};

export type EditorChangeHandler = (
  state: EditorState,
  change: DocumentSessionChange | null,
) => void;

export type EditorOptions = {
  readonly onChange?: EditorChangeHandler;
  readonly plugins?: readonly EditorPlugin[];
  readonly keymap?: EditorKeymapOptions;
};

export type EditorOpenDocumentOptions = {
  readonly text: string;
  readonly documentId?: string;
  readonly languageId?: EditorSyntaxLanguageId | null;
};

export type EditorSyntaxSessionFactory = (
  options: EditorSyntaxSessionOptions,
) => EditorSyntaxSession;
