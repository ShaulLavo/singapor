export type FixedRowVisibleRange = {
  readonly start: number;
  readonly end: number;
};

export type FixedRowVirtualItem = {
  readonly index: number;
  readonly start: number;
  readonly size: number;
};

export type FixedRowVirtualizerSnapshot = {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly totalSize: number;
  readonly visibleRange: FixedRowVisibleRange;
  readonly virtualItems: readonly FixedRowVirtualItem[];
};

export type FixedRowVirtualizerOptions = {
  readonly count: number;
  readonly rowHeight: number;
  readonly rowSizes?: readonly number[];
  readonly overscan?: number;
  readonly enabled?: boolean;
};

export type FixedRowScrollMetrics = {
  readonly scrollTop: number;
  readonly viewportHeight: number;
};

export type FixedRowVirtualizerChangeHandler = (snapshot: FixedRowVirtualizerSnapshot) => void;

type AttachedScrollElement = {
  readonly element: HTMLElement;
  readonly onScroll: () => void;
  readonly resizeObserver: ResizeObserver | null;
};

const DEFAULT_ROW_HEIGHT = 1;

export function computeFixedRowTotalSize(count: number, rowHeight: number): number {
  return normalizeCount(count) * normalizeRowHeight(rowHeight);
}

export function computeFixedRowVisibleRange(options: {
  readonly count: number;
  readonly rowHeight: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly enabled?: boolean;
}): FixedRowVisibleRange {
  const count = normalizeCount(options.count);
  if (options.enabled === false || count === 0) return { start: 0, end: 0 };

  const rowHeight = normalizeRowHeight(options.rowHeight);
  const scrollTop = Math.max(0, normalizeNumber(options.scrollTop));
  const viewportHeight = Math.max(0, normalizeNumber(options.viewportHeight));
  const start = clamp(Math.floor(scrollTop / rowHeight), 0, count - 1);
  const rawEnd = Math.ceil((scrollTop + viewportHeight) / rowHeight);
  const end = clamp(Math.max(start + 1, rawEnd), start + 1, count);
  return { start, end };
}

export function computeFixedRowVirtualItems(options: {
  readonly count: number;
  readonly rowHeight: number;
  readonly range: FixedRowVisibleRange;
  readonly overscan?: number;
  readonly enabled?: boolean;
}): FixedRowVirtualItem[] {
  const count = normalizeCount(options.count);
  if (options.enabled === false || count === 0) return [];

  const rowHeight = normalizeRowHeight(options.rowHeight);
  const window = computeOverscannedRange(count, options.range, options.overscan);
  const items: FixedRowVirtualItem[] = [];

  for (let index = window.start; index < window.end; index += 1) {
    items.push(createVirtualItem(index, rowHeight));
  }

  return items;
}

export class FixedRowVirtualizer {
  private options: NormalizedFixedRowVirtualizerOptions;
  private scrollTop = 0;
  private viewportHeight = 0;
  private attached: AttachedScrollElement | null = null;
  private changeHandler: FixedRowVirtualizerChangeHandler | null = null;
  private scrollAnimationFrame = 0;
  private itemCache = new Map<number, FixedRowVirtualItem>();
  private cachedRowHeight = DEFAULT_ROW_HEIGHT;

  public constructor(options: FixedRowVirtualizerOptions) {
    this.options = normalizeOptions(options);
    this.cachedRowHeight = this.options.rowHeight;
  }

  public updateOptions(options: Partial<FixedRowVirtualizerOptions>): void {
    const next = normalizeOptions({ ...denormalizeOptions(this.options), ...options });
    this.updateCacheForRowHeight(next.rowHeight);
    this.options = next;
    this.emitChange();
  }

  public attachScrollElement(
    element: HTMLElement,
    onChange?: FixedRowVirtualizerChangeHandler,
  ): void {
    this.detachScrollElement();
    this.changeHandler = onChange ?? null;

    const onScroll = (): void => this.scheduleScrollSync();
    const resizeObserver = createResizeObserver(() => this.syncFromScrollElement());
    this.attached = { element, onScroll, resizeObserver };

    element.addEventListener("scroll", onScroll, { passive: true });
    resizeObserver?.observe(element);
    this.syncFromScrollElement();
  }

