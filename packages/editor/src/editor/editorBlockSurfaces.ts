import type { BlockRow } from '../displayTransforms'
import type {
  EditorBlock,
  EditorBlockAnchor,
  EditorBlockHorizontalSurface,
  EditorBlockSize,
  EditorBlockSurfaceSlot,
  EditorBlockVerticalSurface,
} from '../editorBlocks'
import type { EditorDisposable } from '../plugins'

export type ResolvedEditorBlockSurface = {
  readonly rowId: string
  readonly block: EditorBlock
  readonly surface: EditorBlockHorizontalSurface
  readonly slot: 'top' | 'bottom'
  readonly anchorBufferRow: number
  readonly size: ResolvedEditorBlockSize
}

export type ResolvedEditorBlockLaneSurface = {
  readonly laneId: string
  readonly block: EditorBlock
  readonly surface: EditorBlockVerticalSurface
  readonly slot: 'left' | 'right'
  readonly startBufferRow: number
  readonly endBufferRow: number
  readonly size: ResolvedEditorBlockSize
}

export type ResolvedEditorBlockSize = {
  readonly px: number
  readonly measure: EditorBlockMeasurement | null
}

export type EditorBlockMeasurement = {
  readonly key: string
  readonly dimension: 'height' | 'width'
  readonly minPx: number | null
  readonly maxPx: number | null
}

export function editorBlockSurfaceRowId(
  revision: number,
  providerIndex: number,
  blockId: string,
  slot: EditorBlockSurfaceSlot,
): string {
  return `${revision}:${providerIndex}:${blockId}:${slot}`
}

export function editorBlockSurfaceLaneId(
  revision: number,
  providerIndex: number,
  blockId: string,
  slot: EditorBlockSurfaceSlot,
): string {
  return `${revision}:${providerIndex}:${blockId}:${slot}`
}

/**
 * Identifies a surface independently of the resolution that produced it, unlike
 * the row and lane ids. Anything that has to survive re-resolution — a cached
 * measurement, a hoisted DOM host — is keyed by this.
 */
export function editorBlockSurfaceKey(
  providerIndex: number,
  blockId: string,
  slot: EditorBlockSurfaceSlot,
): string {
  return `${providerIndex}:${blockId}:${slot}`
}

export function resolveEditorBlockSize(
  size: EditorBlockSize | undefined,
  measureKey: string,
  dimension: EditorBlockMeasurement['dimension'],
  measuredSizes: ReadonlyMap<string, number>,
): ResolvedEditorBlockSize | null {
  if (!size) return null

  const fixedPx = positiveSizePx(size.px)
  if (fixedPx !== null) return { px: fixedPx, measure: null }

  const minPx = positiveSizePx(size.minPx)
  const maxPx = positiveSizePx(size.maxPx)
  if (minPx === null && maxPx === null) return null
  if (minPx !== null && maxPx !== null && maxPx < minPx) return null

  const measure = { key: measureKey, dimension, minPx, maxPx }
  const measuredPx = measuredSizes.get(measureKey)
  return { px: initialMeasuredEditorBlockSize(measure, measuredPx), measure }
}

export function initialMeasuredEditorBlockSize(
  measurement: EditorBlockMeasurement,
  measuredPx: number | undefined,
): number {
  if (measuredPx !== undefined) return clampEditorBlockMeasuredSize(measuredPx, measurement)
  return measurement.minPx ?? measurement.maxPx ?? 1
}

export function clampEditorBlockMeasuredSize(
  value: number,
  measurement: EditorBlockMeasurement,
): number {
  if (!Number.isFinite(value) || value < 0) return initialMeasuredEditorBlockSize(measurement, 0)

  const min = measurement.minPx ?? 1
  const max = measurement.maxPx ?? Number.POSITIVE_INFINITY
  return Math.min(Math.max(value, min), max)
}

export function addEditorBlockMeasurementKey(
  keys: Set<string>,
  size: ResolvedEditorBlockSize,
): void {
  if (!size.measure) return

  keys.add(size.measure.key)
}

