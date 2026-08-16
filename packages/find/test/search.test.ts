import { describe, expect, it, vi } from 'vitest'
import { parseReplaceString } from '../src/replacePattern'
import {
  FIND_MATCHES_LIMIT,
  findMatches,
  nextMatchAfter,
  previousMatchBefore,
  type FindQuery,
} from '../src/search'
import {
  EditorFindController,
  type EditorFindHost,
  type EditorFindResolvedSelection,
  type EditorFindWidgetState,
} from '../src/findController'
import { EditorFindWidget } from '../src/findWidget'
import type { EditorFindOptions } from '../src/types'

describe('editor search', () => {
  it('finds plain matches with case and whole-word options', () => {
    expect(
      findMatches('foo Foo food foo', {
        searchString: 'foo',
        isRegex: false,
        matchCase: false,
        wholeWord: true,
      }).map(({ start, end }) => ({ start, end })),
    ).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 13, end: 16 },
    ])

    expect(
      findMatches('foo Foo', {
        searchString: 'foo',
        isRegex: false,
        matchCase: true,
        wholeWord: false,
      }).map(({ start, end }) => ({ start, end })),
    ).toEqual([{ start: 0, end: 3 }])
  })

  it('uses shared unicode word boundaries', () => {
    expect(
      findMatches('café cafe café_2', {
        searchString: 'café',
        isRegex: false,
        matchCase: true,
        wholeWord: true,
      }).map(({ start, end }) => ({ start, end })),
    ).toEqual([{ start: 0, end: 4 }])
  })

  it('finds regex, multiline, invalid-regex, zero-length, and limited matches', () => {
    const regexMatches = findMatches(
      'one\ntwo\nthree',
      { searchString: '^t\\w+', isRegex: true, matchCase: true, wholeWord: false },
      null,
      true,
    )
    expect(
      regexMatches.map(({ start, end, matches }) => ({ start, end, match: matches?.[0] })),
    ).toEqual([
      { start: 4, end: 7, match: 'two' },
      { start: 8, end: 13, match: 'three' },
    ])

    expect(
      findMatches('abc', {
        searchString: '(',
        isRegex: true,
        matchCase: true,
        wholeWord: false,
      }),
    ).toEqual([])

    expect(
      findMatches('ab', {
        searchString: '',
        isRegex: false,
        matchCase: true,
        wholeWord: false,
      }),
    ).toEqual([])

    expect(
      findMatches(
        'aaa',
        { searchString: 'a', isRegex: false, matchCase: true, wholeWord: false },
        null,
        false,
        2,
      ),
    ).toHaveLength(2)

    expect(
      findMatches('ab', {
        searchString: '(?=)',
        isRegex: true,
        matchCase: true,
        wholeWord: false,
      }),
    ).toHaveLength(3)
  })

  it('still matches case-insensitively without folding', () => {
    const matches = findMatches('Foo foo FOO', {
      searchString: 'foo',
      isRegex: false,
      matchCase: false,
      wholeWord: false,
    })

    expect(matches.map((match) => match.start)).toEqual([0, 4, 8])
  })

  it('keeps the plain-text path for caseless queries', () => {
    const matches = findMatches('a1b1c', {
      searchString: '1',
      isRegex: false,
      matchCase: false,
      wholeWord: false,
    })

    expect(matches.map((match) => match.start)).toEqual([1, 3])
  })

  it('reports case-insensitive matches at unfolded offsets', () => {
    // Folding is not length-preserving: 'İ' (U+0130) lowercases to two code
    // units while 'ẞ' (U+1E9E) lowercases to one, so an index taken from a
    // folded copy runs ahead of the original text by one per 'İ' already seen.
    const text = 'aİstanbul ẞtraße stanbul'
    const matches = findMatches(text, {
      searchString: 'stanbul',
      isRegex: false,
      matchCase: false,
      wholeWord: false,
    })

    expect(matches.map(({ start, end }) => ({ start, end }))).toEqual([
      { start: 2, end: 9 },
      { start: 17, end: 24 },
    ])
    for (const match of matches) {
      expect(text.slice(match.start, match.end).toLowerCase()).toBe('stanbul')
    }
  })

  it('escapes a zero-width match parked on the navigation offset', () => {
    const text = 'one\ntwo\nthree'
    const anchoredMatches = findMatches(text, regexQuery('^'))

    expect(anchoredMatches.map((match) => match.start)).toEqual([0, 4, 8])
    expect(nextMatchAfter(anchoredMatches, 4, true, true)?.start).toBe(8)
    expect(previousMatchBefore(anchoredMatches, 4, true, true)?.start).toBe(0)

    const lookaheadMatches = findMatches('ab ab', regexQuery('(?=b)'))

    expect(lookaheadMatches.map((match) => match.start)).toEqual([1, 4])
    expect(nextMatchAfter(lookaheadMatches, 1, true, true)?.start).toBe(4)
    expect(previousMatchBefore(lookaheadMatches, 4, true, true)?.start).toBe(1)
  })

  it('steps to the neighbouring match rather than probing the document', () => {
    // '[^,]*' produces an empty match at every comma. Escaping by re-probing
    // the text has to guess whether a '^' in the pattern is an anchor; stepping
    // the ordered match list does not, and cannot step over a real match.
    const matches = findMatches('a,b\nc,d', regexQuery('[^,]*'))

    expect(matches.map(({ start, end }) => [start, end])).toEqual([
      [0, 1],
      [1, 1],
      [2, 5],
      [5, 5],
      [6, 7],
      [7, 7],
    ])
    expect(nextMatchAfter(matches, 1, true, true)?.start).toBe(2)
    expect(previousMatchBefore(matches, 1, true, true)?.start).toBe(0)
  })

  it('keeps loop semantics while escaping', () => {
    const text = 'one\ntwo\nthree'
    const matches = findMatches(text, regexQuery('^'))

    expect(nextMatchAfter(matches, 8, false, true)).toBeNull()
    expect(previousMatchBefore(matches, 0, false, true)).toBeNull()
    expect(nextMatchAfter(matches, 8, true, true)?.start).toBe(0)
    expect(previousMatchBefore(matches, 0, true, true)?.start).toBe(8)

    // A non-empty match on the offset is where the user asked to be; escaping
    // is only ever for the zero-width case.
    const wordMatches = findMatches(text, regexQuery('t\\w+'))
    expect(nextMatchAfter(wordMatches, 4, true, true)?.start).toBe(4)
  })

  it('parses replacement patterns and preserve-case replacements', () => {
    const pattern = parseReplaceString('[$&]-$1-$$-\\n-\\u$2')

    expect(pattern.buildReplaceString(['ab', 'a', 'b'])).toBe('[ab]-a-$-\n-B')
    expect(parseReplaceString('bar').buildReplaceString(['FOO'], true)).toBe('BAR')
    expect(parseReplaceString('bar-baz').buildReplaceString(['foo-qux'], true)).toBe('bar-baz')
    expect(parseReplaceString('bar_baz').buildReplaceString(['FOO_QUX'], true)).toBe('BAR_BAZ')
  })
})

