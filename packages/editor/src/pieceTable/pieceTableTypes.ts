import type { DocumentLineEnding } from './lineEndings'
import type { TextSourceIndex } from '../textMeasurements'

declare const pieceBufferIdBrand: unique symbol

export type PieceBufferId = string & {
  readonly [pieceBufferIdBrand]: true
}

export type Point = {
  readonly row: number
  readonly column: number
}

export type AnchorBias = 'left' | 'right'

export type AnchorLiveness = 'live' | 'deleted'

export type RealAnchor = {
  readonly kind: 'anchor'
  readonly buffer: PieceBufferId
  readonly offset: number
  readonly bias: AnchorBias
}

type SentinelAnchor = { kind: 'min' } | { kind: 'max' }

export type Anchor = RealAnchor | SentinelAnchor

export type ResolvedAnchor = {
  readonly offset: number
  readonly liveness: AnchorLiveness
}

export type Piece = {
  readonly buffer: PieceBufferId
  readonly start: number
  readonly length: number
  readonly order: number
  readonly lineBreaks: number
  readonly visible: boolean
}

export type PieceTableBuffers = {
  readonly textIndexes: Map<PieceBufferId, TextSourceIndex>
  readonly original: PieceBufferId
  readonly chunks: PieceBufferChunks
  readonly nextBufferSequence: number
  readonly prioritySeed: number
  // Stored text is always LF-only; these record what the document arrived with
  // so a host can round-trip it on save. See pieceTable/lineEndings.ts.
  readonly lineEnding: DocumentLineEnding
  readonly byteOrderMark: string
  // Ingestion folded U+2028/U+2029 into real line breaks, so the document is no
  // longer byte-identical to the one the host handed us. Recorded rather than
  // acted on: the fold is not reversible, and only the host can decide whether
  // a warning is owed. See pieceTable/lineEndings.ts.
  readonly containsUnusualLineTerminators: boolean
  // Lazily built '\n' offset index per buffer, shared across snapshots via
  // spread copies. Each entry records the text it scanned, because a buffer id
  // rolled back by undo can be re-minted for text a discarded branch never had;
  // see bufferLineIndex in buffers.ts.
  readonly lineIndexes?: Map<PieceBufferId, PieceBufferLineIndex>
}

export type PieceBufferLineIndex = {
  // Grown by doubling, so `offsets.length` is capacity and `count` is the only
  // safe bound to read or search within.
  offsets: Uint32Array
  count: number
  scannedLength: number
  // The exact chunk string these offsets were scanned from. A buffer id is a
  // sequence number and undo rolls that sequence back, so the id alone does not
  // identify text; this is what tells a re-minted id from a grown one.
  text: string
}

export type PieceBufferChunks = {
  readonly size: number
  get(buffer: PieceBufferId): string | undefined
  keys(): IterableIterator<PieceBufferId>
  [Symbol.iterator](): IterableIterator<[PieceBufferId, string]>
}

export type PieceTreeNode = {
  piece: Piece
  left: PieceTreeNode | null
  right: PieceTreeNode | null
  priority: number
  subtreeLength: number
  subtreeVisibleLength: number
  subtreePieces: number
  subtreeLineBreaks: number
  subtreeMinOrder: number
  subtreeMaxOrder: number
}

export type PieceTableReverseIndexNode = {
  buffer: PieceBufferId
  start: number
  piece: Piece
  order: number
  priority: number
  left: PieceTableReverseIndexNode | null
  right: PieceTableReverseIndexNode | null
}

export type PieceTableTreeSnapshot = {
  readonly buffers: PieceTableBuffers
  readonly root: PieceTreeNode | null
  readonly reverseIndexRoot: PieceTableReverseIndexNode | null
  readonly length: number
  readonly pieceCount: number
}

export type PieceTableEdit = {
  readonly from: number
  readonly to: number
  readonly text: string
}

export type PieceTableSnapshot = PieceTableTreeSnapshot
