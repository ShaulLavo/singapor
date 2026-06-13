import {
  bufferColumnToVisualColumn,
  visualColumnToBufferColumn,
  type TransformBias,
} from '../displayTransforms'
import { clamp } from '../style-utils'
import type {
  MountedVirtualizedTextRow,
  VirtualizedTextChunk,
  VirtualizedTextChunkPart,
  VirtualizedTextChunkTextPart,
} from './virtualizedTextViewTypes'
import type { VirtualizedTextViewInternal } from './virtualizedTextViewInternals'
import { rowTextInsetLeft, rowTextInsetRight } from './virtualizedTextViewBlockLanes'

const CONTROL_CHARACTER_CLASS = 'editor-virtualized-control-character'

type GeometryBoundary = {
  readonly offset: number
  readonly x: number
}

type RowGeometry = {
  readonly boundaries: readonly GeometryBoundary[]
  readonly hitBoundaries: readonly GeometryBoundary[]
  readonly width: number
}

type RowGeometryCache = {
  readonly key: string
  readonly geometry: RowGeometry
}

type MutableRowGeometryCache = MountedVirtualizedTextRow & {
  geometryCache: RowGeometryCache | null
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

type RenderedChunkParts = {
  readonly nodes: readonly Node[]
  readonly parts: readonly VirtualizedTextChunkPart[]
  readonly textNode: Text
}

type TextSegment = {
  readonly index: number
  readonly segment: string
}

type ControlCharacterInfo = {
  readonly label: string
  readonly widthCells: number
  readonly key: string
}

type GraphemeSegmenter = {
  segment(input: string): Iterable<TextSegment>
}

type IntlWithSegmenter = typeof Intl & {
  Segmenter?: new (
    locale?: string,
    options?: { readonly granularity?: 'grapheme' },
  ) => GraphemeSegmenter
}

const graphemeSegmenter = createGraphemeSegmenter()

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
): RenderedChunkParts {
  const parts: VirtualizedTextChunkPart[] = []
  const nodes: Node[] = []
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
  return {
    nodes,
    parts,
    textNode: firstTextNode(parts) ?? document.createTextNode(''),
  }
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
  return xForOffset(geometry.boundaries, clamped)
}

export function xToOffset(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  x: number,
): number {
  if (isSimpleRowText(row.text)) return calculatedXToOffset(view, row, x)

  const geometry = ensureRowGeometry(view, row)
  const boundary = nearestBoundaryForX(geometry.hitBoundaries, Math.max(0, x))
  return boundary?.offset ?? row.startOffset
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
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): Range | null {
  const boundaries = domBoundariesForChunkRange(chunk, start, end)
  if (!boundaries) return null

  const range = document.createRange()
  range.setStart(boundaries.start.node, boundaries.start.offset)
  range.setEnd(boundaries.end.node, boundaries.end.offset)
  return range
}

export function createStaticRangeForChunkRange(
  document: Document,
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): StaticRange | null {
  const boundaries = domBoundariesForChunkRange(chunk, start, end)
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
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): { readonly start: DomBoundary; readonly end: DomBoundary } | null {
  if (end <= start) return null
  if (end <= chunk.startOffset || start >= chunk.endOffset) return null

  const localStart = chunk.localStart + clamp(start - chunk.startOffset, 0, chunk.text.length)
  const localEnd = chunk.localStart + clamp(end - chunk.startOffset, 0, chunk.text.length)
  const startBoundary = domBoundaryForChunkLocalOffset(chunk, localStart)
  const endBoundary = domBoundaryForChunkLocalOffset(chunk, localEnd)
  if (!startBoundary || !endBoundary) return null

  return { end: endBoundary, start: startBoundary }
}

