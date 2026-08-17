import type { DocumentSessionEditSelection } from '../documentSession'
import { normalizeTabSize } from '../displayTransforms'
import type { ResolvedSelection } from '../selections'
import {
  nextCodePointOffset,
  nextWordOffset,
  nextWordPartOffset,
  nextWordStartOffset,
  previousCodePointOffset,
  previousWordEndOffset,
  previousWordOffset,
  previousWordPartOffset,
  wordSeparatorsForLanguage,
} from '../textRanges'
import { injectedLanguageIdsAtOffset, type EditorSyntaxInjection } from '../syntax/session'
import type { TextEdit } from '../tokens'
import type { EditorCommandId } from './commands'
import {
  editorLanguageConfiguration,
  type EditorBlockCommentTokens,
  type EditorCommentTokens,
} from './languageConfiguration'

export type EditorEditActionCommandId =
  | 'deleteWordLeft'
  | 'deleteWordRight'
  | 'deleteWordPartLeft'
  | 'deleteWordPartRight'
  | 'editor.action.commentLine'
  | 'editor.action.blockComment'
  | 'editor.action.indentLines'
  | 'editor.action.outdentLines'
  | 'editor.action.deleteLines'
  | 'editor.action.copyLinesUpAction'
  | 'editor.action.copyLinesDownAction'
  | 'editor.action.moveLinesUpAction'
  | 'editor.action.moveLinesDownAction'
  | 'editor.action.insertLineBefore'
  | 'editor.action.insertLineAfter'
  | 'editor.action.trimTrailingWhitespace'
  | 'editor.action.sortLinesAscending'
  | 'editor.action.sortLinesDescending'
  | 'editor.action.joinLines'
  | 'editor.action.duplicateSelection'
  | 'editor.action.transformToUppercase'
  | 'editor.action.transformToLowercase'
  | 'editor.action.transformToTitlecase'

export type EditorEditActionResult = {
  readonly edits: readonly TextEdit[]
  readonly selections?: readonly DocumentSessionEditSelection[]
  readonly revealOffset?: number
  readonly timingName: string
}

export type EditorEditActionOptions = {
  readonly languageId?: string | null
  /**
   * The stretches of the document written in some other language, as the parse already reports them.
   *
   * Without them a comment toggle answers for the file's extension everywhere, and a fenced block of
   * TypeScript inside a markdown file gets its code buried in `<!--` and `-->`.
   */
  readonly injections?: readonly EditorSyntaxInjection[]
  readonly tabSize?: number
  readonly indentText?: string
}

/** One row's text, without its terminator, together with the offset the row starts at. */
export type EditorDocumentLine = {
  readonly start: number
  readonly text: string
}

export type EditorListLineBreakOptions = {
  readonly caretOffset: number
  readonly caretRow: number
  readonly languageId?: string | null
  /**
   * Reads one row, or returns null past the last one.
   *
   * A callback rather than the document text because renumbering stops at the first row that is not
   * a list item, which is usually the next one: a line break must not pay for materializing the
   * whole document to find that out.
   */
  readonly readLine: (row: number) => EditorDocumentLine | null
}

export type EditorListLineBreakResult = {
  readonly edits: readonly TextEdit[]
  /** Where the caret lands, which the edits no longer say once a marker has been removed. */
  readonly caretOffset: number
}

type OffsetRange = {
  readonly start: number
  readonly end: number
}

type WordDeleteGranularity = 'word' | 'wordPart'

type BlockUncommentParts = {
  readonly open: OffsetRange
  readonly close: OffsetRange
}

type RowGroup = {
  readonly startRow: number
  readonly endRow: number
}

type LineMap = {
  readonly text: string
  readonly starts: readonly number[]
}

type RelativePoint = {
  readonly row: number
  readonly column: number
}

type LineSelectionDescriptor = {
  readonly groupIndex: number
  readonly anchor: RelativePoint
  readonly head: RelativePoint
}

/**
 * What a language nobody has described gets.
 *
 * Slash-slash is a guess, and a wrong one for a shell script. It is still the better answer than
 * refusing to toggle at all: the wrong marker is visible immediately and one undo away, whereas a
 * chord that silently does nothing reads as a broken editor.
 */
const DEFAULT_COMMENT_TOKENS: EditorCommentTokens = {
  line: '//',
  block: { open: '/*', close: '*/' },
}

export function isEditorEditActionCommand(
  command: EditorCommandId,
): command is EditorEditActionCommandId {
  return (
    command === 'deleteWordLeft' ||
    command === 'deleteWordRight' ||
    command === 'deleteWordPartLeft' ||
    command === 'deleteWordPartRight' ||
    command === 'editor.action.commentLine' ||
    command === 'editor.action.blockComment' ||
    command === 'editor.action.indentLines' ||
    command === 'editor.action.outdentLines' ||
    command === 'editor.action.deleteLines' ||
    command === 'editor.action.trimTrailingWhitespace' ||
    command === 'editor.action.sortLinesAscending' ||
    command === 'editor.action.sortLinesDescending' ||
    command === 'editor.action.joinLines' ||
    command === 'editor.action.duplicateSelection' ||
    command === 'editor.action.transformToUppercase' ||
    command === 'editor.action.transformToLowercase' ||
    command === 'editor.action.transformToTitlecase' ||
    command === 'editor.action.copyLinesUpAction' ||
    command === 'editor.action.copyLinesDownAction' ||
    command === 'editor.action.moveLinesUpAction' ||
    command === 'editor.action.moveLinesDownAction' ||
    command === 'editor.action.insertLineBefore' ||
    command === 'editor.action.insertLineAfter'
  )
}

