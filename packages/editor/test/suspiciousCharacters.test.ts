import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Editor } from '../src/editor/Editor'
import { EDITOR_OPTION_DESCRIPTORS } from '../src/editor/optionDescriptors'
import { resetEditorInstanceCount, setHighlightRegistry } from '../src/public/testing'
import {
  type EditorSuspiciousCharactersOptions,
  normalizeSuspiciousCharactersOptions,
  type SuspiciousCharacterRange,
  suspiciousCharacterRanges,
} from '../src/unicodeHighlight'
import { VirtualizedTextView } from '../src/virtualization'

const CYRILLIC_A = 'а'
const FULLWIDTH_A = 'ａ'
const MATHEMATICAL_BOLD_A = '\u{1d41a}'
const NO_BREAK_SPACE = ' '
const ZERO_WIDTH_SPACE = '​'
const RIGHT_TO_LEFT_OVERRIDE = '‮'
const FIRST_STRONG_ISOLATE = '⁦'
const POP_DIRECTIONAL_ISOLATE = '⁩'

/**
 * The published shape of a trojan-source attack: the overrides reorder the line so a reviewer reads
 * a commented-out branch where the compiler reads a live one. Every character of the deception is
 * one of the four below.
 */
const TROJAN_SOURCE =
  `if (level != "user${RIGHT_TO_LEFT_OVERRIDE} ${FIRST_STRONG_ISOLATE}// admin only` +
  `${POP_DIRECTIONAL_ISOLATE} ${FIRST_STRONG_ISOLATE}") {`

const ON = normalizeSuspiciousCharactersOptions(undefined)

const highlightsMap = new Map<string, unknown>()
const mockRegistry = {
  delete: (name: string) => highlightsMap.delete(name),
  set: (name: string, highlight: unknown) => {
    highlightsMap.set(name, highlight)
  },
}

class MockHighlight extends Set<Range> {}

function scan(
  text: string,
  options = ON,
  range?: { start: number; end: number },
): readonly (SuspiciousCharacterRange & { text: string })[] {
  return suspiciousCharacterRanges(text, options, range).map((found) => ({
    ...found,
    text: text.slice(found.start, found.end),
  }))
}

function kinds(text: string, options = ON): string[] {
  return suspiciousCharacterRanges(text, options).map((found) => found.kind)
}

describe('suspicious character scanning', () => {
  it('reports a Cyrillic letter passing itself off as part of an ASCII identifier', () => {
    expect(scan(`const p${CYRILLIC_A}ssword = secret`)).toEqual([
      { start: 7, end: 8, kind: 'ambiguous', text: CYRILLIC_A },
    ])
  })

  // Without this the feature is unusable on any codebase that is not written in English, which is
  // the same as not shipping it.
  it('leaves a word that is written entirely in another script alone', () => {
    expect(scan('const привет = 1')).toEqual([])
  })

  it('reports the invisible characters a trojan-source line is built from', () => {
    expect(kinds(TROJAN_SOURCE)).toEqual(['invisible', 'invisible', 'invisible', 'invisible'])
  })

  it('reports a no-break space, which draws as a space and is not one', () => {
    expect(scan(`\tconst a =${NO_BREAK_SPACE}1`)).toEqual([
      { start: 10, end: 11, kind: 'invisible', text: NO_BREAK_SPACE },
    ])
  })

  // Where a line ends was settled when the text was read in, so a carriage return still in it is a
  // leftover of that rather than something hidden by anyone.
  it('leaves a stray carriage return alone', () => {
    expect(scan('const a =\r1')).toEqual([])
  })

  it('reports a character above the basic plane as the whole pair', () => {
    expect(scan(`const ${MATHEMATICAL_BOLD_A}bc = 1`)).toEqual([
      { start: 6, end: 8, kind: 'ambiguous', text: MATHEMATICAL_BOLD_A },
    ])
  })

  it('reports a pair the scanned range opens in the middle of', () => {
    const text = `const ${MATHEMATICAL_BOLD_A}bc = 1`

    expect(scan(text, ON, { start: 7, end: 9 })).toEqual([
      { start: 6, end: 8, kind: 'ambiguous', text: MATHEMATICAL_BOLD_A },
    ])
  })

  it('reports nothing outside the range it was given', () => {
    const text = `const p${CYRILLIC_A}ssword = 1`

    expect(scan(text, ON, { start: 0, end: 7 })).toEqual([])
  })

  it('excuses the script a named locale is written in, and nothing else', () => {
    const options = normalizeSuspiciousCharactersOptions({ allowedLocales: ['ru'] })

    expect(scan(`const p${CYRILLIC_A}ssword = 1`, options)).toEqual([])
    expect(scan(`const p${FULLWIDTH_A}ssword = 1`, options)).toEqual([
      { start: 7, end: 8, kind: 'ambiguous', text: FULLWIDTH_A },
    ])
  })

  // Allowing two languages excuses what either of them writes, which is what intersecting the
  // per-locale lists of what stays suspicious amounts to.
  it('excuses a character any one of several named locales writes ordinarily', () => {
    const japanese = normalizeSuspiciousCharactersOptions({ allowedLocales: ['ja'] })
    const both = normalizeSuspiciousCharactersOptions({ allowedLocales: ['ja', 'ru'] })

    expect(kinds(`const p${CYRILLIC_A}ssword = 1`, japanese)).toEqual(['ambiguous'])
    expect(kinds(`const p${CYRILLIC_A}ssword = 1`, both)).toEqual([])
  })

  it('excuses a code point the document declares as its own', () => {
    const options = normalizeSuspiciousCharactersOptions({ allowedCodePoints: [0x430] })

    expect(scan(`const p${CYRILLIC_A}ssword = 1`, options)).toEqual([])
  })

  it('reports only the family that is switched on', () => {
    const text = `const p${CYRILLIC_A}ssword =${ZERO_WIDTH_SPACE} 1`

    expect(kinds(text, normalizeSuspiciousCharactersOptions({ invisible: false }))).toEqual([
      'ambiguous',
    ])
    expect(kinds(text, normalizeSuspiciousCharactersOptions({ ambiguous: false }))).toEqual([
      'invisible',
    ])
    expect(
      kinds(text, normalizeSuspiciousCharactersOptions({ ambiguous: false, invisible: false })),
    ).toEqual([])
  })
})

