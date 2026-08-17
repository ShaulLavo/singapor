import { normalizeTabSize, visualColumnLength } from '../displayTransforms'
import type { ResolvedSelection } from '../selections'
import type { TextEdit } from '../tokens'
import type { EditorCommandId } from './commands'
import type { EditorEditActionOptions, EditorEditActionResult } from './editActions'
import { leadingWhitespace } from './indentation'
import {
  editorLanguageConfiguration,
  matches,
  type EditorIndentationRules,
  type EditorLanguageConfiguration,
} from './languageConfiguration'

/**
 * Rewriting the indentation of whole rows from the language's indentation rules.
 *
 * Indenting answers "one level in from wherever this row is"; these commands answer "where does this
 * row belong", which only the rules can say. That is the gesture that cleans up after a paste, and
 * the two differ on every row that was already wrong.
 *
 * A row's level is read off the row above it, so a delimiter that is really the content of a string
 * or a comment does not move one row, it moves every row under it. The rules are patterns over a
 * line's text and nothing in them can tell content from code, so the text they are matched against
 * has every literal blanked out first. The parse cannot be what draws that line: its captures are
 * retained only while something else asks for them and they land a frame behind the edit, and a
 * command that rewrites a file must not be correct only when a highlighter happens to be installed.
 */

export type EditorDocumentSelectionEditCommandId =
  | 'editor.action.reindentlines'
  | 'editor.action.reindentselectedlines'

type OffsetRange = {
  readonly start: number
  readonly end: number
}

type RowRange = {
  readonly startRow: number
  readonly endRow: number
}

/** The document twice over: as written, and as the indentation rules are allowed to see it. */
type ReindentSource = {
  readonly text: string
  /** Same length and same row starts as `text`, with every string and comment blanked out. */
  readonly maskedText: string
  readonly starts: readonly number[]
  /** Rows whose first character is inside a literal, where the indentation is content, not layout. */
  readonly rowsInsideLiteral: ReadonlySet<number>
}

export function isEditorDocumentSelectionEditCommand(
  command: EditorCommandId,
): command is EditorDocumentSelectionEditCommandId {
  return (
    command === 'editor.action.reindentlines' || command === 'editor.action.reindentselectedlines'
  )
}

export function documentSelectionEditForCommand(
  command: EditorDocumentSelectionEditCommandId,
  text: string,
  selections: readonly ResolvedSelection[],
  options: EditorEditActionOptions = {},
): EditorEditActionResult {
  const wholeDocument = command === 'editor.action.reindentlines'
  const timingName = wholeDocument ? 'editor.reindentLines' : 'editor.reindentSelectedLines'
  const configuration = editorLanguageConfiguration(options.languageId)
  const rules = configuration?.indentationRules
  // A language that never described how its lines nest has no answer here, and a guessed one would
  // move rows for a reason the user has no way to inspect.
  if (!rules) return { edits: [], timingName }

  const source = createReindentSource(text, configuration)
  const ranges = wholeDocument
    ? [{ endRow: lastRow(source), startRow: 0 }]
    : rowRangesForSelections(source, selections)

  return {
    edits: ranges.flatMap((range) => reindentEdits(source, rules, range, options)),
    timingName,
  }
}

function createReindentSource(
  text: string,
  configuration: EditorLanguageConfiguration | null,
): ReindentSource {
  const starts = [0]

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue
    starts.push(index + 1)
  }

  return { ...maskLiterals(text, configuration), starts, text }
}

/**
 * Blanks every string and comment, delimiters included.
 *
 * Blanking rather than cutting keeps both copies of the document addressable by the same offsets.
 * The delimiters go too: a line comment's own marker is what a rule written to skip commented
 * delimiters is looking for, and once the comment is gone there is nothing left for it to skip.
 *
 * A quoted run may cross line breaks, because a template literal is written that way and the braces
 * inside one must not drive the indentation of the rows it spans — reindent would otherwise rewrite
 * the string's own contents. A run that never closes falls back to ending at its line break: an
 * unbalanced delimiter is more often an apostrophe than the start of a literal, and one of those
 * must not swallow the rest of the file.
 */
