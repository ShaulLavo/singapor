import {
  createAnchorSelection,
  createSelectionIdFactory,
  createSelectionSet,
  markSelectionSetDirty,
  normalizeSelectionSet,
  type AnchorSelection,
  type SelectionIdFactory,
  type SelectionGoal,
  type SelectionSet,
} from './selections'
import {
  applyTextToSelections,
  backspaceSelections,
  deleteSelections,
  indentSelections,
  outdentSelections,
} from './documentSelectionEdits'
import {
  amendEditorHistory,
  commitEditorHistory,
  createEditorHistory,
  redoEditorHistory,
  undoEditorHistory,
  type EditorHistory,
} from './history'
import type { TextEdit } from './tokens'
import { EditorEventSource } from './editor/emitter'
import { createDocumentTextSnapshot, type DocumentTextSnapshot } from './documentTextSnapshot'
import type { Anchor as PieceTableAnchor, PieceTableSnapshot } from './pieceTable/pieceTableTypes'
import { applyBatchToPieceTable, snapBatchEditRanges } from './pieceTable/edits'
import { readPieceTableTextRange, pieceTableSnapshotsHaveSameText } from './pieceTable/reads'
import { createPieceTableSnapshot } from './pieceTable/snapshot'
import { normalizeDocumentText, normalizeLineEndings } from './pieceTable/lineEndings'

export type DocumentSessionChangeKind = 'edit' | 'selection' | 'undo' | 'redo' | 'none'

export type EditorTimingMeasurement = {
  readonly name: string
  readonly durationMs: number
}

export type DocumentSessionChange = {
  readonly kind: DocumentSessionChangeKind
  readonly edits: readonly TextEdit[]
  readonly transaction: DocumentTransaction | null
  readonly snapshot: PieceTableSnapshot
  readonly selections: SelectionSet<PieceTableAnchor>
  readonly textSnapshot: DocumentTextSnapshot
  readonly timings: readonly EditorTimingMeasurement[]
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly isDirty: boolean
}

export type DocumentSession = {
  applyText(text: string): DocumentSessionChange
  indentSelection(text: string): DocumentSessionChange
  outdentSelection(tabSize: number): DocumentSessionChange
  applyEdits(
    edits: readonly TextEdit[],
    options?: DocumentSessionApplyEditsOptions,
  ): DocumentSessionChange
  backspace(): DocumentSessionChange
  deleteSelection(): DocumentSessionChange
  undo(): DocumentSessionChange
  redo(): DocumentSessionChange
  setSelection(
    anchorOffset: number,
    headOffset?: number,
    options?: DocumentSessionSelectionOptions,
  ): DocumentSessionChange
  setSelections(
    selections: readonly DocumentSessionSelectionRange[],
    options?: DocumentSessionSelectionOptions,
  ): DocumentSessionChange
  addSelection(
    anchorOffset: number,
    headOffset?: number,
    options?: DocumentSessionSelectionOptions,
  ): DocumentSessionChange
  clearSecondarySelections(): DocumentSessionChange
  materializeFullText(): string
  getTextSnapshot(): DocumentTextSnapshot
  getSelections(): SelectionSet<PieceTableAnchor>
  getSnapshot(): PieceTableSnapshot
  canUndo(): boolean
  canRedo(): boolean
  isDirty(): boolean
  markClean(): void
  breakTypingRun(): void
}

export type EditorViewScrollPosition = {
  readonly left?: number
  readonly top?: number
}

export type EditorViewMetadataValue =
  | boolean
  | null
  | number
  | readonly EditorViewMetadataValue[]
  | string
  | { readonly [key: string]: EditorViewMetadataValue }

export type EditorTextBufferChange = {
  readonly change: DocumentSessionChange
  readonly sourceViewId: string | null
}

export type EditorTextBufferChangeListener = (event: EditorTextBufferChange) => void

export type EditorTextBuffer = {
  applyText(
    selections: SelectionSet<PieceTableAnchor>,
    text: string,
    sourceViewId?: string | null,
  ): DocumentSessionChange
  indentSelection(
    selections: SelectionSet<PieceTableAnchor>,
    text: string,
    sourceViewId?: string | null,
  ): DocumentSessionChange
  outdentSelection(
    selections: SelectionSet<PieceTableAnchor>,
    tabSize: number,
    sourceViewId?: string | null,
  ): DocumentSessionChange
  applyEdits(
    selections: SelectionSet<PieceTableAnchor>,
    edits: readonly TextEdit[],
    options?: DocumentSessionApplyEditsOptions,
    sourceViewId?: string | null,
  ): DocumentSessionChange
  backspace(
    selections: SelectionSet<PieceTableAnchor>,
    sourceViewId?: string | null,
  ): DocumentSessionChange
  deleteSelection(
    selections: SelectionSet<PieceTableAnchor>,
    sourceViewId?: string | null,
  ): DocumentSessionChange
  undo(sourceViewId?: string | null): DocumentSessionChange
  redo(sourceViewId?: string | null): DocumentSessionChange
  materializeFullText(): string
  getTextSnapshot(): DocumentTextSnapshot
  getSnapshot(): PieceTableSnapshot
  getRevision(): number
  // Whether materializing the whole document as one string is a heap hazard,
  // the streaming alternative being `getTextSnapshot()`'s `forEachTextChunk`.
  // Decided once when the buffer is constructed and never re-evaluated, so a
  // consumer that branched on it at open cannot have the answer change under it
  // mid-session. Nothing in the repo branches on it yet.
  isTooLargeForHeapOperation(): boolean
  canUndo(): boolean
  canRedo(): boolean
  isDirty(): boolean
  markClean(): void
  breakTypingRun(): void
  subscribe(listener: EditorTextBufferChangeListener): () => void
}

