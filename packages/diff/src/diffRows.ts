import type {
  VirtualizedTextHighlightRange,
  VirtualizedTextRowDecoration,
} from '@singapor/core/rendering'
import type { EditorViewSnapshot } from '@singapor/core/extensions'
import type { DiffRenderRow } from './types'

export function diffRowDecorations(
  rows: readonly DiffRenderRow[],
): ReadonlyMap<number, VirtualizedTextRowDecoration> {
  const decorations = new Map<number, VirtualizedTextRowDecoration>()
  for (const [index, row] of rows.entries()) decorations.set(index, decorationForRow(row))
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

function decorationForRow(row: DiffRenderRow): VirtualizedTextRowDecoration {
  const suffix = row.type
  const expandable = row.expandable ? ' editor-diff-row-expandable' : ''
  return {
    className: `editor-diff-row editor-diff-row-${suffix}${expandable}`,
    gutterClassName: `editor-diff-gutter-row editor-diff-gutter-row-${suffix}`,
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
