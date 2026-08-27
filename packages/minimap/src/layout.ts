import { Constants } from './minimapCharSheet'
import type {
  MinimapMetrics,
  MinimapRenderLayout,
  MinimapViewport,
  ResolvedMinimapOptions,
} from './types'
import { RenderMinimap } from './types'

export const MINIMAP_GUTTER_WIDTH = 2
export const MINIMAP_RIGHT_GUTTER_WIDTH = 8

export type MinimapFrameLayout = {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly sliderNeeded: boolean
  readonly computedSliderRatio: number
  readonly sliderTop: number
  readonly sliderHeight: number
  readonly topPaddingLineCount: number
  readonly startLineNumber: number
  readonly endLineNumber: number
}

export function computeRenderLayout(options: {
  readonly minimap: ResolvedMinimapOptions
  readonly metrics: MinimapMetrics
  readonly viewport: MinimapViewport
  readonly lineCount: number
}): MinimapRenderLayout {
  const pixelRatio = Math.max(1, options.metrics.devicePixelRatio)
  const height = Math.max(0, options.viewport.clientHeight)
  const baseCharHeight = options.minimap.renderCharacters
    ? Constants.BASE_CHAR_HEIGHT
    : Constants.BASE_CHAR_HEIGHT + 1
  const configuredScale =
    pixelRatio >= 2 ? Math.round(options.minimap.scale * 2) : options.minimap.scale
  const baseCanvasInnerHeight = Math.floor(pixelRatio * height)
  const fitted = computeFittedScale({
    baseCharHeight,
    canvasInnerHeight: baseCanvasInnerHeight,
    configuredScale,
    height,
    lineCount: options.lineCount,
    minimap: options.minimap,
    pixelRatio,
    rowHeight: options.metrics.rowHeight,
  })
  const layoutCharWidth = fitted.scale / pixelRatio / fitted.widthMultiplier
  const width = computeMinimapWidth({
    charWidth: layoutCharWidth,
    maxColumn: options.minimap.maxColumn,
    viewportWidth: options.viewport.clientWidth + Math.max(0, options.viewport.reservedWidth),
    characterWidth: options.metrics.characterWidth,
  })
  const baseCanvasInnerWidth = Math.floor(pixelRatio * width)
  const canvasInnerWidth = Math.floor(baseCanvasInnerWidth * fitted.widthMultiplier)
  const canvasInnerHeight = fitted.heightIsEditorHeight
    ? Math.ceil(Math.max(baseCanvasInnerHeight, fitted.documentMinimapHeight))
    : baseCanvasInnerHeight

  return {
    width,
    height,
    canvasInnerWidth,
    canvasInnerHeight,
    canvasOuterWidth: baseCanvasInnerWidth / pixelRatio,
    canvasOuterHeight: baseCanvasInnerHeight / pixelRatio,
    lineHeight: fitted.lineHeight,
    charWidth: Constants.BASE_CHAR_WIDTH * fitted.scale,
    scale: fitted.scale,
    isSampling: fitted.isSampling,
    heightIsEditorHeight: fitted.heightIsEditorHeight,
    renderMinimap: options.minimap.enabled
      ? options.minimap.renderCharacters
        ? RenderMinimap.Text
        : RenderMinimap.Blocks
      : RenderMinimap.None,
  }
}

export function computeFrameLayout(options: {
  readonly renderLayout: MinimapRenderLayout
  readonly metrics: MinimapMetrics
  readonly viewport: MinimapViewport
  readonly lineCount: number
  readonly realLineCount: number
  readonly previous: MinimapFrameLayout | null
}): MinimapFrameLayout {
  if (options.renderLayout.heightIsEditorHeight) return containedFrameLayout(options)
  return proportionalFrameLayout(options)
}

