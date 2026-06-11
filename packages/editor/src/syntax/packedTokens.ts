import type { EditorToken, EditorTokenStyle } from '../tokens'
import { getEditorTokenIndex, setEditorTokenIndex } from '../editor/tokenIndex'

// Structure-of-arrays token transport. Worker responses carry three numeric
// buffers plus a small style palette instead of one object per token, so
// postMessage transfers the buffers instead of structured-cloning hundreds of
// thousands of objects on the main thread.
export type PackedEditorTokens = {
  readonly starts: Uint32Array
  readonly ends: Uint32Array
  readonly styleIds: Uint32Array
  readonly styles: readonly EditorTokenStyle[]
  readonly monotonicEnd: boolean
  readonly nonOverlapping: boolean
  readonly sortedByStart: boolean
}

export function packEditorTokens(tokens: readonly EditorToken[]): PackedEditorTokens {
  const starts = new Uint32Array(tokens.length)
  const ends = new Uint32Array(tokens.length)
  const styleIds = new Uint32Array(tokens.length)
  const styles: EditorTokenStyle[] = []
  // Styles come from shared per-capture tables, so identity de-duplication
  // collapses them into a small palette.
  const styleIdByStyle = new Map<EditorTokenStyle, number>()

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    starts[index] = token.start
    ends[index] = token.end
    let styleId = styleIdByStyle.get(token.style)
    if (styleId === undefined) {
      styleId = styles.length
      styles.push(token.style)
      styleIdByStyle.set(token.style, styleId)
    }
    styleIds[index] = styleId
  }

  const index = getEditorTokenIndex(tokens)
  return {
    starts,
    ends,
    styleIds,
    styles,
    monotonicEnd: index?.monotonicEnd ?? false,
    nonOverlapping: index?.nonOverlapping ?? false,
    sortedByStart: index?.sortedByStart ?? false,
  }
}

export function packedEditorTokenTransfers(packed: PackedEditorTokens): Transferable[] {
  return [packed.starts.buffer, packed.ends.buffer, packed.styleIds.buffer]
}

export function unpackEditorTokens(packed: PackedEditorTokens): EditorToken[] {
  const { starts, ends, styleIds, styles } = packed
  const tokens: EditorToken[] = new Array(starts.length)
  const maxEnds: number[] = new Array(starts.length)
  let maxEnd = 0

  for (let index = 0; index < starts.length; index += 1) {
    const end = ends[index]!
    tokens[index] = {
      start: starts[index]!,
      end,
      style: styles[styleIds[index]!]!,
    }
    if (end > maxEnd) maxEnd = end
    maxEnds[index] = maxEnd
  }

  setEditorTokenIndex(tokens, {
    maxEnds,
    monotonicEnd: packed.monotonicEnd,
    nonOverlapping: packed.nonOverlapping,
    sortedByStart: packed.sortedByStart,
  })
  return tokens
}
