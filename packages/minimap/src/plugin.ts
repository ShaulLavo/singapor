import type { DocumentSessionChange } from '@singapor/core/document'
import type {
  EditorDisposable,
  EditorCapabilityContribution,
  EditorCapabilityContributionContext,
  EditorMinimapDecoration,
  EditorMinimapFeature,
  EditorPlugin,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import { EDITOR_MINIMAP_FEATURE } from '@singapor/core/extensions'
import { resolveMinimapOptions } from './options'
import type { EditorMinimapOptions, ResolvedMinimapOptions } from './types'
import { canUseMinimapWorker, MinimapWorkerClient, type MinimapHost } from './workerClient'

const THIN_SCROLLBAR_GUTTER_FALLBACK = 7
const WEBKIT_SCROLLBAR_PSEUDO_ELEMENT = '::-webkit-scrollbar'

export function createMinimapPlugin(options: EditorMinimapOptions = {}): EditorPlugin {
  const resolved = resolveMinimapOptions(options)
  const decorations = new MinimapDecorationRegistry()

  return {
    name: 'minimap',
    activate(context) {
      return [
        context.registerCapabilityContribution({
          createContribution: (contributionContext) =>
            createMinimapFeatureContribution(contributionContext, decorations),
        }),
        context.registerViewContribution({
          createContribution: (contributionContext) =>
            createMinimapContribution(contributionContext, resolved, decorations),
        }),
      ]
    },
  }
}

function createMinimapFeatureContribution(
  context: EditorCapabilityContributionContext,
  decorations: MinimapDecorationRegistry,
): EditorCapabilityContribution {
  const registration = context.registerFeature(EDITOR_MINIMAP_FEATURE, decorations)

  return {
    dispose: () => registration.dispose(),
  }
}

function createMinimapContribution(
  context: EditorViewContributionContext,
  options: ResolvedMinimapOptions,
  decorations: MinimapDecorationRegistry,
): EditorViewContribution | null {
  if (!options.enabled) return null
  if (!canUseMinimapWorker()) return null

  return new MinimapContribution(context, options, decorations)
}

class MinimapContribution implements EditorViewContribution {
  private readonly context: EditorViewContributionContext
  private readonly options: ResolvedMinimapOptions
  private readonly host: MinimapHost
  private readonly client: MinimapWorkerClient
  private readonly decorationSubscription: EditorDisposable
  private latestSnapshot: EditorViewSnapshot
  private activeSliderDrag: SliderDrag | null = null
  private reservedWidth = 0
  private appliedReservedWidth = 0
  private verticalScrollbarWidth = -1
  private horizontalScrollbarHeight = -1
  private scrollbarGutterSignature = ''
  private readonly scrollElementBorderMetrics: ScrollElementBorderMetrics
  private readonly scrollbarGutterFallback: ScrollbarGutterFallbackMetrics
  private pendingSliderScrollTop: number | null = null
  private sliderScrollFrame = 0
  private disposed = false

  public constructor(
    context: EditorViewContributionContext,
    options: ResolvedMinimapOptions,
    private readonly decorations: MinimapDecorationRegistry,
  ) {
    this.context = context
    this.options = options
    this.latestSnapshot = context.getSnapshot()
    this.host = createHost(context, options)
    this.scrollElementBorderMetrics = readScrollElementBorderMetrics(context.scrollElement)
    this.scrollbarGutterFallback = measureScrollbarGutterFallback(context.scrollElement)
    this.updateNativeScrollbarGutter()
    this.client = new MinimapWorkerClient({
      host: this.host,
      options,
      snapshot: this.latestSnapshot,
      decorations: decorations.getDecorations(),
      onLayoutWidth: this.reserveWidth,
    })
    this.decorationSubscription = decorations.subscribe(this.handleDecorationsChanged)
    this.installPointerHandlers()
    this.client.update(this.latestSnapshot, 'document')
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void {
    if (this.disposed) return

    this.latestSnapshot = snapshot
    this.updateNativeScrollbarGutter()
    this.client.update(snapshot, kind, change)
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.stopSliderDrag()
    this.decorationSubscription.dispose()
    this.client.dispose()
    this.context.reserveOverlayWidth(this.options.side, 0)
    this.host.root.remove()
  }

  private installPointerHandlers(): void {
    this.host.root.addEventListener('pointerdown', this.handlePointerDown)
    this.host.slider.addEventListener('pointerdown', this.handleSliderPointerDown)
  }

  private readonly reserveWidth = (width: number): void => {
    const nextWidth = Math.ceil(width)
    if (nextWidth === this.reservedWidth) return

    this.reservedWidth = nextWidth
    this.updateNativeScrollbarGutter()
    this.reserveEditorOverlayWidth()
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    if (event.target === this.host.slider || this.host.slider.contains(event.target as Node)) return

    event.preventDefault()
    const row = this.rowFromPointer(event)
    this.context.revealLine(row)
  }

  private readonly handleSliderPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return

    event.preventDefault()
    this.stopSliderDrag()
    const startY = event.clientY
    const startScrollTop = this.latestSnapshot.viewport.scrollTop
    const sliderHeight = Math.max(1, this.host.slider.getBoundingClientRect().height)
    const scrollable = Math.max(
      1,
      this.latestSnapshot.viewport.scrollHeight - this.latestSnapshot.viewport.clientHeight,
    )
    const trackHeight = Math.max(1, this.host.root.clientHeight - sliderHeight)
    const ratio = scrollable / trackHeight

    const onMove = (move: PointerEvent): void => {
      const scrollTop = clamp(startScrollTop + (move.clientY - startY) * ratio, 0, scrollable)
      this.client.previewScrollTop(this.latestSnapshot, scrollTop)
      this.scheduleSliderScroll(scrollTop)
    }
    const onEnd = (): void => this.stopSliderDrag()

    this.captureSliderPointer(event.pointerId)
    this.host.slider.classList.add('active')
    this.activeSliderDrag = { pointerId: event.pointerId, onMove, onEnd }
    this.host.slider.ownerDocument.addEventListener('pointermove', onMove)
    this.host.slider.ownerDocument.addEventListener('pointerup', onEnd, { once: true })
    this.host.slider.ownerDocument.addEventListener('pointercancel', onEnd, { once: true })
    this.host.slider.addEventListener('lostpointercapture', onEnd, { once: true })
  }

  private captureSliderPointer(pointerId: number): void {
    try {
      this.host.slider.setPointerCapture(pointerId)
    } catch {
      return
    }
  }

  private stopSliderDrag(): void {
    const drag = this.activeSliderDrag
    if (!drag) return

    this.activeSliderDrag = null
    this.cancelSliderScroll()
    this.flushSliderScroll()
    this.host.slider.ownerDocument.removeEventListener('pointermove', drag.onMove)
    this.host.slider.ownerDocument.removeEventListener('pointerup', drag.onEnd)
    this.host.slider.ownerDocument.removeEventListener('pointercancel', drag.onEnd)
    this.host.slider.removeEventListener('lostpointercapture', drag.onEnd)
    this.releaseSliderPointer(drag.pointerId)
    this.host.slider.classList.remove('active')
  }

  private scheduleSliderScroll(scrollTop: number): void {
    this.pendingSliderScrollTop = scrollTop
    if (this.sliderScrollFrame !== 0) return

    this.sliderScrollFrame = requestFrame(() => {
      this.sliderScrollFrame = 0
      this.flushSliderScroll()
    })
  }

  private flushSliderScroll(): void {
    const scrollTop = this.pendingSliderScrollTop
    this.pendingSliderScrollTop = null
    if (scrollTop === null) return

    setScrollTop(this.context.scrollElement, scrollTop)
  }

  private cancelSliderScroll(): void {
    if (this.sliderScrollFrame === 0) return

    cancelFrame(this.sliderScrollFrame)
    this.sliderScrollFrame = 0
  }

  private releaseSliderPointer(pointerId: number): void {
    if (!this.host.slider.hasPointerCapture(pointerId)) return

    try {
      this.host.slider.releasePointerCapture(pointerId)
    } catch {
      return
    }
  }

  private rowFromPointer(event: PointerEvent): number {
    const rect = this.host.root.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)))
    return Math.floor(ratio * Math.max(1, this.latestSnapshot.lineCount))
  }

  private updateNativeScrollbarGutter(): void {
    const signature = nativeScrollbarGutterSignature(this.latestSnapshot, this.reservedWidth)
    if (signature === this.scrollbarGutterSignature) return

    this.scrollbarGutterSignature = signature
    const gutter = nativeScrollbarGutter(
      this.latestSnapshot,
      this.reservedWidth,
      this.scrollElementBorderMetrics,
      this.scrollbarGutterFallback,
    )
    if (
      gutter.vertical === this.verticalScrollbarWidth &&
      gutter.horizontal === this.horizontalScrollbarHeight
    ) {
      return
    }

    this.verticalScrollbarWidth = gutter.vertical
    this.horizontalScrollbarHeight = gutter.horizontal
    this.host.root.style.bottom = `${gutter.horizontal}px`
    this.reserveEditorOverlayWidth()
    if (this.options.side === 'right') {
      this.host.root.style.right = `${gutter.vertical}px`
      this.host.root.style.left = ''
      return
    }

    this.host.root.style.left = '0'
    this.host.root.style.right = ''
  }

  private reserveEditorOverlayWidth(): void {
    const scrollbarWidth =
      this.options.side === 'right' ? Math.max(0, this.verticalScrollbarWidth) : 0
    const nextWidth = this.reservedWidth + scrollbarWidth
    if (nextWidth === this.appliedReservedWidth) return

    this.appliedReservedWidth = nextWidth
    this.context.reserveOverlayWidth(this.options.side, nextWidth)
  }

  private readonly handleDecorationsChanged = (): void => {
    this.client.setExternalDecorations(this.latestSnapshot, this.decorations.getDecorations())
  }
}

