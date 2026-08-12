import { describe, expect, it } from 'vitest'

import { bracketJumpTargetOffset, findBracketMatchAtCaret } from '../src/editor/bracketMatching'
import type { BracketInfo } from '../src/syntax/session'

/**
 * Builds the bracket list the syntax worker would ship for `text`, mirroring its rules: sorted by
 * index, depth counted with the opener included, and a closer keeping the depth it saw before
 * popping. Only bracket characters are recorded, so anything the worker would treat as string or
 * comment content simply must not appear in these fixtures.
 */
function bracketsFor(text: string): BracketInfo[] {
  const pairs: Record<string, string | undefined> = { '(': ')', '[': ']', '{': '}' }
  const closers = new Set(Object.values(pairs))
  const stack: string[] = []
  const brackets: BracketInfo[] = []

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === undefined) continue

    if (pairs[char] !== undefined) {
      stack.push(char)
      brackets.push({ char, depth: stack.length, index })
      continue
    }
    if (!closers.has(char)) continue

    const depth = stack.length > 0 ? stack.length : 1
    const top = stack[stack.length - 1]
    if (top !== undefined && pairs[top] === char) stack.pop()
    brackets.push({ char, depth, index })
  }

  return brackets
}

describe('findBracketMatchAtCaret', () => {
  it('pairs a caret sitting just after an opening bracket', () => {
    const text = 'fn(a)'
    const match = findBracketMatchAtCaret(bracketsFor(text), text.indexOf('(') + 1)

    expect(match).toEqual({ closeOffset: 4, openOffset: 2 })
  })

  it('pairs a caret sitting just after a closing bracket', () => {
    const text = 'fn(a)'
    const match = findBracketMatchAtCaret(bracketsFor(text), text.length)

    expect(match).toEqual({ closeOffset: 4, openOffset: 2 })
  })

  it('pairs a caret sitting directly on a bracket', () => {
    const text = 'fn(a)'
    const match = findBracketMatchAtCaret(bracketsFor(text), text.indexOf('('))

    expect(match).toEqual({ closeOffset: 4, openOffset: 2 })
  })

  it('skips nested pairs to find the partner at its own level', () => {
    const text = '{ a([1, 2]) }'
    const match = findBracketMatchAtCaret(bracketsFor(text), 1)

    expect(match).toEqual({ closeOffset: text.length - 1, openOffset: 0 })
  })

  it('matches the inner pair when the caret is inside a nest', () => {
    const text = '{ a([1, 2]) }'
    const match = findBracketMatchAtCaret(bracketsFor(text), text.indexOf('[') + 1)

    expect(match).toEqual({ closeOffset: text.indexOf(']'), openOffset: text.indexOf('[') })
  })

  it('returns null when the caret touches no bracket', () => {
    const text = 'fn(a)'
    expect(findBracketMatchAtCaret(bracketsFor(text), 1)).toBeNull()
  })

  it('returns null for an unclosed bracket', () => {
    const text = 'fn(a'
    expect(findBracketMatchAtCaret(bracketsFor(text), 3)).toBeNull()
  })

  it('returns null for an unopened closing bracket', () => {
    const text = 'a)'
    expect(findBracketMatchAtCaret(bracketsFor(text), 2)).toBeNull()
  })

  // The worker gives `{` and `]` the same depth here, so a depth-only matcher would pair them.
  it('refuses to pair mismatched characters at the same depth', () => {
    const text = '{ a ]'
    expect(findBracketMatchAtCaret(bracketsFor(text), 1)).toBeNull()
  })

  it('returns null on an empty bracket list', () => {
    expect(findBracketMatchAtCaret([], 0)).toBeNull()
  })

  it('gives up once the scan budget is exhausted', () => {
    const text = `(${'[]'.repeat(50)})`
    const brackets = bracketsFor(text)

    expect(findBracketMatchAtCaret(brackets, 1, 4)).toBeNull()
    expect(findBracketMatchAtCaret(brackets, 1)).toEqual({
      closeOffset: text.length - 1,
      openOffset: 0,
    })
  })
})

describe('bracketJumpTargetOffset', () => {
  it('jumps forward to just past the closing bracket', () => {
    const text = 'fn(a)'
    expect(bracketJumpTargetOffset(bracketsFor(text), 3)).toBe(5)
  })

  it('jumps back to just past the opening bracket', () => {
    const text = 'fn(a)'
    expect(bracketJumpTargetOffset(bracketsFor(text), 5)).toBe(3)
  })

  it('round-trips: jumping twice returns to the starting caret', () => {
    const text = '{ a([1, 2]) }'
    const brackets = bracketsFor(text)
    const first = bracketJumpTargetOffset(brackets, 1)

    expect(first).not.toBeNull()
    expect(bracketJumpTargetOffset(brackets, first ?? 0)).toBe(1)
  })

  it('returns null when there is nothing to jump to', () => {
    expect(bracketJumpTargetOffset(bracketsFor('fn(a'), 3)).toBeNull()
  })
})
