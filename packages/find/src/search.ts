import {
  codePointSizeAt,
  compareTextOffsetRanges,
  isWholeWordRange,
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

// Escapes whose class cannot hold a line break, so a pattern built only from
// these can be answered a line at a time. A carriage return is among them: it
// sits inside a line, not between two.
const LINE_SAFE_ESCAPES = new Set(['d', 'w', 't', 'r', 'f', 'v', 'b', 'B', '0'])

export type FindRange = TextOffsetRange

// Read-only line-start access, structurally the view a document snapshot
// already hands out, so a search never asks for the array behind it.
export type FindLineStartsView = {
  readonly length: number
  at(index: number): number | undefined
  indexForOffset(offset: number): number
}

/**
 * The text a search reads, in ranges rather than as one string.
 *
 * A query that cannot match a line break is answered a line at a time, so a
 * keystroke in the find box costs the lines examined instead of a copy of the
 * whole document — and a chunked buffer gets searched where it lies.
 */
export type FindTextSource = {
  readonly length: number
  readRange(start: number, end: number): string
  readonly lineStartsView: FindLineStartsView
}

export type FindQuery = {
  readonly searchString: string
  readonly isRegex: boolean
  readonly matchCase: boolean
  readonly wholeWord: boolean
}

export type FindMatch = FindRange & {
  readonly matches: readonly string[] | null
}

export type FindMatchFromOptions = {
  readonly captureMatches?: boolean
  readonly loop?: boolean
  readonly escapeEmptyMatchAtOffset?: boolean
}

/** What the two directions have in common, so one caller can hold either. */
export type FindMatchFromSearcher = (
  source: FindTextSource,
  query: FindQuery,
  offset: number,
  ranges: readonly FindRange[] | null,
  options: FindMatchFromOptions,
) => FindMatch | null

type CompiledFindQuery = {
  readonly regex: RegExp
  // Non-null only when a plain indexOf over the untouched text is exactly
  // equivalent to the regex; see compileFindQuery.
  readonly simpleSearch: string | null
  readonly wholeWord: boolean
  readonly lineCrossing: boolean
}

// One stretch of the document already read: the text of
// `[start, start + text.length)`, to be searched from `from` onward.
type FindWindow = {
  readonly text: string
  readonly start: number
  readonly from: number
}

export function findMatches(
  source: FindTextSource,
  query: FindQuery,
  ranges: readonly FindRange[] | null = null,
  captureMatches = false,
  limit = FIND_MATCHES_LIMIT,
): readonly FindMatch[] {
  const compiled = compileFindQuery(query)
  if (!compiled) return []

  const matches: FindMatch[] = []
  for (const range of searchRanges(source, ranges)) {
    appendMatchesInRange(matches, source, compiled, range, captureMatches, limit)
    if (matches.length >= limit) break
  }

  return matches
}

// Adapts a materialized line-start array for a source that has no view of its
// own; searching only ever reaches line starts through the view.
export function arrayFindLineStartsView(lineStarts: readonly number[]): FindLineStartsView {
  return {
    length: lineStarts.length,
    at: (index) => lineStarts[index],
    indexForOffset: (offset) => arrayLineIndexForOffset(lineStarts, offset),
  }
}

/** The line holding `offset`, break excluded. */
export function findLineRange(source: FindTextSource, offset: number): FindRange {
  const index = source.lineStartsView.indexForOffset(offset)
  return { start: source.lineStartsView.at(index) ?? 0, end: lineEndAt(source, index) }
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

/**
 * One match, scanned for from an offset instead of picked out of a list.
 *
 * A listing stops at FIND_MATCHES_LIMIT, and past that every entry in it sits
 * behind the cursor: picking from it answers each press with the top of the
 * document. Scanning outward stops at the first match it reaches, so how far
 * navigation can go is not what a paint budget allowed.
 */
export function findNextMatchFrom(
  source: FindTextSource,
  query: FindQuery,
  offset: number,
  ranges: readonly FindRange[] | null = null,
  options: FindMatchFromOptions = {},
): FindMatch | null {
  const searched = searchRanges(source, ranges)
  const ahead = firstMatchAfter(source, query, searched, clampSourceOffset(source, offset), options)
  if (ahead) return ahead
  if (options.loop === false) return null

  // Wrapping is a second bounded scan rather than a listing, so a cursor past
  // the last match still costs only the text up to the first one.
  return firstMatchAtOrAfter(source, query, searched, searched[0]?.start ?? 0, options)
}

export function findPreviousMatchFrom(
  source: FindTextSource,
  query: FindQuery,
  offset: number,
  ranges: readonly FindRange[] | null = null,
  options: FindMatchFromOptions = {},
): FindMatch | null {
  const searched = searchRanges(source, ranges)
  const behind = lastMatchBefore(
    source,
    query,
    searched,
    clampSourceOffset(source, offset),
    options,
  )
  if (behind) return behind
  if (options.loop === false) return null

  return lastMatchBefore(source, query, searched, source.length, {
    ...options,
    escapeEmptyMatchAtOffset: false,
  })
}

export function findMatchIndex(matches: readonly FindMatch[], range: FindRange): number {
  return matches.findIndex((match) => match.start === range.start && match.end === range.end)
}

export function escapeRegExpCharacters(value: string): string {
  return value.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&')
}

function arrayLineIndexForOffset(lineStarts: readonly number[], offset: number): number {
  const clamped = Math.max(0, offset)
  let low = 0
  let high = lineStarts.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (clamped < (lineStarts[middle] ?? 0)) {
      high = middle - 1
      continue
    }
    if (clamped >= (lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY)) {
      low = middle + 1
      continue
    }
    return middle
  }

  return Math.max(0, lineStarts.length - 1)
}

// The break belongs to no line: a query that cannot match one would otherwise be
// handed a haystack whose `$` sits behind it.
function lineEndAt(source: FindTextSource, index: number): number {
  const nextLineStart = source.lineStartsView.at(index + 1)
  return nextLineStart === undefined ? source.length : nextLineStart - 1
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
// forever. Stepping to the neighbouring entry escapes it without re-probing the
// document, and without having to guess whether the pattern is anchored.
function escapesEmptyMatch(match: FindMatch, offset: number, escape: boolean): boolean {
  return escape && match.start === match.end && match.start === offset
}

function firstMatchAfter(
  source: FindTextSource,
  query: FindQuery,
  ranges: readonly FindRange[],
  offset: number,
  options: FindMatchFromOptions,
): FindMatch | null {
  const found = firstMatchAtOrAfter(source, query, ranges, offset, options)
  if (!found) return null
  if (!escapesEmptyMatch(found, offset, options.escapeEmptyMatchAtOffset ?? false)) return found

  // Resumed past the offset itself, once: whatever stands there is the entry
  // after the one being escaped, empty or not.
  return firstMatchAtOrAfter(source, query, ranges, nextCodePointOffset(source, offset), options)
}

function firstMatchAtOrAfter(
  source: FindTextSource,
  query: FindQuery,
  ranges: readonly FindRange[],
  offset: number,
  options: FindMatchFromOptions,
): FindMatch | null {
  for (const range of ranges) {
    if (range.end < offset) continue

    // A range cut at the offset keeps whole lines under it, so the anchors and
    // the word boundaries still answer for the line the reader sees.
    const clipped = { start: Math.max(range.start, offset), end: range.end }
    const found = findMatches(source, query, [clipped], options.captureMatches ?? false, 1)
    if (found[0]) return found[0]
  }

  return null
}

function lastMatchBefore(
  source: FindTextSource,
  query: FindQuery,
  ranges: readonly FindRange[],
  offset: number,
  options: FindMatchFromOptions,
): FindMatch | null {
  for (const range of ranges.toReversed()) {
    if (range.start > offset) continue

    const clipped = { start: range.start, end: Math.min(range.end, offset) }
    const found = lastMatchInRange(source, query, clipped, offset, options)
    if (found) return found
  }

  return null
}

// Walked back a line at a time, because the match before the cursor is the one
// being asked for and listing everything behind it to reach the last entry is
// the whole document on a search that started near its end.
function lastMatchInRange(
  source: FindTextSource,
  query: FindQuery,
  range: FindRange,
  offset: number,
  options: FindMatchFromOptions,
): FindMatch | null {
  if (isLineCrossingQuery(query)) return lastMatchInWindow(source, query, range, offset, options)

  const lineStartsView = source.lineStartsView
  for (let index = lineStartsView.indexForOffset(range.end); index >= 0; index -= 1) {
    const lineStart = lineStartsView.at(index) ?? 0
    const line = {
      start: Math.max(range.start, lineStart),
      end: Math.min(range.end, lineEndAt(source, index)),
    }
    const found =
      line.end < line.start ? null : lastMatchInWindow(source, query, line, offset, options)
    if (found) return found
    if (lineStart <= range.start) return null
  }

  return null
}

// The last match in one window, escaping the same way stepping an ordered list
// does: what stands before a zero-width match parked on the cursor is the entry
// the search is being asked for, and it may be in an earlier window.
function lastMatchInWindow(
  source: FindTextSource,
  query: FindQuery,
  range: FindRange,
  offset: number,
  options: FindMatchFromOptions,
): FindMatch | null {
  // Uncapped: the cap bounds what gets painted, and a listing that stopped at it
  // would answer every press behind the cursor with the 19,999th match rather
  // than the nearest one.
  const found = findMatches(
    source,
    query,
    [range],
    options.captureMatches ?? false,
    FIND_REPLACE_ALL_LIMIT,
  )
  const last = found.at(-1)
  if (!last) return null
  if (!escapesEmptyMatch(last, offset, options.escapeEmptyMatchAtOffset ?? false)) return last

  return found.at(-2) ?? null
}

// A pattern compiled with the unicode flag may not be resumed inside a surrogate
// pair, so stepping off an empty match steps a code point rather than a unit.
function nextCodePointOffset(source: FindTextSource, offset: number): number {
  const text = source.readRange(offset, Math.min(source.length, offset + 2))
  return offset + Math.max(1, codePointSizeAt(text, 0))
}

// True when the query contains at least one character whose case can differ,
// which is the only situation where matchCase changes what a plain search
// finds. Digits, punctuation and CJK are caseless, so an untouched indexOf is
// still exact for them even with matchCase off.
function queryIsCaseSensitiveByContent(searchString: string): boolean {
  return searchString.toLowerCase() !== searchString.toUpperCase()
}

// True when no per-line haystack could answer the query, so the search has to
// be handed text that still holds its breaks.
/**
 * Whether a query has to be answered by a haystack that spans line breaks.
 *
 * Asked the safe way round. Listing the constructs that CAN hold a break means
 * one nobody thought of routes a query to the per-line path, where it answers
 * "no results" for text that is plainly there — the one wrong answer a search
 * must never give. So a query stays on the per-line path only when every part of
 * it is provably break-free, and anything unrecognized takes the slower path
 * that is always correct.
 */
function isLineCrossingQuery(query: FindQuery): boolean {
  if (!query.isRegex) return query.searchString.includes('\n')
  return !isLineSafePattern(query.searchString)
}

function isLineSafePattern(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '\n') return false
    if (char === '[') {
      const end = characterClassEnd(pattern, index)
      if (end === null || !isLineSafeCharacterClass(pattern.slice(index + 1, end))) return false

      index = end
      continue
    }

    if (char === '(' && !isLineSafeGroupOpener(pattern, index)) return false
    if (char !== '\\') continue

    index += 1
    const escaped = pattern[index]
    if (escaped === undefined) return false
    // A hex or unicode escape can spell the break itself, and reading which one
    // it spells is more machinery than routing it to the correct path costs.
    if (!LINE_SAFE_ESCAPES.has(escaped) && /[\p{L}\p{N}]/u.test(escaped)) return false
  }

  return true
}

