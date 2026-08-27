import {
  createAnchorSelection,
  createSelectionIdFactory,
  createSelectionSet,
  markSelectionSetDirty,
  normalizeSelectionSet,
  type AnchorSelection,
  type SelectionAffinity,
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
import { diffPieceTableSnapshots } from './pieceTable/diff'
import { readPieceTableTextRange, pieceTableSnapshotsHaveSameText } from './pieceTable/reads'
import { createPieceTableSnapshot } from './pieceTable/snapshot'
import { normalizeDocumentText, normalizeLineEndings } from './pieceTable/lineEndings'
import {
  DocumentEditChain,
  type DocumentChangesSinceSyncPoint,
  type DocumentLogicalRevisionScope,
  type DocumentSyncPoint,
} from './editor/editChain'

export type DocumentSessionChangeKind =
  | 'edit'
  | 'selection'
  | 'undo'
  | 'redo'
  | 'synchronize'
  | 'none'

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
  readonly logicalRevisionCount: number
  readonly logicalRevisionScope: DocumentLogicalRevisionScope | null
}

export type DocumentSession = {
  applyText(text: string): DocumentSessionChange
  indentSelection(text: string): DocumentSessionChange
  outdentSelection(tabSize: number): DocumentSessionChange
  applyEdits(
    edits: readonly TextEdit[],
    options?: DocumentSessionApplyEditsOptions,
  ): DocumentSessionChange
  backspace(tabSize?: number): DocumentSessionChange
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
  readonly origin: 'external' | 'view'
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
    tabSize?: number,
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
  getDocumentSyncPoint(): DocumentSyncPoint
  changesSinceDocumentSyncPoint(
    point: DocumentSyncPoint,
    scope: DocumentLogicalRevisionScope | null,
  ): DocumentChangesSinceSyncPoint | null
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
  readonly affinity?: SelectionAffinity
}

