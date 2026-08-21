import {
  bufferColumnToVisualColumn,
  visualColumnToBufferColumn,
  type TransformBias,
} from '../displayTransforms'
import {
  codePointLength,
  isCombiningMark,
  isVariationSelector,
  segmentGraphemes,
  type TextSegment,
} from '../graphemes'
import { clamp } from '../style-utils'
import { rowLocalIndexForOffset, rowOffsetForLocalIndex } from './virtualizedTextViewInlineMapping'
import type {
  MountedVirtualizedTextRow,
  VirtualizedTextChunk,
  VirtualizedTextChunkPart,
  VirtualizedTextChunkTextPart,
} from './virtualizedTextViewTypes'
import type { VirtualizedTextViewInternal } from './virtualizedTextViewInternals'
import { rowTextInsetLeft, rowTextInsetRight } from './virtualizedTextViewBlockLanes'

const CONTROL_CHARACTER_CLASS = 'editor-virtualized-control-character'

/**
 * How many columns of pure arithmetic are allowed between two measured anchors on a calculated row.
 * `characterWidth` is an average taken over a probe string, so it sits a fraction of a pixel away
 * from any real advance, and multiplying it by a column index carries that error along with it —
 * unbounded in the line's length, which is why a caret drifts further from its glyph the further
 * right it goes. Re-reading a real advance every so often caps the error at whatever accumulates
 * over this many columns, for one layout read per anchor.
 */
const KEY_COLUMN_DISTANCE = 300
const COLUMN_EPSILON = 1e-9

/**
 * Boundaries as two parallel arrays rather than one object per boundary: a row is rebuilt on every
 * scroll frame that remounts it, and a character-length object array plus a sorted copy of it is
 * garbage the collector pays for while the user is dragging.
 *
 * `offsets` ascends by construction. `xs` ascends with it for every row whose parts all measured,
 * so both directions binary-search the pair in place; `xOrder` carries the x ordering only for the
 * rows that interleave measured and estimated widths and can therefore step backwards.
 */
type RowGeometry = {
  readonly offsets: Float64Array
  readonly xs: Float64Array
  /**
   * What is still owed on `xs`, or null once nothing is. A caret asks one row for one column, so
   * reading the row's every advance to answer it is the whole row's cost spent on a hundredth of
   * it. The plan holds what a boundary would be read from, and `xs` starts as sentinels that the
   * boundaries somebody actually asks about replace.
   */
  plan: MeasuredRowPlan | null
  xOrder: Uint32Array | null
  width: number
  /**
   * Flattened (x, visual column) pairs, ascending, that a calculated row extrapolated from — null
   * when it extrapolated from column zero alone. The inverse mapping has to start from the same
   * anchor the boundary did, or a hit test and the caret it places disagree about the same column.
   */
  readonly anchors: Float64Array | null
}

/** No advance is ever NaN, so it is free to stand for a boundary that has not been read yet. */
const UNREAD = Number.NaN

const UNIT_LEFT = 0
const UNIT_RIGHT = 1

type MeasuredUnitKind = 'text' | 'control' | 'widget'

/**
 * One advance a measured row is assembled from: a grapheme of a text part, a control glyph, or a
 * mounted replacement. Which offsets it spans follows from the text alone and costs no layout, so a
 * row can be laid out in units in full while none of them has been measured.
 */
type MeasuredUnit = {
  readonly kind: MeasuredUnitKind
  readonly node: Text | null
  readonly nodeOffset: number
  readonly nodeLength: number
  readonly element: HTMLElement | null
  readonly widthCells: number
  readonly localStart: number
  readonly localEnd: number
  /**
   * The unit this one follows inside its chunk, or -1 at a chunk's first. Only a unit that fails to
   * measure — or a replacement, which is placed rather than measured — needs it: it stands where
   * whatever precedes it ended, and that is the one direction a lazy read has to chase.
   */
  readonly previous: number
  /** Where the chunk begins, for a unit with nothing before it to stand after. */
  readonly chunkX: number
}

type MeasuredRowPlan = {
  readonly view: VirtualizedTextViewInternal
  readonly row: MountedVirtualizedTextRow
  readonly units: readonly MeasuredUnit[]
  readonly lefts: Float64Array
  readonly widths: Float64Array
  /** Per boundary: the unit whose edge stands there, or -1 for one no unit reaches. */
  readonly writerUnit: Int32Array
  readonly writerSide: Uint8Array
  readonly writerX: Float64Array
  measurement: RowMeasurementContext | null
}

type BoundaryBuffer = {
  offsets: Float64Array
  xs: Float64Array
  length: number
}

type PlanBuffer = {
  readonly offsets: Float64Array
  readonly writerUnit: Int32Array
  readonly writerSide: Uint8Array
  readonly writerX: Float64Array
  length: number
}

/**
 * Sampled once and carried through every advance a row is read for. `scale` is itself a layout
 * read, and two readings of it taken at different points would put the boundaries either side of
 * them in different spaces.
 */
type RowMeasurementContext = {
  readonly row: MountedVirtualizedTextRow
  readonly scale: number
}

/**
 * One Range reused for every segment instead of one allocated per grapheme, since a measured row
 * asks for as many rects as it has graphemes and the Range is scratch in all of them. It is parked
 * on a detached node between reads so it stops holding the row it last measured, which the row pool
 * is free to recycle underneath it.
 */
type MeasurementScratch = {
  readonly document: Document
  readonly range: Range
  readonly parking: Text
}

type RowGeometryCache = {
  readonly key: string
  readonly geometry: RowGeometry
}

type MutableRowGeometryCache = MountedVirtualizedTextRow & {
  geometryCache: RowGeometryCache | null
}

type RowContentWidthCache = {
  readonly key: string
  readonly width: number
}

type GeometryRangeSegment = {
  readonly start: number
  readonly end: number
  readonly left: number
  readonly width: number
}

type DomBoundary = {
  readonly node: Node
  readonly offset: number
}

export type RenderedChunkParts = {
  readonly nodes: readonly Node[]
  readonly parts: readonly VirtualizedTextChunkPart[]
  readonly textNode: Text
}

/** Where a mounted inline replacement sits in a row's rendered text, in row-local indices. */
export type InlineWidgetPlacement = {
  readonly localStart: number
  readonly localEnd: number
  readonly element: HTMLSpanElement
}

type ControlCharacterInfo = {
  readonly label: string
  readonly widthCells: number
  readonly key: string
}

let rowRectMeasurementDepth = 0
let measuredRowRects: Map<HTMLElement, DOMRect> | null = null
let measurementScratch: MeasurementScratch | null = null
const measuredRowWidths = new WeakMap<HTMLElement, RowContentWidthCache>()
/**
 * Kept per element rather than per row: a mounted replacement outlives the rows it is painted into,
 * and its advance is a property of the node, not of whichever row currently hosts it.
 */
const inlineWidgetWidths = new WeakMap<HTMLElement, number>()
/**
 * Bumped whenever any of those advances moves, and carried in the row geometry key so that a row
 * hosting a replacement retires everything keyed against it. Global rather than per element,
 * because the key is built from the row and a row does not know which nodes it is standing on.
 */
