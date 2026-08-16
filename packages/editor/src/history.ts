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

// Every retained entry pins the snapshot it was taken from, and a pinned snapshot
// keeps alive every piece the document has ever deleted. Unbounded history therefore
// makes a long session monotonically slower rather than merely larger: nothing can
// ever be reclaimed while some entry still points at it.
const MAX_UNDO_DEPTH = 200

export const createEditorHistory = <TSnapshot, TSelectionState, TTransaction = never>(
  current: TSnapshot,
  selections: TSelectionState,
): EditorHistory<TSnapshot, TSelectionState, TTransaction> => ({
  current,
  selections,
  undo: null,
  redo: null,
})

const truncateHistoryStack = <TSnapshot, TSelectionState, TTransaction = never>(
  stack: EditorHistoryStack<TSnapshot, TSelectionState, TTransaction>,
): EditorHistoryStack<TSnapshot, TSelectionState, TTransaction> => {
  const retained: EditorHistoryEntry<TSnapshot, TSelectionState, TTransaction>[] = []
  for (let node = stack; node && retained.length < MAX_UNDO_DEPTH; node = node.previous) {
    retained.push(node.entry)
  }

  // Links point from newest to oldest, so the surviving prefix has to be rebuilt
  // rather than re-pointed — reusing any of it would leave the dropped tail
  // reachable, which is the whole cost the cap exists to shed.
  let truncated: EditorHistoryStack<TSnapshot, TSelectionState, TTransaction> = null
  for (let index = retained.length - 1; index >= 0; index -= 1) {
    truncated = { entry: retained[index]!, previous: truncated, size: retained.length - index }
  }
  return truncated
}

const pushHistoryEntry = <TSnapshot, TSelectionState, TTransaction = never>(
  stack: EditorHistoryStack<TSnapshot, TSelectionState, TTransaction>,
  entry: EditorHistoryEntry<TSnapshot, TSelectionState, TTransaction>,
): NonNullable<EditorHistoryStack<TSnapshot, TSelectionState, TTransaction>> => ({
  entry,
  previous: stack,
  size: (stack?.size ?? 0) + 1,
})

const pushCappedHistoryEntry = <TSnapshot, TSelectionState, TTransaction = never>(
  stack: EditorHistoryStack<TSnapshot, TSelectionState, TTransaction>,
  entry: EditorHistoryEntry<TSnapshot, TSelectionState, TTransaction>,
): EditorHistoryStack<TSnapshot, TSelectionState, TTransaction> => {
  const pushed = pushHistoryEntry(stack, entry)
  return pushed.size > MAX_UNDO_DEPTH ? truncateHistoryStack(pushed) : pushed
}

export const commitEditorHistory = <TSnapshot, TSelectionState, TTransaction = never>(
  history: EditorHistory<TSnapshot, TSelectionState, TTransaction>,
  current: TSnapshot,
  selections: TSelectionState,
  transaction?: TTransaction,
): EditorHistory<TSnapshot, TSelectionState, TTransaction> => ({
  current,
  selections,
  undo: pushCappedHistoryEntry(history.undo, {
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
    // Deliberately uncapped: the redo stack is fed only by what this function
    // moves off the undo stack, and any commit empties it, so the pair together
    // can never hold more than the cap the undo side is already kept under.
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
    undo: pushCappedHistoryEntry(history.undo, {
      snapshot: history.current,
      selections: history.selections,
      transaction: next.entry.transaction,
    }),
    redo: next.previous,
  }
}
