import type { Piece, PieceBufferId, PieceTableBuffers } from "./pieceTableTypes";
import { PIECE_ORDER_STEP } from "./orders";

const BUFFER_CHUNK_SIZE = 16 * 1024;
let nextBufferSequence = 0;

export const createBufferId = (): PieceBufferId =>
  ("buffer:" + nextBufferSequence++) as PieceBufferId;

export const countLineBreaks = (text: string, start = 0, end = text.length): number => {
  let count = 0;
  let index = text.indexOf("\n", start);

  while (index !== -1 && index < end) {
    count++;
    index = text.indexOf("\n", index + 1);
  }

  return count;
};

export const getBufferText = (buffers: PieceTableBuffers, buffer: PieceBufferId): string => {
  const text = buffers.chunks.get(buffer);
  if (text !== undefined) return text;
  throw new Error("piece buffer not found");
};

export const createPiece = (
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  start: number,
  length: number,
  order: number,
  visible = true,
): Piece => {
  const text = getBufferText(buffers, buffer);
  return {
    buffer,
    start,
    length,
    order,
    lineBreaks: countLineBreaks(text, start, start + length),
    visible,
  };
};

export const bufferForPiece = (buffers: PieceTableBuffers, piece: Piece): string =>
  getBufferText(buffers, piece.buffer);

export const appendChunksToBuffers = (buffers: PieceTableBuffers, text: string): Piece[] => {
  const chunks = buffers.chunks as Map<PieceBufferId, string>;
  const pieces: Piece[] = [];
  let textOffset = 0;

  while (textOffset < text.length) {
    const chunkText = text.slice(textOffset, textOffset + BUFFER_CHUNK_SIZE);
    const buffer = createBufferId();
    chunks.set(buffer, chunkText);
    pieces.push({
      buffer,
      start: 0,
      length: chunkText.length,
      order: 0,
      lineBreaks: countLineBreaks(chunkText),
      visible: true,
    });
    textOffset += chunkText.length;
  }

  return pieces;
};

export const createInitialBuffers = (original: string): PieceTableBuffers => {
  const originalBuffer = createBufferId();
  const chunks = new Map<PieceBufferId, string>([[originalBuffer, original]]);
  return {
    original: originalBuffer,
    chunks,
  };
};

export const createOriginalPiece = (buffers: PieceTableBuffers): Piece | null => {
  const original = getBufferText(buffers, buffers.original);
  if (original.length === 0) return null;

  return {
    buffer: buffers.original,
    start: 0,
    length: original.length,
    order: PIECE_ORDER_STEP,
    lineBreaks: countLineBreaks(original),
    visible: true,
  };
};