class MinimapDecorationRegistry implements EditorMinimapFeature {
  private readonly decorationsBySource = new Map<string, readonly EditorMinimapDecoration[]>()
  private readonly listeners = new Set<() => void>()

  public setDecorations(sourceId: string, decorations: readonly EditorMinimapDecoration[]): void {
    this.decorationsBySource.set(sourceId, decorations)
    this.notify()
  }

  public clearDecorations(sourceId: string): void {
    if (!this.decorationsBySource.delete(sourceId)) return

    this.notify()
  }

  public getDecorations(): readonly EditorMinimapDecoration[] {
    return Array.from(this.decorationsBySource.values()).flat()
  }

  public subscribe(listener: () => void): EditorDisposable {
    this.listeners.add(listener)
    return {
      dispose: () => this.listeners.delete(listener),
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

type SliderDrag = {
  readonly pointerId: number
  readonly onMove: (event: PointerEvent) => void
  readonly onEnd: () => void
}

type ScrollElementBorderMetrics = {
  readonly x: number
  readonly y: number
}

type ScrollbarGutterFallbackMetrics = {
  readonly vertical: number
  readonly horizontal: number
}

function createHost(
  context: EditorViewContributionContext,
  options: ResolvedMinimapOptions,
): MinimapHost {
  const document = context.container.ownerDocument
  const root = document.createElement('div')
  const shadow = document.createElement('div')
  const mainCanvas = document.createElement('canvas')
  const decorationsCanvas = document.createElement('canvas')
  const slider = document.createElement('div')
  const sliderHorizontal = document.createElement('div')

  root.className = hostClassName(options)
  shadow.className = 'editor-minimap-shadow editor-minimap-shadow-hidden'
  mainCanvas.className = 'editor-minimap-canvas'
  decorationsCanvas.className = 'editor-minimap-canvas editor-minimap-decorations'
  slider.className = 'editor-minimap-slider'
  sliderHorizontal.className = 'editor-minimap-slider-horizontal'
  slider.appendChild(sliderHorizontal)
  root.append(shadow, mainCanvas, decorationsCanvas, slider)
  if (getComputedStyle(context.container).position === 'static') {
    context.container.style.position = 'relative'
  }
  context.container.appendChild(root)

  return {
    root,
    colorScope: context.scrollElement,
    shadow,
    mainCanvas,
    decorationsCanvas,
    slider,
    sliderHorizontal,
  }
}

function hostClassName(options: ResolvedMinimapOptions): string {
  const classes = ['editor-minimap', `editor-minimap-${options.side}`]
  if (options.showSlider === 'always') classes.push('slider-always')
  if (options.showSlider === 'mouseover') classes.push('slider-mouseover')
  if (options.autohide !== 'none') classes.push(`editor-minimap-autohide-${options.autohide}`)
  return classes.join(' ')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function setScrollTop(element: HTMLElement, scrollTop: number): void {
  if (element.scrollTop === scrollTop) return

  element.scrollTop = scrollTop
}

function requestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
  return setTimeout(callback, 16) as unknown as number
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle)
    return
  }

  clearTimeout(handle)
}

function nativeScrollbarGutter(
  snapshot: EditorViewSnapshot,
  reservedOverlayWidth: number,
  border: ScrollElementBorderMetrics,
  fallback: ScrollbarGutterFallbackMetrics,
): {
  readonly vertical: number
  readonly horizontal: number
} {
  const viewport = snapshot.viewport
  const hasVerticalScrollbar =
    viewport.clientHeight > 0 &&
    Math.max(viewport.scrollHeight, snapshot.totalHeight) > viewport.clientHeight
  const hasHorizontalScrollbar =
    viewport.clientWidth > 0 && viewport.scrollWidth > viewport.clientWidth
  const vertical = hasVerticalScrollbar
    ? scrollbarGutterOrFallback(
        measuredVerticalScrollbarGutter(viewport, border.x, reservedOverlayWidth),
        fallback.vertical,
      )
    : 0
  const horizontal = hasHorizontalScrollbar
    ? scrollbarGutterOrFallback(
        measuredHorizontalScrollbarGutter(viewport, border.y),
        fallback.horizontal,
      )
    : 0

  return { vertical, horizontal }
}

function scrollbarGutterOrFallback(measured: number, fallback: number): number {
  if (measured > 0) return measured
  return fallback
}

function nativeScrollbarGutterSignature(
  snapshot: EditorViewSnapshot,
  reservedOverlayWidth: number,
): string {
  const viewport = snapshot.viewport
  return [
    viewport.clientHeight,
    viewport.clientWidth,
    viewport.scrollHeight,
    viewport.scrollWidth,
    viewport.borderBoxHeight ?? '',
    viewport.borderBoxWidth ?? '',
    snapshot.totalHeight,
    reservedOverlayWidth,
  ].join(':')
}

function measuredVerticalScrollbarGutter(
  viewport: EditorViewSnapshot['viewport'],
  borderWidth: number,
  reservedOverlayWidth: number,
): number {
  if (viewport.clientWidth <= 0) return 0

  const clientWidth = viewport.clientWidth + Math.max(0, reservedOverlayWidth)
  const borderBoxWidth = viewport.borderBoxWidth ?? clientWidth + borderWidth
  return Math.max(0, borderBoxWidth - clientWidth - borderWidth)
}

function measuredHorizontalScrollbarGutter(
  viewport: EditorViewSnapshot['viewport'],
  borderWidth: number,
): number {
  if (viewport.clientHeight <= 0) return 0

  const borderBoxHeight = viewport.borderBoxHeight ?? viewport.clientHeight + borderWidth
  return Math.max(0, borderBoxHeight - viewport.clientHeight - borderWidth)
}

function readScrollElementBorderMetrics(element: HTMLElement): ScrollElementBorderMetrics {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return {
    x: cssPixels(style?.borderLeftWidth) + cssPixels(style?.borderRightWidth),
    y: cssPixels(style?.borderTopWidth) + cssPixels(style?.borderBottomWidth),
  }
}

function measureScrollbarGutterFallback(element: HTMLElement): ScrollbarGutterFallbackMetrics {
  const cssDimensions = readScrollbarCssDimensions(element)
  const keywordWidth = readScrollbarWidthKeyword(element)
  const nativeDimensions = measureNativeScrollbarGutter(element.ownerDocument)

  return {
    vertical: cssDimensions.vertical ?? keywordWidth ?? nativeDimensions.vertical,
    horizontal: cssDimensions.horizontal ?? keywordWidth ?? nativeDimensions.horizontal,
  }
}

function measureNativeScrollbarGutter(document: Document): ScrollbarGutterFallbackMetrics {
  const container = document.body ?? document.documentElement
  if (!container) return { vertical: 0, horizontal: 0 }

  const probe = document.createElement('div')
  probe.style.height = '100px'
  probe.style.left = '-10000px'
  probe.style.overflow = 'scroll'
  probe.style.position = 'absolute'
  probe.style.top = '-10000px'
  probe.style.visibility = 'hidden'
  probe.style.width = '100px'
  container.appendChild(probe)

  const vertical = Math.max(0, probe.offsetWidth - probe.clientWidth)
  const horizontal = Math.max(0, probe.offsetHeight - probe.clientHeight)
  probe.remove()

  return { vertical, horizontal }
}

function readScrollbarCssDimensions(element: HTMLElement): {
  readonly vertical: number | null
  readonly horizontal: number | null
} {
  const style = readComputedStyle(element, WEBKIT_SCROLLBAR_PSEUDO_ELEMENT)
  return {
    vertical: positiveCssPixels(style?.width),
    horizontal: positiveCssPixels(style?.height),
  }
}

function readScrollbarWidthKeyword(element: HTMLElement): number | null {
  const value = readComputedStyle(element)?.getPropertyValue('scrollbar-width').trim()
  if (value === 'none') return 0
  if (value === 'thin') return THIN_SCROLLBAR_GUTTER_FALLBACK
  return null
}

function readComputedStyle(
  element: HTMLElement,
  pseudoElement?: string,
): CSSStyleDeclaration | undefined {
  try {
    return element.ownerDocument.defaultView?.getComputedStyle(element, pseudoElement)
  } catch {
    return undefined
  }
}

function positiveCssPixels(value: string | undefined): number | null {
  const parsed = cssPixels(value)
  if (parsed <= 0) return null
  return parsed
}

function cssPixels(value: string | undefined): number {
  if (!value) return 0

  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return 0
  return parsed
}
