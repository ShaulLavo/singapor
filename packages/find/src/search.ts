import {
  codePointSizeAt,
  isWholeWordRange,
  normalizeTextOffsetRanges,
  type TextOffsetRange,
} from '@singapor/core/document'

// Bounds the match set the widget counts and paints, so a pathological query
// on a huge file cannot stall the frame.
export const FIND_MATCHES_LIMIT = 19_999

// Replace All must never apply to a truncated match set: stopping early would
// silently rewrite part of the document and leave the rest, with no signal to
// the user. Searching is linear, so the only real cost of lifting the cap here
// is the edit batch itself.
export const FIND_REPLACE_ALL_LIMIT = 1_073_741_824

export type FindRange = TextOffsetRange

export type FindQuery = {
  readonly searchString: string
  readonly isRegex: boolean
  readonly matchCase: boolean
  readonly wholeWord: boolean
}

export type FindMatch = FindRange & {
  readonly matches: readonly string[] | null
}

type CompiledFindQuery = {
  readonly regex: RegExp
  // Non-null only when a plain indexOf over the untouched text is exactly
  // equivalent to the regex; see compileFindQuery.
  readonly simpleSearch: string | null
  readonly wholeWord: boolean
}

export function findMatches(
  text: string,
  query: FindQuery,
  ranges: readonly FindRange[] | null = null,
  captureMatches = false,
  limit = FIND_MATCHES_LIMIT,
): readonly FindMatch[] {
  const compiled = compileFindQuery(query)
  if (!compiled) return []

  const searchRanges = normalizedSearchRanges(text, ranges)
  const matches: FindMatch[] = []
  for (const range of searchRanges) {
    appendMatchesInRange(matches, text, compiled, range, captureMatches, limit)
    if (matches.length >= limit) break
  }

  return matches
}

export function nextMatchAfter(
  matches: readonly FindMatch[],
  offset: number,
  loop: boolean,
  escapeEmptyMatchAtOffset = false,
): FindMatch | null {
  if (matches.length === 0) return null

  const found = indexAtOrAfter(matches, offset)
  if (found === -1) return loop ? (matches[0] ?? null) : null

  const index = escapesEmptyMatch(matches[found]!, offset, escapeEmptyMatchAtOffset)
    ? found + 1
    : found
  return matches[index] ?? (loop ? (matches[0] ?? null) : null)
}

export function previousMatchBefore(
  matches: readonly FindMatch[],
  offset: number,
  loop: boolean,
  escapeEmptyMatchAtOffset = false,
): FindMatch | null {
  if (matches.length === 0) return null

  const found = indexAtOrBefore(matches, offset)
  if (found === -1) return loop ? (matches.at(-1) ?? null) : null

  const index = escapesEmptyMatch(matches[found]!, offset, escapeEmptyMatchAtOffset)
    ? found - 1
    : found
  return matches[index] ?? (loop ? (matches.at(-1) ?? null) : null)
}

export function findMatchIndex(matches: readonly FindMatch[], range: FindRange): number {
  return matches.findIndex((match) => match.start === range.start && match.end === range.end)
}

export function escapeRegExpCharacters(value: string): string {
  return value.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&')
}

function indexAtOrAfter(matches: readonly FindMatch[], offset: number): number {
  return matches.findIndex((match) => match.start >= offset)
}

function indexAtOrBefore(matches: readonly FindMatch[], offset: number): number {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if (matches[index]!.end <= offset) return index
  }

  return -1
}

// A zero-width match sitting exactly on the cursor answers the search again on
// every press, so `^`, `$`, `\b` and lookaheads would pin navigation there
// forever. Monaco re-probes the document by a code point or a whole line
// depending on whether the pattern is anchored; we already hold every match in
// document order, so the neighbouring entry is that answer without the probe or
// the anchor guess.
function escapesEmptyMatch(match: FindMatch, offset: number, escape: boolean): boolean {
  return escape && match.start === match.end && match.start === offset
}