export function yForLineNumber(
  frame: Pick<MinimapFrameLayout, 'startLineNumber' | 'topPaddingLineCount'>,
  lineNumber: number,
  minimapLineHeight: number,
): number {
  return (lineNumber - frame.startLineNumber + frame.topPaddingLineCount) * minimapLineHeight
}

// How many document lines the viewport actually shows. Both slider heights need this,
// and both used to divide the viewport's pixels by the *minimap's* line height instead
// of the editor's row height — so the slider grew to the size of the whole minimap.
function visibleLineCount(viewport: MinimapViewport, metrics: MinimapMetrics): number {
  return viewport.clientHeight / Math.max(1, metrics.rowHeight)
}

function computeFittedScale(options: {
  readonly minimap: ResolvedMinimapOptions
  readonly baseCharHeight: number
  readonly canvasInnerHeight: number
  readonly configuredScale: number
  readonly height: number
  readonly pixelRatio: number
  readonly rowHeight: number
  readonly lineCount: number
}): {
  readonly scale: number
  readonly lineHeight: number
  readonly widthMultiplier: number
  readonly isSampling: boolean
  readonly heightIsEditorHeight: boolean
  readonly documentMinimapHeight: number
} {
  const lineHeight = options.baseCharHeight * options.configuredScale
  if (options.minimap.size === 'proportional') {
    return fittedScale(options.configuredScale, lineHeight, 1, false, false, 0)
  }

  const desiredRatio = options.lineCount / Math.max(1, options.canvasInnerHeight)
  if (desiredRatio > 1) return fittedScale(1, 1, 1, true, true, options.canvasInnerHeight)

  if (options.minimap.size === 'fit') {
    const documentHeight = Math.ceil(options.lineCount * lineHeight)
    if (documentHeight <= options.canvasInnerHeight) {
      return fittedScale(options.configuredScale, lineHeight, 1, false, false, documentHeight)
    }
  }

  const maxScale = options.configuredScale + 1
  const fillLineHeight = Math.min(
    options.rowHeight * options.pixelRatio,
    Math.max(1, Math.floor(1 / desiredRatio)),
  )
  const scale = Math.min(maxScale, Math.max(1, Math.floor(fillLineHeight / options.baseCharHeight)))
  const widthMultiplier =
    scale > options.configuredScale ? Math.min(2, scale / options.configuredScale) : 1
  const typicalViewportLineCount = options.height / Math.max(1, options.rowHeight)
  return fittedScale(
    scale,
    fillLineHeight,
    widthMultiplier,
    false,
    true,
    Math.ceil(Math.max(typicalViewportLineCount, options.lineCount) * fillLineHeight),
  )
}

function fittedScale(
  scale: number,
  lineHeight: number,
  widthMultiplier: number,
  isSampling: boolean,
  heightIsEditorHeight: boolean,
  documentMinimapHeight: number,
) {
  return {
    scale,
    lineHeight,
    widthMultiplier,
    isSampling,
    heightIsEditorHeight,
    documentMinimapHeight,
  }
}

function computeMinimapWidth(options: {
  readonly charWidth: number
  readonly maxColumn: number
  readonly viewportWidth: number
  readonly characterWidth: number
}): number {
  const availableWidth = Math.max(0, options.viewportWidth)
  const minimapMaxWidth = Math.floor(options.maxColumn * options.charWidth)
  const proportionalWidth = Math.floor(
    ((availableWidth - 2) * options.charWidth) / (options.characterWidth + options.charWidth),
  )
  return Math.min(
    minimapMaxWidth,
    Math.max(0, proportionalWidth) + MINIMAP_GUTTER_WIDTH + MINIMAP_RIGHT_GUTTER_WIDTH,
  )
}

