import {
  createRowHeightIndex,
  rowHeightIndexRowAfterOffset,
  rowHeightIndexRowAtOffset,
  rowHeightIndexStart,
  type RowHeightIndex,
} from './rowHeightIndex'

export type FixedRowVisibleRange = {
  readonly start: number
  readonly end: number
}

export type FixedRowVirtualItem = {
  readonly index: number
  readonly start: number
  readonly size: number
}

export type FixedRowVirtualizerSnapshot = {
  readonly scrollTop: number
  readonly scrollLeft: number
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly borderBoxWidth: number
  readonly borderBoxHeight: number
  readonly totalSize: number
  readonly scrollHeight: number
  readonly nativeScrollHeight: number
  readonly nativeScrollTop: number
  readonly visibleRange: FixedRowVisibleRange
  readonly virtualItems: readonly FixedRowVirtualItem[]
}

export type FixedRowVirtualizerOptions = {
  readonly count: number
  readonly rowHeight: number
  readonly rowGap?: number
  readonly rowSizes?: readonly number[]
  readonly overscan?: number
  readonly enabled?: boolean
  readonly maxScrollHeight?: number
  readonly scrollMode?: FixedRowScrollMode
}

export type FixedRowScrollMode = 'virtualized' | 'static'

export type FixedRowScrollMetrics = {
  readonly scrollTop: number
  readonly viewportHeight: number
  readonly borderBoxHeight?: number
  readonly borderBoxWidth?: number
  readonly scrollLeft?: number
  readonly viewportWidth?: number
}

export type FixedRowVirtualizerChangeHandler = (snapshot: FixedRowVirtualizerSnapshot) => void

export type FixedRowVirtualizerAttachOptions = {
  readonly readInitialScrollPosition?: boolean
}

type AttachedScrollElement = {
  readonly element: HTMLElement
  readonly onScroll: () => void
  readonly resizeObserver: ResizeObserver | null
  scrollListenerAttached: boolean
}

type PendingResizeMetrics = {
  readonly borderBoxHeight: number
  readonly borderBoxWidth: number
  readonly scrollLeft: number
  readonly viewportHeight: number
  readonly viewportWidth: number
}

const DEFAULT_ROW_HEIGHT = 1
const DEFAULT_ROW_GAP = 0
// Keep native spacer heights below browser element-size caps while preserving logical scroll size.
const DEFAULT_MAX_SCROLL_HEIGHT = 16_000_000

export function computeFixedRowTotalSize(
  count: number,
  rowHeight: number,
  rowGap?: number,
): number {
  const normalizedCount = normalizeCount(count)
  const normalizedRowHeight = normalizeRowHeight(rowHeight)
  const normalizedRowGap = normalizeRowGap(rowGap)
  return normalizedCount * normalizedRowHeight + totalRowGap(normalizedCount, normalizedRowGap)
}

export function computeFixedRowVisibleRange(options: {
  readonly count: number
  readonly rowHeight: number
  readonly rowGap?: number
  readonly scrollTop: number
  readonly viewportHeight: number
  readonly enabled?: boolean
}): FixedRowVisibleRange {
  const count = normalizeCount(options.count)
  if (options.enabled === false || count === 0) return { start: 0, end: 0 }

  const rowHeight = normalizeRowHeight(options.rowHeight)
  const rowGap = normalizeRowGap(options.rowGap)
  const scrollTop = Math.max(0, normalizeNumber(options.scrollTop))
  const viewportHeight = Math.max(0, normalizeNumber(options.viewportHeight))
  const start = fixedRowIndexAtOffset(count, rowHeight, rowGap, scrollTop)
  const rawEnd = fixedRowIndexAfterOffset(count, rowHeight, rowGap, scrollTop + viewportHeight)
  const end = clamp(Math.max(start + 1, rawEnd), start + 1, count)
  return { start, end }
}

export function computeFixedRowVirtualItems(options: {
  readonly count: number
  readonly rowHeight: number
  readonly rowGap?: number
  readonly range: FixedRowVisibleRange
  readonly overscan?: number
  readonly enabled?: boolean
}): FixedRowVirtualItem[] {
  const count = normalizeCount(options.count)
  if (options.enabled === false || count === 0) return []

  const rowHeight = normalizeRowHeight(options.rowHeight)
  const rowGap = normalizeRowGap(options.rowGap)
  const window = computeOverscannedRange(count, options.range, options.overscan)
  const items: FixedRowVirtualItem[] = []

  for (let index = window.start; index < window.end; index += 1) {
    items.push(createVirtualItem(index, rowHeight, rowGap))
  }

  return items
}