export function domBoundaryForOffset(
  row: MountedVirtualizedTextRow,
  offset: number,
): DomBoundary | null {
  const local = clamp(offset - row.startOffset, 0, row.text.length)
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

  return offsetFromElementBoundary(row, node, offset)
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
    row.text.length,
    row.displayKind,
    row.foldMarkerKey,
    row.rowDecorationKey,
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
  if (isSimpleRowText(row.text)) return buildCalculatedRowGeometry(view, row)
  return buildMeasuredRowGeometry(view, row)
}

function buildCalculatedRowGeometry(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): RowGeometry {
  const boundaries: GeometryBoundary[] = []
  const cellWidth = view.metrics.characterWidth
  for (const chunk of row.chunks) appendCalculatedChunkBoundaries(boundaries, view, row, chunk)

  const width =
    rowTextInsetLeft(row) +
    bufferColumnToVisualColumn(row.text, row.text.length, view.tabSize) * cellWidth +
    rowTextInsetRight(row)
  return geometryFromBoundaries(row, boundaries, width)
}

function calculatedXToOffset(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  x: number,
): number {
  const localX = Math.max(0, x - rowTextInsetLeft(row))
  const visualColumn = Math.floor(localX / Math.max(1, view.metrics.characterWidth))
  const local = visualColumnToBufferColumn(row.text, visualColumn, 'nearest', view.tabSize)
  return row.startOffset + clampLocalOffsetToMountedChunks(row, local)
}

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
  boundaries: GeometryBoundary[],
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
): void {
  const cellWidth = view.metrics.characterWidth
  for (let local = chunk.localStart; local <= chunk.localEnd; local += 1) {
    const column = bufferColumnToVisualColumn(row.text, local, view.tabSize)
    appendBoundary(boundaries, row.startOffset + local, rowTextInsetLeft(row) + column * cellWidth)
  }
}

function buildMeasuredRowGeometry(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): RowGeometry {
  const boundaries: GeometryBoundary[] = []
  for (const chunk of row.chunks) appendMeasuredChunkBoundaries(boundaries, view, row, chunk)

  const estimatedWidth =
    rowTextInsetLeft(row) +
    estimatedRowWidth(row.text, view.tabSize, view.metrics.characterWidth) +
    rowTextInsetRight(row)
  return geometryFromBoundaries(row, boundaries, estimatedWidth)
}

function appendMeasuredChunkBoundaries(
  boundaries: GeometryBoundary[],
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
): void {
  let fallbackX = rowTextInsetLeft(row) + estimatedPrefixWidth(view, row, chunk.localStart)
  appendBoundary(boundaries, row.startOffset + chunk.localStart, fallbackX)

  for (const part of chunk.parts) {
    fallbackX = appendMeasuredPartBoundaries(boundaries, view, row, part, fallbackX)
  }

  appendBoundary(boundaries, row.startOffset + chunk.localEnd, fallbackX)
}

function appendMeasuredPartBoundaries(
  boundaries: GeometryBoundary[],
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  part: VirtualizedTextChunkPart,
  fallbackX: number,
): number {
  if (part.kind === 'control')
    return appendControlBoundaries(boundaries, view, row, part, fallbackX)
  return appendTextBoundaries(boundaries, view, row, part, fallbackX)
}

function appendTextBoundaries(
  boundaries: GeometryBoundary[],
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  part: VirtualizedTextChunkTextPart,
  fallbackX: number,
): number {
  let currentX = fallbackX
  for (const segment of textPartSegments(part.node.data)) {
    currentX = appendTextSegmentBoundaries(boundaries, view, row, part, segment, currentX)
  }

  return currentX
}

function appendTextSegmentBoundaries(
  boundaries: GeometryBoundary[],
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  part: VirtualizedTextChunkTextPart,
  segment: TextSegment,
  fallbackX: number,
): number {
  const localStart = part.localStart + segment.index
  const localEnd = localStart + segment.segment.length
  const measured = measuredTextSegmentRect(row, part.node, segment.index, segment.segment.length)
  const width = measured?.width ?? estimatedLocalRangeWidth(view, row, localStart, localEnd)
  const left = measured?.left ?? fallbackX
  appendBoundary(boundaries, row.startOffset + localStart, left)
  appendBoundary(boundaries, row.startOffset + localEnd, left + width)
  return left + width
}