  public detachScrollElement(): void {
    const attached = this.attached;
    if (!attached) return;

    attached.element.removeEventListener("scroll", attached.onScroll);
    attached.resizeObserver?.disconnect();
    this.cancelScheduledScrollSync();
    this.attached = null;
  }

  public dispose(): void {
    this.detachScrollElement();
    this.changeHandler = null;
    this.itemCache.clear();
  }

  public setScrollMetrics(metrics: FixedRowScrollMetrics): void {
    this.scrollTop = Math.max(0, normalizeNumber(metrics.scrollTop));
    this.viewportHeight = Math.max(0, normalizeNumber(metrics.viewportHeight));
    this.emitChange();
  }

  public getSnapshot(): FixedRowVirtualizerSnapshot {
    const visibleRange = this.getVisibleRange();
    return {
      scrollTop: this.scrollTop,
      viewportHeight: this.viewportHeight,
      totalSize: computeTotalSize(this.options),
      visibleRange,
      virtualItems: this.getVirtualItems(visibleRange),
    };
  }

  private getVisibleRange(): FixedRowVisibleRange {
    if (this.options.rowSizes) {
      return computeVariableRowVisibleRange({
        rowSizes: this.options.rowSizes,
        scrollTop: this.scrollTop,
        viewportHeight: this.viewportHeight,
        enabled: this.options.enabled,
      });
    }

    return computeFixedRowVisibleRange({
      count: this.options.count,
      rowHeight: this.options.rowHeight,
      scrollTop: this.scrollTop,
      viewportHeight: this.viewportHeight,
      enabled: this.options.enabled,
    });
  }

  private getVirtualItems(range: FixedRowVisibleRange): readonly FixedRowVirtualItem[] {
    const count = this.options.count;
    if (!this.options.enabled || count === 0) {
      this.itemCache.clear();
      return [];
    }

    const window = computeOverscannedRange(count, range, this.options.overscan);
    if (this.options.rowSizes) return collectVariableVirtualItems(this.options.rowSizes, window);

    this.pruneItemCache(window);
    return this.collectVirtualItems(window);
  }

  private collectVirtualItems(range: FixedRowVisibleRange): FixedRowVirtualItem[] {
    const items: FixedRowVirtualItem[] = [];
    for (let index = range.start; index < range.end; index += 1) {
      items.push(this.getCachedVirtualItem(index));
    }

    return items;
  }

  private getCachedVirtualItem(index: number): FixedRowVirtualItem {
    const existing = this.itemCache.get(index);
    if (existing) return existing;

    const item = createVirtualItem(index, this.options.rowHeight);
    this.itemCache.set(index, item);
    return item;
  }

  private pruneItemCache(range: FixedRowVisibleRange): void {
    for (const index of this.itemCache.keys()) {
      if (index >= range.start && index < range.end) continue;
      this.itemCache.delete(index);
    }
  }

  private updateCacheForRowHeight(rowHeight: number): void {
    if (rowHeight === this.cachedRowHeight) return;

    this.cachedRowHeight = rowHeight;
    this.itemCache.clear();
  }

  private syncFromScrollElement(): void {
    const element = this.attached?.element;
    if (!element) return;

    this.setScrollMetrics({
      scrollTop: element.scrollTop,
      viewportHeight: element.clientHeight,
    });
  }

  private scheduleScrollSync(): void {
    if (this.scrollAnimationFrame !== 0) return;

    this.scrollAnimationFrame = requestFrame(() => {
      this.scrollAnimationFrame = 0;
      this.syncFromScrollElement();
    });
  }

  private cancelScheduledScrollSync(): void {
    if (this.scrollAnimationFrame === 0) return;

    cancelFrame(this.scrollAnimationFrame);
    this.scrollAnimationFrame = 0;
  }

  private emitChange(): void {
    this.changeHandler?.(this.getSnapshot());
  }
}

