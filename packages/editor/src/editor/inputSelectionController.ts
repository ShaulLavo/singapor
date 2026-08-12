import type { DocumentSession, DocumentSessionChange } from '../documentSession'
import { readPieceTableTextRange } from '../pieceTable/reads'
import {
  SelectionGoal,
  resolveSelection,
  type ResolvedSelection,
  type SelectionGoal as SelectionGoalValue,
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
import { childContainingNode, childNodeIndex, elementBoundaryToTextOffset } from './domBoundary'
import { editActionForCommand, type EditorEditActionCommandId } from './editActions'
import {
  capitalize,
  eventTargetInsideBlockSurface,
  indentTimingName,
  selectionGoalColumn,
  type SessionChangeOptions,
} from './editorUtils'
import { keyboardFallbackText } from './input'
import {
  cancelFrame,
  mouseSelectionAutoScrollDelta,
  requestFrame,
  type MouseSelectionDrag,
} from './mouseSelection'
import { navigationTargetForCommand } from './navigationTargets'
import {
  findAllExactOccurrences,
  findNextExactOccurrence,
  findNextExactOccurrenceFromRange,
  getOccurrenceQuery,
  occurrenceQueryForSelection,
  occurrenceSelectTimingName,
  type OccurrenceQuery,
  type OccurrenceSelectionChange,
} from './occurrences'
import { lineRangeAtOffset, wordRangeAtOffset } from './textRanges'
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
import type { PieceTableSnapshot } from '../pieceTable/pieceTableTypes'

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

export class InputSelectionController {
  private readonly autoClose = new AutoCloseStore()
  private mouseSelectionDrag: MouseSelectionDrag | null = null
  private mouseSelectionAutoScrollFrame = 0
  private inputState: EditorInputState = createEditorInputState()
  private nativeInputHandlersInstalled = false

  constructor(private readonly options: InputSelectionControllerOptions) {}

  install(): void {
    const { el } = this.options
    el.addEventListener('mousedown', this.handleMouseDown)
    el.addEventListener('beforeinput', this.handleBeforeInput)
    el.addEventListener('copy', this.handleCopy)
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
    const decided = this.autoCloseChange(session, text)
    if (decided) return decided

    const change = session.applyText(text)
    // Plain typing keeps tracked pairs alive; their anchors have already shifted with the edit.
    this.autoClose.advance(change.snapshot)
    return change
  }

  /** The auto-close variant of a keystroke, or null when the keystroke is ordinary. */
  private autoCloseChange(
    session: DocumentSession,
    text: string,
  ): DocumentSessionChange | null {
    if (text.length !== 1) return null

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
    const change = session.applyEdits([{ from: caret, text: opening.open + opening.close, to: caret }], {
      selections: [{ anchor: caret + opening.open.length, head: caret + opening.open.length }],
    })
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
    const pair = charBefore === null ? null : autoClosingPairForOpen(this.options.getLanguageId(), charBefore)
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
        ? (this.deleteAutoClosedPair(session) ?? session.backspace())
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

    const start = context.event ? eventStartMs(context.event) : nowMs()
    const change = session.clearSecondarySelections()
    if (change.kind === 'none') return false

    this.syncSessionSelectionHighlight()
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, 'input.clearSecondarySelections', start, {
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

    const snapshot = session.getSnapshot()
    const text = session.materializeFullText()
    const resolvedSelections = session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection))
    if (resolvedSelections.length === 0) return false

    const navigation = resolvedSelections.map((resolved) => ({
      resolved,
      target: navigationTargetForCommand({
        command,
        resolved,
        text,
        documentLength: snapshot.length,
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

    if (event.detail === 3) {
      this.selectLineAtOffset(event, offset)
      return
    }

    if (event.detail === 2) {
      this.selectWordAtOffset(event, offset)
      return
    }

    if (event.altKey) {
      this.addCursorAtOffset(event, offset)
      return
    }

    this.startMouseSelectionDrag(event, offset)
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

  private startMouseSelectionDrag(event: MouseEvent, offset: number): void {
    if (event.button !== 0) return
    if (event.detail !== 1) return

    event.preventDefault()
    this.options.view.focusInput()
    this.mouseSelectionDrag = {
      anchorOffset: offset,
      headOffset: offset,
      clientX: event.clientX,
      clientY: event.clientY,
    }
    this.syncCustomSelectionHighlight(offset, offset)
    this.transitionInputState({ type: 'mouse-selection-start' })
    this.options.el.ownerDocument.addEventListener('mousemove', this.updateMouseSelectionDrag)
    this.options.el.ownerDocument.addEventListener('mouseup', this.finishMouseSelectionDrag)
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

    drag.clientX = event.clientX
    drag.clientY = event.clientY
    const offset = this.mouseSelectionOffsetFromPoint(drag.clientX, drag.clientY)
    event.preventDefault()
    this.stopMouseSelectionDrag('finish')

    const start = nowMs()
    const change = session.setSelection(drag.anchorOffset, offset)
    const syncDomSelection = drag.anchorOffset === offset
    this.syncCustomSelectionHighlight(drag.anchorOffset, offset)
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, 'input.selection', start, { syncDomSelection })
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
    this.syncCustomSelectionHighlight(drag.anchorOffset, offset)
    session.setSelection(drag.anchorOffset, offset)
    this.options.notifyViewContributions('selection', null)
    if (drag.anchorOffset === offset) {
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

  private selectLineAtOffset(event: MouseEvent, offset: number): void {
    const session = this.session
    if (!session) return

    const range = lineRangeAtOffset(session.materializeFullText(), offset)
    this.selectRange(event, range, 'input.tripleClick')
  }

  private selectWordAtOffset(event: MouseEvent, offset: number): void {
    const session = this.session
    if (!session) return

    const range = wordRangeAtOffset(session.materializeFullText(), offset)
    if (range.start === range.end) return

    this.selectRange(event, range, 'input.doubleClick')
  }

  private selectRange(
    event: MouseEvent,
    range: { readonly start: number; readonly end: number },
    timingName: string,
  ): void {
    const session = this.session
    if (!session) return

    const start = eventStartMs(event)
    event.preventDefault()
    const change = session.setSelection(range.start, range.end)
    this.syncCustomSelectionHighlight(range.start, range.end)
    this.markSessionSelectionForNextInput()
    this.options.applySessionChange(change, timingName, start, { syncDomSelection: false })
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
        : session.applyText(inserted),
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

    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text.length === 0) return

    this.cancelPendingKeyboardTextFallback()
    this.transitionInputState({ text, type: 'paste-pending' })
    const start = eventStartMs(event)
    const selectionChange = this.selectionChangeBeforeEdit()
    event.preventDefault()
    const change = mergeChangeTimings(applyPasteText(session, text), selectionChange)
    this.transitionInputState({ type: 'transaction-committed' })
    this.options.applySessionChange(change, 'input.paste', start, {
      revealBlock: pasteRevealBlock(text),
      revealOffset: this.primarySelectionHeadOffset(change),
    })
  }

  private handleDrop = (event: DragEvent): void => {
    const session = this.session
    if (!session) return

    this.cancelPendingKeyboardTextFallback()
    event.preventDefault()
    if (!this.options.canEditDocument()) return

    const text = dropPlainText(event)
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
    const text = this.selectedTextForClipboard()
    if (text === null) return
    if (!event.clipboardData) return

    event.clipboardData.setData('text/plain', text)
    event.preventDefault()
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
    const visualColumn = selectionGoalColumn(selection, this.options.view)
    return {
      anchor: this.options.view.offsetByDisplayRows(selection.headOffset, rowDelta, visualColumn),
      goal: SelectionGoal.horizontal(visualColumn),
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

  private addNextExactOccurrence(): OccurrenceSelectionChange | null {
    const session = this.session
    if (!session) return null

    const text = session.materializeFullText()
    const resolved = this.resolvedSelections()
    const primary = resolved[0]
    if (!primary) return null

    if (resolved.length === 1 && primary.collapsed) {
      return this.selectCurrentWordForOccurrence(text, primary)
    }

    const query = getOccurrenceQuery(text, resolved)
    if (!query) return null

    const range = findNextExactOccurrence(text, query, resolved)
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

  private selectedTextForClipboard(): string | null {
    const session = this.session
    if (!session) return null

    const snapshot = session.getSnapshot()
    const texts = session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection))
      .filter((selection) => !selection.collapsed)
      .map((selection) =>
        readPieceTableTextRange(snapshot, selection.startOffset, selection.endOffset),
      )
    if (texts.length === 0) return null

    return texts.join('\n')
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