export type EditorViewSession = {
  readonly viewId: string
  getSelections(): SelectionSet<PieceTableAnchor>
  setSelection(
    anchorOffset: number,
    headOffset?: number,
    options?: DocumentSessionSelectionOptions,
  ): DocumentSessionChange
  setSelections(
    selections: readonly DocumentSessionSelectionRange[],
    options?: DocumentSessionSelectionOptions,
  ): DocumentSessionChange
  addSelection(
    anchorOffset: number,
    headOffset?: number,
    options?: DocumentSessionSelectionOptions,
  ): DocumentSessionChange
  clearSecondarySelections(): DocumentSessionChange
  acceptBufferSelections(selections: SelectionSet<PieceTableAnchor>): void
  getScrollPosition(): EditorViewScrollPosition | undefined
  setScrollPosition(scrollPosition: EditorViewScrollPosition | undefined): void
  getMetadata(key: string): EditorViewMetadataValue | undefined
  setMetadata(key: string, value: EditorViewMetadataValue | undefined): void
}

export type EditorBufferSession = DocumentSession & {
  readonly buffer: EditorTextBuffer
  readonly view: EditorViewSession
}

export type DocumentSessionSelectionOptions = {
  readonly goal?: SelectionGoal
}

export type DocumentSessionSelectionRange = {
  readonly anchor: number
  readonly head?: number
  readonly goal?: SelectionGoal
}

export type DocumentSessionEditHistoryMode = 'record' | 'skip'

export type DocumentSessionEditSelection = DocumentSessionSelectionRange

export type DocumentSessionApplyEditsOptions = {
  readonly history?: DocumentSessionEditHistoryMode
  readonly selection?: DocumentSessionEditSelection
  readonly selections?: readonly DocumentSessionEditSelection[]
}

export type DocumentTransactionMetadata = {
  readonly source: 'keyboard' | 'programmatic' | 'history'
  readonly intent:
    | 'insert-text'
    | 'indent'
    | 'outdent'
    | 'backspace'
    | 'delete'
    | 'programmatic-edit'
    | 'undo'
    | 'redo'
  readonly undoGroup?: string
}

export type DocumentTransaction = {
  readonly edits: readonly TextEdit[]
  readonly inverseEdits: readonly TextEdit[]
  readonly snapshotBefore: PieceTableSnapshot
  readonly snapshotAfter: PieceTableSnapshot
  readonly selectionBefore: SelectionSet<PieceTableAnchor>
  readonly selectionAfter: SelectionSet<PieceTableAnchor>
  readonly metadata: DocumentTransactionMetadata
}

type CommitEditOptions = {
  readonly history: DocumentSessionEditHistoryMode
  readonly metadata: DocumentTransactionMetadata
  readonly selectionBefore: SelectionSet<PieceTableAnchor>
  readonly sourceViewId: string | null
}

type DocumentHistory = EditorHistory<
  PieceTableSnapshot,
  SelectionSet<PieceTableAnchor>,
  DocumentTransaction
>

type DocumentTransactionIntent = DocumentTransactionMetadata['intent']

type TypingRunKind = 'insert' | 'backspace' | 'delete'

// Whether the run currently ends in a space, and whether that space had one
// before it. A lone space belongs to the word that follows, so it must not end
// a run; a second one is deliberate enough that the text either side of it is
// worth undoing separately.
type TypingRunSpacing = 'none' | 'first-space' | 'consecutive-space'

type TypingRun = {
  readonly kind: TypingRunKind
  readonly spacing: TypingRunSpacing
  // Where the run left the caret, which is the only place the next keystroke of
  // the same kind can continue it from: inserts and forward deletes start here,
  // a backspace ends here.
  readonly caretOffset: number
}

// Roughly 512MB of UTF-16 for one string, so past this point materializing the
// whole document is a bug rather than a slow path.
export const MAX_HEAP_OPERATION_LENGTH = 256 * 1024 * 1024

export const exceedsHeapOperationBudget = (length: number): boolean =>
  length > MAX_HEAP_OPERATION_LENGTH

class PieceTableEditorTextBuffer implements EditorTextBuffer {
  private readonly changes = new EditorEventSource<EditorTextBufferChange>({
    action: 'editor.buffer.change_listener_failed',
  })
  private history: DocumentHistory
  private cleanSnapshot: PieceTableSnapshot
  private dirtyCacheSnapshot: PieceTableSnapshot
  private dirtyCacheValue = false
  private revision = 0
  private typingRun: TypingRun | null = null
  private textSnapshot: DocumentTextSnapshot
  private readonly tooLargeForHeapOperation: boolean

  public constructor(rawText: string) {
    // Ingested first so the retained copy below is the text the piece table
    // actually holds. Folding U+2028/U+2029 to LF does not change the length,
    // so handing the raw string to createDocumentTextSnapshot would sail past
    // its length check and leave every reader — including the view's line-start
    // scan — looking at characters the model does not have.
    const ingested = normalizeDocumentText(rawText)
    const text = ingested.text
    const snapshot = createPieceTableSnapshot(text, {
      normalized: true,
      lineEnding: ingested.lineEnding,
      byteOrderMark: ingested.byteOrderMark,
    })
    const selections = createInitialSelectionSet(snapshot, createSelectionIdFactory())
    this.history = createEditorHistory<
      PieceTableSnapshot,
      SelectionSet<PieceTableAnchor>,
      DocumentTransaction
    >(snapshot, selections)
    this.cleanSnapshot = snapshot
    this.dirtyCacheSnapshot = snapshot
    this.textSnapshot = createDocumentTextSnapshot(snapshot, text)
    this.tooLargeForHeapOperation = exceedsHeapOperationBudget(snapshot.length)
  }

