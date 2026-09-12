import type { TextSnapshot } from '../documentTextSnapshot'
import type { EditorToken, TextEdit } from '../tokens'
import { firstBatchChangeEndingAtOrAfter, type TextEditBatch } from '../textEditBatch'
import { recordEditorPerformanceDiagnostic } from './performanceDiagnostics'
import {
  appendEditorTokenIndexEntry,
  copyEditorTokenIndex,
  getEditorTokenIndex,
  setEditorTokenIndex,
  type EditorTokenIndex,
} from './tokenIndex'

type TokenProjectionMetadata = {
  readonly keepsLiveRanges: boolean
  readonly sourceTokens: readonly EditorToken[]
}

type TokenProjectionBuilder = {
  maxEnds: number[]
  tokens: EditorToken[]
  maxEnd: number
  monotonicEnd: boolean
  nonOverlapping: boolean
  previousEnd: number
  previousStart: number
  sortedByStart: boolean
}

type TokenProjectionPath = 'indexed.bulk' | 'indexed.fallback' | 'indexed.lazy' | 'scan'

type TokenProjectionText = string | TextSnapshot

const LAZY_PROJECTED_SUFFIX_THRESHOLD = 64
const tokenProjectionMetadata = new WeakMap<readonly EditorToken[], TokenProjectionMetadata>()

export function projectTokensThroughEdit(
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: TokenProjectionText,
): readonly EditorToken[] {
  const delta = edit.text.length - (edit.to - edit.from)
  const lineStructureChanged = editChangesLineStructure(edit, previousText)
  const indexed = projectIndexedTokensThroughEdit(
    tokens,
    edit,
    previousText,
    delta,
    lineStructureChanged,
  )
  if (indexed) return indexed

  recordTokenProjectionPath('scan', tokens, 0, tokens.length)
  return scanProjectTokensThroughEdit(tokens, edit, previousText, delta, lineStructureChanged)
}

export function projectTokensThroughEdits(
  tokens: readonly EditorToken[],
  batch: TextEditBatch,
): readonly EditorToken[] {
  if (tokens.length === 0 || batch.changes.length === 0) return tokens
  const edits = batch.changes.map((change) => ({
    from: change.from,
    to: change.to,
    text: batch.after.readRange(change.afterFrom, change.afterTo),
  }))
  const builder = createTokenProjectionBuilder()
  for (const token of tokens) {
    const projected = projectTokenThroughBatch(token, batch, edits)
    if (isRenderableToken(projected)) appendBuiltToken(builder, projected)
  }
  recordTokenProjectionPath('scan', tokens, 0, tokens.length, undefined, {
    editCount: batch.edits.length,
    batch: true,
  })
  return finishTokenProjection(tokens, builder, false)
}

function projectTokenThroughBatch(
  token: EditorToken,
  batch: TextEditBatch,
  edits: readonly TextEdit[],
): EditorToken | null {
  const first = firstBatchChangeEndingAtOrAfter(batch, token.start)
  const change = batch.changes[first]
  let startDelta = change
    ? change.afterFrom - change.from
    : batch.after.length - batch.before.length
  let endDelta = startDelta
  for (let index = first; index < batch.changes.length; index += 1) {
    const next = batch.changes[index]!
    if (next.from > token.end) break
    const lineChanged = next.startRow !== next.endRow || next.afterStartRow !== next.afterEndRow
    const projected = projectTokenThroughEdit(
      token,
      edits[index]!,
      batch.before,
      next.offsetDelta,
      lineChanged,
    )
    if (!projected) return null
    startDelta += projected.start - token.start
    endDelta += projected.end - token.end
  }
  if (startDelta === 0 && endDelta === 0) return token
  return { ...token, start: token.start + startDelta, end: token.end + endDelta }
}

export function tokenProjectionLiveRangeStatus(
  sourceTokens: readonly EditorToken[],
  projectedTokens: readonly EditorToken[],
): boolean | null {
  if (sourceTokens === projectedTokens) return true

  const metadata = tokenProjectionMetadata.get(projectedTokens)
  if (!metadata) return null
  if (metadata.sourceTokens !== sourceTokens) return false
  return metadata.keepsLiveRanges
}

