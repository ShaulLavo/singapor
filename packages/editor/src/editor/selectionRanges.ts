import type { DocumentSession } from '../documentSession'
import type { PieceTableSnapshot } from '../pieceTable/pieceTableTypes'
import type {
  EditorSelectionRange,
  EditorSelectionRangeContext,
  EditorSelectionRangeProvider,
} from '../plugins'
import { resolveSelection, type ResolvedSelection } from '../selections'
import type { EditorSyntaxLanguageId, FoldRange } from '../syntax/session'
import {
  clampTextOffsetRange,
  lineRangeAtOffset,
  nextWordPartOffset,
  previousWordPartOffset,
  wordRangeAtOffset,
  type TextOffsetRange,
} from '../textRanges'

export type SelectionRangeStoreOptions = {
  getSession(): DocumentSession | null
  getLanguageId(): EditorSyntaxLanguageId | null
  getSyntaxFolds(): readonly FoldRange[]
  getProviders(): readonly EditorSelectionRangeProvider[]
  setSelections(
    selections: readonly EditorSelectionRange[],
    timingName: string,
    revealOffset?: number,
  ): void
}

type SelectionRangeLadder = {
  readonly ranges: readonly TextOffsetRange[]
  readonly index: number
}

type SelectionRangeState = {
  readonly snapshot: PieceTableSnapshot
  readonly ladders: readonly SelectionRangeLadder[]
  readonly selections: readonly EditorSelectionRange[]
}

/**
 * Candidates a plain string can answer for, which is every buffer: subword and word. The whole
 * document closes the bucket so that the line steps interpolated below always have a rung above them
 * to fit under — including for a caret with no word around it, which then climbs line steps alone.
 */
const wordSelectionRanges: EditorSelectionRangeProvider = ({ text, offset }) => {
  const ranges: TextOffsetRange[] = [{ start: 0, end: text.length }]
  const word = wordRangeAtOffset(text, offset)
  if (word.start >= word.end) return ranges

  ranges.push(word)
  const part = wordPartRangeAtOffset(text, word, offset)
  if (part) ranges.push(part)

  return ranges
}

/**
 * The rungs a caret climbs, from the live selection outwards, each strictly containing the one
 * below it. Equal and merely-overlapping candidates are dropped rather than reconciled: a rung that
 * does not visibly grow the selection reads as a keypress that did nothing.
 */
function selectionRangeLadder(
  context: EditorSelectionRangeContext,
  providers: readonly EditorSelectionRangeProvider[],
): readonly TextOffsetRange[] {
  const { text, selection } = context
  const candidates = providers
    .flatMap((provider) => provider(context))
    .map((range) => clampTextOffsetRange(text, range))
    .filter((range) => containsRange(range, selection))
    .toSorted(innermostFirst)

  const chain: TextOffsetRange[] = [selection]
  for (const range of candidates) {
    const last = chain[chain.length - 1]
    if (last && containsRange(range, last) && !rangesEqual(range, last)) chain.push(range)
  }

  return chainWithLineSteps(text, chain)
}

export class SelectionRangeStore {
  private state: SelectionRangeState | null = null

  public constructor(private readonly options: SelectionRangeStoreOptions) {}

  public apply(direction: 'expand' | 'shrink'): boolean {
    const session = this.options.getSession()
    if (!session) return false

    const snapshot = session.getSnapshot()
    const resolved = session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection))
    if (resolved.length === 0) return false

    const ladders = this.laddersFor(session, snapshot, resolved, direction)
    if (!ladders) return false

    const step = direction === 'expand' ? 1 : -1
    const moved = ladders.map((ladder) => movedLadder(ladder, step))
    if (moved.every((ladder, index) => ladder === ladders[index])) return false

    const selections = moved.map((ladder, index) =>
      selectionRangeFrom(ladder, resolved[index]?.reversed ?? false),
    )
    this.state = { snapshot, ladders: moved, selections }
    this.options.setSelections(
      selections,
      direction === 'expand' ? 'editor.expandSelection' : 'editor.shrinkSelection',
      selections[0]?.head,
    )
    return true
  }

  /**
   * A ladder describes one caret over one revision of the text. Recognising the selections we last
   * wrote is what lets our own expansions keep climbing while a click elsewhere starts over; holding
   * out for the same snapshot as well is what stops an edit the caret never felt from being climbed
   * as if the rungs above it had not moved.
   */
  private laddersFor(
    session: DocumentSession,
    snapshot: PieceTableSnapshot,
    resolved: readonly ResolvedSelection[],
    direction: 'expand' | 'shrink',
  ): readonly SelectionRangeLadder[] | null {
    const state = this.state
    if (state && state.snapshot === snapshot && sameSelections(state.selections, resolved)) {
      return state.ladders
    }

    if (direction === 'shrink') return null

    const text = session.materializeFullText()
    const languageId = this.options.getLanguageId()
    const folds = this.options.getSyntaxFolds()
    const providers = [wordSelectionRanges, ...this.options.getProviders()]

    return resolved.map((selection) => ({
      ranges: selectionRangeLadder(
        {
          text,
          languageId,
          offset: selection.headOffset,
          selection: { start: selection.startOffset, end: selection.endOffset },
          folds,
        },
        providers,
      ),
      index: 0,
    }))
  }
}

