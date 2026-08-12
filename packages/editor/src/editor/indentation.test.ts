import { describe, expect, it } from 'vitest'

import { leadingWhitespace, lineBreakIndent } from './indentation'

const options = (overrides: Partial<Parameters<typeof lineBreakIndent>[0]> = {}) => ({
  afterOpener: false,
  betweenPair: false,
  charAfter: null,
  charBefore: null,
  lineTextBeforeCaret: '',
  tabSize: 2,
  ...overrides,
})

describe('leadingWhitespace', () => {
  it('reads spaces and tabs', () => {
    expect(leadingWhitespace('    foo')).toBe('    ')
    expect(leadingWhitespace('\t\tfoo')).toBe('\t\t')
  })

  it('is empty for an unindented or blank line', () => {
    expect(leadingWhitespace('foo')).toBe('')
    expect(leadingWhitespace('')).toBe('')
  })
})

describe('lineBreakIndent', () => {
  it('continues the previous indentation', () => {
    const result = lineBreakIndent(options({ lineTextBeforeCaret: '    foo' }))

    expect(result).toEqual({ insert: '\n    ', trailing: '' })
  })

  it('adds nothing at the top level', () => {
    expect(lineBreakIndent(options({ lineTextBeforeCaret: 'foo' }))).toEqual({
      insert: '\n',
      trailing: '',
    })
  })

  it('indents one level deeper after an opener', () => {
    const result = lineBreakIndent(
      options({ afterOpener: true, charBefore: '{', lineTextBeforeCaret: '  if (x) {' }),
    )

    expect(result).toEqual({ insert: '\n    ', trailing: '' })
  })

  // The pairing with auto-close: `{|}` + Enter becomes a three-line block.
  it('pushes a closer onto its own line when the caret sits between a pair', () => {
    const result = lineBreakIndent(
      options({
        afterOpener: true,
        betweenPair: true,
        charAfter: '}',
        charBefore: '{',
        lineTextBeforeCaret: '  if (x) {',
      }),
    )

    expect(result).toEqual({ insert: '\n    ', trailing: '\n  ' })
  })

  it('keeps tabs when the line is indented with tabs', () => {
    const result = lineBreakIndent(
      options({ afterOpener: true, charBefore: '{', lineTextBeforeCaret: '\tif (x) {' }),
    )

    expect(result).toEqual({ insert: '\n\t\t', trailing: '' })
  })

  it('uses the tab size for a space-indented line', () => {
    const result = lineBreakIndent(
      options({ afterOpener: true, charBefore: '{', lineTextBeforeCaret: 'f() {', tabSize: 4 }),
    )

    expect(result).toEqual({ insert: '\n    ', trailing: '' })
  })

  it('never produces a zero-width indent level', () => {
    const result = lineBreakIndent(
      options({ afterOpener: true, charBefore: '{', lineTextBeforeCaret: 'f() {', tabSize: 0 }),
    )

    expect(result.insert).toBe('\n ')
  })
})