export class FixedRowVirtualizer {
  private options: NormalizedFixedRowVirtualizerOptions
  private scrollTop = 0
  private scrollLeft = 0
  private viewportWidth = 0
  private viewportHeight = 0
  private borderBoxWidth = 0
  private borderBoxHeight = 0
  private attached: AttachedScrollElement | null = null
  private changeHandler: FixedRowVirtualizerChangeHandler | null = null
  private scrollAnimationFrame = 0
  private resizeAnimationFrame = 0
  private pendingResizeMetrics: PendingResizeMetrics | null = null
  private itemCache = new Map<number, FixedRowVirtualItem>()
  private cachedRowHeight = DEFAULT_ROW_HEIGHT
  private cachedRowGap = DEFAULT_ROW_GAP
  private stableVirtualWindow: FixedRowVisibleRange | null = null
  private logicalScrollProperties: LogicalScrollProperties | null = null

  public constructor(options: FixedRowVirtualizerOptions) {
    this.options = normalizeOptions(options)
    this.cachedRowHeight = this.options.rowHeight
    this.cachedRowGap = this.options.rowGap
  }

  public updateOptions(options: Partial<FixedRowVirtualizerOptions>): boolean {
    const next = normalizeOptions({ ...denormalizeOptions(this.options), ...options })
    const nextScrollTop = nextScrollTopForOptions(next, this.scrollTop, this.viewportHeight)
    if (sameNormalizedOptions(this.options, next) && nextScrollTop === this.scrollTop) return false

    this.updateCacheForFixedRows(next.rowHeight, next.rowGap)
    this.options = next
    this.scrollTop = nextScrollTop
    this.stableVirtualWindow = null
    this.syncAttachedScrollMode()
    this.syncAttachedNativeScrollTop()
    this.emitChange()
    return true
  }

  public refresh(): void {
    this.emitChange()
  }

  public attachScrollElement(
    element: HTMLElement,
    onChange?: FixedRowVirtualizerChangeHandler,
    options: FixedRowVirtualizerAttachOptions = {},
  ): void {
    this.detachScrollElement()
    this.changeHandler = onChange ?? null

    const onScroll = (): void => this.scheduleScrollSync()
    const resizeObserver = createResizeObserver((entries) => this.syncFromResizeEntries(entries))
    this.attached = { element, onScroll, resizeObserver, scrollListenerAttached: false }
    this.syncAttachedScrollMode()
    resizeObserver?.observe(element)
    if (options.readInitialScrollPosition !== false && !this.isStaticMode()) {
      this.syncScrollPositionFromElement()
    }
  }

  public detachScrollElement(): void {
    const attached = this.attached
    if (!attached) return

    this.disableAttachedScrollElement(attached)
    attached.resizeObserver?.disconnect()
    this.clearPendingResizeSync()
    this.attached = null
  }

  public dispose(): void {
    this.detachScrollElement()
    this.changeHandler = null
    this.itemCache.clear()
  }

  public setScrollMetrics(metrics: FixedRowScrollMetrics): void {
    this.clearPendingResizeSync()
    this.applyScrollMetrics(metrics)
  }

  private applyScrollMetrics(metrics: FixedRowScrollMetrics): void {
    const nextViewportHeight = Math.max(0, normalizeNumber(metrics.viewportHeight))
    const nextScrollLeft = optionalNonNegative(metrics.scrollLeft, this.scrollLeft)
    const nextViewportWidth = optionalNonNegative(metrics.viewportWidth, this.viewportWidth)
    const nextBorderBoxWidth = optionalBorderBoxMetric(
      metrics.borderBoxWidth,
      this.borderBoxWidth,
      nextViewportWidth,
      metrics.viewportWidth,
    )
    const nextBorderBoxHeight = optionalBorderBoxMetric(
      metrics.borderBoxHeight,
      this.borderBoxHeight,
      nextViewportHeight,
      metrics.viewportHeight,
    )
    const nextScrollTop = this.normalizeScrollTopForMetrics(metrics.scrollTop, nextViewportHeight)
    const viewportHeightChanged = nextViewportHeight !== this.viewportHeight
    if (
      nextScrollTop === this.scrollTop &&
      nextScrollLeft === this.scrollLeft &&
      nextViewportWidth === this.viewportWidth &&
      nextViewportHeight === this.viewportHeight &&
      nextBorderBoxWidth === this.borderBoxWidth &&
      nextBorderBoxHeight === this.borderBoxHeight
    )
      return

    this.scrollTop = nextScrollTop
    this.scrollLeft = nextScrollLeft
    this.viewportWidth = nextViewportWidth
    this.viewportHeight = nextViewportHeight
    this.borderBoxWidth = nextBorderBoxWidth
    this.borderBoxHeight = nextBorderBoxHeight
    if (viewportHeightChanged) this.stableVirtualWindow = null
    this.syncAttachedNativeScrollTop()
    this.emitChange()
  }

