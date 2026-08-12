export type TextOffsetRange = {
  readonly start: number
  readonly end: number
}

export type TextCharacterClass = 'word' | 'space' | 'punctuation'

const WORD_PATTERN = /^[\p{L}\p{N}_]$/u

export function clampTextOffset(text: string, offset: number): number {
  return Math.min(Math.max(0, offset), text.length)
}

export function clampTextOffsetRange(text: string, range: TextOffsetRange): TextOffsetRange {
  return {
    start: clampTextOffset(text, range.start),
    end: clampTextOffset(text, range.end),
  }
}

export function compareTextOffsetRanges(left: TextOffsetRange, right: TextOffsetRange): number {
  return left.start - right.start || left.end - right.end
}

export function normalizeTextOffsetRanges(
  text: string,
  ranges: readonly TextOffsetRange[],
): readonly TextOffsetRange[] {
  return ranges
    .map((range) => clampTextOffsetRange(text, range))
    .filter((range) => range.start <= range.end)
    .toSorted(compareTextOffsetRanges)
}

export function lineRangeAtOffset(text: string, rawOffset: number): TextOffsetRange {
  const offset = clampTextOffset(text, rawOffset)
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const nextLineBreak = text.indexOf('\n', offset)
  const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak
  return { start: lineStart, end: lineEnd }
}

export function previousCodePointOffset(text: string, offset: number): number {
  const cursor = clampTextOffset(text, offset)
  if (cursor <= 0) return 0

  const previous = cursor - 1
  const codeUnit = text.charCodeAt(previous)
  const beforePrevious = previous - 1
  const lowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff
  if (!lowSurrogate || beforePrevious < 0) return previous

  const previousCodeUnit = text.charCodeAt(beforePrevious)
  const highSurrogate = previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff
  return highSurrogate ? beforePrevious : previous
}

export function previousCodePointStart(text: string, offset: number): number | null {
  if (offset <= 0) return null
  return previousCodePointOffset(text, offset)
}

export function nextCodePointOffset(text: string, offset: number): number {
  const cursor = clampTextOffset(text, offset)
  if (cursor >= text.length) return text.length

  const size = codePointSizeAt(text, cursor)
  return Math.min(text.length, cursor + Math.max(1, size))
}

export function codePointSizeAt(text: string, offset: number): number {
  const codePoint = text.codePointAt(offset)
  if (codePoint === undefined) return 0
  return codePoint > 0xffff ? 2 : 1
}

export function isWordCodePointAt(text: string, offset: number): boolean {
  const codePoint = text.codePointAt(offset)
  if (codePoint === undefined) return false
  return WORD_PATTERN.test(String.fromCodePoint(codePoint))
}

export function isWordCodePointBefore(text: string, offset: number): boolean {
  const previous = previousCodePointStart(text, offset)
  return previous !== null && isWordCodePointAt(text, previous)
}

export function characterClassAt(text: string, offset: number): TextCharacterClass {
  const codePoint = text.codePointAt(offset)
  if (codePoint === undefined) return 'space'

  const character = String.fromCodePoint(codePoint)
  if (/\s/u.test(character)) return 'space'
  if (WORD_PATTERN.test(character)) return 'word'
  return 'punctuation'
}

export function previousWordOffset(text: string, offset: number): number {
  let cursor = clampTextOffset(text, offset)
  cursor = skipBackward(text, cursor, 'space')
  const previous = previousCodePointOffset(text, cursor)
  return skipBackward(text, cursor, characterClassAt(text, previous))
}

export function nextWordOffset(text: string, offset: number): number {
  let cursor = clampTextOffset(text, offset)
  cursor = skipForward(text, cursor, 'space')
  cursor = skipForward(text, cursor, characterClassAt(text, cursor))
  return skipForward(text, cursor, 'space')
}

export function wordRangeAtOffset(text: string, rawOffset: number): TextOffsetRange {
  const offset = clampTextOffset(text, rawOffset)
  const probeOffset = wordProbeOffset(text, offset)
  if (probeOffset === null) return { start: offset, end: offset }

  let start = probeOffset
  let end = probeOffset + codePointSizeAt(text, probeOffset)

  while (start > 0) {
    const previous = previousCodePointStart(text, start)
    if (previous === null || !isWordCodePointAt(text, previous)) break
    start = previous
  }

  while (end < text.length && isWordCodePointAt(text, end)) {
    end = nextCodePointOffset(text, end)
  }

  return { start, end }
}