export function copyTokenProjectionMetadata(
  sourceTokens: readonly EditorToken[],
  copiedTokens: readonly EditorToken[],
): void {
  copyEditorTokenIndex(sourceTokens, copiedTokens)

  const metadata = tokenProjectionMetadata.get(sourceTokens)
  if (metadata) tokenProjectionMetadata.set(copiedTokens, metadata)
}

export function sourceTokensForProjectedTokens(
  projectedTokens: readonly EditorToken[],
): readonly EditorToken[] | null {
  return tokenProjectionMetadata.get(projectedTokens)?.sourceTokens ?? null
}

function scanProjectTokensThroughEdit(
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: TokenProjectionText,
  delta: number,
  lineStructureChanged: boolean,
): readonly EditorToken[] {
  const builder = createTokenProjectionBuilder()
  let keepsLiveRanges = true

  for (const token of tokens) {
    const next = projectTokenThroughEdit(token, edit, previousText, delta, lineStructureChanged)
    if (!isRenderableToken(next)) {
      keepsLiveRanges = false
      continue
    }

    appendBuiltToken(builder, next)
  }

  return finishTokenProjection(tokens, builder, keepsLiveRanges)
}

function projectIndexedTokensThroughEdit(
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: TokenProjectionText,
  delta: number,
  lineStructureChanged: boolean,
): readonly EditorToken[] | null {
  const index = getEditorTokenIndex(tokens)
  if (!index?.sortedByStart) return null

  const prefixEnd = unchangedPrefixEnd(index, edit)
  const suffixStart = shiftedSuffixStart(tokens, edit)
  if (prefixEnd > suffixStart) return null

  const lazyProjected = projectSortedTokenRangesLazy(
    tokens,
    edit,
    previousText,
    delta,
    prefixEnd,
    suffixStart,
    index,
    lineStructureChanged,
  )
  if (lazyProjected) {
    recordTokenProjectionPath('indexed.lazy', tokens, prefixEnd, suffixStart, index, {
      resultCount: lazyProjected.length,
    })
    return lazyProjected
  }

  const projected = projectSortedTokenRangesBulk(
    tokens,
    edit,
    previousText,
    delta,
    prefixEnd,
    suffixStart,
    index,
    lineStructureChanged,
  )
  if (projected) {
    recordTokenProjectionPath('indexed.bulk', tokens, prefixEnd, suffixStart, index, {
      resultCount: projected.length,
    })
    return projected
  }

  recordTokenProjectionPath('indexed.fallback', tokens, prefixEnd, suffixStart, index)
  return projectSortedTokenRanges(
    tokens,
    edit,
    previousText,
    delta,
    prefixEnd,
    suffixStart,
    index,
    lineStructureChanged,
  )
}

function projectSortedTokenRangesLazy(
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: TokenProjectionText,
  delta: number,
  prefixEnd: number,
  suffixStart: number,
  index: EditorTokenIndex,
  lineStructureChanged: boolean,
): readonly EditorToken[] | null {
  if (!shouldUseLazyProjection(tokens, suffixStart)) return null

  const builder = createContinuationTokenProjectionBuilder(
    tokens[prefixEnd - 1],
    index.maxEnds[prefixEnd - 1] ?? 0,
    index,
  )
  const keepsLiveRanges = appendProjectedTokens(
    builder,
    tokens,
    edit,
    previousText,
    delta,
    prefixEnd,
    suffixStart,
    lineStructureChanged,
  )
  if (!canKeepLazyIndex(builder, tokens, suffixStart, delta, index)) return null

  return createLazyProjectedTokenArray(
    tokens,
    delta,
    prefixEnd,
    suffixStart,
    builder,
    index,
    keepsLiveRanges,
  )
}

