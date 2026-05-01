import type { DocumentSessionChange } from "../documentSession";
import type {
  EditorSyntaxLanguageId,
  EditorSyntaxSession,
  EditorSyntaxSessionOptions,
} from "../syntax/session";
import type { EditorPlugin } from "../plugins";
import type { EditorTheme } from "../theme";
import type {
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
} from "../virtualization/virtualizedTextViewTypes";
import type { EditorKeymapOptions } from "./keymap";
import type { TextEdit } from "../tokens";

/** Minimal interface for the CSS Custom Highlight API registry. */
export interface HighlightRegistry {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

export type EditorSessionChangeHandler = (change: DocumentSessionChange) => void;

export type EditorScrollPosition = {
  readonly top?: number;
  readonly left?: number;
};

export type EditorSessionOptions = {
  readonly onChange?: EditorSessionChangeHandler;
  readonly scrollPosition?: EditorScrollPosition;
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
  readonly defaultText?: string;
  readonly theme?: EditorTheme;
  readonly onChange?: EditorChangeHandler;
  readonly plugins?: readonly EditorPlugin[];
  readonly keymap?: EditorKeymapOptions;
  readonly cursorLineHighlight?: EditorCursorLineHighlightOptions;
  readonly hiddenCharacters?: HiddenCharactersMode;
  readonly lineHeight?: number;
  readonly tabSize?: number;
};

export type EditorSetTextOptions = {
  readonly languageId?: EditorSyntaxLanguageId | null;
  readonly scrollPosition?: EditorScrollPosition;
};

export type EditorOpenDocumentOptions = EditorSetTextOptions & {
  readonly text: string;
  readonly documentId?: string;
};

export type EditorEditHistoryMode = "record" | "skip";

export type EditorEditSelection = {
  readonly anchor: number;
  readonly head?: number;
};

export type EditorEditOptions = {
  readonly history?: EditorEditHistoryMode;
  readonly selection?: EditorEditSelection;
};

export type EditorEditInput = TextEdit | readonly TextEdit[];

export type EditorSyntaxSessionFactory = (
  options: EditorSyntaxSessionOptions,
) => EditorSyntaxSession;