function appendControlBoundaries(
  boundaries: GeometryBoundary[],
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  part: Extract<VirtualizedTextChunkPart, { readonly kind: 'control' }>,
  fallbackX: number,
): number {
  const measured = measuredElementRect(row, part.element)
  const width = measured?.width ?? part.widthCells * view.metrics.characterWidth
  const left = measured?.left ?? fallbackX
  appendBoundary(boundaries, row.startOffset + part.localStart, left)
  appendBoundary(boundaries, row.startOffset + part.localEnd, left + width)
  return left + width
}

function geometryFromBoundaries(
  row: MountedVirtualizedTextRow,
  boundaries: GeometryBoundary[],
  fallbackWidth: number,
): RowGeometry {
  if (boundaries.length === 0) appendBoundary(boundaries, row.startOffset, 0)

  const width = Math.max(fallbackWidth, maxBoundaryX(boundaries))
  return {
    boundaries,
    hitBoundaries: boundaries.toSorted(compareBoundaryX),
    width,
  }
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

function xForOffset(boundaries: readonly GeometryBoundary[], offset: number): number {
  const exact = boundaryForOffset(boundaries, offset)
  if (exact) return exact.x

  const nextIndex = firstBoundaryAfterOffset(boundaries, offset)
  const previous = boundaries[Math.max(0, nextIndex - 1)]
  const next = boundaries[nextIndex]
  if (!previous) return next?.x ?? 0
  if (!next) return previous.x
  return nearestOffsetBoundary(previous, next, offset).x
}

function boundaryForOffset(
  boundaries: readonly GeometryBoundary[],
  offset: number,
): GeometryBoundary | null {
  const index = firstBoundaryAtOrAfterOffset(boundaries, offset)
  const boundary = boundaries[index]
  if (boundary?.offset !== offset) return null
  return boundary
}

function firstBoundaryAtOrAfterOffset(
  boundaries: readonly GeometryBoundary[],
  offset: number,
): number {
  let low = 0
  let high = boundaries.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (boundaries[middle]!.offset >= offset) {
      high = middle
      continue
    }

    low = middle + 1
  }

  return low
}

function firstBoundaryAfterOffset(boundaries: readonly GeometryBoundary[], offset: number): number {
  let low = 0
  let high = boundaries.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (boundaries[middle]!.offset > offset) {
      high = middle
      continue
    }

    low = middle + 1
  }

  return low
}

function nearestBoundaryForX(
  boundaries: readonly GeometryBoundary[],
  x: number,
): GeometryBoundary | null {
  const first = boundaries[0]
  const last = boundaries.at(-1)
  if (!first || !last) return null
  if (x <= first.x) return first
  if (x >= last.x) return last

  const nextIndex = firstBoundaryAtOrAfterX(boundaries, x)
  const previous = boundaries[Math.max(0, nextIndex - 1)]!
  const next = boundaries[nextIndex]!
  return nearestXBoundary(previous, next, x)
}

function firstBoundaryAtOrAfterX(boundaries: readonly GeometryBoundary[], x: number): number {
  let low = 0
  let high = boundaries.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (boundaries[middle]!.x >= x) {
      high = middle
      continue
    }

    low = middle + 1
  }

  return low
}

function nearestOffsetBoundary(
  previous: GeometryBoundary,
  next: GeometryBoundary,
  offset: number,
): GeometryBoundary {
  if (offset - previous.offset <= next.offset - offset) return previous
  return next
}

function nearestXBoundary(
  previous: GeometryBoundary,
  next: GeometryBoundary,
  x: number,
): GeometryBoundary {
  if (x - previous.x <= next.x - x) return previous
  return next
}

