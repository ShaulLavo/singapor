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

export type SentinelAnchor = { kind: 'min' } | { kind: 'max' }

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
  readonly original: PieceBufferId
  readonly chunks: PieceBufferChunks
  readonly nextBufferSequence: number
  readonly prioritySeed: number
  // Lazily built '\n' offset index per buffer, shared across snapshots via
  // spread copies. Buffers are append-only, so cached prefixes stay valid
  // for every historical snapshot; see bufferLineIndex in buffers.ts.
  readonly lineIndexes?: Map<PieceBufferId, PieceBufferLineIndex>
}

export type PieceBufferLineIndex = {
  offsets: number[]
  scannedLength: number
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
