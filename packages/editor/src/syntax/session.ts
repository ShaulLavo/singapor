import type { DocumentSessionChange } from "../documentSession";
import type { EditorToken, TextEdit } from "../tokens";
import type { PieceTableSnapshot } from "../pieceTable/pieceTableTypes";
import { applyBatchToPieceTable } from "../pieceTable/edits";
import { offsetToPoint } from "../pieceTable/positions";
import type {
  TreeSitterInputEdit,
  TreeSitterLanguageId,
  TreeSitterParseResult,
} from "./treeSitter/types";
import { treeSitterCapturesToEditorTokens } from "./captures";
import {
  disposeTreeSitterDocument,
  editWithTreeSitter,
  parseWithTreeSitter,
  registerTreeSitterLanguagesWithWorker,
  type TreeSitterEditPayload,
} from "./treeSitter/workerClient";
import { isTreeSitterLanguageId, type TreeSitterLanguageResolver } from "./treeSitter/registry";

export type EditorSyntaxLanguageId = TreeSitterLanguageId;

export type EditorSyntaxResult = Pick<
  TreeSitterParseResult,
  "captures" | "folds" | "brackets" | "errors"
> & {
  readonly injections: TreeSitterParseResult["injections"];
  readonly tokens: readonly EditorToken[];
};

