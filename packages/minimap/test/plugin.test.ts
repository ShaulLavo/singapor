import { describe, expect, it, vi } from 'vitest'
import type {
  EditorCapabilityContributionProvider,
  EditorPluginContext,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import { EDITOR_MINIMAP_FEATURE } from '@singapor/core/extensions'
import { createMinimapPlugin } from '../src/plugin'

describe('createMinimapPlugin', () => {
  it('registers a view contribution factory', () => {
    const registerViewContribution = vi.fn<EditorPluginContext['registerViewContribution']>(() => ({
      dispose: vi.fn(),
    }))
    const plugin = createMinimapPlugin({ enabled: false })

    const disposable = plugin.activate({
      registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
      registerSyntaxProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerViewContribution,
      registerCommandContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerCapabilityContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerEditContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerDecorationContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerBlockProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerInjectedTextRowProvider: vi.fn(() => ({ dispose: vi.fn() })),
    })

    expect(plugin.name).toBe('minimap')
    expect(disposable).toBeDefined()
    expect(registerViewContribution).toHaveBeenCalledOnce()
  })

  it('registers decorations through a capability contribution factory', () => {
    let registration: EditorCapabilityContributionProvider | undefined
    const registerCapabilityContribution: EditorPluginContext['registerCapabilityContribution'] = (
      provider,
    ) => {
      registration = provider
      return { dispose: vi.fn() }
    }
    const registerFeature = vi.fn(() => ({ dispose: vi.fn() }))
    const plugin = createMinimapPlugin({ enabled: false })

    plugin.activate({
      registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
      registerSyntaxProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerViewContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerCommandContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerCapabilityContribution,
      registerEditContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerDecorationContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerBlockProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerInjectedTextRowProvider: vi.fn(() => ({ dispose: vi.fn() })),
    })

    const contribution = registration?.createContribution({ registerFeature })

    expect(registerFeature).toHaveBeenCalledWith(EDITOR_MINIMAP_FEATURE, expect.any(Object))

    contribution?.dispose()
  })

  it('returns no contribution when disabled', () => {
    let registration: EditorViewContributionProvider | undefined
    const registerViewContribution: EditorPluginContext['registerViewContribution'] = (
      provider,
    ) => {
      registration = provider
      return { dispose: vi.fn() }
    }
    const plugin = createMinimapPlugin({ enabled: false })

    plugin.activate({
      registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
      registerSyntaxProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerViewContribution,
      registerCommandContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerCapabilityContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerEditContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerDecorationContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerBlockProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerInjectedTextRowProvider: vi.fn(() => ({ dispose: vi.fn() })),
    })

    expect(registration?.createContribution(context())).toBeNull()
  })

  it('uses viewport border-box metrics for native scrollbar gutters', () => {
    const restoreRuntime = installMinimapRuntime()
    try {
      let registration: EditorViewContributionProvider | undefined
      const registerViewContribution: EditorPluginContext['registerViewContribution'] = (
        provider,
      ) => {
        registration = provider
        return { dispose: vi.fn() }
      }
      const plugin = createMinimapPlugin({ enabled: true })

      plugin.activate({
        registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
        registerSyntaxProvider: vi.fn(() => ({ dispose: vi.fn() })),
        registerViewContribution,
        registerCommandContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerCapabilityContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerEditContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerDecorationContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerBlockProvider: vi.fn(() => ({ dispose: vi.fn() })),
        registerInjectedTextRowProvider: vi.fn(() => ({ dispose: vi.fn() })),
      })

      const snapshotWithScrollbar = snapshot({
        borderBoxWidth: 110,
        clientHeight: 20,
        clientWidth: 80,
        scrollHeight: 80,
        scrollWidth: 80,
      })
      const testContext = context(snapshotWithScrollbar)
      defineThrowingLayoutProperty(testContext.scrollElement, 'offsetHeight')
      defineThrowingLayoutProperty(testContext.scrollElement, 'offsetWidth')
      defineThrowingLayoutProperty(testContext.scrollElement, 'scrollHeight')
      defineThrowingLayoutProperty(testContext.scrollElement, 'scrollWidth')
      defineThrowingLayoutProperty(testContext.scrollElement, 'clientWidth')

      const contribution = registration?.createContribution(testContext)
      const host = testContext.container.querySelector<HTMLElement>('.editor-minimap-right')

      expect(contribution).not.toBeNull()
      expect(host?.style.right).toBe('30px')
      expect(testContext.reserveOverlayWidth).toHaveBeenCalledWith('right', 30)

      vi.mocked(testContext.reserveOverlayWidth).mockClear()
      contribution?.update(snapshotWithScrollbar, 'viewport')
      expect(testContext.reserveOverlayWidth).not.toHaveBeenCalled()

      const getComputedStyle = vi.spyOn(window, 'getComputedStyle')
      contribution?.update(
        snapshot({
          borderBoxWidth: 112,
          clientHeight: 20,
          clientWidth: 80,
          scrollHeight: 80,
          scrollWidth: 80,
        }),
        'viewport',
      )

      expect(getComputedStyle).not.toHaveBeenCalled()
      getComputedStyle.mockRestore()

      contribution?.dispose()
    } finally {
      restoreRuntime()
    }
  })

  it('uses the measured scrollbar dimensions before overlay fallback', () => {
    const restoreRuntime = installMinimapRuntime()
    const getComputedStyle = vi
      .spyOn(window, 'getComputedStyle')
      .mockImplementation((_element, pseudoElement) =>
        mockComputedStyle(
          pseudoElement === '::-webkit-scrollbar'
            ? { height: '6px', width: '9px' }
            : {
                borderBottomWidth: '0px',
                borderLeftWidth: '0px',
                borderRightWidth: '0px',
                borderTopWidth: '0px',
              },
        ),
      )

    try {
      let registration: EditorViewContributionProvider | undefined
      const registerViewContribution: EditorPluginContext['registerViewContribution'] = (
        provider,
      ) => {
        registration = provider
        return { dispose: vi.fn() }
      }
      const plugin = createMinimapPlugin({ enabled: true })

      plugin.activate({
        registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
        registerSyntaxProvider: vi.fn(() => ({ dispose: vi.fn() })),
        registerViewContribution,
        registerCommandContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerCapabilityContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerEditContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerDecorationContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerBlockProvider: vi.fn(() => ({ dispose: vi.fn() })),
        registerInjectedTextRowProvider: vi.fn(() => ({ dispose: vi.fn() })),
      })

      const hiddenNativeScrollSnapshot = {
        ...snapshot({
          borderBoxWidth: 80,
          clientHeight: 20,
          clientWidth: 80,
          scrollWidth: 120,
          scrollHeight: 20,
        }),
        totalHeight: 80,
      }
      const testContext = context(hiddenNativeScrollSnapshot)
      const contribution = registration?.createContribution(testContext)
      const host = testContext.container.querySelector<HTMLElement>('.editor-minimap-right')

      expect(contribution).not.toBeNull()
      expect(host?.style.bottom).toBe('6px')
      expect(host?.style.right).toBe('9px')
      expect(testContext.reserveOverlayWidth).toHaveBeenCalledWith('right', 9)

      contribution?.dispose()
    } finally {
      getComputedStyle.mockRestore()
      restoreRuntime()
    }
  })

  it('does not reserve an overlay scrollbar lane when native gutters measure zero', () => {
    const restoreRuntime = installMinimapRuntime()
    try {
      let registration: EditorViewContributionProvider | undefined
      const registerViewContribution: EditorPluginContext['registerViewContribution'] = (
        provider,
      ) => {
        registration = provider
        return { dispose: vi.fn() }
      }
      const plugin = createMinimapPlugin({ enabled: true })

      plugin.activate({
        registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
        registerSyntaxProvider: vi.fn(() => ({ dispose: vi.fn() })),
        registerViewContribution,
        registerCommandContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerCapabilityContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerEditContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerDecorationContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerBlockProvider: vi.fn(() => ({ dispose: vi.fn() })),
        registerInjectedTextRowProvider: vi.fn(() => ({ dispose: vi.fn() })),
      })

      const hiddenNativeScrollSnapshot = {
        ...snapshot({
          borderBoxWidth: 80,
          clientHeight: 20,
          clientWidth: 80,
          scrollHeight: 20,
        }),
        totalHeight: 80,
      }
      const testContext = context(hiddenNativeScrollSnapshot)
      const contribution = registration?.createContribution(testContext)
      const host = testContext.container.querySelector<HTMLElement>('.editor-minimap-right')

      expect(contribution).not.toBeNull()
      expect(host?.style.right).toBe('0px')
      expect(testContext.reserveOverlayWidth).not.toHaveBeenCalledWith('right', 7)

      contribution?.dispose()
    } finally {
      restoreRuntime()
    }
  })

  it('coalesces slider drag scrolling outside the pointermove handler', () => {
    const restoreRuntime = installMinimapRuntime()
    const animationFrames = installAnimationFrames()
    try {
      let registration: EditorViewContributionProvider | undefined
      const registerViewContribution: EditorPluginContext['registerViewContribution'] = (
        provider,
      ) => {
        registration = provider
        return { dispose: vi.fn() }
      }
      const plugin = createMinimapPlugin({ enabled: true })

      plugin.activate({
        registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
        registerSyntaxProvider: vi.fn(() => ({ dispose: vi.fn() })),
        registerViewContribution,
        registerCommandContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerCapabilityContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerEditContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerDecorationContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerBlockProvider: vi.fn(() => ({ dispose: vi.fn() })),
        registerInjectedTextRowProvider: vi.fn(() => ({ dispose: vi.fn() })),
      })

      const testContext = context(
        snapshot({
          clientHeight: 100,
          scrollHeight: 500,
        }),
      )
      const contribution = registration?.createContribution(testContext)
      const root = testContext.container.querySelector<HTMLElement>('.editor-minimap')
      const slider = testContext.container.querySelector<HTMLElement>('.editor-minimap-slider')

      expect(contribution).not.toBeNull()
      expect(root).not.toBeNull()
      expect(slider).not.toBeNull()

      defineReadonlyProperty(root!, 'clientHeight', 100)
      defineElementRect(slider!, { height: 20, width: 20 })
      installPointerCapture(slider!)

      dispatchPointer(slider!, 'pointerdown', { clientY: 10 })
      dispatchPointer(slider!.ownerDocument, 'pointermove', { clientY: 50 })

      expect(testContext.setScrollTop).not.toHaveBeenCalled()
      expect(testContext.scrollElement.scrollTop).toBe(0)

      animationFrames.flush()

      expect(testContext.scrollElement.scrollTop).toBe(200)
      expect(testContext.setScrollTop).not.toHaveBeenCalled()

      dispatchPointer(slider!.ownerDocument, 'pointermove', { clientY: 60 })
      dispatchPointer(slider!.ownerDocument, 'pointerup', { clientY: 60 })

      expect(testContext.scrollElement.scrollTop).toBe(250)
      expect(animationFrames.pendingCount()).toBe(0)

      contribution?.dispose()
    } finally {
      animationFrames.restore()
      restoreRuntime()
    }
  })
})

function context(viewSnapshot = snapshot()): EditorViewContributionContext {
  const container = document.createElement('div')
  const scrollElement = document.createElement('div')
  container.appendChild(scrollElement)
  return {
    container,
    scrollElement,
    hasDocument: () => true,
    getSnapshot: () => viewSnapshot,
    reserveOverlayWidth: vi.fn(),
    revealLine: vi.fn(),
    focusEditor: vi.fn(),
    setSelection: vi.fn(),
    setSelections: vi.fn(),
    setScrollTop: vi.fn(),
    textOffsetFromPoint: vi.fn(() => null),
    getRangeClientRect: vi.fn(() => null),
  }
}

function snapshot(viewport: Partial<EditorViewSnapshot['viewport']> = {}): EditorViewSnapshot {
  return {
    documentId: 'minimap-test',
    languageId: 'typescript',
    fullText: '',
    textVersion: 1,
    lineStarts: [0],
    tokens: [],
    selections: [],
    metrics: { rowHeight: 20, characterWidth: 8 },
    lineCount: 1,
    contentWidth: 0,
    totalHeight: 20,
    tabSize: 4,
    foldMarkers: [],
    visibleRows: [],
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 20,
      scrollWidth: 0,
      clientHeight: 20,
      clientWidth: 80,
      borderBoxHeight: 20,
      borderBoxWidth: 80,
      visibleRange: { start: 0, end: 1 },
      ...viewport,
    },
  }
}

