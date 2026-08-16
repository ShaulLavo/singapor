import { describe, expect, it } from 'vitest'
import {
  createDocumentSession,
  createEditorBufferSession,
  createEditorTextBuffer,
  materializePieceTableFullText,
  offsetToPoint,
  pointToOffset,
  type DocumentSession,
  type TextEdit,
} from '../src/public/document'
import { pieceTableDocumentText, UTF8_BYTE_ORDER_MARK } from '../src/pieceTable'
import { exceedsHeapOperationBudget, MAX_HEAP_OPERATION_LENGTH } from '../src/documentSession'
import { resolveSelection } from '../src/selections'

// The lines a view would paint: line starts from the piece table, line ends as
// `nextLineStart - 1` exactly like virtualizedTextViewModel derives them, so a
// carriage return left inside the document shows up here the way it would
// show up in the DOM.
function renderedLines(session: DocumentSession): readonly string[] {
  const snapshot = session.getSnapshot()
  const textSnapshot = session.getTextSnapshot()
  const rowCount = offsetToPoint(snapshot, snapshot.length).row + 1
  const lines: string[] = []

  for (let row = 0; row < rowCount; row++) {
    const start = pointToOffset(snapshot, { row, column: 0 })
    const end =
      row + 1 < rowCount
        ? pointToOffset(snapshot, { row: row + 1, column: 0 }) - 1
        : snapshot.length
    lines.push(textSnapshot.readRange(start, end))
  }

  return lines
}

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

describe('DocumentSession line endings', () => {
  it('round-trips a byte-order-marked CRLF document through open, edit and save', () => {
    const original = `${UTF8_BYTE_ORDER_MARK}alpha\r\nbeta\r\ngamma`
    const session = createDocumentSession(original)

    // Open: the BOM is off the text and the carriage returns are gone, so
    // offsets are the ones every consumer downstream already assumes.
    expect(session.materializeFullText()).toBe('alpha\nbeta\ngamma')
    expect(renderedLines(session)).toEqual(['alpha', 'beta', 'gamma'])

    session.applyEdits([{ from: 16, to: 16, text: '!' }])

    // Save: both the BOM and the document's own line ending come back, so the
    // file does not turn up as every-line-changed in git after one keystroke.
    expect(pieceTableDocumentText(session.getSnapshot())).toBe(
      `${UTF8_BYTE_ORDER_MARK}alpha\r\nbeta\r\ngamma!`,
    )
  })

  it('never leaves a carriage return at the end of a rendered line', () => {
    const session = createDocumentSession(`${UTF8_BYTE_ORDER_MARK}alpha\r\nbeta`)
    session.applyEdits([{ from: 10, to: 10, text: '\r\ngamma\r\n' }])

    for (const line of renderedLines(session)) {
      expect(line.endsWith('\r')).toBe(false)
    }
    expect(renderedLines(session)).toEqual(['alpha', 'beta', 'gamma', ''])
  })
})