/**
 * The subword the caret sits in, bounded by the word around it.
 *
 * Reusing the boundaries subword motion moves over keeps the two features from disagreeing about
 * where a subword begins, and lands the caret on the right-hand part when it sits exactly on a
 * boundary — the part it would move into next.
 */
function wordPartRangeAtOffset(
  text: string,
  word: TextOffsetRange,
  offset: number,
): TextOffsetRange | null {
  const start = Math.max(word.start, previousWordPartOffset(text, Math.min(offset + 1, word.end)))
  const end = Math.min(word.end, nextWordPartOffset(text, start))

  return start < end ? { start, end } : null
}

/**
 * The two steps a reader expects whenever a rung jumps onto lines the one below it did not cover:
 * the covered lines without their surrounding whitespace, then those lines whole.
 *
 * They are interpolated rather than offered as candidates so that a chain of ranges sharing a line
 * — everything a grammar contributes inside one statement — never has a line step wedged into it.
 */
function chainWithLineSteps(
  text: string,
  chain: readonly TextOffsetRange[],
): readonly TextOffsetRange[] {
  const first = chain[0]
  if (!first) return chain

  const stepped: TextOffsetRange[] = [first]
  for (let index = 1; index < chain.length; index += 1) {
    const previous = chain[index - 1]
    const current = chain[index]
    if (!previous || !current) continue

    if (!sameLines(text, previous, current)) {
      pushLineStep(stepped, lineContentRange(text, previous), current)
      pushLineStep(stepped, wholeLineRange(text, previous), current)
    }
    stepped.push(current)
  }

  return stepped
}

function pushLineStep(
  stepped: TextOffsetRange[],
  step: TextOffsetRange,
  current: TextOffsetRange,
): void {
  const last = stepped[stepped.length - 1]
  if (!last) return
  if (!containsRange(step, last) || rangesEqual(step, last)) return
  if (!containsRange(current, step) || rangesEqual(current, step)) return

  stepped.push(step)
}

function lineContentRange(text: string, range: TextOffsetRange): TextOffsetRange {
  const first = lineRangeAtOffset(text, range.start)
  const last = lineRangeAtOffset(text, range.end)

  return { start: firstNonWhitespaceOffset(text, first), end: lastNonWhitespaceOffset(text, last) }
}

function wholeLineRange(text: string, range: TextOffsetRange): TextOffsetRange {
  return {
    start: lineRangeAtOffset(text, range.start).start,
    end: lineRangeAtOffset(text, range.end).end,
  }
}

function firstNonWhitespaceOffset(text: string, line: TextOffsetRange): number {
  let offset = line.start
  while (offset < line.end && isWhitespace(text[offset])) offset += 1
  return offset
}

function lastNonWhitespaceOffset(text: string, line: TextOffsetRange): number {
  let offset = line.end
  while (offset > line.start && isWhitespace(text[offset - 1])) offset -= 1
  return offset
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && character.trim() === ''
}

function sameLines(text: string, left: TextOffsetRange, right: TextOffsetRange): boolean {
  return (
    lineRangeAtOffset(text, left.start).start === lineRangeAtOffset(text, right.start).start &&
    lineRangeAtOffset(text, left.end).start === lineRangeAtOffset(text, right.end).start
  )
}

/** Innermost first — latest start, then shortest — so one pass over candidates only ever grows. */
function innermostFirst(left: TextOffsetRange, right: TextOffsetRange): number {
  return right.start - left.start || left.end - right.end
}

function containsRange(outer: TextOffsetRange, inner: TextOffsetRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end
}

function rangesEqual(left: TextOffsetRange, right: TextOffsetRange): boolean {
  return left.start === right.start && left.end === right.end
}

function movedLadder(ladder: SelectionRangeLadder, step: number): SelectionRangeLadder {
  const index = ladder.index + step
  if (index < 0 || index >= ladder.ranges.length) return ladder

  return { ranges: ladder.ranges, index }
}

function selectionRangeFrom(ladder: SelectionRangeLadder, reversed: boolean): EditorSelectionRange {
  const range = ladder.ranges[ladder.index] ?? { start: 0, end: 0 }

  return reversed
    ? { anchor: range.end, head: range.start }
    : { anchor: range.start, head: range.end }
}

function sameSelections(
  written: readonly EditorSelectionRange[],
  resolved: readonly ResolvedSelection[],
): boolean {
  if (written.length !== resolved.length) return false

  return written.every(
    (selection, index) =>
      selection.anchor === resolved[index]?.anchorOffset &&
      selection.head === resolved[index]?.headOffset,
  )
}
