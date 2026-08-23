import type { SelectionAffinity } from '../selections'

export type EditorSetSelectionOptions = {
  readonly affinity?: SelectionAffinity
  readonly reveal?: boolean
  readonly revealOffset?: number
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
