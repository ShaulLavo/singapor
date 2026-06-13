import type { Point } from './pieceTable/pieceTableTypes'

declare const tabPointBrand: unique symbol
declare const wrapPointBrand: unique symbol
declare const blockPointBrand: unique symbol

export type TransformBias = 'before' | 'after' | 'nearest'

export type InvalidatedRange<TPoint extends Point> = {
  readonly start: TPoint
  readonly end: TPoint
  readonly lineCountDelta: number
}

export type TabPoint = Point & {
  readonly [tabPointBrand]: true
}

export type WrapPoint = Point & {
  readonly [wrapPointBrand]: true
}

export type BlockPoint = Point & {
  readonly [blockPointBrand]: true
}

export type DisplayTextRowSource = 'document' | 'injected'

export type DisplayDocumentTextRow = {
  readonly kind: 'text'
  readonly source: 'document'
  readonly index: number
  readonly bufferRow: number
  readonly startOffset: number
  readonly endOffset: number
  readonly text: string
  readonly sourceText: string
  readonly sourceStartColumn: number
  readonly sourceEndColumn: number
  readonly wrapSegment: number
}

export type DisplayInjectedTextRow = {
  readonly kind: 'text'
  readonly source: 'injected'
  readonly id: string
  readonly index: number
  readonly bufferRow: number
  readonly anchorBufferRow: number
  readonly placement: InjectedTextRowPlacement
  readonly order: number
  readonly startOffset: number
  readonly endOffset: number
  readonly text: string
  readonly sourceText: string
  readonly sourceStartColumn: number
  readonly sourceEndColumn: number
  readonly wrapSegment: number
  readonly className?: string
  readonly gutterClassName?: string
  readonly metadata?: unknown
}

export type DisplayTextRow = DisplayDocumentTextRow | DisplayInjectedTextRow

export type DisplayBlockRow = {
  readonly kind: 'block'
  readonly id: string
  readonly index: number
  readonly anchorBufferRow: number
  readonly placement: BlockRowPlacement
  readonly unitIndex: number
  readonly heightRows: number
  readonly heightPx?: number
  readonly heightMeasured?: boolean
  readonly startOffset: number
  readonly endOffset: number
  readonly text: string
}

export type DisplayRow = DisplayTextRow | DisplayBlockRow

export type BlockRowPlacement = 'before' | 'after'

type InjectedTextRowPlacement = 'before' | 'after'

export type InjectedTextRow = {
  readonly id: string
  readonly anchorBufferRow: number
  readonly placement: InjectedTextRowPlacement
  readonly text: string
  readonly order?: number
  readonly className?: string
  readonly gutterClassName?: string
  readonly metadata?: unknown
}

export type BlockLanePlacement = 'left' | 'right'

export type BlockRow = {
  readonly id: string
  readonly anchorBufferRow: number
  readonly placement: BlockRowPlacement
  readonly heightRows: number
  readonly heightPx?: number
  readonly heightMeasured?: boolean
  readonly text?: string
}

export type BlockLane = {
  readonly id: string
  readonly startBufferRow: number
  readonly endBufferRow: number
  readonly placement: BlockLanePlacement
  readonly widthPx: number
  readonly widthMeasured?: boolean
}

type BlockRowsAtBufferRow = {
  readonly before: readonly BlockRow[]
  readonly after: readonly BlockRow[]
}

type MutableBlockRowsAtBufferRow = {
  readonly before: BlockRow[]
  readonly after: BlockRow[]
}

type BlockRowIndex = ReadonlyMap<number, BlockRowsAtBufferRow>

type InjectedTextRowsAtBufferRow = {
  readonly before: readonly InjectedTextRow[]
  readonly after: readonly InjectedTextRow[]
}

type MutableInjectedTextRowsAtBufferRow = {
  readonly before: InjectedTextRow[]
  readonly after: InjectedTextRow[]
}

type InjectedTextRowIndex = ReadonlyMap<number, InjectedTextRowsAtBufferRow>

