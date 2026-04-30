import { SelectionGoal, type ResolvedSelection } from "../selections";
import type { EditorCommandId } from "./commands";
import {
  nextCodePointOffset,
  nextWordOffset,
  previousCodePointOffset,
  previousWordOffset,
} from "./navigation";

export type NavigationTarget = {
  readonly offset: number;
  readonly extend: boolean;
  readonly goal?: ReturnType<typeof SelectionGoal.horizontal>;
  readonly timingName: string;
};

type NavigationTargetView = {
  readonly offsetAtLineBoundary: (offset: number, boundary: "start" | "end") => number;
  readonly offsetByDisplayRows: (offset: number, rowDelta: number, goalColumn: number) => number;
  readonly pageRowDelta: () => number;
  readonly visualColumnForOffset: (offset: number) => number;
};

type NavigationTargetContext = {
  readonly command: EditorCommandId;
  readonly resolved: ResolvedSelection;
  readonly text: string;
  readonly documentLength: number;
  readonly view: NavigationTargetView;
};

export function navigationTargetForCommand(
  context: NavigationTargetContext,
): NavigationTarget | null {
  const { command, resolved } = context;
  if (command === "cursorLeft") return horizontalTarget(context, "left", false);
  if (command === "cursorRight") return horizontalTarget(context, "right", false);
  if (command === "selectLeft") return horizontalTarget(context, "left", true);
  if (command === "selectRight") return horizontalTarget(context, "right", true);
  if (command === "cursorWordLeft") return wordTarget(context, "left", false);
  if (command === "cursorWordRight") return wordTarget(context, "right", false);
  if (command === "selectWordLeft") return wordTarget(context, "left", true);
  if (command === "selectWordRight") return wordTarget(context, "right", true);
  if (command === "cursorUp") return verticalTarget(context, -1, false, "input.cursorUp");
  if (command === "cursorDown") return verticalTarget(context, 1, false, "input.cursorDown");
  if (command === "selectUp") return verticalTarget(context, -1, true, "input.selectUp");
  if (command === "selectDown") return verticalTarget(context, 1, true, "input.selectDown");

  return boundaryNavigationTarget(context, resolved);
}

function horizontalTarget(
  context: NavigationTargetContext,
  direction: "left" | "right",
  extend: boolean,
): NavigationTarget {
  const { resolved, text } = context;
  const collapsedOffset = direction === "left" ? resolved.startOffset : resolved.endOffset;
  const shouldMoveHead = extend || resolved.collapsed;
  const offset = shouldMoveHead
    ? codePointOffset(text, resolved.headOffset, direction)
    : collapsedOffset;

  return {
    offset,
    extend,
    timingName: extend
      ? `input.select${capitalize(direction)}`
      : `input.cursor${capitalize(direction)}`,
  };
}

function wordTarget(
  context: NavigationTargetContext,
  direction: "left" | "right",
  extend: boolean,
): NavigationTarget {
  const offset =
    direction === "left"
      ? previousWordOffset(context.text, context.resolved.headOffset)
      : nextWordOffset(context.text, context.resolved.headOffset);

  return {
    offset,
    extend,
    timingName: extend
      ? `input.selectWord${capitalize(direction)}`
      : `input.cursorWord${capitalize(direction)}`,
  };
}

function verticalTarget(
  context: NavigationTargetContext,
  rowDelta: number,
  extend: boolean,
  timingName: string,
): NavigationTarget {
  const goalColumn = navigationGoalColumn(context);
  return {
    offset: context.view.offsetByDisplayRows(context.resolved.headOffset, rowDelta, goalColumn),
    extend,
    goal: SelectionGoal.horizontal(goalColumn),
    timingName,
  };
}

function boundaryNavigationTarget(
  context: NavigationTargetContext,
  resolved: ResolvedSelection,
): NavigationTarget | null {
  const { command } = context;
  if (command === "cursorLineStart") return lineBoundaryTarget(context, "start", false);
  if (command === "cursorLineEnd") return lineBoundaryTarget(context, "end", false);
  if (command === "selectLineStart") return lineBoundaryTarget(context, "start", true);
  if (command === "selectLineEnd") return lineBoundaryTarget(context, "end", true);
  if (command === "cursorDocumentStart") return documentBoundaryTarget(context, "start", false);
  if (command === "cursorDocumentEnd") return documentBoundaryTarget(context, "end", false);
  if (command === "selectDocumentStart") return documentBoundaryTarget(context, "start", true);
  if (command === "selectDocumentEnd") return documentBoundaryTarget(context, "end", true);
  if (command === "cursorPageUp") return pageTarget(context, resolved, -1, false);
  if (command === "cursorPageDown") return pageTarget(context, resolved, 1, false);
  if (command === "selectPageUp") return pageTarget(context, resolved, -1, true);
  if (command === "selectPageDown") return pageTarget(context, resolved, 1, true);
  return null;
}

function lineBoundaryTarget(
  context: NavigationTargetContext,
  boundary: "start" | "end",
  extend: boolean,
): NavigationTarget {
  return {
    offset: context.view.offsetAtLineBoundary(context.resolved.headOffset, boundary),
    extend,
    timingName: extend
      ? `input.selectLine${capitalize(boundary)}`
      : `input.cursorLine${capitalize(boundary)}`,
  };
}

function documentBoundaryTarget(
  context: NavigationTargetContext,
  boundary: "start" | "end",
  extend: boolean,
): NavigationTarget {
  return {
    offset: boundary === "start" ? 0 : context.documentLength,
    extend,
    timingName: extend
      ? `input.selectDocument${capitalize(boundary)}`
      : `input.cursorDocument${capitalize(boundary)}`,
  };
}

function pageTarget(
  context: NavigationTargetContext,
  resolved: ResolvedSelection,
  direction: -1 | 1,
  extend: boolean,
): NavigationTarget {
  const rowDelta = direction * context.view.pageRowDelta();
  const goalColumn = navigationGoalColumn(context);
  return {
    offset: context.view.offsetByDisplayRows(resolved.headOffset, rowDelta, goalColumn),
    extend,
    goal: SelectionGoal.horizontal(goalColumn),
    timingName: pageTimingName(direction, extend),
  };
}

function navigationGoalColumn(context: NavigationTargetContext): number {
  if (context.resolved.goal.kind === "horizontal") return context.resolved.goal.x;
  return context.view.visualColumnForOffset(context.resolved.headOffset);
}

function pageTimingName(direction: -1 | 1, extend: boolean): string {
  if (extend) return direction < 0 ? "input.selectPageUp" : "input.selectPageDown";
  return direction < 0 ? "input.cursorPageUp" : "input.cursorPageDown";
}

function codePointOffset(text: string, offset: number, direction: "left" | "right"): number {
  if (direction === "left") return previousCodePointOffset(text, offset);
  return nextCodePointOffset(text, offset);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