function projectSortedTokenRangesBulk(
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: TokenProjectionText,
  delta: number,
  prefixEnd: number,
  suffixStart: number,
  index: EditorTokenIndex,
  lineStructureChanged: boolean,
): readonly EditorToken[] | null {
  const prefixTokens = tokens.slice(0, prefixEnd)
  const prefixMaxEnds = index.maxEnds.slice(0, prefixEnd) as number[]
  const builder = createContinuationTokenProjectionBuilder(
    tokens[prefixEnd - 1],
    prefixMaxEnds[prefixMaxEnds.length - 1] ?? 0,
    index,
  )
  const keepsLiveRanges = appendProjectedTokens(
    builder,
    tokens,
    edit,
    previousText,
    delta,
    prefixEnd,
    suffixStart,
    lineStructureChanged,
  )
  const suffixTokens = shiftedTokenRange(tokens, suffixStart, delta)
  if (!canKeepBulkIndex(builder, suffixTokens)) return null

  appendSuffixIndexEntries(builder, suffixTokens)
  const maxEnds = prefixMaxEnds.concat(builder.maxEnds)
  const projectedTokens = prefixTokens.concat(builder.tokens, suffixTokens)

  setEditorTokenIndex(projectedTokens, {
    maxEnds,
    monotonicEnd: builder.monotonicEnd,
    nonOverlapping: builder.nonOverlapping,
    sortedByStart: true,
  })
  tokenProjectionMetadata.set(projectedTokens, { keepsLiveRanges, sourceTokens: tokens })
  return projectedTokens
}

function shouldUseLazyProjection(tokens: readonly EditorToken[], suffixStart: number): boolean {
  if (suffixStart >= tokens.length) return false
  return tokens.length - suffixStart >= LAZY_PROJECTED_SUFFIX_THRESHOLD
}

function canKeepLazyIndex(
  builder: TokenProjectionBuilder,
  tokens: readonly EditorToken[],
  suffixStart: number,
  delta: number,
  index: EditorTokenIndex,
): boolean {
  if (!builder.sortedByStart) return false

  const first = tokens[suffixStart]
  if (!first) return true
  const projectedFirst = shiftToken(first, delta)
  if (projectedFirst.start < builder.previousStart) return false
  if (index.nonOverlapping && projectedFirst.start < builder.previousEnd) {
    builder.nonOverlapping = false
  }
  if (index.monotonicEnd && projectedFirst.end < builder.maxEnd) builder.monotonicEnd = false
  return true
}

function canKeepBulkIndex(
  builder: TokenProjectionBuilder,
  suffixTokens: readonly EditorToken[],
): boolean {
  if (!builder.sortedByStart) return false
  return suffixKeepsSortedStart(builder, suffixTokens)
}

function createLazyProjectedTokenArray(
  sourceTokens: readonly EditorToken[],
  delta: number,
  prefixEnd: number,
  suffixStart: number,
  builder: TokenProjectionBuilder,
  sourceIndex: EditorTokenIndex,
  keepsLiveRanges: boolean,
): readonly EditorToken[] {
  const middleTokens = builder.tokens
  const projectedLength = prefixEnd + middleTokens.length + sourceTokens.length - suffixStart
  const suffixOffset = prefixEnd + middleTokens.length
  const target: EditorToken[] = []
  target.length = projectedLength

  const projectedTokens = new Proxy(target, {
    get: (array, property, receiver) => {
      if (property === Symbol.iterator) return projectedArrayIterator(projectedLength, tokenAt)
      if (property === 'slice') return projectedArraySlice(projectedLength, tokenAt)

      const index = arrayIndexProperty(property)
      if (index !== null && index < projectedLength) return tokenAt(index)
      return Reflect.get(array, property, receiver)
    },
    getOwnPropertyDescriptor: (array, property) => {
      const index = arrayIndexProperty(property)
      if (index === null || index >= projectedLength) {
        return Reflect.getOwnPropertyDescriptor(array, property)
      }

      return {
        configurable: true,
        enumerable: true,
        value: tokenAt(index),
        writable: false,
      }
    },
    has: (array, property) => {
      const index = arrayIndexProperty(property)
      if (index !== null && index < projectedLength) return true
      return Reflect.has(array, property)
    },
  })

  setEditorTokenIndex(projectedTokens, {
    maxEnds: lazyProjectedMaxEnds(
      projectedLength,
      prefixEnd,
      suffixStart,
      builder,
      sourceIndex,
      delta,
    ),
    monotonicEnd: builder.monotonicEnd,
    nonOverlapping: builder.nonOverlapping,
    sortedByStart: true,
  })
  tokenProjectionMetadata.set(projectedTokens, { keepsLiveRanges, sourceTokens })
  return projectedTokens

  function tokenAt(index: number): EditorToken {
    if (index < prefixEnd) return sourceTokens[index]!

    const middleIndex = index - prefixEnd
    if (middleIndex < middleTokens.length) return middleTokens[middleIndex]!

    const suffixIndex = suffixStart + index - suffixOffset
    return shiftToken(sourceTokens[suffixIndex]!, delta)
  }
}