export function editActionForCommand(
  command: EditorEditActionCommandId,
  text: string,
  selections: readonly ResolvedSelection[],
  options: EditorEditActionOptions = {},
): EditorEditActionResult {
  if (command === 'deleteWordLeft') {
    return deleteWordAction(text, selections, 'left', 'word', options)
  }
  if (command === 'deleteWordRight') {
    return deleteWordAction(text, selections, 'right', 'word', options)
  }
  if (command === 'deleteWordPartLeft') {
    return deleteWordAction(text, selections, 'left', 'wordPart', options)
  }
  if (command === 'deleteWordPartRight') {
    return deleteWordAction(text, selections, 'right', 'wordPart', options)
  }
  if (command === 'editor.action.commentLine') return commentLineAction(text, selections, options)
  if (command === 'editor.action.blockComment') {
    return blockCommentAction(text, selections, options)
  }
  if (command === 'editor.action.indentLines') {
    return indentLinesAction(text, selections, 'indent', options)
  }
  if (command === 'editor.action.outdentLines') {
    return indentLinesAction(text, selections, 'outdent', options)
  }
  if (command === 'editor.action.trimTrailingWhitespace') {
    return trimTrailingWhitespaceAction(text)
  }
  if (command === 'editor.action.sortLinesAscending') {
    return sortLinesAction(text, selections, 'ascending')
  }
  if (command === 'editor.action.sortLinesDescending') {
    return sortLinesAction(text, selections, 'descending')
  }
  if (command === 'editor.action.joinLines') return joinLinesAction(text, selections)
  if (command === 'editor.action.duplicateSelection') {
    return duplicateSelectionAction(text, selections)
  }
  if (command === 'editor.action.transformToUppercase') {
    return transformCaseAction(text, selections, 'upper')
  }
  if (command === 'editor.action.transformToLowercase') {
    return transformCaseAction(text, selections, 'lower')
  }
  if (command === 'editor.action.transformToTitlecase') {
    return transformCaseAction(text, selections, 'title')
  }
  if (command === 'editor.action.deleteLines') return deleteLinesAction(text, selections)
  if (command === 'editor.action.copyLinesUpAction') return copyLinesAction(text, selections, 'up')
  if (command === 'editor.action.copyLinesDownAction') {
    return copyLinesAction(text, selections, 'down')
  }
  if (command === 'editor.action.moveLinesUpAction') return moveLinesAction(text, selections, 'up')
  if (command === 'editor.action.moveLinesDownAction') {
    return moveLinesAction(text, selections, 'down')
  }
  if (command === 'editor.action.insertLineBefore') {
    return insertLineAction(text, selections, 'before')
  }
  return insertLineAction(text, selections, 'after')
}

function deleteWordAction(
  text: string,
  selections: readonly ResolvedSelection[],
  direction: 'left' | 'right',
  granularity: WordDeleteGranularity,
  options: EditorEditActionOptions,
): EditorEditActionResult {
  const separators = wordSeparatorsForLanguage(options.languageId)
  const ranges = selections
    .map((selection) => wordDeleteRange(text, selection, direction, granularity, separators))
    .filter((range) => range.start !== range.end)
  const merged = mergeOffsetRanges(ranges)
  const edits = merged.map((range) => rangeToEdit(range, ''))
  const collapsedSelections = collapseSelectionsAfterRanges(merged)
  const scope = granularity === 'wordPart' ? 'WordPart' : 'Word'

  return {
    edits,
    selections: collapsedSelections,
    revealOffset: collapsedSelections[0]?.head,
    timingName: `input.delete${scope}${direction === 'left' ? 'Left' : 'Right'}`,
  }
}

/**
 * Trims trailing spaces and tabs from every line of the document, selection or not.
 *
 * One edit per affected line rather than one whole-document edit, so untouched lines keep their
 * piece-table sharing and every anchor outside the trimmed runs survives.
 */
function trimTrailingWhitespaceAction(text: string): EditorEditActionResult {
  const map = createLineMap(text)
  const edits: TextEdit[] = []

  for (let row = 0; row <= lastRow(map); row += 1) {
    const start = lineStart(map, row)
    const end = lineEnd(map, row)
    const line = text.slice(start, end)
    const trimmed = line.replace(/[ \t]+$/, '')
    if (trimmed.length === line.length) continue

    edits.push({ from: start + trimmed.length, text: '', to: end })
  }

  return { edits, timingName: 'editor.trimTrailingWhitespace' }
}

function sortLinesAction(
  text: string,
  selections: readonly ResolvedSelection[],
  direction: 'ascending' | 'descending',
): EditorEditActionResult {
  const map = createLineMap(text)
  const edits: TextEdit[] = []

  for (const group of rowGroupsForSelections(map, selections)) {
    // Silently reordering a file the user never selected is worse than leaving one line as it is.
    if (group.startRow === group.endRow) continue

    const rows: string[] = []
    for (let row = group.startRow; row <= group.endRow; row += 1) {
      rows.push(text.slice(lineStart(map, row), lineEnd(map, row)))
    }

    const sorted = [...rows].sort((left, right) => left.localeCompare(right))
    if (direction === 'descending') sorted.reverse()

    edits.push({
      from: lineStart(map, group.startRow),
      text: sorted.join('\n'),
      to: lineEnd(map, group.endRow),
    })
  }

  return { edits, timingName: 'editor.sortLines' }
}

/** Joins each selected line with the next, collapsing the break and surrounding indentation. */
function joinLinesAction(
  text: string,
  selections: readonly ResolvedSelection[],
): EditorEditActionResult {
  const map = createLineMap(text)
  const edits: TextEdit[] = []

  for (const group of rowGroupsForSelections(map, selections)) {
    const lastJoinRow = group.startRow === group.endRow ? group.startRow : group.endRow - 1
    for (let row = group.startRow; row <= lastJoinRow; row += 1) {
      if (row >= lastRow(map)) break

      const from = lineEnd(map, row)
      const nextStart = lineStart(map, row + 1)
      const nextLine = text.slice(nextStart, lineEnd(map, row + 1))
      const indent = nextLine.length - nextLine.trimStart().length
      // A single space, unless the joined line is empty — then the lines simply meet.
      const separator = nextLine.trim().length === 0 ? '' : ' '
      edits.push({ from, text: separator, to: nextStart + indent })
    }
  }

  return { edits, timingName: 'editor.joinLines' }
}

/** Duplicates the selected text, or the whole line when the caret is collapsed. */
function duplicateSelectionAction(
  text: string,
  selections: readonly ResolvedSelection[],
): EditorEditActionResult {
  const map = createLineMap(text)
  const edits: TextEdit[] = []

  for (const selection of selections) {
    if (selection.startOffset !== selection.endOffset) {
      const slice = text.slice(selection.startOffset, selection.endOffset)
      edits.push({ from: selection.endOffset, text: slice, to: selection.endOffset })
      continue
    }

    const row = rowAtOffset(map, selection.headOffset)
    const start = lineStart(map, row)
    const end = lineFullEnd(map, row)
    const line = text.slice(start, end)
    edits.push({ from: end, text: line.endsWith('\n') ? line : `\n${line}`, to: end })
  }

  return { edits, timingName: 'editor.duplicateSelection' }
}

