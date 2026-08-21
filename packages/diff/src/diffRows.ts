import type {
  VirtualizedTextHighlightRange,
  VirtualizedTextRowDecoration,
} from '@singapor/core/rendering'
import type { EditorViewSnapshot } from '@singapor/core/extensions'
import type { DiffRenderRow } from './types'

/**
 * Row decorations for the rows that actually need one.
 *
 * A context row carries no tint and no cursor, so the decoration it used to get was two freshly
 * built strings saying "ordinary line" — for every line of the file, rebuilt on every `setFile` and
 * every `toggleRegion`, and then copied twice more by the editor before reaching the view. On a
 * fully expanded large diff the overwhelming majority of rows are context.
 *
 * Only rows that differ from the default are emitted now, which is the shape the overlay path
 * already had (`LiveDiffProjectionBuilder.decorateDocumentRow` decorates changed rows only). The
 * `--editor-diff-*` variable block a host overrides is declared on `.editor-diff-view` as well as
 * on the row classes, so an undecorated row still inherits it from the container.
 */
export function diffRowDecorations(
  rows: readonly DiffRenderRow[],
): ReadonlyMap<number, VirtualizedTextRowDecoration> {
  const decorations = new Map<number, VirtualizedTextRowDecoration>()
  for (const [index, row] of rows.entries()) {
    const decoration = decorationForRow(row)
    if (decoration) decorations.set(index, decoration)
  }
  return decorations
}

export function diffInlineHighlightRanges(
  rows: readonly DiffRenderRow[],
): readonly VirtualizedTextHighlightRange[] {
  const ranges: VirtualizedTextHighlightRange[] = []
  let offset = 0

  for (const row of rows) {
    appendInlineRanges(ranges, row, offset)
    offset += row.text.length + 1
  }

  return ranges
}

function appendInlineRanges(
  ranges: VirtualizedTextHighlightRange[],
  row: DiffRenderRow,
  rowOffset: number,
): void {
  for (const range of row.inlineRanges ?? []) {
    if (range.end <= range.start) continue
    ranges.push({ start: rowOffset + range.start, end: rowOffset + range.end })
  }
}

/**
 * `null` for a row that needs no decoration.
 *
 * The gutter class is the bare `editor-diff-gutter-row` only: the `-${type}` suffixes matched no
 * rule once the gutter tint moved to `data-diff-row-tone` on the cell, so emitting them was a
 * template literal per row producing a class that styled nothing. The bare class stays — it is
 * where the `--editor-diff-*` block is declared, and a host overrides on it.
 */
function decorationForRow(row: DiffRenderRow): VirtualizedTextRowDecoration | null {
  if (row.type === 'context') return null

  const expandable = row.expandable ? ' editor-diff-row-expandable' : ''
  return {
    className: `editor-diff-row editor-diff-row-${row.type}${expandable}`,
    gutterClassName: 'editor-diff-gutter-row',
  }
}

export type DiffDocumentModeViolation =
  | 'row-count-mismatch'
  | 'row-index-not-buffer-row'
  | 'non-document-row'

/**
 * §C4 and §C7, asserted rather than assumed.
 *
 * `document` mode is built on one identity: projection row `i` is buffer row `i` is
 * `data-editor-virtual-row="i"`. Platform's line-comment layer reads line numbers straight off that
 * attribute, and split alignment is the same property held twice. It survives only on the
 * plain-display-row fast path, which `hasModelRowProjections` turns off for block rows, an inline
 * map or injected rows (virtualizedTextViewLayout.ts:789-795), and which word wrap and a fold map
 * also break.
 *
 * Rather than enumerate the features that would break it — a list that goes stale the moment a new
 * projection is added — this checks the identity itself on the rows actually mounted. Any
 * divergence means one of them got switched on.
 */
export function documentModeViolations(
  snapshot: EditorViewSnapshot,
  rows: readonly DiffRenderRow[],
): readonly DiffDocumentModeViolation[] {
  const violations = new Set<DiffDocumentModeViolation>()
  if (rows.length > 0 && snapshot.lineCount !== rows.length) {
    violations.add('row-count-mismatch')
  }

  for (const row of snapshot.visibleRows) {
    if (row.source !== 'document' || row.kind !== 'text') {
      violations.add('non-document-row')
      continue
    }
    if (row.index !== row.bufferRow) violations.add('row-index-not-buffer-row')
  }

  return [...violations]
}