function lazyProjectedMaxEnds(
  length: number,
  prefixEnd: number,
  suffixStart: number,
  builder: TokenProjectionBuilder,
  sourceIndex: EditorTokenIndex,
  delta: number,
): readonly number[] {
  const target: number[] = []
  target.length = length
  const middleMaxEnds = builder.maxEnds
  const suffixOffset = prefixEnd + middleMaxEnds.length

  return new Proxy(target, {
    get: (array, property, receiver) => {
      const index = arrayIndexProperty(property)
      if (index !== null && index < length) return maxEndAt(index)
      return Reflect.get(array, property, receiver)
    },
    getOwnPropertyDescriptor: (array, property) => {
      const index = arrayIndexProperty(property)
      if (index === null || index >= length) {
        return Reflect.getOwnPropertyDescriptor(array, property)
      }

      return {
        configurable: true,
        enumerable: true,
        value: maxEndAt(index),
        writable: false,
      }
    },
    has: (array, property) => {
      const index = arrayIndexProperty(property)
      if (index !== null && index < length) return true
      return Reflect.has(array, property)
    },
  })

  function maxEndAt(index: number): number {
    if (index < prefixEnd) return sourceIndex.maxEnds[index] ?? 0

    const middleIndex = index - prefixEnd
    if (middleIndex < middleMaxEnds.length) return middleMaxEnds[middleIndex] ?? 0

    const sourceTokenIndex = suffixStart + index - suffixOffset
    return Math.max(builder.maxEnd, (sourceIndex.maxEnds[sourceTokenIndex] ?? 0) + delta)
  }
}

function projectedArrayIterator<T>(
  length: number,
  itemAt: (index: number) => T,
): () => IterableIterator<T> {
  return function* projectedArrayValues() {
    for (let index = 0; index < length; index += 1) yield itemAt(index)
  }
}

function projectedArraySlice<T>(
  length: number,
  itemAt: (index: number) => T,
): (start?: number, end?: number) => T[] {
  return (start, end) => {
    const range = normalizedSliceRange(length, start, end)
    const items: T[] = []
    for (let index = range.start; index < range.end; index += 1) items.push(itemAt(index))
    return items
  }
}

function normalizedSliceRange(
  length: number,
  start: number | undefined,
  end: number | undefined,
): { readonly start: number; readonly end: number } {
  const normalizedStart = normalizeSliceIndex(length, start ?? 0)
  const normalizedEnd = normalizeSliceIndex(length, end ?? length)
  return { start: normalizedStart, end: normalizedEnd }
}

function normalizeSliceIndex(length: number, index: number): number {
  if (index < 0) return Math.max(0, length + index)
  return Math.min(length, index)
}

function arrayIndexProperty(property: string | symbol): number | null {
  if (typeof property !== 'string') return null
  if (property.length === 0) return null

  const index = Number(property)
  if (!Number.isSafeInteger(index)) return null
  if (index < 0) return null
  return String(index) === property ? index : null
}

function projectSortedTokenRanges(
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: TokenProjectionText,
  delta: number,
  prefixEnd: number,
  suffixStart: number,
  index: EditorTokenIndex,
  lineStructureChanged: boolean,
): readonly EditorToken[] {
  const builder = createTokenProjectionBuilder(tokens, prefixEnd, index)
  let keepsLiveRanges = true

  keepsLiveRanges = appendProjectedTokens(
    builder,
    tokens,
    edit,
    previousText,
    delta,
    prefixEnd,
    suffixStart,
    lineStructureChanged,
  )
  appendShiftedTokens(builder, tokens, suffixStart, tokens.length, delta)

  return finishTokenProjection(tokens, builder, keepsLiveRanges)
}

function appendUnchangedTokens(
  builder: TokenProjectionBuilder,
  tokens: readonly EditorToken[],
  start: number,
  end: number,
): void {
  for (let index = start; index < end; index += 1) {
    appendBuiltToken(builder, tokens[index]!)
  }
}

