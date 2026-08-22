import { describe, expect, it } from 'vitest'

import { applyBatchToPieceTable, createPieceTableSnapshot } from '@singapor/core/document'
import {
  createTreeSitterSourceDescriptor,
  readTreeSitterInputRange,
  resolveTreeSitterSourceDescriptor,
  type TreeSitterSourceCache,
} from '../src/treeSitter/source.ts'

// One 16KB source chunk is the unit the descriptor splits on, so the text has
// to span several of them for boundary reads to mean anything.
const UNIT = 'const 名前 = "emoji 🎉🚀 tail"; // ünïcødé\n'
const TEXT = UNIT.repeat(2_000)

const readAll = (text: string, useSharedBuffers: boolean): string => {
  let snapshot = createPieceTableSnapshot(text)
  snapshot = applyBatchToPieceTable(snapshot, [
    { from: Math.floor(text.length / 2), to: Math.floor(text.length / 2), text: 'INSERTED🌍' },
  ])
  const descriptor = createTreeSitterSourceDescriptor(snapshot, { useSharedBuffers })
  const cache: TreeSitterSourceCache = new Map()
  const input = resolveTreeSitterSourceDescriptor(cache, 'doc', descriptor)
  return readTreeSitterInputRange(input, 0, descriptor.length)
}

const resolveShared = (text: string) => {
  const snapshot = createPieceTableSnapshot(text)
  const descriptor = createTreeSitterSourceDescriptor(snapshot, { useSharedBuffers: true })
  const cache: TreeSitterSourceCache = new Map()
  return { descriptor, input: resolveTreeSitterSourceDescriptor(cache, 'doc', descriptor) }
}

describe('shared-utf16 source chunks', () => {
  it('emits shared chunks when shared buffers are requested', () => {
    const { descriptor } = resolveShared(TEXT)
    expect(descriptor.chunks.length).toBeGreaterThan(1)
    expect(new Set(descriptor.chunks.map((chunk) => chunk.kind))).toEqual(new Set(['shared-utf16']))
  })

  it('decodes to the same text as the string path', () => {
    expect(readAll(TEXT, true)).toBe(readAll(TEXT, false))
  })

  it('reads ranges that cross chunk boundaries', () => {
    const { descriptor, input } = resolveShared(TEXT)
    const expected = TEXT.slice(0, descriptor.length)
    for (const [start, end] of [
      [0, 10],
      [16_380, 16_400],
      [100, 50_000],
      [descriptor.length - 5, descriptor.length],
    ]) {
      expect(readTreeSitterInputRange(input, start!, end!)).toBe(expected.slice(start, end))
    }
  })

  it('round-trips a lone high surrogate at a chunk boundary', () => {
    // A split surrogate pair is where a naive decode corrupts the text.
    const padding = 'a'.repeat(16 * 1024 - 1)
    const text = `${padding}🎉${'b'.repeat(64)}`
    expect(readAll(text, true)).toBe(readAll(text, false))
  })

  it('preserves U+FEFF at a shared chunk boundary', () => {
    const text = `${'a'.repeat(16 * 1024)}\uFEFFtail`
    const { descriptor, input } = resolveShared(text)
    expect(readTreeSitterInputRange(input, 0, descriptor.length)).toBe(text)
  })
})
