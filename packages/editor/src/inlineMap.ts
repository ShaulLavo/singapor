import { anchorAfter, anchorBefore, resolveAnchor } from './pieceTable/anchors'
import {
  createInlineRow,
  type InlineReplacement,
  type InlineRow,
  type InvalidatedRange,
  inlineColumnToSourceColumn,
  sourceColumnToInlineColumn,
  type TransformBias,
} from './displayTransforms'
import type {
  Anchor as PieceTableAnchor,
  PieceTableEdit,
  PieceTableSnapshot,
  Point,
} from './pieceTable/pieceTableTypes'
import { offsetToPoint } from './pieceTable/positions'
import type { TextOffsetRange } from './textRanges'

declare const inlinePointBrand: unique symbol

export type InlinePoint = Point & {
  readonly [inlinePointBrand]: true
}

export type InlineReplacementSpec = {
  readonly id: string
  readonly startIndex: number
  readonly endIndex: number
  readonly text: string
  readonly kind?: string
  /** Replacements sharing a group reveal together, so both `**` fences of one construct unhide. */
  readonly groupId?: string
  readonly metadata?: unknown
}

export type InlineReplacementRange = {
  readonly id: string
  readonly start: PieceTableAnchor
  readonly end: PieceTableAnchor
  readonly startOffset: number
  readonly endOffset: number
  readonly startPoint: Point
  readonly endPoint: Point
  readonly text: string
  readonly kind?: string
  readonly groupId?: string
  readonly metadata?: unknown
}

export type InlineMap = {
  readonly snapshot: PieceTableSnapshot
  readonly ranges: readonly InlineReplacementRange[]
  readonly rowReplacements: ReadonlyMap<number, readonly InlineReplacement[]>
}

type InlineMapInvalidationReason = 'external-edit' | 'replacement-changed' | 'replacement-dropped'

type InlineMapInvalidatedRange = InvalidatedRange<InlinePoint> & {
  readonly reason: InlineMapInvalidationReason
}

export type InlineMapUpdate = {
  readonly map: InlineMap
  readonly invalidations: readonly InlineMapInvalidatedRange[]
}

const EMPTY_REPLACEMENTS: readonly InlineReplacement[] = []

export const createInlineMap = (
  snapshot: PieceTableSnapshot,
  specs: readonly InlineReplacementSpec[],
): InlineMap => {
  const ranges = specs
    .map((spec) => inlineRangeFromSpec(snapshot, spec))
    .filter((range) => range !== null)

  return inlineMapFromRanges(snapshot, ranges)
}

export const updateInlineMapForEdit = (
  map: InlineMap,
  edit: PieceTableEdit,
  nextSnapshot: PieceTableSnapshot,
): InlineMapUpdate => {
  const nextMap = inlineMapFromRanges(nextSnapshot, map.ranges)

  return { map: nextMap, invalidations: invalidateInlineMapEdit(map, edit, nextMap) }
}

/**
 * Drops every replacement the given ranges touch, along with the rest of each touched group. Feeding
 * the caret and selections through this is what makes markdown source reappear under the cursor:
 * mapping and painting both read the revealed map, so they can never disagree about what is hidden.
 */
export const revealInlineMap = (map: InlineMap, ranges: readonly TextOffsetRange[]): InlineMap => {
  if (ranges.length === 0) return map

  const revealedIds = new Set<string>()
  const revealedGroups = new Set<string>()
  const groupSpans = inlineGroupSpans(map.ranges)

  for (const range of map.ranges) {
    const span = revealSpanForRange(range, groupSpans)
    if (!ranges.some((target) => spanTouchesOffsetRange(span, target))) continue
    revealedIds.add(range.id)
    if (range.groupId !== undefined) revealedGroups.add(range.groupId)
  }

  if (revealedIds.size === 0) return map

  const remaining = map.ranges.filter((range) => {
    if (revealedIds.has(range.id)) return false
    return range.groupId === undefined || !revealedGroups.has(range.groupId)
  })

  return inlineMapFromRanges(map.snapshot, remaining)
}