let inlineWidgetWidthRevision = 0

export function isSimpleRowText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (!isSimpleRowCodeUnit(text.charCodeAt(index))) return false
  }

  return true
}

export function createTextChunkParts(
  node: Text,
  localStart: number,
  localEnd: number,
): readonly VirtualizedTextChunkTextPart[] {
  return [
    {
      kind: 'text',
      localStart,
      localEnd,
      node,
    },
  ]
}

export function createRenderedChunkParts(
  document: Document,
  text: string,
  localStart: number,
  cellWidth: number,
  widgets: readonly InlineWidgetPlacement[] = [],
): RenderedChunkParts {
  const parts: VirtualizedTextChunkPart[] = []
  const nodes: Node[] = []
  let cursor = 0

  for (const widget of widgets) {
    const start = widget.localStart - localStart
    appendRenderedText(
      document,
      parts,
      nodes,
      text.slice(cursor, start),
      localStart + cursor,
      cellWidth,
    )
    nodes.push(widget.element)
    parts.push({
      kind: 'widget',
      localStart: widget.localStart,
      localEnd: widget.localEnd,
      element: widget.element,
    })
    cursor = widget.localEnd - localStart
  }

  appendRenderedText(document, parts, nodes, text.slice(cursor), localStart + cursor, cellWidth)
  return {
    nodes,
    parts,
    textNode: firstTextNode(parts) ?? document.createTextNode(''),
  }
}

function appendRenderedText(
  document: Document,
  parts: VirtualizedTextChunkPart[],
  nodes: Node[],
  text: string,
  localStart: number,
  cellWidth: number,
): void {
  let run = ''
  let runStart = localStart
  let index = 0

  while (index < text.length) {
    const code = text.charCodeAt(index)
    const oneCell = oneCellControlCharacterLabel(code)
    if (oneCell !== null) {
      run += oneCell
      index += 1
      continue
    }

    const control = controlCharacterInfo(code)
    if (!control) {
      run += text[index]!
      index += 1
      continue
    }

    appendTextPart(document, parts, nodes, runStart, run)
    run = ''
    index += 1
    appendControlPart(document, parts, nodes, localStart + index - 1, control, cellWidth)
    runStart = localStart + index
  }

  appendTextPart(document, parts, nodes, runStart, run)
}

/**
 * Reports whether the advance changed, so a caller that has just measured can tell whether anything
 * that already read this width has to read it again.
 */
export function setInlineWidgetMeasuredWidth(element: HTMLElement, width: number): boolean {
  if (inlineWidgetWidths.get(element) === width) return false

  inlineWidgetWidths.set(element, width)
  inlineWidgetWidthRevision += 1
  return true
}

export function clearRowGeometryCache(row: MountedVirtualizedTextRow): void {
  ;(row as MutableRowGeometryCache).geometryCache = null
}

export function clearRowGeometryCaches(view: VirtualizedTextViewInternal): void {
  for (const row of view.rowElements.values()) clearRowGeometryCache(row)
  for (const row of view.rowPool) clearRowGeometryCache(row)
}

export function offsetToX(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  offset: number,
): number {
  // TODO: Add BiDi/RTL-aware geometry. The current mapping assumes logical offsets
  // advance left-to-right, so Hebrew and mixed-direction runs assign the wrong
  // visual edge to offsets and break caret positions, hit testing, and selection widths.
  const geometry = ensureRowGeometry(view, row)
  const clamped = clamp(offset, row.startOffset, row.endOffset)
  return xForOffset(geometry, clamped)
}

export function xToOffset(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  x: number,
): number {
  if (rowUsesCalculatedGeometry(row)) return calculatedXToOffset(view, row, x)

  const geometry = ensureRowGeometry(view, row)
  return offsetForX(geometry, Math.max(0, x))
}

/** Null when the row's rendered width is only available for the price of a layout read. */
export function knownRowContentWidth(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): number | null {
  const key = rowGeometryCacheKey(view, row)
  const cached = row.geometryCache as RowGeometryCache | null
  if (cached?.key === key && !cached.geometry.plan) return cached.geometry.width
  if (rowUsesCalculatedGeometry(row)) return calculatedRowWidth(view, row)

  const measured = measuredRowWidths.get(row.element)
  return measured?.key === key ? measured.width : null
}

/**
 * Pays that price: one rect per chunk, against the one per grapheme a geometry build spends. What
 * comes back is kept against the key that retires the row's geometry, so even a row whose rects all
 * read empty is asked once rather than once per frame.
 */
export function measureRowContentWidth(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): number {
  const known = knownRowContentWidth(view, row)
  if (known !== null) return known

  const measurement = { row, scale: rowClientRectScale(row) }
  let contentRight = 0
  for (const chunk of row.chunks) {
    const measured = measuredChunkRect(measurement, chunk)
    if (measured) contentRight = Math.max(contentRight, measured.left + measured.width)
  }

  const width = Math.max(estimatedRowContentWidth(view, row), contentRight + rowTextInsetRight(row))
  measuredRowWidths.set(row.element, { key: rowGeometryCacheKey(view, row), width })
  return width
}

export function rangeSegments(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  start: number,
  end: number,
): readonly GeometryRangeSegment[] {
  if (row.kind !== 'text') return []
  if (row.source === 'injected') return []
  if (end <= start) return []

  const segments: GeometryRangeSegment[] = []
  for (const chunk of row.chunks) {
    appendRangeSegmentForChunk(segments, view, row, chunk, start, end)
  }

  return segments
}

function estimatedDisplayCells(text: string, tabSize: number): number {
  const simpleCells = simpleDisplayCellsOrNull(text, 0, text.length, 0, tabSize)
  if (simpleCells !== null) return simpleCells
  return estimatedDisplayCellsFrom(text, 0, text.length, 0, tabSize).cells
}

export function estimatedDisplayCellForColumn(
  text: string,
  column: number,
  tabSize: number,
): number {
  const end = clamp(column, 0, text.length)
  const simpleCells = simpleDisplayCellsOrNull(text, 0, end, 0, tabSize)
  if (simpleCells !== null) return simpleCells

  return estimatedDisplayCellsFrom(text, 0, end, 0, tabSize).cells
}

export function estimatedColumnToBufferColumn(
  text: string,
  visualColumn: number,
  bias: TransformBias,
  tabSize: number,
): number {
  if (isSimpleRowText(text)) return visualColumnToBufferColumn(text, visualColumn, bias, tabSize)

  const target = Math.max(0, visualColumn)
  let visual = 0
  let index = 0
  while (index < text.length) {
    const step = estimatedStep(text, index, visual, tabSize)
    const column = columnForVisualTarget(
      index,
      index + step.length,
      visual,
      visual + step.cells,
      target,
      bias,
    )
    if (column !== null) return column
    visual += step.cells
    index += step.length
  }

  return text.length
}