describe('EditorTextBuffer materialization budget', () => {
  it('leaves an ordinary document under the budget', () => {
    expect(createEditorTextBuffer('alpha\nbeta\n').isTooLargeForHeapOperation()).toBe(false)
  })

  it('refuses only above the threshold, not at it', () => {
    // Asserted on the decision itself: the boundary is what an off-by-one or a
    // wrong constant gets wrong, and materializing two 256MB fixtures to probe
    // it would cost more than the whole rest of this suite.
    expect(exceedsHeapOperationBudget(MAX_HEAP_OPERATION_LENGTH - 1)).toBe(false)
    expect(exceedsHeapOperationBudget(MAX_HEAP_OPERATION_LENGTH)).toBe(false)
    expect(exceedsHeapOperationBudget(MAX_HEAP_OPERATION_LENGTH + 1)).toBe(true)
    expect(MAX_HEAP_OPERATION_LENGTH).toBe(256 * 1024 * 1024)
  })

  it(
    'keeps the refusal after the document shrinks back under the budget',
    { timeout: 60_000 },
    () => {
      const oversized = MAX_HEAP_OPERATION_LENGTH + 1
      const buffer = createEditorTextBuffer('a'.repeat(oversized))
      const session = createEditorBufferSession(buffer)

      expect(buffer.isTooLargeForHeapOperation()).toBe(true)

      session.applyEdits([{ from: 0, to: oversized, text: 'tiny' }])

      expect(session.materializeFullText()).toBe('tiny')
      expect(buffer.isTooLargeForHeapOperation()).toBe(true)
    },
  )

  it('keeps the permission after the document grows past the budget', () => {
    const buffer = createEditorTextBuffer('')
    const session = createEditorBufferSession(buffer)

    session.applyEdits([{ from: 0, to: 0, text: 'a'.repeat(1_000) }])

    expect(buffer.isTooLargeForHeapOperation()).toBe(false)
  })
})

describe('document session edit reporting', () => {
  const EMOJI_TEXT = 'a\u{1F600}b'

  it('reports the range it applied when an edit is snapped off a surrogate pair', () => {
    const session = createDocumentSession(EMOJI_TEXT)
    const change = session.applyEdits([{ from: 1, to: 2, text: 'X' }])

    expect(session.materializeFullText()).toBe('aXb')
    // Reporting {from:1,to:2} would tell every consumer the document did not
    // change length, and each of them patches its own copy from this list.
    expect(change.edits).toEqual([{ from: 1, to: 3, text: 'X' }])
    expect(appliedLength(EMOJI_TEXT, change.edits)).toBe(session.getSnapshot().length)
  })

  it('inverts a snapped edit back to the original text', () => {
    const session = createDocumentSession(EMOJI_TEXT)
    session.applyEdits([{ from: 1, to: 2, text: 'X' }])
    session.undo()

    expect(session.materializeFullText()).toBe(EMOJI_TEXT)
  })

  it('applies adjacent edits that together consume a surrogate pair', () => {
    const session = createDocumentSession(EMOJI_TEXT)
    const change = session.applyEdits([
      { from: 0, to: 2, text: 'A' },
      { from: 2, to: 4, text: 'B' },
    ])

    expect(session.materializeFullText()).toBe('AB')
    expect(change.edits).toEqual([
      { from: 0, to: 2, text: 'A' },
      { from: 2, to: 4, text: 'B' },
    ])
  })
})

describe('document session ingestion', () => {
  const LINE_SEPARATOR = '\u2028'

  it('reads back the text the piece table holds, not the text it was given', () => {
    const session = createDocumentSession(`ab${LINE_SEPARATOR}cd`)

    expect(session.getTextSnapshot().materializeFullText()).toBe('ab\ncd')
    expect(session.materializeFullText()).toBe('ab\ncd')
    expect(session.getTextSnapshot().readRange(0, 5)).toBe('ab\ncd')
  })

  it('round-trips a CRLF document with a byte order mark through an edit', () => {
    const buffer = createEditorTextBuffer('\uFEFFalpha\r\nbeta\r\n')
    const session = createEditorBufferSession(buffer)

    session.applyEdits([{ from: 5, to: 5, text: '!' }])

    // Stored LF-only, so no line carries a stray CR into the DOM...
    expect(session.materializeFullText()).toBe('alpha!\nbeta\n')
    expect(session.materializeFullText()).not.toContain('\r')
    // ...and saving restores exactly what was opened, plus the edit.
    expect(pieceTableDocumentText(session.getSnapshot())).toBe('\uFEFFalpha!\r\nbeta\r\n')
  })
})

function appliedLength(source: string, edits: readonly TextEdit[]): number {
  return edits.reduce(
    (result, edit) => result.slice(0, edit.from) + edit.text + result.slice(edit.to),
    source,
  ).length
}
