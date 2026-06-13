import type {
  Piece,
  PieceBufferChunks,
  PieceBufferId,
  PieceBufferLineIndex,
  PieceTableBuffers,
} from './pieceTableTypes'
import { PIECE_ORDER_STEP } from './orders'
import { DEFAULT_PIECE_TABLE_PRIORITY_SEED } from './priority'

export const BUFFER_CHUNK_SIZE = 16 * 1024
const BUFFER_ID_PREFIX = 'buffer:'
const BUFFER_STORE_PAGE_SIZE = 1024

class PieceBufferChunkStore implements PieceBufferChunks {
  public readonly [Symbol.toStringTag] = 'PieceBufferChunkStore'

  public constructor(
    private readonly pages: readonly (readonly string[])[],
    public readonly size: number,
  ) {}

  public static from(chunks: readonly string[]): PieceBufferChunkStore {
    return new PieceBufferChunkStore([chunks], chunks.length)
  }

  public get(buffer: PieceBufferId): string | undefined {
    const sequence = bufferSequence(buffer)
    if (sequence === null) return undefined

    const page = this.pages[Math.floor(sequence / BUFFER_STORE_PAGE_SIZE)]
    return page?.[sequence % BUFFER_STORE_PAGE_SIZE]
  }

  public has(buffer: PieceBufferId): boolean {
    return this.get(buffer) !== undefined
  }

  public forEach(
    callback: (value: string, key: PieceBufferId, map: PieceBufferChunks) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) {
      callback.call(thisArg, value, key, this)
    }
  }

  public *entries(): IterableIterator<[PieceBufferId, string]> {
    let sequence = 0

    for (const page of this.pages) {
      for (const text of page) {
        yield [createBufferId(sequence), text]
        sequence += 1
      }
    }
  }

  public *keys(): IterableIterator<PieceBufferId> {
    for (const [key] of this.entries()) yield key
  }

  public *values(): IterableIterator<string> {
    for (const [, value] of this.entries()) yield value
  }

  public [Symbol.iterator](): IterableIterator<[PieceBufferId, string]> {
    return this.entries()
  }

  public append(chunks: readonly string[]): PieceBufferChunkStore {
    if (chunks.length === 0) return this

    const nextPages = [...this.pages]
    let tail = nextPages.pop()?.slice() ?? []

    for (const chunk of chunks) {
      if (tail.length === BUFFER_STORE_PAGE_SIZE) {
        nextPages.push(tail)
        tail = []
      }

      tail.push(chunk)
    }

    if (tail.length > 0) nextPages.push(tail)
    return new PieceBufferChunkStore(nextPages, this.size + chunks.length)
  }

  public extendTail(text: string): PieceBufferChunkStore {
    if (text.length === 0) return this
    if (this.size === 0) throw new Error('piece buffer tail not found')

    const nextPages = [...this.pages]
    const pageIndex = nextPages.length - 1
    const tail = nextPages[pageIndex]?.slice()
    if (!tail || tail.length === 0) throw new Error('piece buffer tail not found')

    const chunkIndex = tail.length - 1
    tail[chunkIndex] = `${tail[chunkIndex] ?? ''}${text}`
    nextPages[pageIndex] = tail
    return new PieceBufferChunkStore(nextPages, this.size)
  }
}

export type PieceTableBufferOptions = {
  readonly prioritySeed?: number
}

export type AppendChunksToBuffersResult = {
  readonly buffers: PieceTableBuffers
  readonly pieces: readonly Piece[]
}

const createBufferId = (sequence: number): PieceBufferId =>
  `${BUFFER_ID_PREFIX}${sequence}` as PieceBufferId

const bufferSequence = (buffer: PieceBufferId): number | null => {
  if (!buffer.startsWith(BUFFER_ID_PREFIX)) return null

  const sequence = Number(buffer.slice(BUFFER_ID_PREFIX.length))
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null
  return sequence
}

export const isNewestChunk = (buffers: PieceTableBuffers, buffer: PieceBufferId): boolean => {
  const sequence = bufferSequence(buffer)
  return sequence !== null && sequence === buffers.nextBufferSequence - 1
}

export const countLineBreaks = (text: string, start = 0, end = text.length): number => {
  let count = 0
  let index = text.indexOf('\n', start)

  while (index !== -1 && index < end) {
    count++
    index = text.indexOf('\n', index + 1)
  }

  return count
}

// Buffers are append-only: existing text never changes, the tail chunk only
// grows. One lazily extended '\n' offset index per buffer therefore serves
// every snapshot that references the buffer, including undo history, and
// turns per-piece line-break scans from O(piece bytes) into O(log breaks).
const bufferLineIndex = (
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  text: string,
): PieceBufferLineIndex => {
  const holder = buffers as PieceTableBuffers & {
    lineIndexes?: Map<PieceBufferId, PieceBufferLineIndex>
  }
  holder.lineIndexes ??= new Map()

  let index = holder.lineIndexes.get(buffer)
  if (!index) {
    index = { offsets: [], scannedLength: 0 }
    holder.lineIndexes.set(buffer, index)
  }
  if (index.scannedLength < text.length) extendBufferLineIndex(index, text)

  return index
}

