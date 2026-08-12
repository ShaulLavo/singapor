import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Editor } from '../src/editor/Editor'
import { resetEditorInstanceCount, setHighlightRegistry } from '../src/public/testing'

/**
 * Auto-closing pairs driven through the real input path: a beforeinput event on the editor, the
 * document session, and the piece table. The decision rules themselves are unit-tested in
 * src/editor/autoClose.test.ts; this is about the wiring holding together.
 */

const highlightsMap = new Map<string, unknown>()
const mockRegistry = {
  delete: (name: string) => highlightsMap.delete(name),
  set: (name: string, highlight: unknown) => {
    highlightsMap.set(name, highlight)
  },
}

class MockHighlight extends Set<Range> {}

function insert(data: string): InputEvent {
  return new InputEvent('beforeinput', { bubbles: true, cancelable: true, data, inputType: 'insertText' })
}

function lineBreak(): InputEvent {
  return new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertLineBreak' })
}

describe('auto-closing pairs', () => {
  let container: HTMLElement
  let editor: Editor

  beforeEach(() => {
    highlightsMap.clear()
    // @ts-expect-error — happy-dom has no Highlight constructor
    globalThis.Highlight = MockHighlight
    setHighlightRegistry(mockRegistry)
    resetEditorInstanceCount()
    container = document.createElement('div')
    document.body.appendChild(container)
    editor = new Editor(container, {})
    editor.openDocument({ documentId: 'main.ts', languageId: 'typescript', text: '' })
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
    setHighlightRegistry(undefined)
  })

  const type = (...characters: readonly string[]) => {
    for (const character of characters) editor.el.dispatchEvent(insert(character))
  }

  it('inserts the closer and leaves the caret between the halves', () => {
    type('(')

    expect(editor.materializeFullText()).toBe('()')
    expect(editor.getState().cursor).toMatchObject({ column: 1, row: 0 })
  })

  it('keeps typing inside the pair', () => {
    type('(', 'a')

    expect(editor.materializeFullText()).toBe('(a)')
  })

  it('types over its own closer instead of adding another', () => {
    type('(', ')')

    expect(editor.materializeFullText()).toBe('()')
    expect(editor.getState().cursor).toMatchObject({ column: 2, row: 0 })
  })

  it('types over the closer even after editing inside the pair', () => {
    type('(', 'a', 'b', ')')

    expect(editor.materializeFullText()).toBe('(ab)')
  })

  // A closer the editor did not insert must still be typeable.
  it('inserts a closer that was not auto-inserted', () => {
    editor.setText(')')
    editor.setSelection(0, 0)

    type(')')

    expect(editor.materializeFullText()).toBe('))')
  })

  it('backspacing between the halves removes both', () => {
    type('(')
    editor.dispatchCommand('deleteBackward')

    expect(editor.materializeFullText()).toBe('')
  })

  it('backspacing a hand-typed pair removes only one character', () => {
    editor.setText('()')
    editor.setSelection(1, 1)

    editor.dispatchCommand('deleteBackward')

    expect(editor.materializeFullText()).toBe(')')
  })

  it('does not close directly before a word', () => {
    editor.setText('abc')
    editor.setSelection(0, 0)

    type('(')

    expect(editor.materializeFullText()).toBe('(abc')
  })

  it('closes quotes on their own', () => {
    type('"')

    expect(editor.materializeFullText()).toBe('""')
  })

  // don't, it's — the apostrophe is punctuation, not a delimiter.
  it('does not close an apostrophe after a word character', () => {
    editor.setText('don')
    editor.setSelection(3, 3)

    type("'")

    expect(editor.materializeFullText()).toBe("don'")
  })

  // The pairing auto-close exists for: the closer moves to its own line and the caret lands on a
  // blank indented line between them.
  it('expands into a block when Enter is pressed inside a pair', () => {
    type('(')
    editor.el.dispatchEvent(lineBreak())

    expect(editor.materializeFullText()).toBe('(\n    \n)')
    expect(editor.getState().cursor).toMatchObject({ column: 4, row: 1 })
  })

  it('continues the previous line indentation', () => {
    editor.setText('    foo')
    editor.setSelection(7, 7)

    editor.el.dispatchEvent(lineBreak())

    expect(editor.materializeFullText()).toBe('    foo\n    ')
  })

  it('indents one level deeper after an opener with no closer following', () => {
    editor.setText('  if (x) {', { languageId: 'typescript' })
    editor.setSelection(10, 10)

    editor.el.dispatchEvent(lineBreak())

    expect(editor.materializeFullText()).toBe('  if (x) {\n      ')
  })

  it('keeps tabs when the line uses tabs', () => {
    editor.setText('\tif (x) {', { languageId: 'typescript' })
    editor.setSelection(9, 9)

    editor.el.dispatchEvent(lineBreak())

    expect(editor.materializeFullText()).toBe('\tif (x) {\n\t\t')
  })

  it('adds no indentation at the top level', () => {
    editor.setText('foo')
    editor.setSelection(3, 3)

    editor.el.dispatchEvent(lineBreak())

    expect(editor.materializeFullText()).toBe('foo\n')
  })

  it('wraps a selection instead of replacing it', () => {
    editor.setText('foo bar', { languageId: 'typescript' })
    editor.setSelection(0, 3)

    type('(')

    expect(editor.materializeFullText()).toBe('(foo) bar')
  })

  it('wraps with quotes too', () => {
    editor.setText('foo', { languageId: 'typescript' })
    editor.setSelection(0, 3)

    type('"')

    expect(editor.materializeFullText()).toBe('"foo"')
  })

  // The wrapped text stays selected, so a second wrap nests rather than starting over.
  it('keeps the wrapped text selected', () => {
    editor.setText('foo', { languageId: 'typescript' })
    editor.setSelection(0, 3)

    type('(', '[')

    expect(editor.materializeFullText()).toBe('([foo])')
  })

  it('wraps a backwards selection and keeps its direction', () => {
    editor.setText('foo bar', { languageId: 'typescript' })
    editor.setSelection(3, 0)

    type('(')

    expect(editor.materializeFullText()).toBe('(foo) bar')
  })

  it('does not auto-close in a language with no pairs', () => {
    editor.openDocument({ documentId: 'notes.txt', languageId: null, text: '' })

    type('(')

    expect(editor.materializeFullText()).toBe('(')
  })

  it('undoes the whole pair in one step', () => {
    type('(')
    editor.dispatchCommand('undo')

    expect(editor.materializeFullText()).toBe('')
  })

  // Undo history is deliberately not coalesced across an auto-close: the pair is its own
  // transaction, so the character typed after it undoes separately.
  it('undoes a character typed inside the pair before the pair itself', () => {
    type('(', 'a')

    editor.dispatchCommand('undo')
    expect(editor.materializeFullText()).toBe('()')

    editor.dispatchCommand('undo')
    expect(editor.materializeFullText()).toBe('')
  })
})
