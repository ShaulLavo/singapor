import type { PieceTableSnapshot } from '@singapor/core/document'
import { debugPieceTable, type PieceBufferId } from '@singapor/core/debug'

type TreeSitterSourcePieceSpan = {
  readonly chunkId: string
  readonly start: number
  readonly length: number
}

type TreeSitterSourceChunkPayload =
  | {
      readonly kind: 'shared-utf16'
      readonly chunkId: string
      readonly buffer: SharedArrayBuffer
      readonly length: number
    }
  | {
      readonly kind: 'string'
      readonly chunkId: string
      readonly text: string
    }

export type TreeSitterSourceDescriptor = {
  readonly length: number
  readonly pieces: readonly TreeSitterSourcePieceSpan[]
  readonly chunks: readonly TreeSitterSourceChunkPayload[]
}

export type TreeSitterSourceDescriptorOptions = {
  readonly sentChunkLengths?: ReadonlyMap<string, number>
  readonly useSharedBuffers?: boolean
}

type ResolvedTreeSitterSourceChunk = {
  readonly text: string
  readonly length: number
}

export type TreeSitterSourceCache = Map<string, Map<string, ResolvedTreeSitterSourceChunk>>

type TreeSitterInputChunk = {
  readonly start: number
  readonly end: number
  readonly chunkStart: number
  readonly source: ResolvedTreeSitterSourceChunk
}

export type TreeSitterPieceTableInput = {
  readonly length: number
  readonly chunks: readonly TreeSitterInputChunk[]
  lastChunkIndex?: number
}

const SOURCE_CHUNK_SIZE = 16 * 1024
// web-tree-sitter copies parser callback text into a fixed 10KB UTF-16 buffer.
const PARSER_READ_BATCH_CODE_UNITS = 4096
const UTF16_READ_BATCH = 8192

export const createTreeSitterSourceDescriptor = (
  snapshot: PieceTableSnapshot,
  options: TreeSitterSourceDescriptorOptions = {},
): TreeSitterSourceDescriptor => {
  const pieces: TreeSitterSourcePieceSpan[] = []
  const chunks: TreeSitterSourceChunkPayload[] = []
  const emittedChunkIds = new Set<string>()
  const useSharedBuffers = options.useSharedBuffers ?? supportsSharedTreeSitterSource()

  for (const piece of debugPieceTable(snapshot)) {
    if (!piece.visible) continue
    appendPieceSpans(snapshot, piece.buffer, piece.start, piece.length, {
      pieces,
      chunks,
      emittedChunkIds,
      sentChunkLengths: options.sentChunkLengths,
      useSharedBuffers,
    })
  }

  return {
    length: snapshot.length,
    pieces,
    chunks,
  }
}

export const resolveTreeSitterSourceDescriptor = (
  cache: TreeSitterSourceCache,
  documentId: string,
  descriptor: TreeSitterSourceDescriptor,
): TreeSitterPieceTableInput => {
  const chunks = resolveDescriptorChunks(ensureDocumentSourceCache(cache, documentId), descriptor)
  return {
    length: descriptor.length,
    chunks,
  }
}

export const disposeTreeSitterSourceDocument = (
  cache: TreeSitterSourceCache,
  documentId: string,
): void => {
  cache.delete(documentId)
}

export const clearTreeSitterSourceCache = (cache: TreeSitterSourceCache): void => {
  cache.clear()
}

export const readTreeSitterPieceTableInput = (
  input: TreeSitterPieceTableInput,
  index: number,
): string | undefined => {
  if (index < 0 || index >= input.length) return undefined

  const chunk = findChunkContainingWithCursor(input, index)
  if (!chunk) return undefined

  const sourceStart = chunk.chunkStart + index - chunk.start
  const sourceEnd = chunk.chunkStart + chunk.end - chunk.start
  const readEnd = safeParserReadEnd(
    chunk.source,
    sourceStart,
    Math.min(sourceEnd, sourceStart + PARSER_READ_BATCH_CODE_UNITS),
    sourceEnd,
  )
  return readResolvedChunkText(chunk.source, sourceStart, readEnd)
}

export const readTreeSitterInputRange = (
  input: TreeSitterPieceTableInput,
  startIndex: number,
  endIndex: number,
): string => {
  if (endIndex <= startIndex) return ''

  const chunks: string[] = []
  for (const chunk of input.chunks) {
    if (chunk.end <= startIndex) continue
    if (chunk.start >= endIndex) break

    const start = Math.max(startIndex, chunk.start) - chunk.start
    const end = Math.min(endIndex, chunk.end) - chunk.start
    chunks.push(
      readResolvedChunkText(chunk.source, chunk.chunkStart + start, chunk.chunkStart + end),
    )
  }

  return chunks.join('')
}

