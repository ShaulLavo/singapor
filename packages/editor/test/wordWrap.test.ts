import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Editor } from '../src/editor/Editor'
import { resetEditorInstanceCount, setHighlightRegistry } from '../src/public/testing'

/**
 * The wrap machinery (WrapMap, setWrapEnabledLayout) was already built and covered; what was
 * missing was any way for a host to turn it on. These cover that seam: the option, the setter, and
 * the command.
 */

const LONG_LINE = `${'word '.repeat(60)}\nsecond line\n`

const highlightsMap = new Map<string, unknown>()
const mockRegistry = {
  delete: (name: string) => highlightsMap.delete(name),
  set: (name: string, highlight: unknown) => {
    highlightsMap.set(name, highlight)
  },
}

class MockHighlight extends Set<Range> {}

describe('word wrap', () => {
  let container: HTMLElement
  let editor: Editor | null = null

  beforeEach(() => {
    highlightsMap.clear()
    // @ts-expect-error — happy-dom has no Highlight constructor
    globalThis.Highlight = MockHighlight
    setHighlightRegistry(mockRegistry)
    resetEditorInstanceCount()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    editor?.dispose()
    editor = null
    container.remove()
    setHighlightRegistry(undefined)
  })

  it('is off unless a host asks for it', () => {
    editor = new Editor(container, { defaultText: LONG_LINE })

    expect(editor.isWordWrapEnabled()).toBe(false)
  })

  it('starts enabled when the option is set', () => {
    editor = new Editor(container, { defaultText: LONG_LINE, wordWrap: true })

    expect(editor.isWordWrapEnabled()).toBe(true)
  })

  it('turns on and off through the setter', () => {
    editor = new Editor(container, { defaultText: LONG_LINE })

    expect(editor.setWordWrap(true)).toBe(true)
    expect(editor.isWordWrapEnabled()).toBe(true)

    expect(editor.setWordWrap(false)).toBe(false)
    expect(editor.isWordWrapEnabled()).toBe(false)
  })

  it('toggles through the command router', () => {
    editor = new Editor(container, { defaultText: LONG_LINE })

    expect(editor.dispatchCommand('editor.action.toggleWordWrap')).toBe(true)
    expect(editor.isWordWrapEnabled()).toBe(true)

    editor.dispatchCommand('editor.action.toggleWordWrap')
    expect(editor.isWordWrapEnabled()).toBe(false)
  })

  it('keeps the document text unchanged when wrapping', () => {
    editor = new Editor(container, { defaultText: LONG_LINE })

    editor.setWordWrap(true)

    expect(editor.materializeFullText()).toBe(LONG_LINE)
  })
})
