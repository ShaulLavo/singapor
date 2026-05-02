import type { FoldRange } from "../syntax/session";
import type { TextEdit } from "../tokens";
import type { VirtualizedFoldMarker } from "../virtualization/virtualizedTextView";

export type SyntaxFoldProjection = {
  readonly folds: readonly FoldRange[];
  readonly keyMap: ReadonlyMap<string, string>;
};

export const EMPTY_SYNTAX_FOLDS: readonly FoldRange[] = [];
export const EMPTY_FOLD_MARKERS: readonly VirtualizedFoldMarker[] = [];

export function foldMarkerFromRange(
  fold: FoldRange,
  collapsedFoldKeys: ReadonlySet<string>,
): VirtualizedFoldMarker {
  const key = foldRangeKey(fold);
  return {
    key,
    startOffset: fold.startIndex,
    endOffset: fold.endIndex,
    startRow: fold.startLine,
    endRow: fold.endLine,
    collapsed: collapsedFoldKeys.has(key),
  };
}

export function foldRangeKey(fold: FoldRange): string {
  return `${fold.languageId ?? "plain"}:${fold.type}:${fold.startIndex}:${fold.endIndex}`;
}

export function foldRangesEqual(left: readonly FoldRange[], right: readonly FoldRange[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    if (!foldRangeEqual(left[index]!, right[index]!)) return false;
  }

  return true;
}

export function projectSyntaxFoldsThroughLineEdit(
  folds: readonly FoldRange[],
  edit: TextEdit,
  previousText: string,
): SyntaxFoldProjection | null {
  const lineDelta = editLineDelta(edit, previousText);
  if (lineDelta === 0) return null;
  if (folds.length === 0) return null;

  const offsetDelta = edit.text.length - (edit.to - edit.from);
  const keyMap = new Map<string, string>();
  const projected = folds.map((fold) =>
    projectSyntaxFoldThroughLineEdit(fold, edit, offsetDelta, lineDelta, keyMap),
  );

  if (foldRangesEqual(folds, projected)) return null;
  return { folds: projected, keyMap };
}

function foldRangeEqual(left: FoldRange, right: FoldRange): boolean {
  return (
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex &&
    left.startLine === right.startLine &&
    left.endLine === right.endLine &&
    left.type === right.type &&
    left.languageId === right.languageId
  );
}

function projectSyntaxFoldThroughLineEdit(
  fold: FoldRange,
  edit: TextEdit,
  offsetDelta: number,
  lineDelta: number,
  keyMap: Map<string, string>,
): FoldRange {
  const projected = projectFoldRangeThroughLineEdit(fold, edit, offsetDelta, lineDelta);
  if (projected === fold) return fold;

  keyMap.set(foldRangeKey(fold), foldRangeKey(projected));
  return projected;
}

function projectFoldRangeThroughLineEdit(
  fold: FoldRange,
  edit: TextEdit,
  offsetDelta: number,
  lineDelta: number,
): FoldRange {
  if (edit.to <= fold.startIndex) return shiftFoldRange(fold, offsetDelta, lineDelta);
  if (edit.from >= fold.endIndex) return fold;
  if (edit.from > fold.startIndex && edit.to < fold.endIndex) {
    return resizeFoldRangeEnd(fold, offsetDelta, lineDelta);
  }

  return fold;
}

function shiftFoldRange(fold: FoldRange, offsetDelta: number, lineDelta: number): FoldRange {
  return {
    ...fold,
    startIndex: Math.max(0, fold.startIndex + offsetDelta),
    endIndex: Math.max(0, fold.endIndex + offsetDelta),
    startLine: Math.max(0, fold.startLine + lineDelta),
    endLine: Math.max(0, fold.endLine + lineDelta),
  };
}

function resizeFoldRangeEnd(fold: FoldRange, offsetDelta: number, lineDelta: number): FoldRange {
  return {
    ...fold,
    endIndex: Math.max(fold.startIndex + 1, fold.endIndex + offsetDelta),
    endLine: Math.max(fold.startLine + 1, fold.endLine + lineDelta),
  };
}

function editLineDelta(edit: TextEdit, previousText: string): number {
  const deletedText = previousText.slice(edit.from, edit.to);
  return countLineBreaks(edit.text) - countLineBreaks(deletedText);
}

function countLineBreaks(text: string): number {
  let count = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") count += 1;
  }

  return count;
}
