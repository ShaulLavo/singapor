import { debugPieceTable, type PieceBufferId, type PieceTableSnapshot } from "@editor/core";

export type TreeSitterSourcePieceSpan = {
  readonly chunkId: string;
  readonly start: number;
  readonly length: number;
};

export type TreeSitterSourceChunkPayload =
  | {
      readonly kind: "shared-utf16";
      readonly chunkId: string;
      readonly buffer: SharedArrayBuffer;
      readonly length: number;
    }
  | {
      readonly kind: "string";
      readonly chunkId: string;
      readonly text: string;
    };

export type TreeSitterSourceDescriptor = {
  readonly length: number;
  readonly pieces: readonly TreeSitterSourcePieceSpan[];
  readonly chunks: readonly TreeSitterSourceChunkPayload[];
};

export type TreeSitterSourceDescriptorOptions = {
  readonly sentChunkIds?: ReadonlySet<string>;
  readonly useSharedBuffers?: boolean;
};

type ResolvedTreeSitterSourceChunk =
  | {
      readonly kind: "shared-utf16";
      readonly units: Uint16Array;
      readonly length: number;
    }
  | {
      readonly kind: "string";
      readonly text: string;
      readonly length: number;
    };

export type TreeSitterSourceCache = Map<string, Map<string, ResolvedTreeSitterSourceChunk>>;

export type TreeSitterInputChunk = {
  readonly start: number;
  readonly end: number;
  readonly chunkStart: number;
  readonly source: ResolvedTreeSitterSourceChunk;
};

export type TreeSitterPieceTableInput = {
  readonly length: number;
  readonly chunks: readonly TreeSitterInputChunk[];
};

const SOURCE_CHUNK_SIZE = 16 * 1024;
const UTF16_READ_BATCH = 8192;

export const createTreeSitterSourceDescriptor = (
  snapshot: PieceTableSnapshot,
  options: TreeSitterSourceDescriptorOptions = {},
): TreeSitterSourceDescriptor => {
  const pieces: TreeSitterSourcePieceSpan[] = [];
  const chunks: TreeSitterSourceChunkPayload[] = [];
  const emittedChunkIds = new Set<string>();
  const useSharedBuffers = options.useSharedBuffers ?? supportsSharedTreeSitterSource();

  for (const piece of debugPieceTable(snapshot)) {
    if (!piece.visible) continue;
    appendPieceSpans(snapshot, piece.buffer, piece.start, piece.length, {
      pieces,
      chunks,
      emittedChunkIds,
      sentChunkIds: options.sentChunkIds,
      useSharedBuffers,
    });
  }

  return {
    length: snapshot.length,
    pieces,
    chunks,
  };
};

export const resolveTreeSitterSourceDescriptor = (
  cache: TreeSitterSourceCache,
  documentId: string,
  descriptor: TreeSitterSourceDescriptor,
): TreeSitterPieceTableInput => {
  const chunks = resolveDescriptorChunks(ensureDocumentSourceCache(cache, documentId), descriptor);
  return {
    length: descriptor.length,
    chunks,
  };
};

export const disposeTreeSitterSourceDocument = (
  cache: TreeSitterSourceCache,
  documentId: string,
): void => {
  cache.delete(documentId);
};

export const clearTreeSitterSourceCache = (cache: TreeSitterSourceCache): void => {
  cache.clear();
};

export const readTreeSitterPieceTableInput = (
  input: TreeSitterPieceTableInput,
  index: number,
): string | undefined => {
  if (index < 0 || index >= input.length) return undefined;

  const chunk = findChunkContaining(input.chunks, index);
  if (!chunk) return undefined;

  const sourceStart = chunk.chunkStart + index - chunk.start;
  return readResolvedChunkText(chunk.source, sourceStart, chunk.source.length);
};

export const readTreeSitterInputRange = (
  input: TreeSitterPieceTableInput,
  startIndex: number,
  endIndex: number,
): string => {
  if (endIndex <= startIndex) return "";

  const chunks: string[] = [];
  for (const chunk of input.chunks) {
    if (chunk.end <= startIndex) continue;
    if (chunk.start >= endIndex) break;

    const start = Math.max(startIndex, chunk.start) - chunk.start;
    const end = Math.min(endIndex, chunk.end) - chunk.start;
    chunks.push(
      readResolvedChunkText(chunk.source, chunk.chunkStart + start, chunk.chunkStart + end),
    );
  }

  return chunks.join("");
};

type PieceSpanBuilder = {
  readonly pieces: TreeSitterSourcePieceSpan[];
  readonly chunks: TreeSitterSourceChunkPayload[];
  readonly emittedChunkIds: Set<string>;
  readonly sentChunkIds?: ReadonlySet<string>;
  readonly useSharedBuffers: boolean;
};

const appendPieceSpans = (
  snapshot: PieceTableSnapshot,
  bufferId: PieceBufferId,
  start: number,
  length: number,
  builder: PieceSpanBuilder,
): void => {
  const text = getSnapshotBufferText(snapshot, bufferId);
  let offset = start;
  let remaining = length;

  while (remaining > 0) {
    const chunkStart = Math.floor(offset / SOURCE_CHUNK_SIZE) * SOURCE_CHUNK_SIZE;
    const chunkLength = Math.min(text.length - chunkStart, SOURCE_CHUNK_SIZE);
    const spanStart = offset - chunkStart;
    const spanLength = Math.min(remaining, chunkLength - spanStart);
    const chunkId = sourceChunkId(bufferId, chunkStart);

    builder.pieces.push({ chunkId, start: spanStart, length: spanLength });
    appendChunkPayload(text, chunkId, chunkStart, chunkLength, builder);
    offset += spanLength;
    remaining -= spanLength;
  }
};