function estimatedRowWidth(text: string, tabSize: number, cellWidth: number): number {
  return estimatedDisplayCells(text, tabSize) * cellWidth
}

export function createDomRangeForChunkRange(
  document: Document,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): Range | null {
  const boundaries = domBoundariesForChunkRange(row, chunk, start, end)
  if (!boundaries) return null

  const range = document.createRange()
  range.setStart(boundaries.start.node, boundaries.start.offset)
  range.setEnd(boundaries.end.node, boundaries.end.offset)
  return range
}

export function createStaticRangeForChunkRange(
  document: Document,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): StaticRange | null {
  const boundaries = domBoundariesForChunkRange(row, chunk, start, end)
  const StaticRangeConstructor = document.defaultView?.StaticRange
  if (!boundaries || !StaticRangeConstructor) return null

  return new StaticRangeConstructor({
    endContainer: boundaries.end.node,
    endOffset: boundaries.end.offset,
    startContainer: boundaries.start.node,
    startOffset: boundaries.start.offset,
  })
}

function domBoundariesForChunkRange(
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): { readonly start: DomBoundary; readonly end: DomBoundary } | null {
  if (end <= start) return null
  if (end <= chunk.startOffset || start >= chunk.endOffset) return null

  const localStart = clampChunkLocal(chunk, rowLocalIndexForOffset(row, start, 'before'))
  const localEnd = clampChunkLocal(chunk, rowLocalIndexForOffset(row, end, 'after'))
  const startBoundary = domBoundaryForChunkLocalOffset(chunk, localStart)
  const endBoundary = domBoundaryForChunkLocalOffset(chunk, localEnd)
  if (!startBoundary || !endBoundary) return null

  return { end: endBoundary, start: startBoundary }
}

export function domBoundaryForOffset(
  row: MountedVirtualizedTextRow,
  offset: number,
): DomBoundary | null {
  const local = clamp(rowLocalIndexForOffset(row, offset), 0, row.text.length)
  const chunk = chunkForLocalOffset(row, local)
  if (!chunk) return null
  return domBoundaryForChunkLocalOffset(chunk, local)
}

export function offsetFromDomBoundary(
  row: MountedVirtualizedTextRow,
  node: Node,
  offset: number,
): number | null {
  const textOffset = offsetFromTextPartBoundary(row, node, offset)
  if (textOffset !== null) return textOffset

  const controlOffset = offsetFromControlPartBoundary(row, node, offset)
  if (controlOffset !== null) return controlOffset

  const widgetOffset = offsetFromInlineWidgetBoundary(row, node, offset)
  if (widgetOffset !== null) return widgetOffset

  return offsetFromElementBoundary(row, node, offset)
}

/**
 * A replacement stands for its whole source span, so a boundary the browser found somewhere in the
 * rendered node — a double-click reaching into an image's alt text, a drag that ended over it —
 * resolves to an edge of the span rather than to whatever the row ends in.
 */
function offsetFromInlineWidgetBoundary(
  row: MountedVirtualizedTextRow,
  node: Node,
  offset: number,
): number | null {
  const part = inlineWidgetPartForNode(row, node)
  if (!part) return null
  if (node === part.element && offset > 0) return rowOffsetForLocalIndex(row, part.localEnd)

  return rowOffsetForLocalIndex(row, part.localStart)
}

function inlineWidgetPartForNode(
  row: MountedVirtualizedTextRow,
  node: Node,
): Extract<VirtualizedTextChunkPart, { readonly kind: 'widget' }> | null {
  for (const chunk of row.chunks) {
    const part = chunk.parts.find((candidate) => {
      if (candidate.kind !== 'widget') return false
      return candidate.element === node || candidate.element.contains(node)
    })
    if (part?.kind === 'widget') return part
  }

  return null
}

function ensureRowGeometry(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): RowGeometry {
  const key = rowGeometryCacheKey(view, row)
  const cached = row.geometryCache as RowGeometryCache | null
  if (cached?.key === key) return cached.geometry

  const geometry = buildRowGeometry(view, row)
  ;(row as MutableRowGeometryCache).geometryCache = { key, geometry }
  return geometry
}

function rowGeometryCacheKey(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): string {
  return [
    row.textRevision,
    row.chunkKey,
    // Pins the key to a line: a row's element and its record are both recycled onto whatever line
    // scrolls into their place, and every other part of this key survives that move intact.
    row.startOffset,
    row.text.length,
    row.displayKind,
    row.foldMarkerKey,
    row.rowDecorationKey,
    // Inline-kind classes restyle the row's font, so measured boundaries die with them.
    row.inlineKindsClassName,
    // A replacement that settles on its real size moves every column after it, and the row's own
    // text is unchanged when it does — nothing else in this key notices.
    inlineWidgetWidthRevision,
    row.leftBlockLaneWidth,
    row.rightBlockLaneWidth,
    view.tabSize,
    view.metrics.characterWidth,
  ].join(':')
}

function buildRowGeometry(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): RowGeometry {
  if (rowUsesCalculatedGeometry(row)) return buildCalculatedRowGeometry(view, row)
  return buildMeasuredRowGeometry(view, row)
}

/**
 * Calculated geometry multiplies the global character width, which assumes every row renders in the
 * editor's base font. Rows with inline replacements can be restyled per replacement kind — a
 * markdown heading row is bold and larger — so their advance widths only exist in the DOM.
 */
function rowUsesCalculatedGeometry(row: MountedVirtualizedTextRow): boolean {
  if (row.inlineMapping) return false
  return isSimpleRowText(row.text)
}

function buildCalculatedRowGeometry(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): RowGeometry {
  const boundaries = createBoundaryBuffer(row)
  const anchors: number[] = []
  // Read whether or not this row will re-anchor on anything: the boundaries below are written in
  // the row's own space either way, and the inverse mapping reads them back in it.
  const scale = rowClientRectScale(row)
  const measurement = row.text.length > KEY_COLUMN_DISTANCE ? { row, scale } : null
  const cellWidth = cellWidthInRowSpace(view, scale)
  for (const chunk of row.chunks) {
    appendCalculatedChunkBoundaries(boundaries, view, row, chunk, cellWidth, measurement, anchors)
  }

  return geometryFromBoundaries(row, boundaries, calculatedRowWidth(view, row), anchors)
}

function calculatedRowWidth(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): number {
  const columns = bufferColumnToVisualColumn(row.text, row.text.length, view.tabSize)
  return rowTextInsetLeft(row) + columns * view.metrics.characterWidth + rowTextInsetRight(row)
}