type WrapSegment = {
  readonly inputRow: number
  readonly outputRow: number
  readonly segmentIndex: number
  readonly startColumn: number
  readonly endColumn: number
  readonly startVisualColumn: number
  readonly endVisualColumn: number
}

export type WrapMap = {
  readonly wrapColumn: number
  readonly segments: readonly WrapSegment[]
}

const DEFAULT_TAB_SIZE = 4

export function normalizeTabSize(tabSize: number | undefined): number {
  if (tabSize === undefined) return DEFAULT_TAB_SIZE
  if (!Number.isFinite(tabSize) || tabSize <= 0) return DEFAULT_TAB_SIZE
  return Math.max(1, Math.floor(tabSize))
}

export function bufferColumnToVisualColumn(
  text: string,
  column: number,
  tabSize = DEFAULT_TAB_SIZE,
): number {
  let visual = 0
  const end = clampColumn(column, text.length)

  for (let index = 0; index < end; index += 1) {
    visual += visualWidthForChar(text[index]!, visual, tabSize)
  }

  return visual
}

export function visualColumnToBufferColumn(
  text: string,
  visualColumn: number,
  bias: TransformBias = 'nearest',
  tabSize = DEFAULT_TAB_SIZE,
): number {
  const target = Math.max(0, visualColumn)
  let visual = 0

  for (let index = 0; index < text.length; index += 1) {
    const next = visual + visualWidthForChar(text[index]!, visual, tabSize)
    const column = columnForVisualTarget(index, visual, next, target, bias)
    if (column !== null) return column
    visual = next
  }

  return text.length
}

export function visualColumnLength(text: string, tabSize = DEFAULT_TAB_SIZE): number {
  return bufferColumnToVisualColumn(text, text.length, tabSize)
}

export function bufferPointToTabPoint(
  text: string,
  point: Point,
  tabSize = DEFAULT_TAB_SIZE,
): TabPoint {
  return asTabPoint({
    row: point.row,
    column: bufferColumnToVisualColumn(text, point.column, tabSize),
  })
}

export function tabPointToBufferPoint(
  text: string,
  point: TabPoint,
  bias: TransformBias = 'nearest',
  tabSize = DEFAULT_TAB_SIZE,
): Point {
  return {
    row: point.row,
    column: visualColumnToBufferColumn(text, point.column, bias, tabSize),
  }
}

export function createWrapMap(
  rows: readonly { readonly row: number; readonly text: string }[],
  wrapColumn: number,
  tabSize = DEFAULT_TAB_SIZE,
): WrapMap {
  const width = normalizeWrapColumn(wrapColumn)
  const segments: WrapSegment[] = []

  for (const row of rows) {
    appendWrapSegments(segments, row.row, row.text, width, tabSize)
  }

  return { wrapColumn: width, segments }
}

export function tabPointToWrapPoint(map: WrapMap, point: TabPoint): WrapPoint {
  const segment = wrapSegmentForInput(map, point.row, point.column)
  if (!segment) return asWrapPoint(point)

  return asWrapPoint({
    row: segment.outputRow,
    column: point.column - segment.startVisualColumn,
  })
}

export function wrapPointToTabPoint(
  map: WrapMap,
  point: WrapPoint,
  bias: TransformBias = 'nearest',
): TabPoint {
  const segment = wrapSegmentForOutput(map, point.row)
  if (!segment) return asTabPoint(point)

  const column = segment.startVisualColumn + clampWrapColumn(point.column, segment, bias)
  return asTabPoint({ row: segment.inputRow, column })
}

export function blockPointToBufferPoint(
  rows: readonly DisplayRow[],
  point: BlockPoint,
  bias: TransformBias = 'nearest',
): Point {
  const row = rows[clampColumn(point.row, Math.max(0, rows.length - 1))]
  if (!row) return { row: 0, column: 0 }
  if (row.kind === 'text') return { row: row.bufferRow, column: point.column }
  return blockRowFallbackPoint(row, bias)
}

export function isDocumentTextDisplayRow(
  row: DisplayRow | undefined,
): row is DisplayDocumentTextRow {
  return row?.kind === 'text' && row.source === 'document'
}