const extendBufferLineIndex = (index: PieceBufferLineIndex, text: string): void => {
  let at = text.indexOf('\n', index.scannedLength)
  while (at !== -1) {
    index.offsets.push(at)
    at = text.indexOf('\n', at + 1)
  }

  index.scannedLength = text.length
}

const firstLineBreakAtOrAfter = (offsets: readonly number[], target: number): number => {
  let low = 0
  let high = offsets.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (offsets[middle]! < target) low = middle + 1
    else high = middle
  }

  return low
}

export const countBufferLineBreaks = (
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  start: number,
  end: number,
): number => {
  if (end <= start) return 0

  const text = getBufferText(buffers, buffer)
  const offsets = bufferLineIndex(buffers, buffer, text).offsets
  return firstLineBreakAtOrAfter(offsets, end) - firstLineBreakAtOrAfter(offsets, start)
}

// Absolute buffer offset of the ordinal-th (1-based) '\n' at or after start.
export const findBufferLineBreakOffset = (
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  start: number,
  ordinal: number,
): number | null => {
  const text = getBufferText(buffers, buffer)
  const offsets = bufferLineIndex(buffers, buffer, text).offsets
  const at = firstLineBreakAtOrAfter(offsets, start) + ordinal - 1
  if (at >= offsets.length) return null

  return offsets[at]!
}

export const getBufferText = (buffers: PieceTableBuffers, buffer: PieceBufferId): string => {
  const text = buffers.chunks.get(buffer)
  if (text !== undefined) return text
  throw new Error('piece buffer not found')
}

export const createPiece = (
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  start: number,
  length: number,
  order: number,
  visible = true,
): Piece => {
  return {
    buffer,
    start,
    length,
    order,
    lineBreaks: countBufferLineBreaks(buffers, buffer, start, start + length),
    visible,
  }
}

export const bufferForPiece = (buffers: PieceTableBuffers, piece: Piece): string =>
  getBufferText(buffers, piece.buffer)

export const appendChunksToBuffers = (
  buffers: PieceTableBuffers,
  text: string,
): AppendChunksToBuffersResult => {
  const chunkTexts: string[] = []
  const pieces: Piece[] = []
  let nextBufferSequence = buffers.nextBufferSequence
  let textOffset = 0

  while (textOffset < text.length) {
    const chunkText = text.slice(textOffset, textOffset + BUFFER_CHUNK_SIZE)
    const buffer = createBufferId(nextBufferSequence)
    nextBufferSequence += 1
    chunkTexts.push(chunkText)
    pieces.push({
      buffer,
      start: 0,
      length: chunkText.length,
      order: 0,
      lineBreaks: countLineBreaks(chunkText),
      visible: true,
    })
    textOffset += chunkText.length
  }

  return {
    buffers: {
      ...buffers,
      chunks: appendChunkTexts(buffers.chunks, chunkTexts),
      nextBufferSequence,
    },
    pieces,
  }
}

export const extendTailChunk = (buffers: PieceTableBuffers, text: string): PieceTableBuffers => {
  if (text.length === 0) return buffers

  const tailBuffer = createBufferId(buffers.nextBufferSequence - 1)
  if (buffers.chunks.get(tailBuffer) === undefined) throw new Error('piece buffer tail not found')

  return {
    ...buffers,
    chunks: extendTailChunkText(buffers.chunks, tailBuffer, text),
  }
}

const appendChunkTexts = (
  chunks: PieceBufferChunks,
  chunkTexts: readonly string[],
): PieceBufferChunks => {
  if (chunks instanceof PieceBufferChunkStore) return chunks.append(chunkTexts)

  const next = new Map(chunks)
  let sequence = chunks.size
  for (const chunkText of chunkTexts) {
    next.set(createBufferId(sequence), chunkText)
    sequence += 1
  }
  return next
}

const extendTailChunkText = (
  chunks: PieceBufferChunks,
  tailBuffer: PieceBufferId,
  text: string,
): PieceBufferChunks => {
  if (chunks instanceof PieceBufferChunkStore) return chunks.extendTail(text)

  const next = new Map(chunks)
  const previous = next.get(tailBuffer)
  if (previous === undefined) throw new Error('piece buffer tail not found')
  next.set(tailBuffer, previous + text)
  return next
}

export const createInitialBuffers = (
  original: string,
  options: PieceTableBufferOptions = {},
): PieceTableBuffers => {
  const originalBuffer = createBufferId(0)
  const chunks = PieceBufferChunkStore.from([original])
  return {
    original: originalBuffer,
    chunks,
    nextBufferSequence: 1,
    prioritySeed: options.prioritySeed ?? DEFAULT_PIECE_TABLE_PRIORITY_SEED,
  }
}

export const createOriginalPiece = (buffers: PieceTableBuffers): Piece | null => {
  const original = getBufferText(buffers, buffers.original)
  if (original.length === 0) return null

  return {
    buffer: buffers.original,
    start: 0,
    length: original.length,
    order: PIECE_ORDER_STEP,
    lineBreaks: countLineBreaks(original),
    visible: true,
  }
}