function transformCaseAction(
  text: string,
  selections: readonly ResolvedSelection[],
  kind: 'upper' | 'lower' | 'title',
): EditorEditActionResult {
  const edits: TextEdit[] = []

  for (const selection of selections) {
    // With no selection there is no range to transform; the word under the caret would be a
    // different command, and guessing between them is worse than doing nothing.
    if (selection.startOffset === selection.endOffset) continue

    const slice = text.slice(selection.startOffset, selection.endOffset)
    const transformed = transformCase(slice, kind)
    if (transformed === slice) continue

    edits.push({ from: selection.startOffset, text: transformed, to: selection.endOffset })
  }

  return { edits, timingName: 'editor.transformCase' }
}

function transformCase(text: string, kind: 'upper' | 'lower' | 'title'): string {
  if (kind === 'upper') return text.toUpperCase()
  if (kind === 'lower') return text.toLowerCase()

  return text.replace(/\p{L}[\p{L}\p{N}']*/gu, (word) => {
    const first = word.slice(0, 1).toUpperCase()
    return first + word.slice(1).toLowerCase()
  })
}

function deleteLinesAction(
  text: string,
  selections: readonly ResolvedSelection[],
): EditorEditActionResult {
  const map = createLineMap(text)
  const groups = rowGroupsForSelections(map, selections)
  const ranges = groups
    .map((group) => deleteRangeForGroup(map, group))
    .filter((range) => range.start !== range.end)
  const merged = mergeOffsetRanges(ranges)
  const edits = merged.map((range) => rangeToEdit(range, ''))
  const collapsedSelections = collapseSelectionsAfterRanges(merged)

  return {
    edits,
    selections: collapsedSelections,
    revealOffset: collapsedSelections[0]?.head,
    timingName: 'input.deleteLines',
  }
}

function copyLinesAction(
  text: string,
  selections: readonly ResolvedSelection[],
  direction: 'up' | 'down',
): EditorEditActionResult {
  const map = createLineMap(text)
  const groups = rowGroupsForSelections(map, selections)
  const descriptors = lineSelectionDescriptors(map, selections, groups)
  const edits = groups.map((group) => copyLineEdit(map, group, direction))
  const targetRows = copyTargetRows(groups, direction)
  const nextText = applyTextEdits(text, edits)
  const nextMap = createLineMap(nextText)
  const nextSelections = selectionsForTargetRows(nextMap, descriptors, targetRows)

  return {
    edits,
    selections: nextSelections,
    revealOffset: nextSelections[0]?.head,
    timingName: direction === 'up' ? 'input.copyLinesUp' : 'input.copyLinesDown',
  }
}

function moveLinesAction(
  text: string,
  selections: readonly ResolvedSelection[],
  direction: 'up' | 'down',
): EditorEditActionResult {
  const map = createLineMap(text)
  const groups = rowGroupsForSelections(map, selections)
  const descriptors = lineSelectionDescriptors(map, selections, groups)
  const movableGroups = groups.filter((group) => canMoveGroup(map, group, direction))
  const edits = movableGroups.map((group) => moveLineEdit(map, group, direction))
  const targetRows = groups.map((group) => moveTargetRow(map, group, direction))
  const nextText = applyTextEdits(text, edits)
  const nextMap = createLineMap(nextText)
  const nextSelections = selectionsForTargetRows(nextMap, descriptors, targetRows)

  return {
    edits,
    selections: nextSelections,
    revealOffset: nextSelections[0]?.head,
    timingName: direction === 'up' ? 'input.moveLinesUp' : 'input.moveLinesDown',
  }
}

function insertLineAction(
  text: string,
  selections: readonly ResolvedSelection[],
  direction: 'before' | 'after',
): EditorEditActionResult {
  const map = createLineMap(text)
  const groups = rowGroupsForSelections(map, selections)
  const edits = groups.map((group) => insertLineEdit(map, group, direction))
  const nextText = applyTextEdits(text, edits)
  const nextMap = createLineMap(nextText)
  const nextSelections = insertedLineSelections(nextMap, groups, direction)

  return {
    edits,
    selections: nextSelections,
    revealOffset: nextSelections[0]?.head,
    timingName: direction === 'before' ? 'input.insertLineBefore' : 'input.insertLineAfter',
  }
}

function commentLineAction(
  text: string,
  selections: readonly ResolvedSelection[],
  options: EditorEditActionOptions,
): EditorEditActionResult {
  const map = createLineMap(text)
  const tokens = commentTokensAtCaret(map, selections, options)
  if (!tokens.line && tokens.block) return blockCommentLinesAction(text, selections, tokens.block)

  const rows = rowsForSelections(map, selections)
  const lineToken = tokens.line ?? DEFAULT_COMMENT_TOKENS.line!
  const edits = lineCommentEdits(map, rows, lineToken)
  return editActionResultFromEdits(selections, edits, 'input.commentLine')
}

function blockCommentAction(
  text: string,
  selections: readonly ResolvedSelection[],
  options: EditorEditActionOptions,
): EditorEditActionResult {
  const map = createLineMap(text)
  const tokens =
    commentTokensAtCaret(map, selections, options).block ?? DEFAULT_COMMENT_TOKENS.block!
  const ranges = selections.map((selection) => blockCommentRangeForSelection(map, selection))
  return blockCommentRangesAction(text, selections, ranges, tokens, 'input.blockComment')
}

function indentLinesAction(
  text: string,
  selections: readonly ResolvedSelection[],
  direction: 'indent' | 'outdent',
  options: EditorEditActionOptions,
): EditorEditActionResult {
  const map = createLineMap(text)
  const rows = rowsForSelections(map, selections)
  const edits =
    direction === 'indent'
      ? indentLineEdits(map, rows, options.indentText ?? '\t')
      : outdentLineEdits(map, rows, normalizeTabSize(options.tabSize))
  const timingName = direction === 'indent' ? 'input.indentLines' : 'input.outdentLines'
  return editActionResultFromEdits(selections, edits, timingName)
}

