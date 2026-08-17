import type {
  DocumentSession,
  DocumentSessionChange,
  DocumentSessionSelectionRange,
} from '../documentSession'
import { normalizeLineEndings } from '../pieceTable/lineEndings'
import { readPieceTableTextRange } from '../pieceTable/reads'
import {
  SelectionGoal,
  lastAddedSelectionIndex,
  resolveSelection,
  type ResolvedSelection,
  type SelectionGoal as SelectionGoalValue,
  type SelectionSet,
} from '../selections'
import { clamp } from '../style-utils'
import type { TextEdit } from '../tokens'
import type { VirtualizedTextView } from '../virtualization/virtualizedTextView'
import type {
  EditorResolvedSelection,
  EditorSelectionRange,
  EditorViewContributionUpdateKind,
} from '../plugins'
import type { EditorSyntaxLanguageId } from '../syntax/session'
import {
  readClipboardMetadata,
  writeClipboardPayload,
  type ClipboardMetadata,
} from './clipboardMetadata'
import { childContainingNode, childNodeIndex, elementBoundaryToTextOffset } from './domBoundary'
import { editActionForCommand, type EditorEditActionCommandId } from './editActions'
import {
  capitalize,
  eventTargetInsideBlockSurface,
  indentTimingName,
  type SessionChangeOptions,
} from './editorUtils'
import { keyboardFallbackText } from './input'
import {
  cancelFrame,
  mouseSelectionAutoScrollDelta,
  mouseSelectionEnds,
  mouseTextMove,
  requestFrame,
  type MouseSelectionDrag,
  type MouseSelectionEnds,
  type MouseSelectionGranularity,
  type MouseTextMoveDrag,
} from './mouseSelection'
import {
  createNavigationLineReader,
  navigationTargetForCommand,
  verticalMoveGoal,
  type NavigationLine,
} from './navigationTargets'
import {
  findAllExactOccurrences,
  findNextExactOccurrenceFromRange,
  occurrenceQueryForSelection,
  occurrenceSelectTimingName,
  type OccurrenceQuery,
  type OccurrenceSelectionChange,
} from './occurrences'
import { wordRangeAtOffset, wordSeparatorsForLanguage, type TextOffsetRange } from '../textRanges'
import {
  bufferColumnToVisualColumn,
  visualColumnLength,
  visualColumnToBufferColumn,
} from '../displayTransforms'
import { appendTiming, eventStartMs, mergeChangeTimings, nowMs } from './timing'
import { measureEditorPerformance } from './performanceDiagnostics'
import {
  canWaitForNativeTextInput,
  createEditorInputState,
  hasPendingKeyboardTextFallbackForGeneration,
  pendingKeyboardTextFallback,
  selectionBeforeEditSource,
  shouldCommitCompositionEnd,
  shouldSyncCustomSelectionFromDom,
  shouldSyncSessionSelectionFromDom,
  transitionEditorInputState,
  type EditorInputState,
  type EditorInputStateTransition,
} from './inputState'
import type { EditorCommandContext, EditorCommandId } from './commands'
import type { EditorSelectionSyncMode, EditorSessionOptions } from './types'
import {
  autoClosingPairForClose,
  autoClosingPairForOpen,
  shouldAutoClose,
  shouldDeletePair,
  shouldTypeOverCloser,
} from './autoClose'
import { AutoCloseStore, characterAt, characterBefore } from './autoCloseStore'
import { SnippetSession, type SnippetStopRange } from './snippetSession'
import type { Anchor as PieceTableAnchor, PieceTableSnapshot } from '../pieceTable/pieceTableTypes'
import { offsetToPoint, pointToOffset } from '../pieceTable/positions'
import { lineBreakIndent } from './indentation'

