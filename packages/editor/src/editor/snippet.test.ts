import { describe, expect, it } from 'vitest'

import { parseSnippet, snippetInitialSelection } from './snippet'

describe('parseSnippet', () => {
  it('returns plain text unchanged', () => {
    expect(parseSnippet('console.log')).toEqual({ stops: [], text: 'console.log' })
  })

  it('records a simple tab stop as a caret position', () => {
    const parsed = parseSnippet('foo($1)')

    expect(parsed.text).toBe('foo()')
    expect(parsed.stops).toEqual([{ index: 1, ranges: [{ end: 4, start: 4 }] }])
  })

  it('expands a placeholder to its default and selects it', () => {
    const parsed = parseSnippet('foo(${1:arg})')

    expect(parsed.text).toBe('foo(arg)')
    expect(parsed.stops).toEqual([{ index: 1, ranges: [{ end: 7, start: 4 }] }])
  })

  it('handles several placeholders in order', () => {
    const parsed = parseSnippet('${1:a}, ${2:b}')

    expect(parsed.text).toBe('a, b')
    expect(parsed.stops.map((stop) => stop.index)).toEqual([1, 2])
  })

  // $0 is where the caret leaves the snippet, so it is visited last however it is numbered.
  it('sorts the exit stop last', () => {
    const parsed = parseSnippet('if ($1) {\n  $0\n}')

    expect(parsed.stops.map((stop) => stop.index)).toEqual([1, 0])
  })

  it('groups repeated stops so they can be edited together', () => {
    const parsed = parseSnippet('$1 = $1')

    expect(parsed.stops).toEqual([{ index: 1, ranges: [{ end: 0, start: 0 }, { end: 3, start: 3 }] }])
  })

  it('takes the first option of a choice as the default', () => {
    const parsed = parseSnippet('${1|public,private|} x')

    expect(parsed.text).toBe('public x')
    expect(parsed.stops[0]?.ranges).toEqual([{ end: 6, start: 0 }])
  })

  it('expands ${1} with no default to an empty stop', () => {
    const parsed = parseSnippet('a${1}b')

    expect(parsed.text).toBe('ab')
    expect(parsed.stops[0]?.ranges).toEqual([{ end: 1, start: 1 }])
  })

  it('substitutes known variables and empties unknown ones', () => {
    expect(parseSnippet('$TM_SELECTED_TEXT!', { selection: 'hi' }).text).toBe('hi!')
    expect(parseSnippet('${TM_SELECTED_TEXT}!', { selection: 'hi' }).text).toBe('hi!')
    expect(parseSnippet('$NOT_A_THING!').text).toBe('!')
  })

  it('falls back to a variable default when the variable is empty', () => {
    expect(parseSnippet('${TM_SELECTED_TEXT:none}').text).toBe('none')
  })

  it('unescapes \\$, \\} and \\\\', () => {
    expect(parseSnippet('\\$1').text).toBe('$1')
    expect(parseSnippet('\\}').text).toBe('}')
    expect(parseSnippet('a\\\\b').text).toBe('a\\b')
  })

  it('leaves a bare dollar alone', () => {
    expect(parseSnippet('costs $ today').text).toBe('costs $ today')
  })

  it('flattens a nested placeholder to its default text', () => {
    const parsed = parseSnippet('${1:outer ${2:inner}}')

    expect(parsed.text).toBe('outer inner')
    expect(parsed.stops.map((stop) => stop.index)).toEqual([1])
  })

  it('leaves an unterminated placeholder as literal text', () => {
    expect(parseSnippet('${1:oops').text).toBe('${1:oops')
  })
})

describe('snippetInitialSelection', () => {
  it('selects the first stop, offset into the document', () => {
    const parsed = parseSnippet('foo(${1:arg})')

    expect(snippetInitialSelection(parsed, 100)).toEqual({ end: 107, start: 104 })
  })

  it('lands at the end when the snippet has no stops', () => {
    const parsed = parseSnippet('done')

    expect(snippetInitialSelection(parsed, 10)).toEqual({ end: 14, start: 14 })
  })
})