/**
 * A list item's leader: indentation, the marker, then the whitespace separating it from the text.
 *
 * The task box is tried ahead of the plain bullet, or a task item continues as a bare bullet and
 * loses its box. A number needs that separating whitespace to be a marker at all — `1.5 kg` is a
 * measurement and `1.` at the end of a line is the end of a sentence.
 */
const LIST_ITEM_LEADER = /^([ \t]*)(>[> \t]*|[*+-][ \t]+\[[ xX]\]|[*+-]|(\d+)([.)]))([ \t]+)/

type ListItemLeader = {
  readonly indent: string
  readonly marker: string
  /** The ordered number as written, or null for a bullet, task box or block quote. */
  readonly number: string | null
  readonly delimiter: string
  readonly separator: string
  /** Whether the row holds the leader and nothing else. */
  readonly empty: boolean
}

/**
 * What a line break does inside a list, or null when it does nothing special.
 *
 * Two behaviours, and the second is what makes the first bearable: Enter on an item carries the
 * marker onto the next line, and Enter on an *empty* item takes the marker away instead, so the
 * second press ends the list rather than laying down another marker nobody asked for.
 *
 * Only a collapsed caret gets here, and only one with something other than indentation in front of
 * it: a caret sitting before the marker is pushing the item down, not starting a new one.
 */
export function listItemLineBreak(
  options: EditorListLineBreakOptions,
): EditorListLineBreakResult | null {
  if (editorLanguageConfiguration(options.languageId)?.listMarkers !== true) return null

  const line = options.readLine(options.caretRow)
  if (!line) return null

  const leader = listItemLeader(line.text)
  if (!leader) return null
  if (/^[ \t]*$/.test(line.text.slice(0, options.caretOffset - line.start))) return null

  if (leader.empty) {
    return {
      caretOffset: line.start + 1,
      edits: [{ from: line.start, text: '\n', to: line.start + line.text.length }],
    }
  }

  const inserted = `\n${leader.indent}${continuedLeader(leader)}`
  return {
    caretOffset: options.caretOffset + inserted.length,
    edits: [
      { from: options.caretOffset, text: inserted, to: options.caretOffset },
      ...renumberedItemEdits(options, leader),
    ],
  }
}

function listItemLeader(lineText: string): ListItemLeader | null {
  const match = LIST_ITEM_LEADER.exec(lineText)
  if (!match) return null

  return {
    delimiter: match[4] ?? '',
    empty: match[0].length === lineText.length,
    indent: match[1] ?? '',
    marker: match[2] ?? '',
    number: match[3] ?? null,
    separator: match[5] ?? '',
  }
}

/**
 * The leader the next item gets.
 *
 * A number advances and everything else repeats verbatim, down to the width of the separator, so an
 * item aligned by hand keeps its alignment. A ticked box comes back empty: the next thing you write
 * down is not already done.
 */
function continuedLeader(leader: ListItemLeader): string {
  const marker =
    leader.number === null
      ? leader.marker.replace(/\[[xX]\]/, '[ ]')
      : `${Number.parseInt(leader.number, 10) + 1}${leader.delimiter}`

  return `${marker}${leader.separator}`
}

/**
 * Renumbering for the items that follow the one just inserted.
 *
 * Only items at the same indentation are in the same sequence: a deeper one is a sublist counting
 * for itself and is stepped over, a shallower one is this list ending, and so is anything that is not
 * a list item. A bullet at this level means the list changed kind, whose numbering is not ours.
 */
function renumberedItemEdits(
  options: EditorListLineBreakOptions,
  leader: ListItemLeader,
): readonly TextEdit[] {
  if (leader.number === null) return []

  const edits: TextEdit[] = []
  let expected = Number.parseInt(leader.number, 10) + 1

  for (let row = options.caretRow + 1; ; row += 1) {
    const line = options.readLine(row)
    if (!line) break

    const following = listItemLeader(line.text)
    if (!following) break
    if (following.indent.length > leader.indent.length) continue
    if (following.indent.length < leader.indent.length) break
    if (following.number === null) break

    expected += 1
    if (Number.parseInt(following.number, 10) === expected) continue

    const from = line.start + following.indent.length
    edits.push({ from, text: String(expected), to: from + following.number.length })
  }

  return edits
}

/**
 * A word delete consumes the word the caret is against, or the line break when there is none.
 *
 * Word motion refuses to cross a line break, so at a line edge every scan reports the caret's own
 * offset: the break is then the thing the caret is against, and the thing to take.
 */
function wordDeleteRange(
  text: string,
  selection: ResolvedSelection,
  direction: 'left' | 'right',
  granularity: WordDeleteGranularity,
  separators: string,
): OffsetRange {
  if (!selection.collapsed) {
    return { start: selection.startOffset, end: selection.endOffset }
  }

  const head = selection.headOffset
  const boundary = wordDeleteOffset(text, head, direction, granularity, separators)
  if (direction === 'left') {
    return { start: boundary === head ? previousCodePointOffset(text, head) : boundary, end: head }
  }

  return { start: head, end: boundary === head ? nextCodePointOffset(text, head) : boundary }
}

/** Bounding the subword scan by the word stops keeps a subword delete a shortening of the word. */
function wordDeleteOffset(
  text: string,
  head: number,
  direction: 'left' | 'right',
  granularity: WordDeleteGranularity,
  separators: string,
): number {
  if (direction === 'left') {
    const wordStart = previousWordOffset(text, head, separators)
    if (granularity === 'word') return wordStart

    return Math.max(
      wordStart,
      previousWordPartOffset(text, head),
      previousWordEndOffset(text, head, separators),
    )
  }

  const wordEnd = nextWordOffset(text, head, separators)
  if (granularity === 'word') return wordEnd

  return Math.min(
    wordEnd,
    nextWordPartOffset(text, head),
    nextWordStartOffset(text, head, separators),
  )
}

function createLineMap(text: string): LineMap {
  const starts = [0]

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue
    starts.push(index + 1)
  }

  return { text, starts }
}

function rowGroupsForSelections(
  map: LineMap,
  selections: readonly ResolvedSelection[],
): readonly RowGroup[] {
  return mergeRowGroups(selections.map((selection) => rowGroupForSelection(map, selection)))
}

