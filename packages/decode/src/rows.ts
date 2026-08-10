import type { EditorViewContributionContext, EditorViewSnapshot } from '@singapor/core/extensions'

/** Class on the scroll element that hides the real rows until each is revealed. */
export const ACTIVE_CLASS = 'editor-decode-active'

const ROW_SELECTOR = '.editor-virtualized-row'

export type DecodeRevealRow = {
  /** The editor's own (already syntax-highlighted) row element. */
  readonly element: HTMLElement
  /** The row's text — diffusion builds one scramble glyph per character from this. */
  readonly text: string
  /** Document offset of the row's first character — diffusion maps glyphs to token colours. */
  readonly startOffset: number
  /** Character count, used to scale the per-line reveal duration. */
  readonly length: number
  /** Row top in content coordinates (matches the live row). */
  readonly top: number
  /** Row height in px. */
  readonly height: number
  /** Rendered text width in px — the clip target and the caret's travel distance. */
  readonly width: number
}

/**
 * Matches the snapshot's visible text rows to the editor's live row elements
 * (keyed by `data-editor-virtual-row`). We animate these real, highlight-painted
 * elements directly — never a clone — so the reveal is syntax-coloured from the
 * first frame. Geometry comes from the editor's own measurements so the caret
 * rides exactly on the reveal edge.
 */
export function collectRevealRows(
  context: EditorViewContributionContext,
  snapshot: EditorViewSnapshot,
  maxRows: number,
): DecodeRevealRow[] {
  const scroll = context.scrollElement
  const charWidth = snapshot.metrics.characterWidth
  const rows: DecodeRevealRow[] = []
  for (const row of snapshot.visibleRows) {
    if (row.kind !== 'text' || row.text.length === 0) continue

    const element = scroll.querySelector<HTMLElement>(
      `${ROW_SELECTOR}[data-editor-virtual-row="${row.index}"]`,
    )
    if (!element) continue

    rows.push({
      element,
      text: row.text,
      startOffset: row.startOffset,
      length: row.text.length,
      top: row.top,
      height: row.height,
      width: textWidth(context, row.startOffset, row.endOffset, row.text.length, charWidth),
    })
    if (rows.length >= maxRows) break
  }
  return rows
}

/** Exact rendered width via the editor's geometry; monospace estimate as fallback. */
function textWidth(
  context: EditorViewContributionContext,
  startOffset: number,
  endOffset: number,
  length: number,
  charWidth: number,
): number {
  const rect = context.getRangeClientRect(startOffset, endOffset)
  if (rect && rect.width > 0) return rect.width
  return length * charWidth
}