export type DocumentSessionSelectionRange = {
  readonly anchor: number
  readonly head?: number
  readonly goal?: SelectionGoal
  readonly affinity?: SelectionAffinity
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
  readonly logicalRevisionCount: number
  readonly logicalRevisionScope: DocumentLogicalRevisionScope | null
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

export type PreparedDocumentTransaction = {
  readonly hasTextChange: boolean
  readonly logicalRevisionCount: number
  readonly logicalRevisionScope: DocumentLogicalRevisionScope | null
  readonly expectedRevision: number
  readonly snapshotBefore: PieceTableSnapshot
  readonly snapshotAfter: PieceTableSnapshot
  readonly edits: readonly TextEdit[]
  readonly inverseEdits: readonly TextEdit[]
}

declare const preparedDocumentTransactionSequenceBrand: unique symbol
declare const documentTransactionSequenceReverseBrand: unique symbol
declare const documentTransactionReceiptBrand: unique symbol
declare const documentMutationLeaseBrand: unique symbol

export type PreparedDocumentTransactionSequence = {
  readonly [preparedDocumentTransactionSequenceBrand]: true
  readonly expectedRevision: number
  readonly segments: readonly PreparedDocumentTransaction[]
  readonly snapshotAfter: PieceTableSnapshot
  readonly snapshotBefore: PieceTableSnapshot
}

export type DocumentTransactionSequenceSegmentInput = {
  readonly edits: readonly TextEdit[]
  readonly logicalRevisionCount: number
  readonly logicalRevisionScope: DocumentLogicalRevisionScope | null
}

export type DocumentTransactionSequenceReverseCursor = {
  readonly [documentTransactionSequenceReverseBrand]: true
  readonly nextSegmentIndex: number
}

export type DocumentTransactionHistory =
  | { readonly kind: 'record'; readonly undoGroup?: string }
  | { readonly groupId: string; readonly kind: 'external-barrier' }

export type DocumentTransactionCommitTarget = {
  readonly buffer: EditorTextBuffer
  readonly mutationLease?: DocumentMutationLease
  readonly sourceView: EditorViewSession | null
}

export type DocumentTransactionCommitOptions = {
  readonly history: DocumentTransactionHistory
  readonly selection?: DocumentSessionEditSelection
  readonly selections?: readonly DocumentSessionEditSelection[]
}

export type DocumentMutationLease = {
  readonly [documentMutationLeaseBrand]: true
  readonly ownerId: string
}

export type AcquireDocumentMutationLeaseResult =
  | { readonly lease: DocumentMutationLease; readonly status: 'acquired' }
  | { readonly status: 'busy' | 'stale' }

export type DocumentMutationLeaseState = {
  readonly isLeased: boolean
  readonly ownerId: string | null
}

export type DocumentMutationLeaseStateListener = (state: DocumentMutationLeaseState) => void

export type DocumentTransactionReceipt = {
  readonly [documentTransactionReceiptBrand]: true
  readonly edits: readonly TextEdit[]
  readonly history: DocumentTransactionHistory
  readonly inverseEdits: readonly TextEdit[]
  readonly logicalRevisionCount: number
  readonly phase: 'provisional' | 'sealed'
  readonly revisionAfter: number
  readonly revisionBefore: number
  readonly segmentCount: number
  readonly snapshotAfter: PieceTableSnapshot
  readonly snapshotBefore: PieceTableSnapshot
}

export type PreparedDocumentCommitResult =
  | {
      readonly status: 'committed'
      readonly change: DocumentSessionChange
      readonly receipt: DocumentTransactionReceipt
    }
  | { readonly status: 'logical-only'; readonly change: DocumentSessionChange }
  | { readonly status: 'stale' }

export type PreparedDocumentSequenceSegmentCommitResult =
  | {
      readonly change: DocumentSessionChange
      readonly receipt: DocumentTransactionReceipt | null
      readonly status: 'committed' | 'logical-only'
    }
  | { readonly status: 'out-of-order' | 'stale' }

export type CompletePreparedDocumentSequenceResult =
  | { readonly receipt: DocumentTransactionReceipt | null; readonly status: 'completed' }
  | { readonly status: 'incomplete' | 'stale' }

export type BeginReverseDocumentTransactionSequenceResult =
  | {
      readonly cursor: DocumentTransactionSequenceReverseCursor
      readonly status: 'started'
    }
  | { readonly status: 'stale' }

export type ReverseDocumentTransactionSequenceSegmentResult =
  | {
      readonly change: DocumentSessionChange
      readonly cursor: DocumentTransactionSequenceReverseCursor
      readonly status: 'reversed'
    }
  | { readonly status: 'out-of-order' | 'stale' }

export type CompleteReverseDocumentTransactionSequenceResult =
  | { readonly receipt: DocumentTransactionReceipt; readonly status: 'completed' }
  | { readonly status: 'incomplete' | 'stale' }

export type RotateDocumentSyncSegmentResult =
  | { readonly status: 'rotated'; readonly syncPoint: DocumentSyncPoint }
  | { readonly status: 'stale' }

export type ReverseDocumentTransactionResult =
  | {
      readonly status: 'reversed'
      readonly change: DocumentSessionChange
      readonly receipt: DocumentTransactionReceipt
    }
  | { readonly status: 'stale' }

export type SealDocumentTransactionResult = {
  readonly receipt: DocumentTransactionReceipt
  readonly status: 'sealed' | 'already-sealed'
}

export type ReleaseDocumentTransactionResult = {
  readonly status: 'released' | 'already-released'
}

export type ReleaseDocumentMutationLeaseResult = {
  readonly status: 'released' | 'already-released'
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

type DocumentBarrierState = {
  readonly buffer: PieceTableEditorTextBuffer
  historyBefore: DocumentHistory
  older: DocumentBarrierState | null
  phase: 'provisional' | 'sealed'
  released: boolean
  installed: boolean
  readonly revisionBefore: number
  revisionAfter: number
  readonly history: DocumentTransactionHistory
  readonly segments: DocumentTransaction[]
}

type PreparedSequenceState = {
  nextSegmentIndex: number
  receipt: DocumentTransactionReceipt | null
}

type ReverseSequenceState = {
  readonly barrier: DocumentBarrierState
  expectedCurrentBarrier: DocumentBarrierState | null
  expectedRevision: number
  readonly historyBeforeReverse: DocumentHistory
  readonly receipt: DocumentTransactionReceipt
  readonly revisionBefore: number
  readonly wasInstalled: boolean
  completed: boolean
  nextSegmentIndex: number
  readonly reversedTransactions: DocumentTransaction[]
}

const receiptStates = new WeakMap<DocumentTransactionReceipt, DocumentBarrierState>()
const sequenceStates = new WeakMap<PreparedDocumentTransactionSequence, PreparedSequenceState>()
const reverseCursorStates = new WeakMap<
  DocumentTransactionSequenceReverseCursor,
  ReverseSequenceState
>()

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
  private readonly leaseChanges = new EditorEventSource<DocumentMutationLeaseState>({
    action: 'editor.buffer.lease_listener_failed',
  })
  private readonly editChain = new DocumentEditChain(0, 0)
  private history: DocumentHistory
  private cleanSnapshot: PieceTableSnapshot
  private dirtyCacheSnapshot: PieceTableSnapshot
  private dirtyCacheValue = false
  private revision = 0
  private mutationLease: DocumentMutationLease | null = null
  private currentBarrier: DocumentBarrierState | null = null
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
      containsUnusualLineTerminators: ingested.containsUnusualLineTerminators,
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
    if (this.mutationLease)
      return appendTiming(this.createChange('none', []), 'session.applyText', start)
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
        metadata: ordinaryTransactionMetadata('keyboard', 'insert-text'),
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
    if (this.mutationLease) {
      return appendTiming(this.createChange('none', []), 'session.indentSelection', start)
    }
    const result = indentSelections(this.history.current, selections, text)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: ordinaryTransactionMetadata('keyboard', 'indent'),
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
    if (this.mutationLease) {
      return appendTiming(this.createChange('none', []), 'session.outdentSelection', start)
    }
    const result = outdentSelections(this.history.current, selections, tabSize)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: ordinaryTransactionMetadata('keyboard', 'outdent'),
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
    if (this.mutationLease) {
      return appendTiming(this.createChange('none', []), 'session.applyEdits', start)
    }
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
        metadata: ordinaryTransactionMetadata('programmatic', 'programmatic-edit'),
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
    tabSize?: number,
  ): DocumentSessionChange {
    const start = nowMs()
    if (this.mutationLease) {
      return appendTiming(this.createChange('none', []), 'session.backspace', start)
    }
    const result = backspaceSelections(this.history.current, selections, tabSize)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: ordinaryTransactionMetadata('keyboard', 'backspace'),
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
    if (this.mutationLease) {
      return appendTiming(this.createChange('none', []), 'session.delete', start)
    }
    const result = deleteSelections(this.history.current, selections)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: ordinaryTransactionMetadata('keyboard', 'delete'),
        selectionBefore: selections,
        sourceViewId,
      }),
      'session.delete',
      start,
    )
  }

  public undo(sourceViewId: string | null = null): DocumentSessionChange {
    const start = nowMs()
    if (this.mutationLease)
      return appendTiming(this.createChange('none', []), 'session.undo', start)
    const transaction = this.history.undo?.entry.transaction ?? null
    const next = undoEditorHistory(this.history)
    this.typingRun = null
    if (next === this.history) {
      return appendTiming(this.createChange('none', []), 'session.undo', start)
    }

    this.history = next
    this.textSnapshot = createDocumentTextSnapshot(this.history.current)
    const revisionBefore = this.revision
    this.revision += 1
    this.editChain.record({
      edits: transaction?.inverseEdits ?? null,
      logicalRevisionCount: 1,
      logicalRevisionScope: null,
      revisionAfter: this.revision,
      revisionBefore,
      textChanged: true,
    })
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
    if (this.mutationLease)
      return appendTiming(this.createChange('none', []), 'session.redo', start)
    const transaction = this.history.redo?.entry.transaction ?? null
    const next = redoEditorHistory(this.history)
    this.typingRun = null
    if (next === this.history) {
      return appendTiming(this.createChange('none', []), 'session.redo', start)
    }

    this.history = next
    this.textSnapshot = createDocumentTextSnapshot(this.history.current)
    const revisionBefore = this.revision
    this.revision += 1
    this.editChain.record({
      edits: transaction?.edits ?? null,
      logicalRevisionCount: 1,
      logicalRevisionScope: null,
      revisionAfter: this.revision,
      revisionBefore,
      textChanged: true,
    })
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

  public getDocumentSyncPoint(): DocumentSyncPoint {
    return this.editChain.point
  }

  public changesSinceDocumentSyncPoint(
    point: DocumentSyncPoint,
    scope: DocumentLogicalRevisionScope | null,
  ): DocumentChangesSinceSyncPoint | null {
    return this.editChain.changesSince(point, scope)
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

  public acquireMutationLease(
    expectedRevision: number,
    expectedSnapshot: PieceTableSnapshot,
    ownerId: string,
  ): AcquireDocumentMutationLeaseResult {
    if (this.revision !== expectedRevision || this.getSnapshot() !== expectedSnapshot) {
      return { status: 'stale' }
    }
    if (this.mutationLease) {
      if (this.mutationLease.ownerId === ownerId) {
        return { status: 'acquired', lease: this.mutationLease }
      }
      return { status: 'busy' }
    }

    const lease = Object.freeze({ ownerId }) as DocumentMutationLease
    this.mutationLease = lease
    this.leaseChanges.fire(this.getMutationLeaseState())
    return { status: 'acquired', lease }
  }

  public releaseMutationLease(lease: DocumentMutationLease): ReleaseDocumentMutationLeaseResult {
    if (this.mutationLease !== lease) return { status: 'already-released' }

    this.mutationLease = null
    this.leaseChanges.fire(this.getMutationLeaseState())
    return { status: 'released' }
  }

  public getMutationLeaseState(): DocumentMutationLeaseState {
    return {
      isLeased: this.mutationLease !== null,
      ownerId: this.mutationLease?.ownerId ?? null,
    }
  }

  public subscribeMutationLeaseState(listener: DocumentMutationLeaseStateListener): () => void {
    const subscription = this.leaseChanges.subscribe(listener)
    return () => subscription.dispose()
  }

  public commitPrepared(
    target: DocumentTransactionCommitTarget,
    prepared: PreparedDocumentTransaction,
    options: DocumentTransactionCommitOptions,
    existingReceipt: DocumentTransactionReceipt | null = null,
  ): PreparedDocumentCommitResult {
    if (!this.canUsePrepared(target, prepared)) return { status: 'stale' }
    if (!prepared.hasTextChange) {
      const cumulativeBarrier = this.cumulativeBarrier(existingReceipt)
      if (existingReceipt && !cumulativeBarrier) return { status: 'stale' }
      return this.commitLogicalOnly(target, prepared, cumulativeBarrier)
    }

    const selectionBefore = target.sourceView?.getSelections() ?? this.history.selections
    const selectionAfter = this.selectionsAfterProgrammaticEdit(
      prepared.snapshotAfter,
      selectionBefore,
      options.selection,
      options.selections,
    )
    const transaction = preparedTransactionRecord(
      prepared,
      selectionBefore,
      selectionAfter,
      options,
    )
    const revisionBefore = this.revision
    const historyBefore = this.history
    const barrier = this.commitPreparedHistory(
      transaction,
      options.history,
      existingReceipt,
      historyBefore,
      revisionBefore,
    )

    target.sourceView?.acceptBufferSelections(selectionAfter)
    this.typingRun = null
    this.textSnapshot = createDocumentTextSnapshot(prepared.snapshotAfter)
    this.revision += 1
    barrier.revisionAfter = this.revision
    this.editChain.record({
      edits: prepared.edits,
      logicalRevisionCount: prepared.logicalRevisionCount,
      logicalRevisionScope: prepared.logicalRevisionScope,
      revisionAfter: this.revision,
      revisionBefore,
      textChanged: true,
    })
    const change = this.createChange('edit', prepared.edits, transaction)
    this.emitChange(change, target.sourceView?.viewId ?? null, 'external')
    const receipt = createReceipt(barrier)
    return { status: 'committed', change, receipt }
  }

  public reverseReceipt(
    target: DocumentTransactionCommitTarget,
    receipt: DocumentTransactionReceipt,
  ): ReverseDocumentTransactionResult {
    const barrier = receiptStates.get(receipt)
    if (!barrier || barrier.buffer !== this || receipt.segmentCount !== 1) {
      return { status: 'stale' }
    }
    if (!this.canReverse(target, receipt, barrier)) return { status: 'stale' }

    const transaction = barrier.segments[0]!
    const historyAtAfter = this.history
    const wasInstalled = barrier.installed
    this.restoreHistoryForReverse(barrier, transaction)
    target.sourceView?.acceptBufferSelections(transaction.selectionBefore)
    const revisionBefore = this.revision
    this.textSnapshot = createDocumentTextSnapshot(receipt.snapshotBefore)
    this.revision += 1
    this.editChain.record({
      edits: receipt.inverseEdits,
      logicalRevisionCount: 1,
      logicalRevisionScope: null,
      revisionAfter: this.revision,
      revisionBefore,
      textChanged: true,
    })

    const reverseTransaction = reciprocalTransaction(transaction)
    const change = this.createChange('edit', receipt.inverseEdits, reverseTransaction)
    this.emitChange(change, target.sourceView?.viewId ?? null, 'external')
    const reciprocalBarrier = this.createReciprocalBarrier(
      barrier,
      reverseTransaction,
      historyAtAfter,
      wasInstalled,
      revisionBefore,
    )
    reciprocalBarrier.revisionAfter = this.revision
    const reciprocal = createReceipt(reciprocalBarrier)
    return { status: 'reversed', change, receipt: reciprocal }
  }

  public beginReverseSequence(
    target: DocumentTransactionCommitTarget,
    receipt: DocumentTransactionReceipt,
  ): BeginReverseDocumentTransactionSequenceResult {
    const barrier = receiptStates.get(receipt)
    if (!barrier || barrier.buffer !== this || receipt.segmentCount <= 1) {
      return { status: 'stale' }
    }
    if (!this.canReverse(target, receipt, barrier)) return { status: 'stale' }

    const nextSegmentIndex = receipt.segmentCount - 1
    const cursor = createReverseCursor(nextSegmentIndex)
    reverseCursorStates.set(cursor, {
      barrier,
      expectedCurrentBarrier: this.currentBarrier,
      expectedRevision: this.revision,
      historyBeforeReverse: this.history,
      receipt,
      revisionBefore: this.revision,
      wasInstalled: barrier.installed,
      completed: false,
      nextSegmentIndex,
      reversedTransactions: [],
    })
    return { status: 'started', cursor }
  }

  public reverseSequenceSegment(
    target: DocumentTransactionCommitTarget,
    cursor: DocumentTransactionSequenceReverseCursor,
    segmentIndex: number,
  ): ReverseDocumentTransactionSequenceSegmentResult {
    const state = reverseCursorStates.get(cursor)
    if (!state || state.nextSegmentIndex !== segmentIndex) return { status: 'out-of-order' }
    if (cursor.nextSegmentIndex !== segmentIndex) return { status: 'out-of-order' }
    if (!this.canContinueReverseSequence(target, state)) return { status: 'stale' }

    const transaction = state.barrier.segments[segmentIndex]
    if (!transaction || this.getSnapshot() !== transaction.snapshotAfter) {
      return { status: 'stale' }
    }

    if (segmentIndex === state.receipt.segmentCount - 1 && state.wasInstalled) {
      this.currentBarrier = state.barrier.older
      state.barrier.installed = false
      state.expectedCurrentBarrier = this.currentBarrier
    }
    this.setHistoryForSequenceReverse(state, transaction, segmentIndex)
    target.sourceView?.acceptBufferSelections(transaction.selectionBefore)
    const revisionBefore = this.revision
    this.textSnapshot = createDocumentTextSnapshot(transaction.snapshotBefore)
    this.revision += 1
    this.editChain.record({
      edits: transaction.inverseEdits,
      logicalRevisionCount: 1,
      logicalRevisionScope: null,
      revisionAfter: this.revision,
      revisionBefore,
      textChanged: true,
    })
    state.expectedRevision = this.revision
    const reciprocal = reciprocalTransaction(transaction)
    state.reversedTransactions.push(reciprocal)
    state.nextSegmentIndex -= 1
    const change = this.createChange('edit', transaction.inverseEdits, reciprocal)
    this.emitChange(change, target.sourceView?.viewId ?? null, 'external')
    const nextCursor = createReverseCursor(state.nextSegmentIndex)
    reverseCursorStates.set(nextCursor, state)
    return { status: 'reversed', change, cursor: nextCursor }
  }

  public completeReverseSequence(
    target: DocumentTransactionCommitTarget,
    cursor: DocumentTransactionSequenceReverseCursor,
  ): CompleteReverseDocumentTransactionSequenceResult {
    const state = reverseCursorStates.get(cursor)
    if (!state || state.completed) return { status: 'incomplete' }
    if (cursor.nextSegmentIndex !== state.nextSegmentIndex) return { status: 'incomplete' }
    if (state.nextSegmentIndex >= 0) return { status: 'incomplete' }
    if (!this.canContinueReverseSequence(target, state)) return { status: 'stale' }
    if (this.getSnapshot() !== state.receipt.snapshotBefore) return { status: 'stale' }

    const transactions = state.reversedTransactions
    const first = transactions[0]
    const last = transactions.at(-1)
    if (!first || !last) return { status: 'incomplete' }

    const barrier: DocumentBarrierState = {
      buffer: this,
      historyBefore: this.history,
      older: this.currentBarrier,
      phase: state.barrier.phase,
      released: false,
      installed: !state.wasInstalled,
      revisionBefore: state.revisionBefore,
      revisionAfter: this.revision,
      history: state.barrier.history,
      segments: transactions,
    }
    if (barrier.installed) {
      barrier.historyBefore = state.historyBeforeReverse
      this.currentBarrier = barrier
      this.history = createEditorHistory(last.snapshotAfter, last.selectionAfter)
    }
    state.completed = true
    const receipt = createReceipt(barrier)
    return { status: 'completed', receipt }
  }

  public sealReceipt(receipt: DocumentTransactionReceipt): SealDocumentTransactionResult | null {
    const barrier = receiptStates.get(receipt)
    if (!barrier || barrier.buffer !== this || barrier.released) return null
    const alreadySealed = barrier.phase === 'sealed'
    barrier.phase = 'sealed'
    barrier.historyBefore = { ...barrier.historyBefore, redo: null }
    const sealedReceipt = createReceipt(barrier)
    return {
      receipt: sealedReceipt,
      status: alreadySealed ? 'already-sealed' : 'sealed',
    }
  }

  public releaseReceipt(receipt: DocumentTransactionReceipt): ReleaseDocumentTransactionResult {
    const barrier = receiptStates.get(receipt)
    if (!barrier || barrier.buffer !== this || barrier.released) {
      return { status: 'already-released' }
    }

    barrier.released = true
    barrier.installed = false
    this.unlinkBarrier(barrier)
    return { status: 'released' }
  }

  public rotateSyncSegment(
    expectedPoint: DocumentSyncPoint,
    lease: DocumentMutationLease,
  ): RotateDocumentSyncSegmentResult {
    if (this.mutationLease !== lease) return { status: 'stale' }
    if (this.editChain.point !== expectedPoint) return { status: 'stale' }

    this.editChain.rotate()
    return { status: 'rotated', syncPoint: this.editChain.point }
  }

  private canUsePrepared(
    target: DocumentTransactionCommitTarget,
    prepared: PreparedDocumentTransaction,
  ): boolean {
    if (this.revision !== prepared.expectedRevision) return false
    if (this.getSnapshot() !== prepared.snapshotBefore) return false
    if (this.mutationLease && target.mutationLease !== this.mutationLease) return false
    if (target.mutationLease && target.mutationLease !== this.mutationLease) return false
    return true
  }

  private commitLogicalOnly(
    target: DocumentTransactionCommitTarget,
    prepared: PreparedDocumentTransaction,
    cumulativeBarrier: DocumentBarrierState | null,
  ): PreparedDocumentCommitResult {
    const revisionBefore = this.revision
    this.revision += 1
    this.editChain.record({
      edits: [],
      logicalRevisionCount: prepared.logicalRevisionCount,
      logicalRevisionScope: prepared.logicalRevisionScope,
      revisionAfter: this.revision,
      revisionBefore,
      textChanged: false,
    })
    if (cumulativeBarrier) cumulativeBarrier.revisionAfter = this.revision
    const change = this.createSynchronizeChange(prepared, target.sourceView)
    this.emitChange(change, target.sourceView?.viewId ?? null, 'external')
    return { status: 'logical-only', change }
  }

  private cumulativeBarrier(
    receipt: DocumentTransactionReceipt | null,
  ): DocumentBarrierState | null {
    if (!receipt) return null
    const barrier = receiptStates.get(receipt)
    if (!barrier || barrier.buffer !== this) return null
    if (barrier.released || !barrier.installed) return null
    if (this.currentBarrier !== barrier) return null
    if (receipt.revisionAfter !== this.revision) return null
    if (receipt.snapshotAfter !== this.getSnapshot()) return null
    return barrier
  }

  private createSynchronizeChange(
    prepared: PreparedDocumentTransaction,
    sourceView: EditorViewSession | null,
  ): DocumentSessionChange {
    return createDocumentSessionChange({
      kind: 'synchronize',
      edits: [],
      transaction: null,
      snapshot: this.history.current,
      selections: sourceView?.getSelections() ?? this.history.selections,
      textSnapshot: this.textSnapshot,
      timings: [],
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      isDirty: this.isDirty(),
      logicalRevisionCount: prepared.logicalRevisionCount,
      logicalRevisionScope: prepared.logicalRevisionScope,
    })
  }

  private commitPreparedHistory(
    transaction: DocumentTransaction,
    history: DocumentTransactionHistory,
    existingReceipt: DocumentTransactionReceipt | null,
    historyBefore: DocumentHistory,
    revisionBefore: number,
  ): DocumentBarrierState {
    if (history.kind === 'record') {
      this.history = commitEditorHistory(
        { ...historyBefore, selections: transaction.selectionBefore },
        transaction.snapshotAfter,
        transaction.selectionAfter,
        transaction,
      )
      return createDetachedBarrier(
        this,
        historyBefore,
        this.currentBarrier,
        history,
        transaction,
        revisionBefore,
      )
    }

    const existing = existingReceipt ? receiptStates.get(existingReceipt) : null
    if (existing && !existing.released && existing.installed) {
      existing.segments.push(transaction)
      this.history = {
        ...this.history,
        current: transaction.snapshotAfter,
        selections: transaction.selectionAfter,
        redo: null,
      }
      return existing
    }

    const barrier: DocumentBarrierState = {
      buffer: this,
      historyBefore,
      older: this.currentBarrier,
      phase: 'provisional',
      released: false,
      installed: true,
      revisionBefore,
      revisionAfter: revisionBefore,
      history,
      segments: [transaction],
    }
    this.currentBarrier = barrier
    this.history = createEditorHistory(transaction.snapshotAfter, transaction.selectionAfter)
    return barrier
  }

  private canReverse(
    target: DocumentTransactionCommitTarget,
    receipt: DocumentTransactionReceipt,
    barrier: DocumentBarrierState,
  ): boolean {
    if (barrier.released) return false
    if (this.revision !== receipt.revisionAfter) return false
    if (this.getSnapshot() !== receipt.snapshotAfter) return false
    if (this.mutationLease && target.mutationLease !== this.mutationLease) return false
    if (target.mutationLease && target.mutationLease !== this.mutationLease) return false
    if (barrier.installed && this.currentBarrier !== barrier) return false
    return true
  }

  private canUseLease(lease: DocumentMutationLease | undefined): boolean {
    if (this.mutationLease) return lease === this.mutationLease
    return lease === undefined
  }

  private canContinueReverseSequence(
    target: DocumentTransactionCommitTarget,
    state: ReverseSequenceState,
  ): boolean {
    if (!this.canUseLease(target.mutationLease)) return false
    if (state.barrier.released) return false
    if (this.revision !== state.expectedRevision) return false
    return this.currentBarrier === state.expectedCurrentBarrier
  }

  private setHistoryForSequenceReverse(
    state: ReverseSequenceState,
    transaction: DocumentTransaction,
    segmentIndex: number,
  ): void {
    if (segmentIndex === 0 && state.wasInstalled) {
      this.history = state.barrier.historyBefore
      return
    }
    this.history = createEditorHistory(transaction.snapshotBefore, transaction.selectionBefore)
  }

  private restoreHistoryForReverse(
    barrier: DocumentBarrierState,
    transaction: DocumentTransaction,
  ): void {
    if (barrier.installed) {
      this.currentBarrier = barrier.older
      barrier.installed = false
      this.history = barrier.historyBefore
      return
    }

    this.history = {
      ...this.history,
      current: transaction.snapshotBefore,
      selections: transaction.selectionBefore,
      redo: null,
    }
  }

  private createReciprocalBarrier(
    previous: DocumentBarrierState,
    transaction: DocumentTransaction,
    historyAtAfter: DocumentHistory,
    previousWasInstalled: boolean,
    revisionBefore: number,
  ): DocumentBarrierState {
    const reciprocal = createDetachedBarrier(
      this,
      this.history,
      this.currentBarrier,
      previous.history,
      transaction,
      revisionBefore,
      previous.phase,
    )
    if (previousWasInstalled) return reciprocal

    reciprocal.installed = true
    reciprocal.historyBefore = historyAtAfter
    reciprocal.older = this.currentBarrier
    this.currentBarrier = reciprocal
    this.history = createEditorHistory(transaction.snapshotAfter, transaction.selectionAfter)
    return reciprocal
  }

  private unlinkBarrier(target: DocumentBarrierState): void {
    if (this.currentBarrier === target) {
      this.currentBarrier = target.older
      return
    }

    for (let barrier = this.currentBarrier; barrier; barrier = barrier.older) {
      if (barrier.older !== target) continue
      barrier.older = target.older
      return
    }
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
    const revisionBefore = this.revision
    this.revision += 1
    this.editChain.record({
      edits,
      logicalRevisionCount: options.metadata.logicalRevisionCount,
      logicalRevisionScope: options.metadata.logicalRevisionScope,
      revisionAfter: this.revision,
      revisionBefore,
      textChanged: true,
    })
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
    const logicalRevision = documentChangeLogicalRevision(kind, transaction)
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
      logicalRevisionCount: logicalRevision.count,
      logicalRevisionScope: logicalRevision.scope,
    })
  }

  private emitChange(
    change: DocumentSessionChange,
    sourceViewId: string | null | undefined,
    origin: EditorTextBufferChange['origin'] = 'view',
  ): void {
    if (change.kind === 'none') return

    this.changes.fire({ change, origin, sourceViewId: sourceViewId ?? null })
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
      affinity: options.affinity,
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
      logicalRevisionCount: 0,
      logicalRevisionScope: null,
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

  public backspace(tabSize?: number): DocumentSessionChange {
    return this.acceptBufferChange(
      this.buffer.backspace(this.view.getSelections(), this.view.viewId, tabSize),
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
      containsUnusualLineTerminators: ingested.containsUnusualLineTerminators,
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

  public backspace(_tabSize?: number): DocumentSessionChange {
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
        affinity: selection.affinity ?? options.affinity,
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
      affinity: options.affinity,
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
        affinity: selection.affinity ?? options.affinity,
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
      logicalRevisionCount: kind === 'edit' ? 1 : 0,
      logicalRevisionScope: null,
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

export function prepareDocumentTransaction(
  buffer: EditorTextBuffer,
  edits: readonly TextEdit[],
  logicalRevisionCount: number,
  logicalRevisionScope: DocumentLogicalRevisionScope | null,
): PreparedDocumentTransaction {
  assertLogicalRevisionCount(logicalRevisionCount)
  return prepareDocumentTransactionForSnapshot(
    buffer.getRevision(),
    buffer.getSnapshot(),
    edits,
    logicalRevisionCount,
    logicalRevisionScope,
  )
}

export function prepareDocumentTransactionSequence(
  buffer: EditorTextBuffer,
  segments: readonly DocumentTransactionSequenceSegmentInput[],
): PreparedDocumentTransactionSequence {
  let snapshot = buffer.getSnapshot()
  const expectedRevision = buffer.getRevision()
  const preparedSegments: PreparedDocumentTransaction[] = []

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!
    assertLogicalRevisionCount(segment.logicalRevisionCount)
    const prepared = prepareDocumentTransactionForSnapshot(
      expectedRevision + index,
      snapshot,
      segment.edits,
      segment.logicalRevisionCount,
      segment.logicalRevisionScope,
    )
    preparedSegments.push(prepared)
    snapshot = prepared.snapshotAfter
  }

  const sequence = Object.freeze({
    expectedRevision,
    segments: Object.freeze(preparedSegments),
    snapshotAfter: snapshot,
    snapshotBefore: buffer.getSnapshot(),
  }) as PreparedDocumentTransactionSequence
  sequenceStates.set(sequence, { nextSegmentIndex: 0, receipt: null })
  return sequence
}

export function acquireDocumentMutationLease(
  buffer: EditorTextBuffer,
  expectedRevision: number,
  expectedSnapshot: PieceTableSnapshot,
  ownerId: string,
): AcquireDocumentMutationLeaseResult {
  return pieceTableBuffer(buffer).acquireMutationLease(expectedRevision, expectedSnapshot, ownerId)
}

export function releaseDocumentMutationLease(
  buffer: EditorTextBuffer,
  lease: DocumentMutationLease,
): ReleaseDocumentMutationLeaseResult {
  return pieceTableBuffer(buffer).releaseMutationLease(lease)
}

export function getDocumentMutationLeaseState(
  buffer: EditorTextBuffer,
): DocumentMutationLeaseState {
  return pieceTableBuffer(buffer).getMutationLeaseState()
}

export function subscribeDocumentMutationLeaseState(
  buffer: EditorTextBuffer,
  listener: DocumentMutationLeaseStateListener,
): () => void {
  return pieceTableBuffer(buffer).subscribeMutationLeaseState(listener)
}

export function commitPreparedDocumentTransaction(
  target: DocumentTransactionCommitTarget,
  prepared: PreparedDocumentTransaction,
  options: DocumentTransactionCommitOptions,
): PreparedDocumentCommitResult {
  return pieceTableBuffer(target.buffer).commitPrepared(target, prepared, options)
}

export function commitPreparedDocumentTransactionSequenceSegment(
  target: DocumentTransactionCommitTarget,
  sequence: PreparedDocumentTransactionSequence,
  segmentIndex: number,
  options: DocumentTransactionCommitOptions,
): PreparedDocumentSequenceSegmentCommitResult {
  const state = sequenceStates.get(sequence)
  if (!state || state.nextSegmentIndex !== segmentIndex) return { status: 'out-of-order' }
  if (options.history.kind === 'record' && sequence.segments.length > 1) {
    throw new RangeError('multi-segment native history is not supported')
  }

  const prepared = sequence.segments[segmentIndex]
  if (!prepared) return { status: 'out-of-order' }
  const result = pieceTableBuffer(target.buffer).commitPrepared(
    target,
    prepared,
    options,
    state.receipt,
  )
  if (result.status === 'stale') return result

  state.nextSegmentIndex += 1
  if (result.status === 'committed') state.receipt = result.receipt
  if (result.status === 'logical-only' && state.receipt) {
    state.receipt = refreshReceipt(state.receipt)
  }
  return {
    change: result.change,
    receipt: state.receipt,
    status: result.status,
  }
}

export function completePreparedDocumentTransactionSequence(
  target: DocumentTransactionCommitTarget,
  sequence: PreparedDocumentTransactionSequence,
): CompletePreparedDocumentSequenceResult {
  const state = sequenceStates.get(sequence)
  if (!state || state.nextSegmentIndex !== sequence.segments.length) {
    return { status: 'incomplete' }
  }
  if (target.buffer.getSnapshot() !== sequence.snapshotAfter) return { status: 'stale' }
  if (target.buffer.getRevision() !== sequence.expectedRevision + sequence.segments.length) {
    return { status: 'stale' }
  }
  return { status: 'completed', receipt: state.receipt }
}

export function reverseDocumentTransaction(
  target: DocumentTransactionCommitTarget,
  receipt: DocumentTransactionReceipt,
): ReverseDocumentTransactionResult {
  if (receipt.segmentCount > 1) {
    throw new RangeError('sequence receipts must be reversed segment by segment')
  }
  return pieceTableBuffer(target.buffer).reverseReceipt(target, receipt)
}

export function beginReverseDocumentTransactionSequence(
  target: DocumentTransactionCommitTarget,
  receipt: DocumentTransactionReceipt,
): BeginReverseDocumentTransactionSequenceResult {
  return pieceTableBuffer(target.buffer).beginReverseSequence(target, receipt)
}

export function reverseNextDocumentTransactionSequenceSegment(
  target: DocumentTransactionCommitTarget,
  cursor: DocumentTransactionSequenceReverseCursor,
  segmentIndex: number,
): ReverseDocumentTransactionSequenceSegmentResult {
  return pieceTableBuffer(target.buffer).reverseSequenceSegment(target, cursor, segmentIndex)
}

export function completeReverseDocumentTransactionSequence(
  target: DocumentTransactionCommitTarget,
  cursor: DocumentTransactionSequenceReverseCursor,
): CompleteReverseDocumentTransactionSequenceResult {
  return pieceTableBuffer(target.buffer).completeReverseSequence(target, cursor)
}

export function sealDocumentTransactionReceipt(
  target: DocumentTransactionCommitTarget,
  receipt: DocumentTransactionReceipt,
): SealDocumentTransactionResult {
  const result = pieceTableBuffer(target.buffer).sealReceipt(receipt)
  if (result) return result
  return { status: 'already-sealed', receipt }
}

export function releaseDocumentTransactionReceipt(
  target: DocumentTransactionCommitTarget,
  receipt: DocumentTransactionReceipt,
): ReleaseDocumentTransactionResult {
  return pieceTableBuffer(target.buffer).releaseReceipt(receipt)
}

export function rotateDocumentSyncSegment(
  buffer: EditorTextBuffer,
  expectedPoint: DocumentSyncPoint,
  mutationLease: DocumentMutationLease,
): RotateDocumentSyncSegmentResult {
  return pieceTableBuffer(buffer).rotateSyncSegment(expectedPoint, mutationLease)
}

function prepareDocumentTransactionForSnapshot(
  expectedRevision: number,
  snapshotBefore: PieceTableSnapshot,
  edits: readonly TextEdit[],
  logicalRevisionCount: number,
  logicalRevisionScope: DocumentLogicalRevisionScope | null,
): PreparedDocumentTransaction {
  const normalized = normalizeTextEdits(edits)
  const applied = snapBatchEditRanges(snapshotBefore, normalized).filter(isEffectiveTextEdit)
  const candidate = applyBatchToPieceTable(snapshotBefore, applied)
  const hasTextChange = !pieceTableSnapshotsHaveSameText(snapshotBefore, candidate)
  const snapshotAfter = hasTextChange ? candidate : snapshotBefore
  return Object.freeze({
    hasTextChange,
    logicalRevisionCount,
    logicalRevisionScope,
    expectedRevision,
    snapshotBefore,
    snapshotAfter,
    edits: applied,
    inverseEdits: invertTextEdits(snapshotBefore, applied),
  })
}

function assertLogicalRevisionCount(count: number): void {
  if (Number.isSafeInteger(count) && count > 0) return
  throw new RangeError('logicalRevisionCount must be a positive safe integer')
}

function pieceTableBuffer(buffer: EditorTextBuffer): PieceTableEditorTextBuffer {
  if (buffer instanceof PieceTableEditorTextBuffer) return buffer
  throw new TypeError('transaction target is not an Editor piece-table buffer')
}

function preparedTransactionRecord(
  prepared: PreparedDocumentTransaction,
  selectionBefore: SelectionSet<PieceTableAnchor>,
  selectionAfter: SelectionSet<PieceTableAnchor>,
  options: DocumentTransactionCommitOptions,
): DocumentTransaction {
  return {
    edits: prepared.edits,
    inverseEdits: prepared.inverseEdits,
    snapshotBefore: prepared.snapshotBefore,
    snapshotAfter: prepared.snapshotAfter,
    selectionBefore,
    selectionAfter,
    metadata: {
      source: 'programmatic',
      intent: 'programmatic-edit',
      undoGroup: options.history.kind === 'record' ? options.history.undoGroup : undefined,
      logicalRevisionCount: prepared.logicalRevisionCount,
      logicalRevisionScope: prepared.logicalRevisionScope,
    },
  }
}

function reciprocalTransaction(transaction: DocumentTransaction): DocumentTransaction {
  return {
    edits: transaction.inverseEdits,
    inverseEdits: transaction.edits,
    snapshotBefore: transaction.snapshotAfter,
    snapshotAfter: transaction.snapshotBefore,
    selectionBefore: transaction.selectionAfter,
    selectionAfter: transaction.selectionBefore,
    metadata: ordinaryTransactionMetadata('history', 'undo'),
  }
}

function createDetachedBarrier(
  buffer: PieceTableEditorTextBuffer,
  historyBefore: DocumentHistory,
  older: DocumentBarrierState | null,
  history: DocumentTransactionHistory,
  transaction: DocumentTransaction,
  revisionBefore: number,
  phase: DocumentBarrierState['phase'] = 'provisional',
): DocumentBarrierState {
  return {
    buffer,
    historyBefore,
    older,
    phase,
    released: false,
    installed: false,
    revisionBefore,
    revisionAfter: revisionBefore,
    history,
    segments: [transaction],
  }
}

function createReceipt(barrier: DocumentBarrierState): DocumentTransactionReceipt {
  const first = barrier.segments[0]!
  const last = barrier.segments.at(-1)!
  const edits = receiptEdits(first.snapshotBefore, last.snapshotAfter, barrier.segments, false)
  const inverseEdits = receiptEdits(
    first.snapshotBefore,
    last.snapshotAfter,
    barrier.segments,
    true,
  )
  const receipt = Object.freeze({
    edits,
    history: barrier.history,
    inverseEdits,
    logicalRevisionCount: barrier.segments.reduce(
      (count, segment) => count + segment.metadata.logicalRevisionCount,
      0,
    ),
    phase: barrier.phase,
    revisionAfter: barrier.revisionAfter,
    revisionBefore: barrier.revisionBefore,
    segmentCount: barrier.segments.length,
    snapshotAfter: last.snapshotAfter,
    snapshotBefore: first.snapshotBefore,
  }) as DocumentTransactionReceipt
  receiptStates.set(receipt, barrier)
  return receipt
}

function refreshReceipt(receipt: DocumentTransactionReceipt): DocumentTransactionReceipt {
  const barrier = receiptStates.get(receipt)
  if (!barrier) throw new RangeError('document transaction receipt lost its barrier')
  return createReceipt(barrier)
}

function createReverseCursor(nextSegmentIndex: number): DocumentTransactionSequenceReverseCursor {
  return Object.freeze({ nextSegmentIndex }) as DocumentTransactionSequenceReverseCursor
}

function receiptEdits(
  snapshotBefore: PieceTableSnapshot,
  snapshotAfter: PieceTableSnapshot,
  segments: readonly DocumentTransaction[],
  inverse: boolean,
): readonly TextEdit[] {
  if (segments.length === 1) return inverse ? segments[0]!.inverseEdits : segments[0]!.edits
  const edit = inverse
    ? diffPieceTableSnapshots(snapshotAfter, snapshotBefore)
    : diffPieceTableSnapshots(snapshotBefore, snapshotAfter)
  return edit ? [edit] : []
}

type DocumentSessionChangeFields = DocumentSessionChange

function createDocumentSessionChange(fields: DocumentSessionChangeFields): DocumentSessionChange {
  return { ...fields } // TODO why do we need this func??
}

function ordinaryTransactionMetadata(
  source: DocumentTransactionMetadata['source'],
  intent: DocumentTransactionIntent,
  undoGroup?: string,
): DocumentTransactionMetadata {
  return {
    source,
    intent,
    undoGroup,
    logicalRevisionCount: 1,
    logicalRevisionScope: null,
  }
}

function documentChangeLogicalRevision(
  kind: DocumentSessionChangeKind,
  transaction: DocumentTransaction | null,
): { readonly count: number; readonly scope: DocumentLogicalRevisionScope | null } {
  if (kind === 'undo' || kind === 'redo') return { count: 1, scope: null }
  if (kind !== 'edit' || !transaction) return { count: 0, scope: null }
  return {
    count: transaction.metadata.logicalRevisionCount,
    scope: transaction.metadata.logicalRevisionScope,
  }
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
    logicalRevisionCount: change.logicalRevisionCount,
    logicalRevisionScope: change.logicalRevisionScope,
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
      affinity: selection.affinity ?? options.affinity,
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
