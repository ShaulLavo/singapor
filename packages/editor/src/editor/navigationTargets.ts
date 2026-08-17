import type { TextSnapshot } from '../documentTextSnapshot'
import type { PieceTableSnapshot } from '../pieceTable/pieceTableTypes'
import { offsetToPoint, pointToOffset } from '../pieceTable/positions'
import { SelectionGoal, type ResolvedSelection } from '../selections'
import {
  nextCodePointOffset,
  nextWordOffset,
  nextWordPartOffset,
  nextWordStartOffset,
  previousCodePointOffset,
  previousWordEndOffset,
  previousWordOffset,
  previousWordPartOffset,
} from '../textRanges'
import type { EditorCommandId } from './commands'

export type NavigationTarget = {
  readonly offset: number
  readonly extend: boolean
  readonly goal?: SelectionGoal
  readonly timingName: string
}

/** One buffer line and the document offset it starts at, so a scan can report absolute offsets. */
export type NavigationLine = {
  readonly text: string
  readonly start: number
}

type NavigationLineReader = (offset: number) => NavigationLine

type VisualColumnView = {
  readonly visualColumnForOffset: (offset: number) => number
}

type LineBoundaryView = {
  readonly offsetAtLineBoundary: (offset: number, boundary: 'start' | 'end') => number
}

type NavigationTargetView = VisualColumnView &
  LineBoundaryView & {
    readonly offsetByDisplayRows: (offset: number, rowDelta: number, goalColumn: number) => number
    readonly pageRowDelta: () => number
  }

type NavigationTargetContext = {
  readonly command: EditorCommandId
  readonly resolved: ResolvedSelection
  readonly readLine: NavigationLineReader
  readonly documentLength: number
  readonly wordSeparators?: string
  readonly view: NavigationTargetView
}

// A column past the end of every line: asking for it yields the line's end, and a caret carrying
// it as its goal rides the ragged right edge down the file instead of snapping to one line's width.
const PAST_LINE_END_COLUMN = Number.MAX_SAFE_INTEGER

/**
 * Reads the single line an offset falls on, so caret motion never scales with the file.
 *
 * The cache deliberately spans one command and no longer: several selections moving together
 * usually share a line, while the next command arrives over a snapshot this one cannot see.
 */
export function createNavigationLineReader(
  snapshot: PieceTableSnapshot,
  textSnapshot: TextSnapshot,
): NavigationLineReader {
  let cached: NavigationLine | null = null

  return (offset) => {
    if (cached && offset >= cached.start && offset <= cached.start + cached.text.length) {
      return cached
    }

    const point = offsetToPoint(snapshot, offset)
    const start = offset - point.column
    const end = pointToOffset(snapshot, { row: point.row, column: PAST_LINE_END_COLUMN })
    cached = { start, text: textSnapshot.readRange(start, end) }
    return cached
  }
}

export function navigationTargetForCommand(
  context: NavigationTargetContext,
): NavigationTarget | null {
  const target = commandNavigationTarget(context)
  if (!target) return null

  return renderedRowTarget(context, target)
}

/**
 * Pulls an offset back onto a row that is drawn.
 *
 * The rows a collapsed region swallowed are drawn nowhere, so the row that answers for an offset on
 * one of them is the region's header, and it ends before that offset does. A caret left beyond that
 * end draws on the header while addressing text no row shows: it reads as a caret that refused to
 * move, and the next keystroke edits where the user cannot watch it happen.
 */
export function renderedRowCaretOffset(view: LineBoundaryView, offset: number): number {
  const rowEnd = view.offsetAtLineBoundary(offset, 'end')
  return rowEnd < offset ? rowEnd : offset
}

/**
 * A move heading forward crosses the whole region rather than stopping on its header, so holding the
 * key keeps making progress through the file. Everything else — and a forward move with no row left
 * beyond the region — settles onto the header, the last row the caret was visibly on.
 */
function renderedRowTarget(
  context: NavigationTargetContext,
  target: NavigationTarget,
): NavigationTarget {
  const rendered = renderedRowCaretOffset(context.view, target.offset)
  if (rendered === target.offset) return target
  if (target.offset <= context.resolved.headOffset) return { ...target, offset: rendered }

  const beyondRegion = context.view.offsetByDisplayRows(target.offset, 1, 0)
  return { ...target, offset: beyondRegion > target.offset ? beyondRegion : rendered }
}