export type InputSelectionControllerOptions = {
  readonly el: HTMLDivElement
  readonly selectionSyncMode: EditorSelectionSyncMode
  readonly tabSize: number
  readonly view: VirtualizedTextView
  getLanguageId(): EditorSyntaxLanguageId | null
  getSession(): DocumentSession | null
  getSessionOptions(): EditorSessionOptions
  materializeFullText(): string
  canEditDocument(): boolean
  applySessionChange(
    change: DocumentSessionChange,
    totalName?: string,
    totalStart?: number,
    options?: SessionChangeOptions,
  ): void
  notifyChangeWithTiming(change: DocumentSessionChange): void
  notifyViewContributions(
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void
}

// A run of occurrence presses owns its search settings, so that widening one to whole words never
// reaches the find widget's own toggles. The selection set it produced identifies it: selection
// sets are replaced wholesale, so anything the user does in between hands back a different one and
// the next press starts a fresh run from whatever is selected then.
type OccurrenceRun = {
  readonly selections: SelectionSet<PieceTableAnchor>
  readonly wholeWord: boolean
}

/** What a copy or a cut hands to the clipboard: the text, plus how it was assembled. */
type ClipboardPayload = {
  readonly metadata: ClipboardMetadata
  readonly text: string
}

/**
 * A box selection, held as the two corners it spans rather than as the cursors it produces: the
 * cursors are derived again on every change, which is what lets the rectangle be pushed past the
 * end of a short line and pick that line up again on the way back.
 */
type ColumnSelectionRectangle = {
  // The text the columns were measured against. Any edit leaves them describing characters that
  // have since moved, so identity here is what expires the rectangle.
  readonly snapshot: PieceTableSnapshot
  readonly fromRow: number
  readonly fromColumn: number
  readonly toRow: number
  readonly toColumn: number
}

/** A rectangle the next gesture may still continue, with what the last one already worked out. */
type ColumnSelectionRun = {
  readonly rectangle: ColumnSelectionRectangle
  // The cursors the rectangle put down. Selection sets are replaced wholesale, so anything that
  // moves the caret in between hands back a different one and the abandoned box cannot resume.
  readonly selections: SelectionSet<PieceTableAnchor>
  // How far right the rectangle can go: the widest of the rows it covers, measured on the same
  // walk that placed the cursors, so holding the chord never re-reads those rows.
  readonly widestColumn: number
}

const COLUMN_SELECTION_COMMANDS = new Set<EditorCommandId>([
  'cursorColumnSelectLeft',
  'cursorColumnSelectRight',
  'cursorColumnSelectUp',
  'cursorColumnSelectDown',
  'cursorColumnSelectPageUp',
  'cursorColumnSelectPageDown',
])

export class InputSelectionController {
  private readonly autoClose = new AutoCloseStore()
  private readonly snippet = new SnippetSession()
  private occurrenceRun: OccurrenceRun | null = null
  private mouseSelectionDrag: MouseSelectionDrag | null = null
  private mouseTextMoveDrag: MouseTextMoveDrag | null = null
  private mouseSelectionAnchor: TextOffsetRange | null = null
  private columnSelection: ColumnSelectionRun | null = null
  private mouseSelectionAutoScrollFrame = 0
  private inputState: EditorInputState = createEditorInputState()
  private nativeInputHandlersInstalled = false

  constructor(private readonly options: InputSelectionControllerOptions) {}

  install(): void {
    const { el } = this.options
    el.addEventListener('mousedown', this.handleMouseDown)
    el.addEventListener('beforeinput', this.handleBeforeInput)
    el.addEventListener('copy', this.handleCopy)
    el.addEventListener('cut', this.handleCut)
    el.addEventListener('dragover', this.handleDragOver)
    el.addEventListener('dragleave', this.handleDragLeave)
    el.addEventListener('drop', this.handleDrop)
    el.addEventListener('paste', this.handlePaste)
    el.addEventListener('keydown', this.handleKeyDown)
    el.addEventListener('compositionstart', this.handleCompositionStart)
    el.addEventListener('compositionupdate', this.handleCompositionUpdate)
    el.addEventListener('compositionend', this.handleCompositionEnd)
    el.addEventListener('keyup', this.handleKeyUp)
    el.addEventListener('mouseup', this.syncSessionSelectionFromDom)
    el.ownerDocument.addEventListener('selectionchange', this.syncCustomSelectionFromDom)
  }

  dispose(): void {
    const { el } = this.options
    this.cancelPendingKeyboardTextFallback()
    this.uninstallNativeInputHandlers()
    el.removeEventListener('mousedown', this.handleMouseDown)
    el.removeEventListener('beforeinput', this.handleBeforeInput)
    el.removeEventListener('copy', this.handleCopy)
    el.removeEventListener('cut', this.handleCut)
    el.removeEventListener('dragover', this.handleDragOver)
    el.removeEventListener('dragleave', this.handleDragLeave)
    el.removeEventListener('drop', this.handleDrop)
    el.removeEventListener('paste', this.handlePaste)
    el.removeEventListener('keydown', this.handleKeyDown)
    el.removeEventListener('compositionstart', this.handleCompositionStart)
    el.removeEventListener('compositionupdate', this.handleCompositionUpdate)
    el.removeEventListener('compositionend', this.handleCompositionEnd)
    el.removeEventListener('keyup', this.handleKeyUp)
    el.removeEventListener('mouseup', this.syncSessionSelectionFromDom)
    el.ownerDocument.removeEventListener('selectionchange', this.syncCustomSelectionFromDom)
    this.stopMouseSelectionDrag()
    this.stopMouseTextMoveDrag()
  }

  syncNativeInputHandlers(editable: boolean): void {
    if (editable) {
      this.installNativeInputHandlers()
      return
    }

    this.uninstallNativeInputHandlers()
  }

  applyHistoryCommand(command: 'undo' | 'redo', context: EditorCommandContext): boolean {
    const session = this.session
    if (!session) return false
    if (!this.options.canEditDocument()) return false

    const start = context.event ? eventStartMs(context.event) : nowMs()
    const change = command === 'undo' ? session.undo() : session.redo()
    if (change.kind !== 'none') this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, command === 'undo' ? 'input.undo' : 'input.redo', start)
    return true
  }

  /**
   * Typing path for a single plain character, with auto-closing pairs applied.
   *
   * Only a single collapsed caret takes the auto-close path. Several carets fall through to plain
   * insertion: a batch would need one edit per caret, and two zero-width edits landing at the same
   * offset pass batch validation but apply in an unspecified order.
   */
  private applyTypedText(session: DocumentSession, text: string): DocumentSessionChange {
    // The keydown fallback turns Enter into '\n', so it arrives here rather than as a
    // beforeinput line break; both routes must indent identically.
    if (text === '\n') return this.applyLineBreak(session, text)

    const decided = this.autoCloseChange(session, text)
    if (decided) return decided

    const change = session.applyText(text)
    // Plain typing keeps tracked pairs and snippet stops alive; their anchors have already shifted
    // with the edit.
    this.autoClose.advance(change.snapshot)
    this.snippet.advance(change.snapshot)
    return change
  }

  /**
   * Line break with indentation continued from the current line.
   *
   * Falls back to a plain newline for anything but a single collapsed caret, for the same reason
   * auto-close does: a batch would need one edit per caret.
   */
  private applyLineBreak(session: DocumentSession, text: string): DocumentSessionChange {
    if (text !== '\n') return session.applyText(text)

    const snapshot = session.getSnapshot()
    const caret = this.collapsedCaretOffset(session, snapshot)
    if (caret === null) return session.applyText(text)

    const charBefore = characterBefore(snapshot, caret)
    const charAfter = characterAt(snapshot, caret)
    const pair =
      charBefore === null ? null : autoClosingPairForOpen(this.options.getLanguageId(), charBefore)
    const indent = lineBreakIndent({
      afterOpener: pair !== null && !pair.quote,
      betweenPair: pair !== null && !pair.quote && charAfter === pair.close,
      charAfter,
      charBefore,
      lineTextBeforeCaret: this.lineTextBeforeCaret(snapshot, caret),
      tabSize: this.options.tabSize,
    })

    const change = session.applyEdits(
      [{ from: caret, text: indent.insert + indent.trailing, to: caret }],
      {
        selections: [{ anchor: caret + indent.insert.length, head: caret + indent.insert.length }],
      },
    )
    // The pair the caret was inside has been split across lines; its closer is no longer adjacent.
    this.autoClose.clear()
    this.markSessionSelectionForNextInput()
    return change
  }

  /** Current line's text up to the caret, read without materializing the document. */
  private lineTextBeforeCaret(snapshot: PieceTableSnapshot, caret: number): string {
    const point = offsetToPoint(snapshot, caret)
    if (point.column === 0) return ''

    return readPieceTableTextRange(snapshot, caret - point.column, caret)
  }

  /** The auto-close variant of a keystroke, or null when the keystroke is ordinary. */
  private autoCloseChange(session: DocumentSession, text: string): DocumentSessionChange | null {
    if (text.length !== 1) return null

    const surrounded = this.surroundSelection(session, text)
    if (surrounded) return surrounded

    const snapshot = session.getSnapshot()
    const caret = this.collapsedCaretOffset(session, snapshot)
    if (caret === null) return null

    const languageId = this.options.getLanguageId()
    const closing = autoClosingPairForClose(languageId, text)
    if (
      closing &&
      shouldTypeOverCloser({
        charAfter: characterAt(snapshot, caret),
        close: closing.close,
        trackedAtCaret: this.autoClose.hasCloserAt(snapshot, caret, closing.close),
      })
    ) {
      return this.typeOverCloser(session, snapshot, caret)
    }

    const opening = autoClosingPairForOpen(languageId, text)
    if (!opening) return null
    if (
      !shouldAutoClose(opening, {
        charAfter: characterAt(snapshot, caret),
        charBefore: characterBefore(snapshot, caret),
      })
    ) {
      return null
    }

    // One edit, not two: the renderer only takes its incremental path for a single-edit change.
    const change = session.applyEdits(
      [{ from: caret, text: opening.open + opening.close, to: caret }],
      {
        selections: [{ anchor: caret + opening.open.length, head: caret + opening.open.length }],
      },
    )
    this.autoClose.track(change.snapshot, caret + opening.open.length, opening.close)
    this.markSessionSelectionForNextInput()
    return change
  }

  /** Steps the caret over a closer this editor inserted, without touching the text. */
  private typeOverCloser(
    session: DocumentSession,
    snapshot: PieceTableSnapshot,
    caret: number,
  ): DocumentSessionChange {
    this.autoClose.forget(snapshot, caret)
    const change = session.setSelection(caret + 1, caret + 1)
    this.autoClose.advance(change.snapshot)
    this.markSessionSelectionForNextInput()
    return change
  }

  /** Backspace between the halves of a pair this editor inserted removes both, or null. */
  private deleteAutoClosedPair(session: DocumentSession): DocumentSessionChange | null {
    const snapshot = session.getSnapshot()
    const caret = this.collapsedCaretOffset(session, snapshot)
    if (caret === null) return null

    const charBefore = characterBefore(snapshot, caret)
    const pair =
      charBefore === null ? null : autoClosingPairForOpen(this.options.getLanguageId(), charBefore)
    if (
      !shouldDeletePair({
        charAfter: characterAt(snapshot, caret),
        charBefore,
        pair,
        trackedAtCaret: this.autoClose.hasCloserAt(snapshot, caret, pair?.close ?? ''),
      })
    ) {
      return null
    }

    this.autoClose.forget(snapshot, caret)
    const change = session.applyEdits([{ from: caret - 1, text: '', to: caret + 1 }], {
      selections: [{ anchor: caret - 1, head: caret - 1 }],
    })
    this.autoClose.advance(change.snapshot)
    this.markSessionSelectionForNextInput()
    return change
  }

  /**
   * Typing an opener over a non-empty selection wraps it instead of replacing it.
   *
   * The two edits sit at different offsets, so they are safe as a batch — unlike a collapsed caret,
   * where opener and closer would be two zero-width edits at one offset with no defined order.
   */
  private surroundSelection(session: DocumentSession, text: string): DocumentSessionChange | null {
    const opening = autoClosingPairForOpen(this.options.getLanguageId(), text)
    if (!opening) return null

    const snapshot = session.getSnapshot()
    const selections = session.getSelections().selections
    if (selections.length !== 1) return null

    const only = selections[0]
    if (!only) return null

    const resolved = resolveSelection(snapshot, only)
    if (resolved.startOffset === resolved.endOffset) return null

    const shift = opening.open.length
    const start = resolved.startOffset + shift
    const end = resolved.endOffset + shift
    // Direction is preserved so a second wrap, or shift+arrow, continues from the same end.
    const forward = resolved.headOffset >= resolved.anchorOffset
    const change = session.applyEdits(
      [
        { from: resolved.startOffset, text: opening.open, to: resolved.startOffset },
        { from: resolved.endOffset, text: opening.close, to: resolved.endOffset },
      ],
      { selections: [forward ? { anchor: start, head: end } : { anchor: end, head: start }] },
    )
    // The closer here is deliberate, not a speculative auto-insert: nothing to type over.
    this.autoClose.clear()
    this.markSessionSelectionForNextInput()
    return change
  }

  /** Begins tab-stop navigation for a snippet that was just inserted. */
  startSnippetSession(ranges: readonly SnippetStopRange[]): void {
    const session = this.session
    if (!session) return

    this.snippet.start(session.getSnapshot(), ranges)
  }

  /** Moves to the next or previous snippet stop, or reports that no session owns the key. */
  private moveSnippetStop(session: DocumentSession, direction: 1 | -1): boolean {
    if (!this.snippet.active) return false

    const range = this.snippet.move(session.getSnapshot(), direction)
    if (!range) return false

    const change = session.setSelection(range.start, range.end)
    this.snippet.advance(change.snapshot)
    this.autoClose.advance(change.snapshot)
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, 'input.snippetStop')
    return true
  }

  /** The single collapsed caret offset, or null when there is a selection or several carets. */
  private collapsedCaretOffset(
    session: DocumentSession,
    snapshot: PieceTableSnapshot,
  ): number | null {
    const selections = session.getSelections().selections
    if (selections.length !== 1) return null

    const only = selections[0]
    if (!only) return null

    const resolved = resolveSelection(snapshot, only)
    if (resolved.startOffset !== resolved.endOffset) return null

    return resolved.headOffset
  }

  applyDeleteCommand(direction: 'backward' | 'forward', context: EditorCommandContext): boolean {
    const session = this.session
    if (!session) return false
    if (!this.options.canEditDocument()) return false

    const start = context.event ? eventStartMs(context.event) : nowMs()
    const selectionChange = this.selectionChangeBeforeEdit()
    const change =
      direction === 'backward'
        ? (this.deleteAutoClosedPair(session) ?? session.backspace(this.options.tabSize))
        : session.deleteSelection()
    this.options.applySessionChange(
      mergeChangeTimings(change, selectionChange),
      direction === 'backward' ? 'input.backspace' : 'input.delete',
      start,
    )
    return true
  }

  applyIndentCommand(direction: 'indent' | 'outdent', context: EditorCommandContext): boolean {
    const session = this.session
    if (!session) return false
    if (!this.options.canEditDocument()) return false

    // Tab belongs to an active snippet first: cycling its stops is what the key means while one is
    // being filled in, and indenting there would push the placeholder around instead.
    if (this.moveSnippetStop(session, direction === 'indent' ? 1 : -1)) return true

    const start = context.event ? eventStartMs(context.event) : nowMs()
    const selectionChange = this.selectionChangeBeforeEdit()
    const change =
      direction === 'indent'
        ? this.applyIndentToSession()
        : session.outdentSelection(this.options.tabSize)
    const merged = mergeChangeTimings(change, selectionChange)
    this.options.applySessionChange(merged, indentTimingName(direction), start, {
      revealOffset: this.primarySelectionHeadOffset(merged),
    })
    return true
  }

  applyEditActionCommand(
    command: EditorEditActionCommandId,
    context: EditorCommandContext,
  ): boolean {
    const session = this.session
    if (!session) return false
    if (!this.options.canEditDocument()) return false

    const start = context.event ? eventStartMs(context.event) : nowMs()
    const selectionChange = this.selectionChangeBeforeEdit()
    const snapshot = session.getSnapshot()
    const selections = session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection))
    const action = editActionForCommand(command, session.materializeFullText(), selections, {
      languageId: this.options.getLanguageId(),
      tabSize: this.options.tabSize,
    })
    const change = session.applyEdits(action.edits, {
      selections: action.selections,
    })
    this.options.applySessionChange(
      mergeChangeTimings(change, selectionChange),
      action.timingName,
      start,
      {
        revealOffset: action.revealOffset,
      },
    )
    return true
  }

  applySelectAllCommand(context: EditorCommandContext): boolean {
    const session = this.session
    if (!session) return false

    const start = context.event ? eventStartMs(context.event) : nowMs()
    const change = session.setSelection(0, session.getSnapshot().length)
    this.syncCustomSelectionHighlight(0, session.getSnapshot().length)
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, 'input.selectAll', start, { syncDomSelection: false })
    return true
  }

  applyClearSecondarySelections(context: EditorCommandContext): boolean {
    const session = this.session
    if (!session) return false

    const resolved = this.resolvedSelections()
    if (resolved.length <= 1) return false

    // Dropping the extras leaves the user at the cursor they last reached for — the one the editor
    // scrolled to when it was added. Keeping whichever cursor sorts first instead would throw the
    // caret to the top of the run they just built.
    const kept = resolved[lastAddedSelectionIndex(session.getSelections())] ?? resolved[0]
    if (!kept) return false

    const start = context.event ? eventStartMs(context.event) : nowMs()
    const change = session.setSelections([
      { anchor: kept.anchorOffset, goal: kept.goal, head: kept.headOffset },
    ])
    this.syncSessionSelectionHighlight()
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, 'input.clearSecondarySelections', start, {
      revealOffset: kept.headOffset,
      syncDomSelection: false,
    })
    return true
  }

  applyInsertCursorCommand(direction: 'above' | 'below', context: EditorCommandContext): boolean {
    const session = this.session
    if (!session) return false

    const resolved = this.resolvedSelections()
    const rowDelta = direction === 'above' ? -1 : 1
    const inserted = resolved
      .map((selection) => this.cursorSelectionByDisplayRows(selection, rowDelta))
      .filter((selection) => selection.anchor !== selection.sourceHead)
    if (inserted.length === 0) return false

    const selections = [
      ...resolved.map((selection) => ({
        anchor: selection.anchorOffset,
        head: selection.headOffset,
        goal: selection.goal,
      })),
      ...inserted.map((selection) => ({
        anchor: selection.anchor,
        head: selection.anchor,
        goal: selection.goal,
      })),
    ]
    const start = context.event ? eventStartMs(context.event) : nowMs()
    const change = session.setSelections(selections)
    this.syncSessionSelectionHighlight()
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, `input.insertCursor${capitalize(direction)}`, start, {
      revealOffset: inserted[0]?.anchor,
      syncDomSelection: false,
    })
    return true
  }

  applySelectExactOccurrencesCommand(
    command: 'editor.action.selectHighlights' | 'editor.action.changeAll',
    context: EditorCommandContext,
  ): boolean {
    const session = this.session
    if (!session) return false

    const text = session.materializeFullText()
    const query = this.occurrenceQueryForCurrentSelection(text)
    if (!query) return false

    const ranges = findAllExactOccurrences(text, query.query)
    if (ranges.length === 0) return false

    const selections = ranges.map((range) => ({ anchor: range.start, head: range.end }))
    const start = context.event ? eventStartMs(context.event) : nowMs()
    const change = session.setSelections(selections)
    this.syncSessionSelectionHighlight()
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, occurrenceSelectTimingName(command), start, {
      revealOffset: query.range.end,
      syncDomSelection: false,
    })
    return true
  }

  applyMoveSelectionToNextOccurrenceCommand(context: EditorCommandContext): boolean {
    const session = this.session
    if (!session) return false

    const text = session.materializeFullText()
    const resolved = this.resolvedSelections()
    const source = resolved.at(-1)
    if (!source) return false

    const query = occurrenceQueryForSelection(text, source)
    if (!query) return false

    const keptSelections = resolved.slice(0, -1)
    const selected = keptSelections.map((selection) => ({
      start: selection.startOffset,
      end: selection.endOffset,
    }))
    const next = findNextExactOccurrenceFromRange(text, query.query, selected, query.range)
    if (!next) return false
    if (next.start === query.range.start && next.end === query.range.end) return false

    const selections = [
      ...keptSelections.map((selection) => ({
        anchor: selection.anchorOffset,
        head: selection.headOffset,
        goal: selection.goal,
      })),
      { anchor: next.start, head: next.end },
    ]
    const start = context.event ? eventStartMs(context.event) : nowMs()
    const change = session.setSelections(selections)
    this.syncSessionSelectionHighlight()
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, 'input.moveSelectionToNextFindMatch', start, {
      revealOffset: next.end,
      syncDomSelection: false,
    })
    return true
  }

  applyAddNextOccurrenceCommand(context: EditorCommandContext): boolean {
    const start = context.event ? eventStartMs(context.event) : nowMs()
    const result = this.addNextExactOccurrence()
    if (!result) return false

    this.syncSessionSelectionHighlight()
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(result.change, 'input.addNextOccurrence', start, {
      revealOffset: result.revealOffset,
      syncDomSelection: false,
    })
    return true
  }

  applyNavigationCommand(command: EditorCommandId, context: EditorCommandContext): boolean {
    const session = this.session
    if (!session) return false
    if (COLUMN_SELECTION_COMMANDS.has(command)) {
      return this.applyColumnSelectionCommand(command, context)
    }

    const snapshot = session.getSnapshot()
    const resolvedSelections = session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection))
    if (resolvedSelections.length === 0) return false

    const readLine = createNavigationLineReader(snapshot, session.getTextSnapshot())
    const wordSeparators = wordSeparatorsForLanguage(this.options.getLanguageId())
    const navigation = resolvedSelections.map((resolved) => ({
      resolved,
      target: navigationTargetForCommand({
        command,
        resolved,
        readLine,
        documentLength: snapshot.length,
        wordSeparators,
        view: this.options.view,
      }),
    }))
    const primary = navigation[0]
    if (!primary?.target) return false

    const start = context.event ? eventStartMs(context.event) : nowMs()
    const selections = []
    for (const { resolved, target } of navigation) {
      if (!target) return false
      selections.push({
        anchor: target.extend ? resolved.anchorOffset : target.offset,
        head: target.offset,
        goal: target.goal ?? SelectionGoal.none(),
      })
    }
    const change = session.setSelections(selections)
    this.markSessionSelectionForNextInput()
    this.options.view.revealOffset(primary.target.offset)
    this.options.applySessionChange(change, primary.target.timingName, start)
    return true
  }

  applyFindSelection(
    anchorOffset: number,
    headOffset: number,
    timingName: string,
    revealOffset?: number,
  ): void {
    const session = this.session
    if (!session) return

    const start = nowMs()
    const change = session.setSelection(anchorOffset, headOffset)
    this.syncSessionSelectionHighlight()
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, timingName, start, {
      revealOffset,
      syncDomSelection: false,
    })
  }

  applyFindSelections(
    selections: readonly EditorSelectionRange[],
    timingName: string,
    revealOffset?: number,
  ): void {
    const session = this.session
    if (!session) return
    if (selections.length === 0) return

    const start = nowMs()
    const change = session.setSelections(selections)
    this.syncSessionSelectionHighlight()
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, timingName, start, {
      revealOffset,
      syncDomSelection: false,
    })
  }

  applyFindEdits(
    edits: readonly TextEdit[],
    timingName: string,
    selection?: EditorSelectionRange,
  ): void {
    const session = this.session
    if (!session) return
    if (!this.options.canEditDocument()) return
    if (edits.length === 0) return

    const start = nowMs()
    const change = session.applyEdits(edits, { selection })
    this.syncSessionSelectionHighlight()
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, timingName, start, {
      revealOffset: this.primarySelectionHeadOffset(change),
      syncDomSelection: false,
    })
  }

  resolveViewSelections(): readonly EditorResolvedSelection[] {
    const snapshot = this.session?.getSnapshot()
    const selections = this.session?.getSelections().selections ?? []
    if (!snapshot) return []

    return selections.map((selection) => {
      const resolved = resolveSelection(snapshot, selection)
      return {
        anchorOffset: resolved.anchorOffset,
        headOffset: resolved.headOffset,
        startOffset: resolved.startOffset,
        endOffset: resolved.endOffset,
      }
    })
  }

  syncDomSelection(): void {
    const session = this.session
    if (!session) return

    const selection = session.getSelections().selections[0]
    if (!selection) return

    const snapshot = session.getSnapshot()
    const resolved = resolveSelection(snapshot, selection)
    const start = clamp(resolved.startOffset, 0, snapshot.length)
    const end = clamp(resolved.endOffset, start, snapshot.length)

    if (this.hasFocusedExternalElement()) {
      this.syncSessionSelectionHighlight()
      this.options.notifyViewContributions('selection', null)
      return
    }

    if (this.isInputFocused()) {
      this.syncSessionSelectionHighlight()
      this.options.notifyViewContributions('selection', null)
      return
    }

    if (this.options.selectionSyncMode === 'none') {
      this.syncSessionSelectionHighlight()
      this.options.notifyViewContributions('selection', null)
      return
    }

    const range = this.options.view.createRange(start, end, { scrollIntoView: false })
    const domSelection = window.getSelection()
    domSelection?.removeAllRanges()
    if (range) domSelection?.addRange(range)
    this.syncSessionSelectionHighlight()
    this.options.notifyViewContributions('selection', null)
  }

  syncSessionSelectionHighlight(): void {
    const session = this.session
    if (!session) return

    const snapshot = session.getSnapshot()
    const selections = session.getSelections().selections.map((selection) => {
      const resolved = resolveSelection(snapshot, selection)
      return {
        anchorOffset: resolved.anchorOffset,
        headOffset: resolved.headOffset,
      }
    })
    this.options.view.setSelections(selections)
  }

  clearSelectionHighlight(): void {
    this.options.view.clearSelection()
  }

  textOffsetFromPoint(clientX: number, clientY: number): number | null {
    return (
      this.options.view.textOffsetFromPoint(clientX, clientY) ??
      this.options.view.textOffsetFromViewportPoint(clientX, clientY)
    )
  }

  rangeClientRect(start: number, end: number): DOMRect | null {
    const range = this.options.view.createRange(start, Math.max(start, end), {
      scrollIntoView: false,
    })
    if (!range) return null

    const firstRect = range.getClientRects()[0]
    if (firstRect) return firstRect

    const rect = range.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) return rect
    return null
  }

  private get session(): DocumentSession | null {
    return this.options.getSession()
  }

  private get text(): string {
    return this.options.materializeFullText()
  }

  private transitionInputState(transition: EditorInputStateTransition): void {
    this.inputState = transitionEditorInputState(this.inputState, transition)
  }

  private markSessionSelectionForNextInput(): void {
    this.transitionInputState({ type: 'selection-owned-by-session' })
  }

  private markDomSelectionForNextInput(): void {
    this.transitionInputState({ type: 'selection-owned-by-dom' })
  }

  private markHiddenInputSelectionForNextInput(): void {
    this.transitionInputState({ type: 'selection-owned-by-hidden-input' })
  }

  private installNativeInputHandlers(): void {
    if (this.nativeInputHandlersInstalled) return

    this.options.view.inputElement.addEventListener(
      'beforeinput',
      this.handleNativeInputBeforeInputCapture,
      {
        capture: true,
      },
    )
    this.options.view.inputElement.addEventListener('input', this.handleNativeInputInputCapture, {
      capture: true,
    })
    this.nativeInputHandlersInstalled = true
  }

  private uninstallNativeInputHandlers(): void {
    if (!this.nativeInputHandlersInstalled) return

    this.options.view.inputElement.removeEventListener(
      'beforeinput',
      this.handleNativeInputBeforeInputCapture,
      { capture: true },
    )
    this.options.view.inputElement.removeEventListener(
      'input',
      this.handleNativeInputInputCapture,
      {
        capture: true,
      },
    )
    this.nativeInputHandlersInstalled = false
  }

  private handleNativeInputBeforeInputCapture = (_event: InputEvent): void => {
    this.transitionInputState({ type: 'native-input-observed' })
    this.cancelPendingKeyboardTextFallback()
  }

  private handleNativeInputInputCapture = (_event: Event): void => {
    this.transitionInputState({ type: 'native-input-observed' })
    this.cancelPendingKeyboardTextFallback()
  }

  private handleCompositionStart = (_event: CompositionEvent): void => {
    this.cancelPendingKeyboardTextFallback()
    this.transitionInputState({ type: 'composition-start' })
  }

  private handleCompositionUpdate = (event: CompositionEvent): void => {
    this.transitionInputState({ text: event.data, type: 'composition-update' })
  }

  private handleCompositionEnd = (event: CompositionEvent): void => {
    const text = event.data || this.inputState.compositionText
    const shouldCommit = shouldCommitCompositionEnd(this.inputState, text)
    this.transitionInputState({ type: 'composition-end' })
    if (!shouldCommit) return

    this.applyCompositionText(text, eventStartMs(event))
  }

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this.session) return
    if (event.defaultPrevented) return
    if (eventTargetInsideBlockSurface(event.target)) return

    this.options.view.focusInput()
    if (event.detail >= 4) {
      this.selectFullDocument(event, 'input.quadClick')
      return
    }

    const offset = this.textOffsetFromMouseEvent(event)
    if (offset === null) return

    // Alt on its own already means "another cursor here", so the rectangle takes the pair.
    if (event.altKey && event.shiftKey) {
      this.startMouseSelectionDrag(event, offset, 'column')
      return
    }

    if (event.detail === 3) {
      this.startMouseSelectionDrag(event, offset, 'line')
      return
    }

    if (event.detail === 2) {
      this.startMouseSelectionDrag(event, offset, 'word')
      return
    }

    if (event.altKey) {
      this.addCursorAtOffset(event, offset)
      return
    }

    if (this.startMouseTextMoveDrag(event, offset)) return

    this.startMouseSelectionDrag(event, offset, 'char')
  }

  private addCursorAtOffset(event: MouseEvent, offset: number): void {
    const session = this.session
    if (!session) return
    if (event.button !== 0) return
    if (event.detail !== 1) return

    const start = eventStartMs(event)
    event.preventDefault()
    const change = session.addSelection(offset)
    this.syncSessionSelectionHighlight()
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, 'input.addCursor', start, {
      syncDomSelection: false,
    })
  }

  /**
   * Arms a drag over the pressed point.
   *
   * Shift keeps the anchor the previous press laid down instead of laying down a new one, which is
   * the whole of extending by click: only the head moves, and a run begun on a word or a line goes
   * on selecting whole words or lines in either direction.
   */
  private startMouseSelectionDrag(
    event: MouseEvent,
    offset: number,
    granularity: MouseSelectionGranularity,
  ): void {
    const session = this.session
    if (!session) return
    if (event.button !== 0) return

    const head = this.offsetRangeAt(offset, granularity)
    const anchor = event.shiftKey ? this.mouseSelectionExtendAnchor() : head
    if (!anchor) return

    const start = eventStartMs(event)
    event.preventDefault()
    this.options.view.focusInput()
    this.mouseSelectionAnchor = anchor
    this.mouseSelectionDrag = {
      anchor,
      granularity,
      headOffset: offset,
      clientX: event.clientX,
      clientY: event.clientY,
    }
    this.transitionInputState({ type: 'mouse-selection-start' })
    this.options.el.ownerDocument.addEventListener('mousemove', this.updateMouseSelectionDrag)
    this.options.el.ownerDocument.addEventListener('mouseup', this.finishMouseSelectionDrag)
    if (granularity === 'column') {
      this.startColumnSelection(session, offset, start)
      return
    }

    // A press that only drops the caret somewhere has nothing to show until it moves or lifts, and
    // committing here would spend a selection change on every click.
    if (granularity === 'char' && !event.shiftKey) {
      this.syncCustomSelectionHighlight(offset, offset)
      return
    }

    this.applyMouseSelection(
      session,
      mouseSelectionEnds(anchor, head),
      mouseSelectionTimingName(granularity),
      start,
    )
  }

  private offsetRangeAt(offset: number, granularity: MouseSelectionGranularity): TextOffsetRange {
    if (granularity === 'char' || granularity === 'column') return { start: offset, end: offset }

    const line = this.readLineAt(offset)
    if (!line) return { start: offset, end: offset }
    if (granularity === 'line') return { start: line.start, end: line.start + line.text.length }

    const word = wordRangeAtOffset(line.text, offset - line.start)
    return { start: line.start + word.start, end: line.start + word.end }
  }

  /**
   * What a shift-click pivots on. The range the last press anchored to holds only while the live
   * selection is still anchored there: Select All or a Shift+Arrow run has re-anchored it since and
   * owes that press nothing, so extending falls back to the end the selection is anchored by —
   * never the end the caret happens to sit at.
   */
  private mouseSelectionExtendAnchor(): TextOffsetRange | null {
    const primary = this.primaryResolvedSelection()
    if (!primary) return null

    const remembered = this.mouseSelectionAnchor
    if (
      remembered &&
      (primary.anchorOffset === remembered.start || primary.anchorOffset === remembered.end)
    ) {
      return remembered
    }

    return { start: primary.anchorOffset, end: primary.anchorOffset }
  }

  private applyMouseSelection(
    session: DocumentSession,
    ends: MouseSelectionEnds,
    timingName: string,
    start: number,
  ): void {
    const change = session.setSelection(ends.anchorOffset, ends.headOffset)
    this.syncCustomSelectionHighlight(ends.anchorOffset, ends.headOffset)
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, timingName, start, { syncDomSelection: false })
  }

  private startColumnSelection(session: DocumentSession, offset: number, start: number): void {
    // A press lays down a rectangle of its own rather than continuing the one the keyboard was
    // pushing around: it is anchored where the caret already is and spans out to the pointer.
    this.columnSelection = null
    this.commitColumnSelection(session, offset, start)
  }

  private updateColumnSelection(session: DocumentSession, offset: number): void {
    const rectangle = this.columnSelectionTo(session, offset)
    if (!rectangle) return
    if (!this.setColumnSelection(session, rectangle)) return

    this.options.notifyViewContributions('selection', null)
  }

  private commitColumnSelection(session: DocumentSession, offset: number, start: number): void {
    const rectangle = this.columnSelectionTo(session, offset)
    if (!rectangle) return

    const applied = this.setColumnSelection(session, rectangle)
    if (!applied) return

    // No reveal: the corner the pointer is holding is already the part of the document the user is
    // looking at, and scrolling to it would drag the text out from under the drag.
    this.options.applySessionChange(applied.change, 'input.columnSelection', start, {
      syncDomSelection: false,
    })
  }

  private applyColumnSelectionCommand(
    command: EditorCommandId,
    context: EditorCommandContext,
  ): boolean {
    const session = this.session
    if (!session) return false

    const rectangle = this.columnSelectionRectangle(session)
    if (!rectangle) return false

    const applied = this.setColumnSelection(
      session,
      this.movedColumnSelection(session, command, rectangle),
    )
    if (!applied) return false

    const start = context.event ? eventStartMs(context.event) : nowMs()
    this.options.applySessionChange(applied.change, 'input.columnSelection', start, {
      revealOffset: applied.revealOffset,
      syncDomSelection: false,
    })
    return true
  }

  /** Only the moving corner ever changes; the anchored one is what the rectangle is measured from. */
  private movedColumnSelection(
    session: DocumentSession,
    command: EditorCommandId,
    rectangle: ColumnSelectionRectangle,
  ): ColumnSelectionRectangle {
    if (command === 'cursorColumnSelectLeft') {
      return { ...rectangle, toColumn: Math.max(0, rectangle.toColumn - 1) }
    }

    if (command === 'cursorColumnSelectRight') {
      // The widest line in the band, so the rectangle can be pushed past the end of the short ones
      // but never off into a column no line in it reaches.
      const limit = this.columnSelectionWidestColumn(session, rectangle)
      return { ...rectangle, toColumn: Math.min(rectangle.toColumn + 1, limit) }
    }

    const rows = columnSelectionRowDelta(command, this.options.view.pageRowDelta())
    const snapshot = session.getSnapshot()
    const lastRow = offsetToPoint(snapshot, snapshot.length).row
    return { ...rectangle, toRow: clamp(rectangle.toRow + rows, 0, lastRow) }
  }

  private setColumnSelection(
    session: DocumentSession,
    rectangle: ColumnSelectionRectangle,
  ): { readonly change: DocumentSessionChange; readonly revealOffset: number } | null {
    const { ranges, widestColumn } = this.columnSelectionRanges(session, rectangle)
    // The anchored row is measured from a real position on itself, so it is always inside the band
    // and always contributes: no gesture can empty this, and the guard is here for the index type.
    const moving = ranges.at(-1)
    if (!moving) return null

    const change = session.setSelections(ranges)
    this.columnSelection = { rectangle, selections: session.getSelections(), widestColumn }
    this.syncSessionSelectionHighlight()
    this.markSessionSelectionForNextInput()
    return { change, revealOffset: moving.head ?? moving.anchor }
  }

  /**
   * One cursor per row the rectangle covers, walked from its anchored corner to its moving one,
   * with the widest of those rows picked up on the way: both readings need every line's text, and
   * the rows can number in the thousands while the chord is held down.
   */
  private columnSelectionRanges(
    session: DocumentSession,
    rectangle: ColumnSelectionRectangle,
  ): {
    readonly ranges: readonly DocumentSessionSelectionRange[]
    readonly widestColumn: number
  } {
    const snapshot = session.getSnapshot()
    const readLine = createNavigationLineReader(snapshot, session.getTextSnapshot())
    const tabSize = this.options.tabSize
    const step = rectangle.toRow < rectangle.fromRow ? -1 : 1
    const rows = Math.abs(rectangle.toRow - rectangle.fromRow) + 1
    const ranges: DocumentSessionSelectionRange[] = []
    let widestColumn = 0

    for (let index = 0; index < rows; index += 1) {
      const row = rectangle.fromRow + step * index
      const line = readLine(pointToOffset(snapshot, { row, column: 0 }))
      widestColumn = Math.max(widestColumn, visualColumnLength(line.text, tabSize))

      const fromColumn = visualColumnToBufferColumn(
        line.text,
        rectangle.fromColumn,
        'nearest',
        tabSize,
      )
      const toColumn = visualColumnToBufferColumn(line.text, rectangle.toColumn, 'nearest', tabSize)
      const covers = columnBandCoversLine(
        rectangle,
        bufferColumnToVisualColumn(line.text, fromColumn, tabSize),
        bufferColumnToVisualColumn(line.text, toColumn, tabSize),
      )
      // A line that stops short of the band contributes no cursor at all. Clamping it to its own
      // end instead would put a caret outside the rectangle, editing text it never covered.
      if (!covers) continue

      ranges.push({ anchor: line.start + fromColumn, head: line.start + toColumn })
    }

    return { ranges, widestColumn }
  }

  private columnSelectionWidestColumn(
    session: DocumentSession,
    rectangle: ColumnSelectionRectangle,
  ): number {
    // A rectangle that is still the stored one covers the rows the stored width was measured over.
    const run = this.columnSelection
    if (run?.rectangle === rectangle) return run.widestColumn

    return this.columnSelectionRanges(session, rectangle).widestColumn
  }

  private columnSelectionTo(
    session: DocumentSession,
    offset: number,
  ): ColumnSelectionRectangle | null {
    const rectangle = this.columnSelectionRectangle(session)
    if (!rectangle) return null

    const to = this.columnSelectionCorner(session, offset)
    return { ...rectangle, toRow: to.row, toColumn: to.column }
  }

  /** The rectangle the next column gesture continues, or one synthesised from the caret. */
  private columnSelectionRectangle(session: DocumentSession): ColumnSelectionRectangle | null {
    const snapshot = session.getSnapshot()
    const run = this.columnSelection
    if (run?.rectangle.snapshot === snapshot && run.selections === session.getSelections()) {
      return run.rectangle
    }

    this.columnSelection = null
    const primary = this.primaryResolvedSelection()
    if (!primary) return null

    const from = this.columnSelectionCorner(session, primary.anchorOffset)
    const to = this.columnSelectionCorner(session, primary.headOffset)
    return {
      snapshot,
      fromRow: from.row,
      fromColumn: from.column,
      toRow: to.row,
      toColumn: to.column,
    }
  }

  private columnSelectionCorner(
    session: DocumentSession,
    offset: number,
  ): { readonly row: number; readonly column: number } {
    const point = offsetToPoint(session.getSnapshot(), offset)
    const line = this.readLineAt(offset)
    return {
      row: point.row,
      column: bufferColumnToVisualColumn(line?.text ?? '', point.column, this.options.tabSize),
    }
  }

  private updateMouseSelectionDrag = (event: MouseEvent): void => {
    if (!this.mouseSelectionDrag) return
    if (!this.session) return

    event.preventDefault()
    this.mouseSelectionDrag.clientX = event.clientX
    this.mouseSelectionDrag.clientY = event.clientY
    this.updateMouseSelectionFromDragPoint()
    this.updateMouseSelectionAutoScroll()
  }

  private finishMouseSelectionDrag = (event: MouseEvent): void => {
    const drag = this.mouseSelectionDrag
    const session = this.session
    if (!drag || !session) {
      this.stopMouseSelectionDrag()
      return
    }

    // A release can arrive from over the gutter, a scrollbar, or past the last line, where a hit
    // test answers with an offset the pointer never visited.
    const { anchor, granularity, headOffset } = drag
    event.preventDefault()
    this.stopMouseSelectionDrag('finish')

    const start = nowMs()
    if (granularity === 'column') {
      this.commitColumnSelection(session, headOffset, start)
      return
    }

    const ends = mouseSelectionEnds(anchor, this.offsetRangeAt(headOffset, granularity))
    const change = session.setSelection(ends.anchorOffset, ends.headOffset)
    const syncDomSelection = ends.anchorOffset === ends.headOffset
    this.syncCustomSelectionHighlight(ends.anchorOffset, ends.headOffset)
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, 'input.selection', start, { syncDomSelection })
  }

  /**
   * Takes a press that landed inside the selection, so that dragging carries the selected text
   * instead of throwing the selection away and starting a new one.
   *
   * Only the interior counts: a press on either edge is how a selection is grown by dragging, and
   * text that is only one character wide has no interior to grab. Several cursors have no one run to
   * carry, and a read-only document cannot take the text back out again.
   */
  private startMouseTextMoveDrag(event: MouseEvent, offset: number): boolean {
    if (event.button !== 0) return false
    if (event.detail !== 1) return false
    if (event.shiftKey) return false
    if (!this.options.canEditDocument()) return false

    const resolved = this.resolvedSelections()
    const primary = resolved.length === 1 ? resolved[0] : undefined
    if (!primary) return false
    if (offset <= primary.startOffset || offset >= primary.endOffset) return false

    event.preventDefault()
    this.options.view.focusInput()
    this.mouseTextMoveDrag = {
      dropOffset: null,
      moved: false,
      pressOffset: offset,
      source: { start: primary.startOffset, end: primary.endOffset },
    }
    this.transitionInputState({ type: 'mouse-selection-start' })
    this.options.el.ownerDocument.addEventListener('mousemove', this.updateMouseTextMoveDrag)
    this.options.el.ownerDocument.addEventListener('mouseup', this.finishMouseTextMoveDrag)
    return true
  }

  private updateMouseTextMoveDrag = (event: MouseEvent): void => {
    const drag = this.mouseTextMoveDrag
    if (!drag) return

    event.preventDefault()
    const offset = this.textOffsetFromPoint(event.clientX, event.clientY)
    if (offset === null) return

    drag.moved = drag.moved || offset !== drag.pressOffset
    drag.dropOffset = offset > drag.source.start && offset < drag.source.end ? null : offset
    this.showTextMoveDropCaret(drag)
  }

  private finishMouseTextMoveDrag = (event: MouseEvent): void => {
    const drag = this.mouseTextMoveDrag
    const session = this.session
    if (!drag || !session) {
      this.stopMouseTextMoveDrag()
      return
    }

    event.preventDefault()
    this.stopMouseTextMoveDrag()
    const start = eventStartMs(event)
    if (!drag.moved) {
      this.collapseSelectionToOffset(session, drag.pressOffset, start)
      return
    }

    // The modifier is read here rather than at the press, because it can be taken up or let go at
    // any point while the text is in flight and what it says at the release is the user's answer.
    const move =
      drag.dropOffset === null
        ? null
        : mouseTextMove(
            drag.source,
            readPieceTableTextRange(session.getSnapshot(), drag.source.start, drag.source.end),
            drag.dropOffset,
            event.altKey || event.ctrlKey,
          )
    if (!move) {
      this.syncSessionSelectionHighlight()
      return
    }

    const change = session.applyEdits(move.edits, {
      selections: [{ anchor: move.selection.start, head: move.selection.end }],
    })
    this.syncCustomSelectionHighlight(move.selection.start, move.selection.end)
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, 'input.dragText', start, {
      revealOffset: move.selection.end,
      syncDomSelection: false,
    })
  }

  private showTextMoveDropCaret(drag: MouseTextMoveDrag): void {
    // With nowhere to drop, the selection comes back: the run is still where it was, and a caret
    // sitting inside it would claim otherwise.
    if (drag.dropOffset === null) {
      this.syncSessionSelectionHighlight()
      return
    }

    this.syncCustomSelectionHighlight(drag.dropOffset, drag.dropOffset)
  }

  private collapseSelectionToOffset(session: DocumentSession, offset: number, start: number): void {
    const change = session.setSelection(offset)
    this.syncCustomSelectionHighlight(offset, offset)
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, 'input.selection', start, { syncDomSelection: true })
  }

  private stopMouseTextMoveDrag(): void {
    const hadDrag = this.mouseTextMoveDrag !== null
    this.mouseTextMoveDrag = null
    this.options.el.ownerDocument.removeEventListener('mousemove', this.updateMouseTextMoveDrag)
    this.options.el.ownerDocument.removeEventListener('mouseup', this.finishMouseTextMoveDrag)
    if (!hadDrag) return

    this.transitionInputState({ type: 'mouse-selection-finish' })
  }

  private stopMouseSelectionDrag(reason: 'cancel' | 'finish' = 'cancel'): void {
    const hadDrag = this.mouseSelectionDrag !== null
    this.mouseSelectionDrag = null
    this.stopMouseSelectionAutoScroll()
    this.options.el.ownerDocument.removeEventListener('mousemove', this.updateMouseSelectionDrag)
    this.options.el.ownerDocument.removeEventListener('mouseup', this.finishMouseSelectionDrag)
    if (!hadDrag) return

    this.transitionInputState({
      type: reason === 'finish' ? 'mouse-selection-finish' : 'mouse-selection-cancel',
    })
  }

  private updateMouseSelectionFromDragPoint(): void {
    const drag = this.mouseSelectionDrag
    const session = this.session
    if (!drag || !session) return

    const offset = this.mouseSelectionOffsetFromPoint(drag.clientX, drag.clientY)
    drag.headOffset = offset
    if (drag.granularity === 'column') {
      this.updateColumnSelection(session, offset)
      return
    }

    const ends = mouseSelectionEnds(drag.anchor, this.offsetRangeAt(offset, drag.granularity))
    this.syncCustomSelectionHighlight(ends.anchorOffset, ends.headOffset)
    session.setSelection(ends.anchorOffset, ends.headOffset)
    this.options.notifyViewContributions('selection', null)
    if (ends.anchorOffset === ends.headOffset) {
      this.markDomSelectionForNextInput()
      return
    }

    this.markSessionSelectionForNextInput()
  }

  private mouseSelectionOffsetFromPoint(clientX: number, clientY: number): number {
    const offset =
      this.options.view.textOffsetFromPoint(clientX, clientY) ??
      this.options.view.textOffsetFromViewportPoint(clientX, clientY)
    if (offset !== null) return offset

    return this.mouseSelectionDrag?.headOffset ?? 0
  }

  private updateMouseSelectionAutoScroll(): void {
    const delta = this.mouseSelectionAutoScrollDelta()
    if (delta === 0 || !this.canMouseSelectionAutoScroll(delta)) {
      this.stopMouseSelectionAutoScroll()
      return
    }

    this.scrollMouseSelection(delta)
    this.scheduleMouseSelectionAutoScroll()
  }

  private mouseSelectionAutoScrollDelta(): number {
    const drag = this.mouseSelectionDrag
    if (!drag) return 0

    const rect = this.options.el.getBoundingClientRect()
    return mouseSelectionAutoScrollDelta(drag.clientY, rect)
  }

  private canMouseSelectionAutoScroll(delta: number): boolean {
    const maxScrollTop = Math.max(0, this.options.el.scrollHeight - this.options.el.clientHeight)
    if (delta < 0) return this.options.el.scrollTop > 0
    if (delta > 0) return this.options.el.scrollTop < maxScrollTop
    return false
  }

  private scrollMouseSelection(delta: number): void {
    const maxScrollTop = Math.max(0, this.options.el.scrollHeight - this.options.el.clientHeight)
    const nextScrollTop = clamp(this.options.el.scrollTop + delta, 0, maxScrollTop)
    if (nextScrollTop === this.options.el.scrollTop) return

    this.options.el.scrollTop = nextScrollTop
    this.options.view.setScrollMetrics(this.options.el.scrollTop, this.options.el.clientHeight)
    this.updateMouseSelectionFromDragPoint()
  }

  private scheduleMouseSelectionAutoScroll(): void {
    if (this.mouseSelectionAutoScrollFrame !== 0) return

    this.mouseSelectionAutoScrollFrame = requestFrame(() => {
      this.mouseSelectionAutoScrollFrame = 0
      if (!this.mouseSelectionDrag) return
      this.updateMouseSelectionAutoScroll()
    })
  }

  private stopMouseSelectionAutoScroll(): void {
    if (this.mouseSelectionAutoScrollFrame === 0) return

    cancelFrame(this.mouseSelectionAutoScrollFrame)
    this.mouseSelectionAutoScrollFrame = 0
  }

  private selectFullDocument(event: MouseEvent, timingName: string): void {
    const session = this.session
    if (!session) return

    const start = eventStartMs(event)
    event.preventDefault()
    const change = session.setSelection(0, session.getSnapshot().length)
    this.syncCustomSelectionHighlight(0, session.getSnapshot().length)
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, timingName, start, { syncDomSelection: false })
  }

  private readLineAt(offset: number): NavigationLine | null {
    const session = this.session
    if (!session) return null

    return createNavigationLineReader(session.getSnapshot(), session.getTextSnapshot())(offset)
  }

  private handleBeforeInput = (event: InputEvent): void => {
    const session = this.session
    if (!session) return
    if (!this.options.canEditDocument()) {
      this.cancelPendingKeyboardTextFallback()
      event.preventDefault()
      return
    }

    const inserted = beforeInputText(event)
    if (inserted === null) return

    this.cancelPendingKeyboardTextFallback()
    const start = eventStartMs(event)
    const selectionChange = measureEditorPerformance('input.selectionChangeBeforeEdit', () =>
      this.selectionChangeBeforeEdit(),
    )
    event.preventDefault()
    this.transitionInputState({ text: inserted, type: 'beforeinput-pending' })
    // Only a plain typed character can auto-close; insertLineBreak also yields a 1-character
    // string, and composition results must never be rewritten.
    const textChange = measureEditorPerformance('session.applyText', () =>
      event.inputType === 'insertText'
        ? this.applyTypedText(session, inserted)
        : this.applyLineBreak(session, inserted),
    )
    this.transitionInputState({ type: 'transaction-committed' })
    this.options.applySessionChange(
      mergeChangeTimings(textChange, selectionChange),
      'input.beforeinput',
      start,
    )
  }

  private handlePaste = (event: ClipboardEvent): void => {
    const session = this.session
    if (!session) return
    if (!this.options.canEditDocument()) {
      event.preventDefault()
      return
    }

    // The session flattens terminators again on its way into the buffer, so
    // this is not what keeps them out of the document. It is what pasteRevealBlock
    // reads: the reveal is decided from the payload rather than from the document
    // it produces, and a Word or PDF paste whose only breaks are U+2028/U+2029
    // would otherwise count as a single line and leave its new rows unrevealed.
    const text = normalizeLineEndings(event.clipboardData?.getData('text/plain') ?? '')
    if (text.length === 0) return

    // Looked up under the folded text, because that is the form the payload was written in.
    const metadata = readClipboardMetadata(event.clipboardData ?? null, text)
    this.cancelPendingKeyboardTextFallback()
    this.transitionInputState({ text, type: 'paste-pending' })
    const start = eventStartMs(event)
    const selectionChange = this.selectionChangeBeforeEdit()
    event.preventDefault()
    const change = mergeChangeTimings(this.applyPaste(session, text, metadata), selectionChange)
    this.transitionInputState({ type: 'transaction-committed' })
    this.options.applySessionChange(change, 'input.paste', start, {
      revealBlock: pasteRevealBlock(text),
      revealOffset: this.primarySelectionHeadOffset(change),
    })
  }

  /**
   * Claims a drag while it is over the text.
   *
   * A browser delivers a drop only to an element that has claimed the drag on its way past, and
   * nothing here is natively a drop target — so without this the handler below never runs at all,
   * and the pointer reads as "no drop" the whole way across the editor. A document that cannot be
   * edited leaves the drag unclaimed rather than accepting one it would then have to discard.
   */
  private handleDragOver = (event: DragEvent): void => {
    if (!this.session) return
    if (!this.options.canEditDocument()) return

    event.preventDefault()
    // Text arriving from outside brings no cursor of its own, so the editor lends it one: without a
    // mark on the spot the pointer has picked out, a drop is aimed by guesswork.
    const offset = this.textOffsetFromPoint(event.clientX, event.clientY)
    if (offset !== null) this.syncCustomSelectionHighlight(offset, offset)
    // Never `move`: the text belongs to whatever the drag came from, and telling that source to take
    // it away is a deletion in a document this editor does not own.
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }

  /** Gives the caret back to the selection once a drag the editor was aiming for goes elsewhere. */
  private handleDragLeave = (event: DragEvent): void => {
    if (!this.session) return
    // Crossing between the rows inside the editor leaves each of them in turn, and the drag has not
    // gone anywhere.
    if (event.relatedTarget instanceof Node && this.options.el.contains(event.relatedTarget)) return

    this.syncSessionSelectionHighlight()
  }

  private handleDrop = (event: DragEvent): void => {
    const session = this.session
    if (!session) return

    this.cancelPendingKeyboardTextFallback()
    event.preventDefault()
    if (!this.options.canEditDocument()) return

    // Normalized for the same reason as the pasted payload above.
    const text = normalizeLineEndings(dropPlainText(event))
    if (text.length === 0) return

    const offset = this.textOffsetFromPoint(event.clientX, event.clientY)
    if (offset === null) return

    this.transitionInputState({ text, type: 'drop-pending' })
    const start = eventStartMs(event)
    const selectionChange = session.setSelection(offset)
    this.markSessionSelectionForNextInput()
    const textChange = session.applyText(text)
    const change = mergeChangeTimings(textChange, selectionChange)
    this.transitionInputState({ type: 'transaction-committed' })
    this.options.applySessionChange(change, 'input.drop', start, {
      revealBlock: pasteRevealBlock(text),
      revealOffset: this.primarySelectionHeadOffset(change),
    })
  }

  private handleCopy = (event: ClipboardEvent): void => {
    const payload = this.clipboardPayload()
    if (!payload) return
    if (!event.clipboardData) return

    writeClipboardPayload(event.clipboardData, payload.text, payload.metadata)
    event.preventDefault()
  }

  /**
   * Cut, which the browser cannot do for us: the element the keystroke lands on holds no document
   * text, so the native gesture has nothing to take away and nothing to remove.
   */
  private handleCut = (event: ClipboardEvent): void => {
    const session = this.session
    if (!session) return
    if (!event.clipboardData) return
    if (!this.options.canEditDocument()) return

    const start = eventStartMs(event)
    const selectionChange = this.selectionChangeBeforeEdit()
    const payload = this.clipboardPayload()
    if (!payload) return

    writeClipboardPayload(event.clipboardData, payload.text, payload.metadata)
    event.preventDefault()
    const change = payload.metadata.pasteOnNewLine
      ? this.deleteCaretLines(session)
      : session.deleteSelection()
    this.options.applySessionChange(mergeChangeTimings(change, selectionChange), 'input.cut', start)
  }

  /** Removal half of a cut that took whole lines, including the line-joining terminators. */
  private deleteCaretLines(session: DocumentSession): DocumentSessionChange {
    const action = editActionForCommand(
      'editor.action.deleteLines',
      session.materializeFullText(),
      this.resolvedSelections(),
      { languageId: this.options.getLanguageId(), tabSize: this.options.tabSize },
    )
    return session.applyEdits(action.edits, { selections: action.selections })
  }

  private applyPaste(
    session: DocumentSession,
    text: string,
    metadata: ClipboardMetadata | null,
  ): DocumentSessionChange {
    const resolved = this.resolvedSelections()
    if (metadata?.pasteOnNewLine && resolved.every((selection) => selection.collapsed)) {
      return this.applyLinePaste(session, text, resolved)
    }
    // Cursor i takes fragment i only while the counts still line up. Under any other count the
    // fragments no longer describe these cursors, and handing them out anyway would scatter the
    // payload; the whole text at every cursor is then the only honest reading of it.
    if (metadata && resolved.length > 1 && metadata.perSelection.length === resolved.length) {
      return this.applyDistributedPaste(session, metadata.perSelection, resolved)
    }

    return applyPasteText(session, text)
  }

  /**
   * A payload copied off carets is a set of lines, so it lands as lines: at the start of the line
   * each caret is on rather than splicing itself into the middle of whatever word the caret is in.
   */
  private applyLinePaste(
    session: DocumentSession,
    text: string,
    resolved: readonly ResolvedSelection[],
  ): DocumentSessionChange {
    const starts = this.caretLines(resolved).map((line) => line.start)
    const edits = starts.map((start) => ({ from: start, text, to: start }))
    const selections = starts.map((start, index) => {
      const caret = start + text.length * (index + 1)
      return { anchor: caret, head: caret }
    })
    return applyPasteEdits(session, edits, selections)
  }

  private applyDistributedPaste(
    session: DocumentSession,
    texts: readonly string[],
    resolved: readonly ResolvedSelection[],
  ): DocumentSessionChange {
    const edits: TextEdit[] = []
    const selections: { readonly anchor: number; readonly head: number }[] = []
    // Every edit is expressed against the document as it stands now, but the carets left behind are
    // read back off the document the batch produces, so they carry what the earlier ones shifted.
    let shift = 0
    for (const [index, selection] of resolved.entries()) {
      const fragment = texts[index] ?? ''
      edits.push({ from: selection.startOffset, text: fragment, to: selection.endOffset })
      const caret = selection.startOffset + shift + fragment.length
      selections.push({ anchor: caret, head: caret })
      shift += fragment.length - (selection.endOffset - selection.startOffset)
    }

    return applyPasteEdits(session, edits, selections)
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    const session = this.session
    if (!session) return
    if (!this.options.canEditDocument()) return

    const fallbackText = keyboardFallbackText(event)
    if (fallbackText === null) return
    if (this.inputState.compositionActive) return

    if (this.canWaitForNativeTextInput(event, fallbackText)) {
      this.startKeyboardTextFallbackWait(event, fallbackText)
      return
    }

    event.preventDefault()
    this.resolvePendingKeyboardTextFallback()
    this.applyKeyboardTextFallback(fallbackText, eventStartMs(event))
    if (event.target !== this.options.view.inputElement) this.options.view.focusInput()
  }

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.resolvePendingKeyboardTextFallback()
    this.syncSessionSelectionFromDom(event)
  }

  private canWaitForNativeTextInput(event: KeyboardEvent, text: string): boolean {
    return canWaitForNativeTextInput(this.inputState, {
      targetIsHiddenInput: event.target === this.options.view.inputElement,
      text,
    })
  }

  private startKeyboardTextFallbackWait(event: KeyboardEvent, text: string): void {
    const start = eventStartMs(event)
    const nativeInputGeneration = this.inputState.nativeInputGeneration

    if (hasPendingKeyboardTextFallbackForGeneration(this.inputState, nativeInputGeneration)) {
      this.transitionInputState({ startMs: start, text, type: 'native-input-wait-appended' })
      return
    }

    this.cancelPendingKeyboardTextFallback()
    this.transitionInputState({
      generation: nativeInputGeneration,
      startMs: start,
      text,
      type: 'native-input-wait-started',
    })
  }

  private cancelPendingKeyboardTextFallback(): void {
    const pending = pendingKeyboardTextFallback(this.inputState)
    if (!pending) return

    this.transitionInputState({ type: 'native-input-wait-cancelled' })
  }

  private resolvePendingKeyboardTextFallback(): void {
    const pending = pendingKeyboardTextFallback(this.inputState)
    if (!pending) return

    this.transitionInputState({ generation: pending.generation, type: 'native-input-missing' })
    this.transitionInputState({ type: 'native-input-wait-cancelled' })
    this.applyKeyboardTextFallback(pending.text, pending.startMs, pending.generation)
  }

  private applyKeyboardTextFallback(
    text: string,
    start: number,
    nativeInputGeneration?: number,
  ): void {
    const session = this.session
    if (!session) return
    if (!this.options.canEditDocument()) return
    if (
      nativeInputGeneration !== undefined &&
      this.inputState.nativeInputGeneration !== nativeInputGeneration
    ) {
      return
    }

    const selectionChange = measureEditorPerformance('input.selectionChangeBeforeEdit', () =>
      this.selectionChangeBeforeEdit(),
    )
    this.options.view.inputElement.value = ''
    this.transitionInputState({ type: 'hidden-input-cleared' })
    const textChange = measureEditorPerformance('session.applyText', () =>
      this.applyTypedText(session, text),
    )
    this.transitionInputState({ type: 'transaction-committed' })
    this.options.applySessionChange(
      mergeChangeTimings(textChange, selectionChange),
      'input.keydownFallback',
      start,
    )
  }

  private applyCompositionText(text: string, start: number): void {
    const session = this.session
    if (!session) return
    if (!this.options.canEditDocument()) return
    if (text.length === 0) return

    this.transitionInputState({ text, type: 'composition-pending' })
    const selectionChange = measureEditorPerformance('input.selectionChangeBeforeEdit', () =>
      this.selectionChangeBeforeEdit(),
    )
    this.options.view.inputElement.value = ''
    this.transitionInputState({ type: 'hidden-input-cleared' })
    const textChange = measureEditorPerformance('session.applyText', () => session.applyText(text))
    this.transitionInputState({ type: 'transaction-committed' })
    this.options.applySessionChange(
      mergeChangeTimings(textChange, selectionChange),
      'input.composition',
      start,
    )
  }

  private applyIndentToSession(): DocumentSessionChange {
    const session = this.session
    if (!session) throw new Error('missing editor session')
    if (this.shouldInsertLiteralTab()) return session.applyText('\t')
    return session.indentSelection('\t')
  }

  private shouldInsertLiteralTab(): boolean {
    const session = this.session
    if (!session) return false

    const snapshot = session.getSnapshot()
    const selections = session.getSelections().selections
    return selections.every((selection) => resolveSelection(snapshot, selection).collapsed)
  }

  private cursorSelectionByDisplayRows(
    selection: ResolvedSelection,
    rowDelta: -1 | 1,
  ): {
    readonly anchor: number
    readonly goal: SelectionGoalValue
    readonly sourceHead: number
  } {
    const { goal, column } = verticalMoveGoal(
      selection.goal,
      selection.headOffset,
      this.options.view,
    )
    return {
      anchor: this.options.view.offsetByDisplayRows(selection.headOffset, rowDelta, column),
      goal,
      sourceHead: selection.headOffset,
    }
  }

  private resolvedSelections(): readonly ResolvedSelection[] {
    const session = this.session
    if (!session) return []

    const snapshot = session.getSnapshot()
    return session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection))
  }

  /** The cursor a gesture that ends up with one selection continues from. */
  private primaryResolvedSelection(): ResolvedSelection | null {
    const session = this.session
    if (!session) return null

    const resolved = this.resolvedSelections()
    return resolved[lastAddedSelectionIndex(session.getSelections())] ?? resolved[0] ?? null
  }

  private addNextExactOccurrence(): OccurrenceSelectionChange | null {
    const session = this.session
    if (!session) return null

    const selections = session.getSelections()
    const resolved = this.resolvedSelections()
    const source = resolved[lastAddedSelectionIndex(selections)] ?? resolved.at(-1)
    if (!source) return null

    // A run started on a bare caret is a rename in the making, and the word the caret sat in is the
    // whole of what the user meant: without the boundaries, `id` also claims the `id` inside
    // `width` and `hidden`, and the next keystroke overwrites them all.
    const wholeWord =
      this.occurrenceRunFor(selections)?.wholeWord ?? (resolved.length === 1 && source.collapsed)
    const result = this.nextExactOccurrence(session, resolved, source, wholeWord)
    if (!result) return null

    this.occurrenceRun = { selections: session.getSelections(), wholeWord }
    return result
  }

  private occurrenceRunFor(selections: SelectionSet<PieceTableAnchor>): OccurrenceRun | null {
    const run = this.occurrenceRun
    if (!run || run.selections !== selections) return null
    return run
  }

  private nextExactOccurrence(
    session: DocumentSession,
    resolved: readonly ResolvedSelection[],
    source: ResolvedSelection,
    wholeWord: boolean,
  ): OccurrenceSelectionChange | null {
    const text = session.materializeFullText()
    if (resolved.length === 1 && source.collapsed) {
      return this.selectCurrentWordForOccurrence(text, source)
    }

    const query = occurrenceQueryForSelection(text, source)
    if (!query) return null

    const selected = resolved.map((selection) => ({
      start: selection.startOffset,
      end: selection.endOffset,
    }))
    const range = findNextExactOccurrenceFromRange(
      text,
      query.query,
      selected,
      query.range,
      wholeWord,
    )
    if (!range) return null

    const selections = [
      ...resolved.map((selection) => ({
        anchor: selection.anchorOffset,
        head: selection.headOffset,
      })),
      { anchor: range.start, head: range.end },
    ]
    return {
      change: session.setSelections(selections),
      revealOffset: range.end,
    }
  }

  private occurrenceQueryForCurrentSelection(text: string): OccurrenceQuery | null {
    const resolved = this.resolvedSelections()
    const selected = resolved.find((selection) => !selection.collapsed)
    if (selected) return occurrenceQueryForSelection(text, selected)

    const primary = resolved[0]
    if (!primary) return null
    return occurrenceQueryForSelection(text, primary)
  }

  private selectCurrentWordForOccurrence(
    text: string,
    selection: ResolvedSelection,
  ): OccurrenceSelectionChange | null {
    const session = this.session
    if (!session) return null

    const range = wordRangeAtOffset(text, selection.headOffset)
    if (range.start === range.end) return null

    return {
      change: session.setSelection(range.start, range.end),
      revealOffset: range.end,
    }
  }

  private clipboardPayload(): ClipboardPayload | null {
    const session = this.session
    if (!session) return null

    const snapshot = session.getSnapshot()
    const resolved = this.resolvedSelections()
    const selected = resolved.filter((selection) => !selection.collapsed)
    if (selected.length > 0) {
      const perSelection = selected.map((selection) =>
        readPieceTableTextRange(snapshot, selection.startOffset, selection.endOffset),
      )
      return { metadata: { perSelection, pasteOnNewLine: false }, text: perSelection.join('\n') }
    }

    // A caret that selects nothing is pointing at its line, so that is what it takes. The
    // terminator travels with it: it is what makes the payload a line rather than a run of
    // characters, both to the next paste and to any other application it is handed to.
    const perSelection = this.caretLines(resolved).map((line) => `${line.text}\n`)
    if (perSelection.length === 0) return null

    return { metadata: { perSelection, pasteOnNewLine: true }, text: perSelection.join('') }
  }

  /** The lines the carets are on, in document order; two carets on one line answer for it once. */
  private caretLines(resolved: readonly ResolvedSelection[]): readonly NavigationLine[] {
    const lines: NavigationLine[] = []
    for (const selection of resolved) {
      const line = this.readLineAt(selection.headOffset)
      if (!line) continue
      if (lines.at(-1)?.start === line.start) continue

      lines.push(line)
    }

    return lines
  }

  private primarySelectionHeadOffset(change: DocumentSessionChange): number | undefined {
    const selection = change.selections.selections[0]
    if (!selection) return undefined

    return resolveSelection(change.snapshot, selection).headOffset
  }

  private syncSessionSelectionFromDom = (_event: Event): void => {
    if (!this.session) return
    if (!shouldSyncSessionSelectionFromDom(this.inputState, this.domSelectionContext())) return

    const start = nowMs()
    const change = this.updateSessionSelectionFromDom()
    if (!change) return

    this.markDomSelectionForNextInput()
    const timedChange = appendTiming(change, 'input.selection', start)
    this.options.getSessionOptions().onChange?.(timedChange)
    this.options.notifyViewContributions('selection', null)
    this.options.notifyChangeWithTiming(timedChange)
  }

  private updateSessionSelectionFromDom(): DocumentSessionChange | null {
    const session = this.session
    if (!session) return null

    const readStart = nowMs()
    const offsets = this.readDomSelectionOffsets()
    if (!offsets) return null

    this.syncCustomSelectionHighlight(offsets.anchorOffset, offsets.headOffset)
    return appendTiming(
      session.setSelection(offsets.anchorOffset, offsets.headOffset),
      'editor.readDomSelection',
      readStart,
    )
  }

  private selectionChangeBeforeEdit(): DocumentSessionChange | null {
    const source = selectionBeforeEditSource(this.inputState, this.domSelectionContext())
    if (source === 'hidden-input') {
      this.markHiddenInputSelectionForNextInput()
      return null
    }
    if (source === 'dom') return this.updateSessionSelectionFromDom()

    this.markDomSelectionForNextInput()
    return null
  }

  private readDomSelectionOffsets(): { anchorOffset: number; headOffset: number } | null {
    const selection = window.getSelection()
    if (!selection?.anchorNode || !selection.focusNode) return null

    const anchorOffset = this.domBoundaryToTextOffset(selection.anchorNode, selection.anchorOffset)
    const headOffset = this.domBoundaryToTextOffset(selection.focusNode, selection.focusOffset)
    if (anchorOffset === null || headOffset === null) return null

    return { anchorOffset, headOffset }
  }

  private syncCustomSelectionFromDom = (): void => {
    if (!this.session) return
    if (!shouldSyncCustomSelectionFromDom(this.inputState, this.domSelectionContext())) return

    const offsets = this.readDomSelectionOffsets()
    if (!offsets) return

    this.syncCustomSelectionHighlight(offsets.anchorOffset, offsets.headOffset)
  }

  private syncCustomSelectionHighlight(anchorOffset: number, headOffset: number): void {
    this.options.view.setSelection(anchorOffset, headOffset)
    this.transitionInputState({ owner: 'dom', type: 'selection-reconciled' })
  }

  private isInputFocused(): boolean {
    return this.options.el.ownerDocument.activeElement === this.options.view.inputElement
  }

  private domSelectionContext(): { readonly hiddenInputFocused: boolean } {
    return {
      hiddenInputFocused: this.isInputFocused(),
    }
  }

  private hasFocusedExternalElement(): boolean {
    const activeElement = this.options.el.ownerDocument.activeElement
    if (!activeElement) return false
    if (activeElement === this.options.el.ownerDocument.body) return false
    if (activeElement === this.options.el.ownerDocument.documentElement) return false

    return !this.options.el.contains(activeElement)
  }

  private domBoundaryToTextOffset(node: Node, offset: number): number | null {
    const viewOffset = this.options.view.textOffsetFromDomBoundary(node, offset)
    if (viewOffset !== null) return viewOffset

    if (node === this.options.el) return elementBoundaryToTextOffset(offset, this.text.length)
    return this.externalBoundaryToTextOffset(node, offset)
  }

  private textOffsetFromMouseEvent(event: MouseEvent): number | null {
    return this.textOffsetFromPoint(event.clientX, event.clientY)
  }

  private externalBoundaryToTextOffset(node: Node, offset: number): number | null {
    if (node.contains(this.options.el)) {
      const child = childContainingNode(node, this.options.el)
      const childIndex = child ? childNodeIndex(node, child) : -1
      if (childIndex === -1) return null
      return elementBoundaryToTextOffset(offset <= childIndex ? 0 : 1, this.text.length)
    }

    const position = node.compareDocumentPosition(this.options.el)
    if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return 0
    if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return this.text.length
    return null
  }
}