  public getSnapshot(): FixedRowVirtualizerSnapshot {
    const visibleRange = this.getVisibleRange()
    const totalSize = computeTotalSize(this.options)
    const viewportHeight = this.snapshotViewportHeight(totalSize)
    const scrollTop = this.snapshotScrollTop()
    const geometry = this.scrollGeometry(viewportHeight, totalSize)
    return {
      scrollTop,
      scrollLeft: this.scrollLeft,
      viewportWidth: this.viewportWidth,
      viewportHeight,
      borderBoxWidth: this.borderBoxWidth,
      borderBoxHeight: this.borderBoxHeight,
      totalSize,
      scrollHeight: geometry.scrollHeight,
      nativeScrollHeight: geometry.nativeScrollHeight,
      nativeScrollTop: nativeScrollTopForLogical(scrollTop, geometry),
      visibleRange,
      virtualItems: this.getVirtualItems(visibleRange),
    }
  }

  private getVisibleRange(): FixedRowVisibleRange {
    if (this.isStaticMode()) return staticVisibleRange(this.options)

    if (this.options.rowHeightIndex) {
      return computeVariableRowVisibleRange({
        rowHeightIndex: this.options.rowHeightIndex,
        scrollTop: this.scrollTop,
        viewportHeight: this.viewportHeight,
        enabled: this.options.enabled,
      })
    }

    return computeFixedRowVisibleRange({
      count: this.options.count,
      rowHeight: this.options.rowHeight,
      rowGap: this.options.rowGap,
      scrollTop: this.scrollTop,
      viewportHeight: this.viewportHeight,
      enabled: this.options.enabled,
    })
  }

  private getVirtualItems(range: FixedRowVisibleRange): readonly FixedRowVirtualItem[] {
    const count = this.options.count
    if (!this.options.enabled || count === 0) {
      this.itemCache.clear()
      return []
    }

    const window = computeOverscannedRange(count, range, this.options.overscan)
    const stableWindow = this.stableWindowForRange(range, window, count)
    if (this.options.rowHeightIndex)
      return collectVariableVirtualItems(this.options.rowHeightIndex, stableWindow)

    this.pruneItemCache(stableWindow)
    return this.collectVirtualItems(stableWindow)
  }

  private stableWindowForRange(
    visibleRange: FixedRowVisibleRange,
    desiredWindow: FixedRowVisibleRange,
    count: number,
  ): FixedRowVisibleRange {
    const currentWindow = this.stableVirtualWindow
    const deadband = stableWindowDeadband(this.options.overscan)
    if (!currentWindow || deadband === 0) {
      this.stableVirtualWindow = desiredWindow
      return desiredWindow
    }

    if (stableWindowContainsVisibleRange(currentWindow, visibleRange, deadband, count)) {
      return currentWindow
    }

    this.stableVirtualWindow = desiredWindow
    return desiredWindow
  }

  private collectVirtualItems(range: FixedRowVisibleRange): FixedRowVirtualItem[] {
    const items: FixedRowVirtualItem[] = []
    for (let index = range.start; index < range.end; index += 1) {
      items.push(this.getCachedVirtualItem(index))
    }

    return items
  }

  private getCachedVirtualItem(index: number): FixedRowVirtualItem {
    const existing = this.itemCache.get(index)
    if (existing) return existing

    const item = createVirtualItem(index, this.options.rowHeight, this.options.rowGap)
    this.itemCache.set(index, item)
    return item
  }

  private pruneItemCache(range: FixedRowVisibleRange): void {
    for (const index of this.itemCache.keys()) {
      if (index >= range.start && index < range.end) continue
      this.itemCache.delete(index)
    }
  }

  private updateCacheForFixedRows(rowHeight: number, rowGap: number): void {
    if (rowHeight === this.cachedRowHeight && rowGap === this.cachedRowGap) return

    this.cachedRowHeight = rowHeight
    this.cachedRowGap = rowGap
    this.itemCache.clear()
    this.stableVirtualWindow = null
  }

  private syncScrollPositionFromElement(): void {
    const element = this.attached?.element
    if (!element) return

    const resizeMetrics = this.takePendingResizeMetrics()
    const viewportHeight = resizeMetrics?.viewportHeight ?? this.viewportHeight
    this.applyScrollMetrics({
      scrollTop: this.logicalScrollTopFromNativeElement(viewportHeight),
      scrollLeft: element.scrollLeft,
      borderBoxHeight: resizeMetrics?.borderBoxHeight ?? this.borderBoxHeight,
      borderBoxWidth: resizeMetrics?.borderBoxWidth ?? this.borderBoxWidth,
      viewportHeight,
      viewportWidth: resizeMetrics?.viewportWidth ?? this.viewportWidth,
    })
  }

