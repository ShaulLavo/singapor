import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorBlockSurfaceController } from '../src/editor/blockSurfaceController'
import type {
  EditorBlockMount,
  EditorBlockMountContext,
  EditorBlockProvider,
  EditorBlockSize,
} from '../src/editorBlocks'
import { type VirtualizedTextHighlightRegistry, VirtualizedTextView } from '../src/virtualization'

const highlightsMap = new Map<string, Highlight>()
const mockRegistry: VirtualizedTextHighlightRegistry = {
  set: (name, highlight) => {
    highlightsMap.set(name, highlight)
  },
  delete: (name) => highlightsMap.delete(name),
}

describe('block surfaces', () => {
  let container: HTMLElement
  let view: VirtualizedTextView
  let controller: EditorBlockSurfaceController
  let fullTextReads: number

  beforeEach(() => {
    highlightsMap.clear()
    fullTextReads = 0
    // @ts-expect-error happy-dom does not provide Highlight.
    globalThis.Highlight = Set
    container = document.createElement('div')
    document.body.appendChild(container)
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      highlightRegistry: mockRegistry,
      selectionHighlightName: 'test-selection',
      blockRowMount: (element, row) => controller.mountRow(element, row),
    })
    controller = new EditorBlockSurfaceController({
      getDocumentId: () => 'doc',
      getLineCount: () => view.getState().lineCount,
      materializeFullText: () => {
        fullTextReads += 1
        return view.getState().lineCount > 0 ? 'document text' : ''
      },
      applyBlockRows: (rows) => view.setBlockRows(rows),
      applyBlockLanes: (lanes) => view.setBlockLanes(lanes),
      focusEditor: () => {},
      setSelection: () => {},
      notifyLayout: () => {},
    })
  })

  afterEach(() => {
    controller.dispose()
    view.dispose()
    container.remove()
    Reflect.deleteProperty(globalThis, 'Highlight')
  })

  it('orders surfaces anchored to the same row by provider, past ten providers', () => {
    const mountOrder: string[] = []

    view.setText(documentLines(200))
    controller.sync(
      Array.from({ length: 12 }, (_value, index) =>
        blockProvider(`block-${index}`, { minPx: 20, maxPx: 20 }, (_element, context) => {
          mountOrder.push(context.blockId)
        }),
      ),
    )
    view.setScrollMetrics(0, 400)

    expect(mountOrder).toEqual(Array.from({ length: 12 }, (_value, index) => `block-${index}`))
  })

  it('settles a measured surface without re-resolving any provider', async () => {
    let mountContext: EditorBlockMountContext | null = null
    let blockElement: HTMLElement | null = null
    let resolutions = 0

    view.setText(documentLines(200))
    controller.sync(
      Array.from({ length: 8 }, (_value, index) =>
        blockProvider(`block-${index}`, { minPx: 20, maxPx: 400 }, (element, context) => {
          if (index !== 0) return

          blockElement = element
          mountContext = context
        }),
      ).map((provider) => countResolutions(provider, () => (resolutions += 1))),
    )
    view.setScrollMetrics(0, 100)

    const heightBefore = view.getState().totalHeight
    resolutions = 0
    fullTextReads = 0

    measureAs(blockElement, 300)
    mountContext!.requestMeasure()
    await flushMeasurements()

    expect(view.getState().totalHeight).toBeGreaterThan(heightBefore)
    expect(resolutions).toBe(0)
    expect(fullTextReads).toBe(0)
  })

  it('leaves the document unread for surfaces that never ask for it', () => {
    view.setText(documentLines(200))
    controller.sync([blockProvider('preview', { px: 40 }, () => {})])
    view.setScrollMetrics(0, 100)
    view.setScrollMetrics(1_000, 100)
    view.setScrollMetrics(0, 100)

    expect(fullTextReads).toBe(0)
  })

  it('reads the document once for a surface that asks for it repeatedly', () => {
    view.setText(documentLines(200))
    controller.sync([
      blockProvider('preview', { px: 40 }, (element, context) => {
        element.textContent = `${context.text.length}:${context.text.length}`
      }),
    ])
    view.setScrollMetrics(0, 100)

    expect(fullTextReads).toBe(1)
  })

  it('keeps a hoisted surface and its state across scroll recycling', () => {
    let mounts = 0

    view.setText(documentLines(200))
    controller.sync([hoistedProvider(() => (mounts += 1))])
    view.setScrollMetrics(0, 100)

    const draft = container.querySelector('input')
    const pane = container.querySelector<HTMLElement>('[data-block-pane]')
    draft!.value = 'unsent comment'
    draft!.focus()
    pane!.scrollTop = 40

    view.setScrollMetrics(1_000, 100)
    view.setScrollMetrics(0, 100)

    expect(mounts).toBe(1)
    expect(container.querySelector('input')?.value).toBe('unsent comment')
    expect(container.querySelector<HTMLElement>('[data-block-pane]')?.scrollTop).toBe(40)
    expect(document.activeElement).toBe(container.querySelector('input'))
  })

  it('keeps a hoisted surface and its state across a provider re-resolution', () => {
    let mounts = 0

    view.setText(documentLines(200))
    controller.sync([hoistedProvider(() => (mounts += 1))])
    view.setScrollMetrics(0, 100)

    const draft = container.querySelector('input')
    draft!.value = 'unsent comment'
    draft!.focus()

    // What every edit to the document does: the providers run again and answer
    // with a fresh resolution of the same block.
    controller.sync([hoistedProvider(() => (mounts += 1))])
    view.setScrollMetrics(0, 100)

    expect(mounts).toBe(1)
    expect(container.querySelector('input')).toBe(draft)
    expect(draft!.value).toBe('unsent comment')
    expect(document.activeElement).toBe(draft)
  })

  it('disposes a hoisted surface once its block is withdrawn', () => {
    let disposals = 0

    view.setText(documentLines(200))
    controller.sync([hoistedProvider(() => {}, { onDispose: () => (disposals += 1) })])
    view.setScrollMetrics(0, 100)
    expect(container.querySelector('input')).not.toBeNull()

    controller.sync([])
    view.setScrollMetrics(0, 100)

    expect(disposals).toBe(1)
    expect(container.querySelector('input')).toBeNull()
  })

  it('disposes a live hoisted surface when the view goes away', () => {
    let disposals = 0

    view.setText(documentLines(200))
    controller.sync([hoistedProvider(() => {}, { onDispose: () => (disposals += 1) })])
    view.setScrollMetrics(0, 100)
    const layer = container.querySelector<HTMLElement>(HOISTED_LAYER)!
    const spacer = layer.parentElement!

    view.dispose()

    expect(disposals).toBe(1)
    expect(spacer.contains(layer)).toBe(false)
  })

  it('builds no hoisted layer for a view with nothing hoisted', () => {
    view.setText(documentLines(200))
    controller.sync([blockProvider('preview', { px: 40 }, () => {})])
    view.setScrollMetrics(0, 100)
    view.setScrollMetrics(200, 100)

    expect(container.querySelector(HOISTED_LAYER)).toBeNull()
  })

  it('hands a hoisted surface an element already in the page to mount into', () => {
    const attachedAtMount: boolean[] = []

    view.setText(documentLines(200))
    controller.sync([hoistedProvider((element) => attachedAtMount.push(element.isConnected))])
    view.setScrollMetrics(0, 100)

    expect(attachedAtMount).toEqual([true])
  })

  it('gives a hoisted host the height of the row it covers, and follows it', () => {
    view.setText(documentLines(200))
    controller.sync([hoistedProvider(() => {})])
    view.setScrollMetrics(0, 100)
    const host = hoistedHost(container)

    expect(host.style.height).toBe('60px')

    controller.sync([hoistedProvider(() => {}, { heightPx: 140 })])
    view.setScrollMetrics(0, 100)

    expect(host.style.height).toBe('140px')
  })

  it('parks a hoisted surface out of reach of every scroll offset', () => {
    view.setText(documentLines(200))
    controller.sync([hoistedProvider(() => {}, { row: 100, heightPx: 320 })])
    view.setScrollMetrics(2_000, 100)
    const host = hoistedHost(container)

    view.setScrollMetrics(0, 100)

    const parkedTop = translateYPx(host.style.transform)
    expect(parkedTop + Number.parseFloat(host.style.height)).toBeLessThanOrEqual(0)
  })

  it('paints the hoisted layer above the gutter', () => {
    view.setText(documentLines(200))
    controller.sync([hoistedProvider(() => {})])
    view.setScrollMetrics(0, 100)
    const layer = container.querySelector<HTMLElement>(HOISTED_LAYER)!

    expect(stackingTier(layer.style.zIndex)).toBeGreaterThan(
      stackingTier(shippedZIndex('.editor-virtualized-gutter')),
    )
  })

  it('leaves the row a hoisted surface covers untouched while it only scrolls', () => {
    view.setText(documentLines(200))
    controller.sync([hoistedProvider(() => {})])
    view.setScrollMetrics(0, 100)

    const touched = recordStyleProperties(
      container.querySelector<HTMLElement>('[data-editor-virtual-row-kind="block"]')!,
    )
    view.setScrollMetrics(20, 100)
    view.setScrollMetrics(40, 100)

    expect(touched).toEqual([])
  })

  it('moves a hoisted surface only when its row moves', () => {
    view.setText(documentLines(200))
    controller.sync([hoistedProvider(() => {})])
    view.setScrollMetrics(0, 100)

    const touched = recordStyleProperties(hoistedHost(container))
    view.setScrollMetrics(20, 100)
    view.setScrollMetrics(40, 100)

    expect(touched).not.toContain('transform')

    controller.sync([hoistedProvider(() => {}, { row: 6 })])
    view.setScrollMetrics(40, 100)

    expect(touched).toContain('transform')
  })
})

