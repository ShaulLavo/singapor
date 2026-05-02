import {
  createAnchorSelection,
  createSelectionSet,
  normalizeSelectionSet,
  resolveSelection,
  type SelectionSet,
  type PieceTableAnchor,
  type PieceTableSnapshot,
} from "@editor/core";
import { selectWithTreeSitter } from "./treeSitter/workerClient";
import type {
  TreeSitterLanguageId,
  TreeSitterSelectionRange,
  TreeSitterSelectionResult,
} from "./treeSitter/types";

export type TreeSitterSelectionExpansionState = {
  readonly snapshotVersion: number;
  readonly stacks: readonly (readonly TreeSitterSelectionRange[])[];
};

export type TreeSitterSelectionCommandOptions = {
  readonly documentId: string;
  readonly languageId: TreeSitterLanguageId;
  readonly snapshotVersion: number;
  readonly snapshot: PieceTableSnapshot;
  readonly selections: SelectionSet<PieceTableAnchor>;
  readonly state?: TreeSitterSelectionExpansionState;
};

export type TreeSitterSelectionCommandResult = {
  readonly selections: SelectionSet<PieceTableAnchor>;
  readonly state: TreeSitterSelectionExpansionState;
  readonly status: "ok" | "stale";
};

export const selectTreeSitterToken = async (
  options: TreeSitterSelectionCommandOptions,
): Promise<TreeSitterSelectionCommandResult> => {
  const result = await requestSelectionRanges(options, "selectToken");
  return selectionCommandResult(options, result, (range) => [range]);
};

export const expandTreeSitterSelection = async (
  options: TreeSitterSelectionCommandOptions,
): Promise<TreeSitterSelectionCommandResult> => {
  const result = await requestSelectionRanges(options, "expand");
  return selectionCommandResult(options, result, (range, index) => {
    const stack = stackForSelection(options.state, index);
    const previous = stack.at(-1);
    if (previous && rangesEqual(previous, range)) return stack;
    return [...stack, range];
  });
};

export const shrinkTreeSitterSelection = (
  options: TreeSitterSelectionCommandOptions,
): TreeSitterSelectionCommandResult => {
  const ranges = rangesFromShrinkState(options);
  if (!ranges) return noOpSelectionCommandResult(options, "stale");

  return {
    selections: selectionSetFromRanges(options.snapshot, options.selections, ranges),
    state: {
      snapshotVersion: options.snapshotVersion,
      stacks: options.state!.stacks.map((stack) => stack.slice(0, -1)),
    },
    status: "ok",
  };
};

const requestSelectionRanges = (
  options: TreeSitterSelectionCommandOptions,
  action: "selectToken" | "expand",
): Promise<TreeSitterSelectionResult | undefined> =>
  selectWithTreeSitter({
    documentId: options.documentId,
    languageId: options.languageId,
    snapshotVersion: options.snapshotVersion,
    action,
    ranges: rangesFromSelectionSet(options.snapshot, options.selections),
  });

const selectionCommandResult = (
  options: TreeSitterSelectionCommandOptions,
  result: TreeSitterSelectionResult | undefined,
  nextStack: (
    range: TreeSitterSelectionRange,
    index: number,
  ) => readonly TreeSitterSelectionRange[],
): TreeSitterSelectionCommandResult => {
  if (!result || result.status === "stale") return noOpSelectionCommandResult(options, "stale");

  return {
    selections: selectionSetFromRanges(options.snapshot, options.selections, result.ranges),
    state: {
      snapshotVersion: options.snapshotVersion,
      stacks: result.ranges.map(nextStack),
    },
    status: "ok",
  };
};

const noOpSelectionCommandResult = (
  options: TreeSitterSelectionCommandOptions,
  status: "ok" | "stale",
): TreeSitterSelectionCommandResult => ({
  selections: options.selections,
  state: options.state ?? {
    snapshotVersion: options.snapshotVersion,
    stacks: rangesFromSelectionSet(options.snapshot, options.selections).map((range) => [range]),
  },
  status,
});

const rangesFromSelectionSet = (
  snapshot: PieceTableSnapshot,
  set: SelectionSet<PieceTableAnchor>,
): TreeSitterSelectionRange[] => {
  const normalized = normalizeSelectionSet(snapshot, set);
  return normalized.selections.map((selection) => {
    const resolved = resolveSelection(snapshot, selection);
    return {
      startIndex: resolved.startOffset,
      endIndex: resolved.endOffset,
    };
  });
};

const selectionSetFromRanges = (
  snapshot: PieceTableSnapshot,
  original: SelectionSet<PieceTableAnchor>,
  ranges: readonly TreeSitterSelectionRange[],
): SelectionSet<PieceTableAnchor> => {
  const selections = ranges.map((range, index) => {
    const source = original.selections[index];
    return createAnchorSelection(snapshot, range.startIndex, range.endIndex, {
      id: source?.id,
      reversed: false,
    });
  });

  return createSelectionSet(selections, true, snapshot);
};

const rangesFromShrinkState = (
  options: TreeSitterSelectionCommandOptions,
): readonly TreeSitterSelectionRange[] | null => {
  if (!options.state) return null;
  if (options.state.snapshotVersion !== options.snapshotVersion) return null;

  const ranges = options.state.stacks.map((stack) => stack.at(-2) ?? stack.at(-1));
  if (ranges.some((range) => !range)) return null;
  return ranges as readonly TreeSitterSelectionRange[];
};

const stackForSelection = (
  state: TreeSitterSelectionExpansionState | undefined,
  index: number,
): readonly TreeSitterSelectionRange[] => {
  const stack = state?.stacks[index];
  return stack ? [...stack] : [];
};

const rangesEqual = (left: TreeSitterSelectionRange, right: TreeSitterSelectionRange): boolean =>
  left.startIndex === right.startIndex && left.endIndex === right.endIndex;