  private syncFromResizeEntries(entries: readonly ResizeObserverEntry[]): void {
    const element = this.attached?.element
    if (!element) return

    const entry = resizeEntryForElement(entries, element)
    if (!entry) return

    const size = resizeEntrySize(entry)
    this.pendingResizeMetrics = {
      scrollLeft: element.scrollLeft,
      borderBoxHeight: size.border.height,
      borderBoxWidth: size.border.width,
      viewportHeight: size.content.height,
      viewportWidth: size.content.width,
    }
    this.scheduleResizeSync()
  }

  private scheduleScrollSync(): void {
    if (this.pendingResizeMetrics) this.cancelScheduledResizeSync()
    if (this.scrollAnimationFrame !== 0) return

    this.scrollAnimationFrame = requestFrame(() => {
      this.scrollAnimationFrame = 0
      this.syncScrollPositionFromElement()
    })
  }

  private cancelScheduledScrollSync(): void {
    if (this.scrollAnimationFrame === 0) return

    cancelFrame(this.scrollAnimationFrame)
    this.scrollAnimationFrame = 0
  }

  private scheduleResizeSync(): void {
    if (this.scrollAnimationFrame !== 0) return
    if (this.resizeAnimationFrame !== 0) return

    this.resizeAnimationFrame = requestFrame(() => {
      this.resizeAnimationFrame = 0
      this.flushPendingResizeMetrics()
    })
  }

  private flushPendingResizeMetrics(): void {
    const resizeMetrics = this.takePendingResizeMetrics()
    if (!resizeMetrics) return

    this.applyScrollMetrics({
      scrollTop: this.scrollTop,
      scrollLeft: resizeMetrics.scrollLeft,
      borderBoxHeight: resizeMetrics.borderBoxHeight,
      borderBoxWidth: resizeMetrics.borderBoxWidth,
      viewportHeight: resizeMetrics.viewportHeight,
      viewportWidth: resizeMetrics.viewportWidth,
    })
  }

  private takePendingResizeMetrics(): PendingResizeMetrics | null {
    const resizeMetrics = this.pendingResizeMetrics
    if (!resizeMetrics) return null

    this.pendingResizeMetrics = null
    this.cancelScheduledResizeSync()
    return resizeMetrics
  }

  private clearPendingResizeSync(): void {
    this.pendingResizeMetrics = null
    this.cancelScheduledResizeSync()
  }

  private cancelScheduledResizeSync(): void {
    if (this.resizeAnimationFrame === 0) return

    cancelFrame(this.resizeAnimationFrame)
    this.resizeAnimationFrame = 0
  }

  private emitChange(): void {
    this.changeHandler?.(this.getSnapshot())
  }

  private scrollGeometry(
    viewportHeight = this.viewportHeight,
    totalSize?: number,
  ): FixedRowScrollGeometry {
    return scrollGeometryForOptions(this.options, viewportHeight, totalSize)
  }

  private logicalScrollTopFromNativeElement(viewportHeight = this.viewportHeight): number {
    if (this.isStaticMode()) return 0

    const nativeScrollTop =
      this.logicalScrollProperties?.readNativeScrollTop() ?? this.attached?.element.scrollTop ?? 0
    return logicalScrollTopForNative(nativeScrollTop, this.scrollGeometry(viewportHeight))
  }

  private setScrollTopFromElement(value: number): void {
    if (this.isStaticMode()) return

    const resizeMetrics = this.takePendingResizeMetrics()
    const viewportHeight = resizeMetrics?.viewportHeight ?? this.viewportHeight
    this.applyScrollMetrics({
      borderBoxHeight: resizeMetrics?.borderBoxHeight ?? this.borderBoxHeight,
      borderBoxWidth: resizeMetrics?.borderBoxWidth ?? this.borderBoxWidth,
      scrollLeft: this.scrollLeft,
      scrollTop: value,
      viewportHeight,
      viewportWidth: resizeMetrics?.viewportWidth ?? this.viewportWidth,
    })
  }

  private syncAttachedNativeScrollTop(): void {
    if (this.isStaticMode()) return

    const properties = this.logicalScrollProperties
    if (!properties) return

    properties.writeNativeScrollTop(
      nativeScrollTopForLogical(this.scrollTop, this.scrollGeometry()),
    )
  }

