import type { EditorToken, EditorTokenStyle } from '../tokens'
import { setEditorTokenIndex } from '../editor/tokenIndex'

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

export type PackedEditorTokenWriter = {
  readonly ends: Uint32Array
  readonly starts: Uint32Array
  readonly styleIds: Uint32Array
  index: number
  maxEnd: number
  monotonicEnd: boolean
  nonOverlapping: boolean
  previousEnd: number
  previousStart: number
  sortedByStart: boolean
}

export function createPackedEditorTokenWriter(tokenCount: number): PackedEditorTokenWriter {
  return {
    ends: new Uint32Array(tokenCount),
    index: 0,
    maxEnd: 0,
    monotonicEnd: true,
    nonOverlapping: true,
    previousEnd: -Infinity,
    previousStart: -Infinity,
    sortedByStart: true,
    starts: new Uint32Array(tokenCount),
    styleIds: new Uint32Array(tokenCount),
  }
}

export function writePackedEditorToken(
  writer: PackedEditorTokenWriter,
  start: number,
  end: number,
  styleId: number,
): void {
  if (start < writer.previousStart) writer.sortedByStart = false
  if (start < writer.previousEnd) writer.nonOverlapping = false
  if (end < writer.maxEnd) writer.monotonicEnd = false

  writer.starts[writer.index] = start
  writer.ends[writer.index] = end
  writer.styleIds[writer.index] = styleId
  writer.index += 1
  writer.maxEnd = Math.max(writer.maxEnd, end)
  writer.previousEnd = end
  writer.previousStart = start
}

export function finishPackedEditorTokenWriter(
  writer: PackedEditorTokenWriter,
  styles: readonly EditorTokenStyle[],
): PackedEditorTokens {
  return {
    starts: writer.starts,
    ends: writer.ends,
    styleIds: writer.styleIds,
    styles,
    monotonicEnd: writer.monotonicEnd,
    nonOverlapping: writer.nonOverlapping,
    sortedByStart: writer.sortedByStart,
  }
}

export function packEditorTokens(tokens: readonly EditorToken[]): PackedEditorTokens {
  const writer = createPackedEditorTokenWriter(tokens.length)
  const styles: EditorTokenStyle[] = []
  // Styles come from shared per-capture tables, so identity de-duplication
  // collapses them into a small palette.
  const styleIdByStyle = new Map<EditorTokenStyle, number>()

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    let styleId = styleIdByStyle.get(token.style)
    if (styleId === undefined) {
      styleId = styles.length
      styles.push(token.style)
      styleIdByStyle.set(token.style, styleId)
    }
    writePackedEditorToken(writer, token.start, token.end, styleId)
  }

  return finishPackedEditorTokenWriter(writer, styles)
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