describe('suspicious character markers', () => {
  let container: HTMLElement
  const views: VirtualizedTextView[] = []

  beforeEach(() => {
    // @ts-expect-error happy-dom does not provide Highlight.
    globalThis.Highlight = MockHighlight
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    for (const view of views.splice(0)) view.dispose()
    container.remove()
    Reflect.deleteProperty(globalThis, 'Highlight')
  })

  function mountView(text: string): VirtualizedTextView {
    const view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      highlightRegistry: mockRegistry,
      selectionHighlightName: 'test-selection',
      hiddenCharacters: 'hidden',
    })
    views.push(view)
    view.setText(text)
    view.setScrollMetrics(0, 200)
    return view
  }

  function markerKinds(): string[] {
    return [
      ...container.querySelectorAll<HTMLElement>('.editor-virtualized-hidden-character-marker'),
    ].map((marker) => marker.dataset.editorHiddenCharacter ?? '')
  }

  // Whitespace rendering is a preference about how to read the text; this is a claim about what the
  // text is, so turning the one off says nothing about the other.
  it('marks a suspicious character even with whitespace rendering switched off', () => {
    mountView(`const p${CYRILLIC_A}ssword = 1`)

    expect(markerKinds()).toEqual(['ambiguous'])
  })

  it('marks the invisible characters of a trojan-source line', () => {
    mountView(TROJAN_SOURCE)

    expect(markerKinds()).toEqual(['invisible', 'invisible', 'invisible', 'invisible'])
  })

  it('redraws the mounted rows when the settings change', () => {
    const view = mountView(`const p${CYRILLIC_A}ssword = 1`)
    // Asserted before the change so an empty result after it proves the mark was taken away rather
    // than never drawn.
    expect(markerKinds()).toEqual(['ambiguous'])

    view.setSuspiciousCharacters(
      normalizeSuspiciousCharactersOptions({ ambiguous: false, invisible: false }),
    )

    expect(markerKinds()).toEqual([])
  })
})

describe('suspicious characters as an editor option', () => {
  let container: HTMLElement
  let editor: Editor

  beforeEach(() => {
    highlightsMap.clear()
    // @ts-expect-error happy-dom does not provide Highlight.
    globalThis.Highlight = MockHighlight
    setHighlightRegistry(mockRegistry)
    resetEditorInstanceCount()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
    setHighlightRegistry(undefined)
    Reflect.deleteProperty(globalThis, 'Highlight')
  })

  function markerKinds(): string[] {
    return [
      ...container.querySelectorAll<HTMLElement>('.editor-virtualized-hidden-character-marker'),
    ].map((marker) => marker.dataset.editorHiddenCharacter ?? '')
  }

  // Whitespace rendering is on throughout so that every expectation below names markers the rows
  // do draw: an empty result would otherwise read the same as rows that never mounted.
  function mountEditor(suspiciousCharacters?: EditorSuspiciousCharactersOptions): Editor {
    editor = new Editor(container, {
      defaultText: `const p${CYRILLIC_A}ssword = 1`,
      hiddenCharacters: 'show',
      suspiciousCharacters,
    })

    return editor
  }

  it('carries the option handed to the constructor into the mounted rows', () => {
    mountEditor({ ambiguous: false, invisible: false })

    expect(markerKinds()).toEqual(['space', 'space', 'space'])
  })

  it('marks what was already on screen when the option is turned back on', () => {
    mountEditor({ ambiguous: false, invisible: false })

    editor.setSuspiciousCharacters({})

    expect(markerKinds()).toEqual(['space', 'space', 'space', 'ambiguous'])
  })

  // The registry is what the framework bindings iterate; an option missing from it is an option no
  // host can drive, however well the editor method behind it works.
  it('is an entry in the option registry that reaches the editor', () => {
    mountEditor()
    const descriptor = EDITOR_OPTION_DESCRIPTORS.find(
      (entry) => entry.name === 'suspiciousCharacters',
    )
    if (!descriptor) throw new Error('suspiciousCharacters is not in the option registry')

    descriptor.applyTo(editor, descriptor.validate({ ambiguous: false, invisible: false }))

    expect(markerKinds()).toEqual(['space', 'space', 'space'])
  })
})