function calculatedXToOffset(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  x: number,
): number {
  const anchor = calculatedRowAnchorForX(view, row, x)
  // Undoing the anchor's own offset costs a few bits, so a column's exact left edge can come back a
  // hair under the whole number it was built from and fall into the cell before it. The tolerance
  // is orders of magnitude below a pixel, so it can only reclaim that.
  const cells = (x - anchor.x) / Math.max(1, calculatedCellWidth(view, row)) + COLUMN_EPSILON
  // Each anchor speaks only for its own columns. Re-anchoring on a measured
  // advance leaves a gap wherever the measured position and the extrapolated
  // one disagree, and an x inside that gap extrapolates past the span into
  // columns the next anchor owns — a click landing a character or two right of
  // where the caret is drawn, and not even monotonically.
  const visualColumn = clamp(anchor.column + Math.floor(cells), anchor.column, anchor.lastColumn)
  const local = visualColumnToBufferColumn(row.text, visualColumn, 'nearest', view.tabSize)
  return rowOffsetForLocalIndex(row, clampLocalOffsetToMountedChunks(row, local))
}

type CalculatedRowAnchor = {
  readonly x: number
  readonly column: number
  readonly lastColumn: number
}

function calculatedRowAnchorForX(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  x: number,
): CalculatedRowAnchor {
  const lastColumn = bufferColumnToVisualColumn(row.text, row.text.length, view.tabSize)
  const base = { x: rowTextInsetLeft(row), column: 0, lastColumn }
  if (row.text.length <= KEY_COLUMN_DISTANCE) return base

  const anchors = ensureRowGeometry(view, row).anchors
  if (!anchors) return base

  let anchor = base
  for (let index = 0; index + 1 < anchors.length; index += 2) {
    const anchorX = anchors[index]!
    const anchorColumn = anchors[index + 1]!
    if (anchorX > x) return { ...anchor, lastColumn: Math.max(anchor.column, anchorColumn - 1) }

    anchor = { x: anchorX, column: anchorColumn, lastColumn }
  }

  return anchor
}

// The measured advances an anchor is built from are read back in the row's own
// space, so the estimate they are extended with has to be too: metrics are
// probed through the host, which may scale everything it contains.
function cellWidthInRowSpace(view: VirtualizedTextViewInternal, scale: number): number {
  return view.metrics.characterWidth / scale
}

function calculatedCellWidth(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): number {
  return cellWidthInRowSpace(view, rowClientRectScale(row))
}

const clampChunkLocal = (chunk: VirtualizedTextChunk, local: number): number =>
  clamp(local, chunk.localStart, chunk.localEnd)

function clampLocalOffsetToMountedChunks(
  row: MountedVirtualizedTextRow,
  localOffset: number,
): number {
  const first = row.chunks[0]
  const last = row.chunks.at(-1)
  if (!first || !last) return clamp(localOffset, 0, row.text.length)
  return clamp(localOffset, first.localStart, last.localEnd)
}

function appendCalculatedChunkBoundaries(
  boundaries: BoundaryBuffer,
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  cellWidth: number,
  measurement: RowMeasurementContext | null,
  anchors: number[],
): void {
  // Column zero at the row's inset is the anchor an unanchored row extrapolates from, so a row that
  // measures nothing keeps the plain multiplication it had.
  let anchorColumn = 0
  let anchorX = rowTextInsetLeft(row)
  let nextAnchorLocal = chunk.localStart

  for (let local = chunk.localStart; local <= chunk.localEnd; local += 1) {
    const column = bufferColumnToVisualColumn(row.text, local, view.tabSize)
    if (measurement && local >= nextAnchorLocal) {
      nextAnchorLocal = local + KEY_COLUMN_DISTANCE
      const measured = keyColumnX(measurement, chunk, local)
      if (measured !== null) {
        anchorColumn = column
        anchorX = measured
        anchors.push(measured, column)
      }
    }

    appendBoundary(
      boundaries,
      rowOffsetForLocalIndex(row, local),
      anchorX + (column - anchorColumn) * cellWidth,
    )
  }
}

/**
 * Null when nothing in the chunk renders `local` as text — a control glyph stands there, or the
 * column belongs to a chunk that is not mounted. There is no advance to re-anchor on, so the caller
 * keeps extending the anchor it already has.
 */
function keyColumnX(
  measurement: RowMeasurementContext,
  chunk: VirtualizedTextChunk,
  local: number,
): number | null {
  for (const part of chunk.parts) {
    if (part.kind !== 'text') continue
    if (local < part.localStart || local >= part.localEnd) continue

    return measuredTextSegmentRect(measurement, part.node, local - part.localStart, 1)?.left ?? null
  }

  return null
}

/**
 * Lays the row out in units without reading a single advance. Everything expensive is deferred to
 * `boundaryX`, which reads the one unit the asked-for boundary stands on — a caret on a paragraph
 * row costs one segment rect instead of one per grapheme in the paragraph.
 */
function buildMeasuredRowGeometry(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): RowGeometry {
  const buffer = createPlanBuffer(row)
  const units: MeasuredUnit[] = []
  for (const chunk of row.chunks) appendChunkPlan(buffer, units, view, row, chunk)
  if (buffer.length === 0) appendPlanBoundary(buffer, row.startOffset, -1, UNIT_LEFT, 0)

  return {
    offsets: buffer.offsets.subarray(0, buffer.length),
    xs: new Float64Array(buffer.length).fill(UNREAD),
    plan: {
      view,
      row,
      units,
      lefts: new Float64Array(units.length).fill(UNREAD),
      widths: new Float64Array(units.length).fill(UNREAD),
      writerUnit: buffer.writerUnit.subarray(0, buffer.length),
      writerSide: buffer.writerSide.subarray(0, buffer.length),
      writerX: buffer.writerX.subarray(0, buffer.length),
      measurement: null,
    },
    xOrder: null,
    width: UNREAD,
    anchors: null,
  }
}

function estimatedRowContentWidth(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): number {
  const textWidth = estimatedRowWidth(row.text, view.tabSize, view.metrics.characterWidth)
  return rowTextInsetLeft(row) + textWidth + rowTextInsetRight(row)
}

function appendChunkPlan(
  buffer: PlanBuffer,
  units: MeasuredUnit[],
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
): void {
  const chunkX = rowTextInsetLeft(row) + estimatedPrefixWidth(view, row, chunk.localStart)
  appendPlanBoundary(buffer, rowOffsetForLocalIndex(row, chunk.localStart), -1, UNIT_LEFT, chunkX)

  let previous = -1
  for (const part of chunk.parts) {
    previous = appendPartPlan(buffer, units, row, part, previous, chunkX)
  }

  // A chunk that rendered nothing still ends where it began; one that rendered something ends where
  // its last unit does, which is the same edge that unit already wrote.
  appendPlanBoundary(
    buffer,
    rowOffsetForLocalIndex(row, chunk.localEnd),
    previous,
    UNIT_RIGHT,
    chunkX,
  )
}

function appendPartPlan(
  buffer: PlanBuffer,
  units: MeasuredUnit[],
  row: MountedVirtualizedTextRow,
  part: VirtualizedTextChunkPart,
  previous: number,
  chunkX: number,
): number {
  if (part.kind === 'text') {
    let last = previous
    for (const segment of segmentGraphemes(part.node.data)) {
      last = appendUnitPlan(buffer, units, row, textUnit(part, segment, last, chunkX))
    }

    return last
  }

  if (part.kind === 'control') {
    return appendUnitPlan(buffer, units, row, {
      kind: 'control',
      node: null,
      nodeOffset: 0,
      nodeLength: 0,
      element: part.element,
      widthCells: part.widthCells,
      localStart: part.localStart,
      localEnd: part.localEnd,
      previous,
      chunkX,
    })
  }

  return appendUnitPlan(buffer, units, row, {
    kind: 'widget',
    node: null,
    nodeOffset: 0,
    nodeLength: 0,
    element: part.element,
    widthCells: 0,
    localStart: part.localStart,
    localEnd: part.localEnd,
    previous,
    chunkX,
  })
}