  private syncAttachedScrollMode(): void {
    const attached = this.attached
    if (!attached) return

    if (this.isStaticMode()) {
      this.disableAttachedScrollElement(attached)
      return
    }

    this.enableAttachedScrollElement(attached)
  }

  private enableAttachedScrollElement(attached: AttachedScrollElement): void {
    if (attached.scrollListenerAttached) return

    this.logicalScrollProperties = installLogicalScrollProperties(attached.element, {
      getScrollHeight: () => this.scrollGeometry().scrollHeight,
      getScrollTop: () => this.scrollTop,
      setScrollTop: (value) => this.setScrollTopFromElement(value),
    })
    attached.element.addEventListener('scroll', attached.onScroll, { passive: true })
    attached.scrollListenerAttached = true
  }

  private disableAttachedScrollElement(attached: AttachedScrollElement): void {
    if (attached.scrollListenerAttached) {
      attached.element.removeEventListener('scroll', attached.onScroll)
      attached.scrollListenerAttached = false
    }

    this.logicalScrollProperties?.restore()
    this.logicalScrollProperties = null
    this.cancelScheduledScrollSync()
  }

  private normalizeScrollTopForMetrics(scrollTop: number, viewportHeight: number): number {
    if (this.isStaticMode()) return 0

    return normalizeScrollTopForMetrics(scrollTop, this.scrollGeometry(viewportHeight))
  }

  private snapshotViewportHeight(totalSize: number): number {
    if (this.isStaticMode()) return totalSize

    return this.viewportHeight
  }

  private snapshotScrollTop(): number {
    if (this.isStaticMode()) return 0

    return this.scrollTop
  }

  private isStaticMode(): boolean {
    return this.options.scrollMode === 'static'
  }
}

function computeOverscannedRange(
  count: number,
  range: FixedRowVisibleRange,
  overscan: number | undefined,
): FixedRowVisibleRange {
  const normalizedOverscan = normalizeOverscan(overscan)
  return {
    start: clamp(range.start - normalizedOverscan, 0, count),
    end: clamp(range.end + normalizedOverscan, 0, count),
  }
}

function stableWindowDeadband(overscan: number): number {
  if (overscan < 2) return 0

  // TODO(editor-perf): Make WebKit faster without weakening syntax quality.
  // 2026-06-05 seeded platform scroll bench, 80 x 36px steps:
  // before stable windows, Chrome ran 80 token-highlight range updates
  // (21.3ms total range work, 13.67ms segment work). This capped deadband
  // measured 10 updates in Chrome (3.83ms range, 2.27ms segment, 0 long frames),
  // WebKit still averaged 36.64ms/frame with 11.5 long frames. Keep this gate:
  // `bun run --cwd apps/web bench:editor-scroll:gate`.
  return Math.min(2, Math.floor(overscan / 2))
}

function stableWindowContainsVisibleRange(
  window: FixedRowVisibleRange,
  visibleRange: FixedRowVisibleRange,
  deadband: number,
  count: number,
): boolean {
  const safeStart = window.start === 0 ? window.start : window.start + deadband
  const safeEnd = window.end === count ? window.end : window.end - deadband
  return visibleRange.start >= safeStart && visibleRange.end <= safeEnd
}

function createVirtualItem(index: number, rowHeight: number, rowGap: number): FixedRowVirtualItem {
  return {
    index,
    start: index * (rowHeight + rowGap),
    size: rowHeight,
  }
}

type NormalizedFixedRowVirtualizerOptions = Required<
  Omit<FixedRowVirtualizerOptions, 'rowSizes'>
> & {
  readonly rowSizes: readonly number[] | null
  readonly rowHeightIndex: RowHeightIndex | null
}

function normalizeOptions(
  options: FixedRowVirtualizerOptions,
): NormalizedFixedRowVirtualizerOptions {
  const count = normalizeCount(options.count)
  const rowGap = normalizeRowGap(options.rowGap)
  const rowSizes = normalizeRowSizes(options.rowSizes, count)
  return {
    count,
    rowHeight: normalizeRowHeight(options.rowHeight),
    rowGap,
    rowSizes,
    rowHeightIndex: rowSizes ? createRowHeightIndex(rowSizes, rowGap) : null,
    overscan: normalizeOverscan(options.overscan),
    enabled: options.enabled ?? true,
    maxScrollHeight: normalizeMaxScrollHeight(options.maxScrollHeight),
    scrollMode: normalizeScrollMode(options.scrollMode),
  }
}

function denormalizeOptions(
  options: NormalizedFixedRowVirtualizerOptions,
): FixedRowVirtualizerOptions {
  return {
    count: options.count,
    rowHeight: options.rowHeight,
    rowGap: options.rowGap,
    rowSizes: options.rowSizes ?? undefined,
    overscan: options.overscan,
    enabled: options.enabled,
    maxScrollHeight: options.maxScrollHeight,
    scrollMode: options.scrollMode,
  }
}