type PieceSpanBuilder = {
  readonly pieces: TreeSitterSourcePieceSpan[]
  readonly chunks: TreeSitterSourceChunkPayload[]
  readonly emittedChunkIds: Set<string>
  readonly sentChunkLengths?: ReadonlyMap<string, number>
  readonly useSharedBuffers: boolean
}

const appendPieceSpans = (
  snapshot: PieceTableSnapshot,
  bufferId: PieceBufferId,
  start: number,
  length: number,
  builder: PieceSpanBuilder,
): void => {
  const text = getSnapshotBufferText(snapshot, bufferId)
  let offset = start
  let remaining = length

  while (remaining > 0) {
    const chunkStart = Math.floor(offset / SOURCE_CHUNK_SIZE) * SOURCE_CHUNK_SIZE
    const chunkLength = Math.min(text.length - chunkStart, SOURCE_CHUNK_SIZE)
    const spanStart = offset - chunkStart
    const spanLength = Math.min(remaining, chunkLength - spanStart)
    const chunkId = sourceChunkId(bufferId, chunkStart)

    builder.pieces.push({ chunkId, start: spanStart, length: spanLength })
    appendChunkPayload(text, chunkId, chunkStart, chunkLength, builder)
    offset += spanLength
    remaining -= spanLength
  }
}

const appendChunkPayload = (
  text: string,
  chunkId: string,
  chunkStart: number,
  chunkLength: number,
  builder: PieceSpanBuilder,
): void => {
  // Piece buffers are append-only but their tail chunk grows in place, so a
  // previously sent chunk id only stays valid while its length is unchanged.
  if (builder.sentChunkLengths?.get(chunkId) === chunkLength) return
  if (builder.emittedChunkIds.has(chunkId)) return

  const chunkText = text.slice(chunkStart, chunkStart + chunkLength)
  builder.emittedChunkIds.add(chunkId)
  builder.chunks.push(createChunkPayload(chunkId, chunkText, builder.useSharedBuffers))
}

const createChunkPayload = (
  chunkId: string,
  text: string,
  useSharedBuffers: boolean,
): TreeSitterSourceChunkPayload => {
  if (!useSharedBuffers) return { kind: 'string', chunkId, text }
  return {
    kind: 'shared-utf16',
    chunkId,
    buffer: createSharedUtf16Buffer(text),
    length: text.length,
  }
}

const createSharedUtf16Buffer = (text: string): SharedArrayBuffer => {
  const buffer = new SharedArrayBuffer(text.length * Uint16Array.BYTES_PER_ELEMENT)
  const units = new Uint16Array(buffer)
  for (let index = 0; index < text.length; index++) units[index] = text.charCodeAt(index)
  return buffer
}

const sourceChunkId = (bufferId: string, chunkStart: number): string => `${bufferId}:${chunkStart}`

const getSnapshotBufferText = (snapshot: PieceTableSnapshot, bufferId: PieceBufferId): string => {
  const text = snapshot.buffers.chunks.get(bufferId)
  if (text !== undefined) return text
  throw new Error('piece buffer not found')
}

const supportsSharedTreeSitterSource = (): boolean => {
  if (typeof SharedArrayBuffer === 'undefined') return false
  return Boolean((globalThis as { readonly crossOriginIsolated?: boolean }).crossOriginIsolated)
}

const ensureDocumentSourceCache = (
  cache: TreeSitterSourceCache,
  documentId: string,
): Map<string, ResolvedTreeSitterSourceChunk> => {
  const existing = cache.get(documentId)
  if (existing) return existing

  const documentCache = new Map<string, ResolvedTreeSitterSourceChunk>()
  cache.set(documentId, documentCache)
  return documentCache
}

const resolveDescriptorChunks = (
  cache: Map<string, ResolvedTreeSitterSourceChunk>,
  descriptor: TreeSitterSourceDescriptor,
): TreeSitterInputChunk[] => {
  cacheChunkPayloads(cache, descriptor.chunks)

  const chunks: TreeSitterInputChunk[] = []
  let documentOffset = 0
  for (const piece of descriptor.pieces) {
    const source = cache.get(piece.chunkId)
    if (!source) throw new Error(`Tree-sitter source chunk "${piece.chunkId}" is missing`)

    chunks.push({
      start: documentOffset,
      end: documentOffset + piece.length,
      chunkStart: piece.start,
      source,
    })
    documentOffset += piece.length
  }

  if (documentOffset !== descriptor.length) throw new Error('Tree-sitter source length mismatch')
  return chunks
}

