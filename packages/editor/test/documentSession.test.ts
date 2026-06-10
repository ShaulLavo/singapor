import { describe, expect, it } from 'vitest'
import {
  createDocumentSession,
  materializePieceTableFullText,
  type DocumentSession,
} from '../src/public/document'
import { resolveSelection } from '../src/selections'

function resolvedOffsets(session: DocumentSession): { start: number; end: number } {
  const selection = session.getSelections().selections[0]!
  const resolved = resolveSelection(session.getSnapshot(), selection)
  return { start: resolved.startOffset, end: resolved.endOffset }
}

function resolvedSelectionOffsets(
  session: DocumentSession,
): readonly { start: number; end: number }[] {
  return session.getSelections().selections.map((selection) => {
    const resolved = resolveSelection(session.getSnapshot(), selection)
    return { start: resolved.startOffset, end: resolved.endOffset }
  })
}

function typeText(session: DocumentSession, text: string): void {
  for (const char of text) session.applyText(char)
}

describe('DocumentSession', () => {
  it('creates a piece-table snapshot with a collapsed selection at the end', () => {
    const session = createDocumentSession('abc')

    expect(materializePieceTableFullText(session.getSnapshot())).toBe('abc')
    expect(session.materializeFullText()).toBe('abc')
    expect(resolvedOffsets(session)).toEqual({ start: 3, end: 3 })
    expect(session.canUndo()).toBe(false)
  })

  it('applies inserted text and records undo history', () => {
    const session = createDocumentSession('abc')
    const change = session.applyText('!')

    expect(change.kind).toBe('edit')
    expect(change.edits).toEqual([{ from: 3, to: 3, text: '!' }])
    expect(change.transaction).toMatchObject({
      edits: [{ from: 3, to: 3, text: '!' }],
      inverseEdits: [{ from: 3, to: 4, text: '' }],
      metadata: { source: 'keyboard', intent: 'insert-text' },
    })
    expect(Object.keys(change)).not.toContain('text')
    expect(change.textSnapshot.materializeFullText()).toBe('abc!')
    expect(session.materializeFullText()).toBe('abc!')
    expect(resolvedOffsets(session)).toEqual({ start: 4, end: 4 })
    expect(session.canUndo()).toBe(true)
  })

  it('tracks dirty state from the clean snapshot checkpoint', () => {
    const session = createDocumentSession('abc')

    expect(session.isDirty()).toBe(false)

    session.applyText('!')
    expect(session.isDirty()).toBe(true)

    const undone = session.undo()
    expect(undone.isDirty).toBe(false)
    expect(session.isDirty()).toBe(false)

    const redone = session.redo()
    expect(redone.isDirty).toBe(true)
    expect(session.isDirty()).toBe(true)
  })

  it('clears dirty state when edits restore the clean text', () => {
    const session = createDocumentSession('abc')

    session.applyText('!')
    expect(session.isDirty()).toBe(true)

    const change = session.backspace()
    expect(change.textSnapshot.materializeFullText()).toBe('abc')
    expect(change.isDirty).toBe(false)
    expect(session.isDirty()).toBe(false)
    expect(session.canUndo()).toBe(true)
  })

  it('marks the current snapshot clean without clearing undo history', () => {
    const session = createDocumentSession('abc')
    session.applyText('!')

    session.markClean()

    expect(session.isDirty()).toBe(false)
    expect(session.canUndo()).toBe(true)

    session.undo()
    expect(session.materializeFullText()).toBe('abc')
    expect(session.isDirty()).toBe(true)

    session.redo()
    expect(session.materializeFullText()).toBe('abc!')
    expect(session.isDirty()).toBe(false)
  })

  it('applies text to multiple selections as one undoable edit', () => {
    const session = createDocumentSession('abcdef')
    session.setSelections([
      { anchor: 1, head: 2 },
      { anchor: 4, head: 6 },
    ])

    const change = session.applyText('X')

    expect(change.edits).toEqual([
      { from: 1, to: 2, text: 'X' },
      { from: 4, to: 6, text: 'X' },
    ])
    expect(session.materializeFullText()).toBe('aXcdX')
    expect(resolvedSelectionOffsets(session)).toEqual([
      { start: 2, end: 2 },
      { start: 5, end: 5 },
    ])
    expect(session.undo().textSnapshot.materializeFullText()).toBe('abcdef')
    expect(resolvedSelectionOffsets(session)).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 6 },
    ])
  })

  it('adds and clears secondary selections', () => {
    const session = createDocumentSession('abcdef')
    session.setSelection(1)
    session.addSelection(4)

    expect(resolvedSelectionOffsets(session)).toEqual([
      { start: 1, end: 1 },
      { start: 4, end: 4 },
    ])

    session.clearSecondarySelections()

    expect(resolvedSelectionOffsets(session)).toEqual([{ start: 1, end: 1 }])
  })

  it('backspaces by code point', () => {
    const session = createDocumentSession('a😀b')
    session.setSelection(3)
    session.backspace()

    expect(session.materializeFullText()).toBe('ab')
    expect(resolvedOffsets(session)).toEqual({ start: 1, end: 1 })
  })

  it('replaces selected ranges and collapses after inserted text', () => {
    const session = createDocumentSession('abcdef')
    session.setSelection(1, 4)
    const change = session.applyText('X')

    expect(change.edits).toEqual([{ from: 1, to: 4, text: 'X' }])
    expect(session.materializeFullText()).toBe('aXef')
    expect(resolvedOffsets(session)).toEqual({ start: 2, end: 2 })
  })

  it('undoes and redoes snapshot and selection state together', () => {
    const session = createDocumentSession('abc')
    session.applyText('!')
    const undone = session.undo()
    const redone = session.redo()

    expect(undone.textSnapshot.materializeFullText()).toBe('abc')
    expect(redone.textSnapshot.materializeFullText()).toBe('abc!')
    expect(session.materializeFullText()).toBe('abc!')
    expect(resolvedOffsets(session)).toEqual({ start: 4, end: 4 })
  })

  it('coalesces contiguous typing into one undo entry', () => {
    const session = createDocumentSession('')
    typeText(session, 'hell')
    const lastChange = session.applyText('o')

    expect(lastChange.edits).toEqual([{ from: 4, to: 4, text: 'o' }])
    expect(lastChange.transaction?.edits).toEqual([{ from: 4, to: 4, text: 'o' }])
    expect(session.materializeFullText()).toBe('hello')

    const undone = session.undo()
    expect(undone.textSnapshot.materializeFullText()).toBe('')
    expect(resolvedOffsets(session)).toEqual({ start: 0, end: 0 })
    expect(session.canUndo()).toBe(false)
  })

  it('breaks typing undo runs at word boundaries and newlines', () => {
    const session = createDocumentSession('')
    typeText(session, 'hello world')

    expect(session.undo().textSnapshot.materializeFullText()).toBe('hello ')
    expect(session.undo().textSnapshot.materializeFullText()).toBe('')

    typeText(session, 'a\nb')
    expect(session.undo().textSnapshot.materializeFullText()).toBe('a\n')
    expect(session.undo().textSnapshot.materializeFullText()).toBe('a')
    expect(session.undo().textSnapshot.materializeFullText()).toBe('')
  })

  it('breaks typing undo runs on cursor moves and backspace', () => {
    const moved = createDocumentSession('')
    typeText(moved, 'ab')
    moved.setSelection(2)
    moved.applyText('c')

    expect(moved.undo().textSnapshot.materializeFullText()).toBe('ab')
    expect(moved.undo().textSnapshot.materializeFullText()).toBe('')

    const deleted = createDocumentSession('')
    typeText(deleted, 'ab')
    deleted.backspace()

    expect(deleted.undo().textSnapshot.materializeFullText()).toBe('ab')
    expect(deleted.undo().textSnapshot.materializeFullText()).toBe('')
  })

  it('emits merged incremental edits when undoing and redoing a typing run', () => {
    const session = createDocumentSession('')
    typeText(session, 'hello')

    const undone = session.undo()
    const redone = session.redo()

    expect(undone.edits).toEqual([{ from: 0, to: 5, text: '' }])
    expect(undone.transaction?.inverseEdits).toEqual([{ from: 0, to: 5, text: '' }])
    expect(redone.edits).toEqual([{ from: 0, to: 0, text: 'hello' }])
    expect(redone.transaction?.edits).toEqual([{ from: 0, to: 0, text: 'hello' }])
  })

  it('reports incremental edits for undo and redo', () => {
    const session = createDocumentSession('abcdef')
    session.setSelection(1, 4)
    session.applyText('XYZ')

    const undone = session.undo()
    const redone = session.redo()

    expect(undone.kind).toBe('undo')
    expect(undone.edits).toEqual([{ from: 1, to: 4, text: 'bcd' }])
    expect(undone.transaction?.inverseEdits).toEqual([{ from: 1, to: 4, text: 'bcd' }])
    expect(redone.kind).toBe('redo')
    expect(redone.edits).toEqual([{ from: 1, to: 4, text: 'XYZ' }])
    expect(redone.transaction?.edits).toEqual([{ from: 1, to: 4, text: 'XYZ' }])
  })

  it('applies batch edits as one undoable operation', () => {
    const session = createDocumentSession('abcd')
    const change = session.applyEdits([
      { from: 3, to: 3, text: 'Y' },
      { from: 1, to: 2, text: 'X' },
    ])

    expect(change.edits).toEqual([
      { from: 1, to: 2, text: 'X' },
      { from: 3, to: 3, text: 'Y' },
    ])
    expect(session.materializeFullText()).toBe('aXcYd')
    expect(session.undo().textSnapshot.materializeFullText()).toBe('abcd')
  })

  it('can apply edits without recording undo history', () => {
    const session = createDocumentSession('abc')
    const change = session.applyEdits([{ from: 3, to: 3, text: '!' }], { history: 'skip' })

    expect(change.kind).toBe('edit')
    expect(session.materializeFullText()).toBe('abc!')
    expect(session.canUndo()).toBe(false)
  })

  it('preserves selections through programmatic edits unless replaced', () => {
    const session = createDocumentSession('abc')
    session.setSelection(3)

    session.applyEdits([{ from: 0, to: 0, text: '!' }])
    expect(resolvedOffsets(session)).toEqual({ start: 4, end: 4 })

    session.applyEdits([{ from: 0, to: 1, text: '?' }], {
      selection: { anchor: 1, head: 2 },
    })
    expect(resolvedOffsets(session)).toEqual({ start: 1, end: 2 })
  })
})