function appendProjectedTokens(
  builder: TokenProjectionBuilder,
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: TokenProjectionText,
  delta: number,
  start: number,
  end: number,
  lineStructureChanged: boolean,
): boolean {
  let keepsLiveRanges = true
  for (let index = start; index < end; index += 1) {
    const next = projectTokenThroughEdit(
      tokens[index]!,
      edit,
      previousText,
      delta,
      lineStructureChanged,
    )
    if (!isRenderableToken(next)) {
      keepsLiveRanges = false
      continue
    }

    appendBuiltToken(builder, next)
  }

  return keepsLiveRanges
}

function appendShiftedTokens(
  builder: TokenProjectionBuilder,
  tokens: readonly EditorToken[],
  start: number,
  end: number,
  delta: number,
): void {
  if (delta === 0) {
    appendUnchangedTokens(builder, tokens, start, end)
    return
  }

  for (let index = start; index < end; index += 1) {
    appendBuiltToken(builder, shiftToken(tokens[index]!, delta))
  }
}

function shiftedTokenRange(
  tokens: readonly EditorToken[],
  start: number,
  delta: number,
): EditorToken[] {
  if (start >= tokens.length) return []
  if (delta === 0) return tokens.slice(start) as EditorToken[]

  return Array.from({ length: tokens.length - start }, (_, index) =>
    shiftToken(tokens[start + index]!, delta),
  )
}

function appendSuffixIndexEntries(
  builder: TokenProjectionBuilder,
  suffixTokens: readonly EditorToken[],
): void {
  for (const token of suffixTokens) {
    if (token.start < builder.previousStart) builder.sortedByStart = false
    if (token.start < builder.previousEnd) builder.nonOverlapping = false
    if (token.end < builder.maxEnd) builder.monotonicEnd = false

    builder.maxEnd = Math.max(builder.maxEnd, token.end)
    builder.maxEnds.push(builder.maxEnd)
    builder.previousEnd = token.end
    builder.previousStart = token.start
  }
}

function suffixKeepsSortedStart(
  builder: TokenProjectionBuilder,
  suffixTokens: readonly EditorToken[],
): boolean {
  const first = suffixTokens[0]
  if (!first) return true
  return first.start >= builder.previousStart
}

function finishTokenProjection(
  sourceTokens: readonly EditorToken[],
  builder: TokenProjectionBuilder,
  keepsLiveRanges: boolean,
): readonly EditorToken[] {
  const projectedTokens = builder.tokens
  setEditorTokenIndex(projectedTokens, {
    maxEnds: builder.maxEnds,
    monotonicEnd: builder.monotonicEnd,
    nonOverlapping: builder.nonOverlapping,
    sortedByStart: builder.sortedByStart,
  })
  tokenProjectionMetadata.set(projectedTokens, { keepsLiveRanges, sourceTokens })
  return projectedTokens
}

function createTokenProjectionBuilder(
  tokens: readonly EditorToken[] = [],
  prefixEnd = 0,
  index?: EditorTokenIndex,
): TokenProjectionBuilder {
  if (prefixEnd > 0 && index) return createPrefixedTokenProjectionBuilder(tokens, prefixEnd, index)

  return {
    maxEnd: 0,
    maxEnds: [],
    monotonicEnd: true,
    nonOverlapping: true,
    previousEnd: -Infinity,
    previousStart: -Infinity,
    sortedByStart: true,
    tokens: [],
  }
}

function createContinuationTokenProjectionBuilder(
  previousToken: EditorToken | undefined,
  prefixMaxEnd: number,
  index: EditorTokenIndex,
): TokenProjectionBuilder {
  return {
    maxEnd: prefixMaxEnd,
    maxEnds: [],
    monotonicEnd: index.monotonicEnd,
    nonOverlapping: index.nonOverlapping,
    previousEnd: previousToken?.end ?? -Infinity,
    previousStart: previousToken?.start ?? -Infinity,
    sortedByStart: true,
    tokens: [],
  }
}