function commandNavigationTarget(context: NavigationTargetContext): NavigationTarget | null {
  const { command, resolved } = context
  if (command === 'cursorLeft') return horizontalTarget(context, 'left', false)
  if (command === 'cursorRight') return horizontalTarget(context, 'right', false)
  if (command === 'selectLeft') return horizontalTarget(context, 'left', true)
  if (command === 'selectRight') return horizontalTarget(context, 'right', true)
  if (command === 'cursorWordLeft') return wordTarget(context, 'left', false)
  if (command === 'cursorWordRight') return wordTarget(context, 'right', false)
  if (command === 'cursorWordPartLeft') return wordPartTarget(context, 'left', false)
  if (command === 'cursorWordPartRight') return wordPartTarget(context, 'right', false)
  if (command === 'cursorWordPartLeftSelect') return wordPartTarget(context, 'left', true)
  if (command === 'cursorWordPartRightSelect') return wordPartTarget(context, 'right', true)
  if (command === 'selectWordLeft') return wordTarget(context, 'left', true)
  if (command === 'selectWordRight') return wordTarget(context, 'right', true)
  if (command === 'cursorUp') return verticalTarget(context, -1, false, 'input.cursorUp')
  if (command === 'cursorDown') return verticalTarget(context, 1, false, 'input.cursorDown')
  if (command === 'selectUp') return verticalTarget(context, -1, true, 'input.selectUp')
  if (command === 'selectDown') return verticalTarget(context, 1, true, 'input.selectDown')

  return boundaryNavigationTarget(context, resolved)
}

function horizontalTarget(
  context: NavigationTargetContext,
  direction: 'left' | 'right',
  extend: boolean,
): NavigationTarget {
  const { resolved } = context
  const collapsedOffset = direction === 'left' ? resolved.startOffset : resolved.endOffset
  const shouldMoveHead = extend || resolved.collapsed
  const offset = shouldMoveHead
    ? codePointOffset(context, resolved.headOffset, direction)
    : collapsedOffset

  return {
    offset,
    extend,
    timingName: extend
      ? `input.select${capitalize(direction)}`
      : `input.cursor${capitalize(direction)}`,
  }
}

function wordTarget(
  context: NavigationTargetContext,
  direction: 'left' | 'right',
  extend: boolean,
): NavigationTarget {
  const line = context.readLine(context.resolved.headOffset)
  const column = context.resolved.headOffset - line.start
  const offset =
    direction === 'left'
      ? previousWordOffset(line.text, column, context.wordSeparators)
      : nextWordOffset(line.text, column, context.wordSeparators)

  return {
    offset: line.start + offset,
    extend,
    timingName: extend
      ? `input.selectWord${capitalize(direction)}`
      : `input.cursorWord${capitalize(direction)}`,
  }
}

function wordPartTarget(
  context: NavigationTargetContext,
  direction: 'left' | 'right',
  extend: boolean,
): NavigationTarget {
  const line = context.readLine(context.resolved.headOffset)
  const column = context.resolved.headOffset - line.start

  return {
    extend,
    offset: line.start + wordPartColumn(line.text, column, direction, context.wordSeparators),
    timingName: extend
      ? `input.selectWordPart${capitalize(direction)}`
      : `input.cursorWordPart${capitalize(direction)}`,
  }
}

/**
 * Word motion bounds the subword scanner, never the other way round.
 *
 * The scanner only understands identifier shape, so left to itself it walks through whitespace and
 * punctuation hunting for the next camel hump. Taking whichever candidate is nearest the caret
 * lets it shorten a word move but never overshoot one.
 */
function wordPartColumn(
  line: string,
  column: number,
  direction: 'left' | 'right',
  separators: string | undefined,
): number {
  if (direction === 'left') {
    return Math.max(
      previousWordPartOffset(line, column),
      previousWordOffset(line, column, separators),
      previousWordEndOffset(line, column, separators),
    )
  }

  return Math.min(nextWordPartOffset(line, column), nextWordStartOffset(line, column, separators))
}

function verticalTarget(
  context: NavigationTargetContext,
  rowDelta: number,
  extend: boolean,
  timingName: string,
): NavigationTarget {
  const origin = verticalOriginOffset(context, rowDelta, extend)
  const { goal, column } = verticalMoveGoal(context.resolved.goal, origin, context.view)
  return {
    offset: context.view.offsetByDisplayRows(origin, rowDelta, column),
    extend,
    goal,
    timingName,
  }
}

/**
 * Up and Down without Shift leave a selection from the edge they are heading towards, the way
 * every native text control does; only an extending move keeps pivoting on the head.
 */
function verticalOriginOffset(
  context: NavigationTargetContext,
  rowDelta: number,
  extend: boolean,
): number {
  const { resolved } = context
  if (extend || resolved.collapsed) return resolved.headOffset
  return rowDelta < 0 ? resolved.startOffset : resolved.endOffset
}