export function isInjectedTextDisplayRow(
  row: DisplayRow | undefined,
): row is DisplayInjectedTextRow {
  return row?.kind === 'text' && row.source === 'injected'
}

export type DisplayRowLineInput = {
  readonly visibleLineCount: number
  readonly bufferRowForVisibleRow: (row: number) => number
  readonly lineText: (bufferRow: number) => string
  readonly lineStartOffset: (bufferRow: number) => number
  readonly lineEndOffset: (bufferRow: number) => number
  readonly wrapColumn?: number | null
  readonly blocks?: readonly BlockRow[]
  readonly injectedTextRows?: readonly InjectedTextRow[]
  readonly tabSize?: number
}

export function createDisplayRows(options: {
  readonly lineStarts: readonly number[]
  readonly text: string
  readonly bufferRowForVisibleRow: (row: number) => number
  readonly visibleLineCount: number
  readonly wrapColumn?: number | null
  readonly blocks?: readonly BlockRow[]
  readonly injectedTextRows?: readonly InjectedTextRow[]
  readonly tabSize?: number
}): DisplayRow[] {
  return createDisplayRowsFromLines({
    ...options,
    lineText: (row) => lineTextFromFullText(options.text, options.lineStarts, row),
    lineStartOffset: (row) => lineStartOffsetFromLineStarts(options.text, options.lineStarts, row),
    lineEndOffset: (row) => lineEndOffsetFromLineStarts(options.text, options.lineStarts, row),
  })
}

export function createDisplayRowsFromLines(options: DisplayRowLineInput): DisplayRow[] {
  const rows: DisplayRow[] = []
  const blocks = blockRowIndex(options.blocks ?? [])
  const injectedTextRows = injectedTextRowIndex(options.injectedTextRows ?? [])
  const tabSize = options.tabSize ?? DEFAULT_TAB_SIZE

  for (let visibleRow = 0; visibleRow < options.visibleLineCount; visibleRow += 1) {
    appendDisplayRowsForVisibleRow(rows, visibleRow, blocks, injectedTextRows, options, tabSize)
  }

  return rows
}

const asTabPoint = (point: Point): TabPoint => point as TabPoint
const asWrapPoint = (point: Point): WrapPoint => point as WrapPoint

export function normalizeBlockLanes(lanes: readonly BlockLane[]): readonly BlockLane[] {
  return lanes
    .filter((lane) => lane.id.length > 0)
    .filter((lane) => lane.startBufferRow >= 0)
    .filter((lane) => lane.endBufferRow >= lane.startBufferRow)
    .map((lane) => ({ ...lane, widthPx: normalizeLaneWidthPx(lane.widthPx) }))
    .filter((lane) => lane.widthPx > 0)
    .toSorted((left, right) => {
      return (
        left.startBufferRow - right.startBufferRow ||
        left.endBufferRow - right.endBufferRow ||
        lanePlacementOrder(left.placement) - lanePlacementOrder(right.placement) ||
        left.id.localeCompare(right.id)
      )
    })
}

export function blockLaneCoversBufferRow(lane: BlockLane, bufferRow: number): boolean {
  if (bufferRow < lane.startBufferRow) return false
  return bufferRow <= lane.endBufferRow
}

const appendDisplayRowsForVisibleRow = (
  rows: DisplayRow[],
  visibleRow: number,
  blocks: BlockRowIndex,
  injectedTextRows: InjectedTextRowIndex,
  options: DisplayRowLineInput,
  tabSize: number,
): void => {
  const bufferRow = options.bufferRowForVisibleRow(visibleRow)
  const text = options.lineText(bufferRow)
  const startOffset = options.lineStartOffset(bufferRow)
  appendInjectedTextRows(
    rows,
    injectedTextRows,
    bufferRow,
    'before',
    startOffset,
    options.wrapColumn,
    tabSize,
  )
  appendBlockRows(rows, blocks, bufferRow, 'before', startOffset)
  appendDocumentTextDisplayRows(rows, bufferRow, text, startOffset, options.wrapColumn, tabSize)
  appendBlockRows(rows, blocks, bufferRow, 'after', options.lineEndOffset(bufferRow))
  appendInjectedTextRows(
    rows,
    injectedTextRows,
    bufferRow,
    'after',
    options.lineEndOffset(bufferRow),
    options.wrapColumn,
    tabSize,
  )
}

