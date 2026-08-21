import type { DocumentSessionChange } from '../documentSession'
import type { ResolvedSelection } from '../selections'
import { isWholeWordRange, wordRangeAtOffset } from '../textRanges'

export type ExactOccurrenceRange = {
  readonly start: number
  readonly end: number
}

export type OccurrenceSelectionChange = {
  readonly change: DocumentSessionChange
  readonly revealOffset: number
}

export type OccurrenceQuery = {
  readonly query: string
  readonly range: ExactOccurrenceRange
}

export function occurrenceQueryForSelection(
  text: string,
  selection: ResolvedSelection,
): OccurrenceQuery | null {
  if (!selection.collapsed) {
    const query = text.slice(selection.startOffset, selection.endOffset)
    if (query.length === 0) return null
    return { query, range: { start: selection.startOffset, end: selection.endOffset } }
  }

  const range = wordRangeAtOffset(text, selection.headOffset)
  if (range.start === range.end) return null
  return { query: text.slice(range.start, range.end), range }
}

export function findAllExactOccurrences(
  text: string,
  query: string,
): readonly ExactOccurrenceRange[] {
  if (query.length === 0) return []

  const ranges: ExactOccurrenceRange[] = []
  let index = text.indexOf(query)
  while (index !== -1) {
    ranges.push({ start: index, end: index + query.length })
    index = text.indexOf(query, index + query.length)
  }
  return ranges
}

export function findNextExactOccurrenceFromRange(
  text: string,
  query: string,
  selected: readonly ExactOccurrenceRange[],
  range: ExactOccurrenceRange,
  wholeWord = false,
): ExactOccurrenceRange | null {
  if (query.length === 0) return null

  return (
    findExactOccurrenceFrom(text, query, selected, wholeWord, range.end) ??
    findExactOccurrenceFrom(text, query, selected, wholeWord, 0, range.end)
  )
}

export function occurrenceSelectTimingName(
  command: 'editor.action.selectHighlights' | 'editor.action.changeAll',
): string {
  if (command === 'editor.action.selectHighlights') return 'input.selectHighlights'
  return 'input.changeAll'
}

function findExactOccurrenceFrom(
  text: string,
  query: string,
  selected: readonly ExactOccurrenceRange[],
  wholeWord: boolean,
  start: number,
  end = text.length,
): ExactOccurrenceRange | null {
  let index = text.indexOf(query, start)

  while (index !== -1 && index < end) {
    const range = { start: index, end: index + query.length }
    const claimed = selected.some((selection) => rangesOverlap(selection, range))
    if (!claimed && (!wholeWord || isWholeWordRange(text, range))) return range
    index = text.indexOf(query, index + 1)
  }

  return null
}

function rangesOverlap(left: ExactOccurrenceRange, right: ExactOccurrenceRange): boolean {
  return left.start < right.end && right.start < left.end
}
