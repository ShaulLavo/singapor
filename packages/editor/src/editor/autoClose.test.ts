import { describe, expect, it } from 'vitest'

import {
  autoClosingPairForClose,
  autoClosingPairForOpen,
  shouldAutoClose,
  shouldDeletePair,
  shouldTypeOverCloser,
} from './autoClose'

const paren = { close: ')', open: '(' } as const
const single = { close: "'", open: "'", quote: true } as const

describe('autoClosingPairForOpen', () => {
  it('finds a pair for a known language', () => {
    expect(autoClosingPairForOpen('typescript', '(')).toEqual({ close: ')', open: '(' })
  })

  it('treats quotes as pairs in code', () => {
    expect(autoClosingPairForOpen('typescript', "'")?.quote).toBe(true)
  })

  // Apostrophes are punctuation in prose, so markdown deliberately omits them.
  it('omits apostrophes in markdown', () => {
    expect(autoClosingPairForOpen('markdown', "'")).toBeNull()
    expect(autoClosingPairForOpen('markdown', '(')).not.toBeNull()
  })

  it('has no pairs for an unknown or absent language', () => {
    expect(autoClosingPairForOpen('cobol', '(')).toBeNull()
    expect(autoClosingPairForOpen(null, '(')).toBeNull()
  })
})

describe('autoClosingPairForClose', () => {
  it('finds the pair a closer belongs to', () => {
    expect(autoClosingPairForClose('typescript', ')')).toEqual({ close: ')', open: '(' })
  })

  it('is null for a character that closes nothing', () => {
    expect(autoClosingPairForClose('typescript', 'x')).toBeNull()
  })
})

describe('shouldAutoClose', () => {
  it('closes at end of line', () => {
    expect(shouldAutoClose(paren, { charAfter: null, charBefore: 'f' })).toBe(true)
  })

  it('closes before whitespace and expression enders', () => {
    for (const charAfter of [' ', '\n', ')', ']', '}', ',', ';', '.']) {
      expect(shouldAutoClose(paren, { charAfter, charBefore: 'f' })).toBe(true)
    }
  })

  // Closing here would drop the ')' into the middle of the word being wrapped.
  it('does not close directly before a word', () => {
    expect(shouldAutoClose(paren, { charAfter: 'a', charBefore: ' ' })).toBe(false)
  })

  it('closes quotes in the same places as brackets', () => {
    expect(shouldAutoClose(single, { charAfter: null, charBefore: ' ' })).toBe(true)
  })

  // don't, it's, isn't
  it('does not close a quote right after a word character', () => {
    expect(shouldAutoClose(single, { charAfter: ' ', charBefore: 'n' })).toBe(false)
    expect(shouldAutoClose(single, { charAfter: null, charBefore: '9' })).toBe(false)
  })

  it('still closes a quote after punctuation or whitespace', () => {
    expect(shouldAutoClose(single, { charAfter: null, charBefore: '(' })).toBe(true)
    expect(shouldAutoClose(single, { charAfter: null, charBefore: null })).toBe(true)
  })

  // Typing the second quote of '' would otherwise nest forever.
  it('does not close a quote immediately after the same quote', () => {
    expect(shouldAutoClose(single, { charAfter: null, charBefore: "'" })).toBe(false)
  })

  it('does not veto a bracket after a word character', () => {
    expect(shouldAutoClose(paren, { charAfter: null, charBefore: 'n' })).toBe(true)
  })
})

describe('shouldTypeOverCloser', () => {
  it('steps over a closer this editor inserted', () => {
    expect(shouldTypeOverCloser({ charAfter: ')', close: ')', trackedAtCaret: true })).toBe(true)
  })

  // Otherwise a hand-typed ')' could never be inserted before an existing one.
  it('does not step over an untracked closer', () => {
    expect(shouldTypeOverCloser({ charAfter: ')', close: ')', trackedAtCaret: false })).toBe(false)
  })

  it('does not step over a different character', () => {
    expect(shouldTypeOverCloser({ charAfter: ']', close: ')', trackedAtCaret: true })).toBe(false)
    expect(shouldTypeOverCloser({ charAfter: null, close: ')', trackedAtCaret: true })).toBe(false)
  })
})

describe('shouldDeletePair', () => {
  it('deletes both halves when the caret sits inside a tracked pair', () => {
    expect(
      shouldDeletePair({ charAfter: ')', charBefore: '(', pair: paren, trackedAtCaret: true }),
    ).toBe(true)
  })

  it('leaves a hand-typed pair alone', () => {
    expect(
      shouldDeletePair({ charAfter: ')', charBefore: '(', pair: paren, trackedAtCaret: false }),
    ).toBe(false)
  })

  it('does nothing when the halves no longer surround the caret', () => {
    expect(
      shouldDeletePair({ charAfter: 'x', charBefore: '(', pair: paren, trackedAtCaret: true }),
    ).toBe(false)
    expect(
      shouldDeletePair({ charAfter: ')', charBefore: 'x', pair: paren, trackedAtCaret: true }),
    ).toBe(false)
  })

  it('does nothing without a pair', () => {
    expect(
      shouldDeletePair({ charAfter: ')', charBefore: '(', pair: null, trackedAtCaret: true }),
    ).toBe(false)
  })
})
