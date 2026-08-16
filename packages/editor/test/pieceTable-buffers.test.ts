import { describe, expect, it } from 'vitest'

import {
  appendChunksToBuffers,
  BUFFER_CHUNK_SIZE,
  bufferForPiece,
  countBufferLineBreaks,
  countLineBreaks,
  createInitialBuffers,
  createOriginalPiece,
  createPiece,
  extendTailChunk,
  findBufferLineBreakOffset,
  getBufferText,
} from '../src/pieceTable/buffers.ts'

describe('piece table buffers', () => {
  it('counts line breaks inside an optional range', () => {
    expect(countLineBreaks('a\nb\nc')).toBe(2)
    expect(countLineBreaks('a\nb\nc', 2, 4)).toBe(1)
    expect(countLineBreaks('a\nb\nc', 4, 5)).toBe(0)
  })

  it('creates original pieces with line-break metadata', () => {
    const buffers = createInitialBuffers('alpha\nbeta')
    const piece = createOriginalPiece(buffers)

    expect(getBufferText(buffers, buffers.original)).toBe('alpha\nbeta')
    expect(piece).toMatchObject({
      buffer: buffers.original,
      start: 0,
      length: 10,
      lineBreaks: 1,
      visible: true,
    })
  })

  it('creates sliced pieces and reads their backing buffer', () => {
    const buffers = createInitialBuffers('alpha\nbeta')
    const piece = createPiece(buffers, buffers.original, 6, 4, 20, false)

    expect(piece).toMatchObject({ start: 6, length: 4, lineBreaks: 0, visible: false })
    expect(bufferForPiece(buffers, piece)).toBe('alpha\nbeta')
  })

  it('splits appended text into bounded chunks', () => {
    const buffers = createInitialBuffers('')
    const text = 'x'.repeat(16 * 1024) + 'tail'
    const appended = appendChunksToBuffers(buffers, text)
    const pieces = appended.pieces

    expect(pieces).toHaveLength(2)
    expect(pieces.map((piece) => piece.length)).toEqual([16 * 1024, 4])
    expect(pieces.map((piece) => getBufferText(appended.buffers, piece.buffer))).toEqual([
      'x'.repeat(16 * 1024),
      'tail',
    ])
  })

  it('appends with copy-on-write buffer maps', () => {
    const buffers = createInitialBuffers('')
    const appended = appendChunksToBuffers(buffers, 'abc')
    const piece = appended.pieces[0]!

    expect(appended.buffers.chunks).not.toBe(buffers.chunks)
    expect(buffers.chunks.has(piece.buffer)).toBe(false)
    expect(getBufferText(appended.buffers, piece.buffer)).toBe('abc')
  })

  it('emits one chunk when the text ends exactly on a chunk boundary', () => {
    // The pull-back only applies to a split, and text of exactly one chunk has
    // none. Testing the boundary from the other side too: a CR or high surrogate
    // as the final unit of an exactly-full chunk must not be held back into a
    // second chunk of one orphaned code unit.
    const buffers = createInitialBuffers('')

    for (const tail of ['\r', '\ud834', 'z']) {
      const text = 'x'.repeat(BUFFER_CHUNK_SIZE - 1) + tail
      const appended = appendChunksToBuffers(buffers, text)
      const chunks = appended.pieces.map((piece) => getBufferText(appended.buffers, piece.buffer))

      expect(chunks).toEqual([text])
    }
  })

  it('never splits a surrogate pair across two chunks', () => {
    const buffers = createInitialBuffers('')
    // The pair straddles the natural boundary: its high half is the last unit
    // of chunk 0 unless the split point is pulled back.
    const text = `${'x'.repeat(BUFFER_CHUNK_SIZE - 1)}\u{1d11e}${'y'.repeat(10)}`
    const appended = appendChunksToBuffers(buffers, text)
    const chunks = appended.pieces.map((piece) => getBufferText(appended.buffers, piece.buffer))

    expect(chunks.join('')).toBe(text)
    expect(chunks[0]).toBe('x'.repeat(BUFFER_CHUNK_SIZE - 1))
    expect(chunks[1]).toBe(`\u{1d11e}${'y'.repeat(10)}`)
    for (const chunk of chunks) {
      const last = chunk.charCodeAt(chunk.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
    expect(appended.pieces.map((piece) => piece.length)).toEqual(
      chunks.map((chunk) => chunk.length),
    )
  })

  it('never splits a CRLF across two chunks', () => {
    const buffers = createInitialBuffers('')
    const text = `${'x'.repeat(BUFFER_CHUNK_SIZE - 1)}\r\n${'y'.repeat(10)}`
    const appended = appendChunksToBuffers(buffers, text)
    const chunks = appended.pieces.map((piece) => getBufferText(appended.buffers, piece.buffer))

    expect(chunks.join('')).toBe(text)
    expect(chunks.some((chunk) => chunk.endsWith('\r'))).toBe(false)
    expect(chunks[1]).toBe(`\r\n${'y'.repeat(10)}`)
    expect(appended.pieces.map((piece) => piece.lineBreaks)).toEqual([0, 1])
  })

  it('answers line-break queries from a grown typed-array index', () => {
    const lineCount = 5000
    const text = Array.from({ length: lineCount }, (_, line) => `line ${line}`).join('\n')
    const buffers = createInitialBuffers(text)
    const buffer = buffers.original

    for (let start = 0; start <= text.length; start += 97) {
      for (const candidate of [start, start + 1, start + 500, text.length]) {
        const end = Math.min(candidate, text.length)
        expect(countBufferLineBreaks(buffers, buffer, start, end)).toBe(
          countLineBreaks(text, start, end),
        )
      }

      for (const ordinal of [1, 2, 3, lineCount]) {
        expect(findBufferLineBreakOffset(buffers, buffer, start, ordinal)).toBe(
          nthLineBreakOffset(text, start, ordinal),
        )
      }
    }

    // Boundaries the sweep above steps over: the very first break, the very
    // last one, the ordinal one past it, and a start beyond every break.
    expect(findBufferLineBreakOffset(buffers, buffer, 0, 1)).toBe(text.indexOf('\n'))
    expect(findBufferLineBreakOffset(buffers, buffer, 0, lineCount - 1)).toBe(
      text.lastIndexOf('\n'),
    )
    expect(findBufferLineBreakOffset(buffers, buffer, 0, lineCount)).toBeNull()
    expect(findBufferLineBreakOffset(buffers, buffer, text.lastIndexOf('\n') + 1, 1)).toBeNull()
    expect(countBufferLineBreaks(buffers, buffer, 0, text.length)).toBe(lineCount - 1)
    expect(countBufferLineBreaks(buffers, buffer, text.lastIndexOf('\n') + 1, text.length)).toBe(0)

    const index = buffers.lineIndexes?.get(buffer)
    expect(index?.count).toBe(lineCount - 1)
    // The one representation fact worth pinning, because it is the whole point
    // of the index: four bytes per break, not the eight a boxed double costs.
    expect(index?.offsets.BYTES_PER_ELEMENT).toBe(4)
  })

  it('grows the line index while the tail chunk is extended in place', () => {
    const appended = appendChunksToBuffers(createInitialBuffers(''), 'a\n')
    let buffers = appended.buffers
    const buffer = appended.pieces[0]!.buffer
    let text = 'a\n'

    expect(countBufferLineBreaks(buffers, buffer, 0, text.length)).toBe(1)

    for (let round = 0; round < 200; round += 1) {
      const added = `line ${round}\n`
      buffers = extendTailChunk(buffers, added)
      text += added
      expect(countBufferLineBreaks(buffers, buffer, 0, text.length)).toBe(countLineBreaks(text))
    }

    for (const ordinal of [1, 2, 100, 201]) {
      expect(findBufferLineBreakOffset(buffers, buffer, 0, ordinal)).toBe(
        nthLineBreakOffset(text, 0, ordinal),
      )
    }
    expect(findBufferLineBreakOffset(buffers, buffer, 0, 202)).toBeNull()

    const index = buffers.lineIndexes?.get(buffer)
    expect(index?.count).toBe(201)
    expect(index?.scannedLength).toBe(text.length)
  })

  it('reallocates the line-break index a logarithmic number of times', () => {
    // Growing by one slot per break would satisfy every other assertion here
    // while turning the index build over a large file quadratic, so the growth
    // policy is pinned by counting how often the backing store is replaced.
    const pushes = 2000
    const appended = appendChunksToBuffers(createInitialBuffers(''), 'seed\n')
    let buffers = appended.buffers
    const buffer = appended.pieces[0]!.buffer
    let text = 'seed\n'
    let reallocations = 0
    let backing: Uint32Array | undefined

    const observeBacking = (): void => {
      const offsets = buffers.lineIndexes?.get(buffer)?.offsets
      if (offsets === backing) return

      reallocations += 1
      backing = offsets
    }

    countBufferLineBreaks(buffers, buffer, 0, text.length)
    observeBacking()

    for (let round = 0; round < pushes; round += 1) {
      const added = `line ${round}\n`
      buffers = extendTailChunk(buffers, added)
      text += added
      countBufferLineBreaks(buffers, buffer, 0, text.length)
      observeBacking()
    }

    expect(buffers.lineIndexes?.get(buffer)?.count).toBe(pushes + 1)
    expect(reallocations).toBeLessThanOrEqual(Math.ceil(Math.log2(pushes)) + 2)
  })
})

// Independent scan the indexed binary search is checked against.
const nthLineBreakOffset = (text: string, start: number, ordinal: number): number | null => {
  let at = text.indexOf('\n', start)
  let remaining = ordinal

  while (at !== -1 && remaining > 1) {
    at = text.indexOf('\n', at + 1)
    remaining -= 1
  }

  return at === -1 ? null : at
}