export const inlineReplacementsForBufferRow = (
  map: InlineMap,
  bufferRow: number,
): readonly InlineReplacement[] => map.rowReplacements.get(bufferRow) ?? EMPTY_REPLACEMENTS

export const inlineRowForBufferRow = (
  map: InlineMap,
  bufferRow: number,
  sourceText: string,
): InlineRow => createInlineRow(sourceText, inlineReplacementsForBufferRow(map, bufferRow))

export const bufferPointToInlinePoint = (
  row: InlineRow,
  point: Point,
  bias: TransformBias = 'nearest',
): InlinePoint =>
  asInlinePoint({ row: point.row, column: sourceColumnToInlineColumn(row, point.column, bias) })

export const inlinePointToBufferPoint = (
  row: InlineRow,
  point: InlinePoint,
  bias: TransformBias = 'nearest',
): Point => ({ row: point.row, column: inlineColumnToSourceColumn(row, point.column, bias) })

const inlineMapFromRanges = (
  snapshot: PieceTableSnapshot,
  ranges: readonly InlineReplacementRange[],
): InlineMap => {
  const normalized = normalizeInlineRanges(snapshot, ranges)

  return { snapshot, ranges: normalized, rowReplacements: rowReplacementIndex(normalized) }
}

/**
 * Replacements do not absorb edits at their edges: the start anchors right and the end anchors left,
 * so text typed immediately before or after `**bold**` lands outside the hidden markers rather than
 * inside them. This is deliberately the opposite of FoldMap, whose ranges grow at their boundaries.
 */
const inlineRangeFromSpec = (
  snapshot: PieceTableSnapshot,
  spec: InlineReplacementSpec,
): InlineReplacementRange | null => {
  const startOffset = clampOffset(snapshot, Math.min(spec.startIndex, spec.endIndex))
  const endOffset = clampOffset(snapshot, Math.max(spec.startIndex, spec.endIndex))
  if (endOffset <= startOffset) return null
  if (spec.id.length === 0) return null

  const anchors = inlineAnchorPair(snapshot, startOffset, endOffset)
  if (!anchors) return null

  return {
    id: spec.id,
    start: anchors.start,
    end: anchors.end,
    startOffset,
    endOffset,
    startPoint: offsetToPoint(snapshot, startOffset),
    endPoint: offsetToPoint(snapshot, endOffset),
    text: spec.text,
    ...(spec.kind === undefined ? {} : { kind: spec.kind }),
    ...(spec.groupId === undefined ? {} : { groupId: spec.groupId }),
    ...(spec.metadata === undefined ? {} : { metadata: spec.metadata }),
  }
}

const inlineAnchorPair = (
  snapshot: PieceTableSnapshot,
  startOffset: number,
  endOffset: number,
): { readonly start: PieceTableAnchor; readonly end: PieceTableAnchor } | null => {
  try {
    return { start: anchorAfter(snapshot, startOffset), end: anchorBefore(snapshot, endOffset) }
  } catch {
    // anchorAt rejects offsets that split a surrogate pair. A replacement that cannot be anchored is
    // dropped so one bad range from a grammar cannot throw through the transform layer.
    return null
  }
}

const normalizeInlineRanges = (
  snapshot: PieceTableSnapshot,
  ranges: readonly InlineReplacementRange[],
): readonly InlineReplacementRange[] => {
  const resolved = ranges
    .map((range) => resolveInlineRange(snapshot, range))
    .filter((range) => range !== null)
    .filter((range) => range.startPoint.row === range.endPoint.row)
    .filter((range) => !range.text.includes('\n'))
    .toSorted((left, right) => {
      return (
        left.startOffset - right.startOffset ||
        right.endOffset - left.endOffset ||
        left.id.localeCompare(right.id)
      )
    })

  const kept: InlineReplacementRange[] = []
  for (const range of resolved) {
    const previous = kept.at(-1)
    if (previous && range.startOffset < previous.endOffset) continue
    kept.push(range)
  }

  return kept
}