function sameNormalizedOptions(
  left: NormalizedFixedRowVirtualizerOptions,
  right: NormalizedFixedRowVirtualizerOptions,
): boolean {
  return (
    left.count === right.count &&
    left.rowHeight === right.rowHeight &&
    left.rowGap === right.rowGap &&
    left.overscan === right.overscan &&
    left.enabled === right.enabled &&
    left.maxScrollHeight === right.maxScrollHeight &&
    left.scrollMode === right.scrollMode &&
    sameRowSizes(left.rowSizes, right.rowSizes)
  )
}

function sameRowSizes(left: readonly number[] | null, right: readonly number[] | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false

  return left.every((size, index) => size === right[index])
}

function computeTotalSize(options: NormalizedFixedRowVirtualizerOptions): number {
  if (options.rowHeightIndex) return options.rowHeightIndex.totalSize

  return computeFixedRowTotalSize(options.count, options.rowHeight, options.rowGap)
}

type FixedRowScrollGeometry = {
  readonly scrollHeight: number
  readonly nativeScrollHeight: number
  readonly maxScrollTop: number
  readonly maxNativeScrollTop: number
}

function scrollGeometryForOptions(
  options: NormalizedFixedRowVirtualizerOptions,
  viewportHeight: number,
  totalSize = computeTotalSize(options),
): FixedRowScrollGeometry {
  if (options.scrollMode === 'static') return staticScrollGeometry(totalSize)

  const normalizedViewportHeight = Math.max(0, normalizeNumber(viewportHeight))
  const scrollHeight = totalSize + scrollPaddingEnd(options, normalizedViewportHeight)
  const nativeScrollHeight = nativeScrollHeightFor(
    scrollHeight,
    normalizedViewportHeight,
    options.maxScrollHeight,
  )

  return {
    scrollHeight,
    nativeScrollHeight,
    maxScrollTop: Math.max(0, scrollHeight - normalizedViewportHeight),
    maxNativeScrollTop: Math.max(0, nativeScrollHeight - normalizedViewportHeight),
  }
}

function staticScrollGeometry(totalSize: number): FixedRowScrollGeometry {
  return {
    scrollHeight: totalSize,
    nativeScrollHeight: totalSize,
    maxScrollTop: 0,
    maxNativeScrollTop: 0,
  }
}

function nextScrollTopForOptions(
  options: NormalizedFixedRowVirtualizerOptions,
  currentScrollTop: number,
  viewportHeight: number,
): number {
  if (options.scrollMode === 'static') return 0

  return clampScrollTopForGeometry(
    currentScrollTop,
    scrollGeometryForOptions(options, viewportHeight),
  )
}

function staticVisibleRange(options: NormalizedFixedRowVirtualizerOptions): FixedRowVisibleRange {
  const count = options.rowHeightIndex?.rowSizes.length ?? options.count
  if (!options.enabled || count === 0) return { start: 0, end: 0 }

  return { start: 0, end: count }
}

function scrollPaddingEnd(
  options: NormalizedFixedRowVirtualizerOptions,
  viewportHeight: number,
): number {
  if (options.count === 0) return 0

  return Math.max(0, viewportHeight - lastRowHeight(options))
}

function lastRowHeight(options: NormalizedFixedRowVirtualizerOptions): number {
  if (options.rowHeightIndex) {
    return options.rowHeightIndex.rowSizes.at(-1) ?? DEFAULT_ROW_HEIGHT
  }

  return options.rowHeight
}

function nativeScrollHeightFor(
  scrollHeight: number,
  viewportHeight: number,
  maxScrollHeight: number,
): number {
  if (scrollHeight <= maxScrollHeight) return scrollHeight

  return Math.max(viewportHeight, maxScrollHeight)
}

function nativeScrollTopForLogical(scrollTop: number, geometry: FixedRowScrollGeometry): number {
  const logical = clampScrollTopForGeometry(scrollTop, geometry)
  if (geometry.maxScrollTop <= geometry.maxNativeScrollTop) return logical
  if (geometry.maxScrollTop === 0 || geometry.maxNativeScrollTop === 0) return 0

  return (logical / geometry.maxScrollTop) * geometry.maxNativeScrollTop
}

function logicalScrollTopForNative(
  nativeScrollTop: number,
  geometry: FixedRowScrollGeometry,
): number {
  const native = clamp(nativeScrollTop, 0, geometry.maxNativeScrollTop)
  if (geometry.maxScrollTop <= geometry.maxNativeScrollTop) return native
  if (geometry.maxScrollTop === 0 || geometry.maxNativeScrollTop === 0) return 0

  return (native / geometry.maxNativeScrollTop) * geometry.maxScrollTop
}