function boundaryNavigationTarget(
  context: NavigationTargetContext,
  resolved: ResolvedSelection,
): NavigationTarget | null {
  const { command } = context
  if (command === 'cursorLineStart') return lineBoundaryTarget(context, 'start', false)
  if (command === 'cursorLineEnd') return lineBoundaryTarget(context, 'end', false)
  if (command === 'selectLineStart') return lineBoundaryTarget(context, 'start', true)
  if (command === 'selectLineEnd') return lineBoundaryTarget(context, 'end', true)
  if (command === 'cursorDocumentStart') return documentBoundaryTarget(context, 'start', false)
  if (command === 'cursorDocumentEnd') return documentBoundaryTarget(context, 'end', false)
  if (command === 'selectDocumentStart') return documentBoundaryTarget(context, 'start', true)
  if (command === 'selectDocumentEnd') return documentBoundaryTarget(context, 'end', true)
  if (command === 'cursorPageUp') return pageTarget(context, resolved, -1, false)
  if (command === 'cursorPageDown') return pageTarget(context, resolved, 1, false)
  if (command === 'selectPageUp') return pageTarget(context, resolved, -1, true)
  if (command === 'selectPageDown') return pageTarget(context, resolved, 1, true)
  return null
}

function lineBoundaryTarget(
  context: NavigationTargetContext,
  boundary: 'start' | 'end',
  extend: boolean,
): NavigationTarget {
  const head = context.resolved.headOffset
  return {
    offset:
      boundary === 'start'
        ? lineStartTargetOffset(context)
        : context.view.offsetAtLineBoundary(head, 'end'),
    extend,
    goal: boundary === 'end' ? SelectionGoal.lineEnd() : undefined,
    timingName: extend
      ? `input.selectLine${capitalize(boundary)}`
      : `input.cursorLine${capitalize(boundary)}`,
  }
}

/**
 * Home reaches the first non-blank character before it reaches the margin, so the start of an
 * indented statement is one press away and column zero stays one press further.
 *
 * A wrapped continuation row carries no indentation of its own and a blank line has nothing to
 * escalate to, so both offer only their own start.
 */
function lineStartTargetOffset(context: NavigationTargetContext): number {
  const head = context.resolved.headOffset
  const rowStart = context.view.offsetAtLineBoundary(head, 'start')
  const line = context.readLine(head)
  if (rowStart > line.start) return rowStart

  const indent = line.text.search(/\S/u)
  if (indent <= 0) return line.start

  const firstNonBlank = line.start + indent
  return head === firstNonBlank ? line.start : firstNonBlank
}

function documentBoundaryTarget(
  context: NavigationTargetContext,
  boundary: 'start' | 'end',
  extend: boolean,
): NavigationTarget {
  return {
    offset: boundary === 'start' ? 0 : context.documentLength,
    extend,
    timingName: extend
      ? `input.selectDocument${capitalize(boundary)}`
      : `input.cursorDocument${capitalize(boundary)}`,
  }
}

function pageTarget(
  context: NavigationTargetContext,
  resolved: ResolvedSelection,
  direction: -1 | 1,
  extend: boolean,
): NavigationTarget {
  const rowDelta = direction * context.view.pageRowDelta()
  const { goal, column } = verticalMoveGoal(resolved.goal, resolved.headOffset, context.view)
  return {
    offset: context.view.offsetByDisplayRows(resolved.headOffset, rowDelta, column),
    extend,
    goal,
    timingName: pageTimingName(direction, extend),
  }
}

/**
 * Where a vertical move aims, and the goal it hands to the selection it produces.
 *
 * A run of Up/Down presses has to keep aiming at the column the run started from, so a goal the
 * selection already holds outlives the move and only a selection without one adopts the caret's
 * column. Every kind names its column here because a kind that did not would be answered with the
 * caret's own, discarding the goal the run is built on without anything failing.
 */
export function verticalMoveGoal(
  goal: SelectionGoal,
  offset: number,
  view: VisualColumnView,
): { readonly goal: SelectionGoal; readonly column: number } {
  switch (goal.kind) {
    case 'horizontal':
      return { goal, column: goal.x }
    case 'lineEnd':
      return { goal, column: PAST_LINE_END_COLUMN }
    case 'none': {
      const column = view.visualColumnForOffset(offset)
      return { goal: SelectionGoal.horizontal(column), column }
    }
    default:
      return unhandledSelectionGoal(goal)
  }
}

function unhandledSelectionGoal(goal: never): never {
  throw new Error(`unhandled selection goal: ${JSON.stringify(goal)}`)
}

function pageTimingName(direction: -1 | 1, extend: boolean): string {
  if (extend) return direction < 0 ? 'input.selectPageUp' : 'input.selectPageDown'
  return direction < 0 ? 'input.cursorPageUp' : 'input.cursorPageDown'
}

function codePointOffset(
  context: NavigationTargetContext,
  offset: number,
  direction: 'left' | 'right',
): number {
  const line = context.readLine(offset)
  const column = offset - line.start

  // At either edge the neighbouring character is the line break, which the buffer stores as one
  // character, so stepping over it needs no line of its own to be read.
  if (direction === 'left') {
    if (column === 0) return Math.max(0, offset - 1)
    return line.start + previousCodePointOffset(line.text, column)
  }

  if (column >= line.text.length) return Math.min(context.documentLength, offset + 1)
  return line.start + nextCodePointOffset(line.text, column)
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}