/**
 * Only a group that bundles what is written inside it, leaving its meaning alone.
 *
 * A capture, a non-capture and either lookaround are all of those. A modifier
 * group is not: it can switch on the flag under which a dot spans a break, so the
 * characters inside it stop saying what they say anywhere else — and reading back
 * which flags one names is more machinery than routing it to the correct path
 * costs. Every other spelling is one nobody here recognized, which is the same
 * answer.
 */
function isLineSafeGroupOpener(pattern: string, index: number): boolean {
  if (pattern[index + 1] !== '?') return true

  const kind = pattern[index + 2]
  // '<' opens a lookbehind or names a capture, and neither changes what matches.
  return kind === ':' || kind === '=' || kind === '!' || kind === '<'
}

// Only a positive class naming its members outright: a negated one holds a break
// unless it names it, and an escape inside one can bring a whole class with it.
function isLineSafeCharacterClass(body: string): boolean {
  if (body.startsWith('^')) return false
  return !body.includes('\\') && !body.includes('\n')
}

function characterClassEnd(pattern: string, from: number): number | null {
  for (let index = from + 1; index < pattern.length; index += 1) {
    if (pattern[index] === '\\') index += 1
    else if (pattern[index] === ']') return index
  }

  return null
}

function compileFindQuery(query: FindQuery): CompiledFindQuery | null {
  if (query.searchString.length === 0) return null

  const source = query.isRegex ? query.searchString : escapeRegExpCharacters(query.searchString)
  const lineCrossing = isLineCrossingQuery(query)
  // Flags describe the haystack, and only a line-crossing search is ever handed
  // one holding a break: a per-line slice bounds `^` and `$` by itself, so `m`
  // there would only claim breaks the slice does not contain.
  const flags = `g${query.matchCase ? '' : 'i'}${lineCrossing ? 'm' : ''}u`

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
      lineCrossing,
    }
  } catch {
    return null
  }
}