  public applyText(
    selections: SelectionSet<PieceTableAnchor>,
    rawText: string,
    sourceViewId: string | null = null,
  ): DocumentSessionChange {
    const start = nowMs()
    // Pasted text is the common CRLF carrier; flatten before the edits are
    // derived so selections land where the inserted text actually ends.
    const text = normalizeLineEndings(rawText)
    if (text.length === 0) {
      return appendTiming(this.createChange('none', []), 'session.applyText', start)
    }

    const result = applyTextToSelections(this.history.current, selections, text)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: { source: 'keyboard', intent: 'insert-text' },
        selectionBefore: selections,
        sourceViewId,
      }),
      'session.applyText',
      start,
    )
  }

  public indentSelection(
    selections: SelectionSet<PieceTableAnchor>,
    text: string,
    sourceViewId: string | null = null,
  ): DocumentSessionChange {
    const start = nowMs()
    const result = indentSelections(this.history.current, selections, text)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: { source: 'keyboard', intent: 'indent' },
        selectionBefore: selections,
        sourceViewId,
      }),
      'session.indentSelection',
      start,
    )
  }

  public outdentSelection(
    selections: SelectionSet<PieceTableAnchor>,
    tabSize: number,
    sourceViewId: string | null = null,
  ): DocumentSessionChange {
    const start = nowMs()
    const result = outdentSelections(this.history.current, selections, tabSize)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: { source: 'keyboard', intent: 'outdent' },
        selectionBefore: selections,
        sourceViewId,
      }),
      'session.outdentSelection',
      start,
    )
  }

  public applyEdits(
    selections: SelectionSet<PieceTableAnchor>,
    edits: readonly TextEdit[],
    options: DocumentSessionApplyEditsOptions = {},
    sourceViewId: string | null = null,
  ): DocumentSessionChange {
    const start = nowMs()
    const normalizedEdits = normalizeTextEdits(edits)
    if (normalizedEdits.length === 0) {
      return appendTiming(this.createChange('none', []), 'session.applyEdits', start)
    }

    // Snapping can widen an edit off a surrogate pair, so the applied ranges are
    // not always the ones we were handed. Everything downstream of this change —
    // undo inversion, incremental re-render, decoration remapping, the LSP's
    // copy of the document — has to be told what actually happened.
    const appliedEdits = snapBatchEditRanges(this.history.current, normalizedEdits)
    const nextSnapshot = applyBatchToPieceTable(this.history.current, appliedEdits)
    const effectiveEdits = appliedEdits.filter(isEffectiveTextEdit)
    if (effectiveEdits.length === 0) {
      return appendTiming(this.createChange('none', []), 'session.applyEdits', start)
    }

    const nextSelections = this.selectionsAfterProgrammaticEdit(
      nextSnapshot,
      selections,
      options.selection,
      options.selections,
    )
    return appendTiming(
      this.commitEdit(nextSnapshot, nextSelections, effectiveEdits, {
        history: options.history ?? 'record',
        metadata: { source: 'programmatic', intent: 'programmatic-edit' },
        selectionBefore: selections,
        sourceViewId,
      }),
      'session.applyEdits',
      start,
    )
  }

  public backspace(
    selections: SelectionSet<PieceTableAnchor>,
    sourceViewId: string | null = null,
  ): DocumentSessionChange {
    const start = nowMs()
    const result = backspaceSelections(this.history.current, selections)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: { source: 'keyboard', intent: 'backspace' },
        selectionBefore: selections,
        sourceViewId,
      }),
      'session.backspace',
      start,
    )
  }

  public deleteSelection(
    selections: SelectionSet<PieceTableAnchor>,
    sourceViewId: string | null = null,
  ): DocumentSessionChange {
    const start = nowMs()
    const result = deleteSelections(this.history.current, selections)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: { source: 'keyboard', intent: 'delete' },
        selectionBefore: selections,
        sourceViewId,
      }),
      'session.delete',
      start,
    )
  }

  public undo(sourceViewId: string | null = null): DocumentSessionChange {
    const start = nowMs()
    const transaction = this.history.undo?.entry.transaction ?? null
    const next = undoEditorHistory(this.history)
    this.typingRun = null
    if (next === this.history) {
      return appendTiming(this.createChange('none', []), 'session.undo', start)
    }

    this.history = next
    this.textSnapshot = createDocumentTextSnapshot(this.history.current)
    this.revision += 1
    const change = appendTiming(
      this.createChange('undo', transaction?.inverseEdits ?? [], transaction),
      'session.undo',
      start,
    )
    this.emitChange(change, sourceViewId)
    return change
  }

  public redo(sourceViewId: string | null = null): DocumentSessionChange {
    const start = nowMs()
    const transaction = this.history.redo?.entry.transaction ?? null
    const next = redoEditorHistory(this.history)
    this.typingRun = null
    if (next === this.history) {
      return appendTiming(this.createChange('none', []), 'session.redo', start)
    }

    this.history = next
    this.textSnapshot = createDocumentTextSnapshot(this.history.current)
    this.revision += 1
    const change = appendTiming(
      this.createChange('redo', transaction?.edits ?? [], transaction),
      'session.redo',
      start,
    )
    this.emitChange(change, sourceViewId)
    return change
  }

  public materializeFullText(): string {
    return this.textSnapshot.materializeFullText()
  }

  public getTextSnapshot(): DocumentTextSnapshot {
    return this.textSnapshot
  }

  public getSnapshot(): PieceTableSnapshot {
    return this.history.current
  }

  public getRevision(): number {
    return this.revision
  }

  public isTooLargeForHeapOperation(): boolean {
    return this.tooLargeForHeapOperation
  }

  public canUndo(): boolean {
    return this.history.undo !== null
  }

  public canRedo(): boolean {
    return this.history.redo !== null
  }

  public isDirty(): boolean {
    const snapshot = this.history.current
    if (this.dirtyCacheSnapshot === snapshot) return this.dirtyCacheValue

    const dirty = !pieceTableSnapshotsHaveSameText(snapshot, this.cleanSnapshot)
    this.dirtyCacheSnapshot = snapshot
    this.dirtyCacheValue = dirty
    return dirty
  }

  public markClean(): void {
    this.cleanSnapshot = this.history.current
    this.dirtyCacheSnapshot = this.history.current
    this.dirtyCacheValue = false
  }

  public breakTypingRun(): void {
    this.typingRun = null
  }

  public subscribe(listener: EditorTextBufferChangeListener): () => void {
    const subscription = this.changes.subscribe(listener)
    return () => subscription.dispose()
  }

  private commitEdit(
    snapshot: PieceTableSnapshot,
    selections: SelectionSet<PieceTableAnchor>,
    edits: readonly TextEdit[],
    options: CommitEditOptions,
  ): DocumentSessionChange {
    if (edits.length === 0) return this.createChange('none', [])

    const transaction = this.createTransaction(
      snapshot,
      options.selectionBefore,
      selections,
      edits,
      options.metadata,
    )
    if (options.history === 'record') {
      this.commitRecordedEdit(snapshot, selections, edits, options, transaction)
    } else {
      this.history = { ...this.history, current: snapshot, selections }
    }

    this.typingRun = createTypingRun(this.typingRun, edits, options.metadata.intent, transaction)
    this.textSnapshot = createDocumentTextSnapshot(snapshot)
    this.revision += 1
    const change = this.createChange('edit', edits, transaction)
    this.emitChange(change, options.sourceViewId)
    return change
  }

  private commitRecordedEdit(
    snapshot: PieceTableSnapshot,
    selections: SelectionSet<PieceTableAnchor>,
    edits: readonly TextEdit[],
    options: CommitEditOptions,
    transaction: DocumentTransaction,
  ): void {
    const previous = this.history.undo?.entry.transaction
    const kind = typingRunKind(options.metadata.intent)

    if (kind && previous && this.shouldAmendTypingRun(kind, edits, transaction, previous)) {
      this.history = amendEditorHistory(
        this.history,
        snapshot,
        selections,
        createAmendedTypingTransaction(previous, transaction, kind),
      )
      return
    }

    this.history = commitEditorHistory(
      { ...this.history, selections: options.selectionBefore },
      snapshot,
      selections,
      transaction,
    )
  }

  private shouldAmendTypingRun(
    kind: TypingRunKind,
    edits: readonly TextEdit[],
    transaction: DocumentTransaction,
    previous: DocumentTransaction,
  ): boolean {
    const run = this.typingRun
    if (!run || run.kind !== kind) return false

    const edit = singleTypingRunEdit(edits, kind)
    if (!edit) return false
    if (!continuesTypingRun(run, edit)) return false
    if (kind === 'insert' && endsInsertRun(run.spacing, edit.text)) return false
    if (kind !== 'insert' && !removesSingleCodePoint(transaction)) return false
    return canAmendTypingTransaction(previous, kind)
  }

  private selectionsAfterProgrammaticEdit(
    snapshot: PieceTableSnapshot,
    currentSelections: SelectionSet<PieceTableAnchor>,
    selection: DocumentSessionEditSelection | undefined,
    selections: readonly DocumentSessionEditSelection[] | undefined,
  ): SelectionSet<PieceTableAnchor> {
    if (selections) return createNormalizedSelectionSetForSnapshot(snapshot, selections, {})

    if (selection) {
      return createNormalizedSelectionSetForSnapshot(snapshot, [selection], {})
    }

    return markSelectionSetDirty(currentSelections)
  }

  private createTransaction(
    snapshot: PieceTableSnapshot,
    selectionBefore: SelectionSet<PieceTableAnchor>,
    selections: SelectionSet<PieceTableAnchor>,
    edits: readonly TextEdit[],
    metadata: DocumentTransactionMetadata,
  ): DocumentTransaction {
    return {
      edits,
      inverseEdits: invertTextEdits(this.history.current, edits),
      snapshotBefore: this.history.current,
      snapshotAfter: snapshot,
      selectionBefore,
      selectionAfter: selections,
      metadata,
    }
  }

  private createChange(
    kind: DocumentSessionChangeKind,
    edits: readonly TextEdit[],
    transaction: DocumentTransaction | null = null,
  ): DocumentSessionChange {
    return createDocumentSessionChange({
      kind,
      edits,
      transaction,
      snapshot: this.history.current,
      selections: this.history.selections,
      textSnapshot: this.textSnapshot,
      timings: [],
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      isDirty: this.isDirty(),
    })
  }

  private emitChange(change: DocumentSessionChange, sourceViewId: string | null | undefined): void {
    if (change.kind === 'none') return

    this.changes.fire({ change, sourceViewId: sourceViewId ?? null })
  }
}