const resolveInlineRange = (
  snapshot: PieceTableSnapshot,
  range: InlineReplacementRange,
): InlineReplacementRange | null => {
  const start = resolveAnchor(snapshot, range.start)
  const end = resolveAnchor(snapshot, range.end)
  if (start.liveness === 'deleted' || end.liveness === 'deleted') return null
  if (end.offset <= start.offset) return null

  return {
    ...range,
    startOffset: start.offset,
    endOffset: end.offset,
    startPoint: offsetToPoint(snapshot, start.offset),
    endPoint: offsetToPoint(snapshot, end.offset),
  }
}

const rowReplacementIndex = (
  ranges: readonly InlineReplacementRange[],
): ReadonlyMap<number, readonly InlineReplacement[]> => {
  const index = new Map<number, InlineReplacement[]>()

  for (const range of ranges) {
    replacementsAtBufferRow(index, range.startPoint.row).push(inlineReplacementFromRange(range))
  }

  return index
}

const replacementsAtBufferRow = (
  index: Map<number, InlineReplacement[]>,
  bufferRow: number,
): InlineReplacement[] => {
  const existing = index.get(bufferRow)
  if (existing) return existing

  const replacements: InlineReplacement[] = []
  index.set(bufferRow, replacements)
  return replacements
}

const inlineReplacementFromRange = (range: InlineReplacementRange): InlineReplacement => ({
  id: range.id,
  startColumn: range.startPoint.column,
  endColumn: range.endPoint.column,
  text: range.text,
  ...(range.kind === undefined ? {} : { kind: range.kind }),
  ...(range.metadata === undefined ? {} : { metadata: range.metadata }),
})

const invalidateInlineMapEdit = (
  map: InlineMap,
  edit: PieceTableEdit,
  nextMap: InlineMap,
): readonly InlineMapInvalidatedRange[] => {
  if (isEditAbsorbedByHiddenRange(map, edit, nextMap)) return []

  const touched = map.ranges
    .filter((range) => editTouchesInlineRange(edit, range))
    .map((range) => touchedRangeInvalidation(range, nextMap))

  return mergeInlineInvalidations([...touched, externalEditInvalidation(map, edit)])
}

/**
 * An edit wholly inside a hidden span changes no display column on any row, so the layer above has
 * nothing to repaint. This is the inline analogue of FoldMap absorbing edits inside a fold interior.
 */
const isEditAbsorbedByHiddenRange = (
  map: InlineMap,
  edit: PieceTableEdit,
  nextMap: InlineMap,
): boolean => {
  if (countLineBreaks(edit.text) !== 0) return false

  return map.ranges.some((range) => {
    if (range.text.length !== 0) return false
    if (edit.from <= range.startOffset) return false
    if (edit.to >= range.endOffset) return false
    return inlineRangeSurvives(nextMap, range)
  })
}

const touchedRangeInvalidation = (
  range: InlineReplacementRange,
  nextMap: InlineMap,
): InlineMapInvalidatedRange => ({
  start: asInlinePoint({ row: range.startPoint.row, column: 0 }),
  end: asInlinePoint({ row: range.startPoint.row + 1, column: 0 }),
  // The inline layer never adds or removes rows; row deltas ride on the external-edit invalidation.
  lineCountDelta: 0,
  reason: inlineRangeSurvives(nextMap, range) ? 'replacement-changed' : 'replacement-dropped',
})

const externalEditInvalidation = (
  map: InlineMap,
  edit: PieceTableEdit,
): InlineMapInvalidatedRange => {
  const start = offsetToPoint(map.snapshot, edit.from)
  const end = offsetToPoint(map.snapshot, edit.to)

  return {
    start: asInlinePoint({ row: start.row, column: 0 }),
    end: asInlinePoint({ row: end.row + 1, column: 0 }),
    lineCountDelta: countLineBreaks(edit.text) - (end.row - start.row),
    reason: 'external-edit',
  }
}