const appendDocumentTextDisplayRows = (
  rows: DisplayRow[],
  bufferRow: number,
  text: string,
  startOffset: number,
  wrapColumn: number | null | undefined,
  tabSize: number,
): void => {
  const segments = textSegments(text, wrapColumn, tabSize)
  for (const segment of segments) {
    rows.push({
      kind: 'text',
      source: 'document',
      index: rows.length,
      bufferRow,
      startOffset: startOffset + segment.startColumn,
      endOffset: startOffset + segment.endColumn,
      text: text.slice(segment.startColumn, segment.endColumn),
      sourceText: text,
      sourceStartColumn: segment.startColumn,
      sourceEndColumn: segment.endColumn,
      wrapSegment: segment.segmentIndex,
    })
  }
}

const appendInjectedTextRows = (
  rows: DisplayRow[],
  injectedTextRows: InjectedTextRowIndex,
  bufferRow: number,
  placement: InjectedTextRowPlacement,
  offset: number,
  wrapColumn: number | null | undefined,
  tabSize: number,
): void => {
  const rowInjections = injectedTextRows.get(bufferRow)?.[placement]
  if (!rowInjections) return

  for (const injected of rowInjections) {
    appendInjectedTextRowSegments(rows, injected, offset, wrapColumn, tabSize)
  }
}

const appendInjectedTextRowSegments = (
  rows: DisplayRow[],
  injected: InjectedTextRow,
  offset: number,
  wrapColumn: number | null | undefined,
  tabSize: number,
): void => {
  const segments = textSegments(injected.text, wrapColumn, tabSize)
  for (const segment of segments) {
    rows.push(injectedTextDisplayRow(rows.length, injected, offset, segment))
  }
}

const injectedTextDisplayRow = (
  index: number,
  injected: InjectedTextRow,
  offset: number,
  segment: Omit<WrapSegment, 'inputRow' | 'outputRow'>,
): DisplayInjectedTextRow => ({
  kind: 'text',
  source: 'injected',
  id: injected.id,
  index,
  bufferRow: injected.anchorBufferRow,
  anchorBufferRow: injected.anchorBufferRow,
  placement: injected.placement,
  order: injected.order ?? 0,
  startOffset: offset,
  endOffset: offset,
  text: injected.text.slice(segment.startColumn, segment.endColumn),
  sourceText: injected.text,
  sourceStartColumn: segment.startColumn,
  sourceEndColumn: segment.endColumn,
  wrapSegment: segment.segmentIndex,
  ...(injected.className === undefined ? {} : { className: injected.className }),
  ...(injected.gutterClassName === undefined ? {} : { gutterClassName: injected.gutterClassName }),
  ...(injected.metadata === undefined ? {} : { metadata: injected.metadata }),
})

const appendBlockRows = (
  rows: DisplayRow[],
  blocks: BlockRowIndex,
  bufferRow: number,
  placement: BlockRowPlacement,
  offset: number,
): void => {
  const rowBlocks = blocks.get(bufferRow)?.[placement]
  if (!rowBlocks) return

  for (const block of rowBlocks) {
    appendBlockRowUnits(rows, block, offset)
  }
}

const appendBlockRowUnits = (rows: DisplayRow[], block: BlockRow, offset: number): void => {
  const heightRows = normalizeHeightRows(block.heightRows)
  const heightPx = normalizeHeightPx(block.heightPx)
  rows.push({
    kind: 'block',
    id: block.id,
    index: rows.length,
    anchorBufferRow: block.anchorBufferRow,
    placement: block.placement,
    unitIndex: 0,
    heightRows,
    ...(heightPx === undefined ? {} : { heightPx }),
    ...(block.heightMeasured === true ? { heightMeasured: true } : {}),
    startOffset: offset,
    endOffset: offset,
    text: block.text ?? '',
  })
}

