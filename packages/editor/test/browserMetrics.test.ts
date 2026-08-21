import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '../src/editor'
import {
  clearBrowserTextMetricsCache,
  measureBrowserTextMetrics,
  measureWhitespaceDotGlyph,
} from '../src/virtualization/browserMetrics'
import type { EditorPlugin, EditorViewSnapshot } from '../src/public/extensions'
import { setHighlightRegistry } from '../src/public/testing'

const highlightsMap = new Map<string, Highlight>()
const mockRegistry = {
  set: (name: string, highlight: Highlight) => {
    highlightsMap.set(name, highlight)
  },
  delete: (name: string) => highlightsMap.delete(name),
}

class MockHighlight extends Set<Range> {}

// Stands in for the FontFaceSet happy-dom does not implement: the editor reads document.fonts and
// listens for the load that invalidates its first reading.
class FakeFontFaceSet extends EventTarget {
  status: 'loading' | 'loaded' = 'loading'
  readonly ready: Promise<FakeFontFaceSet>
  listenerCount = 0
  private resolveReady!: (value: FakeFontFaceSet) => void

  constructor() {
    super()
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve
    })
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    this.listenerCount += 1
    super.addEventListener(type, listener)
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    this.listenerCount -= 1
    super.removeEventListener(type, listener)
  }

  finishLoading(): void {
    this.status = 'loaded'
    this.dispatchEvent(new Event('loadingdone'))
  }

  // Reaching 'loaded' without the announcement is the case the editor cannot see coming, and the
  // one where a stale reading would otherwise outlive the session.
  settleQuietly(): void {
    this.status = 'loaded'
    this.resolveReady(this)
  }
}

const PROBE_CLASS = 'editor-virtualized-metric-probe'
const ROW_HEIGHT = 24

let advanceOf: (character: string) => number
let probeHeight = ROW_HEIGHT
let onProbeRect: (() => void) | null = null
let originalGetBoundingClientRect: () => DOMRect
let fonts: FakeFontFaceSet
let container: HTMLElement
let editor: Editor | null = null
let snapshots: EditorViewSnapshot[] = []

function probeRect(width: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height: probeHeight,
    top: 0,
    right: width,
    bottom: probeHeight,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect
}

function stubProbeMeasurement(): void {
  originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
    if (!this.classList.contains(PROBE_CLASS)) return originalGetBoundingClientRect.call(this)

    onProbeRect?.()
    const text = this.textContent ?? ''
    let width = 0
    for (const character of text) width += advanceOf(character)
    return probeRect(width)
  }
}

/**
 * A box read is answered out of the layout the browser is currently holding, and every node put
 * into or taken out of the tree throws that layout away — so reads that follow one another with
 * nothing touching the tree in between are all served by a single one.
 */
function countLayoutsDuring(measure: () => void): number {
  const originalAppendChild = Node.prototype.appendChild
  const originalRemove = Element.prototype.remove
  let layouts = 0
  let stale = true

  Node.prototype.appendChild = function appendChild<T extends Node>(this: Node, node: T): T {
    stale = true
    return originalAppendChild.call(this, node) as T
  }
  Element.prototype.remove = function remove(this: Element): void {
    stale = true
    originalRemove.call(this)
  }
  onProbeRect = () => {
    if (stale) layouts += 1
    stale = false
  }

  try {
    measure()
  } finally {
    Node.prototype.appendChild = originalAppendChild
    Element.prototype.remove = originalRemove
    onProbeRect = null
  }

  return layouts
}

function createSnapshotPlugin(): EditorPlugin {
  return {
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          update: (snapshot) => {
            snapshots.push(snapshot)
          },
          dispose: () => {},
        }),
      }),
  }
}

function createUpdateHookPlugin(onUpdate: () => void): EditorPlugin {
  return {
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          update: () => onUpdate(),
          dispose: () => {},
        }),
      }),
  }
}

function mountEditor(): Editor {
  editor = new Editor(container, {
    defaultText: 'mmmmmmmmmm',
    plugins: [createSnapshotPlugin()],
  })
  return editor
}

function editorRootIn(host: HTMLElement): HTMLElement {
  return host.querySelector('.editor-virtualized') as HTMLElement
}

function measuredRowHeight(root: HTMLElement): string {
  return root.style.getPropertyValue('--editor-row-height')
}