class PieceTableEditorViewSession implements EditorViewSession {
  private readonly createSelectionId: SelectionIdFactory = createSelectionIdFactory()
  private readonly metadata = new Map<string, EditorViewMetadataValue>()
  private readonly buffer: EditorTextBuffer
  private scrollPosition: EditorViewScrollPosition | undefined
  private selections: SelectionSet<PieceTableAnchor>

  public constructor(buffer: EditorTextBuffer, viewId: string) {
    this.buffer = buffer
    this.viewId = viewId
    this.selections = createInitialSelectionSet(buffer.getSnapshot(), this.createSelectionId)
  }

  public readonly viewId: string

  public getSelections(): SelectionSet<PieceTableAnchor> {
    return this.selections
  }

  public setSelection(
    anchorOffset: number,
    headOffset = anchorOffset,
    options: DocumentSessionSelectionOptions = {},
  ): DocumentSessionChange {
    return this.setSelections([{ anchor: anchorOffset, head: headOffset }], options)
  }

  public setSelections(
    selections: readonly DocumentSessionSelectionRange[],
    options: DocumentSessionSelectionOptions = {},
  ): DocumentSessionChange {
    const start = nowMs()
    this.buffer.breakTypingRun()
    this.selections = this.createNormalizedSelectionSet(selections, options)
    return appendTiming(this.createChange('selection', []), 'session.selection', start)
  }

