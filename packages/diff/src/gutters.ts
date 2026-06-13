import type { EditorGutterContribution } from '@singapor/core/extensions'
import type { DiffRenderRow } from './types'

export type DiffGutterSide = 'old' | 'new' | 'stacked'
export type DiffGutterNumberSide = Exclude<DiffGutterSide, 'stacked'>
export type DiffGutterLaneKind = DiffGutterNumberSide | 'indicator'

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

export function createDiffGutterContribution(
  side: DiffGutterSide,
  getRows: () => readonly DiffRenderRow[],
): EditorGutterContribution {
  return {
    id: `diff-${side}-gutter`,
    className: 'editor-diff-gutter-cell',
    createCell(document) {
      return createDiffGutterCell(document)
    },
    width(context) {
      return diffGutterWidth(side, getRows(), context.lineCount, context.metrics.characterWidth)
    },
    updateCell() {},
  }
}

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

function createDiffGutterCell(document: Document): HTMLElement {
  const element = document.createElement('span')
  element.className = 'editor-diff-gutter'
  element.setAttribute('aria-hidden', 'true')
  return element
}

function diffGutterText(row: DiffRenderRow, side: DiffGutterSide): string {
  if (side === 'stacked') {
    const oldNumber = diffGutterNumberText(row, 'old')
    const newNumber = diffGutterNumberText(row, 'new')
    const indicator = diffGutterIndicatorText(row)
    return [oldNumber, newNumber, indicator].filter(Boolean).join(' ')
  }

  const number = diffGutterNumberText(row, side)
  const indicator = diffGutterIndicatorText(row)
  return [number, indicator].filter(Boolean).join(' ')
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

export function diffGutterColor(
  row: DiffRenderRow,
  side: DiffGutterNumberSide,
  colors: {
    readonly added: string
    readonly deleted: string
    readonly foreground: string
    readonly hunk: string
  },
): string {
  if (row.type === 'addition' && side !== 'old') return colors.added
  if (row.type === 'deletion' && side !== 'new') return colors.deleted
  if (row.type === 'hunk') return colors.hunk
  return colors.foreground
}

export function diffGutterIndicatorColor(
  row: DiffRenderRow,
  colors: {
    readonly added: string
    readonly deleted: string
    readonly foreground: string
    readonly hunk: string
  },
): string {
  if (row.type === 'addition') return colors.added
  if (row.type === 'deletion') return colors.deleted
  if (row.type === 'hunk') return colors.hunk
  return colors.foreground
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
