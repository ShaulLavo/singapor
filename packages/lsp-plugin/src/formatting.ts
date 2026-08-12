import type * as lsp from 'vscode-languageserver-protocol'

import type { TextEdit } from '@singapor/core'
import { lspPositionToOffset } from '@singapor/lsp'

/**
 * Converts server formatting edits into buffer edits.
 *
 * Returned in descending order and with overlaps dropped, because the batch applicator rejects
 * overlapping edits outright — a formatter that returns a whole-document edit plus a nested one
 * would otherwise throw rather than format.
 */
export function formattingEdits(text: string, edits: readonly lsp.TextEdit[] | null): TextEdit[] {
  if (!edits || edits.length === 0) return []

  const converted = edits
    .map((edit) => ({
      from: lspPositionToOffset(text, edit.range.start),
      text: edit.newText,
      to: lspPositionToOffset(text, edit.range.end),
    }))
    .filter((edit) => edit.from <= edit.to)
    // Earliest first, and the longest of any that start together: when a formatter sends a
    // whole-document edit alongside a nested one, the outer edit is the real answer and keeping the
    // fragment instead would rewrite a slice of the file with a slice of the result.
    .sort((left, right) => left.from - right.from || right.to - left.to)

  const applied: TextEdit[] = []
  let keptThrough = Number.NEGATIVE_INFINITY
  for (const edit of converted) {
    if (edit.from < keptThrough) continue

    applied.push(edit)
    keptThrough = edit.to
  }

  // Descending, so applying them in order cannot shift the offsets of the ones still to come.
  return applied.reverse()
}

/** Whether the edits would leave the document unchanged, so a no-op formatter records no change. */
export function formattingChangesText(text: string, edits: readonly TextEdit[]): boolean {
  return edits.some((edit) => text.slice(edit.from, edit.to) !== edit.text)
}

export function formattingOptions(tabSize: number): lsp.FormattingOptions {
  return {
    insertSpaces: true,
    tabSize: Math.max(1, tabSize),
  }
}