function clampScrollTopForGeometry(scrollTop: number, geometry: FixedRowScrollGeometry): number {
  return clamp(scrollTop, 0, geometry.maxScrollTop)
}

function normalizeScrollTopForMetrics(scrollTop: number, geometry: FixedRowScrollGeometry): number {
  const normalized = Math.max(0, normalizeNumber(scrollTop))
  if (geometry.scrollHeight === geometry.maxScrollTop) return normalized
  return clampScrollTopForGeometry(normalized, geometry)
}

function computeVariableRowVisibleRange(options: {
  readonly rowHeightIndex: RowHeightIndex
  readonly scrollTop: number
  readonly viewportHeight: number
  readonly enabled?: boolean
}): FixedRowVisibleRange {
  const count = options.rowHeightIndex.rowSizes.length
  if (options.enabled === false || count === 0) return { start: 0, end: 0 }

  const scrollTop = Math.max(0, normalizeNumber(options.scrollTop))
  const viewportHeight = Math.max(0, normalizeNumber(options.viewportHeight))
  const start = rowHeightIndexRowAtOffset(options.rowHeightIndex, scrollTop)
  const end = clamp(
    rowHeightIndexRowAfterOffset(options.rowHeightIndex, scrollTop + viewportHeight),
    start + 1,
    count,
  )
  return { start, end }
}

function collectVariableVirtualItems(
  rowHeightIndex: RowHeightIndex,
  range: FixedRowVisibleRange,
): FixedRowVirtualItem[] {
  const items: FixedRowVirtualItem[] = []

  for (let index = range.start; index < range.end; index += 1) {
    items.push({
      index,
      start: rowHeightIndexStart(rowHeightIndex, index),
      size: rowHeightIndex.rowSizes[index] ?? DEFAULT_ROW_HEIGHT,
    })
  }

  return items
}

function fixedRowIndexAtOffset(
  count: number,
  rowHeight: number,
  rowGap: number,
  offset: number,
): number {
  const stride = rowHeight + rowGap
  const index = clamp(Math.floor(offset / stride), 0, count - 1)
  const rowBottom = index * stride + rowHeight
  if (offset < rowBottom) return index
  return Math.min(index + 1, count - 1)
}

function fixedRowIndexAfterOffset(
  count: number,
  rowHeight: number,
  rowGap: number,
  offset: number,
): number {
  const stride = rowHeight + rowGap
  const index = clamp(Math.floor(offset / stride), 0, count)
  const rowStart = index * stride
  if (offset <= rowStart) return index
  return Math.min(index + 1, count)
}

function totalRowGap(count: number, rowGap: number): number {
  return Math.max(0, count - 1) * rowGap
}

function normalizeRowSizes(
  rowSizes: readonly number[] | undefined,
  count: number,
): readonly number[] | null {
  if (!rowSizes || rowSizes.length !== count) return null
  return rowSizes.map(normalizeRowHeight)
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

function normalizeRowHeight(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ROW_HEIGHT
  return value
}

function normalizeRowGap(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value < 0) return DEFAULT_ROW_GAP
  return value
}

function normalizeOverscan(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return 0
  return Math.floor(value)
}

function normalizeMaxScrollHeight(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return DEFAULT_MAX_SCROLL_HEIGHT
  }

  return Math.floor(value)
}

function normalizeScrollMode(value: FixedRowScrollMode | undefined): FixedRowScrollMode {
  if (value === 'static') return 'static'

  return 'virtualized'
}

function normalizeNumber(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value
}

function optionalNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return Math.max(0, normalizeNumber(value))
}

function optionalBorderBoxMetric(
  value: number | undefined,
  current: number,
  viewportValue: number,
  rawViewportValue: number | undefined,
): number {
  if (value !== undefined) return Math.max(0, normalizeNumber(value))
  if (rawViewportValue !== undefined) return viewportValue
  return current
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function resizeEntryForElement(
  entries: readonly ResizeObserverEntry[],
  element: Element,
): ResizeObserverEntry | null {
  for (const entry of entries) {
    if (entry.target === element) return entry
  }

  return entries[0] ?? null
}

function resizeEntrySize(entry: ResizeObserverEntry): {
  readonly content: {
    readonly width: number
    readonly height: number
  }
  readonly border: {
    readonly width: number
    readonly height: number
  }
} {
  const content = resizeObserverBox(entry.contentBoxSize) ?? {
    width: entry.contentRect.width,
    height: entry.contentRect.height,
  }
  const border = resizeObserverBox(entry.borderBoxSize) ?? content
  return { content, border }
}

function resizeObserverBox(
  size: ResizeObserverEntry['contentBoxSize'],
): { readonly width: number; readonly height: number } | null {
  const box = Array.isArray(size) ? size[0] : size
  if (!box) return null
  return { width: box.inlineSize, height: box.blockSize }
}

function createResizeObserver(callback: ResizeObserverCallback): ResizeObserver | null {
  if (typeof ResizeObserver === 'undefined') return null
  return new ResizeObserver(callback)
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
  return setTimeout(() => callback(nowMs()), 0) as unknown as number
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle)
    return
  }

  clearTimeout(handle)
}