function textUnit(
  part: VirtualizedTextChunkTextPart,
  segment: TextSegment,
  previous: number,
  chunkX: number,
): MeasuredUnit {
  const localStart = part.localStart + segment.index
  return {
    kind: 'text',
    node: part.node,
    nodeOffset: segment.index,
    nodeLength: segment.segment.length,
    element: null,
    widthCells: 0,
    localStart,
    localEnd: localStart + segment.segment.length,
    previous,
    chunkX,
  }
}

function appendUnitPlan(
  buffer: PlanBuffer,
  units: MeasuredUnit[],
  row: MountedVirtualizedTextRow,
  unit: MeasuredUnit,
): number {
  const index = units.length
  units.push(unit)
  appendPlanBoundary(buffer, rowOffsetForLocalIndex(row, unit.localStart), index, UNIT_LEFT, UNREAD)
  appendPlanBoundary(buffer, rowOffsetForLocalIndex(row, unit.localEnd), index, UNIT_RIGHT, UNREAD)
  return index
}

/** Sized once against the same bound `createBoundaryBuffer` is, and appended to the same way. */
function createPlanBuffer(row: MountedVirtualizedTextRow): PlanBuffer {
  const capacity = row.text.length + row.chunks.length + 2
  return {
    offsets: new Float64Array(capacity),
    writerUnit: new Int32Array(capacity),
    writerSide: new Uint8Array(capacity),
    writerX: new Float64Array(capacity),
    length: 0,
  }
}

/**
 * Where two units meet they name the same boundary, and the later of them is the one that stands
 * there. Recording that here rather than resolving it at read time is what lets a boundary asked
 * for on its own come back as the value it would have had if the whole row had been read at once.
 */
function appendPlanBoundary(
  buffer: PlanBuffer,
  offset: number,
  unit: number,
  side: number,
  x: number,
): void {
  const last = buffer.length - 1
  const at = last >= 0 && buffer.offsets[last] === offset ? last : buffer.length
  buffer.offsets[at] = offset
  buffer.writerUnit[at] = unit
  buffer.writerSide[at] = side
  buffer.writerX[at] = x
  if (at === buffer.length) buffer.length += 1
}

function boundaryX(geometry: RowGeometry, index: number): number {
  const cached = geometry.xs[index]
  if (cached === undefined) return 0
  if (!Number.isNaN(cached)) return cached

  const plan = geometry.plan
  if (!plan) return 0

  const unit = plan.writerUnit[index]!
  const x =
    unit < 0 ? plan.writerX[index]! : resolvedUnitEdge(plan, unit, plan.writerSide[index] === 1)
  geometry.xs[index] = x
  return x
}

function resolvedUnitEdge(plan: MeasuredRowPlan, unit: number, right: boolean): number {
  resolveUnit(plan, unit)
  const left = plan.lefts[unit]!
  return right ? left + plan.widths[unit]! : left
}

/**
 * A measured advance stands at an absolute position in the row, so almost every unit answers from
 * its own rect alone. Only the ones with no rect to read — a replacement, whose drawn width is a
 * property of the mounted node rather than of the span it covers, or a segment the engine reports
 * empty — stand after whatever precedes them, and those walk backwards until something does.
 */
function resolveUnit(plan: MeasuredRowPlan, index: number): void {
  if (!Number.isNaN(plan.lefts[index]!)) return

  const placed: number[] = []
  let current = index
  while (current >= 0 && Number.isNaN(plan.lefts[current]!)) {
    const measured = measuredUnitRect(plan, plan.units[current]!)
    if (measured) {
      plan.lefts[current] = measured.left
      plan.widths[current] = measured.width
      break
    }

    placed.push(current)
    current = plan.units[current]!.previous
  }

  for (let at = placed.length - 1; at >= 0; at -= 1) {
    const unitIndex = placed[at]!
    const unit = plan.units[unitIndex]!
    plan.lefts[unitIndex] =
      unit.previous >= 0 ? plan.lefts[unit.previous]! + plan.widths[unit.previous]! : unit.chunkX
    plan.widths[unitIndex] = estimatedUnitWidth(plan, unit)
  }
}

function measuredUnitRect(
  plan: MeasuredRowPlan,
  unit: MeasuredUnit,
): { readonly left: number; readonly width: number } | null {
  if (unit.kind === 'widget') return null
  if (unit.kind === 'control') return measuredElementRect(planMeasurement(plan), unit.element!)
  return measuredTextSegmentRect(
    planMeasurement(plan),
    unit.node!,
    unit.nodeOffset,
    unit.nodeLength,
  )
}

/**
 * What a unit advances by when it has no rect of its own. A rendered replacement is the interesting
 * one: the columns it covers say nothing about how wide it draws, so its advance is the width the
 * mount observed — one rect per resize rather than one per read, and a width even while the row is
 * off-screen. Until something has measured it at all, the placeholder text's own width stands in.
 */
function estimatedUnitWidth(plan: MeasuredRowPlan, unit: MeasuredUnit): number {
  const { view, row } = plan
  if (unit.kind === 'control') return unit.widthCells * view.metrics.characterWidth

  const estimated = estimatedLocalRangeWidth(view, row, unit.localStart, unit.localEnd)
  if (unit.kind !== 'widget') return estimated
  return inlineWidgetWidths.get(unit.element!) ?? estimated
}

/**
 * Sampled at the first advance the row is asked for rather than when the plan is laid out, so a row
 * nobody measures into never reads a layout box at all. The factor is a ratio of two boxes and so
 * survives the row being scrolled, which is the only thing that moves it without retiring the plan.
 */
function planMeasurement(plan: MeasuredRowPlan): RowMeasurementContext {
  const current = plan.measurement
  if (current) return current

  const measurement = { row: plan.row, scale: rowClientRectScale(plan.row) }
  plan.measurement = measurement
  return measurement
}

/**
 * Reading a row's every boundary is what the plan exists to avoid, so this is only for the two
 * questions that genuinely need the whole row: which offset an x falls on, and how wide the row
 * draws. Both search across boundaries rather than at one, and neither can bound where it looks.
 */
function resolveRowGeometry(geometry: RowGeometry): RowGeometry {
  const plan = geometry.plan
  if (!plan) return geometry

  const { offsets, xs } = geometry
  let contentRight = 0
  let ascending = true
  for (let index = 0; index < xs.length; index += 1) {
    const x = boundaryX(geometry, index)
    if (x > contentRight) contentRight = x
    if (index > 0 && x < xs[index - 1]!) ascending = false
  }

  geometry.plan = null
  geometry.xOrder = ascending ? null : boundaryOrderByX(offsets, xs)
  geometry.width = Math.max(
    estimatedRowContentWidth(plan.view, plan.row),
    contentRight + rowTextInsetRight(plan.row),
  )
  return geometry
}