const HOISTED_LAYER = '.editor-virtualized-hoisted-block-layer'

function blockProvider(
  id: string,
  height: EditorBlockSize,
  mount: EditorBlockMount,
): EditorBlockProvider {
  return {
    getBlocks: () => [{ id, anchor: { row: 2 }, top: { height, mount } }],
  }
}

type HoistedProviderOptions = {
  readonly onDispose?: () => void
  readonly heightPx?: number
  readonly row?: number
}

function hoistedProvider(
  onMount: (element: HTMLElement) => void,
  options: HoistedProviderOptions = {},
): EditorBlockProvider {
  return {
    getBlocks: () => [
      {
        id: 'comment',
        anchor: { row: options.row ?? 2 },
        top: {
          height: { px: options.heightPx ?? 60 },
          hosting: 'hoisted',
          mount: (element) => {
            onMount(element)
            const draft = element.ownerDocument.createElement('input')
            const pane = element.ownerDocument.createElement('div')
            pane.dataset.blockPane = ''
            element.append(draft, pane)
            return { dispose: () => options.onDispose?.() }
          },
        },
      },
    ],
  }
}

function hoistedHost(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(`${HOISTED_LAYER} > *`)!
}

function translateYPx(transform: string): number {
  return Number.parseFloat(/translateY\((-?[\d.]+)px\)/.exec(transform)![1]!)
}