function rowsForSelections(
  map: LineMap,
  selections: readonly ResolvedSelection[],
): readonly number[] {
  return rowsForGroups(rowGroupsForSelections(map, selections))
}

function rowsForGroups(groups: readonly RowGroup[]): readonly number[] {
  const rows: number[] = []

  for (const group of groups) {
    for (let row = group.startRow; row <= group.endRow; row += 1) rows.push(row)
  }

  return rows
}

function rowGroupForSelection(map: LineMap, selection: ResolvedSelection): RowGroup {
  const startRow = rowAtOffset(map, selection.startOffset)
  if (selection.collapsed) return { startRow, endRow: startRow }

  const endRow = endRowForSelection(map, selection, startRow)
  return { startRow, endRow }
}

function endRowForSelection(map: LineMap, selection: ResolvedSelection, startRow: number): number {
  const endRow = rowAtOffset(map, selection.endOffset)
  if (endRow <= startRow) return endRow
  if (selection.endOffset !== lineStart(map, endRow)) return endRow
  return endRow - 1
}

function mergeRowGroups(groups: readonly RowGroup[]): readonly RowGroup[] {
  const sorted = groups.toSorted((left, right) => left.startRow - right.startRow)
  const merged: RowGroup[] = []

  for (const group of sorted) {
    const previous = merged[merged.length - 1]
    if (!previous || group.startRow > previous.endRow + 1) {
      merged.push(group)
      continue
    }

    merged[merged.length - 1] = {
      startRow: previous.startRow,
      endRow: Math.max(previous.endRow, group.endRow),
    }
  }

  return merged
}

function lineCommentEdits(
  map: LineMap,
  rows: readonly number[],
  lineToken: string,
): readonly TextEdit[] {
  if (shouldUncommentLineComments(map, rows, lineToken)) {
    return rows
      .map((row) => lineCommentDeleteRange(map, row, lineToken))
      .filter((range): range is OffsetRange => range !== null)
      .map((range) => rangeToEdit(range, ''))
  }

  const targets = commentedRows(map, rows)
  const column = sharedIndentationLength(map, targets)

  return targets.map((row) => {
    const offset = lineStart(map, row) + column
    return { from: offset, to: offset, text: `${lineToken} ` }
  })
}

/**
 * The rows a marker is actually added to.
 *
 * A blank line has nothing to comment out, and a marker parked on it survives as trailing junk once
 * the block is uncommented. Commenting a run that is *only* blank lines is still a request to comment
 * something, though, so there the blank lines are the target rather than nothing at all.
 */
function commentedRows(map: LineMap, rows: readonly number[]): readonly number[] {
  const contentRows = rows.filter((row) => !isBlankLine(map, row))

  return contentRows.length === 0 ? rows : contentRows
}

/**
 * One column for every marker in the block instead of each row's own indentation.
 *
 * Following the indentation staggers the markers with the code, which is exactly the shape the eye
 * uses to read the block's structure, so the comment ends up competing with it. The shallowest row's
 * indentation is the deepest column all of them can share.
 */
function sharedIndentationLength(map: LineMap, rows: readonly number[]): number {
  let length = Number.MAX_SAFE_INTEGER

  for (const row of rows) {
    length = Math.min(length, firstNonWhitespaceOffset(map, row) - lineStart(map, row))
  }

  return length === Number.MAX_SAFE_INTEGER ? 0 : length
}

function shouldUncommentLineComments(
  map: LineMap,
  rows: readonly number[],
  lineToken: string,
): boolean {
  const contentRows = rows.filter((row) => !isBlankLine(map, row))
  if (contentRows.length === 0) return false
  return contentRows.every((row) => lineCommentDeleteRange(map, row, lineToken) !== null)
}

function lineCommentDeleteRange(map: LineMap, row: number, lineToken: string): OffsetRange | null {
  const start = firstNonWhitespaceOffset(map, row)
  if (!map.text.startsWith(lineToken, start)) return null

  const tokenEnd = start + lineToken.length
  const end = map.text[tokenEnd] === ' ' ? tokenEnd + 1 : tokenEnd
  return { start, end }
}

function blockCommentLinesAction(
  text: string,
  selections: readonly ResolvedSelection[],
  tokens: EditorBlockCommentTokens,
): EditorEditActionResult {
  const map = createLineMap(text)
  const ranges = rowsForSelections(map, selections).map((row) => lineContentRange(map, row))
  const uncommentParts = ranges.map((range) => blockUncommentParts(text, range, tokens))
  const edits = shouldUncommentBlockRanges(uncommentParts)
    ? uncommentParts
        .filter((part): part is BlockUncommentParts => part !== null)
        .flatMap((part) => [rangeToEdit(part.open, ''), rangeToEdit(part.close, '')])
    : ranges.flatMap((range) => blockCommentEditsForRange(range, tokens))
  return editActionResultFromEdits(selections, edits, 'input.commentLine')
}

function blockCommentRangesAction(
  text: string,
  selections: readonly ResolvedSelection[],
  ranges: readonly OffsetRange[],
  tokens: EditorBlockCommentTokens,
  timingName: string,
): EditorEditActionResult {
  const uncommentParts = ranges.map((range) => blockUncommentParts(text, range, tokens))
  if (shouldUncommentBlockRanges(uncommentParts)) {
    return uncommentBlockRangesAction(selections, ranges, uncommentParts, timingName)
  }

  return commentBlockRangesAction(selections, ranges, tokens, timingName)
}

function shouldUncommentBlockRanges(parts: readonly (BlockUncommentParts | null)[]): boolean {
  if (parts.length === 0) return false
  return parts.every((part) => part !== null)
}

function commentBlockRangesAction(
  selections: readonly ResolvedSelection[],
  ranges: readonly OffsetRange[],
  tokens: EditorBlockCommentTokens,
  timingName: string,
): EditorEditActionResult {
  const edits = ranges.flatMap((range) => blockCommentEditsForRange(range, tokens))
  const nextSelections = blockCommentSelectionsAfterAdd(selections, ranges, edits, tokens)

  return {
    edits,
    selections: nextSelections,
    revealOffset: nextSelections[0]?.head,
    timingName,
  }
}