/**
 * Sized once, never grown: a row build appends in ascending offset order, so every repeat lands
 * next to the boundary it repeats and `appendBoundary` folds it away. What survives is one boundary
 * per local index — the builders never split one — plus a chunk's own end, which the chunk after it
 * appends again as its start, and the row's end.
 */
function createBoundaryBuffer(row: MountedVirtualizedTextRow): BoundaryBuffer {
  const capacity = row.text.length + row.chunks.length + 2
  return { offsets: new Float64Array(capacity), xs: new Float64Array(capacity), length: 0 }
}

function appendBoundary(boundaries: BoundaryBuffer, offset: number, x: number): void {
  const last = boundaries.length - 1
  if (last >= 0 && boundaries.offsets[last] === offset) {
    boundaries.xs[last] = x
    return
  }

  boundaries.offsets[boundaries.length] = offset
  boundaries.xs[boundaries.length] = x
  boundaries.length += 1
}

function geometryFromBoundaries(
  row: MountedVirtualizedTextRow,
  boundaries: BoundaryBuffer,
  fallbackWidth: number,
  anchors: readonly number[] | null,
): RowGeometry {
  if (boundaries.length === 0) appendBoundary(boundaries, row.startOffset, 0)

  const offsets = boundaries.offsets.subarray(0, boundaries.length)
  const xs = boundaries.xs.subarray(0, boundaries.length)
  let contentRight = 0
  let ascending = true
  for (let index = 0; index < xs.length; index += 1) {
    const x = xs[index]!
    if (x > contentRight) contentRight = x
    if (index > 0 && x < xs[index - 1]!) ascending = false
  }

  return {
    offsets,
    xs,
    plan: null,
    xOrder: ascending ? null : boundaryOrderByX(offsets, xs),
    width: Math.max(fallbackWidth, contentRight + rowTextInsetRight(row)),
    anchors: anchors && anchors.length > 0 ? Float64Array.from(anchors) : null,
  }
}

function boundaryOrderByX(offsets: Float64Array, xs: Float64Array): Uint32Array {
  const order = new Uint32Array(offsets.length)
  for (let index = 0; index < order.length; index += 1) order[index] = index
  return order.sort((left, right) => xs[left]! - xs[right]! || offsets[left]! - offsets[right]!)
}

function appendRangeSegmentForChunk(
  segments: GeometryRangeSegment[],
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): void {
  if (end <= chunk.startOffset || start >= chunk.endOffset) return

  const segmentStart = Math.max(start, chunk.startOffset)
  const segmentEnd = Math.min(end, chunk.endOffset)
  const startX = offsetToX(view, row, segmentStart)
  const endX = offsetToX(view, row, segmentEnd)
  segments.push({
    start: segmentStart,
    end: segmentEnd,
    left: Math.min(startX, endX),
    width: Math.abs(endX - startX),
  })
}

function xForOffset(geometry: RowGeometry, offset: number): number {
  const { offsets } = geometry
  const index = firstBoundaryAtOrAfterOffset(offsets, offset)
  if (offsets[index] === offset) return boundaryX(geometry, index)
  if (index === 0) return boundaryX(geometry, 0)
  if (index === offsets.length) return boundaryX(geometry, index - 1)
  if (offset - offsets[index - 1]! <= offsets[index]! - offset)
    return boundaryX(geometry, index - 1)
  return boundaryX(geometry, index)
}

function firstBoundaryAtOrAfterOffset(offsets: Float64Array, offset: number): number {
  let low = 0
  let high = offsets.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (offsets[middle]! >= offset) {
      high = middle
      continue
    }

    low = middle + 1
  }

  return low
}

function offsetForX(lazy: RowGeometry, x: number): number {
  const geometry = resolveRowGeometry(lazy)
  const { offsets, xs, xOrder } = geometry
  const first = boundaryAtXRank(xOrder, 0)
  const last = boundaryAtXRank(xOrder, offsets.length - 1)
  if (x <= xs[first]!) return offsets[first]!
  if (x >= xs[last]!) return offsets[last]!

  const rank = firstBoundaryAtOrAfterX(xs, xOrder, x)
  const previous = boundaryAtXRank(xOrder, rank - 1)
  const next = boundaryAtXRank(xOrder, rank)
  if (x - xs[previous]! <= xs[next]! - x) return offsets[previous]!
  return offsets[next]!
}

const boundaryAtXRank = (xOrder: Uint32Array | null, rank: number): number =>
  xOrder ? xOrder[Math.max(0, rank)]! : Math.max(0, rank)

function firstBoundaryAtOrAfterX(xs: Float64Array, xOrder: Uint32Array | null, x: number): number {
  let low = 0
  let high = xs.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (xs[boundaryAtXRank(xOrder, middle)]! >= x) {
      high = middle
      continue
    }

    low = middle + 1
  }

  return low
}

function measuredTextSegmentRect(
  measurement: RowMeasurementContext,
  node: Text,
  start: number,
  length: number,
): { readonly left: number; readonly width: number } | null {
  if (length <= 0) return null

  const scratch = measurementScratchFor(node.ownerDocument)
  scratch.range.setStart(node, start)
  scratch.range.setEnd(node, start + length)
  const measured = measuredRangeRect(measurement, scratch.range)
  scratch.range.selectNodeContents(scratch.parking)
  return measured
}

/**
 * One rect for the whole chunk, so a row's extent costs a read per chunk rather than one per
 * grapheme. The union rect is the one wanted here — a chunk spans several text nodes and its client
 * rects come back one per node.
 */
function measuredChunkRect(
  measurement: RowMeasurementContext,
  chunk: VirtualizedTextChunk,
): { readonly left: number; readonly width: number } | null {
  const first = chunk.parts[0]
  const last = chunk.parts.at(-1)
  const start = first ? boundaryBeforePart(first) : null
  const end = last ? boundaryAfterPart(last) : null
  if (!start || !end) return null

  const scratch = measurementScratchFor(chunk.textNode.ownerDocument)
  scratch.range.setStart(start.node, start.offset)
  scratch.range.setEnd(end.node, end.offset)
  const rect = scratch.range.getBoundingClientRect()
  scratch.range.selectNodeContents(scratch.parking)
  if (rect.width <= 0) return null

  return rowLocalRect(measurement, rect)
}

function measurementScratchFor(document: Document): MeasurementScratch {
  const current = measurementScratch
  if (current?.document === document) return current

  const scratch = {
    document,
    range: document.createRange(),
    parking: document.createTextNode(''),
  }
  measurementScratch = scratch
  return scratch
}

function measuredRangeRect(
  measurement: RowMeasurementContext,
  range: Range,
): { readonly left: number; readonly width: number } | null {
  const rect = firstRangeRect(range)
  if (!rect || rect.width <= 0) return null

  return rowLocalRect(measurement, rect)
}