function maskLiterals(
  text: string,
  configuration: EditorLanguageConfiguration | null,
): Pick<ReindentSource, 'maskedText' | 'rowsInsideLiteral'> {
  const quotes = new Set(
    (configuration?.autoClosingPairs ?? [])
      .filter((pair) => pair.quote === true)
      .map((pair) => pair.open),
  )
  const lineComment = configuration?.comments?.line
  const blockComment = configuration?.comments?.block
  const literals: OffsetRange[] = []
  const rowsInsideLiteral = new Set<number>()
  let row = 0
  let index = 0

  while (index < text.length) {
    const start = index
    if (text[index] === '\n') {
      row += 1
      index += 1
      continue
    }

    if (blockComment && text.startsWith(blockComment.open, index)) {
      index = offsetPast(text, index + blockComment.open.length, blockComment.close)
    } else if (lineComment && text.startsWith(lineComment, index)) {
      index = lineBreakFrom(text, index)
    } else if (quotes.has(text[index] ?? '')) {
      index = offsetPastQuoted(text, index, text[index] ?? '')
    } else {
      index += 1
      continue
    }

    literals.push({ end: index, start })
    for (let offset = start; offset < index; offset += 1) {
      if (text[offset] !== '\n') continue
      row += 1
      rowsInsideLiteral.add(row)
    }
  }

  return { maskedText: blankRanges(text, literals), rowsInsideLiteral }
}

/** Just past `token`, or the end of the text for a literal nothing closes. */
function offsetPast(text: string, from: number, token: string): number {
  const found = text.indexOf(token, from)

  return found === -1 ? text.length : found + token.length
}

function lineBreakFrom(text: string, from: number): number {
  const found = text.indexOf('\n', from)

  return found === -1 ? text.length : found
}

function offsetPastQuoted(text: string, from: number, quote: string): number {
  for (let index = from + quote.length; index < text.length; index += 1) {
    const char = text[index]
    // An escaped delimiter is content, and so is whatever the escape was hiding.
    if (char === '\\') index += 1
    else if (char === quote) return index + 1
  }

  return lineBreakFrom(text, from)
}

function blankRanges(text: string, ranges: readonly OffsetRange[]): string {
  if (ranges.length === 0) return text

  let masked = ''
  let cursor = 0
  for (const range of ranges) {
    // Row starts have to survive, so the break is the one character a literal keeps.
    masked +=
      text.slice(cursor, range.start) + text.slice(range.start, range.end).replace(/[^\n]/g, ' ')
    cursor = range.end
  }

  return masked + text.slice(cursor)
}

/**
 * The row ranges the selections ask to have made consistent.
 *
 * Each range reaches one row further up than the selection does, because the first selected row's own
 * level is only decided by the row above it — without that row the range would be measured from a
 * row the user is asking to have corrected. A caret on the first row of the document has nothing
 * above it and nothing selected below it, so it asks for nothing.
 */
function rowRangesForSelections(
  source: ReindentSource,
  selections: readonly ResolvedSelection[],
): readonly RowRange[] {
  const ranges = selections
    .map((selection) => rowRangeForSelection(source, selection))
    .filter((range): range is RowRange => range !== null)
  const merged: RowRange[] = []

  for (const range of ranges.toSorted((left, right) => left.startRow - right.startRow)) {
    const previous = merged[merged.length - 1]
    if (!previous || range.startRow > previous.endRow + 1) {
      merged.push(range)
      continue
    }

    merged[merged.length - 1] = {
      endRow: Math.max(previous.endRow, range.endRow),
      startRow: previous.startRow,
    }
  }

  return merged
}

function rowRangeForSelection(
  source: ReindentSource,
  selection: ResolvedSelection,
): RowRange | null {
  const startRow = rowAtOffset(source, selection.startOffset)
  const endRow = endRowForSelection(source, selection, startRow)
  if (startRow === 0) return endRow === 0 ? null : { endRow, startRow: 0 }

  return { endRow, startRow: startRow - 1 }
}

function endRowForSelection(
  source: ReindentSource,
  selection: ResolvedSelection,
  startRow: number,
): number {
  if (selection.collapsed) return startRow

  const endRow = rowAtOffset(source, selection.endOffset)
  // A selection stopping at a row start has not reached into that row.
  if (endRow > startRow && selection.endOffset === rowStart(source, endRow)) return endRow - 1

  return endRow
}