  public addSelection(
    anchorOffset: number,
    headOffset = anchorOffset,
    options: DocumentSessionSelectionOptions = {},
  ): DocumentSessionChange {
    const start = nowMs()
    this.buffer.breakTypingRun()
    const nextSelection = this.createSelection(anchorOffset, headOffset, options)
    this.selections = normalizeSelectionSet(
      this.buffer.getSnapshot(),
      createSelectionSet([...this.selections.selections, nextSelection]),
    )
    return appendTiming(this.createChange('selection', []), 'session.addSelection', start)
  }

  public clearSecondarySelections(): DocumentSessionChange {
    const start = nowMs()
    const snapshot = this.buffer.getSnapshot()
    const normalized = normalizeSelectionSet(snapshot, this.selections)
    const primary = normalized.selections[0]
    if (!primary || normalized.selections.length <= 1) {
      return appendTiming(this.createChange('none', []), 'session.clearSecondarySelections', start)
    }

    this.selections = createSelectionSet([primary], true, snapshot)
    this.buffer.breakTypingRun()
    return appendTiming(
      this.createChange('selection', []),
      'session.clearSecondarySelections',
      start,
    )
  }

  public acceptBufferSelections(selections: SelectionSet<PieceTableAnchor>): void {
    this.selections = selections
  }

  public getScrollPosition(): EditorViewScrollPosition | undefined {
    return this.scrollPosition
  }

  public setScrollPosition(scrollPosition: EditorViewScrollPosition | undefined): void {
    this.scrollPosition = scrollPosition
  }

  public getMetadata(key: string): EditorViewMetadataValue | undefined {
    return this.metadata.get(key)
  }

  public setMetadata(key: string, value: EditorViewMetadataValue | undefined): void {
    if (value === undefined) {
      this.metadata.delete(key)
      return
    }

    this.metadata.set(key, value)
  }

  private createNormalizedSelectionSet(
    selections: readonly DocumentSessionSelectionRange[],
    options: DocumentSessionSelectionOptions,
  ): SelectionSet<PieceTableAnchor> {
    return createNormalizedSelectionSetForSnapshot(
      this.buffer.getSnapshot(),
      selections,
      options,
      this.createSelectionId,
    )
  }

  private createSelection(
    anchorOffset: number,
    headOffset: number,
    options: DocumentSessionSelectionOptions,
  ): AnchorSelection {
    return createAnchorSelection(this.buffer.getSnapshot(), anchorOffset, headOffset, {
      goal: options.goal,
      idFactory: this.createSelectionId,
    })
  }

  private createChange(
    kind: DocumentSessionChangeKind,
    edits: readonly TextEdit[],
  ): DocumentSessionChange {
    return createDocumentSessionChange({
      kind,
      edits,
      transaction: null,
      snapshot: this.buffer.getSnapshot(),
      selections: this.selections,
      textSnapshot: this.buffer.getTextSnapshot(),
      timings: [],
      canUndo: this.buffer.canUndo(),
      canRedo: this.buffer.canRedo(),
      isDirty: this.buffer.isDirty(),
    })
  }
}

class EditorBufferDocumentSession implements EditorBufferSession {
  public constructor(
    public readonly buffer: EditorTextBuffer,
    public readonly view: EditorViewSession,
  ) {}

  public applyText(text: string): DocumentSessionChange {
    return this.acceptBufferChange(
      this.buffer.applyText(this.view.getSelections(), text, this.view.viewId),
    )
  }

  public indentSelection(text: string): DocumentSessionChange {
    return this.acceptBufferChange(
      this.buffer.indentSelection(this.view.getSelections(), text, this.view.viewId),
    )
  }

  public outdentSelection(tabSize: number): DocumentSessionChange {
    return this.acceptBufferChange(
      this.buffer.outdentSelection(this.view.getSelections(), tabSize, this.view.viewId),
    )
  }

  public applyEdits(
    edits: readonly TextEdit[],
    options: DocumentSessionApplyEditsOptions = {},
  ): DocumentSessionChange {
    return this.acceptBufferChange(
      this.buffer.applyEdits(this.view.getSelections(), edits, options, this.view.viewId),
    )
  }

  public backspace(): DocumentSessionChange {
    return this.acceptBufferChange(
      this.buffer.backspace(this.view.getSelections(), this.view.viewId),
    )
  }

  public deleteSelection(): DocumentSessionChange {
    return this.acceptBufferChange(
      this.buffer.deleteSelection(this.view.getSelections(), this.view.viewId),
    )
  }

  public undo(): DocumentSessionChange {
    return this.acceptBufferChange(this.buffer.undo(this.view.viewId))
  }

  public redo(): DocumentSessionChange {
    return this.acceptBufferChange(this.buffer.redo(this.view.viewId))
  }

  public setSelection(
    anchorOffset: number,
    headOffset?: number,
    options?: DocumentSessionSelectionOptions,
  ): DocumentSessionChange {
    return this.view.setSelection(anchorOffset, headOffset, options)
  }

  public setSelections(
    selections: readonly DocumentSessionSelectionRange[],
    options?: DocumentSessionSelectionOptions,
  ): DocumentSessionChange {
    return this.view.setSelections(selections, options)
  }

