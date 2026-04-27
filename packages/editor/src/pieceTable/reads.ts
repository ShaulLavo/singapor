import type { PieceTableTreeSnapshot } from "./pieceTableTypes";
import { getBufferText } from "./buffers";
import { collectTextInRange } from "./tree";

export const getPieceTableLength = (snapshot: PieceTableTreeSnapshot): number => snapshot.length;

export const getPieceTableOriginalText = (snapshot: PieceTableTreeSnapshot): string =>
  getBufferText(snapshot.buffers, snapshot.buffers.original);

export const ensureValidRange = (snapshot: PieceTableTreeSnapshot, start: number, end: number) => {
  if (start < 0 || end < start || end > snapshot.length) {
    throw new RangeError("invalid range");
  }
};

export const getPieceTableText = (
  snapshot: PieceTableTreeSnapshot,
  start = 0,
  end?: number,
): string => {
  const effectiveEnd = end ?? snapshot.length;
  ensureValidRange(snapshot, start, effectiveEnd);
  if (start === effectiveEnd) return "";

  const chunks: string[] = [];
  collectTextInRange(snapshot.root, snapshot.buffers, start, effectiveEnd, chunks);
  return chunks.join("");
};