function mouseSelectionTimingName(granularity: MouseSelectionGranularity): string {
  if (granularity === 'line') return 'input.tripleClick'
  if (granularity === 'word') return 'input.doubleClick'
  return 'input.selection'
}

/**
 * Whether any of a line falls inside the rectangle's band of columns, given where the band's two
 * edges land once that line's tabs have been accounted for.
 */
function columnBandCoversLine(
  rectangle: ColumnSelectionRectangle,
  fromColumn: number,
  toColumn: number,
): boolean {
  if (rectangle.fromColumn < rectangle.toColumn) {
    return fromColumn <= rectangle.toColumn && toColumn >= rectangle.fromColumn
  }
  if (rectangle.fromColumn > rectangle.toColumn) {
    return toColumn <= rectangle.fromColumn && fromColumn >= rectangle.toColumn
  }

  // A band with no width is a click, not a drag, and every line it passes through takes a caret.
  return true
}

function columnSelectionRowDelta(command: EditorCommandId, pageRows: number): number {
  if (command === 'cursorColumnSelectUp') return -1
  if (command === 'cursorColumnSelectDown') return 1
  if (command === 'cursorColumnSelectPageUp') return -pageRows
  return pageRows
}

function pasteRevealBlock(text: string): SessionChangeOptions['revealBlock'] {
  if (text.includes('\n') || text.includes('\r')) return 'end'
  return 'nearest'
}

function applyPasteText(session: DocumentSession, text: string): DocumentSessionChange {
  session.breakTypingRun()
  const change = session.applyText(text)
  session.breakTypingRun()
  return change
}

function applyPasteEdits(
  session: DocumentSession,
  edits: readonly TextEdit[],
  selections: readonly { readonly anchor: number; readonly head: number }[],
): DocumentSessionChange {
  session.breakTypingRun()
  const change = session.applyEdits(edits, { selections })
  session.breakTypingRun()
  return change
}

function dropPlainText(event: DragEvent): string {
  const transfer = event.dataTransfer
  if (!transfer) return ''

  const plainText = transfer.getData('text/plain')
  if (plainText.length > 0) return plainText
  return transfer.getData('text')
}

function beforeInputText(event: InputEvent): string | null {
  if (event.inputType === 'insertLineBreak') return '\n'
  if (event.inputType === 'insertText') return event.data ?? ''
  if (event.inputType === 'insertFromComposition') return event.data ?? ''
  return null
}