function containedFrameLayout(options: {
  readonly renderLayout: MinimapRenderLayout
  readonly metrics: MinimapMetrics
  readonly viewport: MinimapViewport
  readonly lineCount: number
  readonly realLineCount: number
}): MinimapFrameLayout {
  const sliderHeight = Math.max(
    1,
    Math.floor(
      (visibleLineCount(options.viewport, options.metrics) / Math.max(1, options.realLineCount)) *
        options.renderLayout.height,
    ),
  )
  const maxSliderTop = Math.max(0, options.renderLayout.height - sliderHeight)
  const ratio =
    maxSliderTop / Math.max(1, options.viewport.scrollHeight - options.viewport.clientHeight)
  const maxLinesFitting = Math.floor(
    options.renderLayout.canvasInnerHeight / options.renderLayout.lineHeight,
  )

  return {
    scrollTop: options.viewport.scrollTop,
    scrollHeight: options.viewport.scrollHeight,
    sliderNeeded: maxSliderTop > 0,
    computedSliderRatio: ratio,
    sliderTop: options.viewport.scrollTop * ratio,
    sliderHeight,
    topPaddingLineCount: 0,
    startLineNumber: 1,
    endLineNumber: Math.min(options.lineCount, maxLinesFitting),
  }
}

function proportionalFrameLayout(options: {
  readonly renderLayout: MinimapRenderLayout
  readonly metrics: MinimapMetrics
  readonly viewport: MinimapViewport
  readonly lineCount: number
  readonly previous: MinimapFrameLayout | null
}): MinimapFrameLayout {
  const lineHeight = options.renderLayout.lineHeight
  const pixelRatio =
    options.renderLayout.canvasInnerHeight / Math.max(1, options.renderLayout.canvasOuterHeight)
  const minimapLinesFitting = Math.floor(options.renderLayout.canvasInnerHeight / lineHeight)
  const sliderHeight = Math.max(
    1,
    Math.floor((visibleLineCount(options.viewport, options.metrics) * lineHeight) / pixelRatio),
  )
  const maxSliderTop = Math.max(0, options.renderLayout.height - sliderHeight)
  const ratio =
    maxSliderTop / Math.max(1, options.viewport.scrollHeight - options.viewport.clientHeight)
  const sliderTop = options.viewport.scrollTop * ratio

  if (minimapLinesFitting >= options.lineCount) {
    return frame(
      options.viewport,
      maxSliderTop > 0,
      ratio,
      sliderTop,
      sliderHeight,
      0,
      1,
      options.lineCount,
    )
  }

  const startLineNumber = proportionalStartLine(options, sliderTop, pixelRatio)
  const endLineNumber = Math.min(options.lineCount, startLineNumber + minimapLinesFitting - 1)
  return frame(
    options.viewport,
    true,
    ratio,
    sliderTop,
    sliderHeight,
    0,
    startLineNumber,
    endLineNumber,
  )
}

function proportionalStartLine(
  options: {
    readonly renderLayout: MinimapRenderLayout
    readonly viewport: MinimapViewport
    readonly previous: MinimapFrameLayout | null
  },
  sliderTop: number,
  pixelRatio: number,
): number {
  const visibleStart = Math.max(1, options.viewport.visibleStart + 1)
  const raw = Math.max(
    1,
    Math.floor(visibleStart - (sliderTop * pixelRatio) / options.renderLayout.lineHeight),
  )
  const previous = options.previous
  if (!previous || previous.scrollHeight !== options.viewport.scrollHeight) return raw
  if (previous.scrollTop > options.viewport.scrollTop)
    return Math.min(raw, previous.startLineNumber)
  if (previous.scrollTop < options.viewport.scrollTop)
    return Math.max(raw, previous.startLineNumber)
  return raw
}

function frame(
  viewport: MinimapViewport,
  sliderNeeded: boolean,
  ratio: number,
  sliderTop: number,
  sliderHeight: number,
  topPaddingLineCount: number,
  startLineNumber: number,
  endLineNumber: number,
): MinimapFrameLayout {
  return {
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
    sliderNeeded,
    computedSliderRatio: ratio,
    sliderTop,
    sliderHeight,
    topPaddingLineCount,
    startLineNumber,
    endLineNumber,
  }
}
