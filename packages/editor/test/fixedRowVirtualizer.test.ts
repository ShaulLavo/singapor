import { describe, expect, it, vi } from 'vitest'
import {
  computeFixedRowTotalSize,
  computeFixedRowVirtualItems,
  computeFixedRowVisibleRange,
  FixedRowVirtualizer,
} from '../src/virtualization/fixedRowVirtualizer'

describe('fixed row virtualizer', () => {
  it('computes total scroll height from count and row height', () => {
    expect(computeFixedRowTotalSize(100_000, 18)).toBe(1_800_000)
    expect(computeFixedRowTotalSize(-1, 18)).toBe(0)
    expect(computeFixedRowTotalSize(2, 0)).toBe(2)
  })

  it('computes an exclusive visible range from scroll metrics', () => {
    const range = computeFixedRowVisibleRange({
      count: 100,
      rowHeight: 20,
      scrollTop: 45,
      viewportHeight: 50,
    })

    expect(range).toEqual({ start: 2, end: 5 })
  })

  it('keeps one row visible when the viewport has zero height', () => {
    const range = computeFixedRowVisibleRange({
      count: 100,
      rowHeight: 20,
      scrollTop: 40,
      viewportHeight: 0,
    })

    expect(range).toEqual({ start: 2, end: 3 })
  })

  it('computes overscanned virtual items', () => {
    const items = computeFixedRowVirtualItems({
      count: 100,
      rowHeight: 20,
      range: { start: 10, end: 13 },
      overscan: 2,
    })

    expect(items).toEqual([
      { index: 8, start: 160, size: 20 },
      { index: 9, start: 180, size: 20 },
      { index: 10, start: 200, size: 20 },
      { index: 11, start: 220, size: 20 },
      { index: 12, start: 240, size: 20 },
      { index: 13, start: 260, size: 20 },
      { index: 14, start: 280, size: 20 },
    ])
  })

  it('keeps a stable virtual window until the visible range reaches the deadband', () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 100,
      rowHeight: 10,
      overscan: 4,
    })

    virtualizer.setScrollMetrics({ scrollTop: 0, viewportHeight: 30 })
    expect(virtualizer.getSnapshot().virtualItems.map((item) => item.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ])

    virtualizer.setScrollMetrics({ scrollTop: 10, viewportHeight: 30 })
    expect(virtualizer.getSnapshot().virtualItems.map((item) => item.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ])

    virtualizer.setScrollMetrics({ scrollTop: 30, viewportHeight: 30 })
    expect(virtualizer.getSnapshot().virtualItems.map((item) => item.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
  })

  it('defers scroll-only changes to one trailing emit with the exact final position', () => {
    vi.useFakeTimers()

    try {
      const onChange = vi.fn()
      const virtualizer = new FixedRowVirtualizer({
        count: 100,
        overscan: 2,
        rowHeight: 20,
      })
      const element = document.createElement('div')

      virtualizer.attachScrollElement(element, onChange, {
        readInitialScrollPosition: false,
      })
      virtualizer.setScrollMetrics({ scrollTop: 0, viewportHeight: 60 })
      virtualizer.getSnapshot()
      onChange.mockClear()

      // Same stable window, untouched geometry: no immediate emit...
      virtualizer.setScrollMetrics({ scrollTop: 5, viewportHeight: 60 })
      expect(onChange).not.toHaveBeenCalled()

      // ...but the exact position is emitted once scrolling stops.
      vi.advanceTimersByTime(200)
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ scrollTop: 5 }))

      onChange.mockClear()

      // A stable-window shift still emits immediately and supersedes the trailing emit.
      virtualizer.setScrollMetrics({ scrollTop: 200, viewportHeight: 60 })
      expect(onChange).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(200)
      expect(onChange).toHaveBeenCalledTimes(1)

      onChange.mockClear()

      // Horizontal scroll is geometry: always immediate.
      virtualizer.setScrollMetrics({ scrollLeft: 4, scrollTop: 200, viewportHeight: 60 })
      expect(onChange).toHaveBeenCalledTimes(1)

      virtualizer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits every scroll change while the native scroll height is capped', () => {
    const onChange = vi.fn()
    const virtualizer = new FixedRowVirtualizer({
      count: 1000,
      maxScrollHeight: 500,
      overscan: 2,
      rowHeight: 20,
    })
    const element = document.createElement('div')

    virtualizer.attachScrollElement(element, onChange, {
      readInitialScrollPosition: false,
    })
    virtualizer.setScrollMetrics({ scrollTop: 0, viewportHeight: 100 })
    virtualizer.getSnapshot()
    onChange.mockClear()

    // The spacer transform derives from scrollTop every frame in capped mode,
    // so even a sub-row scroll must emit.
    virtualizer.setScrollMetrics({ scrollTop: 5, viewportHeight: 100 })
    expect(onChange).toHaveBeenCalledTimes(1)

    virtualizer.dispose()
  })

  it('computes fixed row gaps without adding a trailing gap', () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 3,
      rowHeight: 20,
      rowGap: 4,
      overscan: 0,
    })

    virtualizer.setScrollMetrics({ scrollTop: 21, viewportHeight: 25 })

    expect(virtualizer.getSnapshot()).toMatchObject({
      totalSize: 68,
      visibleRange: { start: 1, end: 2 },
      virtualItems: [{ index: 1, start: 24, size: 20 }],
    })
  })

  it('reuses stable virtual item records while a row remains mounted', () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 100,
      rowHeight: 20,
      overscan: 1,
    })

    virtualizer.setScrollMetrics({ scrollTop: 0, viewportHeight: 60 })
    const first = virtualizer.getSnapshot().virtualItems
    const rowTwo = first.find((item) => item.index === 2)

    virtualizer.setScrollMetrics({ scrollTop: 5, viewportHeight: 60 })
    const second = virtualizer.getSnapshot().virtualItems
    const nextRowTwo = second.find((item) => item.index === 2)

    expect(nextRowTwo).toBe(rowTwo)
  })

  it('can attach to a fresh scroll element without reading scroll offsets', () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 100,
      rowHeight: 20,
    })
    const element = document.createElement('div')
    const scrollTop = vi.spyOn(element, 'scrollTop', 'get')
    const scrollLeft = vi.spyOn(element, 'scrollLeft', 'get')

    virtualizer.attachScrollElement(element, undefined, {
      readInitialScrollPosition: false,
    })

    expect(scrollTop).not.toHaveBeenCalled()
    expect(scrollLeft).not.toHaveBeenCalled()

    virtualizer.dispose()
  })

  it('renders the full document range in static scroll mode', () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 5,
      rowHeight: 20,
      overscan: 0,
      scrollMode: 'static',
    })

    virtualizer.setScrollMetrics({ scrollTop: 60, viewportHeight: 40 })

    expect(virtualizer.getSnapshot()).toMatchObject({
      nativeScrollHeight: 100,
      nativeScrollTop: 0,
      scrollHeight: 100,
      scrollTop: 0,
      totalSize: 100,
      viewportHeight: 100,
      visibleRange: { start: 0, end: 5 },
      virtualItems: [
        { index: 0, start: 0, size: 20 },
        { index: 1, start: 20, size: 20 },
        { index: 2, start: 40, size: 20 },
        { index: 3, start: 60, size: 20 },
        { index: 4, start: 80, size: 20 },
      ],
    })
  })

  it('skips scroll listeners and logical scroll properties in static scroll mode', () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 100,
      rowHeight: 20,
      scrollMode: 'static',
    })
    const element = document.createElement('div')
    const addEventListener = vi.spyOn(element, 'addEventListener')

    virtualizer.attachScrollElement(element, undefined, {
      readInitialScrollPosition: false,
    })

    expect(addEventListener).not.toHaveBeenCalled()
    expect(Object.getOwnPropertyDescriptor(element, 'scrollTop')).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(element, 'scrollHeight')).toBeUndefined()

    virtualizer.dispose()
  })

  it('does not write native scrollTop when option updates keep the native offset unchanged', () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 1,
      rowHeight: 20,
    })
    const element = document.createElement('div')
    let nativeScrollTop = 0
    const setNativeScrollTop = vi.fn((value: number) => {
      nativeScrollTop = value
    })

    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => nativeScrollTop,
      set: setNativeScrollTop,
    })

    virtualizer.attachScrollElement(element, undefined, {
      readInitialScrollPosition: false,
    })
    virtualizer.updateOptions({ count: 10_000 })

    expect(setNativeScrollTop).not.toHaveBeenCalled()

    virtualizer.setScrollMetrics({ scrollTop: 200, viewportHeight: 100 })
    expect(setNativeScrollTop).toHaveBeenCalledWith(200)

    setNativeScrollTop.mockClear()
    virtualizer.updateOptions({ count: 20_000 })

    expect(setNativeScrollTop).not.toHaveBeenCalled()

    virtualizer.dispose()
  })

  it('does not emit changes when option updates keep the normalized geometry unchanged', () => {
    const onChange = vi.fn()
    const virtualizer = new FixedRowVirtualizer({
      count: 10,
      overscan: 2,
      rowHeight: 20,
    })
    const element = document.createElement('div')

    virtualizer.attachScrollElement(element, onChange, {
      readInitialScrollPosition: false,
    })
    virtualizer.setScrollMetrics({ scrollTop: 0, viewportHeight: 60 })
    onChange.mockClear()

    virtualizer.updateOptions({ count: 10, overscan: 2, rowHeight: 20 })

    expect(onChange).not.toHaveBeenCalled()

    virtualizer.updateOptions({ count: 11 })

    expect(onChange).toHaveBeenCalledTimes(1)

    virtualizer.dispose()
  })

  it('does not read native scrollTop while syncing resize entries', () => {
    const originalResizeObserver = globalThis.ResizeObserver
    const frameScheduler = installFrameScheduler()
    const observers: TestResizeObserver[] = []

    globalThis.ResizeObserver = class extends TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback)
        observers.push(this)
      }
    } as typeof ResizeObserver

    try {
      const virtualizer = new FixedRowVirtualizer({
        count: 100,
        rowHeight: 20,
      })
      const element = document.createElement('div')
      let nativeScrollTop = 0
      const getNativeScrollTop = vi.fn(() => nativeScrollTop)

      Object.defineProperty(element, 'scrollTop', {
        configurable: true,
        get: getNativeScrollTop,
        set: (value: number) => {
          nativeScrollTop = value
        },
      })

      virtualizer.attachScrollElement(element, undefined, {
        readInitialScrollPosition: false,
      })
      virtualizer.setScrollMetrics({ scrollTop: 200, viewportHeight: 100 })

      getNativeScrollTop.mockClear()
      observers[0]?.resize(element, 320, 160)

      expect(getNativeScrollTop).not.toHaveBeenCalled()
      expect(virtualizer.getSnapshot()).toMatchObject({
        scrollTop: 200,
        viewportHeight: 100,
        viewportWidth: 0,
      })

      frameScheduler.flush()

      expect(getNativeScrollTop).not.toHaveBeenCalled()
      expect(virtualizer.getSnapshot()).toMatchObject({
        scrollTop: 200,
        viewportHeight: 160,
        viewportWidth: 320,
      })

      virtualizer.dispose()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
      frameScheduler.restore()
    }
  })

  it('coalesces resize entries into one frame update with the latest dimensions', () => {
    const originalResizeObserver = globalThis.ResizeObserver
    const frameScheduler = installFrameScheduler()
    const observers: TestResizeObserver[] = []

    globalThis.ResizeObserver = class extends TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback)
        observers.push(this)
      }
    } as typeof ResizeObserver

    try {
      const onChange = vi.fn()
      const virtualizer = new FixedRowVirtualizer({
        count: 100,
        rowHeight: 20,
      })
      const element = document.createElement('div')

      virtualizer.attachScrollElement(element, onChange, {
        readInitialScrollPosition: false,
      })
      virtualizer.setScrollMetrics({ scrollTop: 0, viewportHeight: 100, viewportWidth: 100 })
      onChange.mockClear()

      observers[0]?.resize(element, 320, 160)
      observers[0]?.resize(element, 640, 240)

      expect(onChange).not.toHaveBeenCalled()
      expect(frameScheduler.pendingCount()).toBe(1)

      frameScheduler.flush()

      expect(onChange).toHaveBeenCalledTimes(1)
      expect(virtualizer.getSnapshot()).toMatchObject({
        viewportHeight: 240,
        viewportWidth: 640,
      })

      virtualizer.dispose()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
      frameScheduler.restore()
    }
  })

  it('combines a pending resize with the next scroll sync', () => {
    const originalResizeObserver = globalThis.ResizeObserver
    const frameScheduler = installFrameScheduler()
    const observers: TestResizeObserver[] = []

    globalThis.ResizeObserver = class extends TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback)
        observers.push(this)
      }
    } as typeof ResizeObserver

    try {
      const onChange = vi.fn()
      const virtualizer = new FixedRowVirtualizer({
        count: 100,
        rowHeight: 20,
      })
      const element = document.createElement('div')
      let nativeScrollTop = 0

      Object.defineProperty(element, 'scrollTop', {
        configurable: true,
        get: () => nativeScrollTop,
        set: (value: number) => {
          nativeScrollTop = value
        },
      })

      virtualizer.attachScrollElement(element, onChange, {
        readInitialScrollPosition: false,
      })
      virtualizer.setScrollMetrics({ scrollTop: 200, viewportHeight: 100, viewportWidth: 100 })
      onChange.mockClear()

      observers[0]?.resize(element, 320, 160)
      nativeScrollTop = 260
      element.scrollLeft = 12
      element.dispatchEvent(new Event('scroll'))

      expect(frameScheduler.pendingCount()).toBe(1)

      frameScheduler.flush()

      expect(onChange).toHaveBeenCalledTimes(1)
      expect(virtualizer.getSnapshot()).toMatchObject({
        scrollLeft: 12,
        scrollTop: 260,
        viewportHeight: 160,
        viewportWidth: 320,
      })

      virtualizer.dispose()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
      frameScheduler.restore()
    }
  })

  it('combines a pending resize with logical scrollTop writes', () => {
    const originalResizeObserver = globalThis.ResizeObserver
    const frameScheduler = installFrameScheduler()
    const observers: TestResizeObserver[] = []

    globalThis.ResizeObserver = class extends TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback)
        observers.push(this)
      }
    } as typeof ResizeObserver

    try {
      const virtualizer = new FixedRowVirtualizer({
        count: 100,
        rowHeight: 20,
      })
      const element = document.createElement('div')

      virtualizer.attachScrollElement(element, undefined, {
        readInitialScrollPosition: false,
      })
      virtualizer.setScrollMetrics({ scrollTop: 0, viewportHeight: 100, viewportWidth: 100 })

      observers[0]?.resize(element, 320, 160)
      element.scrollTop = 260

      expect(frameScheduler.pendingCount()).toBe(0)
      expect(virtualizer.getSnapshot()).toMatchObject({
        scrollTop: 260,
        viewportHeight: 160,
        viewportWidth: 320,
      })

      virtualizer.dispose()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
      frameScheduler.restore()
    }
  })

  it('cancels pending resize work when detached', () => {
    const originalResizeObserver = globalThis.ResizeObserver
    const frameScheduler = installFrameScheduler()
    const observers: TestResizeObserver[] = []

    globalThis.ResizeObserver = class extends TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback)
        observers.push(this)
      }
    } as typeof ResizeObserver

    try {
      const onChange = vi.fn()
      const virtualizer = new FixedRowVirtualizer({
        count: 100,
        rowHeight: 20,
      })
      const element = document.createElement('div')

      virtualizer.attachScrollElement(element, onChange, {
        readInitialScrollPosition: false,
      })
      virtualizer.setScrollMetrics({ scrollTop: 0, viewportHeight: 100 })
      onChange.mockClear()

      observers[0]?.resize(element, 320, 160)
      expect(frameScheduler.pendingCount()).toBe(1)

      virtualizer.dispose()
      frameScheduler.flush()

      expect(onChange).not.toHaveBeenCalled()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
      frameScheduler.restore()
    }
  })

  it('tracks the viewport border box separately from the content box', () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 100,
      rowHeight: 20,
    })

    virtualizer.setScrollMetrics({
      scrollTop: 0,
      viewportHeight: 60,
      viewportWidth: 80,
      borderBoxHeight: 72,
      borderBoxWidth: 96,
    })

    expect(virtualizer.getSnapshot()).toMatchObject({
      borderBoxHeight: 72,
      borderBoxWidth: 96,
      viewportHeight: 60,
      viewportWidth: 80,
    })
  })

  it('clears stable records when row height changes', () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 100,
      rowHeight: 20,
      overscan: 1,
    })

    virtualizer.setScrollMetrics({ scrollTop: 0, viewportHeight: 60 })
    const rowOne = virtualizer.getSnapshot().virtualItems[1]
    virtualizer.updateOptions({ rowHeight: 24 })

    expect(virtualizer.getSnapshot().virtualItems[1]).not.toBe(rowOne)
    expect(virtualizer.getSnapshot().virtualItems[1]).toEqual({
      index: 1,
      start: 24,
      size: 24,
    })
  })

  it('supports variable row sizes', () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 3,
      rowHeight: 20,
      rowSizes: [20, 60, 20],
      overscan: 0,
    })

    virtualizer.setScrollMetrics({ scrollTop: 30, viewportHeight: 40 })

    expect(virtualizer.getSnapshot()).toMatchObject({
      totalSize: 100,
      visibleRange: { start: 1, end: 2 },
      virtualItems: [{ index: 1, start: 20, size: 60 }],
    })
  })

  it('applies row gaps between variable rows', () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 3,
      rowHeight: 20,
      rowGap: 4,
      rowSizes: [20, 60, 20],
      overscan: 0,
    })

    virtualizer.setScrollMetrics({ scrollTop: 22, viewportHeight: 40 })

    expect(virtualizer.getSnapshot()).toMatchObject({
      totalSize: 108,
      visibleRange: { start: 1, end: 2 },
      virtualItems: [{ index: 1, start: 24, size: 60 }],
    })
  })

  it('caps native scroll height while preserving logical scroll offsets', () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 1_000,
      maxScrollHeight: 1_000,
      overscan: 0,
      rowHeight: 100,
    })

    virtualizer.setScrollMetrics({ scrollTop: 99_900, viewportHeight: 100 })

    expect(virtualizer.getSnapshot()).toMatchObject({
      nativeScrollHeight: 1_000,
      nativeScrollTop: 900,
      scrollHeight: 100_000,
      scrollTop: 99_900,
      visibleRange: { start: 999, end: 1_000 },
    })
  })

  it('keeps large-file rows addressable past native browser scroll caps', () => {
    const targetRow = 699_051
    const virtualizer = new FixedRowVirtualizer({
      count: targetRow + 100,
      overscan: 0,
      rowHeight: 48,
    })

    virtualizer.setScrollMetrics({
      scrollTop: targetRow * 48,
      viewportHeight: 480,
    })

    expect(virtualizer.getSnapshot()).toMatchObject({
      nativeScrollHeight: 16_000_000,
      visibleRange: { start: targetRow, end: targetRow + 10 },
    })
  })

  it('exposes logical scroll metrics on attached scroll elements', () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 1_000,
      maxScrollHeight: 1_000,
      overscan: 0,
      rowHeight: 100,
    })
    const element = document.createElement('div')

    virtualizer.attachScrollElement(element, undefined, {
      readInitialScrollPosition: false,
    })
    virtualizer.setScrollMetrics({ scrollTop: 99_900, viewportHeight: 100 })

    expect(element.scrollHeight).toBe(100_000)
    expect(element.scrollTop).toBe(99_900)

    element.scrollTop = 49_950

    expect(virtualizer.getSnapshot()).toMatchObject({
      nativeScrollTop: 450,
      scrollTop: 49_950,
      visibleRange: { start: 499, end: 501 },
    })

    virtualizer.dispose()
  })
})