function createPrefixedTokenProjectionBuilder(
  tokens: readonly EditorToken[],
  prefixEnd: number,
  index: EditorTokenIndex,
): TokenProjectionBuilder {
  const prefixTokens = tokens.slice(0, prefixEnd)
  const prefixMaxEnds = index.maxEnds.slice(0, prefixEnd) as number[]
  const maxEnd = prefixMaxEnds[prefixMaxEnds.length - 1] ?? 0

  return {
    maxEnd,
    maxEnds: prefixMaxEnds,
    monotonicEnd: index.monotonicEnd,
    nonOverlapping: index.nonOverlapping,
    previousEnd: prefixTokens[prefixEnd - 1]?.end ?? -Infinity,
    previousStart: prefixTokens[prefixEnd - 1]?.start ?? -Infinity,
    sortedByStart: true,
    tokens: prefixTokens,
  }
}

function appendBuiltToken(builder: TokenProjectionBuilder, token: EditorToken): void {
  appendEditorTokenIndexEntry(builder, token)
  builder.tokens.push(token)
}

function unchangedPrefixEnd(index: EditorTokenIndex, edit: TextEdit): number {
  if (edit.from === edit.to) return firstTokenEndingAtOrAfter(index, edit.from)
  return firstTokenEndingAfter(index, edit.from)
}

function shiftedSuffixStart(tokens: readonly EditorToken[], edit: TextEdit): number {
  if (edit.from === edit.to) return firstTokenStartingAfter(tokens, edit.from)
  return firstTokenStartingAtOrAfter(tokens, edit.to)
}

function firstTokenEndingAfter(index: EditorTokenIndex, offset: number): number {
  let low = 0
  let high = index.maxEnds.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (index.maxEnds[middle]! > offset) {
      high = middle
      continue
    }

    low = middle + 1
  }

  return low
}

function firstTokenEndingAtOrAfter(index: EditorTokenIndex, offset: number): number {
  let low = 0
  let high = index.maxEnds.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (index.maxEnds[middle]! >= offset) {
      high = middle
      continue
    }

    low = middle + 1
  }

  return low
}

function firstTokenStartingAtOrAfter(tokens: readonly EditorToken[], offset: number): number {
  let low = 0
  let high = tokens.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (tokens[middle]!.start >= offset) {
      high = middle
      continue
    }

    low = middle + 1
  }

  return low
}

function firstTokenStartingAfter(tokens: readonly EditorToken[], offset: number): number {
  let low = 0
  let high = tokens.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (tokens[middle]!.start > offset) {
      high = middle
      continue
    }

    low = middle + 1
  }

  return low
}

function editChangesLineStructure(edit: TextEdit, previousText: TokenProjectionText): boolean {
  if (edit.text.includes('\n')) return true
  if (edit.to <= edit.from) return false
  return getProjectionTextInRange(previousText, edit.from, edit.to).includes('\n')
}

function projectTokenThroughEdit(
  token: EditorToken,
  edit: TextEdit,
  previousText: TokenProjectionText,
  delta: number,
  lineStructureChanged: boolean,
): EditorToken | null {
  if (lineStructureChanged) return projectTokenThroughLineEdit(token, edit, delta)
  if (edit.from === edit.to) return projectTokenThroughInsertion(token, edit, previousText)
  if (token.end <= edit.from) return token
  if (token.start >= edit.to) return shiftToken(token, delta)
  if (!canResizeTokenAcrossEdit(token, edit)) return null

  return { ...token, end: token.end + delta }
}

function projectTokenThroughLineEdit(
  token: EditorToken,
  edit: TextEdit,
  delta: number,
): EditorToken | null {
  if (edit.from === edit.to) {
    return projectTokenThroughLineInsertion(token, edit.from, edit.text.length)
  }
  if (token.end <= edit.from) return token
  if (token.start >= edit.to) return shiftToken(token, delta)
  return null
}

function projectTokenThroughLineInsertion(
  token: EditorToken,
  offset: number,
  insertedLength: number,
): EditorToken | null {
  if (token.end <= offset) return token
  if (token.start >= offset) return shiftToken(token, insertedLength)
  return null
}

function projectTokenThroughInsertion(
  token: EditorToken,
  edit: TextEdit,
  previousText: TokenProjectionText,
): EditorToken {
  if (shouldExpandTokenForInsertion(token, edit, previousText)) {
    return { ...token, end: token.end + edit.text.length }
  }
  if (token.start >= edit.from) return shiftToken(token, edit.text.length)

  return token
}

