import type { PieceTableSnapshot } from "../pieceTable";

export type PosttextLayoutMetrics = {
  charWidth: number;
  lineHeight: number;
  tabSize: number;
  fontKey: string;
};

export type PosttextXY = {
  x: number;
  y: number;
};

export type PosttextRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PosttextViewport = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type PosttextLineLayout = {
  row: number;
  startOffset: number;
  endOffset: number;
  text: string;
  y: number;
  height: number;
  width: number;
};

export type PosttextViewportLine = {
  row: number;
  startOffset: number;
  endOffset: number;
  visibleStartOffset: number;
  visibleEndOffset: number;
  rect: PosttextRect;
};

export type PosttextViewportResult = {
  viewport: PosttextViewport;
  lines: PosttextViewportLine[];
};

export type PosttextRangeBox = {
  row: number;
  startOffset: number;
  endOffset: number;
  rect: PosttextRect;
};

export type PosttextLayout = {
  snapshot: PieceTableSnapshot;
  metrics: PosttextLayoutMetrics;
  lines: readonly PosttextLineLayout[];
  width: number;
  height: number;
};
