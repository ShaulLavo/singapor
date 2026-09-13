import { describe, expect, it } from 'vitest'
import { getEditorTokenIndex } from '../src/editor/tokenIndex'
import {
  packEditorTokens,
  packedEditorTokenTransfers,
  splicePackedEditorTokens,
  unpackEditorTokens,
} from '../src/syntax/packedTokens'

describe('packed editor token transport', () => {
  it('shares numeric packing, transfer buffers, and exact ordering metadata', () => {
    const sharedStyle = { color: '#f00' }
    const tokens = [
      { start: 0, end: 10, style: sharedStyle },
      { start: 2, end: 5, style: sharedStyle },
      { start: 11, end: 15, style: { color: '#0f0' } },
    ]

    const packed = packEditorTokens(tokens)

    expect(Array.from(packed.starts)).toEqual([0, 2, 11])
    expect(Array.from(packed.ends)).toEqual([10, 5, 15])
    expect(Array.from(packed.styleIds)).toEqual([0, 0, 1])
    expect(packed.styles).toEqual([{ color: '#f00' }, { color: '#0f0' }])
    expect(packed).toMatchObject({
      monotonicEnd: false,
      nonOverlapping: false,
      sortedByStart: true,
    })
    expect(packedEditorTokenTransfers(packed)).toEqual([
      packed.starts.buffer,
      packed.ends.buffer,
      packed.styleIds.buffer,
    ])

    const unpacked = unpackEditorTokens(packed)
    expect(unpacked).toEqual(tokens)
    expect(unpacked[0]?.style).toBe(unpacked[1]?.style)
    expect(getEditorTokenIndex(unpacked)).toMatchObject({
      maxEnds: [10, 10, 15],
      monotonicEnd: false,
      nonOverlapping: false,
      sortedByStart: true,
    })
  })
})

describe('splicePackedEditorTokens', () => {
  const keyword = { color: '#f00' }
  const name = { color: '#0f0' }
  // "const a = 1;\nconst b = 2;" tokenized as keyword, name per line.
  const base = packEditorTokens([
    { start: 0, end: 5, style: keyword },
    { start: 6, end: 7, style: name },
    { start: 13, end: 18, style: keyword },
    { start: 19, end: 20, style: name },
  ])

  it('replaces the tokens of the edited lines and shifts the rest', () => {
    // Line 0 becomes "const answer = 1;", 5 characters longer.
    const spliced = splicePackedEditorTokens(base, {
      fromOffset: 0,
      oldEndOffset: 13,
      newEndOffset: 18,
      tokensPacked: packEditorTokens([
        { start: 0, end: 5, style: { color: '#f00' } },
        { start: 6, end: 12, style: { color: '#00f' } },
      ]),
    })

    expect(unpackEditorTokens(spliced)).toEqual([
      { start: 0, end: 5, style: keyword },
      { start: 6, end: 12, style: { color: '#00f' } },
      { start: 18, end: 23, style: keyword },
      { start: 24, end: 25, style: name },
    ])
    // The equal-by-value keyword style reused its id; the new one joined the palette.
    expect(spliced.styles).toEqual([keyword, name, { color: '#00f' }])
    expect(Array.from(spliced.styleIds)).toEqual([0, 2, 0, 1])
    expect(spliced).toMatchObject({ sortedByStart: true, nonOverlapping: true, monotonicEnd: true })
  })

  it('drops a deleted line and pulls later tokens back', () => {
    const spliced = splicePackedEditorTokens(base, {
      fromOffset: 0,
      oldEndOffset: 13,
      newEndOffset: 0,
      tokensPacked: packEditorTokens([]),
    })

    expect(unpackEditorTokens(spliced)).toEqual([
      { start: 0, end: 5, style: keyword },
      { start: 6, end: 7, style: name },
    ])
  })

  it('applies a trailing patch without touching earlier tokens', () => {
    const spliced = splicePackedEditorTokens(base, {
      fromOffset: 13,
      oldEndOffset: 20,
      newEndOffset: 22,
      tokensPacked: packEditorTokens([{ start: 13, end: 22, style: name }]),
    })

    expect(Array.from(spliced.starts)).toEqual([0, 6, 13])
    expect(Array.from(spliced.ends)).toEqual([5, 7, 22])
  })
})