export function isWholeWordRange(text: string, range: TextOffsetRange): boolean {
  const clamped = clampTextOffsetRange(text, range)
  if (clamped.start > clamped.end) return false

  const length = clamped.end - clamped.start
  return (
    leftIsWordBoundary(text, clamped.start, length) && rightIsWordBoundary(text, clamped, length)
  )
}

function skipBackward(text: string, offset: number, targetClass: TextCharacterClass): number {
  let cursor = offset

  while (cursor > 0) {
    const previous = previousCodePointOffset(text, cursor)
    if (characterClassAt(text, previous) !== targetClass) return cursor
    cursor = previous
  }

  return cursor
}

function skipForward(text: string, offset: number, targetClass: TextCharacterClass): number {
  let cursor = offset

  while (cursor < text.length) {
    if (characterClassAt(text, cursor) !== targetClass) return cursor
    cursor = nextCodePointOffset(text, cursor)
  }

  return cursor
}

function wordProbeOffset(text: string, offset: number): number | null {
  if (offset < text.length && isWordCodePointAt(text, offset)) return offset

  const previous = previousCodePointStart(text, offset)
  if (previous !== null && isWordCodePointAt(text, previous)) return previous

  return null
}

function leftIsWordBoundary(text: string, start: number, length: number): boolean {
  if (start === 0) return true
  if (!isWordCodePointBefore(text, start)) return true
  if (length === 0) return false
  return !isWordCodePointAt(text, start)
}

function rightIsWordBoundary(text: string, range: TextOffsetRange, length: number): boolean {
  if (range.end === text.length) return true
  if (!isWordCodePointAt(text, range.end)) return true
  if (length === 0) return false
  return !isWordCodePointBefore(text, range.end)
}

/**
 * Subword boundaries: the transitions inside an identifier that camelCase and snake_case create.
 *
 * `parseHTTPResponse` reads as parse | HTTP | Response, and `read_file_sync` as read | file | sync.
 * An acronym run ends one character before the capital that starts the next word, which is what
 * keeps `HTTPResponse` from being read as `HTTPR | esponse`.
 */
export function nextWordPartOffset(text: string, offset: number): number {
  const limit = text.length
  let cursor = clampTextOffset(text, offset)
  if (cursor >= limit) return limit

  // Step off any run of separators first, so a caret before '_' lands on the next word.
  while (cursor < limit && isSubwordSeparator(text[cursor])) cursor += 1
  if (cursor >= limit) return limit

  cursor += 1
  while (cursor < limit) {
    const char = text[cursor]
    if (char === undefined || isSubwordSeparator(char)) break
    if (startsSubword(text, cursor)) break

    cursor += 1
  }

  return cursor
}

export function previousWordPartOffset(text: string, offset: number): number {
  let cursor = clampTextOffset(text, offset)
  if (cursor <= 0) return 0

  cursor -= 1
  while (cursor > 0 && isSubwordSeparator(text[cursor])) cursor -= 1
  if (cursor <= 0) return 0

  while (cursor > 0) {
    if (isSubwordSeparator(text[cursor - 1])) break
    if (startsSubword(text, cursor)) break

    cursor -= 1
  }

  return cursor
}

/** True when `index` begins a new subword: a capital after lower, or a letter after a digit. */
function startsSubword(text: string, index: number): boolean {
  const previous = text[index - 1]
  const current = text[index]
  if (previous === undefined || current === undefined) return false
  if (!isUpper(current)) return isLetter(current) && isDigit(previous)
  if (isLower(previous)) return true
  if (isDigit(previous)) return true

  // Inside an acronym, the boundary is the capital that a lowercase letter follows: HTTP|Response.
  return isUpper(previous) && isLower(text[index + 1] ?? '')
}

function isSubwordSeparator(char: string | undefined): boolean {
  if (char === undefined) return false

  return !/[\p{L}\p{N}]/u.test(char)
}

const isUpper = (char: string) => /\p{Lu}/u.test(char)
const isLower = (char: string) => /\p{Ll}/u.test(char)
const isDigit = (char: string) => /\p{Nd}/u.test(char)
const isLetter = (char: string) => /\p{L}/u.test(char)