const textSegments = (
  text: string,
  wrapColumn: number | null | undefined,
  tabSize: number,
): readonly Omit<WrapSegment, 'inputRow' | 'outputRow'>[] => {
  const width = wrapColumn ? normalizeWrapColumn(wrapColumn) : 0
  if (width <= 0) return [fullTextSegment(text, tabSize)]

  const segments: Omit<WrapSegment, 'inputRow' | 'outputRow'>[] = []
  let segmentStartColumn = 0
  let segmentStartVisual = 0
  let segmentVisual = 0
  let visual = 0

  for (let column = 0; column < text.length; column += 1) {
    const charWidth = visualWidthForChar(text[column]!, visual, tabSize)
    if (segmentVisual > 0 && segmentVisual + charWidth > width) {
      segments.push(segmentForColumns(segments.length, text, segmentStartColumn, column, tabSize))
      segmentStartColumn = column
      segmentStartVisual = visual
      segmentVisual = 0
    }

    segmentVisual += charWidth
    visual += charWidth
  }

  segments.push({
    segmentIndex: segments.length,
    startColumn: segmentStartColumn,
    endColumn: text.length,
    startVisualColumn: segmentStartVisual,
    endVisualColumn: visual,
  })
  return segments
}

const appendWrapSegments = (
  segments: WrapSegment[],
  row: number,
  text: string,
  wrapColumn: number,
  tabSize: number,
): void => {
  const rowSegments = textSegments(text, wrapColumn, tabSize)
  for (const segment of rowSegments) {
    segments.push({
      ...segment,
      inputRow: row,
      outputRow: segments.length,
    })
  }
}

const fullTextSegment = (
  text: string,
  tabSize: number,
): Omit<WrapSegment, 'inputRow' | 'outputRow'> => ({
  segmentIndex: 0,
  startColumn: 0,
  endColumn: text.length,
  startVisualColumn: 0,
  endVisualColumn: visualColumnLength(text, tabSize),
})

const segmentForColumns = (
  index: number,
  text: string,
  startColumn: number,
  endColumn: number,
  tabSize: number,
): Omit<WrapSegment, 'inputRow' | 'outputRow'> => ({
  segmentIndex: index,
  startColumn,
  endColumn,
  startVisualColumn: bufferColumnToVisualColumn(text, startColumn, tabSize),
  endVisualColumn: bufferColumnToVisualColumn(text, endColumn, tabSize),
})

const wrapSegmentForInput = (map: WrapMap, row: number, column: number): WrapSegment | undefined =>
  map.segments.find((segment) => {
    if (segment.inputRow !== row) return false
    if (column < segment.startVisualColumn) return false
    return column <= segment.endVisualColumn
  })

const wrapSegmentForOutput = (map: WrapMap, row: number): WrapSegment | undefined =>
  map.segments.find((segment) => segment.outputRow === row)

const clampWrapColumn = (column: number, segment: WrapSegment, bias: TransformBias): number => {
  const length = segment.endVisualColumn - segment.startVisualColumn
  if (bias === 'after') return clampColumn(column, length)
  return clampColumn(column, length)
}

const columnForVisualTarget = (
  index: number,
  visual: number,
  next: number,
  target: number,
  bias: TransformBias,
): number | null => {
  if (target < visual || target > next) return null
  if (target === visual) return index
  if (target === next) return index + 1
  if (bias === 'before') return index
  if (bias === 'after') return index + 1
  return target - visual <= next - target ? index : index + 1
}

const visualWidthForChar = (char: string, column: number, tabSize: number): number => {
  if (char !== '\t') return 1
  return tabSize - (column % tabSize)
}

const blockRowFallbackPoint = (row: DisplayBlockRow, bias: TransformBias): Point => {
  const nextRow = row.placement === 'before' && bias === 'after'
  return { row: row.anchorBufferRow + (nextRow ? 1 : 0), column: 0 }
}

