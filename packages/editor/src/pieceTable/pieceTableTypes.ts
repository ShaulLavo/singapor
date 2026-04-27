declare const pieceBufferIdBrand: unique symbol;

export type PieceBufferId = string & {
  readonly [pieceBufferIdBrand]: true;
};

export type Point = {
  row: number;
  column: number;
};

export type AnchorBias = "left" | "right";

export type AnchorLiveness = "live" | "deleted";

export type RealAnchor = {
  kind: "anchor";
  buffer: PieceBufferId;
  offset: number;
  bias: AnchorBias;
};

export type SentinelAnchor = { kind: "min" } | { kind: "max" };

export type Anchor = RealAnchor | SentinelAnchor;

export type ResolvedAnchor = {
  offset: number;
  liveness: AnchorLiveness;
};

export type Piece = {
  buffer: PieceBufferId;
  start: number;
  length: number;
  order: number;
  lineBreaks: number;
  visible: boolean;
};

export type PieceTableBuffers = {
  original: PieceBufferId;
  chunks: ReadonlyMap<PieceBufferId, string>;
};

export type PieceTreeNode = {
  piece: Piece;
  left: PieceTreeNode | null;
  right: PieceTreeNode | null;
  priority: number;
  subtreeLength: number;
  subtreeVisibleLength: number;
  subtreePieces: number;
  subtreeLineBreaks: number;
  subtreeMinOrder: number;
  subtreeMaxOrder: number;
};

export type PieceTableReverseIndexNode = {
  buffer: PieceBufferId;
  start: number;
  piece: Piece;
  order: number;
  priority: number;
  left: PieceTableReverseIndexNode | null;
  right: PieceTableReverseIndexNode | null;
};

export type PieceTableTreeSnapshot = {
  buffers: PieceTableBuffers;
  root: PieceTreeNode | null;
  reverseIndexRoot: PieceTableReverseIndexNode | null;
  length: number;
  pieceCount: number;
};

export type PieceTableEdit = {
  from: number;
  to: number;
  text: string;
};

export type PieceTableSnapshot = PieceTableTreeSnapshot;