function uncommentBlockRangesAction(
  selections: readonly ResolvedSelection[],
  ranges: readonly OffsetRange[],
  parts: readonly (BlockUncommentParts | null)[],
  timingName: string,
): EditorEditActionResult {
  const uncommentParts = parts.filter((part): part is BlockUncommentParts => part !== null)
  const edits = uncommentParts.flatMap((part) => [
    rangeToEdit(part.open, ''),
    rangeToEdit(part.close, ''),
  ])
  const nextSelections = blockCommentSelectionsAfterRemove(selections, ranges, edits)

  return {
    edits,
    selections: nextSelections,
    revealOffset: nextSelections[0]?.head,
    timingName,
  }
}

function blockCommentEditsForRange(
  range: OffsetRange,
  tokens: EditorBlockCommentTokens,
): readonly TextEdit[] {
  const openText = blockCommentOpenText(tokens)
  const closeText = blockCommentCloseText(tokens)
  if (range.start === range.end) {
    return [{ from: range.start, to: range.start, text: `${openText}${closeText}` }]
  }

  return [
    { from: range.start, to: range.start, text: openText },
    { from: range.end, to: range.end, text: closeText },
  ]
}

function blockUncommentParts(
  text: string,
  range: OffsetRange,
  tokens: EditorBlockCommentTokens,
): BlockUncommentParts | null {
  return (
    blockUncommentPartsInsideRange(text, range, tokens) ??
    blockUncommentPartsAroundRange(text, range, tokens)
  )
}

function blockUncommentPartsInsideRange(
  text: string,
  range: OffsetRange,
  tokens: EditorBlockCommentTokens,
): BlockUncommentParts | null {
  if (!text.startsWith(tokens.open, range.start)) return null

  const closeStart = range.end - tokens.close.length
  if (closeStart < range.start + tokens.open.length) return null
  if (!text.startsWith(tokens.close, closeStart)) return null

  const openEnd = range.start + tokens.open.length
  const openDeleteEnd = text[openEnd] === ' ' ? openEnd + 1 : openEnd
  const closeDeleteStart = blockCloseDeleteStart(text, closeStart, openDeleteEnd)
  return {
    open: { start: range.start, end: openDeleteEnd },
    close: { start: closeDeleteStart, end: range.end },
  }
}

function blockUncommentPartsAroundRange(
  text: string,
  range: OffsetRange,
  tokens: EditorBlockCommentTokens,
): BlockUncommentParts | null {
  const openText = blockCommentOpenText(tokens)
  const closeText = blockCommentCloseText(tokens)
  const openStart = range.start - openText.length
  if (openStart < 0) return null
  if (!text.startsWith(openText, openStart)) return null
  if (!text.startsWith(closeText, range.end)) return null

  return {
    open: { start: openStart, end: range.start },
    close: { start: range.end, end: range.end + closeText.length },
  }
}

function blockCloseDeleteStart(text: string, closeStart: number, openDeleteEnd: number): number {
  if (closeStart <= openDeleteEnd) return closeStart
  if (text[closeStart - 1] === ' ') return closeStart - 1
  return closeStart
}

function blockCommentSelectionsAfterAdd(
  selections: readonly ResolvedSelection[],
  ranges: readonly OffsetRange[],
  edits: readonly TextEdit[],
  tokens: EditorBlockCommentTokens,
): readonly DocumentSessionEditSelection[] {
  const openLength = blockCommentOpenText(tokens).length
  return selections.map((selection, index) => {
    const range = ranges[index] ?? { start: selection.startOffset, end: selection.endOffset }
    const start = range.start + editDeltaBeforeOffset(edits, range.start) + openLength
    const end =
      range.start === range.end ? start : range.end + editDeltaBeforeOffset(edits, range.end)
    return selectionForRange(selection, start, end)
  })
}

function blockCommentSelectionsAfterRemove(
  selections: readonly ResolvedSelection[],
  ranges: readonly OffsetRange[],
  edits: readonly TextEdit[],
): readonly DocumentSessionEditSelection[] {
  return selections.map((selection, index) => {
    if (selection.collapsed) {
      const offset = offsetAfterEdits(selection.headOffset, edits)
      return { anchor: offset, head: offset }
    }

    const range = ranges[index] ?? { start: selection.startOffset, end: selection.endOffset }
    const start = range.start + editDeltaBeforeOffset(edits, range.start)
    const end = range.end + editDeltaBeforeOffset(edits, range.end)
    return selectionForRange(selection, start, end)
  })
}

function selectionForRange(
  selection: ResolvedSelection,
  start: number,
  end: number,
): DocumentSessionEditSelection {
  if (selection.reversed) return { anchor: end, head: start }
  return { anchor: start, head: end }
}

function blockCommentRangeForSelection(map: LineMap, selection: ResolvedSelection): OffsetRange {
  if (!selection.collapsed) return { start: selection.startOffset, end: selection.endOffset }

  const row = rowAtOffset(map, selection.headOffset)
  return lineContentRange(map, row)
}

function lineContentRange(map: LineMap, row: number): OffsetRange {
  return { start: firstNonWhitespaceOffset(map, row), end: lineEnd(map, row) }
}

function blockCommentOpenText(tokens: EditorBlockCommentTokens): string {
  if (tokens.open === '<!--') return '<!-- '
  return `${tokens.open} `
}

function blockCommentCloseText(tokens: EditorBlockCommentTokens): string {
  if (tokens.close === '-->') return ' -->'
  return ` ${tokens.close}`
}

function indentLineEdits(
  map: LineMap,
  rows: readonly number[],
  indentText: string,
): readonly TextEdit[] {
  if (indentText.length === 0) return []
  return rows.map((row) => {
    const start = lineStart(map, row)
    return { from: start, to: start, text: indentText }
  })
}

function outdentLineEdits(
  map: LineMap,
  rows: readonly number[],
  tabSize: number,
): readonly TextEdit[] {
  return rows
    .map((row) => outdentLineEdit(map, row, tabSize))
    .filter((edit): edit is TextEdit => edit !== null)
}

function outdentLineEdit(map: LineMap, row: number, tabSize: number): TextEdit | null {
  const start = lineStart(map, row)
  const end = lineEnd(map, row)
  if (start >= end) return null

  const prefix = map.text.slice(start, Math.min(end, start + tabSize))
  const length = outdentLength(prefix, tabSize)
  if (length === 0) return null
  return { from: start, to: start + length, text: '' }
}