const normalizeBlockRows = (blocks: readonly BlockRow[]): readonly BlockRow[] =>
  blocks
    .filter((block) => block.id.length > 0)
    .filter((block) => block.anchorBufferRow >= 0)
    .toSorted((left, right) => {
      return (
        left.anchorBufferRow - right.anchorBufferRow ||
        placementOrder(left.placement) - placementOrder(right.placement) ||
        left.id.localeCompare(right.id)
      )
    })

const placementOrder = (placement: BlockRowPlacement): number => (placement === 'before' ? 0 : 1)

const normalizeInjectedTextRows = (rows: readonly InjectedTextRow[]): readonly InjectedTextRow[] =>
  rows
    .filter((row) => row.id.length > 0)
    .filter((row) => row.anchorBufferRow >= 0)
    .toSorted((left, right) => {
      return (
        left.anchorBufferRow - right.anchorBufferRow ||
        placementOrder(left.placement) - placementOrder(right.placement) ||
        (left.order ?? 0) - (right.order ?? 0) ||
        left.id.localeCompare(right.id)
      )
    })

const lanePlacementOrder = (placement: BlockLanePlacement): number => (placement === 'left' ? 0 : 1)

const blockRowIndex = (blocks: readonly BlockRow[]): BlockRowIndex => {
  const index = new Map<number, MutableBlockRowsAtBufferRow>()

  for (const block of normalizeBlockRows(blocks)) {
    blockRowsAtBufferRow(index, block.anchorBufferRow)[block.placement].push(block)
  }

  return index
}

const injectedTextRowIndex = (rows: readonly InjectedTextRow[]): InjectedTextRowIndex => {
  const index = new Map<number, MutableInjectedTextRowsAtBufferRow>()

  for (const row of normalizeInjectedTextRows(rows)) {
    injectedTextRowsAtBufferRow(index, row.anchorBufferRow)[row.placement].push(row)
  }

  return index
}

const blockRowsAtBufferRow = (
  index: Map<number, MutableBlockRowsAtBufferRow>,
  bufferRow: number,
): MutableBlockRowsAtBufferRow => {
  const existing = index.get(bufferRow)
  if (existing) return existing

  const blocks = { before: [], after: [] }
  index.set(bufferRow, blocks)
  return blocks
}

const injectedTextRowsAtBufferRow = (
  index: Map<number, MutableInjectedTextRowsAtBufferRow>,
  bufferRow: number,
): MutableInjectedTextRowsAtBufferRow => {
  const existing = index.get(bufferRow)
  if (existing) return existing

  const rows = { before: [], after: [] }
  index.set(bufferRow, rows)
  return rows
}

const lineTextFromFullText = (text: string, lineStarts: readonly number[], row: number): string =>
  text.slice(
    lineStartOffsetFromLineStarts(text, lineStarts, row),
    lineEndOffsetFromLineStarts(text, lineStarts, row),
  )

const lineStartOffsetFromLineStarts = (
  text: string,
  lineStarts: readonly number[],
  row: number,
): number => lineStarts[row] ?? text.length

const lineEndOffsetFromLineStarts = (
  text: string,
  lineStarts: readonly number[],
  row: number,
): number => {
  const nextLineStart = lineStarts[row + 1]
  if (nextLineStart === undefined) return text.length
  return Math.max(lineStartOffsetFromLineStarts(text, lineStarts, row), nextLineStart - 1)
}

const normalizeWrapColumn = (wrapColumn: number): number => {
  if (!Number.isFinite(wrapColumn) || wrapColumn <= 0) return 0
  return Math.max(1, Math.floor(wrapColumn))
}

const normalizeHeightRows = (heightRows: number): number => {
  if (!Number.isFinite(heightRows) || heightRows <= 0) return 1
  return Math.max(1, Math.floor(heightRows))
}

const normalizeHeightPx = (heightPx: number | undefined): number | undefined => {
  if (heightPx === undefined) return undefined
  if (!Number.isFinite(heightPx) || heightPx <= 0) return undefined
  return heightPx
}

const normalizeLaneWidthPx = (widthPx: number): number => {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 0
  return widthPx
}

const clampColumn = (value: number, max: number): number => {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(0, Math.floor(value)), Math.max(0, max))
}