const editTouchesInlineRange = (edit: PieceTableEdit, range: InlineReplacementRange): boolean => {
  if (edit.to < range.startOffset) return false
  return edit.from <= range.endOffset
}

const inlineRangeSurvives = (map: InlineMap, range: InlineReplacementRange): boolean =>
  map.ranges.some((candidate) => candidate.id === range.id)

/**
 * Reveal is construct-scoped, not marker-scoped: a caret anywhere between the first and last
 * replacement of a group counts as touching all of them, so putting the cursor inside `bold` unhides
 * the `**` fences on both sides rather than only the one it happens to sit next to.
 */
const inlineGroupSpans = (
  ranges: readonly InlineReplacementRange[],
): ReadonlyMap<string, TextOffsetRange> => {
  const spans = new Map<string, TextOffsetRange>()

  for (const range of ranges) {
    if (range.groupId === undefined) continue
    const existing = spans.get(range.groupId)
    spans.set(range.groupId, {
      start: existing ? Math.min(existing.start, range.startOffset) : range.startOffset,
      end: existing ? Math.max(existing.end, range.endOffset) : range.endOffset,
    })
  }

  return spans
}

const revealSpanForRange = (
  range: InlineReplacementRange,
  groupSpans: ReadonlyMap<string, TextOffsetRange>,
): TextOffsetRange => {
  const span = range.groupId === undefined ? undefined : groupSpans.get(range.groupId)
  return span ?? { start: range.startOffset, end: range.endOffset }
}

const spanTouchesOffsetRange = (span: TextOffsetRange, target: TextOffsetRange): boolean => {
  const low = Math.min(target.start, target.end)
  const high = Math.max(target.start, target.end)
  if (high < span.start) return false
  return low <= span.end
}

const mergeInlineInvalidations = (
  invalidations: readonly InlineMapInvalidatedRange[],
): readonly InlineMapInvalidatedRange[] => {
  const sorted = invalidations.toSorted((left, right) => left.start.row - right.start.row)
  const merged: InlineMapInvalidatedRange[] = []

  for (const invalidation of sorted) {
    appendInlineInvalidation(merged, invalidation)
  }

  return merged
}

const appendInlineInvalidation = (
  invalidations: InlineMapInvalidatedRange[],
  invalidation: InlineMapInvalidatedRange,
): void => {
  const previous = invalidations.at(-1)
  if (!previous || invalidation.start.row > previous.end.row) {
    invalidations.push(invalidation)
    return
  }

  invalidations[invalidations.length - 1] = {
    start: previous.start,
    end: previous.end.row >= invalidation.end.row ? previous.end : invalidation.end,
    lineCountDelta: previous.lineCountDelta + invalidation.lineCountDelta,
    reason: strongerInvalidationReason(previous.reason, invalidation.reason),
  }
}

const INVALIDATION_REASON_RANK: Record<InlineMapInvalidationReason, number> = {
  'external-edit': 0,
  'replacement-changed': 1,
  'replacement-dropped': 2,
}

/** Merging must not bury why a row changed; the most specific reason wins. */
const strongerInvalidationReason = (
  left: InlineMapInvalidationReason,
  right: InlineMapInvalidationReason,
): InlineMapInvalidationReason =>
  INVALIDATION_REASON_RANK[right] > INVALIDATION_REASON_RANK[left] ? right : left

const countLineBreaks = (text: string): number => {
  let count = 0

  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') count++
  }

  return count
}

const clampOffset = (snapshot: PieceTableSnapshot, offset: number): number =>
  Math.max(0, Math.min(offset, snapshot.length))

const asInlinePoint = (point: Point): InlinePoint => point as InlinePoint