function searchRanges(
  source: FindTextSource,
  ranges: readonly FindRange[] | null,
): readonly FindRange[] {
  if (!ranges || ranges.length === 0) return [{ start: 0, end: source.length }]

  const clamped = ranges
    .map((range) => ({
      start: clampSourceOffset(source, range.start),
      end: clampSourceOffset(source, range.end),
    }))
    .filter((range) => range.start <= range.end)
    .toSorted(compareTextOffsetRanges)

  // Scopes are followed through edits, and an edit spanning the seam between two
  // of them leaves them overlapping. Searching both would report the text they
  // share twice, which a Replace All then tries to rewrite twice.
  const merged: FindRange[] = []
  for (const range of clamped) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) }
      continue
    }

    merged.push(range)
  }

  return merged
}

function clampSourceOffset(source: FindTextSource, offset: number): number {
  return Math.min(Math.max(0, offset), source.length)
}

function appendMatchesInRange(
  matches: FindMatch[],
  source: FindTextSource,
  query: CompiledFindQuery,
  range: FindRange,
  captureMatches: boolean,
  limit: number,
): void {
  if (query.lineCrossing) {
    appendCrossingMatches(matches, source, query, range, captureMatches, limit)
    return
  }

  appendLineMatches(matches, source, query, range, captureMatches, limit)
}