export type EditorSyntaxSessionOptions = {
  readonly documentId: string;
  readonly languageId: EditorSyntaxLanguageId | null;
  readonly languageResolver?: TreeSitterLanguageResolver;
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

export const createEditorSyntaxSession = (
  options: EditorSyntaxSessionOptions,
): EditorSyntaxSession => {
  if (!options.languageId) return createEmptySyntaxSession();
  return new TreeSitterSyntaxSession(
    options.documentId,
    options.languageId,
    options.languageResolver,
    options.includeHighlights ?? true,
    options.text,
    options.snapshot,
  );
};

export const isEditorSyntaxLanguage = (
  languageId: string | null | undefined,
): languageId is EditorSyntaxLanguageId => isTreeSitterLanguageId(languageId);

const createEmptySyntaxSession = (): EditorSyntaxSession => ({
  refresh: async () => createEmptySyntaxResult(),
  applyChange: async () => createEmptySyntaxResult(),
  getResult: () => createEmptySyntaxResult(),
  getTokens: () => [],
  getSnapshotVersion: () => 0,
  dispose: () => undefined,
});

class TreeSitterSyntaxSession implements EditorSyntaxSession {
  private readonly documentId: string;
  private readonly languageId: EditorSyntaxLanguageId;
  private readonly languageResolver: TreeSitterLanguageResolver | undefined;
  private readonly includeHighlights: boolean;
  private snapshotVersion = 0;
  private text: string;
  private snapshot: PieceTableSnapshot;
  private result: EditorSyntaxResult = createEmptySyntaxResult();
  private languageRegistrationPromise: Promise<boolean> | null = null;

  public constructor(
    documentId: string,
    languageId: EditorSyntaxLanguageId,
    languageResolver: TreeSitterLanguageResolver | undefined,
    includeHighlights: boolean,
    text: string,
    snapshot: PieceTableSnapshot,
  ) {
    this.documentId = documentId;
    this.languageId = languageId;
    this.languageResolver = languageResolver;
    this.includeHighlights = includeHighlights;
    this.text = text;
    this.snapshot = snapshot;
  }

  public async refresh(
    snapshot: PieceTableSnapshot,
    text = this.text,
  ): Promise<EditorSyntaxResult> {
    const snapshotVersion = ++this.snapshotVersion;
    if (!(await this.ensureLanguageRegistered())) {
      return this.updateFromUnavailableLanguage(text, snapshot);
    }

    const result = await parseWithTreeSitter({
      documentId: this.documentId,
      snapshotVersion,
      languageId: this.languageId,
      includeHighlights: this.includeHighlights,
      snapshot,
    });

    return this.updateFromTreeSitterResult(result, snapshotVersion, text, snapshot);
  }

  public async applyChange(change: DocumentSessionChange): Promise<EditorSyntaxResult> {
    if (change.kind === "none" || change.kind === "selection") return this.result;
    if (!(await this.ensureLanguageRegistered())) {
      this.snapshotVersion += 1;
      return this.updateFromUnavailableLanguage(change.text, change.snapshot);
    }

    const edit = createTextDiffEdit(this.text, change.text);
    if (!edit) {
      this.text = change.text;
      this.snapshot = change.snapshot;
      return this.result;
    }

    const payload = createTreeSitterEditPayload({
      documentId: this.documentId,
      languageId: this.languageId,
      snapshotVersion: ++this.snapshotVersion,
      previousSnapshot: this.snapshot,
      nextSnapshot: change.snapshot,
      edits: [edit],
      includeHighlights: this.includeHighlights,
    });

    if (!payload) return this.refresh(change.snapshot, change.text);
    return this.applyIncrementalEdit(payload, change.text);
  }

  public getResult(): EditorSyntaxResult {
    return this.result;
  }

  public getTokens(): readonly EditorToken[] {
    return this.result.tokens;
  }

  public getSnapshotVersion(): number {
    return this.snapshotVersion;
  }

  public dispose(): void {
    disposeTreeSitterDocument(this.documentId);
  }

  private async applyIncrementalEdit(
    payload: TreeSitterEditPayload,
    nextText: string,
  ): Promise<EditorSyntaxResult> {
    try {
      const result = await editWithTreeSitter(payload);
      return this.updateFromTreeSitterResult(
        result,
        payload.snapshotVersion,
        nextText,
        payload.snapshot,
      );
    } catch (error) {
      if (!isRecoverableIncrementalEditError(error)) throw error;
      return this.refresh(payload.snapshot, nextText);
    }
  }

  private ensureLanguageRegistered(): Promise<boolean> {
    if (!this.languageResolver) return Promise.resolve(true);
    if (!this.languageRegistrationPromise) {
      this.languageRegistrationPromise = this.registerResolvedLanguage();
    }

    return this.languageRegistrationPromise;
  }

  private async registerResolvedLanguage(): Promise<boolean> {
    const descriptor = await this.languageResolver?.resolveTreeSitterLanguage(this.languageId);
    if (!descriptor) return false;

    await registerTreeSitterLanguagesWithWorker([descriptor]);
    return true;
  }

  private updateFromUnavailableLanguage(
    text: string,
    snapshot: PieceTableSnapshot,
  ): EditorSyntaxResult {
    this.text = text;
    this.snapshot = snapshot;
    this.result = createEmptySyntaxResult();
    return this.result;
  }

  private updateFromTreeSitterResult(
    result: TreeSitterParseResult | undefined,
    snapshotVersion: number,
    text: string,
    snapshot: PieceTableSnapshot,
  ): EditorSyntaxResult {
    if (!result) return this.result;
    if (result.snapshotVersion !== snapshotVersion) return this.result;
    if (result.snapshotVersion !== this.snapshotVersion) return this.result;

    this.text = text;
    this.snapshot = snapshot;
    this.result = treeSitterParseResultToEditorSyntaxResult(result);
    return this.result;
  }
}

type TreeSitterEditPayloadOptions = {
  readonly documentId: string;
  readonly languageId: EditorSyntaxLanguageId;
  readonly snapshotVersion: number;
  readonly previousSnapshot: PieceTableSnapshot;
  readonly nextSnapshot: PieceTableSnapshot;
  readonly edits: readonly TextEdit[];
  readonly includeHighlights?: boolean;
};

export const createTreeSitterEditPayload = (
  options: TreeSitterEditPayloadOptions,
): TreeSitterEditPayload | null => {
  if (options.edits.length === 0) return null;

  return {
    documentId: options.documentId,
    snapshotVersion: options.snapshotVersion,
    languageId: options.languageId,
    includeHighlights: options.includeHighlights ?? true,
    snapshot: options.nextSnapshot,
    edits: options.edits,
    inputEdits: createTreeSitterInputEdits(options.previousSnapshot, options.edits),
  };
};

const treeSitterParseResultToEditorSyntaxResult = (
  result: TreeSitterParseResult,
): EditorSyntaxResult => ({
  captures: result.captures,
  folds: result.folds,
  brackets: result.brackets,
  errors: result.errors,
  injections: result.injections,
  tokens: treeSitterCapturesToEditorTokens(result.captures),
});

const createEmptySyntaxResult = (): EditorSyntaxResult => ({
  captures: [],
  folds: [],
  brackets: [],
  errors: [],
  injections: [],
  tokens: [],
});

const createTreeSitterInputEdits = (
  snapshot: PieceTableSnapshot,
  edits: readonly TextEdit[],
): TreeSitterInputEdit[] => {
  const sorted = edits.toSorted((left, right) => right.from - left.from || right.to - left.to);
  const inputEdits: TreeSitterInputEdit[] = [];
  let workingSnapshot = snapshot;

  for (const edit of sorted) {
    const startPosition = offsetToPoint(workingSnapshot, edit.from);
    const oldEndPosition = offsetToPoint(workingSnapshot, edit.to);
    const nextSnapshot = applyBatchToPieceTable(workingSnapshot, [edit]);
    const newEndIndex = edit.from + edit.text.length;

    inputEdits.push({
      startIndex: edit.from,
      oldEndIndex: edit.to,
      newEndIndex,
      startPosition,
      oldEndPosition,
      newEndPosition: offsetToPoint(nextSnapshot, newEndIndex),
    });
    workingSnapshot = nextSnapshot;
  }

  return inputEdits;
};

export const createTextDiffEdit = (previousText: string, nextText: string): TextEdit | null => {
  if (previousText === nextText) return null;

  let start = 0;
  const maxPrefixLength = Math.min(previousText.length, nextText.length);
  while (start < maxPrefixLength && previousText[start] === nextText[start]) start += 1;

  let previousEnd = previousText.length;
  let nextEnd = nextText.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousText[previousEnd - 1] === nextText[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return {
    from: start,
    to: previousEnd,
    text: nextText.slice(start, nextEnd),
  };
};

const isRecoverableIncrementalEditError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("cache miss");