// True when the query contains at least one character whose case can differ,
// which is the only situation where matchCase changes what a plain search
// finds. Digits, punctuation and CJK are caseless, so an untouched indexOf is
// still exact for them even with matchCase off.
function queryIsCaseSensitiveByContent(searchString: string): boolean {
  return searchString.toLowerCase() !== searchString.toUpperCase()
}

function compileFindQuery(query: FindQuery): CompiledFindQuery | null {
  if (query.searchString.length === 0) return null

  const source = query.isRegex ? query.searchString : escapeRegExpCharacters(query.searchString)
  const flags = query.matchCase ? 'gmu' : 'gimu'

  // The fast path may never case-fold the haystack: folding is not
  // length-preserving (U+0130 'İ' lowercases to two code units), so an index
  // into folded text does not address the original text, and a match reported
  // from it slices the wrong characters — Replace would then overwrite them.
  // Fall back to the case-insensitive regex, which reports original indices.
  const canUseSimpleSearch =
    !query.isRegex && (query.matchCase || !queryIsCaseSensitiveByContent(query.searchString))

  try {
    return {
      regex: new RegExp(source, flags),
      simpleSearch: canUseSimpleSearch ? query.searchString : null,
      wholeWord: query.wholeWord,
    }
  } catch {
    return null
  }
}

function normalizedSearchRanges(
  text: string,
  ranges: readonly FindRange[] | null,
): readonly FindRange[] {
  if (!ranges || ranges.length === 0) return [{ start: 0, end: text.length }]
  return normalizeTextOffsetRanges(text, ranges)
}

function appendMatchesInRange(
  matches: FindMatch[],
  text: string,
  query: CompiledFindQuery,
  range: FindRange,
  captureMatches: boolean,
  limit: number,
): void {
  if (query.simpleSearch && !captureMatches) {
    appendSimpleMatches(matches, text, query, range, limit)
    return
  }

  appendRegexMatches(matches, text, query, range, captureMatches, limit)
}

function appendSimpleMatches(
  matches: FindMatch[],
  text: string,
  query: CompiledFindQuery,
  range: FindRange,
  limit: number,
): void {
  const searchString = query.simpleSearch
  if (!searchString) return

  // Searched as-is: no folded copy of the document is allocated, and every
  // index returned already addresses `text`.
  let index = range.start - searchString.length
  while (matches.length < limit) {
    index = text.indexOf(searchString, index + searchString.length)
    if (index === -1 || index + searchString.length > range.end) return
    if (index < range.start) continue
    if (!validWholeWordMatch(text, index, searchString.length, query.wholeWord)) continue

    matches.push({ start: index, end: index + searchString.length, matches: null })
  }
}

function appendRegexMatches(
  matches: FindMatch[],
  text: string,
  query: CompiledFindQuery,
  range: FindRange,
  captureMatches: boolean,
  limit: number,
): void {
  query.regex.lastIndex = range.start
  while (matches.length < limit) {
    const match = query.regex.exec(text)
    if (!match) return

    if (!appendRegexMatch(matches, text, query, range, match, captureMatches)) return
    if (match[0].length === 0) advancePastEmptyMatch(query.regex, text)
  }
}

function appendRegexMatch(
  matches: FindMatch[],
  text: string,
  query: CompiledFindQuery,
  range: FindRange,
  match: RegExpExecArray,
  captureMatches: boolean,
): boolean {
  const start = match.index
  const end = start + match[0].length
  if (start > range.end) return false
  if (end > range.end) return false
  if (!validWholeWordMatch(text, start, match[0].length, query.wholeWord)) return true

  matches.push({
    start,
    end,
    matches: captureMatches ? match : null,
  })
  return true
}

function advancePastEmptyMatch(regex: RegExp, text: string): void {
  const current = regex.lastIndex
  if (current > text.length) return

  const size = codePointSizeAt(text, current)
  regex.lastIndex = current + Math.max(1, size)
}

function validWholeWordMatch(
  text: string,
  start: number,
  length: number,
  wholeWord: boolean,
): boolean {
  if (!wholeWord) return true
  return isWholeWordRange(text, { start, end: start + length })
}
