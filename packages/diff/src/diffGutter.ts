import type { EditorGutterContribution, EditorGutterRowContext } from '@singapor/core/extensions'
import {
  diffGutterIndicatorText,
  diffGutterLaneTone,
  diffGutterLayout,
  diffGutterNumberText,
  diffGutterRowTone,
  type DiffGutterDigits,
  type DiffGutterLaneKind,
  type DiffGutterLayout,
  type DiffGutterSide,
} from './gutters'
import type { DiffRenderRow } from './types'

export type DiffGutterOptions = {
  readonly side: DiffGutterSide
  /**
   * The widest line number each lane must fit, computed once when the projection is built. Passing
   * rows here instead would make `width()` re-scan every projected row on every width
   * invalidation — which in overlay mode is every line of the file.
   */
  readonly getDigits: () => DiffGutterDigits
  /**
   * Which diff row a rendered gutter row is showing. The two modes answer this differently and the
   * gutter must not guess: in `document` mode the projection array index *is* the buffer row (§C4),
   * but in `overlay` mode the array interleaves injected deletion rows, so position and buffer row
   * diverge after the first deletion and the lookup has to go through `rowsByBufferRow`.
   *
   * Indexing a projection array positionally here is what broke overlay numbering once already.
   */
  readonly resolveRow: (row: EditorGutterRowContext) => DiffRenderRow | null
  readonly isEnabled?: () => boolean
  /**
   * Called whenever the lane geometry is recomputed, so the host can publish it as CSS custom
   * properties. The canvas gutter derived lane widths arithmetically; a DOM gutter has to hand the
   * same numbers to CSS or the columns drift (§3.3, trap 1).
   */
  readonly onLayout?: (layout: DiffGutterLayout) => void
}

type DiffGutterLanes = {
  readonly cell: HTMLElement
  readonly lanes: ReadonlyMap<DiffGutterLaneKind, HTMLElement>
}

/**
 * Lane elements are resolved once, when the cell is created, and never looked up again.
 *
 * The previous live-diff gutter ran three `querySelector` calls per row per update
 * (editorDiffPlugin.ts:246-255 before this change) — ~132 lookups per repaint at 44 mounted rows,
 * on the exact path the Aug-2026 scroll work fixed. Cells are created once and recycled by the
 * core (virtualizedTextViewRows.ts:308-330), so caching here costs one WeakMap entry per mounted
 * row and removes the lookups entirely (§3.3, trap 3).
 */
const lanesByCell = new WeakMap<HTMLElement, DiffGutterLanes>()

const NUMBER_LANES: readonly DiffGutterLaneKind[] = ['old', 'new']

export function createDiffGutterContribution(options: DiffGutterOptions): EditorGutterContribution {
  const laneKinds = gutterLaneKinds(options.side)
  let lastLayoutKey: string | null = null

  return {
    id: `editor-diff-gutter-${options.side}`,
    className: 'editor-diff-gutter-cell',
    createCell(document) {
      return createDiffGutterCell(document, laneKinds)
    },
    width(context) {
      if (options.isEnabled && !options.isEnabled()) return 0

      const layout = diffGutterLayout(
        options.side,
        options.getDigits(),
        context.lineCount,
        context.metrics.characterWidth,
      )
      // Only on an actual change: `width` runs inside the core's layout pass, and writing custom
      // properties unconditionally would dirty style for the whole subtree on every recompute.
      //
      // Keyed on the whole lane split, not on the total. The stacked total is
      // `ceil(old*cw + 6) + ceil(new*cw + 6) + 12`, which is symmetric in the two lane character
      // counts — so swapping to a file whose old/new digit widths are transposed leaves the total
      // identical while the split needs to change, and a total-keyed memo would silently keep
      // publishing the previous columns. Lanes are `overflow: hidden`, so the under-sized one
      // clips its leading digit.
      const layoutKey = gutterLayoutKey(layout)
      if (layoutKey !== lastLayoutKey) {
        lastLayoutKey = layoutKey
        options.onLayout?.(layout)
      }
      return layout.width
    },
    updateCell(element, row) {
      updateDiffGutterCell(element, row, options)
    },
  }
}

function gutterLaneKinds(side: DiffGutterSide): readonly DiffGutterLaneKind[] {
  if (side === 'stacked') return [...NUMBER_LANES, 'indicator']
  return [side, 'indicator']
}

/** Everything `onLayout` publishes, so the memo cannot miss a change the payload carries. */
function gutterLayoutKey(layout: DiffGutterLayout): string {
  return `${layout.width}:${layout.lanes.map((lane) => `${lane.kind}=${lane.width}`).join(',')}`
}

function createDiffGutterCell(
  document: Document,
  laneKinds: readonly DiffGutterLaneKind[],
): HTMLElement {
  const cell = document.createElement('span')
  cell.className = 'editor-diff-gutter'
  cell.setAttribute('aria-hidden', 'true')

  const lanes = new Map<DiffGutterLaneKind, HTMLElement>()
  for (const kind of laneKinds) {
    const lane = document.createElement('span')
    lane.className = `editor-diff-gutter-lane editor-diff-gutter-lane-${kind}`
    cell.appendChild(lane)
    lanes.set(kind, lane)
  }

  lanesByCell.set(cell, { cell, lanes })
  return cell
}

function updateDiffGutterCell(
  element: HTMLElement,
  row: EditorGutterRowContext,
  options: DiffGutterOptions,
): void {
  const cached = lanesByCell.get(element)
  if (!cached) return

  const diffRow = diffRowForGutterRow(row, options)
  element.hidden = !diffRow
  if (!diffRow) {
    for (const lane of cached.lanes.values()) clearLane(lane)
    if (element.dataset.diffRowType !== undefined) delete element.dataset.diffRowType
    if (element.dataset.diffRowTone !== undefined) delete element.dataset.diffRowTone
    return
  }

  for (const [kind, lane] of cached.lanes) {
    setLaneText(lane, laneText(diffRow, kind))
    setLaneTone(lane, diffGutterLaneTone(diffRow, kind))
  }
  setDataset(element, 'diffRowType', diffRow.type)
  setDataset(element, 'diffRowTone', diffGutterRowTone(diffRow, options.side))
}

function diffRowForGutterRow(
  row: EditorGutterRowContext,
  options: DiffGutterOptions,
): DiffRenderRow | null {
  if (options.isEnabled && !options.isEnabled()) return null
  return options.resolveRow(row)
}

function laneText(row: DiffRenderRow, kind: DiffGutterLaneKind): string {
  if (kind === 'indicator') return diffGutterIndicatorText(row)
  return diffGutterNumberText(row, kind)
}

function clearLane(lane: HTMLElement): void {
  setLaneText(lane, '')
  setLaneTone(lane, 'default')
}

function setLaneText(lane: HTMLElement, text: string): void {
  if (lane.textContent === text) return
  lane.textContent = text
}

function setLaneTone(lane: HTMLElement, tone: string): void {
  setDataset(lane, 'diffTone', tone)
}

function setDataset(element: HTMLElement, key: string, value: string): void {
  if (element.dataset[key] === value) return
  element.dataset[key] = value
}