describe('editor find controller', () => {
  it('walks off a zero-width match instead of re-selecting it', () => {
    const harness = createFindHarness('one\ntwo\nthree', collapsedSelection(0), {
      seedSearchStringFromSelection: 'never',
    })

    harness.controller.openFind()
    harness.controller.toggleRegex()
    harness.controller.setSearchString('^')
    expect(harness.selectionStart()).toBe(0)

    harness.controller.findNext()
    const first = harness.selectionStart()
    harness.controller.findNext()
    const second = harness.selectionStart()
    expect([first, second]).toEqual([4, 8])

    harness.controller.findPrevious()
    expect(harness.selectionStart()).toBe(4)
  })

  it('escapes regex metacharacters when seeding from the selection', () => {
    const text = 'call foo(bar) now'
    const harness = createFindHarness(text, resolvedSelection(5, 13))

    harness.controller.toggleRegex()
    harness.controller.openFind()

    expect(harness.state()?.searchString).toBe('foo\\(bar\\)')
    expect(harness.state()?.matchesCount).toBe(1)
  })

  it('refuses to seed from an oversized selection', () => {
    const text = 'x'.repeat(600_000)
    const harness = createFindHarness(text, resolvedSelection(0, text.length))

    harness.controller.openFind()

    expect(harness.state()?.searchString).toHaveLength(0)
  })

  it('selects every match, not just the painted ones', () => {
    const text = 'a'.repeat(FIND_MATCHES_LIMIT + 2)
    const harness = createFindHarness(text, collapsedSelection(0), {
      seedSearchStringFromSelection: 'never',
    })

    harness.controller.openFind()
    harness.controller.setSearchString('a')
    expect(harness.state()?.matchesCount).toBe(FIND_MATCHES_LIMIT)

    expect(harness.controller.selectAllMatches()).toBe(true)
    expect(harness.selectAllCount()).toBe(FIND_MATCHES_LIMIT + 2)
  })

  it('replaces every match, not just the painted ones', () => {
    const text = 'a'.repeat(FIND_MATCHES_LIMIT + 2)
    const harness = createFindHarness(text, collapsedSelection(0), {
      seedSearchStringFromSelection: 'never',
    })

    harness.controller.openFind()
    harness.controller.setSearchString('a')
    harness.controller.setReplaceString('b')
    expect(harness.state()?.matchesCount).toBe(FIND_MATCHES_LIMIT)

    expect(harness.controller.replaceAll()).toBe(true)
    // Stopping at the paint cap would leave a tail of untouched matches behind,
    // which is the silent half-replacement this guards against.
    expect(harness.text()).toBe('b'.repeat(FIND_MATCHES_LIMIT + 2))
  })

  it('counts a result set that stops exactly at the cap as complete', () => {
    const harness = createFindHarness('a'.repeat(FIND_MATCHES_LIMIT), collapsedSelection(0), {
      seedSearchStringFromSelection: 'never',
    })

    harness.controller.openFind()
    harness.controller.setSearchString('a')

    expect(harness.state()?.matchesCount).toBe(FIND_MATCHES_LIMIT)
    expect(harness.state()?.matchesTruncated).toBe(false)
  })
})