export function applyEditorBlockMeasurementBounds(
  container: HTMLElement,
  measurement: EditorBlockMeasurement,
): void {
  const min = measurement.minPx === null ? '' : `${measurement.minPx}px`
  const max = measurement.maxPx === null ? '' : `${measurement.maxPx}px`
  if (measurement.dimension === 'height') {
    container.style.minHeight = min
    container.style.maxHeight = max
    return
  }

  container.style.minWidth = min
  container.style.maxWidth = max
}

export function elementMeasuredEditorBlockSize(
  container: HTMLElement,
  dimension: EditorBlockMeasurement['dimension'],
): number {
  const rect = container.getBoundingClientRect()
  const rectSize = dimension === 'height' ? rect.height : rect.width
  if (rectSize > 0) return rectSize

  return dimension === 'height' ? container.scrollHeight : container.scrollWidth
}

export function resizeObserverMeasuredSize(
  entries: readonly ResizeObserverEntry[],
  container: HTMLElement,
  dimension: EditorBlockMeasurement['dimension'],
): number | null {
  const entry = resizeObserverEntryForElement(entries, container)
  if (!entry) return null

  const boxSize = resizeObserverBoxSize(entry.contentBoxSize)
  if (boxSize) return dimension === 'height' ? boxSize.height : boxSize.width

  return dimension === 'height' ? entry.contentRect.height : entry.contentRect.width
}

export function createEditorBlockResizeObserver(
  callback: ResizeObserverCallback,
): ResizeObserver | null {
  if (typeof ResizeObserver === 'undefined') return null

  return new ResizeObserver(callback)
}

export function disposableOnce(dispose: () => void): EditorDisposable {
  let disposed = false

  return {
    dispose: () => {
      if (disposed) return

      disposed = true
      dispose()
    },
  }
}

export function validEditorBlockId(id: string): boolean {
  return id.length > 0
}

export function editorBlockSurfaceAnchorRow(
  anchor: EditorBlockAnchor,
  slot: 'top' | 'bottom',
  lineCount: number,
): number | null {
  if (!validEditorBlockAnchor(anchor, lineCount)) return null
  if ('row' in anchor) return anchor.row
  if (slot === 'top') return anchor.startRow
  return anchor.endRow
}

export function editorBlockSurfaceAnchorRange(
  anchor: EditorBlockAnchor,
  lineCount: number,
): { readonly startRow: number; readonly endRow: number } | null {
  if (!validEditorBlockAnchor(anchor, lineCount)) return null
  if ('row' in anchor) return { startRow: anchor.row, endRow: anchor.row }
  return { startRow: anchor.startRow, endRow: anchor.endRow }
}

export function editorBlockSurfacePlacement(slot: 'top' | 'bottom'): BlockRow['placement'] {
  if (slot === 'top') return 'before'
  return 'after'
}

function positiveSizePx(value: number | undefined): number | null {
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}

function resizeObserverEntryForElement(
  entries: readonly ResizeObserverEntry[],
  container: HTMLElement,
): ResizeObserverEntry | null {
  for (const entry of entries) {
    if (entry.target === container) return entry
  }

  return entries[0] ?? null
}

function resizeObserverBoxSize(
  size: ResizeObserverEntry['contentBoxSize'],
): { readonly width: number; readonly height: number } | null {
  const box = Array.isArray(size) ? size[0] : size
  if (!box) return null

  return { width: box.inlineSize, height: box.blockSize }
}

function validEditorBlockAnchor(anchor: EditorBlockAnchor, lineCount: number): boolean {
  const maxRow = Math.max(0, lineCount - 1)
  if ('row' in anchor) return validEditorBlockRow(anchor.row, maxRow)
  if (!validEditorBlockRow(anchor.startRow, maxRow)) return false
  if (!validEditorBlockRow(anchor.endRow, maxRow)) return false
  return anchor.startRow <= anchor.endRow
}

function validEditorBlockRow(row: number, maxRow: number): boolean {
  if (!Number.isInteger(row)) return false
  if (row < 0) return false
  return row <= maxRow
}
