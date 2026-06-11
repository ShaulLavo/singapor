import { describe, expect, it } from 'vitest'

import { DocumentEditChain } from '../src/editor/editChain'

const apply = (text: string, edits: readonly { from: number; to: number; text: string }[]) => {
  let result = text
  for (const edit of [...edits].sort((left, right) => right.from - left.from)) {
    result = result.slice(0, edit.from) + edit.text + result.slice(edit.to)
  }
  return result
}

describe('DocumentEditChain', () => {
  it('returns empty edits when already at the newest version', () => {
    const chain = new DocumentEditChain()
    chain.record(1, 2, [{ from: 5, to: 5, text: 'a' }])
    expect(chain.editsSince(2)).toEqual([])
  })

  it('returns null for unknown or broken versions', () => {
    const chain = new DocumentEditChain()
    expect(chain.editsSince(1)).toBeNull()

    chain.record(1, 2, [{ from: 5, to: 5, text: 'a' }])
    expect(chain.editsSince(0)).toBeNull()

    chain.record(3, 4, [{ from: 9, to: 9, text: 'b' }])
    expect(chain.editsSince(1)).toBeNull()
  })

  it('returns null across entries with unknown edits', () => {
    const chain = new DocumentEditChain()
    chain.record(1, 2, [{ from: 5, to: 5, text: 'a' }])
    chain.record(2, 3, null)
    expect(chain.editsSince(1)).toBeNull()
  })

  it('composes a typing run into one base edit', () => {
    const base = 'const value = 1'
    const chain = new DocumentEditChain()
    chain.record(1, 2, [{ from: 15, to: 15, text: '2' }])
    chain.record(2, 3, [{ from: 16, to: 16, text: '3' }])
    chain.record(3, 4, [{ from: 17, to: 17, text: '4' }])

    const edits = chain.editsSince(1)
    expect(edits).toEqual([{ from: 15, to: 15, text: '234' }])
    expect(apply(base, edits!)).toBe('const value = 1234')
  })

  it('composes typing followed by backspace within the run', () => {
    const base = 'abc'
    const chain = new DocumentEditChain()
    chain.record(1, 2, [{ from: 3, to: 3, text: 'x' }])
    chain.record(2, 3, [{ from: 4, to: 4, text: 'y' }])
    chain.record(3, 4, [{ from: 4, to: 5, text: '' }])

    const edits = chain.editsSince(1)
    expect(apply(base, edits!)).toBe('abcx')
  })

  it('composes edits at separate positions', () => {
    const base = 'one two three'
    const chain = new DocumentEditChain()
    chain.record(1, 2, [{ from: 0, to: 3, text: 'ONE' }])
    chain.record(2, 3, [{ from: 8, to: 13, text: 'THREE' }])

    const edits = chain.editsSince(1)
    expect(apply(base, edits!)).toBe('ONE two THREE')
  })

  it('composes multi-cursor batches', () => {
    const base = 'aa bb cc'
    const chain = new DocumentEditChain()
    chain.record(1, 2, [
      { from: 0, to: 0, text: 'x' },
      { from: 3, to: 3, text: 'y' },
      { from: 6, to: 6, text: 'z' },
    ])
    chain.record(2, 3, [
      { from: 1, to: 1, text: 'X' },
      { from: 5, to: 5, text: 'Y' },
      { from: 9, to: 9, text: 'Z' },
    ])

    const edits = chain.editsSince(1)
    const once = apply(base, [
      { from: 0, to: 0, text: 'x' },
      { from: 3, to: 3, text: 'y' },
      { from: 6, to: 6, text: 'z' },
    ])
    const twice = apply(once, [
      { from: 1, to: 1, text: 'X' },
      { from: 5, to: 5, text: 'Y' },
      { from: 9, to: 9, text: 'Z' },
    ])
    expect(apply(base, edits!)).toBe(twice)
  })

  it('bails when a later edit straddles a previous edit boundary', () => {
    const chain = new DocumentEditChain()
    chain.record(1, 2, [{ from: 5, to: 5, text: 'ab' }])
    chain.record(2, 3, [{ from: 4, to: 6, text: '' }])
    expect(chain.editsSince(1)).toBeNull()
  })

  it('matches sequential application across random typing-like sequences', () => {
    let seed = 0x1234
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }

    for (let round = 0; round < 200; round += 1) {
      let text = 'function example(alpha, beta) { return alpha + beta }'
      const base = text
      const chain = new DocumentEditChain()
      let version = 1
      let composable = true

      for (let step = 0; step < 8; step += 1) {
        const insert = random() < 0.7 || text.length === 0
        const edit = insert
          ? {
              from: Math.floor(random() * (text.length + 1)),
              to: 0,
              text: 'xyz'[Math.floor(random() * 3)]!,
            }
          : { from: Math.floor(random() * text.length), to: 0, text: '' }
        edit.to = insert ? edit.from : Math.min(text.length, edit.from + 1 + Math.floor(random() * 2))

        text = text.slice(0, edit.from) + edit.text + text.slice(edit.to)
        chain.record(version, version + 1, [edit])
        version += 1
      }

      const edits = chain.editsSince(1)
      if (edits === null) {
        composable = false
      } else {
        expect(apply(base, edits)).toBe(text)
      }
      // Bailing is allowed; producing wrong text is not.
      expect(typeof composable).toBe('boolean')
    }
  })
})
