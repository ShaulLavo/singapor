import type { EditorVisibleRowSnapshot } from './plugins'
import { wordRangeAtOffset } from './textRanges'

export type OccurrenceHighlightRange = {
  readonly start: number
  readonly end: number
}

/**
 * Longest query worth painting. A caret inside a very long token would otherwise scan every visible
 * row for a string that can match almost nothing.
 */
const MAX_QUERY_LENGTH = 200

/**
 * The word under `caretOffset`, taken from the visible row that contains it.
 *
 * Rows carry their own text, so this never materializes the document — the reason the whole feature
 * is viewport-scoped rather than a full-buffer search on every caret move.
 */
export function occurrenceQueryAtCaret(
  rows: readonly EditorVisibleRowSnapshot[],
  caretOffset: number,
): string | null {
  const row = rowContainingOffset(rows, caretOffset)
  if (!row) return null

  const local = caretOffset - row.startOffset
  const range = wordRangeAtOffset(row.text, local)
  if (range.start === range.end) return null

  const query = row.text.slice(range.start, range.end)
  return query.length > MAX_QUERY_LENGTH ? null : query
}

/**
 * Whole-word occurrences of the caret's word across the mounted rows, in document offsets.
 *
 * Only the visible rows are searched: anything off-screen cannot be painted, and scanning the whole
 * buffer on every selection change is the cost this feature exists to avoid. Matches never span a
 * row because a word never contains a line break.
 */
export function occurrenceHighlightRanges(
  rows: readonly EditorVisibleRowSnapshot[],
  caretOffset: number,
): readonly OccurrenceHighlightRange[] {
  const query = occurrenceQueryAtCaret(rows, caretOffset)
  if (!query) return []

  const ranges: OccurrenceHighlightRange[] = []
  for (const row of rows) {
    if (!row.primaryText) continue

    appendRowOccurrences(ranges, row, query)
  }

  return ranges
}

function appendRowOccurrences(
  ranges: OccurrenceHighlightRange[],
  row: EditorVisibleRowSnapshot,
  query: string,
): void {
  let index = row.text.indexOf(query)
  while (index !== -1) {
    if (isWholeWordAt(row.text, index, query.length)) {
      ranges.push({ end: row.startOffset + index + query.length, start: row.startOffset + index })
    }
    index = row.text.indexOf(query, index + query.length)
  }
}

/**
 * A match counts only when it is the entire word at that position. Reusing the word-range helper
 * keeps one definition of a word boundary instead of a second character-class table that could
 * drift from it.
 */
function isWholeWordAt(text: string, index: number, length: number): boolean {
  const range = wordRangeAtOffset(text, index)
  return range.start === index && range.end === index + length
}

function rowContainingOffset(
  rows: readonly EditorVisibleRowSnapshot[],
  offset: number,
): EditorVisibleRowSnapshot | null {
  for (const row of rows) {
    if (!row.primaryText) continue
    if (offset < row.startOffset) continue
    if (offset > row.endOffset) continue

    return row
  }

  return null
}