function outdentLength(text: string, tabSize: number): number {
  if (text[0] === '\t') return 1

  let spaces = 0
  while (spaces < text.length && spaces < tabSize && text[spaces] === ' ') spaces += 1
  return spaces
}

function deleteRangeForGroup(map: LineMap, group: RowGroup): OffsetRange {
  if (group.startRow === 0) return { start: 0, end: blockEnd(map, group) }
  if (group.endRow !== lastRow(map)) {
    return { start: blockStart(map, group), end: blockEnd(map, group) }
  }

  return {
    start: lineEnd(map, group.startRow - 1),
    end: map.text.length,
  }
}

function copyLineEdit(map: LineMap, group: RowGroup, direction: 'up' | 'down'): TextEdit {
  const atDocumentEnd = group.endRow === lastRow(map)
  if (direction === 'up') {
    return {
      from: blockStart(map, group),
      to: blockStart(map, group),
      text: atDocumentEnd ? `${blockContentText(map, group)}\n` : blockText(map, group),
    }
  }

  return {
    from: blockEnd(map, group),
    to: blockEnd(map, group),
    text: atDocumentEnd ? `\n${blockContentText(map, group)}` : blockText(map, group),
  }
}

function copyTargetRows(groups: readonly RowGroup[], direction: 'up' | 'down'): readonly number[] {
  let insertedRowsBefore = 0
  const targetRows: number[] = []

  for (const group of groups) {
    const height = group.endRow - group.startRow + 1
    targetRows.push(copyTargetRow(group, direction, insertedRowsBefore))
    insertedRowsBefore += height
  }

  return targetRows
}

function copyTargetRow(
  group: RowGroup,
  direction: 'up' | 'down',
  insertedRowsBefore: number,
): number {
  if (direction === 'up') return group.startRow + insertedRowsBefore
  return group.endRow + 1 + insertedRowsBefore
}

function canMoveGroup(map: LineMap, group: RowGroup, direction: 'up' | 'down'): boolean {
  if (direction === 'up') return group.startRow > 0
  return group.endRow < lastRow(map)
}

function moveTargetRow(map: LineMap, group: RowGroup, direction: 'up' | 'down'): number {
  if (!canMoveGroup(map, group, direction)) return group.startRow
  return group.startRow + (direction === 'up' ? -1 : 1)
}

function moveLineEdit(map: LineMap, group: RowGroup, direction: 'up' | 'down'): TextEdit {
  if (direction === 'up') return moveLineUpEdit(map, group)
  return moveLineDownEdit(map, group)
}

function moveLineUpEdit(map: LineMap, group: RowGroup): TextEdit {
  const previousRow = group.startRow - 1
  return {
    from: lineStart(map, previousRow),
    to: blockEnd(map, group),
    text: moveUpReplacementText(map, group, previousRow),
  }
}

function moveLineDownEdit(map: LineMap, group: RowGroup): TextEdit {
  const nextRow = group.endRow + 1
  return {
    from: blockStart(map, group),
    to: lineFullEnd(map, nextRow),
    text: moveDownReplacementText(map, group, nextRow),
  }
}

function moveUpReplacementText(map: LineMap, group: RowGroup, previousRow: number): string {
  if (group.endRow !== lastRow(map)) return `${blockText(map, group)}${lineText(map, previousRow)}`
  return `${blockContentText(map, group)}\n${lineContentText(map, previousRow)}`
}

function moveDownReplacementText(map: LineMap, group: RowGroup, nextRow: number): string {
  if (nextRow !== lastRow(map)) return `${lineText(map, nextRow)}${blockText(map, group)}`
  return `${lineContentText(map, nextRow)}\n${blockContentText(map, group)}`
}

function insertLineEdit(map: LineMap, group: RowGroup, direction: 'before' | 'after'): TextEdit {
  const offset =
    direction === 'before' ? lineStart(map, group.startRow) : lineEnd(map, group.endRow)
  return { from: offset, to: offset, text: '\n' }
}

function insertedLineSelections(
  map: LineMap,
  groups: readonly RowGroup[],
  direction: 'before' | 'after',
): readonly DocumentSessionEditSelection[] {
  let insertedRowsBefore = 0
  const selections: DocumentSessionEditSelection[] = []

  for (const group of groups) {
    const targetRow =
      direction === 'before'
        ? group.startRow + insertedRowsBefore
        : group.endRow + 1 + insertedRowsBefore
    const offset = lineStart(map, targetRow)
    selections.push({ anchor: offset, head: offset })
    insertedRowsBefore += 1
  }

  return selections
}

function lineSelectionDescriptors(
  map: LineMap,
  selections: readonly ResolvedSelection[],
  groups: readonly RowGroup[],
): readonly LineSelectionDescriptor[] {
  return selections
    .map((selection) => lineSelectionDescriptor(map, selection, groups))
    .filter((descriptor): descriptor is LineSelectionDescriptor => descriptor !== null)
}

function lineSelectionDescriptor(
  map: LineMap,
  selection: ResolvedSelection,
  groups: readonly RowGroup[],
): LineSelectionDescriptor | null {
  const groupIndex = groupIndexForSelection(map, selection, groups)
  const group = groups[groupIndex]
  if (!group) return null

  return {
    groupIndex,
    anchor: relativePointForOffset(map, selection.anchorOffset, group.startRow),
    head: relativePointForOffset(map, selection.headOffset, group.startRow),
  }
}

function groupIndexForSelection(
  map: LineMap,
  selection: ResolvedSelection,
  groups: readonly RowGroup[],
): number {
  const selectionGroup = rowGroupForSelection(map, selection)
  return groups.findIndex(
    (group) => group.startRow <= selectionGroup.startRow && selectionGroup.endRow <= group.endRow,
  )
}

function selectionsForTargetRows(
  map: LineMap,
  descriptors: readonly LineSelectionDescriptor[],
  targetRows: readonly number[],
): readonly DocumentSessionEditSelection[] {
  return descriptors.map((descriptor) => {
    const targetStartRow = targetRows[descriptor.groupIndex] ?? 0
    return {
      anchor: offsetForRelativePoint(map, targetStartRow, descriptor.anchor),
      head: offsetForRelativePoint(map, targetStartRow, descriptor.head),
    }
  })
}

