import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DocumentSessionChange } from '../src/documentSession'
import { Editor } from '../src/editor/Editor'
import { parseSnippet, snippetInitialSelection } from '../src/editor/snippet'
import type { EditorEditContributionContext, EditorPlugin } from '../src/plugins'
import { resetEditorInstanceCount, setHighlightRegistry } from '../src/public/testing'
import { resolveSelection } from '../src/selections'

/**
 * Snippets reaching the document the way a completion source delivers them: a plugin registers an
 * edit contribution, applies the expanded text through it, and hands over the stops it parsed. Tab
 * is then a real keystroke on the editor. A stop the parser produces but no keystroke can reach is
 * exactly the failure this is guarding against.
 */

const highlightsMap = new Map<string, unknown>()
const mockRegistry = {
  delete: (name: string) => highlightsMap.delete(name),
  set: (name: string, highlight: unknown) => {
    highlightsMap.set(name, highlight)
  },
}

class MockHighlight extends Set<Range> {}

describe('snippet insertion', () => {
  let container: HTMLElement
  let editor: Editor
  let edits: EditorEditContributionContext | null
  let lastChange: DocumentSessionChange | null

  beforeEach(() => {
    highlightsMap.clear()
    // @ts-expect-error — happy-dom has no Highlight constructor
    globalThis.Highlight = MockHighlight
    setHighlightRegistry(mockRegistry)
    resetEditorInstanceCount()
    edits = null
    lastChange = null
    container = document.createElement('div')
    document.body.appendChild(container)

    const completionSource: EditorPlugin = {
      name: 'test.snippetSource',
      activate: (context) =>
        context.registerEditContribution({
          createContribution: (contributed) => {
            edits = contributed
            return { dispose: () => {} }
          },
        }),
    }

    editor = new Editor(container, {
      onChange: (_state, change) => {
        if (change) lastChange = change
      },
      plugins: [completionSource],
    })
    editor.openDocument({ documentId: 'main.ts', languageId: 'typescript', text: '' })
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
    setHighlightRegistry(undefined)
  })

  /** Expands a snippet at the caret and starts its stops, which is all a completion source does. */
  const insertSnippet = (source: string) => {
    const contributed = edits
    if (!contributed?.startSnippetSession) throw new Error('the host offered no snippet session')

    const parsed = parseSnippet(source)
    const selection = snippetInitialSelection(parsed, 0)
    contributed.applyEdits([{ from: 0, text: parsed.text, to: 0 }], 'test.snippet', {
      anchor: selection.start,
      head: selection.end,
    })
    // The caret visits the occurrence it can type into; every other occurrence of the same stop
    // rides along as a copy of it, which is what a completion source hands over.
    contributed.startSnippetSession(
      parsed.stops.flatMap((stop) => {
        const caret = stop.ranges.findIndex((range) => !range.transform)
        const range = stop.ranges[caret]
        if (!range) return []

        const mirrors = stop.ranges.filter((_, index) => index !== caret)
        const { end, start } = range
        return [mirrors.length > 0 ? { end, mirrors, start } : { end, start }]
      }),
    )
  }

  const pressTab = () => {
    const root = document.querySelector('.editor-virtualized')
    root?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Tab' }),
    )
  }

  const type = (...characters: readonly string[]) => {
    for (const character of characters) {
      editor.el.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          data: character,
          inputType: 'insertText',
        }),
      )
    }
  }

  /** Where the last keystroke left the caret. */
  const caretOffset = () => {
    const change = lastChange
    if (!change) throw new Error('the keystroke produced no change')

    const selection = change.selections.selections[0]
    if (!selection) throw new Error('the keystroke left no selection')

    return resolveSelection(change.snapshot, selection).headOffset
  }

  /** The text the last keystroke left selected. */
  const selectedText = () => {
    const change = lastChange
    if (!change) throw new Error('the keystroke produced no change')

    const selection = change.selections.selections[0]
    if (!selection) throw new Error('the keystroke left no selection')

    const resolved = resolveSelection(change.snapshot, selection)
    return editor.materializeFullText().slice(resolved.startOffset, resolved.endOffset)
  }

  it('selects the first placeholder as the snippet lands', () => {
    insertSnippet('log(${1:message}, ${2:level})')

    expect(editor.materializeFullText()).toBe('log(message, level)')
    expect(selectedText()).toBe('message')
  })

  // A server writes an argument list as a placeholder holding placeholders; dropping the inner ones
  // is what made Tab jump straight past the body of a callback to the argument after it.
  it('stops at a placeholder nested inside another', () => {
    insertSnippet('setTimeout(${1:() => {\n\t${2:body}\n}}, ${3:delay})')

    expect(editor.materializeFullText()).toBe('setTimeout(() => {\n\tbody\n}, delay)')

    pressTab()

    expect(selectedText()).toBe('body')

    pressTab()

    expect(selectedText()).toBe('delay')
  })

  it('writes a transformed mirror into the document', () => {
    insertSnippet('class ${1:my thing} {}\n// ${1/(.*)/${1:/pascalcase}/}')

    expect(editor.materializeFullText()).toBe('class my thing {}\n// MyThing')
  })

  // A copy that only catches up on Tab shows text that is plainly wrong for as long as it takes to
  // type a name, which is the whole time the reader is looking at it.
  it('rewrites a repeated stop on every keystroke, not on the one that leaves it', () => {
    insertSnippet('let ${1:name} = $1')

    type('u')

    expect(editor.materializeFullText()).toBe('let u = u')

    type('s')

    expect(editor.materializeFullText()).toBe('let us = us')

    type('e')

    expect(editor.materializeFullText()).toBe('let use = use')
  })

  // The keystroke that replaces the whole placeholder deletes the characters the stop is anchored
  // on. When it happens to leave the copies reading exactly as they already did, nothing about the
  // document says anything went wrong — and every keystroke after it is unmirrored.
  it('keeps the copies for the keystroke that replaces the placeholder with what it already said', () => {
    insertSnippet('${1:a} ${1:a}')

    expect(editor.materializeFullText()).toBe('a a')

    type('a')

    expect(editor.materializeFullText()).toBe('a a')

    type('b')

    expect(editor.materializeFullText()).toBe('ab ab')
  })

  it('re-renders a transformed mirror from what the placeholder now holds', () => {
    insertSnippet('${1:name} ${1/(.*)/${1:/upcase}/}')

    type('a', 'b', 'c')

    expect(editor.materializeFullText()).toBe('abc ABC')
  })

  // A mirror above the caret shifts every offset under it, so the caret has to be handed back in
  // the coordinates the batch produces rather than the ones the keystroke was typed at.
  it('keeps the caret right when the mirror it rewrites sits above it', () => {
    insertSnippet('${1/(.*)/${1:/pascalcase}/} = ${1:my thing}')

    expect(editor.materializeFullText()).toBe('MyThing = my thing')

    type('a')

    // The seven-character mirror is now one character long: the caret sits past the `a` it typed.
    expect(editor.materializeFullText()).toBe('A = a')
    expect(caretOffset()).toBe(5)

    type('b')

    expect(editor.materializeFullText()).toBe('Ab = ab')
    expect(caretOffset()).toBe(7)
  })

  it('takes a backspace out of the copies too', () => {
    insertSnippet('let ${1:name} = $1')

    type('u', 's', 'e')
    editor.dispatchCommand('deleteBackward')

    expect(editor.materializeFullText()).toBe('let us = us')

    type('a')

    expect(editor.materializeFullText()).toBe('let usa = usa')
  })

  // A copy is rewritten whole, so one that already reads right has to be left out of the batch
  // rather than deleted and put back identical: everything anchored inside it would go with it.
  it('leaves a copy that does not change out of the batch', () => {
    insertSnippet('${1:name} $1 ${1/.*/fixed/}')

    type('x')

    expect(editor.materializeFullText()).toBe('x x fixed')
    expect(lastChange?.edits).toEqual([
      { from: 0, to: 4, text: 'x' },
      { from: 5, to: 5, text: 'x' },
    ])
  })

  it('still moves to the next stop once a stop has been mirrored', () => {
    insertSnippet('let ${1:name} = $1\n${2:body}')

    type('u', 's')
    pressTab()

    expect(selectedText()).toBe('body')
  })

  // The copies follow the stop, not the caret: text typed after the reader has left the placeholder
  // is theirs to keep, and rewriting the copies from it would put back what they moved away from.
  it('leaves the copies alone for a keystroke outside the stop', () => {
    insertSnippet('let ${1:name} = $1')

    type('u')
    editor.setSelection(9, 9)
    type('!')

    expect(editor.materializeFullText()).toBe('let u = u!')
  })
})
