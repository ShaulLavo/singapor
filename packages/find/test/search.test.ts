import { describe, expect, it } from 'vitest'
import { parseReplaceString } from '../src/replacePattern'
import { findMatches } from '../src/search'

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

  it('reports case-insensitive matches against original offsets', () => {
    // 'İ' (U+0130) lowercases to two code units, so any index taken from a
    // case-folded copy of the text addresses the wrong characters here.
    const text = 'aİstanbul stanbul'
    const matches = findMatches(text, {
      searchString: 'stanbul',
      isRegex: false,
      matchCase: false,
      wholeWord: false,
    })

    expect(matches).toHaveLength(2)
    for (const match of matches) {
      expect(text.slice(match.start, match.end).toLocaleLowerCase()).toBe('stanbul')
    }
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

  it('parses replacement patterns and preserve-case replacements', () => {
    const pattern = parseReplaceString('[$&]-$1-$$-\\n-\\u$2')

    expect(pattern.buildReplaceString(['ab', 'a', 'b'])).toBe('[ab]-a-$-\n-B')
    expect(parseReplaceString('bar').buildReplaceString(['FOO'], true)).toBe('BAR')
    expect(parseReplaceString('bar-baz').buildReplaceString(['foo-qux'], true)).toBe('bar-baz')
    expect(parseReplaceString('bar_baz').buildReplaceString(['FOO_QUX'], true)).toBe('BAR_BAZ')
  })
})