function installMinimapRuntime(): () => void {
  const worker = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  const offscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas')
  const transferControlToOffscreen = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    'transferControlToOffscreen',
  )

  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: MockWorker,
  })
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    configurable: true,
    value: class MockOffscreenCanvas {},
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
    configurable: true,
    value: () => ({}),
  })

  return () => {
    restoreDescriptor(globalThis, 'Worker', worker)
    restoreDescriptor(globalThis, 'OffscreenCanvas', offscreenCanvas)
    restoreDescriptor(
      HTMLCanvasElement.prototype,
      'transferControlToOffscreen',
      transferControlToOffscreen,
    )
  }
}

class MockWorker {
  public onmessage: ((event: MessageEvent) => void) | null = null
  public onerror: ((event: ErrorEvent) => void) | null = null
  public postMessage = vi.fn()
  public terminate = vi.fn()

  public constructor(_url: URL, _options?: WorkerOptions) {}
}

function defineThrowingLayoutProperty(
  element: HTMLElement,
  property: 'offsetHeight' | 'offsetWidth' | 'scrollHeight' | 'scrollWidth' | 'clientWidth',
): void {
  Object.defineProperty(element, property, {
    configurable: true,
    get: () => {
      throw new Error(`unexpected ${property} read`)
    },
  })
}