function nowMs(): DOMHighResTimeStamp {
  return globalThis.performance?.now() ?? Date.now()
}

type LogicalScrollProperties = {
  restore(): void
  readNativeScrollTop(): number
  writeNativeScrollTop(value: number): void
}

type LogicalScrollPropertyHandlers = {
  getScrollHeight(): number
  getScrollTop(): number
  setScrollTop(value: number): void
}

function installLogicalScrollProperties(
  element: HTMLElement,
  handlers: LogicalScrollPropertyHandlers,
): LogicalScrollProperties {
  const originalScrollTop = Object.getOwnPropertyDescriptor(element, 'scrollTop')
  const originalScrollHeight = Object.getOwnPropertyDescriptor(element, 'scrollHeight')
  const nativeScrollTop = createNativeScrollTopAccess(element)
  const scrollTopGet = (): number => handlers.getScrollTop()
  const scrollTopSet = (value: number): void => handlers.setScrollTop(value)
  const scrollHeightGet = (): number => handlers.getScrollHeight()

  tryDefineProperty(element, 'scrollTop', {
    configurable: true,
    get: scrollTopGet,
    set: scrollTopSet,
  })
  tryDefineProperty(element, 'scrollHeight', {
    configurable: true,
    get: scrollHeightGet,
  })

  return {
    readNativeScrollTop: nativeScrollTop.read,
    writeNativeScrollTop: nativeScrollTop.write,
    restore: () => {
      restoreInstalledProperty(element, 'scrollTop', originalScrollTop, scrollTopGet, scrollTopSet)
      restoreInstalledProperty(element, 'scrollHeight', originalScrollHeight, scrollHeightGet)
    },
  }
}

function createNativeScrollTopAccess(element: HTMLElement): {
  readonly read: () => number
  readonly write: (value: number) => void
} {
  const descriptor = findPropertyDescriptor(element, 'scrollTop')
  let lastKnownValue = 0

  return {
    read: () => {
      lastKnownValue = normalizeNativeScrollTop(
        readNativeScrollTop(element, descriptor, lastKnownValue),
      )
      return lastKnownValue
    },
    write: (value) => {
      const nextValue = normalizeNativeScrollTop(value)
      if (nextValue === lastKnownValue) return

      lastKnownValue = nextValue
      writeNativeScrollTop(element, descriptor, nextValue)
    },
  }
}

function normalizeNativeScrollTop(value: number): number {
  return Math.max(0, normalizeNumber(value))
}

function readNativeScrollTop(
  element: HTMLElement,
  descriptor: PropertyDescriptor | undefined,
  fallback: number,
): number {
  if (descriptor?.get) return descriptor.get.call(element) as number
  return fallback
}

function writeNativeScrollTop(
  element: HTMLElement,
  descriptor: PropertyDescriptor | undefined,
  value: number,
): void {
  if (descriptor?.set) {
    descriptor.set.call(element, value)
    return
  }
}

function findPropertyDescriptor(
  element: HTMLElement,
  property: 'scrollTop',
): PropertyDescriptor | undefined {
  let current: unknown = element
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property)
    if (descriptor) return descriptor
    current = Object.getPrototypeOf(current)
  }

  return undefined
}

function tryDefineProperty(
  element: HTMLElement,
  property: 'scrollTop' | 'scrollHeight',
  descriptor: PropertyDescriptor,
): void {
  try {
    Object.defineProperty(element, property, descriptor)
  } catch {
    return
  }
}

function restoreInstalledProperty(
  element: HTMLElement,
  property: 'scrollTop' | 'scrollHeight',
  original: PropertyDescriptor | undefined,
  installedGet: (() => number) | undefined,
  installedSet?: (value: number) => void,
): void {
  const current = Object.getOwnPropertyDescriptor(element, property)
  if (!current || current.get !== installedGet || current.set !== installedSet) return

  if (original) {
    Object.defineProperty(element, property, original)
    return
  }

  Reflect.deleteProperty(element, property)
}
