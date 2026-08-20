import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Editor } from '../src/editor/Editor'
import { EditorAnnouncer } from '../src/editor/announce'
import { resetEditorInstanceCount, setHighlightRegistry } from '../src/public/testing'

/**
 * The channel, and the actions that put something on it.
 *
 * Everything here is about a user who is not looking at the screen, so every assertion is about the
 * accessibility tree: which regions exist, which one a message landed in, and whether the same
 * message twice is still two messages. The editor half drives the real keys, because a channel only
 * tests write into is a channel no reader ever hears.
 */

const highlightsMap = new Map<string, unknown>()
const mockRegistry = {
  delete: (name: string) => highlightsMap.delete(name),
  set: (name: string, highlight: unknown) => {
    highlightsMap.set(name, highlight)
  },
}

class MockHighlight extends Set<Range> {}

describe('the announcement channel', () => {
  let container: HTMLElement
  let announcer: EditorAnnouncer

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    announcer = new EditorAnnouncer(container)
  })

  afterEach(() => {
    announcer.dispose()
    container.remove()
  })

  it('puts nothing in the page until there is something to say', () => {
    expect(container.children).toHaveLength(0)

    announcer.status('something')

    expect(container.querySelectorAll('[role="status"]')).toHaveLength(2)
  })

  it('keeps a pair of each urgency, told apart by their roles', () => {
    announcer.alert('interrupting')
    announcer.status('waiting')

    const alerts = regions(container, 'alert')
    const statuses = regions(container, 'status')
    expect(alerts).toHaveLength(2)
    expect(statuses).toHaveLength(2)
    expect(alerts.map((region) => region.getAttribute('aria-live'))).toEqual([
      'assertive',
      'assertive',
    ])
    expect(statuses.map((region) => region.getAttribute('aria-live'))).toEqual(['polite', 'polite'])
    for (const region of [...alerts, ...statuses]) {
      expect(region.getAttribute('aria-atomic')).toBe('true')
    }
  })

  it('writes a repeated message into the other half of the pair, so it is still a change', () => {
    announcer.status('3 occurrences selected')
    expect(regionTexts(container, 'status')).toEqual(['3 occurrences selected', ''])

    announcer.status('3 occurrences selected')
    expect(regionTexts(container, 'status')).toEqual(['', '3 occurrences selected'])

    announcer.status('3 occurrences selected')
    expect(regionTexts(container, 'status')).toEqual(['3 occurrences selected', ''])
  })

  it('empties the half it is not writing into, so nothing is left to be read twice', () => {
    announcer.status('first')
    announcer.status('first')
    announcer.status('second')

    expect(regionTexts(container, 'status')).toEqual(['second', ''])
  })

  it('keeps what interrupts apart from what waits its turn', () => {
    announcer.alert('Tab moves focus out of the editor')
    announcer.status('2 occurrences selected')

    expect(regionTexts(container, 'alert')).toEqual(['Tab moves focus out of the editor', ''])
    expect(regionTexts(container, 'status')).toEqual(['2 occurrences selected', ''])
  })

  it('hides the region and shows it again, for readers that only speak what they saw move', () => {
    const target = () => regions(container, 'alert')[0]
    announcer.alert('first')
    const observer = new MutationObserver(() => {})
    observer.observe(target()!, { attributeFilter: ['style'], attributeOldValue: true })

    announcer.alert('second')

    const visibility = observer
      .takeRecords()
      .map((record) => record.oldValue)
      .concat(target()!.getAttribute('style'))
    observer.disconnect()
    expect(visibility.filter((style) => style?.includes('visibility: hidden'))).not.toHaveLength(0)
    expect(visibility.at(-1)).toContain('visibility: visible')
  })

  it('cuts a message that would be pasted into the page whole', () => {
    announcer.alert('x'.repeat(20_001))

    expect(regionTexts(container, 'alert')[0]).toHaveLength(20_000)
  })

  it('takes its regions out of the page when it is disposed, and stays out', () => {
    announcer.status('something')

    announcer.dispose()
    expect(container.children).toHaveLength(0)

    announcer.status('something else')
    expect(container.children).toHaveLength(0)
  })
})

describe('what the editor announces', () => {
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
    editor = new Editor(container)
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
    setHighlightRegistry(undefined)
  })

  it('says where a cursor was added, since the row it landed on may be off screen', () => {
    open('alpha\nbeta\ngamma', 1)

    expect(editor.dispatchCommand('editor.action.insertCursorBelow')).toBe(true)

    expect(regionTexts(container, 'status')[0]).toBe('Cursor added at line 2, column 2')
  })

  it('counts the cursors when one press adds several', () => {
    open('alpha\nbeta\ngamma', 1)
    editor.dispatchCommand('editor.action.insertCursorBelow')

    editor.dispatchCommand('editor.action.insertCursorBelow')

    // A different sentence needs no swap; it lands back in the half the first one was cleared from.
    expect(regionTexts(container, 'status')[0]).toBe('2 cursors added, 4 in total')
  })

  it('says how many occurrences a selection just claimed', () => {
    open('foo bar foo foo', 1)

    expect(editor.dispatchCommand('editor.action.selectHighlights')).toBe(true)

    expect(regionTexts(container, 'status')[0]).toBe('3 occurrences selected')
  })

  it('counts what is selected after each press of the occurrence key, from the first', () => {
    open('foo bar foo foo', 1)

    editor.dispatchCommand('addNextOccurrence')
    expect(regionTexts(container, 'status')[0]).toBe('1 occurrence selected')

    editor.dispatchCommand('addNextOccurrence')
    expect(regionTexts(container, 'status')[0]).toBe('2 occurrences selected')
  })

  it('says the same count again when the same word is claimed twice', () => {
    open('foo bar foo foo', 1)

    editor.dispatchCommand('editor.action.selectHighlights')
    editor.setSelection(1, 1)
    editor.dispatchCommand('editor.action.selectHighlights')

    // Both halves of the pair have held it, which is the only way the second press is heard at all.
    expect(regionTexts(container, 'status')).toEqual(['', '3 occurrences selected'])
  })

  it('takes its regions down with the editor', () => {
    open('foo bar foo foo', 1)
    editor.dispatchCommand('editor.action.selectHighlights')
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(2)

    editor.dispose()

    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0)
  })

  // Rows leaving the document is the one editor action with no caret movement to hear, so a reader
  // who cannot see them go has nothing else telling them the file just got shorter.
  it('says how much of the document a fold took away', () => {
    open('function f() {\n  one\n  two\n}\ntail\n', 0)

    expect(editor.dispatchCommand('editor.foldAll')).toBe(true)

    // Either half of the pair may hold it; the pair alternates only to make a repeat a change.
    expect(regionTexts(container, 'status')).toContain('Folded all, 1 regions collapsed')

    expect(editor.dispatchCommand('editor.unfoldAll')).toBe(true)

    expect(regionTexts(container, 'status')).toContain('Unfolded all')
  })

  function open(text: string, caret: number): void {
    editor.openDocument({ documentId: 'main.ts', text })
    editor.setSelection(caret, caret)
    mockViewport(editor.el, 80, 60)
  }
})

function regions(container: HTMLElement, role: 'alert' | 'status'): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[role="${role}"]`)]
}

function regionTexts(container: HTMLElement, role: 'alert' | 'status'): string[] {
  return regions(container, role).map((region) => region.textContent ?? '')
}

/** Cursors above and below are placed in display rows, which happy-dom measures as nothing. */
function mockViewport(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: height })
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 200 })
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      bottom: height,
      height,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  })
}