function defineReadonlyProperty(
  element: HTMLElement,
  property: 'clientHeight',
  value: number,
): void {
  Object.defineProperty(element, property, {
    configurable: true,
    value,
  })
}

function defineElementRect(
  element: HTMLElement,
  rect: { readonly height: number; readonly width: number },
): void {
  element.getBoundingClientRect = () =>
    ({
      bottom: rect.height,
      height: rect.height,
      left: 0,
      right: rect.width,
      top: 0,
      width: rect.width,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    }) as DOMRect
}

function installPointerCapture(element: HTMLElement): void {
  Object.defineProperty(element, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(element, 'hasPointerCapture', {
    configurable: true,
    value: vi.fn(() => true),
  })
  Object.defineProperty(element, 'releasePointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
}

function dispatchPointer(
  target: EventTarget,
  type: string,
  init: { readonly clientY: number; readonly pointerId?: number },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientY: init.clientY,
  })
  Object.defineProperty(event, 'pointerId', {
    configurable: true,
    value: init.pointerId ?? 1,
  })
  target.dispatchEvent(event)
}

function installAnimationFrames(): {
  readonly flush: () => void
  readonly pendingCount: () => number
  readonly restore: () => void
} {
  const requestAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  const cancelAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame')
  const frames = new Map<number, () => void>()
  let nextFrame = 1

  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: () => void) => {
      const frame = nextFrame
      nextFrame += 1
      frames.set(frame, callback)
      return frame
    },
  })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: (frame: number) => frames.delete(frame),
  })

  return {
    flush: () => {
      const pending = new Map(frames)
      frames.clear()
      for (const callback of pending.values()) callback()
    },
    pendingCount: () => frames.size,
    restore: () => {
      restoreDescriptor(globalThis, 'requestAnimationFrame', requestAnimationFrame)
      restoreDescriptor(globalThis, 'cancelAnimationFrame', cancelAnimationFrame)
    },
  }
}

function restoreDescriptor(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor)
    return
  }

  Reflect.deleteProperty(target, property)
}

function mockComputedStyle(values: Record<string, string>): CSSStyleDeclaration {
  return {
    ...values,
    getPropertyValue: (property: string) => values[property] ?? '',
  } as CSSStyleDeclaration
}