  public addSelection(
    anchorOffset: number,
    headOffset?: number,
    options?: DocumentSessionSelectionOptions,
  ): DocumentSessionChange {
    return this.view.addSelection(anchorOffset, headOffset, options)
  }

  public clearSecondarySelections(): DocumentSessionChange {
    return this.view.clearSecondarySelections()
  }

  public materializeFullText(): string {
    return this.buffer.materializeFullText()
  }

  public getTextSnapshot(): DocumentTextSnapshot {
    return this.buffer.getTextSnapshot()
  }

  public getSelections(): SelectionSet<PieceTableAnchor> {
    return this.view.getSelections()
  }

  public getSnapshot(): PieceTableSnapshot {
    return this.buffer.getSnapshot()
  }

  public canUndo(): boolean {
    return this.buffer.canUndo()
  }

  public canRedo(): boolean {
    return this.buffer.canRedo()
  }

  public isDirty(): boolean {
    return this.buffer.isDirty()
  }

  public markClean(): void {
    this.buffer.markClean()
  }

  public breakTypingRun(): void {
    this.buffer.breakTypingRun()
  }

  private acceptBufferChange(change: DocumentSessionChange): DocumentSessionChange {
    if (change.kind !== 'none') this.view.acceptBufferSelections(change.selections)

    return change
  }
}

class StaticDocumentSession implements DocumentSession {
  private readonly createSelectionId: SelectionIdFactory = createSelectionIdFactory()
  private snapshot: PieceTableSnapshot
  private textSnapshot: DocumentTextSnapshot
  private selections: SelectionSet<PieceTableAnchor>

  public constructor(rawText: string) {
    // Same ingestion-before-retention rule as PieceTableEditorTextBuffer.
    const ingested = normalizeDocumentText(rawText)
    this.snapshot = createPieceTableSnapshot(ingested.text, {
      normalized: true,
      lineEnding: ingested.lineEnding,
      byteOrderMark: ingested.byteOrderMark,
    })
    this.textSnapshot = createDocumentTextSnapshot(this.snapshot, ingested.text)
    this.selections = createSelectionSet(
      [
        createAnchorSelection(this.snapshot, this.snapshot.length, this.snapshot.length, {
          idFactory: this.createSelectionId,
        }),
      ],
      true,
      this.snapshot,
    )
  }

  public applyText(_text: string): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public indentSelection(_text: string): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public outdentSelection(_tabSize: number): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public applyEdits(
    edits: readonly TextEdit[],
    options: DocumentSessionApplyEditsOptions = {},
  ): DocumentSessionChange {
    const start = nowMs()
    const normalizedEdits = normalizeTextEdits(edits)
    if (normalizedEdits.length === 0) {
      return appendTiming(this.createChange('none', []), 'session.applyEdits', start)
    }

    const appliedEdits = snapBatchEditRanges(this.snapshot, normalizedEdits)
    const nextSnapshot = applyBatchToPieceTable(this.snapshot, appliedEdits)
    const effectiveEdits = appliedEdits.filter(isEffectiveTextEdit)
    if (effectiveEdits.length === 0) {
      return appendTiming(this.createChange('none', []), 'session.applyEdits', start)
    }

    this.snapshot = nextSnapshot
    this.textSnapshot = createDocumentTextSnapshot(nextSnapshot)
    this.selections = this.selectionsAfterProgrammaticEdit(nextSnapshot, options)
    return appendTiming(this.createChange('edit', effectiveEdits), 'session.applyEdits', start)
  }

  public backspace(): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public deleteSelection(): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public undo(): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public redo(): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public setSelection(
    anchorOffset: number,
    headOffset = anchorOffset,
    options: DocumentSessionSelectionOptions = {},
  ): DocumentSessionChange {
    return this.setSelections([{ anchor: anchorOffset, head: headOffset }], options)
  }

  public setSelections(
    selections: readonly DocumentSessionSelectionRange[],
    options: DocumentSessionSelectionOptions = {},
  ): DocumentSessionChange {
    const start = nowMs()
    this.selections = this.createNormalizedSelectionSet(selections, options)
    return appendTiming(this.createChange('selection', []), 'session.selection', start)
  }

  public addSelection(
    anchorOffset: number,
    headOffset = anchorOffset,
    options: DocumentSessionSelectionOptions = {},
  ): DocumentSessionChange {
    const start = nowMs()
    const nextSelection = this.createSelection(anchorOffset, headOffset, options)
    this.selections = normalizeSelectionSet(
      this.snapshot,
      createSelectionSet([...this.selections.selections, nextSelection]),
    )
    return appendTiming(this.createChange('selection', []), 'session.addSelection', start)
  }

  public clearSecondarySelections(): DocumentSessionChange {
    const start = nowMs()
    const normalized = normalizeSelectionSet(this.snapshot, this.selections)
    const primary = normalized.selections[0]
    if (!primary || normalized.selections.length <= 1) {
      return appendTiming(this.createChange('none', []), 'session.clearSecondarySelections', start)
    }

    this.selections = createSelectionSet([primary], true, this.snapshot)
    return appendTiming(
      this.createChange('selection', []),
      'session.clearSecondarySelections',
      start,
    )
  }

  public materializeFullText(): string {
    return this.textSnapshot.materializeFullText()
  }

  public getTextSnapshot(): DocumentTextSnapshot {
    return this.textSnapshot
  }

  public getSelections(): SelectionSet<PieceTableAnchor> {
    return this.selections
  }

  public getSnapshot(): PieceTableSnapshot {
    return this.snapshot
  }

  public canUndo(): boolean {
    return false
  }

  public canRedo(): boolean {
    return false
  }

  public isDirty(): boolean {
    return false
  }

  public markClean(): void {
    return
  }

  public breakTypingRun(): void {
    return
  }

