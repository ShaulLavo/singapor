import type {
  Anchor as PieceTableAnchor,
  AnchorBias,
  AnchorLiveness,
  PieceTableSnapshot,
} from './pieceTable/pieceTableTypes'
import { anchorAt, resolveAnchor } from './pieceTable/anchors'

export type SelectionGoal =
  | { readonly kind: 'none' }
  | { readonly kind: 'horizontal'; readonly x: number }
  | { readonly kind: 'horizontalRange'; readonly anchorX: number; readonly headX: number }

export const SelectionGoal = {
  none: (): SelectionGoal => ({ kind: 'none' }),
  horizontal: (x: number): SelectionGoal => ({ kind: 'horizontal', x }),
  horizontalRange: (anchorX: number, headX: number): SelectionGoal => ({
    kind: 'horizontalRange',
    anchorX,
    headX,
  }),
} as const

export type Selection<T> = {
  readonly id: string
  readonly start: T
  readonly end: T
  readonly reversed: boolean
  readonly goal: SelectionGoal
}

export type AnchorSelection = Selection<PieceTableAnchor>

export type SelectionSet<T> = {
  readonly selections: readonly Selection<T>[]
  readonly normalized: boolean
  readonly normalizedFor?: PieceTableSnapshot
}

export type ResolvedSelection = {
  readonly id: string
  readonly startOffset: number
  readonly endOffset: number
  readonly anchorOffset: number
  readonly headOffset: number
  readonly reversed: boolean
  readonly collapsed: boolean
  readonly goal: SelectionGoal
  readonly liveness: AnchorLiveness
  readonly startLiveness: AnchorLiveness
  readonly endLiveness: AnchorLiveness
}

export type CreateAnchorSelectionOptions = {
  readonly id?: string
  readonly idFactory?: SelectionIdFactory
  readonly goal?: SelectionGoal
  readonly cursorBias?: AnchorBias
  readonly reversed?: boolean
}

export type SelectionIdFactory = () => string

type OffsetRange = {
  readonly start: number
  readonly end: number
}

type ResolvedSelectionWithSource = ResolvedSelection & {
  readonly source: AnchorSelection
}

export const createSelectionIdFactory = (prefix = 'selection'): SelectionIdFactory => {
  let nextSelectionId = 0
  return () => `${prefix}:${nextSelectionId++}`
}

const createFallbackSelectionId = (
  anchorOffset: number,
  headOffset: number,
  reversed: boolean,
): string => {
  const direction = reversed ? 'reversed' : 'forward'
  return `selection:${anchorOffset}:${headOffset}:${direction}`
}

const orderOffsets = (first: number, second: number): OffsetRange => ({
  start: Math.min(first, second),
  end: Math.max(first, second),
})

const resolvedSelectionRange = (selection: ResolvedSelection): OffsetRange => ({
  start: selection.startOffset,
  end: selection.endOffset,
})

const lastItem = <T>(items: readonly T[]): T | null => {
  if (items.length === 0) return null
  return items[items.length - 1] ?? null
}

const isLiveSelection = (
  startLiveness: AnchorLiveness,
  endLiveness: AnchorLiveness,
): AnchorLiveness => {
  if (startLiveness === 'live' && endLiveness === 'live') return 'live'
  return 'deleted'
}

const createEndpointAnchors = (
  snapshot: PieceTableSnapshot,
  range: OffsetRange,
  cursorBias: AnchorBias,
): { start: PieceTableAnchor; end: PieceTableAnchor } => {
  if (range.start === range.end) {
    const cursor = anchorAt(snapshot, range.start, cursorBias)
    return { start: cursor, end: cursor }
  }

  return {
    start: anchorAt(snapshot, range.start, 'left'),
    end: anchorAt(snapshot, range.end, 'right'),
  }
}

export const createAnchorSelection = (
  snapshot: PieceTableSnapshot,
  anchorOffset: number,
  headOffset = anchorOffset,
  options: CreateAnchorSelectionOptions = {},
): AnchorSelection => {
  const range = orderOffsets(anchorOffset, headOffset)
  const cursorBias = options.cursorBias ?? 'right'
  const endpoints = createEndpointAnchors(snapshot, range, cursorBias)
  const collapsed = range.start === range.end
  const reversed = collapsed ? false : (options.reversed ?? headOffset < anchorOffset)
  const id =
    options.id ??
    options.idFactory?.() ??
    createFallbackSelectionId(anchorOffset, headOffset, reversed)

  return {
    id,
    start: endpoints.start,
    end: endpoints.end,
    reversed,
    goal: options.goal ?? SelectionGoal.none(),
  }
}