class TestResizeObserver implements ResizeObserver {
  public readonly observe = vi.fn()
  public readonly unobserve = vi.fn()
  public readonly disconnect = vi.fn()

  public constructor(private readonly callback: ResizeObserverCallback) {}

  public takeRecords(): ResizeObserverEntry[] {
    return []
  }

  public resize(target: Element, width: number, height: number): void {
    this.callback([resizeEntry(target, width, height)], this)
  }
}

function installFrameScheduler(): {
  flush(): void
  pendingCount(): number
  restore(): void
} {
  const originalRequest = Reflect.get(globalThis, 'requestAnimationFrame') as
    | typeof requestAnimationFrame
    | undefined
  const originalCancel = Reflect.get(globalThis, 'cancelAnimationFrame') as
    | typeof cancelAnimationFrame
    | undefined
  let nextHandle = 1
  const callbacks = new Map<number, FrameRequestCallback>()

  globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback): number => {
    const handle = nextHandle
    nextHandle += 1
    callbacks.set(handle, callback)
    return handle
  })
  globalThis.cancelAnimationFrame = vi.fn((handle: number): void => {
    callbacks.delete(handle)
  })

  return {
    flush: () => {
      const pending = Array.from(callbacks.values())
      callbacks.clear()
      for (const callback of pending) callback(0)
    },
    pendingCount: () => callbacks.size,
    restore: () => {
      restoreFrameFunction('requestAnimationFrame', originalRequest)
      restoreFrameFunction('cancelAnimationFrame', originalCancel)
    },
  }
}

function restoreFrameFunction(
  name: 'requestAnimationFrame' | 'cancelAnimationFrame',
  value: typeof requestAnimationFrame | typeof cancelAnimationFrame | undefined,
): void {
  if (value) {
    Reflect.set(globalThis, name, value)
    return
  }

  Reflect.deleteProperty(globalThis, name)
}

function resizeEntry(target: Element, width: number, height: number): ResizeObserverEntry {
  return {
    borderBoxSize: [resizeBox(width, height)],
    contentBoxSize: [resizeBox(width, height)],
    contentRect: {
      bottom: height,
      height,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRectReadOnly,
    devicePixelContentBoxSize: [resizeBox(width, height)],
    target,
  }
}

function resizeBox(width: number, height: number): ResizeObserverSize {
  return {
    blockSize: height,
    inlineSize: width,
  }
}