const stylesheet = readFileSync(`${import.meta.dirname}/../src/style.css`, 'utf8')

/** The z-index the shipped stylesheet gives a selector, token and all. */
function shippedZIndex(selector: string): string {
  const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(stylesheet)![1]!
  return /z-index:\s*([^;]+);/.exec(rule)![1]!
}

function stackingTier(zIndex: string): number {
  const token = /var\((--[a-z-]+)\)/.exec(zIndex)
  if (!token) return Number.parseInt(zIndex, 10)

  return Number.parseInt(new RegExp(`${token[1]!}:\\s*(\\d+);`).exec(stylesheet)![1]!, 10)
}

/**
 * Records the inline style properties a pass touches, so a test can hold a pass
 * to doing no work rather than to leaving the DOM looking the same afterwards.
 */
function recordStyleProperties(element: HTMLElement): readonly string[] {
  const touched: string[] = []
  const declaration = element.style
  const proxy = new Proxy(declaration, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown
      if (typeof value !== 'function') {
        touched.push(String(property))
        return value
      }

      return (...args: readonly unknown[]) => {
        touched.push(String(args[0]))
        return (value as (...values: readonly unknown[]) => unknown).apply(target, args)
      }
    },
    set(target, property, value) {
      touched.push(String(property))
      return Reflect.set(target, property, value)
    },
  })
  Object.defineProperty(element, 'style', { configurable: true, get: () => proxy })
  return touched
}

function countResolutions(
  provider: EditorBlockProvider,
  onResolve: () => void,
): EditorBlockProvider {
  return {
    getBlocks: (context) => {
      onResolve()
      return provider.getBlocks(context)
    },
  }
}

function documentLines(count: number): string {
  return Array.from({ length: count }, (_value, line) => `line ${line}`).join('\n')
}

// happy-dom reports every rect empty, so a block reports its height the way a
// loaded image would.
function measureAs(element: HTMLElement | null, height: number): void {
  element!.getBoundingClientRect = () => ({ height, width: 0 }) as DOMRect
}

function flushMeasurements(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
