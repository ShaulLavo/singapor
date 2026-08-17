import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DocumentSessionChange } from '../src/documentSession'
import { Editor } from '../src/editor/Editor'
import { resetEditorInstanceCount, setHighlightRegistry } from '../src/public/testing'
import { resolveSelection } from '../src/selections'

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
  return new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data,
    inputType: 'insertText',
  })
}

function lineBreak(): InputEvent {
  return new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertLineBreak',
  })
}

describe('auto-closing pairs', () => {
  let container: HTMLElement
  let editor: Editor
  let lastChange: DocumentSessionChange | null = null

  beforeEach(() => {
    lastChange = null
    highlightsMap.clear()
    // @ts-expect-error — happy-dom has no Highlight constructor
    globalThis.Highlight = MockHighlight
    setHighlightRegistry(mockRegistry)
    resetEditorInstanceCount()
    container = document.createElement('div')
    document.body.appendChild(container)
    editor = new Editor(container, {
      onChange: (_state, change) => {
        lastChange = change
      },
    })
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

  /** Both ends of the one selection the last keystroke left behind, as offsets. */
  const selectionEnds = () => {
    const change = lastChange
    if (!change) throw new Error('the keystroke produced no change')

    const selection = change.selections.selections[0]
    if (!selection) throw new Error('the keystroke left no selection')

    const resolved = resolveSelection(change.snapshot, selection)
    return { anchor: resolved.anchorOffset, head: resolved.headOffset }
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
    // Stopping short of the closer is what lets the next wrap nest inside this one.
    expect(selectionEnds()).toEqual({ anchor: 1, head: 4 })
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

  // The wrapped text reads the same whichever end the caret kept, so only the ends themselves say
  // the direction survived — the next shift+arrow has to go on from the end the user was moving.
  it('wraps a backwards selection and keeps its direction', () => {
    editor.setText('foo bar', { languageId: 'typescript' })
    editor.setSelection(3, 0)

    type('(')

    expect(editor.materializeFullText()).toBe('(foo) bar')
    expect(selectionEnds()).toEqual({ anchor: 4, head: 1 })
  })

  it('does not close a quote typed inside a string', () => {
    editor.setText('const s = "abc  def"', { languageId: 'typescript' })
    editor.setSelection(15, 15)

    type("'")

    expect(editor.materializeFullText()).toBe('const s = "abc \' def"')
  })

  it('does not close a bracket typed inside a line comment', () => {
    editor.setText('// wrap this', { languageId: 'typescript' })
    editor.setSelection(7, 7)

    type('(')

    expect(editor.materializeFullText()).toBe('// wrap( this')
  })

  // Nothing in the characters around the caret says the quote ends the run it is standing in; the
  // line read with a harmless character in the quote's place is what says so.
  it('does not close a quote that would terminate an unterminated string', () => {
    editor.setText("const s = '(abc ", { languageId: 'typescript' })
    editor.setSelection(16, 16)

    type("'")

    expect(editor.materializeFullText()).toBe("const s = '(abc '")
  })

  // A bracket in front of a literal is how `("x")` gets typed; a quote in front of one is not.
  it('closes a bracket before a string but not a quote before one', () => {
    editor.setText('"foo"', { languageId: 'typescript' })
    editor.setSelection(0, 0)

    type('(')

    expect(editor.materializeFullText()).toBe('()"foo"')

    editor.setText('"foo"', { languageId: 'typescript' })
    editor.setSelection(0, 0)

    type('"')

    expect(editor.materializeFullText()).toBe('""foo"')
  })

  it('wraps every selection when several cursors are down', () => {
    editor.setText('one one one', { languageId: 'typescript' })
    editor.setSelection(0, 3)
    editor.dispatchCommand('addNextOccurrence')
    editor.dispatchCommand('addNextOccurrence')

    type('"')

    expect(editor.materializeFullText()).toBe('"one" "one" "one"')
  })

  // Every wrap stays selected, so a second keystroke nests instead of starting over — the same
  // contract the single-cursor wrap has.
  it('keeps every wrapped selection selected', () => {
    editor.setText('one one one', { languageId: 'typescript' })
    editor.setSelection(0, 3)
    editor.dispatchCommand('addNextOccurrence')
    editor.dispatchCommand('addNextOccurrence')

    type('"', '(')

    expect(editor.materializeFullText()).toBe('"(one)" "(one)" "(one)"')
  })

  it('undoes every wrap in one step', () => {
    editor.setText('one one one', { languageId: 'typescript' })
    editor.setSelection(0, 3)
    editor.dispatchCommand('addNextOccurrence')
    editor.dispatchCommand('addNextOccurrence')

    type('"')
    expect(editor.materializeFullText()).toBe('"one" "one" "one"')

    editor.dispatchCommand('undo')
    expect(editor.materializeFullText()).toBe('one one one')
  })

  // The closer of one and the opener of the next land on the same offset here, so this is what says
  // they went in the right order.
  it('wraps selections that meet at an offset', () => {
    editor.setText('abab', { languageId: 'typescript' })
    editor.setSelection(0, 2)
    editor.dispatchCommand('addNextOccurrence')

    type('(')

    expect(editor.materializeFullText()).toBe('(ab)(ab)')
  })

  // Typing over selected blanks is a correction, not a wrap.
  it('replaces a selection that is only whitespace', () => {
    editor.setText('a    b', { languageId: 'typescript' })
    editor.setSelection(1, 5)

    type('"')

    expect(editor.materializeFullText()).toBe('a"b')
  })

  it('replaces a lone selected quote when a quote is typed over it', () => {
    editor.setText("x = 'y'", { languageId: 'typescript' })
    editor.setSelection(4, 5)

    type('"')

    expect(editor.materializeFullText()).toBe('x = "y\'')
  })

  it('still wraps a lone selected quote in a bracket', () => {
    editor.setText("x = 'y'", { languageId: 'typescript' })
    editor.setSelection(4, 5)

    type('(')

    expect(editor.materializeFullText()).toBe("x = (')y'")
  })

  // One cursor wrapping while another replaced the text under it would destroy text for a reason
  // the keystroke does not show, so the whole set falls back to replacing.
  it('wraps nothing when one of several cursors has no selection', () => {
    editor.setText('foo\nbar', { languageId: 'typescript' })
    editor.setSelection(0, 3)
    editor.dispatchCommand('editor.action.insertCursorBelow')

    type('"')

    expect(editor.materializeFullText()).toBe('"\nbar"')
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