const appendChunkPayload = (
  text: string,
  chunkId: string,
  chunkStart: number,
  chunkLength: number,
  builder: PieceSpanBuilder,
): void => {
  if (builder.sentChunkIds?.has(chunkId)) return;
  if (builder.emittedChunkIds.has(chunkId)) return;

  const chunkText = text.slice(chunkStart, chunkStart + chunkLength);
  builder.emittedChunkIds.add(chunkId);
  builder.chunks.push(createChunkPayload(chunkId, chunkText, builder.useSharedBuffers));
};

const createChunkPayload = (
  chunkId: string,
  text: string,
  useSharedBuffers: boolean,
): TreeSitterSourceChunkPayload => {
  if (!useSharedBuffers) return { kind: "string", chunkId, text };
  return {
    kind: "shared-utf16",
    chunkId,
    buffer: createSharedUtf16Buffer(text),
    length: text.length,
  };
};

const createSharedUtf16Buffer = (text: string): SharedArrayBuffer => {
  const buffer = new SharedArrayBuffer(text.length * Uint16Array.BYTES_PER_ELEMENT);
  const units = new Uint16Array(buffer);
  for (let index = 0; index < text.length; index++) units[index] = text.charCodeAt(index);
  return buffer;
};

const sourceChunkId = (bufferId: string, chunkStart: number): string => `${bufferId}:${chunkStart}`;

const getSnapshotBufferText = (snapshot: PieceTableSnapshot, bufferId: PieceBufferId): string => {
  const text = snapshot.buffers.chunks.get(bufferId);
  if (text !== undefined) return text;
  throw new Error("piece buffer not found");
};

const supportsSharedTreeSitterSource = (): boolean => {
  if (typeof SharedArrayBuffer === "undefined") return false;
  return Boolean((globalThis as { readonly crossOriginIsolated?: boolean }).crossOriginIsolated);
};

const ensureDocumentSourceCache = (
  cache: TreeSitterSourceCache,
  documentId: string,
): Map<string, ResolvedTreeSitterSourceChunk> => {
  const existing = cache.get(documentId);
  if (existing) return existing;

  const documentCache = new Map<string, ResolvedTreeSitterSourceChunk>();
  cache.set(documentId, documentCache);
  return documentCache;
};

const resolveDescriptorChunks = (
  cache: Map<string, ResolvedTreeSitterSourceChunk>,
  descriptor: TreeSitterSourceDescriptor,
): TreeSitterInputChunk[] => {
  cacheChunkPayloads(cache, descriptor.chunks);

  const chunks: TreeSitterInputChunk[] = [];
  let documentOffset = 0;
  for (const piece of descriptor.pieces) {
    const source = cache.get(piece.chunkId);
    if (!source) throw new Error(`Tree-sitter source chunk "${piece.chunkId}" is missing`);

    chunks.push({
      start: documentOffset,
      end: documentOffset + piece.length,
      chunkStart: piece.start,
      source,
    });
    documentOffset += piece.length;
  }

  if (documentOffset !== descriptor.length) throw new Error("Tree-sitter source length mismatch");
  return chunks;
};

const cacheChunkPayloads = (
  cache: Map<string, ResolvedTreeSitterSourceChunk>,
  chunks: readonly TreeSitterSourceChunkPayload[],
): void => {
  for (const chunk of chunks) cache.set(chunk.chunkId, resolveChunkPayload(chunk));
};

const resolveChunkPayload = (
  chunk: TreeSitterSourceChunkPayload,
): ResolvedTreeSitterSourceChunk => {
  if (chunk.kind === "string") {
    return { kind: "string", text: chunk.text, length: chunk.text.length };
  }

  const units = new Uint16Array(chunk.buffer, 0, chunk.length);
  return { kind: "shared-utf16", units, length: chunk.length };
};

const readResolvedChunkText = (
  chunk: ResolvedTreeSitterSourceChunk,
  start: number,
  end: number,
): string => {
  if (chunk.kind === "string") return chunk.text.slice(start, end);
  return readUtf16Text(chunk.units, start, end);
};

const readUtf16Text = (units: Uint16Array, start: number, end: number): string => {
  let text = "";
  for (let index = start; index < end; index += UTF16_READ_BATCH) {
    text += String.fromCharCode(...units.subarray(index, Math.min(index + UTF16_READ_BATCH, end)));
  }

  return text;
};

const findChunkContaining = (
  chunks: readonly TreeSitterInputChunk[],
  index: number,
): TreeSitterInputChunk | null => {
  let low = 0;
  let high = chunks.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const chunk = chunks[middle];
    if (!chunk) return null;

    if (index < chunk.start) {
      high = middle - 1;
      continue;
    }

    if (index >= chunk.end) {
      low = middle + 1;
      continue;
    }

    return chunk;
  }

  return null;
};