  private createNormalizedSelectionSet(
    selections: readonly DocumentSessionSelectionRange[],
    options: DocumentSessionSelectionOptions,
  ): SelectionSet<PieceTableAnchor> {
    const anchorSelections = selections.map((selection) => {
      const head = selection.head ?? selection.anchor
      return this.createSelection(selection.anchor, head, {
        goal: selection.goal ?? options.goal,
      })
    })
    return normalizeSelectionSet(this.snapshot, createSelectionSet(anchorSelections))
  }

  private createSelection(
    anchorOffset: number,
    headOffset: number,
    options: DocumentSessionSelectionOptions,
  ): AnchorSelection {
    return createAnchorSelection(this.snapshot, anchorOffset, headOffset, {
      goal: options.goal,
      idFactory: this.createSelectionId,
    })
  }

  private selectionsAfterProgrammaticEdit(
    snapshot: PieceTableSnapshot,
    options: DocumentSessionApplyEditsOptions,
  ): SelectionSet<PieceTableAnchor> {
    if (options.selections) {
      return this.createNormalizedSelectionSetForSnapshot(snapshot, options.selections, {})
    }
    if (options.selection) {
      return this.createNormalizedSelectionSetForSnapshot(snapshot, [options.selection], {})
    }

    return markSelectionSetDirty(this.selections)
  }

  private createNormalizedSelectionSetForSnapshot(
    snapshot: PieceTableSnapshot,
    selections: readonly DocumentSessionSelectionRange[],
    options: DocumentSessionSelectionOptions,
  ): SelectionSet<PieceTableAnchor> {
    const anchorSelections = selections.map((selection) => {
      const head = selection.head ?? selection.anchor
      return createAnchorSelection(snapshot, selection.anchor, head, {
        goal: selection.goal ?? options.goal,
        idFactory: this.createSelectionId,
      })
    })
    return normalizeSelectionSet(snapshot, createSelectionSet(anchorSelections))
  }

  private createChange(
    kind: DocumentSessionChangeKind,
    edits: readonly TextEdit[],
  ): DocumentSessionChange {
    return createDocumentSessionChange({
      kind,
      edits,
      transaction: null,
      snapshot: this.snapshot,
      selections: this.selections,
      textSnapshot: this.textSnapshot,
      timings: [],
      canUndo: false,
      canRedo: false,
      isDirty: false,
    })
  }
}

export function createEditorTextBuffer(text: string): EditorTextBuffer {
  return new PieceTableEditorTextBuffer(text)
}

export function createEditorViewSession(
  buffer: EditorTextBuffer,
  viewId = createEditorViewSessionId(),
): EditorViewSession {
  return new PieceTableEditorViewSession(buffer, viewId)
}

export function createEditorBufferSession(
  buffer: EditorTextBuffer,
  view: EditorViewSession = createEditorViewSession(buffer),
): EditorBufferSession {
  return new EditorBufferDocumentSession(buffer, view)
}

export function createDocumentSession(text: string): DocumentSession {
  return createEditorBufferSession(createEditorTextBuffer(text))
}

export function createStaticDocumentSession(text: string): DocumentSession {
  return new StaticDocumentSession(text)
}

type DocumentSessionChangeFields = DocumentSessionChange

function createDocumentSessionChange(fields: DocumentSessionChangeFields): DocumentSessionChange {
  return { ...fields } // TODO why do we need this func??
}

function typingRunKind(intent: DocumentTransactionIntent): TypingRunKind | null {
  if (intent === 'insert-text') return 'insert'
  if (intent === 'backspace') return 'backspace'
  if (intent === 'delete') return 'delete'
  return null
}

// A run is what one held-down key produces, so it is built from single edits
// only; a multi-cursor pass or an inserted newline is a separate action and gets
// its own undo entry.
function singleTypingRunEdit(edits: readonly TextEdit[], kind: TypingRunKind): TextEdit | null {
  const edit = edits[0]
  if (edits.length !== 1 || !edit) return null

  if (kind === 'insert') {
    if (edit.from !== edit.to || edit.text.length === 0) return null
    return edit.text.includes('\n') ? null : edit
  }

  return edit.from !== edit.to && edit.text.length === 0 ? edit : null
}

function continuesTypingRun(run: TypingRun, edit: TextEdit): boolean {
  return run.kind === 'backspace' ? edit.to === run.caretOffset : edit.from === run.caretOffset
}

// Deleting a selection is one deliberate action rather than a keystroke in a
// run, so it must not swallow the keystrokes around it into its undo entry.
function removesSingleCodePoint(transaction: DocumentTransaction): boolean {
  const removed = transaction.inverseEdits[0]?.text ?? ''
  return [...removed].length === 1
}

function isWhitespace(text: string): boolean {
  return /\s/u.test(text)
}

function endsInsertRun(spacing: TypingRunSpacing, text: string): boolean {
  const typed = text[0]
  if (!typed) return false
  if (spacing === 'first-space') return false
  return isWhitespace(typed) !== (spacing === 'consecutive-space')
}

function nextTypingRunSpacing(spacing: TypingRunSpacing, text: string): TypingRunSpacing {
  const last = text.at(-1)!
  if (!isWhitespace(last)) return 'none'
  return spacing === 'none' ? 'first-space' : 'consecutive-space'
}

function createTypingRun(
  previous: TypingRun | null,
  edits: readonly TextEdit[],
  intent: DocumentTransactionIntent,
  transaction: DocumentTransaction,
): TypingRun | null {
  const kind = typingRunKind(intent)
  if (!kind) return null

  const edit = singleTypingRunEdit(edits, kind)
  if (!edit) return null

  if (kind !== 'insert') {
    return removesSingleCodePoint(transaction)
      ? { kind, spacing: 'none', caretOffset: edit.from }
      : null
  }

  return {
    kind,
    spacing: nextTypingRunSpacing(
      previous?.kind === 'insert' ? previous.spacing : 'none',
      edit.text,
    ),
    caretOffset: edit.from + edit.text.length,
  }
}