function measuredElementRect(
  measurement: RowMeasurementContext,
  element: HTMLElement,
): { readonly left: number; readonly width: number } | null {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0) return null

  return rowLocalRect(measurement, rect)
}

function rowLocalRect(
  measurement: RowMeasurementContext,
  rect: DOMRect,
): { readonly left: number; readonly width: number } {
  const left = rect.left - measuredRowRect(measurement.row).left
  return { left: left / measurement.scale, width: rect.width / measurement.scale }
}

/**
 * Client rects arrive in the host's own space, so a row rendered under a CSS transform reports
 * advances the transform has already scaled — while the caret translations and selection rects they
 * feed are written back in the row's untransformed space. `offsetWidth` is the same box before the
 * transform, so the two together recover the factor and take measurements back to where they are
 * consumed.
 *
 * `offsetWidth` is rounded to whole pixels though, so a ratio small enough to be explained by that
 * rounding is noise, not a transform: dividing by it would bend every measured x on a host that has
 * no transform at all.
 */
function rowClientRectScale(row: MountedVirtualizedTextRow): number {
  const layoutWidth = row.element.offsetWidth
  if (layoutWidth <= 0) return 1

  const scale = measuredRowRect(row).width / layoutWidth
  if (!Number.isFinite(scale) || scale <= 0) return 1
  if (Math.abs(scale - 1) * layoutWidth <= 1) return 1
  return scale
}

/**
 * A measured row asks for its own rect once per grapheme and once per control
 * glyph, because that rect is the origin every part of the row is measured
 * against — the same layout read, repeated for the length of the row. Between
 * `beginRowRectMeasurements` and `endRowRectMeasurements` it is read once per
 * row instead, on the caller's promise that it reports anything moving a row —
 * a write to row DOM, a scroll — through `invalidateRowRectMeasurements`.
 * Outside that window nothing is remembered, so a caller that cannot make the
 * promise simply does not open one.
 */
export function beginRowRectMeasurements(): void {
  rowRectMeasurementDepth += 1
  measuredRowRects ??= new Map()
}

export function invalidateRowRectMeasurements(): void {
  measuredRowRects?.clear()
}

export function endRowRectMeasurements(): void {
  rowRectMeasurementDepth = Math.max(0, rowRectMeasurementDepth - 1)
  if (rowRectMeasurementDepth > 0) return

  measuredRowRects = null
}

function measuredRowRect(row: MountedVirtualizedTextRow): DOMRect {
  const cached = measuredRowRects?.get(row.element)
  if (cached) return cached

  const rect = row.element.getBoundingClientRect()
  measuredRowRects?.set(row.element, rect)
  return rect
}

function firstRangeRect(range: Range): DOMRect | null {
  const rects = range.getClientRects()
  const first = rects.item(0)
  if (first) return first

  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return rect
}

function estimatedPrefixWidth(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  localOffset: number,
): number {
  return estimatedLocalRangeWidth(view, row, 0, localOffset)
}

function estimatedLocalRangeWidth(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  localStart: number,
  localEnd: number,
): number {
  const start = estimatedDisplayCellForColumn(row.text, localStart, view.tabSize)
  const end = estimatedDisplayCellForColumn(row.text, localEnd, view.tabSize)
  return Math.max(0, end - start) * view.metrics.characterWidth
}

function isSimpleRowCodeUnit(code: number): boolean {
  if (code === 9) return true
  return code >= 32 && code <= 126
}

function appendTextPart(
  document: Document,
  parts: VirtualizedTextChunkPart[],
  nodes: Node[],
  localStart: number,
  text: string,
): void {
  if (text.length === 0) return

  const node = document.createTextNode(text)
  nodes.push(node)
  parts.push({
    kind: 'text',
    localStart,
    localEnd: localStart + text.length,
    node,
  })
}

function appendControlPart(
  document: Document,
  parts: VirtualizedTextChunkPart[],
  nodes: Node[],
  localStart: number,
  control: ControlCharacterInfo,
  cellWidth: number,
): void {
  const element = document.createElement('span')
  element.className = CONTROL_CHARACTER_CLASS
  element.dataset.editorControlCharacter = control.key
  element.style.width = `${control.widthCells * cellWidth}px`
  element.textContent = control.label
  nodes.push(element)
  parts.push({
    kind: 'control',
    localStart,
    localEnd: localStart + 1,
    element,
    widthCells: control.widthCells,
  })
}

function firstTextNode(parts: readonly VirtualizedTextChunkPart[]): Text | null {
  const part = parts.find((candidate) => candidate.kind === 'text')
  return part?.kind === 'text' ? part.node : null
}

function controlCharacterInfo(code: number): ControlCharacterInfo | null {
  if (code === 9) return null
  if (code >= 128 && code <= 159) return c1ControlCharacterInfo(code)
  return null
}

function oneCellControlCharacterLabel(code: number): string | null {
  // A tab is laid out, not labelled: `tab-size` under `white-space: pre` expands it to the column
  // the geometry counts it as, and a `␉` in its place would shrink an indent by a whole tab stop
  // per level the moment a replacement made the row take this path.
  if (code === 9) return null
  if (code >= 0 && code <= 31) return String.fromCodePoint(0x2400 + code)
  if (code === 127) return '\u2421'
  return null
}

function c1ControlCharacterInfo(code: number): ControlCharacterInfo {
  const label = `[U+${hexCode(code)}]`
  return {
    label,
    widthCells: label.length,
    key: `U+${hexCode(code)}`,
  }
}

function hexCode(code: number): string {
  return code.toString(16).toUpperCase().padStart(4, '0')
}

function estimatedDisplayCellsFrom(
  text: string,
  start: number,
  end: number,
  initialCells: number,
  tabSize: number,
): { readonly cells: number; readonly index: number } {
  let cells = initialCells
  let index = start
  while (index < end) {
    const step = estimatedStep(text, index, cells, tabSize)
    cells += step.cells
    index += step.length
  }

  return { cells, index }
}

function simpleDisplayCellsOrNull(
  text: string,
  start: number,
  end: number,
  initialCells: number,
  tabSize: number,
): number | null {
  let cells = initialCells
  for (let index = start; index < end; index += 1) {
    const code = text.charCodeAt(index)
    if (!isSimpleRowCodeUnit(code)) return null
    cells += code === 9 ? tabSize - (cells % tabSize) : 1
  }

  return cells
}

function estimatedStep(
  text: string,
  index: number,
  visualCell: number,
  tabSize: number,
): { readonly cells: number; readonly length: number } {
  const codePoint = text.codePointAt(index) ?? 0
  if (codePoint === 9) {
    return { cells: tabSize - (visualCell % tabSize), length: 1 }
  }

  const control = codePoint <= 0xffff ? controlCharacterInfo(codePoint) : null
  if (control) return { cells: control.widthCells, length: 1 }
  if (isCombiningMark(codePoint) || isVariationSelector(codePoint)) {
    return { cells: 0, length: codePointLength(text, index) }
  }

  return {
    cells: isWideCodePoint(codePoint) ? 2 : 1,
    length: codePointLength(text, index),
  }
}