const cacheChunkPayloads = (
  cache: Map<string, ResolvedTreeSitterSourceChunk>,
  chunks: readonly TreeSitterSourceChunkPayload[],
): void => {
  for (const chunk of chunks) cache.set(chunk.chunkId, resolveChunkPayload(chunk))
}

/**
 * Shared chunks decode once, here. The parser reads a chunk hundreds of times
 * in ≤4096-unit slices, and decoding per read cost ~18x the whole parse; the
 * buffer is filled once and never mutated, so one decode is safe. The
 * SharedArrayBuffer still earns its keep by keeping the copy off the main
 * thread at postMessage time.
 */
const resolveChunkPayload = (
  chunk: TreeSitterSourceChunkPayload,
): ResolvedTreeSitterSourceChunk => {
  if (chunk.kind === 'string') return { text: chunk.text, length: chunk.text.length }

  const units = new Uint16Array(chunk.buffer, 0, chunk.length)
  return { text: readUtf16Text(units, 0, chunk.length), length: chunk.length }
}

const readResolvedChunkText = (
  chunk: ResolvedTreeSitterSourceChunk,
  start: number,
  end: number,
): string => chunk.text.slice(start, end)

const safeParserReadEnd = (
  chunk: ResolvedTreeSitterSourceChunk,
  start: number,
  end: number,
  maxEnd: number,
): number => {
  if (end >= maxEnd || end <= start) return end

  const lastCodeUnit = readResolvedChunkCodeUnit(chunk, end - 1)
  if (!isHighSurrogate(lastCodeUnit)) return end
  return Math.max(start + 1, end - 1)
}

const readResolvedChunkCodeUnit = (chunk: ResolvedTreeSitterSourceChunk, index: number): number =>
  chunk.text.charCodeAt(index)

const isHighSurrogate = (codeUnit: number): boolean => codeUnit >= 0xd800 && codeUnit <= 0xdbff

// Uint16Array is host-endian; the decoder is not. Every browser target is
// little-endian, but check rather than assume — a wrong decode is silent.
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
const utf16Decoder =
  HOST_IS_LITTLE_ENDIAN && typeof TextDecoder !== 'undefined'
    ? new TextDecoder('utf-16le')
    : null

const readUtf16Text = (units: Uint16Array, start: number, end: number): string => {
  if (!utf16Decoder) return readUtf16TextExact(units, start, end)

  // `slice`, not a subview: Chrome refuses to decode a shared view, and slicing
  // yields an unshared copy. The copy is free next to the decode (~5x the
  // fromCharCode loop, which spreads thousands of arguments per call).
  const copy = units.slice(start, end)
  const decoded = utf16Decoder.decode(
    new Uint8Array(copy.buffer, copy.byteOffset, copy.byteLength),
  )

  // TextDecoder rewrites an unpaired surrogate to U+FFFD, and chunks split on a
  // fixed 16KB grid, so any pair straddling a boundary would corrupt silently.
  // Pay for the exact path only when a replacement char is actually present.
  if (!decoded.includes('�')) return decoded
  return readUtf16TextExact(units, start, end)
}

const readUtf16TextExact = (units: Uint16Array, start: number, end: number): string => {
  let text = ''
  for (let index = start; index < end; index += UTF16_READ_BATCH) {
    text += String.fromCharCode(...units.subarray(index, Math.min(index + UTF16_READ_BATCH, end)))
  }

  return text
}

const findChunkContaining = (
  chunks: readonly TreeSitterInputChunk[],
  index: number,
): TreeSitterInputChunk | null => {
  let low = 0
  let high = chunks.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const chunk = chunks[middle]
    if (!chunk) return null

    if (index < chunk.start) {
      high = middle - 1
      continue
    }

    if (index >= chunk.end) {
      low = middle + 1
      continue
    }

    return chunk
  }

  return null
}

const findChunkContainingWithCursor = (
  input: TreeSitterPieceTableInput,
  index: number,
): TreeSitterInputChunk | null => {
  const cachedIndex = input.lastChunkIndex
  const cached = cachedIndex === undefined ? null : input.chunks[cachedIndex]
  if (cached && index >= cached.start && index < cached.end) return cached

  if (cachedIndex !== undefined) {
    const next = input.chunks[cachedIndex + 1]
    if (next && index >= next.start && index < next.end) {
      input.lastChunkIndex = cachedIndex + 1
      return next
    }
  }

  const chunk = findChunkContaining(input.chunks, index)
  if (chunk) input.lastChunkIndex = input.chunks.indexOf(chunk)
  return chunk
}
