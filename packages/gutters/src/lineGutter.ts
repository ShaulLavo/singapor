import type {
  EditorGutterContribution,
  EditorGutterRowContext,
  EditorPlugin,
} from '@singapor/core/extensions'
import { normalizeNonNegativeNumber, normalizePositiveInteger, setElementHidden } from './utils'
import './lineGutter.css'

export type LineGutterPluginOptions = {
  readonly counterStyle?: string
  readonly labelForRow?: (row: EditorGutterRowContext) => LineGutterLabel
  readonly minLabelColumns?: number
  readonly minDigits?: number
  readonly minWidth?: number
  readonly startLine?: number
}

export type LineGutterLabel = number | string | null | undefined

const DEFAULT_COUNTER_STYLE = 'decimal'
const DEFAULT_LINE_GUTTER_MIN_COLUMNS = 3
const DEFAULT_LINE_GUTTER_MIN_WIDTH = 26
const DEFAULT_START_LINE = 1
const LINE_GUTTER_PADDING_PX = 8

export function createLineGutterPlugin(options: LineGutterPluginOptions = {}): EditorPlugin {
  const contribution = createLineGutterContribution(options)

  return {
    name: 'line-gutter',
    activate(context) {
      return context.registerGutterContribution(contribution)
    },
  }
}

export function createLineGutterContribution(
  options: LineGutterPluginOptions = {},
): EditorGutterContribution {
  const counterStyle = options.counterStyle ?? DEFAULT_COUNTER_STYLE
  const minLabelColumns = Math.max(
    normalizePositiveInteger(options.minLabelColumns, DEFAULT_LINE_GUTTER_MIN_COLUMNS),
    normalizePositiveInteger(options.minDigits, DEFAULT_LINE_GUTTER_MIN_COLUMNS),
  )
  const minWidth = normalizeNonNegativeNumber(options.minWidth, DEFAULT_LINE_GUTTER_MIN_WIDTH)
  const startLine = normalizePositiveInteger(options.startLine, DEFAULT_START_LINE)
  const labelForRow = options.labelForRow ?? null

  return {
    id: 'line-gutter',
    createCell(document) {
      const element = document.createElement('span')
      element.className = labelForRow
        ? 'editor-virtualized-gutter-label editor-virtualized-line-label'
        : 'editor-virtualized-gutter-label editor-virtualized-line-number'
      element.setAttribute('aria-hidden', 'true')
      if (!labelForRow) {
        element.style.setProperty('--editor-line-gutter-counter-style', counterStyle)
      }
      return element
    },
    width(context) {
      const endLine = startLine + context.lineCount - 1
      const columns = labelForRow
        ? minLabelColumns
        : Math.max(minLabelColumns, decimalDigitCount(endLine))
      return Math.max(
        minWidth,
        Math.ceil(columns * context.metrics.characterWidth + LINE_GUTTER_PADDING_PX),
      )
    },
    updateCell(element, row) {
      updateLineGutterCell(element, row, startLine, labelForRow)
    },
  }
}

function updateLineGutterCell(
  element: HTMLElement,
  row: EditorGutterRowContext,
  startLine: number,
  labelForRow: ((row: EditorGutterRowContext) => LineGutterLabel) | null,
): void {
  const label = row.primaryText && labelForRow ? labelForRow(row) : null
  const hidden = !row.primaryText || (labelForRow !== null && !hasLineGutterLabel(label))
  setElementHidden(element, hidden)
  element.classList.toggle(
    'editor-virtualized-line-number-active',
    !hidden && row.cursorLine && row.cursorLineHighlight.gutterNumber,
  )
  if (hidden) {
    if (labelForRow) setTextContent(element, '')
    return
  }

  if (labelForRow) {
    setTextContent(element, String(label))
    return
  }

  setCounterSet(element, `editor-line ${startLine + row.bufferRow}`)
}

function hasLineGutterLabel(label: LineGutterLabel): boolean {
  if (label === null || label === undefined) return false
  return String(label).length > 0
}

function setCounterSet(element: HTMLElement, value: string): void {
  if (element.style.counterSet === value) return
  element.style.counterSet = value
}

function setTextContent(element: HTMLElement, value: string): void {
  if (element.textContent === value) return
  element.textContent = value
}

function decimalDigitCount(value: number): number {
  return String(Math.max(1, Math.floor(value))).length
}