function columnForVisualTarget(
  startIndex: number,
  endIndex: number,
  visual: number,
  next: number,
  target: number,
  bias: TransformBias,
): number | null {
  if (target < visual || target > next) return null
  if (target === visual) return startIndex
  if (target === next) return endIndex
  if (bias === 'before') return startIndex
  if (bias === 'after') return endIndex
  return target - visual <= next - target ? startIndex : endIndex
}

function isWideCodePoint(codePoint: number): boolean {
  if (codePoint >= 0x1100 && codePoint <= 0x115f) return true
  if (codePoint >= 0x2329 && codePoint <= 0x232a) return true
  if (codePoint >= 0x2e80 && codePoint <= 0xa4cf) return true
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return true
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return true
  if (codePoint >= 0xfe10 && codePoint <= 0xfe6f) return true
  if (codePoint >= 0xff00 && codePoint <= 0xff60) return true
  if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return true
  return codePoint >= 0x1f300 && codePoint <= 0x1faff
}

function chunkForLocalOffset(
  row: MountedVirtualizedTextRow,
  local: number,
): VirtualizedTextChunk | null {
  for (const chunk of row.chunks) {
    if (local < chunk.localStart || local > chunk.localEnd) continue
    return chunk
  }

  return null
}

function domBoundaryForChunkLocalOffset(
  chunk: VirtualizedTextChunk,
  local: number,
): DomBoundary | null {
  for (const part of chunk.parts) {
    const boundary = domBoundaryForPartLocalOffset(part, local)
    if (boundary) return boundary
  }

  return fallbackChunkDomBoundary(chunk, local)
}

function domBoundaryForPartLocalOffset(
  part: VirtualizedTextChunkPart,
  local: number,
): DomBoundary | null {
  if (local < part.localStart || local > part.localEnd) return null
  if (part.kind === 'text') return { node: part.node, offset: local - part.localStart }
  if (local <= part.localStart) return elementBoundary(part.element, 'before')
  return elementBoundary(part.element, 'after')
}

function fallbackChunkDomBoundary(chunk: VirtualizedTextChunk, local: number): DomBoundary | null {
  const first = chunk.parts[0]
  const last = chunk.parts.at(-1)
  if (local <= chunk.localStart && first) return boundaryBeforePart(first)
  if (last) return boundaryAfterPart(last)
  return { node: chunk.textNode, offset: 0 }
}

function boundaryBeforePart(part: VirtualizedTextChunkPart): DomBoundary | null {
  if (part.kind === 'text') return { node: part.node, offset: 0 }
  return elementBoundary(part.element, 'before')
}

function boundaryAfterPart(part: VirtualizedTextChunkPart): DomBoundary | null {
  if (part.kind === 'text') return { node: part.node, offset: part.node.length }
  return elementBoundary(part.element, 'after')
}

function elementBoundary(element: HTMLElement, side: 'before' | 'after'): DomBoundary | null {
  const parent = element.parentNode
  if (!parent) return null

  const offset = childNodeIndex(parent, element) + (side === 'after' ? 1 : 0)
  return { node: parent, offset }
}

function childNodeIndex(parent: Node, child: Node): number {
  return Array.prototype.indexOf.call(parent.childNodes, child) as number
}

function offsetFromTextPartBoundary(
  row: MountedVirtualizedTextRow,
  node: Node,
  offset: number,
): number | null {
  const part = textPartForNode(row, node)
  if (!part) return null

  const local = part.localStart + clamp(offset, 0, part.node.length)
  return rowOffsetForLocalIndex(row, local)
}

function offsetFromControlPartBoundary(
  row: MountedVirtualizedTextRow,
  node: Node,
  offset: number,
): number | null {
  const part = controlPartForNode(row, node)
  if (!part) return null
  if (node === part.element && offset <= 0) return rowOffsetForLocalIndex(row, part.localStart)

  const labelLength = part.element.textContent?.length ?? 0
  if (node !== part.element && offset <= 0) return rowOffsetForLocalIndex(row, part.localStart)
  if (node !== part.element && offset < labelLength / 2)
    return rowOffsetForLocalIndex(row, part.localStart)
  return rowOffsetForLocalIndex(row, part.localEnd)
}

function offsetFromElementBoundary(
  row: MountedVirtualizedTextRow,
  node: Node,
  offset: number,
): number | null {
  if (!(node instanceof HTMLElement)) return null
  if (!row.element.contains(node) && node !== row.element) return null
  if (node === row.element && offset <= 0) return row.startOffset
  if (node === row.element && offset >= node.childNodes.length) return row.endOffset

  const chunk = chunkForElement(row, node)
  if (chunk && offset <= 0) return chunk.startOffset
  if (chunk && offset >= node.childNodes.length) return chunk.endOffset

  const part = partAtElementChildBoundary(row, node, offset)
  if (!part) return row.endOffset
  return rowOffsetForLocalIndex(row, part.localStart)
}

function chunkForElement(
  row: MountedVirtualizedTextRow,
  element: HTMLElement,
): VirtualizedTextChunk | null {
  for (const chunk of row.chunks) {
    if (chunk.element === element) return chunk
  }

  return null
}

function textPartForNode(
  row: MountedVirtualizedTextRow,
  node: Node,
): VirtualizedTextChunkTextPart | null {
  for (const chunk of row.chunks) {
    const part = chunk.parts.find(
      (candidate) => candidate.kind === 'text' && candidate.node === node,
    )
    if (part?.kind === 'text') return part
  }

  return null
}

function controlPartForNode(
  row: MountedVirtualizedTextRow,
  node: Node,
): Extract<VirtualizedTextChunkPart, { readonly kind: 'control' }> | null {
  for (const chunk of row.chunks) {
    const part = chunk.parts.find((candidate) => {
      if (candidate.kind !== 'control') return false
      return candidate.element === node || candidate.element.contains(node)
    })
    if (part?.kind === 'control') return part
  }

  return null
}

function partAtElementChildBoundary(
  row: MountedVirtualizedTextRow,
  element: HTMLElement,
  offset: number,
): VirtualizedTextChunkPart | null {
  if (offset >= element.childNodes.length) return null

  for (let index = Math.max(0, offset); index < element.childNodes.length; index += 1) {
    const child = element.childNodes.item(index)
    const part = child ? partForNode(row, child) : null
    if (part) return part
  }

  return null
}

function partForNode(row: MountedVirtualizedTextRow, node: Node): VirtualizedTextChunkPart | null {
  for (const chunk of row.chunks) {
    const part = chunk.parts.find((candidate) => partContainsNode(candidate, node))
    if (part) return part
  }

  return null
}

function partContainsNode(part: VirtualizedTextChunkPart, node: Node): boolean {
  if (part.kind === 'text') return part.node === node
  return part.element === node || part.element.contains(node)
}