function measuredTextSegmentRect(
  row: MountedVirtualizedTextRow,
  node: Text,
  start: number,
  length: number,
): { readonly left: number; readonly width: number } | null {
  if (length <= 0) return null

  const range = node.ownerDocument.createRange()
  range.setStart(node, start)
  range.setEnd(node, start + length)
  return measuredRangeRect(row, range)
}

function measuredRangeRect(
  row: MountedVirtualizedTextRow,
  range: Range,
): { readonly left: number; readonly width: number } | null {
  const rect = firstRangeRect(range)
  if (!rect || rect.width <= 0) return null

  const rowRect = row.element.getBoundingClientRect()
  return { left: rect.left - rowRect.left, width: rect.width }
}

function measuredElementRect(
  row: MountedVirtualizedTextRow,
  element: HTMLElement,
): { readonly left: number; readonly width: number } | null {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0) return null

  const rowRect = row.element.getBoundingClientRect()
  return { left: rect.left - rowRect.left, width: rect.width }
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

function appendBoundary(boundaries: GeometryBoundary[], offset: number, x: number): void {
  const previous = boundaries.at(-1)
  if (previous?.offset !== offset) {
    boundaries.push({ offset, x })
    return
  }

  boundaries[boundaries.length - 1] = { offset, x }
}

function maxBoundaryX(boundaries: readonly GeometryBoundary[]): number {
  let width = 0
  for (const boundary of boundaries) width = Math.max(width, boundary.x)
  return width
}

function compareBoundaryX(left: GeometryBoundary, right: GeometryBoundary): number {
  return left.x - right.x || left.offset - right.offset
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

function textPartSegments(text: string): readonly TextSegment[] {
  if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(text))
  return fallbackTextSegments(text)
}

function createGraphemeSegmenter(): GraphemeSegmenter | null {
  const Segmenter = (Intl as IntlWithSegmenter).Segmenter
  if (!Segmenter) return null
  return new Segmenter(undefined, { granularity: 'grapheme' })
}

function fallbackTextSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let index = 0
  while (index < text.length) {
    const start = index
    index += codePointLength(text, index)
    index = consumeCombiningSuffix(text, index)
    segments.push({ index: start, segment: text.slice(start, index) })
  }

  return segments
}

function consumeCombiningSuffix(text: string, index: number): number {
  let next = index
  while (next < text.length) {
    const codePoint = text.codePointAt(next) ?? 0
    if (!isCombiningMark(codePoint) && !isVariationSelector(codePoint)) break
    next += codePointLength(text, next)
  }

  return next
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

function codePointLength(text: string, index: number): number {
  const codePoint = text.codePointAt(index) ?? 0
  return codePoint > 0xffff ? 2 : 1
}

function isCombiningMark(codePoint: number): boolean {
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return true
  if (codePoint >= 0x1ab0 && codePoint <= 0x1aff) return true
  if (codePoint >= 0x1dc0 && codePoint <= 0x1dff) return true
  if (codePoint >= 0x20d0 && codePoint <= 0x20ff) return true
  return codePoint >= 0xfe20 && codePoint <= 0xfe2f
}

function isVariationSelector(codePoint: number): boolean {
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return true
  return codePoint >= 0xe0100 && codePoint <= 0xe01ef
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
  return row.startOffset + local
}

function offsetFromControlPartBoundary(
  row: MountedVirtualizedTextRow,
  node: Node,
  offset: number,
): number | null {
  const part = controlPartForNode(row, node)
  if (!part) return null
  if (node === part.element && offset <= 0) return row.startOffset + part.localStart

  const labelLength = part.element.textContent?.length ?? 0
  if (node !== part.element && offset <= 0) return row.startOffset + part.localStart
  if (node !== part.element && offset < labelLength / 2) return row.startOffset + part.localStart
  return row.startOffset + part.localEnd
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
  return row.startOffset + part.localStart
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