function relativePointForOffset(map: LineMap, offset: number, startRow: number): RelativePoint {
  const row = rowAtOffset(map, offset)
  return {
    row: row - startRow,
    column: offset - lineStart(map, row),
  }
}

function offsetForRelativePoint(
  map: LineMap,
  targetStartRow: number,
  point: RelativePoint,
): number {
  const row = clamp(targetStartRow + point.row, 0, lastRow(map))
  return Math.min(lineStart(map, row) + point.column, lineEnd(map, row))
}

function collapseSelectionsAfterRanges(
  ranges: readonly OffsetRange[],
): readonly DocumentSessionEditSelection[] {
  let delta = 0
  const selections: DocumentSessionEditSelection[] = []

  for (const range of ranges) {
    const offset = range.start + delta
    selections.push({ anchor: offset, head: offset })
    delta -= range.end - range.start
  }

  return selections
}

function mergeOffsetRanges(ranges: readonly OffsetRange[]): readonly OffsetRange[] {
  const sorted = ranges.toSorted((left, right) => left.start - right.start || left.end - right.end)
  const merged: OffsetRange[] = []

  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (!previous || range.start > previous.end) {
      merged.push(range)
      continue
    }

    merged[merged.length - 1] = {
      start: previous.start,
      end: Math.max(previous.end, range.end),
    }
  }

  return merged
}

function rangeToEdit(range: OffsetRange, text: string): TextEdit {
  return { from: range.start, to: range.end, text }
}

function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  let next = text
  const sorted = edits.toSorted((left, right) => right.from - left.from || right.to - left.to)

  for (const edit of sorted) {
    next = `${next.slice(0, edit.from)}${edit.text}${next.slice(edit.to)}`
  }

  return next
}

function editActionResultFromEdits(
  selections: readonly ResolvedSelection[],
  edits: readonly TextEdit[],
  timingName: string,
): EditorEditActionResult {
  const nextSelections = selectionsAfterEdits(selections, edits)

  return {
    edits,
    selections: nextSelections,
    revealOffset: nextSelections[0]?.head,
    timingName,
  }
}

function selectionsAfterEdits(
  selections: readonly ResolvedSelection[],
  edits: readonly TextEdit[],
): readonly DocumentSessionEditSelection[] {
  return selections.map((selection) => ({
    anchor: offsetAfterEdits(selection.anchorOffset, edits),
    head: offsetAfterEdits(selection.headOffset, edits),
  }))
}

function offsetAfterEdits(offset: number, edits: readonly TextEdit[]): number {
  let delta = 0
  const sorted = edits.toSorted((left, right) => left.from - right.from || left.to - right.to)

  for (const edit of sorted) {
    if (offset < edit.from) break
    if (offset <= edit.to && edit.from !== edit.to) return edit.from + delta
    delta += edit.text.length - (edit.to - edit.from)
  }

  return offset + delta
}

function editDeltaBeforeOffset(edits: readonly TextEdit[], offset: number): number {
  let delta = 0

  for (const edit of edits) {
    if (edit.from >= offset) continue
    delta += edit.text.length - (edit.to - edit.from)
  }

  return delta
}

/**
 * The markers the primary caret's row takes.
 *
 * Read where the marker is going — the row's first non-blank character — rather than under the caret.
 * A single line can start in one language and continue in another, and a marker only comments in the
 * language it is written into: a `/*` opening a line of markup that merely embeds a CSS rule comments
 * out nothing and breaks the markup instead.
 *
 * The innermost layer that has described its comments wins. A grammar can be injected without being a
 * language anyone wrote rules for, and reaching for the fallback there would replace the host's
 * correct markers with a guess.
 */
function commentTokensAtCaret(
  map: LineMap,
  selections: readonly ResolvedSelection[],
  options: EditorEditActionOptions,
): EditorCommentTokens {
  const caretRow = rowAtOffset(map, selections[0]?.headOffset ?? 0)
  const languageIds = injectedLanguageIdsAtOffset(
    options.injections ?? [],
    firstNonWhitespaceOffset(map, caretRow),
    options.languageId ?? null,
  )

  for (const languageId of languageIds) {
    const comments = editorLanguageConfiguration(languageId)?.comments
    if (comments) return comments
  }

  return DEFAULT_COMMENT_TOKENS
}

function rowAtOffset(map: LineMap, offset: number): number {
  const clamped = clamp(offset, 0, map.text.length)
  let row = 0

  for (let index = 1; index < map.starts.length; index += 1) {
    const start = map.starts[index] ?? 0
    if (start > clamped) break
    row = index
  }

  return row
}

function lastRow(map: LineMap): number {
  return map.starts.length - 1
}

function lineStart(map: LineMap, row: number): number {
  return map.starts[clamp(row, 0, lastRow(map))] ?? map.text.length
}

function lineEnd(map: LineMap, row: number): number {
  if (row < lastRow(map)) return lineStart(map, row + 1) - 1
  return map.text.length
}

function lineFullEnd(map: LineMap, row: number): number {
  if (row < lastRow(map)) return lineStart(map, row + 1)
  return map.text.length
}

function lineText(map: LineMap, row: number): string {
  return map.text.slice(lineStart(map, row), lineFullEnd(map, row))
}

function lineContentText(map: LineMap, row: number): string {
  return map.text.slice(lineStart(map, row), lineEnd(map, row))
}

function firstNonWhitespaceOffset(map: LineMap, row: number): number {
  const end = lineEnd(map, row)

  for (let offset = lineStart(map, row); offset < end; offset += 1) {
    const char = map.text[offset]
    if (char !== ' ' && char !== '\t') return offset
  }

  return end
}

function isBlankLine(map: LineMap, row: number): boolean {
  return firstNonWhitespaceOffset(map, row) === lineEnd(map, row)
}

function blockStart(map: LineMap, group: RowGroup): number {
  return lineStart(map, group.startRow)
}

function blockEnd(map: LineMap, group: RowGroup): number {
  return lineFullEnd(map, group.endRow)
}

function blockText(map: LineMap, group: RowGroup): string {
  return map.text.slice(blockStart(map, group), blockEnd(map, group))
}

function blockContentText(map: LineMap, group: RowGroup): string {
  return map.text.slice(blockStart(map, group), lineEnd(map, group.endRow))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