describe('editor find widget', () => {
  it('marks a truncated result count as a floor', () => {
    const container = document.createElement('div')
    const widget = new EditorFindWidget(container, container, widgetOptions())

    widget.update(widgetState({ matchesPosition: 2, matchesCount: 3, matchesTruncated: false }))
    expect(countElement(container)?.textContent).toBe('2 of 3')
    expect(countElement(container)?.title).toBe('2 of 3')

    widget.update(
      widgetState({
        matchesPosition: 1,
        matchesCount: FIND_MATCHES_LIMIT,
        matchesTruncated: true,
      }),
    )
    expect(countElement(container)?.textContent).toBe(`1 of ${FIND_MATCHES_LIMIT}+`)
    expect(countElement(container)?.title).toContain('entire text')

    widget.dispose()
  })
})

function regexQuery(searchString: string): FindQuery {
  return { searchString, isRegex: true, matchCase: true, wholeWord: false }
}

function resolvedSelection(anchor: number, head: number): EditorFindResolvedSelection {
  return {
    anchorOffset: anchor,
    headOffset: head,
    startOffset: Math.min(anchor, head),
    endOffset: Math.max(anchor, head),
    collapsed: anchor === head,
  }
}

function collapsedSelection(offset: number): EditorFindResolvedSelection {
  return resolvedSelection(offset, offset)
}

function createFindHarness(
  text: string,
  selection: EditorFindResolvedSelection,
  options: EditorFindOptions = {},
) {
  let current = selection
  let document = text
  let state: EditorFindWidgetState | null = null
  let selectAll: readonly { readonly head: number }[] = []
  const host: EditorFindHost = {
    hasDocument: () => true,
    materializeFullText: () => document,
    getSelections: () => [current],
    focusEditor: () => {},
    setSelection: (anchor, head) => {
      current = resolvedSelection(anchor, head)
    },
    setSelections: (selections) => {
      selectAll = selections
    },
    setRangeHighlight: () => {},
    clearRangeHighlight: () => {},
  }

  const controller = new EditorFindController(options)
  controller.attachHost(host, 'find-test')
  // Edits arrive sorted descending by the controller's own merge step, so
  // applying them in order never invalidates a later edit's offsets.
  controller.attachEditHost({
    applyEdits: (edits) => {
      for (const edit of edits) {
        document = document.slice(0, edit.from) + edit.text + document.slice(edit.to)
      }
    },
  })
  controller.subscribe((event) => {
    if (event.type === 'update') state = event.state
  })

  return {
    controller,
    state: () => state,
    text: () => document,
    selectionStart: () => current.startOffset,
    selectAllCount: () => selectAll.length,
  }
}

function widgetState(overrides: Partial<EditorFindWidgetState> = {}): EditorFindWidgetState {
  return {
    searchString: 'a',
    replaceString: '',
    isRegex: false,
    matchCase: false,
    wholeWord: false,
    preserveCase: false,
    revealed: true,
    replaceRevealed: false,
    inSelection: false,
    matchesCount: 0,
    matchesPosition: 0,
    matchesTruncated: false,
    ...overrides,
  }
}

function widgetOptions() {
  return {
    onSearchInput: vi.fn(),
    onReplaceInput: vi.fn(),
    onToggleReplace: vi.fn(),
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onClose: vi.fn(),
    onToggleCase: vi.fn(),
    onToggleWholeWord: vi.fn(),
    onToggleRegex: vi.fn(),
    onToggleScope: vi.fn(),
    onTogglePreserveCase: vi.fn(),
    onReplaceOne: vi.fn(),
    onReplaceAll: vi.fn(),
  }
}

function countElement(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('.editor-find-count')
}
