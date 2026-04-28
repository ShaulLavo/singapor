const WORD_PATTERN = /^[\p{L}\p{N}_]$/u;

type CharacterClass = "word" | "space" | "punctuation";

export function previousCodePointOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;

  const previous = offset - 1;
  const codeUnit = text.charCodeAt(previous);
  const beforePrevious = previous - 1;
  const lowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
  if (!lowSurrogate || beforePrevious < 0) return previous;

  const previousCodeUnit = text.charCodeAt(beforePrevious);
  const highSurrogate = previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff;
  return highSurrogate ? beforePrevious : previous;
}

export function nextCodePointOffset(text: string, offset: number): number {
  if (offset >= text.length) return text.length;

  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined) return text.length;
  return Math.min(text.length, offset + (codePoint > 0xffff ? 2 : 1));
}

export function previousWordOffset(text: string, offset: number): number {
  let cursor = clampOffset(text, offset);
  cursor = skipBackward(text, cursor, "space");
  const previous = previousCodePointOffset(text, cursor);
  const characterClass = classAt(text, previous);
  return skipBackward(text, cursor, characterClass);
}

export function nextWordOffset(text: string, offset: number): number {
  let cursor = clampOffset(text, offset);
  cursor = skipForward(text, cursor, "space");
  const characterClass = classAt(text, cursor);
  cursor = skipForward(text, cursor, characterClass);
  return skipForward(text, cursor, "space");
}

function skipBackward(text: string, offset: number, targetClass: CharacterClass): number {
  let cursor = offset;

  while (cursor > 0) {
    const previous = previousCodePointOffset(text, cursor);
    if (classAt(text, previous) !== targetClass) return cursor;
    cursor = previous;
  }

  return cursor;
}

function skipForward(text: string, offset: number, targetClass: CharacterClass): number {
  let cursor = offset;

  while (cursor < text.length) {
    if (classAt(text, cursor) !== targetClass) return cursor;
    cursor = nextCodePointOffset(text, cursor);
  }

  return cursor;
}

function classAt(text: string, offset: number): CharacterClass {
  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined) return "space";

  const character = String.fromCodePoint(codePoint);
  if (/\s/u.test(character)) return "space";
  if (WORD_PATTERN.test(character)) return "word";
  return "punctuation";
}

function clampOffset(text: string, offset: number): number {
  return Math.min(Math.max(0, offset), text.length);
}
