import type { SelectionAffinity } from '../selections'

export type EditorSetSelectionOptions = {
  readonly affinity?: SelectionAffinity
  readonly reveal?: boolean
  readonly revealOffset?: number
}

/** @deprecated Use {@link EditorSetSelectionOptions}. */
export type EditorSelectionRevealOptions = {
  readonly reveal?: boolean
  readonly revealOffset?: number
}

/** @deprecated Pass an {@link EditorSetSelectionOptions} object instead. */
export type EditorSelectionRevealTarget = number | EditorSelectionRevealOptions

export type EditorSetSelectionInput = EditorSetSelectionOptions | number

export function normalizeEditorSetSelectionOptions(
  input: EditorSetSelectionInput | undefined,
): EditorSetSelectionOptions | undefined {
  if (typeof input === 'number') return { revealOffset: input }
  return input
}

export function selectionRevealOffset(
  options: EditorSetSelectionOptions | undefined,
  fallback: number | undefined,
  revealByDefault: boolean,
): number | undefined {
  if (options?.revealOffset !== undefined) return options.revealOffset
  if (options?.reveal === false) return undefined
  if (!options?.reveal && !revealByDefault) return undefined

  return fallback
}
