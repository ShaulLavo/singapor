import { describe, expect, it } from 'vitest'
import { getEditorTokenIndex } from '../src/editor/tokenIndex'
import {
  packEditorTokens,
  packedEditorTokenTransfers,
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
