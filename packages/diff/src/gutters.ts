import type { DiffRenderRow } from './types'

export type DiffGutterSide = 'old' | 'new' | 'stacked'
export type DiffGutterNumberSide = Exclude<DiffGutterSide, 'stacked'>
export type DiffGutterLaneKind = DiffGutterNumberSide | 'indicator'

/**
 * What a lane is coloured *as*, rather than what colour it ends up. The DOM gutter resolves the
 * colour in CSS so a theme can override it; keeping the branching here means the rule that an
 * addition tints the new lane and not the old one lives in exactly one place.
 */
export type DiffGutterLaneTone = 'added' | 'deleted' | 'hunk' | 'default'

type DiffGutterLaneLayout = {
  readonly kind: DiffGutterLaneKind
  readonly left: number
  readonly width: number
}

export type DiffGutterLayout = {
  readonly lanes: readonly DiffGutterLaneLayout[]
  readonly width: number
}

const MIN_LINE_NUMBER_DIGITS = 2
const GUTTER_NUMBER_RESERVED_WIDTH = 6
const GUTTER_INDICATOR_WIDTH = 12

export function diffGutterWidth(
  side: DiffGutterSide,
  rows: readonly DiffRenderRow[],
  lineCount: number,
  characterWidth: number,
): number {
  return diffGutterLayout(side, rows, lineCount, characterWidth).width
}

export function diffGutterLayout(
  side: DiffGutterSide,
  rows: readonly DiffRenderRow[],
  lineCount: number,
  characterWidth: number,
): DiffGutterLayout {
  if (side !== 'stacked') {
    const numberWidth = gutterNumberLaneWidth(side, rows, lineCount, characterWidth)
    const width = numberWidth + GUTTER_INDICATOR_WIDTH
    return {
      lanes: [
        { kind: side, left: 0, width: numberWidth },
        { kind: 'indicator', left: numberWidth, width: GUTTER_INDICATOR_WIDTH },
      ],
      width,
    }
  }

  const oldWidth = gutterNumberLaneWidth('old', rows, lineCount, characterWidth)
  const newWidth = gutterNumberLaneWidth('new', rows, lineCount, characterWidth)
  const indicatorLeft = oldWidth + newWidth
  return {
    lanes: [
      { kind: 'old', left: 0, width: oldWidth },
      { kind: 'new', left: oldWidth, width: newWidth },
      { kind: 'indicator', left: indicatorLeft, width: GUTTER_INDICATOR_WIDTH },
    ],
    width: indicatorLeft + GUTTER_INDICATOR_WIDTH,
  }
}

function diffGutterWidthCharacters(
  side: DiffGutterSide,
  rows: readonly DiffRenderRow[],
  lineCount: number,
): number {
  if (side === 'stacked') {
    return (
      diffGutterWidthCharacters('old', rows, lineCount) +
      diffGutterWidthCharacters('new', rows, lineCount)
    )
  }

  let maxCharacters = String(Math.max(1, lineCount)).length
  for (const row of rows) {
    maxCharacters = Math.max(maxCharacters, lineNumberForRow(row, side).length)
  }

  return Math.max(MIN_LINE_NUMBER_DIGITS, maxCharacters)
}

export function diffGutterNumberText(row: DiffRenderRow, side: DiffGutterNumberSide): string {
  return lineNumberForRow(row, side)
}

export function diffGutterIndicatorText(row: DiffRenderRow): string {
  if (row.type === 'addition') return '+'
  if (row.type === 'deletion') return '-'
  if (row.type === 'hunk' && row.expandable) return row.expanded ? '−' : '+'
  return ''
}

/**
 * Side-awareness in this gutter is **per lane, not per pane** (plan §3.3). In stacked mode one
 * gutter carries both number lanes, and for a single addition row the old lane stays foreground
 * while the new lane goes green — so a row-level class cannot express it and each lane carries its
 * own tone.
 *
 * The indicator lane is deliberately side-agnostic: it shows `+`/`-` for the row as a whole.
 */
export function diffGutterLaneTone(
  row: DiffRenderRow,
  kind: DiffGutterLaneKind,
): DiffGutterLaneTone {
  if (row.type === 'hunk') return 'hunk'
  if (kind === 'indicator') {
    if (row.type === 'addition') return 'added'
    if (row.type === 'deletion') return 'deleted'
    return 'default'
  }

  if (row.type === 'addition' && kind !== 'old') return 'added'
  if (row.type === 'deletion' && kind !== 'new') return 'deleted'
  return 'default'
}

/**
 * Whether the gutter band behind a row is tinted. Unlike the lane tone this *is* per pane: a split
 * old pane shows no tint behind an addition, because that row is a placeholder there.
 */
export function diffGutterRowTone(row: DiffRenderRow, side: DiffGutterSide): DiffGutterLaneTone {
  if (row.type === 'addition' && side !== 'old') return 'added'
  if (row.type === 'deletion' && side !== 'new') return 'deleted'
  if (row.type === 'hunk') return 'hunk'
  return 'default'
}

function gutterNumberLaneWidth(
  side: DiffGutterNumberSide,
  rows: readonly DiffRenderRow[],
  lineCount: number,
  characterWidth: number,
): number {
  const characters = diffGutterWidthCharacters(side, rows, lineCount)
  return Math.ceil(characters * characterWidth + GUTTER_NUMBER_RESERVED_WIDTH)
}

function lineNumberForRow(row: DiffRenderRow, side: DiffGutterNumberSide): string {
  if (row.type === 'hunk' || row.type === 'empty') return ''
  if (side === 'old') return formatLineNumber(row.oldLineNumber)
  return formatLineNumber(row.newLineNumber)
}

function formatLineNumber(value: number | undefined): string {
  if (value === undefined) return ''
  return String(value)
}