describe('browser text metrics', () => {
  beforeEach(() => {
    highlightsMap.clear()
    // @ts-expect-error — polyfilling Highlight constructor for tests
    globalThis.Highlight = MockHighlight
    setHighlightRegistry(mockRegistry)
    snapshots = []
    advanceOf = () => 8
    probeHeight = ROW_HEIGHT
    stubProbeMeasurement()
    fonts = new FakeFontFaceSet()
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
    clearBrowserTextMetricsCache()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    editor?.dispose()
    editor = null
    container.remove()
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
    Reflect.deleteProperty(document, 'fonts')
    clearBrowserTextMetricsCache()
    setHighlightRegistry(undefined)
  })

  it('re-measures a mounted editor when a font finishes loading', () => {
    mountEditor()
    const before = snapshots.at(-1)

    advanceOf = () => 12
    fonts.finishLoading()
    const after = snapshots.at(-1)

    expect(before?.metrics.characterWidth).toBe(8)
    expect(after?.metrics.characterWidth).toBe(12)
    expect(after?.contentWidth).toBeGreaterThan(before?.contentWidth ?? 0)
  })

  it('re-measures a mounted editor when a pending font settles unannounced', async () => {
    mountEditor()
    const before = snapshots.at(-1)

    advanceOf = () => 12
    fonts.settleQuietly()
    await fonts.ready

    expect(before?.metrics.characterWidth).toBe(8)
    expect(snapshots.at(-1)?.metrics.characterWidth).toBe(12)
  })

  it('releases the font subscription with the last editor on the window', () => {
    mountEditor()
    const mountedListeners = fonts.listenerCount

    editor?.dispose()
    advanceOf = () => 12
    fonts.finishLoading()

    expect(mountedListeners).toBe(1)
    expect(fonts.listenerCount).toBe(0)
    expect(snapshots.at(-1)?.metrics.characterWidth).toBe(8)
  })

  it('leaves the cache standing when a font settles after the last editor is gone', async () => {
    mountEditor()
    editor?.dispose()
    measureBrowserTextMetrics(container)

    fonts.settleQuietly()
    await fonts.ready

    // The cache is shared by every document, so a reading dropped here is paid for by editors that
    // have nothing to do with the window this promise came from.
    expect(countLayoutsDuring(() => measureBrowserTextMetrics(container))).toBe(0)
  })

  it('stops at the editor an earlier listener tore down', () => {
    let disposeSecond: (() => void) | null = null
    editor = new Editor(container, {
      defaultText: 'mmmmmmmmmm',
      plugins: [createUpdateHookPlugin(() => disposeSecond?.())],
    })
    const secondHost = document.createElement('div')
    document.body.appendChild(secondHost)
    const second = new Editor(secondHost, { defaultText: 'mmmmmmmmmm' })
    const secondRoot = editorRootIn(secondHost)
    disposeSecond = () => second.dispose()

    probeHeight = 30
    fonts.finishLoading()
    secondHost.remove()

    expect(measuredRowHeight(editorRootIn(container))).toBe('30px')
    expect(measuredRowHeight(secondRoot)).toBe(`${ROW_HEIGHT}px`)
  })

  it('re-measures when the display pixel ratio changes', () => {
    const first = measureBrowserTextMetrics(container)

    advanceOf = () => 12
    const cached = measureBrowserTextMetrics(container)
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    const rescaled = measureBrowserTextMetrics(container)
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })

    expect(first.characterWidth).toBe(8)
    expect(cached.characterWidth).toBe(8)
    expect(rescaled.characterWidth).toBe(12)
  })

  it('re-arms the resolution query against the ratio it moved to', () => {
    const queries: MediaQueryList[] = []
    const originalMatchMedia = window.matchMedia.bind(window)
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
      const list = originalMatchMedia(query)
      queries.push(list)
      return list
    })
    mountEditor()

    advanceOf = () => 12
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 })
    queries[0]?.dispatchEvent(new Event('change'))
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
    matchMedia.mockRestore()

    expect(queries.map((query) => query.media)).toEqual([
      '(resolution: 1dppx)',
      '(resolution: 3dppx)',
    ])
    expect(snapshots.at(-1)?.metrics.characterWidth).toBe(12)
  })

  it('reads every probe out of one layout', () => {
    const layouts = countLayoutsDuring(() => measureBrowserTextMetrics(container))

    expect(layouts).toBe(1)
  })

  it('picks the whitespace dot whose advance matches the space', () => {
    advanceOf = (character) => (character === '·' ? 5 : 8)
    expect(measureWhitespaceDotGlyph(container)).toBe('⸱')

    clearBrowserTextMetricsCache()
    advanceOf = (character) => (character === '⸱' ? 5 : 8)

    expect(measureWhitespaceDotGlyph(container)).toBe('·')
  })
})