export const createSelectionSet = <T>(
  selections: readonly Selection<T>[],
  normalized = false,
  normalizedFor?: PieceTableSnapshot,
): SelectionSet<T> => ({
  selections,
  normalized,
  normalizedFor: normalized ? normalizedFor : undefined,
})

export const markSelectionSetDirty = <T>(set: SelectionSet<T>): SelectionSet<T> => ({
  selections: set.selections,
  normalized: false,
  normalizedFor: undefined,
})

export const resolveSelection = (
  snapshot: PieceTableSnapshot,
  selection: AnchorSelection,
): ResolvedSelection => {
  const start = resolveAnchor(snapshot, selection.start)
  const end = resolveAnchor(snapshot, selection.end)
  const range = orderOffsets(start.offset, end.offset)
  const collapsed = range.start === range.end
  const reversed = collapsed ? false : selection.reversed

  return {
    id: selection.id,
    startOffset: range.start,
    endOffset: range.end,
    anchorOffset: reversed ? range.end : range.start,
    headOffset: reversed ? range.start : range.end,
    reversed,
    collapsed,
    goal: selection.goal,
    liveness: isLiveSelection(start.liveness, end.liveness),
    startLiveness: start.liveness,
    endLiveness: end.liveness,
  }
}

const resolveSelectionWithSource = (
  snapshot: PieceTableSnapshot,
  selection: AnchorSelection,
): ResolvedSelectionWithSource => ({
  ...resolveSelection(snapshot, selection),
  source: selection,
})

const compareResolvedSelections = (
  left: ResolvedSelectionWithSource,
  right: ResolvedSelectionWithSource,
): number => {
  if (left.startOffset !== right.startOffset) return left.startOffset - right.startOffset
  if (left.endOffset !== right.endOffset) return left.endOffset - right.endOffset
  return left.id.localeCompare(right.id)
}

const shouldMergeRanges = (left: OffsetRange, right: OffsetRange): boolean =>
  right.start <= left.end

const selectionFromResolved = (
  snapshot: PieceTableSnapshot,
  resolved: ResolvedSelectionWithSource,
): AnchorSelection =>
  createAnchorSelection(snapshot, resolved.anchorOffset, resolved.headOffset, {
    id: resolved.id,
    goal: resolved.goal,
    reversed: resolved.reversed,
  })

const normalizeResolvedSelection = (
  snapshot: PieceTableSnapshot,
  resolved: ResolvedSelectionWithSource,
): ResolvedSelectionWithSource => {
  const source = selectionFromResolved(snapshot, resolved)
  return {
    ...resolveSelection(snapshot, source),
    source,
  }
}

const mergeResolvedSelections = (
  snapshot: PieceTableSnapshot,
  left: ResolvedSelectionWithSource,
  right: ResolvedSelectionWithSource,
): ResolvedSelectionWithSource => {
  const startOffset = Math.min(left.startOffset, right.startOffset)
  const endOffset = Math.max(left.endOffset, right.endOffset)
  const source = createAnchorSelection(snapshot, startOffset, endOffset, {
    id: left.id,
    goal: SelectionGoal.none(),
    reversed: false,
  })

  return {
    ...resolveSelection(snapshot, source),
    source,
  }
}

const normalizeSelections = (
  snapshot: PieceTableSnapshot,
  selections: readonly AnchorSelection[],
): AnchorSelection[] => {
  const resolved = selections.map((selection) => resolveSelectionWithSource(snapshot, selection))
  const sorted = resolved.toSorted(compareResolvedSelections)
  const normalized: ResolvedSelectionWithSource[] = []

  for (const selection of sorted) {
    const previous = lastItem(normalized)
    if (!previous) {
      normalized.push(normalizeResolvedSelection(snapshot, selection))
      continue
    }

    if (!shouldMergeRanges(resolvedSelectionRange(previous), resolvedSelectionRange(selection))) {
      normalized.push(normalizeResolvedSelection(snapshot, selection))
      continue
    }

    normalized[normalized.length - 1] = mergeResolvedSelections(snapshot, previous, selection)
  }

  return normalized.map((selection) => selection.source)
}

export const normalizeSelectionSet = (
  snapshot: PieceTableSnapshot,
  set: SelectionSet<PieceTableAnchor>,
): SelectionSet<PieceTableAnchor> => {
  if (set.normalized && set.normalizedFor === snapshot) return set

  return {
    selections: normalizeSelections(snapshot, set.selections),
    normalized: true,
    normalizedFor: snapshot,
  }
}