function computeOverscannedRange(
  count: number,
  range: FixedRowVisibleRange,
  overscan: number | undefined,
): FixedRowVisibleRange {
  const normalizedOverscan = normalizeOverscan(overscan);
  return {
    start: clamp(range.start - normalizedOverscan, 0, count),
    end: clamp(range.end + normalizedOverscan, 0, count),
  };
}

function createVirtualItem(index: number, rowHeight: number): FixedRowVirtualItem {
  return {
    index,
    start: index * rowHeight,
    size: rowHeight,
  };
}

type NormalizedFixedRowVirtualizerOptions = Required<
  Omit<FixedRowVirtualizerOptions, "rowSizes">
> & {
  readonly rowSizes: readonly number[] | null;
};

function normalizeOptions(
  options: FixedRowVirtualizerOptions,
): NormalizedFixedRowVirtualizerOptions {
  const count = normalizeCount(options.count);
  return {
    count,
    rowHeight: normalizeRowHeight(options.rowHeight),
    rowSizes: normalizeRowSizes(options.rowSizes, count),
    overscan: normalizeOverscan(options.overscan),
    enabled: options.enabled ?? true,
  };
}

function denormalizeOptions(
  options: NormalizedFixedRowVirtualizerOptions,
): FixedRowVirtualizerOptions {
  return {
    ...options,
    rowSizes: options.rowSizes ?? undefined,
  };
}

function computeTotalSize(options: NormalizedFixedRowVirtualizerOptions): number {
  if (options.rowSizes) return sumRows(options.rowSizes, 0, options.rowSizes.length);
  return computeFixedRowTotalSize(options.count, options.rowHeight);
}

function computeVariableRowVisibleRange(options: {
  readonly rowSizes: readonly number[];
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly enabled?: boolean;
}): FixedRowVisibleRange {
  const count = options.rowSizes.length;
  if (options.enabled === false || count === 0) return { start: 0, end: 0 };

  const scrollTop = Math.max(0, normalizeNumber(options.scrollTop));
  const viewportHeight = Math.max(0, normalizeNumber(options.viewportHeight));
  const start = rowIndexAtOffset(options.rowSizes, scrollTop);
  const end = clamp(
    rowIndexAfterOffset(options.rowSizes, scrollTop + viewportHeight),
    start + 1,
    count,
  );
  return { start, end };
}

function collectVariableVirtualItems(
  rowSizes: readonly number[],
  range: FixedRowVisibleRange,
): FixedRowVirtualItem[] {
  const items: FixedRowVirtualItem[] = [];
  let start = sumRows(rowSizes, 0, range.start);

  for (let index = range.start; index < range.end; index += 1) {
    const size = rowSizes[index] ?? DEFAULT_ROW_HEIGHT;
    items.push({ index, start, size });
    start += size;
  }

  return items;
}

function rowIndexAtOffset(rowSizes: readonly number[], offset: number): number {
  let top = 0;
  for (let index = 0; index < rowSizes.length; index += 1) {
    const bottom = top + rowSizes[index]!;
    if (offset < bottom) return index;
    top = bottom;
  }

  return Math.max(0, rowSizes.length - 1);
}

function rowIndexAfterOffset(rowSizes: readonly number[], offset: number): number {
  let top = 0;
  for (let index = 0; index < rowSizes.length; index += 1) {
    top += rowSizes[index]!;
    if (offset <= top) return index + 1;
  }

  return rowSizes.length;
}

function sumRows(rowSizes: readonly number[], start: number, end: number): number {
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += rowSizes[index] ?? 0;
  return sum;
}

function normalizeRowSizes(
  rowSizes: readonly number[] | undefined,
  count: number,
): readonly number[] | null {
  if (!rowSizes || rowSizes.length !== count) return null;
  return rowSizes.map(normalizeRowHeight);
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeRowHeight(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ROW_HEIGHT;
  return value;
}

function normalizeOverscan(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createResizeObserver(callback: () => void): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") return null;
  return new ResizeObserver(callback);
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(() => callback(nowMs()), 0) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
    return;
  }

  clearTimeout(handle);
}

function nowMs(): DOMHighResTimeStamp {
  return globalThis.performance?.now() ?? Date.now();
}
