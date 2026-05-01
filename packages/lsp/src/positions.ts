import type * as lsp from "vscode-languageserver-protocol";
import type { LspTextEdit } from "./types";

export type LspContentChangeOptions = {
  readonly incremental?: boolean;
  readonly edits?: readonly LspTextEdit[];
};

type LineIndex = {
  readonly starts: readonly number[];
  readonly ends: readonly number[];
};

export const offsetToLspPosition = (text: string, offset: number): lsp.Position => {
  if (offset < 0 || offset > text.length) throw new RangeError("invalid offset");

  const index = createLineIndex(text);
  const line = lineForOffset(index.starts, offset);
  const start = index.starts[line] ?? 0;
  const end = index.ends[line] ?? text.length;
  return { line, character: Math.min(offset, end) - start };
};

export const lspPositionToOffset = (text: string, position: lsp.Position): number => {
  const index = createLineIndex(text);
  const line = clampInteger(position.line, 0, index.starts.length - 1);
  const start = index.starts[line] ?? 0;
  const end = index.ends[line] ?? text.length;
  return clampInteger(start + position.character, start, end);
};

export const textEditToLspContentChange = (
  previousText: string,
  edit: LspTextEdit,
): lsp.TextDocumentContentChangeEvent => {
  validateTextEdit(previousText, edit);
  return {
    range: {
      start: offsetToLspPosition(previousText, edit.from),
      end: offsetToLspPosition(previousText, edit.to),
    },
    text: edit.text,
  };
};

export const textEditsToLspContentChanges = (
  previousText: string,
  edits: readonly LspTextEdit[],
): readonly lsp.TextDocumentContentChangeEvent[] => {
  if (edits.length === 0) return [];
  if (!areValidBatchEdits(previousText, edits)) return [];

  const changes: lsp.TextDocumentContentChangeEvent[] = [];
  let workingText = previousText;

  for (const edit of edits.toSorted(compareTextEditsDescending)) {
    changes.push(textEditToLspContentChange(workingText, edit));
    workingText = applyTextEdit(workingText, edit);
  }

  return changes;
};

export const createLspContentChanges = (
  previousText: string,
  nextText: string,
  options: LspContentChangeOptions = {},
): readonly lsp.TextDocumentContentChangeEvent[] => {
  if (!options.incremental) return [createFullContentChange(nextText)];
  if (!options.edits || options.edits.length === 0) return [createFullContentChange(nextText)];

  const changes = textEditsToLspContentChanges(previousText, options.edits);
  const editedText = applyTextEdits(previousText, options.edits);
  if (changes.length === 0 || editedText !== nextText) return [createFullContentChange(nextText)];

  return changes;
};

const createLineIndex = (text: string): LineIndex => {
  const starts = [0];
  const ends: number[] = [];
  let lineStart = 0;
  let index = 0;

  while (index < text.length) {
    const nextBreak = nextLineBreak(text, index);
    if (!nextBreak) break;

    ends.push(nextBreak.start);
    starts.push(nextBreak.end);
    lineStart = nextBreak.end;
    index = nextBreak.end;
  }

  ends.push(text.length);
  return { starts, ends: normalizeFinalLineEnd(starts, ends, lineStart, text.length) };
};

const nextLineBreak = (
  text: string,
  from: number,
): { readonly start: number; readonly end: number } | null => {
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") return { start: index, end: index + 1 };
    if (char !== "\r") continue;

    const end = text[index + 1] === "\n" ? index + 2 : index + 1;
    return { start: index, end };
  }

  return null;
};

const normalizeFinalLineEnd = (
  starts: readonly number[],
  ends: readonly number[],
  lineStart: number,
  textLength: number,
): readonly number[] => {
  if (starts[starts.length - 1] === lineStart) return ends;
  return [...ends.slice(0, -1), textLength];
};

const lineForOffset = (starts: readonly number[], offset: number): number => {
  let low = 0;
  let high = starts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = starts[mid] ?? 0;
    if (start <= offset) low = mid + 1;
    else high = mid - 1;
  }

  return Math.max(0, high);
};

const clampInteger = (value: number, min: number, max: number): number => {
  const integer = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, integer));
};

const createFullContentChange = (text: string): lsp.TextDocumentContentChangeEvent => ({ text });

const applyTextEdits = (text: string, edits: readonly LspTextEdit[]): string | null => {
  if (!areValidBatchEdits(text, edits)) return null;

  let nextText = text;
  for (const edit of edits.toSorted(compareTextEditsDescending)) {
    nextText = applyTextEdit(nextText, edit);
  }

  return nextText;
};

const applyTextEdit = (text: string, edit: LspTextEdit): string =>
  `${text.slice(0, edit.from)}${edit.text}${text.slice(edit.to)}`;

const areValidBatchEdits = (text: string, edits: readonly LspTextEdit[]): boolean => {
  let previousEnd = -1;
  for (const edit of edits.toSorted(compareTextEditsAscending)) {
    if (!isValidTextEdit(text, edit)) return false;
    if (edit.from < previousEnd) return false;
    previousEnd = edit.to;
  }

  return true;
};

const validateTextEdit = (text: string, edit: LspTextEdit): void => {
  if (isValidTextEdit(text, edit)) return;
  throw new RangeError("invalid text edit");
};

const isValidTextEdit = (text: string, edit: LspTextEdit): boolean =>
  edit.from >= 0 && edit.to >= edit.from && edit.to <= text.length;

const compareTextEditsAscending = (left: LspTextEdit, right: LspTextEdit): number =>
  left.from - right.from || left.to - right.to;

const compareTextEditsDescending = (left: LspTextEdit, right: LspTextEdit): number =>
  right.from - left.from || right.to - left.to;
