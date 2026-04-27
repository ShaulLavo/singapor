import type { DocumentSessionChange } from "../documentSession";
import type { EditorToken, TextEdit } from "../tokens";
import type {
  TreeSitterLanguageId,
  TreeSitterParseResult,
  TreeSitterPoint,
} from "./treeSitter/types";
import { treeSitterCapturesToEditorTokens } from "./captures";
import {
  disposeTreeSitterDocument,
  editWithTreeSitter,
  parseWithTreeSitter,
  type TreeSitterEditPayload,
} from "./treeSitter/workerClient";

export type EditorSyntaxLanguageId = TreeSitterLanguageId;

export type EditorSyntaxResult = Pick<
  TreeSitterParseResult,
  "captures" | "folds" | "brackets" | "errors"
> & {
  readonly tokens: readonly EditorToken[];
};

export type EditorSyntaxSessionOptions = {
  readonly documentId: string;
  readonly languageId: EditorSyntaxLanguageId | null;
  readonly text: string;
};

export type EditorSyntaxSession = {
  refresh(text: string): Promise<EditorSyntaxResult>;
  applyChange(change: DocumentSessionChange): Promise<EditorSyntaxResult>;
  getResult(): EditorSyntaxResult;
  getTokens(): readonly EditorToken[];
  dispose(): void;
};

export const createEditorSyntaxSession = (
  options: EditorSyntaxSessionOptions,
): EditorSyntaxSession => {
  if (!options.languageId) return createEmptySyntaxSession();
  return new TreeSitterSyntaxSession(options.documentId, options.languageId, options.text);
};

export const isEditorSyntaxLanguage = (
  languageId: string | null | undefined,
): languageId is EditorSyntaxLanguageId =>
  languageId === "javascript" || languageId === "typescript" || languageId === "tsx";

const createEmptySyntaxSession = (): EditorSyntaxSession => ({
  refresh: async () => createEmptySyntaxResult(),
  applyChange: async () => createEmptySyntaxResult(),
  getResult: () => createEmptySyntaxResult(),
  getTokens: () => [],
  dispose: () => undefined,
});

class TreeSitterSyntaxSession implements EditorSyntaxSession {
  private readonly documentId: string;
  private readonly languageId: EditorSyntaxLanguageId;
  private snapshotVersion = 0;
  private text: string;
  private result: EditorSyntaxResult = createEmptySyntaxResult();

  public constructor(documentId: string, languageId: EditorSyntaxLanguageId, text: string) {
    this.documentId = documentId;
    this.languageId = languageId;
    this.text = text;
    void this.refresh(text).catch(() => undefined);
  }

  public async refresh(text: string): Promise<EditorSyntaxResult> {
    const snapshotVersion = ++this.snapshotVersion;
    const result = await parseWithTreeSitter({
      documentId: this.documentId,
      snapshotVersion,
      languageId: this.languageId,
      text,
    });

    return this.updateFromTreeSitterResult(result, snapshotVersion, text);
  }

  public async applyChange(change: DocumentSessionChange): Promise<EditorSyntaxResult> {
    if (change.kind === "none" || change.kind === "selection") return this.result;
    if (change.kind !== "edit") return this.refresh(change.text);

    const payload = createTreeSitterEditPayload({
      documentId: this.documentId,
      languageId: this.languageId,
      snapshotVersion: ++this.snapshotVersion,
      previousText: this.text,
      nextText: change.text,
      edits: change.edits,
    });

    if (!payload) return this.refresh(change.text);
    return this.applyIncrementalEdit(payload, change.text);
  }

  public getResult(): EditorSyntaxResult {
    return this.result;
  }

  public getTokens(): readonly EditorToken[] {
    return this.result.tokens;
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
      return this.updateFromTreeSitterResult(result, payload.snapshotVersion, nextText);
    } catch (error) {
      if (!isRecoverableIncrementalEditError(error)) throw error;
      return this.refresh(nextText);
    }
  }

  private updateFromTreeSitterResult(
    result: TreeSitterParseResult | undefined,
    snapshotVersion: number,
    text: string,
  ): EditorSyntaxResult {
    if (!result) return this.result;
    if (result.snapshotVersion !== snapshotVersion) return this.result;
    if (result.snapshotVersion !== this.snapshotVersion) return this.result;

    this.text = text;
    this.result = treeSitterParseResultToEditorSyntaxResult(result);
    return this.result;
  }
}

type TreeSitterEditPayloadOptions = {
  readonly documentId: string;
  readonly languageId: EditorSyntaxLanguageId;
  readonly snapshotVersion: number;
  readonly previousText: string;
  readonly nextText: string;
  readonly edits: readonly TextEdit[];
};

export const createTreeSitterEditPayload = (
  options: TreeSitterEditPayloadOptions,
): TreeSitterEditPayload | null => {
  const edit = options.edits[0];
  if (!edit || options.edits.length !== 1) return null;

  const newEndIndex = edit.from + edit.text.length;
  return {
    documentId: options.documentId,
    snapshotVersion: options.snapshotVersion,
    languageId: options.languageId,
    startIndex: edit.from,
    oldEndIndex: edit.to,
    newEndIndex,
    startPosition: pointAtOffset(options.previousText, edit.from),
    oldEndPosition: pointAtOffset(options.previousText, edit.to),
    newEndPosition: pointAtOffset(options.nextText, newEndIndex),
    insertedText: edit.text,
  };
};

const treeSitterParseResultToEditorSyntaxResult = (
  result: TreeSitterParseResult,
): EditorSyntaxResult => ({
  captures: result.captures,
  folds: result.folds,
  brackets: result.brackets,
  errors: result.errors,
  tokens: treeSitterCapturesToEditorTokens(result.captures),
});

const createEmptySyntaxResult = (): EditorSyntaxResult => ({
  captures: [],
  folds: [],
  brackets: [],
  errors: [],
  tokens: [],
});

const pointAtOffset = (text: string, offset: number): TreeSitterPoint => {
  const boundedOffset = Math.max(0, Math.min(offset, text.length));
  let row = 0;
  let column = 0;

  for (let index = 0; index < boundedOffset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      row += 1;
      column = 0;
      continue;
    }

    column += 1;
  }

  return { row, column };
};

const isRecoverableIncrementalEditError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("cache miss");
