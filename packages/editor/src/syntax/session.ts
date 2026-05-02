import type { DocumentSessionChange } from "../documentSession";
import type { PieceTableSnapshot } from "../pieceTable/pieceTableTypes";
import type { EditorToken } from "../tokens";

export type EditorSyntaxLanguageId = string;

export type EditorSyntaxCapture = {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly captureName: string;
  readonly languageId?: EditorSyntaxLanguageId;
};

export type FoldRange = {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly type: string;
  readonly languageId?: EditorSyntaxLanguageId;
};

export type BracketInfo = {
  readonly index: number;
  readonly char: string;
  readonly depth: number;
};

export type EditorSyntaxError = {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly message: string;
  readonly isMissing: boolean;
};

export type EditorSyntaxInjection = {
  readonly parentLanguageId: EditorSyntaxLanguageId;
  readonly languageId: EditorSyntaxLanguageId;
  readonly startIndex: number;
  readonly endIndex: number;
};

export type EditorSyntaxResult = {
  readonly captures: readonly EditorSyntaxCapture[];
  readonly folds: readonly FoldRange[];
  readonly brackets: readonly BracketInfo[];
  readonly errors: readonly EditorSyntaxError[];
  readonly injections: readonly EditorSyntaxInjection[];
  readonly tokens: readonly EditorToken[];
};

export type EditorSyntaxSessionOptions = {
  readonly documentId: string;
  readonly languageId: EditorSyntaxLanguageId | null;
  readonly includeHighlights?: boolean;
  readonly text: string;
  readonly snapshot: PieceTableSnapshot;
};

export type EditorSyntaxSession = {
  refresh(snapshot: PieceTableSnapshot, text?: string): Promise<EditorSyntaxResult>;
  applyChange(change: DocumentSessionChange): Promise<EditorSyntaxResult>;
  getResult(): EditorSyntaxResult;
  getTokens(): readonly EditorToken[];
  getSnapshotVersion(): number;
  dispose(): void;
};

export type EditorSyntaxProvider = {
  createSession(options: EditorSyntaxSessionOptions): EditorSyntaxSession | null;
};

export const createEditorSyntaxSession = (): EditorSyntaxSession => createEmptySyntaxSession();

export const createEmptySyntaxSession = (): EditorSyntaxSession => ({
  refresh: async () => createEmptySyntaxResult(),
  applyChange: async () => createEmptySyntaxResult(),
  getResult: () => createEmptySyntaxResult(),
  getTokens: () => [],
  getSnapshotVersion: () => 0,
  dispose: () => undefined,
});

export const createEmptySyntaxResult = (): EditorSyntaxResult => ({
  captures: [],
  folds: [],
  brackets: [],
  errors: [],
  injections: [],
  tokens: [],
});

export const isEditorSyntaxLanguage = (
  languageId: string | null | undefined,
): languageId is EditorSyntaxLanguageId => {
  if (!languageId) return false;
  return languageId.trim().length > 0;
};