function canResizeTokenAcrossEdit(token: EditorToken, edit: TextEdit): boolean {
  if (edit.text.includes('\n')) return false
  return token.start < edit.from && edit.to < token.end
}

function shouldExpandTokenForInsertion(
  token: EditorToken,
  edit: TextEdit,
  previousText: TokenProjectionText,
): boolean {
  if (edit.text.length === 0) return false
  if (edit.text.includes('\n')) return false
  if (token.start < edit.from && edit.from < token.end) return true
  if (!isWordLikeText(edit.text)) return false
  if (token.end === edit.from) return isWordBeforeOffset(previousText, edit.from)
  if (token.start === edit.from) {
    return (
      !isWordBeforeOffset(previousText, edit.from) && isWordCodePointAt(previousText, edit.from)
    )
  }

  return false
}

function shiftToken(token: EditorToken, delta: number): EditorToken {
  return {
    ...token,
    start: token.start + delta,
    end: token.end + delta,
  }
}

function isRenderableToken(token: EditorToken | null): token is EditorToken {
  if (!token) return false
  return token.end > token.start
}

function isWordLikeText(text: string): boolean {
  return /^[\p{L}\p{N}_]+$/u.test(text)
}

function isWordBeforeOffset(text: TokenProjectionText, offset: number): boolean {
  const previous = previousCodePointBeforeOffset(text, offset)
  if (previous === null) return false
  return isWordText(previous)
}

function isWordCodePointAt(text: TokenProjectionText, offset: number): boolean {
  const codePointText = codePointAtOffset(text, offset)
  if (codePointText === null) return false
  return isWordText(codePointText)
}

function isWordText(text: string): boolean {
  const codePoint = text.codePointAt(0)
  if (codePoint === undefined) return false
  return /^[\p{L}\p{N}_]$/u.test(String.fromCodePoint(codePoint))
}

function previousCodePointBeforeOffset(text: TokenProjectionText, offset: number): string | null {
  if (offset <= 0) return null

  const previousText = getProjectionTextInRange(text, Math.max(0, offset - 2), offset)
  if (previousText.length === 0) return null

  const previous = previousText.length - 1
  const codeUnit = previousText.charCodeAt(previous)
  const beforePrevious = previous - 1
  const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff
  if (!isLowSurrogate || beforePrevious < 0) return previousText[previous] ?? null

  const previousCodeUnit = previousText.charCodeAt(beforePrevious)
  const isHighSurrogate = previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff
  if (!isHighSurrogate) return previousText[previous] ?? null

  return previousText.slice(beforePrevious)
}

function codePointAtOffset(text: TokenProjectionText, offset: number): string | null {
  const length = projectionTextLength(text)
  if (offset < 0 || offset >= length) return null

  const codePointText = getProjectionTextInRange(text, offset, Math.min(offset + 2, length))
  const codePoint = codePointText.codePointAt(0)
  if (codePoint === undefined) return null
  return String.fromCodePoint(codePoint)
}

function projectionTextLength(text: TokenProjectionText): number {
  return typeof text === 'string' ? text.length : text.length
}

function getProjectionTextInRange(text: TokenProjectionText, start: number, end: number): string {
  if (typeof text === 'string') return text.slice(start, end)
  return text.readRange(start, end)
}

function recordTokenProjectionPath(
  path: TokenProjectionPath,
  tokens: readonly EditorToken[],
  prefixEnd: number,
  suffixStart: number,
  index?: EditorTokenIndex,
  extra?: Readonly<Record<string, unknown>>,
): void {
  recordEditorPerformanceDiagnostic('editor.tokenProjection.path', () => ({
    affectedCount: Math.max(0, suffixStart - prefixEnd),
    monotonicEnd: index?.monotonicEnd ?? null,
    nonOverlapping: index?.nonOverlapping ?? null,
    path,
    prefixCount: prefixEnd,
    resultCount: extra?.resultCount,
    suffixCount: Math.max(0, tokens.length - suffixStart),
    tokenCount: tokens.length,
  }))
}