function canAmendTypingTransaction(transaction: DocumentTransaction, kind: TypingRunKind): boolean {
  return singleTypingRunEdit(transaction.edits, kind) !== null
}

function createAmendedTypingTransaction(
  previous: DocumentTransaction,
  next: DocumentTransaction,
  kind: TypingRunKind,
): DocumentTransaction {
  const merged =
    kind === 'insert'
      ? mergeInsertedRun(previous, next)
      : mergeRemovedRun(previous, next, kind === 'backspace')

  return {
    ...previous,
    edits: merged.edits,
    inverseEdits: merged.inverseEdits,
    snapshotAfter: next.snapshotAfter,
    selectionAfter: next.selectionAfter,
  }
}

type MergedRunEdits = {
  readonly edits: readonly TextEdit[]
  readonly inverseEdits: readonly TextEdit[]
}

function mergeInsertedRun(
  previous: DocumentTransaction,
  next: DocumentTransaction,
): MergedRunEdits {
  const previousEdit = previous.edits[0]!
  const runStart = previousEdit.from
  const text = previousEdit.text + next.edits[0]!.text

  return {
    edits: [{ from: runStart, to: runStart, text }],
    inverseEdits: [{ from: runStart, to: runStart + text.length, text: '' }],
  }
}

// Both edits are ranges of the document the run started from, and a backspace
// only ever widens that range to the left while a forward delete only widens it
// to the right — which is also the order the removed text has to be put back in.
function mergeRemovedRun(
  previous: DocumentTransaction,
  next: DocumentTransaction,
  backwards: boolean,
): MergedRunEdits {
  const previousEdit = previous.edits[0]!
  const nextEdit = next.edits[0]!
  const previousText = previous.inverseEdits[0]!.text
  const nextText = next.inverseEdits[0]!.text

  const from = backwards ? nextEdit.from : previousEdit.from
  const to = backwards ? previousEdit.to : previousEdit.to + (nextEdit.to - nextEdit.from)
  const text = backwards ? nextText + previousText : previousText + nextText

  return {
    edits: [{ from, to, text: '' }],
    inverseEdits: [{ from, to: from, text }],
  }
}

export function documentSessionChangeTextSnapshot(
  change: DocumentSessionChange,
): DocumentTextSnapshot {
  return change.textSnapshot
}

export function withDocumentSessionChangeTimings(
  change: DocumentSessionChange,
  timings: readonly EditorTimingMeasurement[],
): DocumentSessionChange {
  return createDocumentSessionChange({
    kind: change.kind,
    edits: change.edits,
    transaction: change.transaction,
    snapshot: change.snapshot,
    selections: change.selections,
    textSnapshot: documentSessionChangeTextSnapshot(change),
    timings,
    canUndo: change.canUndo,
    canRedo: change.canRedo,
    isDirty: change.isDirty,
  })
}

// Line endings are flattened here rather than inside insertIntoPieceTable so
// that the edits recorded for history, the inverse edits, and the tree all
// describe the same text; undo derives its ranges from edit.text.length.
function normalizeTextEdits(edits: readonly TextEdit[]): readonly TextEdit[] {
  return edits
    .map((edit) => ({ from: edit.from, to: edit.to, text: normalizeLineEndings(edit.text) }))
    .sort((left, right) => left.from - right.from || left.to - right.to)
}

function isEffectiveTextEdit(edit: TextEdit): boolean {
  return edit.from !== edit.to || edit.text.length > 0
}

function invertTextEdits(
  snapshot: PieceTableSnapshot,
  edits: readonly TextEdit[],
): readonly TextEdit[] {
  let delta = 0
  const inverse: TextEdit[] = []
  const sorted = edits.toSorted((left, right) => left.from - right.from || left.to - right.to) // TODO check if we can sort in place
  for (const edit of sorted) {
    const from = edit.from + delta
    const to = from + edit.text.length
    inverse.push({
      from,
      to,
      text: readPieceTableTextRange(snapshot, edit.from, edit.to),
    })
    delta += edit.text.length - (edit.to - edit.from)
  }

  return inverse
}

function createInitialSelectionSet(
  snapshot: PieceTableSnapshot,
  idFactory: SelectionIdFactory,
): SelectionSet<PieceTableAnchor> {
  return createSelectionSet(
    [
      createAnchorSelection(snapshot, snapshot.length, snapshot.length, {
        idFactory,
      }),
    ],
    true,
    snapshot,
  )
}

function createNormalizedSelectionSetForSnapshot(
  snapshot: PieceTableSnapshot,
  selections: readonly DocumentSessionSelectionRange[],
  options: DocumentSessionSelectionOptions,
  idFactory?: SelectionIdFactory,
): SelectionSet<PieceTableAnchor> {
  const anchorSelections = selections.map((selection) => {
    const head = selection.head ?? selection.anchor
    return createAnchorSelection(snapshot, selection.anchor, head, {
      goal: selection.goal ?? options.goal,
      idFactory,
    })
  })
  return normalizeSelectionSet(snapshot, createSelectionSet(anchorSelections))
}

let nextEditorViewSessionId = 0

function createEditorViewSessionId(): string {
  const id = nextEditorViewSessionId
  nextEditorViewSessionId += 1
  return `editor-view:${id.toString(36)}`
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now()
}

function appendTiming(
  change: DocumentSessionChange,
  name: string,
  startMs: number,
): DocumentSessionChange {
  return withDocumentSessionChangeTimings(change, [
    ...change.timings,
    { name, durationMs: nowMs() - startMs },
  ])
}