// Whole lines, even where the range was cut inside one: the anchors and the word
// boundaries have to answer for the line the reader sees rather than for where
// the range happens to end, so the range only decides which matches are kept.
function appendLineMatches(
  matches: FindMatch[],
  source: FindTextSource,
  query: CompiledFindQuery,
  range: FindRange,
  captureMatches: boolean,
  limit: number,
): void {
  const lineStartsView = source.lineStartsView
  for (
    let index = lineStartsView.indexForOffset(range.start);
    index < lineStartsView.length;
    index += 1
  ) {
    const start = lineStartsView.at(index)
    if (start === undefined || start > range.end) return
    if (matches.length >= limit) return

    const window = readWindow(source, start, lineEndAt(source, index), range)
    if (!appendWindowMatches(matches, window, query, range, captureMatches, limit)) return
  }
}

// Listing every match of a pattern that can span the range's ends has to look at
// every character between them, so the range is read as one window: a window
// grown in steps would only re-run the pattern over text it already scanned. The
// window still stops on line boundaries, or `^` and `$` would answer for its cut
// ends instead of for real ones.
function appendCrossingMatches(
  matches: FindMatch[],
  source: FindTextSource,
  query: CompiledFindQuery,
  range: FindRange,
  captureMatches: boolean,
  limit: number,
): void {
  const lineStartsView = source.lineStartsView
  const start = lineStartsView.at(lineStartsView.indexForOffset(range.start)) ?? 0
  const end = lineEndAt(source, lineStartsView.indexForOffset(range.end))
  const window = readWindow(source, start, Math.max(start, end), range)
  appendWindowMatches(matches, window, query, range, captureMatches, limit)
}

function readWindow(
  source: FindTextSource,
  start: number,
  end: number,
  range: FindRange,
): FindWindow {
  return { text: source.readRange(start, end), start, from: Math.max(0, range.start - start) }
}

/** False once the range is spent, so no later window can add to the result. */
function appendWindowMatches(
  matches: FindMatch[],
  window: FindWindow,
  query: CompiledFindQuery,
  range: FindRange,
  captureMatches: boolean,
  limit: number,
): boolean {
  if (query.simpleSearch && !captureMatches) {
    return appendSimpleMatches(matches, window, query, range, limit)
  }

  return appendRegexMatches(matches, window, query, range, captureMatches, limit)
}

function appendSimpleMatches(
  matches: FindMatch[],
  window: FindWindow,
  query: CompiledFindQuery,
  range: FindRange,
  limit: number,
): boolean {
  const searchString = query.simpleSearch
  if (!searchString) return true

  // Searched as-is: no folded copy of the text is allocated, and every index
  // returned addresses the window it came from.
  let index = window.text.indexOf(searchString, window.from)
  while (index !== -1 && matches.length < limit) {
    const start = window.start + index
    if (start + searchString.length > range.end) return false
    if (validWholeWordMatch(window.text, index, searchString.length, query.wholeWord))
      matches.push({ start, end: start + searchString.length, matches: null })

    index = window.text.indexOf(searchString, index + searchString.length)
  }

  return true
}

function appendRegexMatches(
  matches: FindMatch[],
  window: FindWindow,
  query: CompiledFindQuery,
  range: FindRange,
  captureMatches: boolean,
  limit: number,
): boolean {
  query.regex.lastIndex = window.from
  while (matches.length < limit) {
    const match = query.regex.exec(window.text)
    if (!match) return true

    const start = window.start + match.index
    const end = start + match[0].length
    if (start > range.end || end > range.end) return false
    if (validWholeWordMatch(window.text, match.index, match[0].length, query.wholeWord))
      matches.push({ start, end, matches: captureMatches ? match : null })

    if (match[0].length === 0) advancePastEmptyMatch(query.regex, window.text)
  }

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
