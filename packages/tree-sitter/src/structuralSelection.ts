import type { PieceTableSnapshot, TextOffsetRange } from '@singapor/core/document'
import type { FoldRange } from '@singapor/core/syntax'
import {
  createAnchorSelection,
  createSelectionSet,
  normalizeSelectionSet,
  type PieceTableAnchor,
  resolveSelection,
  type SelectionSet,
} from '@singapor/core/internal'
import type { TreeSitterBackend } from './treeSitter/workerClient'
import type {
  TreeSitterLanguageId,
  TreeSitterSelectionRange,
  TreeSitterSelectionResult,
} from './treeSitter/types'

export type TreeSitterSelectionExpansionState = {
  readonly snapshotVersion: number
  readonly stacks: readonly (readonly TreeSitterSelectionRange[])[]
}

export type TreeSitterSelectionCommandOptions = {
  readonly documentId: string
  readonly languageId: TreeSitterLanguageId
  readonly snapshotVersion: number
  readonly snapshot: PieceTableSnapshot
  readonly selections: SelectionSet<PieceTableAnchor>
  readonly backend: Pick<TreeSitterBackend, 'select'>
  readonly state?: TreeSitterSelectionExpansionState
}

export type TreeSitterSelectionCommandResult = {
  readonly selections: SelectionSet<PieceTableAnchor>
  readonly state: TreeSitterSelectionExpansionState
  readonly status: 'ok' | 'stale'
}

/**
 * The nesting the grammar found, as one unordered bucket for the editor's selection ladder to rank.
 *
 * Fold ranges are node ranges the parse has already published, so expand climbs exactly the nesting
 * the gutter offers to collapse rather than a second, differently shaped idea of what encloses what.
 * The fold query only reports nodes that span lines, so a construct written on one line is left to
 * the word and line rungs.
 */
export const treeSitterSelectionRanges = (
  folds: readonly FoldRange[],
): readonly TextOffsetRange[] =>
  folds.map((fold) => ({ start: fold.startIndex, end: fold.endIndex }))

export const selectTreeSitterToken = async (
  options: TreeSitterSelectionCommandOptions,
): Promise<TreeSitterSelectionCommandResult> => {
  const result = await requestSelectionRanges(options, 'selectToken')
  return selectionCommandResult(options, result, (range) => [range])
}

export const expandTreeSitterSelection = async (
  options: TreeSitterSelectionCommandOptions,
): Promise<TreeSitterSelectionCommandResult> => {
  const result = await requestSelectionRanges(options, 'expand')
  const selected = rangesFromSelectionSet(options.snapshot, options.selections)
  return selectionCommandResult(options, result, (range, index) => {
    const stack = stackForSelection(options, index, selected[index])
    const previous = stack.at(-1)
    if (previous && rangesEqual(previous, range)) return stack
    return [...stack, range]
  })
}

export const shrinkTreeSitterSelection = (
  options: TreeSitterSelectionCommandOptions,
): TreeSitterSelectionCommandResult => {
  const ranges = rangesFromShrinkState(options)
  if (!ranges) return noOpSelectionCommandResult(options, 'stale')

  return {
    selections: selectionSetFromRanges(options.snapshot, options.selections, ranges),
    state: {
      snapshotVersion: options.snapshotVersion,
      stacks: options.state!.stacks.map((stack) => stack.slice(0, -1)),
    },
    status: 'ok',
  }
}

const requestSelectionRanges = (
  options: TreeSitterSelectionCommandOptions,
  action: 'selectToken' | 'expand',
): Promise<TreeSitterSelectionResult | undefined> =>
  options.backend.select({
    documentId: options.documentId,
    languageId: options.languageId,
    snapshotVersion: options.snapshotVersion,
    action,
    ranges: rangesFromSelectionSet(options.snapshot, options.selections),
  })

const selectionCommandResult = (
  options: TreeSitterSelectionCommandOptions,
  result: TreeSitterSelectionResult | undefined,
  nextStack: (
    range: TreeSitterSelectionRange,
    index: number,
  ) => readonly TreeSitterSelectionRange[],
): TreeSitterSelectionCommandResult => {
  if (!result || result.status === 'stale') return noOpSelectionCommandResult(options, 'stale')

  return {
    selections: selectionSetFromRanges(options.snapshot, options.selections, result.ranges),
    state: {
      snapshotVersion: options.snapshotVersion,
      stacks: result.ranges.map(nextStack),
    },
    status: 'ok',
  }
}

const noOpSelectionCommandResult = (
  options: TreeSitterSelectionCommandOptions,
  status: 'ok' | 'stale',
): TreeSitterSelectionCommandResult => ({
  selections: options.selections,
  state: options.state ?? {
    snapshotVersion: options.snapshotVersion,
    stacks: rangesFromSelectionSet(options.snapshot, options.selections).map((range) => [range]),
  },
  status,
})

const rangesFromSelectionSet = (
  snapshot: PieceTableSnapshot,
  set: SelectionSet<PieceTableAnchor>,
): TreeSitterSelectionRange[] => {
  const normalized = normalizeSelectionSet(snapshot, set)
  return normalized.selections.map((selection) => {
    const resolved = resolveSelection(snapshot, selection)
    return {
      startIndex: resolved.startOffset,
      endIndex: resolved.endOffset,
    }
  })
}

const selectionSetFromRanges = (
  snapshot: PieceTableSnapshot,
  original: SelectionSet<PieceTableAnchor>,
  ranges: readonly TreeSitterSelectionRange[],
): SelectionSet<PieceTableAnchor> => {
  const selections = ranges.map((range, index) => {
    const source = original.selections[index]
    return createAnchorSelection(snapshot, range.startIndex, range.endIndex, {
      affinity: source?.affinity,
      id: source?.id,
      // Which end leads is the user's, not the tree's: a selection dragged right to left keeps
      // growing away from its anchor.
      reversed: source?.reversed ?? false,
    })
  })

  return createSelectionSet(selections, true, snapshot)
}

const rangesFromShrinkState = (
  options: TreeSitterSelectionCommandOptions,
): readonly TreeSitterSelectionRange[] | null => {
  if (!options.state) return null
  if (options.state.snapshotVersion !== options.snapshotVersion) return null

  const selected = rangesFromSelectionSet(options.snapshot, options.selections)
  if (options.state.stacks.length !== selected.length) return null

  const ranges = options.state.stacks.map((stack, index) => {
    const top = stack.at(-1)
    const current = selected[index]
    if (!top || !current || !rangesEqual(top, current)) return undefined
    return stack.at(-2) ?? top
  })
  if (ranges.some((range) => !range)) return null
  return ranges as readonly TreeSitterSelectionRange[]
}

const stackForSelection = (
  options: TreeSitterSelectionCommandOptions,
  index: number,
  selected: TreeSitterSelectionRange | undefined,
): readonly TreeSitterSelectionRange[] => {
  if (!selected) return []
  if (options.state?.snapshotVersion !== options.snapshotVersion) return [selected]

  const stack = options.state.stacks[index]
  const top = stack?.at(-1)
  return stack && top && rangesEqual(top, selected) ? stack : [selected]
}

const rangesEqual = (left: TreeSitterSelectionRange, right: TreeSitterSelectionRange): boolean =>
  left.startIndex === right.startIndex && left.endIndex === right.endIndex