/**
 * One replace edit per row whose leading whitespace is not what the rules ask for.
 *
 * The range's first ruled row is the level the rest is measured from: the range is being made
 * self-consistent, not moved somewhere else, so a block that is uniformly too deep stays where the
 * user put it.
 */
function reindentEdits(
  source: ReindentSource,
  rules: EditorIndentationRules,
  range: RowRange,
  options: EditorEditActionOptions,
): readonly TextEdit[] {
  const baseRow = firstRuledRow(source, rules, range)
  if (baseRow === null || baseRow >= range.endRow) return []

  const tabSize = normalizeTabSize(options.tabSize)
  const unit = indentTextForRange(source, range, tabSize)
  const step = Math.max(1, visualColumnLength(unit, tabSize))
  const edits: TextEdit[] = []
  let column = visualColumnLength(indentationOfRow(source, baseRow), tabSize)
  if (matches(rules.increaseIndentPattern, maskedRowText(source, baseRow))) column += step

  for (let row = baseRow + 1; row <= range.endRow; row += 1) {
    if (skipsRules(source, rules, row)) continue

    const masked = maskedRowText(source, row)
    if (matches(rules.decreaseIndentPattern, masked)) column = Math.max(0, column - step)

    const indentation = indentationOfRow(source, row)
    const wanted = indentationForColumn(column, unit, tabSize)
    if (wanted !== indentation) {
      const start = rowStart(source, row)
      edits.push({ from: start, text: wanted, to: start + indentation.length })
    }

    if (matches(rules.increaseIndentPattern, masked)) column += step
  }

  return edits
}

function firstRuledRow(
  source: ReindentSource,
  rules: EditorIndentationRules,
  range: RowRange,
): number | null {
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    if (!skipsRules(source, rules, row)) return row
  }

  return null
}

/**
 * Whether a row is one the rules have nothing to say about, and which therefore neither moves nor
 * changes the level the rows under it get.
 *
 * A blank row has no indentation to correct — writing one would leave trailing whitespace behind —
 * and a row that begins inside a literal has indentation that is part of the text's value. The
 * language's own exemption is matched against the row as written, since it names shapes such as a
 * comment's continuation leader that the mask has already blanked out.
 */
function skipsRules(source: ReindentSource, rules: EditorIndentationRules, row: number): boolean {
  if (source.rowsInsideLiteral.has(row)) return true

  const text = rowText(source, row)
  if (text.trim().length === 0) return true

  return rules.unIndentedLinePattern !== undefined && matches(rules.unIndentedLinePattern, text)
}

/**
 * One level, in the currency the range already spends.
 *
 * The width is the editor's, which the document itself has already had a say in; the choice between
 * tabs and spaces stays with the text, so a tabbed file stays tabbed without anyone configuring it.
 */
function indentTextForRange(source: ReindentSource, range: RowRange, tabSize: number): string {
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    if (indentationOfRow(source, row).includes('\t')) return '\t'
  }

  return ' '.repeat(tabSize)
}

/** A column back into text. Levels are counted in columns so a mixed file collapses onto one unit. */
function indentationForColumn(column: number, unit: string, tabSize: number): string {
  if (!unit.includes('\t')) return ' '.repeat(column)

  return '\t'.repeat(Math.floor(column / tabSize)) + ' '.repeat(column % tabSize)
}

function lastRow(source: ReindentSource): number {
  return source.starts.length - 1
}

function rowStart(source: ReindentSource, row: number): number {
  return source.starts[row] ?? source.text.length
}

function rowEnd(source: ReindentSource, row: number): number {
  if (row < lastRow(source)) return rowStart(source, row + 1) - 1

  return source.text.length
}

function rowText(source: ReindentSource, row: number): string {
  return source.text.slice(rowStart(source, row), rowEnd(source, row))
}

function maskedRowText(source: ReindentSource, row: number): string {
  return source.maskedText.slice(rowStart(source, row), rowEnd(source, row))
}

function indentationOfRow(source: ReindentSource, row: number): string {
  return leadingWhitespace(rowText(source, row))
}

function rowAtOffset(source: ReindentSource, offset: number): number {
  const clamped = Math.min(Math.max(offset, 0), source.text.length)
  let low = 0
  let high = lastRow(source)

  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2)
    if (rowStart(source, middle) <= clamped) low = middle
    else high = middle - 1
  }

  return low
}
