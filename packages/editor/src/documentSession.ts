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
  commitEditorHistory,
  createEditorHistory,
  redoEditorHistory,
  undoEditorHistory,
  type EditorHistory,
} from './history'
import type { TextEdit } from './tokens'
import { createDocumentTextSnapshot, type DocumentTextSnapshot } from './documentTextSnapshot'
import type { Anchor as PieceTableAnchor, PieceTableSnapshot } from './pieceTable/pieceTableTypes'
import { applyBatchToPieceTable } from './pieceTable/edits'
import { readPieceTableTextRange, pieceTableSnapshotsHaveSameText } from './pieceTable/reads'
import { createPieceTableSnapshot } from './pieceTable/snapshot'

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
  canUndo(): boolean
  canRedo(): boolean
  isDirty(): boolean
  markClean(): void
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

class PieceTableEditorTextBuffer implements EditorTextBuffer {
  private readonly listeners = new Set<EditorTextBufferChangeListener>()
  private history: DocumentHistory
  private cleanSnapshot: PieceTableSnapshot
  private dirtyCacheSnapshot: PieceTableSnapshot
  private dirtyCacheValue = false
  private revision = 0
  private textSnapshot: DocumentTextSnapshot

  public constructor(text: string) {
    const snapshot = createPieceTableSnapshot(text)
    const selections = createInitialSelectionSet(snapshot, createSelectionIdFactory())
    this.history = createEditorHistory<
      PieceTableSnapshot,
      SelectionSet<PieceTableAnchor>,
      DocumentTransaction
    >(snapshot, selections)
    this.cleanSnapshot = snapshot
    this.dirtyCacheSnapshot = snapshot
    this.textSnapshot = createDocumentTextSnapshot(snapshot, text)
  }

  public applyText(
    selections: SelectionSet<PieceTableAnchor>,
    text: string,
    sourceViewId: string | null = null,
  ): DocumentSessionChange {
    const start = nowMs()
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

    const nextSnapshot = applyBatchToPieceTable(this.history.current, normalizedEdits)
    const effectiveEdits = normalizedEdits.filter(isEffectiveTextEdit)
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

  public subscribe(listener: EditorTextBufferChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
      this.history = commitEditorHistory(
        { ...this.history, selections: options.selectionBefore },
        snapshot,
        selections,
        transaction,
      )
    } else {
      this.history = { ...this.history, current: snapshot, selections }
    }

    this.textSnapshot = createDocumentTextSnapshot(snapshot)
    this.revision += 1
    const change = this.createChange('edit', edits, transaction)
    this.emitChange(change, options.sourceViewId)
    return change
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

    const event = {
      change,
      sourceViewId: sourceViewId ?? null,
    }
    for (const listener of this.listeners) listener(event)
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

  public constructor(text: string) {
    this.snapshot = createPieceTableSnapshot(text)
    this.textSnapshot = createDocumentTextSnapshot(this.snapshot, text)
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

    const nextSnapshot = applyBatchToPieceTable(this.snapshot, normalizedEdits)
    const effectiveEdits = normalizedEdits.filter(isEffectiveTextEdit)
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

function normalizeTextEdits(edits: readonly TextEdit[]): readonly TextEdit[] {
  return edits
    .map((edit) => ({ from: edit.from, to: edit.to, text: edit.text }))
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
