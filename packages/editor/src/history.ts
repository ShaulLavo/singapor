export type EditorHistoryEntry<TSnapshot, TSelectionState, TTransaction = never> = {
  readonly snapshot: TSnapshot
  readonly selections: TSelectionState
  readonly transaction?: TTransaction
}

export type EditorHistoryStack<TSnapshot, TSelectionState, TTransaction = never> = {
  readonly entry: EditorHistoryEntry<TSnapshot, TSelectionState, TTransaction>
  readonly previous: EditorHistoryStack<TSnapshot, TSelectionState, TTransaction>
  readonly size: number
} | null

export type EditorHistory<TSnapshot, TSelectionState, TTransaction = never> = {
  readonly current: TSnapshot
  readonly selections: TSelectionState
  readonly undo: EditorHistoryStack<TSnapshot, TSelectionState, TTransaction>
  readonly redo: EditorHistoryStack<TSnapshot, TSelectionState, TTransaction>
}

export const createEditorHistory = <TSnapshot, TSelectionState, TTransaction = never>(
  current: TSnapshot,
  selections: TSelectionState,
): EditorHistory<TSnapshot, TSelectionState, TTransaction> => ({
  current,
  selections,
  undo: null,
  redo: null,
})

const pushHistoryEntry = <TSnapshot, TSelectionState, TTransaction = never>(
  stack: EditorHistoryStack<TSnapshot, TSelectionState, TTransaction>,
  entry: EditorHistoryEntry<TSnapshot, TSelectionState, TTransaction>,
): EditorHistoryStack<TSnapshot, TSelectionState, TTransaction> => ({
  entry,
  previous: stack,
  size: (stack?.size ?? 0) + 1,
})

export const commitEditorHistory = <TSnapshot, TSelectionState, TTransaction = never>(
  history: EditorHistory<TSnapshot, TSelectionState, TTransaction>,
  current: TSnapshot,
  selections: TSelectionState,
  transaction?: TTransaction,
): EditorHistory<TSnapshot, TSelectionState, TTransaction> => ({
  current,
  selections,
  undo: pushHistoryEntry(history.undo, {
    snapshot: history.current,
    selections: history.selections,
    transaction,
  }),
  redo: null,
})

export const amendEditorHistory = <TSnapshot, TSelectionState, TTransaction = never>(
  history: EditorHistory<TSnapshot, TSelectionState, TTransaction>,
  current: TSnapshot,
  selections: TSelectionState,
  transaction: TTransaction,
): EditorHistory<TSnapshot, TSelectionState, TTransaction> => {
  const undo = history.undo
  if (!undo) return { ...history, current, selections, redo: null }

  return {
    current,
    selections,
    undo: {
      entry: {
        ...undo.entry,
        transaction,
      },
      previous: undo.previous,
      size: undo.size,
    },
    redo: null,
  }
}

export const undoEditorHistory = <TSnapshot, TSelectionState, TTransaction = never>(
  history: EditorHistory<TSnapshot, TSelectionState, TTransaction>,
): EditorHistory<TSnapshot, TSelectionState, TTransaction> => {
  const previous = history.undo
  if (!previous) return history

  return {
    current: previous.entry.snapshot,
    selections: previous.entry.selections,
    undo: previous.previous,
    redo: pushHistoryEntry(history.redo, {
      snapshot: history.current,
      selections: history.selections,
      transaction: previous.entry.transaction,
    }),
  }
}

export const redoEditorHistory = <TSnapshot, TSelectionState, TTransaction = never>(
  history: EditorHistory<TSnapshot, TSelectionState, TTransaction>,
): EditorHistory<TSnapshot, TSelectionState, TTransaction> => {
  const next = history.redo
  if (!next) return history

  return {
    current: next.entry.snapshot,
    selections: next.entry.selections,
    undo: pushHistoryEntry(history.undo, {
      snapshot: history.current,
      selections: history.selections,
      transaction: next.entry.transaction,
    }),
    redo: next.previous,
  }
}
