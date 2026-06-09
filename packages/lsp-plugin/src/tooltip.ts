import type { EditorTheme } from '@singapor/core/rendering'
import type * as lsp from 'vscode-languageserver-protocol'

import { renderTooltipMarkdown } from './markdownTooltip'

/**
 * Delay, in milliseconds, between the pointer settling on a token and the
 * Language Server `textDocument/hover` request being dispatched (which in turn
 * drives when the tooltip appears). Chosen to debounce rapid pointer sweeps
 * so the user does not trigger a hover round-trip for every token the cursor
 * passes through, while staying short enough that an intentional hover still
 * feels immediate. 250 ms matches the VS Code hover-provider default, which
 * users are already calibrated to.
 */
export const HOVER_REQUEST_DEBOUNCE_MS = 250

/**
 * Grace period, in milliseconds, before the hover tooltip is hidden after
 * the pointer leaves the trigger token or the tooltip body. Long enough to
 * bridge quick pointer transits between the token and the tooltip (so the
 * user can reach into the tooltip to click a link or copy text without the
 * tooltip flickering away), short enough that the tooltip does not linger
 * once the user has clearly moved on. Paired with the pointer-reentry logic
 * in `scheduleHide` / `cancelHide`.
 */
export const TOOLTIP_HIDE_DELAY_MS = 180

/**
 * Duration, in milliseconds, that the tooltip's copy-to-clipboard button
 * retains its "copied" or "failed" confirmation state before reverting to
 * the idle icon. Long enough for the user to register the feedback (roughly
 * one second of perception plus a small buffer), short enough that the
 * state never persists across into a subsequent hover on another token.
 */
export const COPY_BUTTON_RESET_DELAY_MS = 1200

const TOOLTIP_GAP_PX = 8
const TOOLTIP_VIEWPORT_MARGIN_PX = 12
const TOOLTIP_MAX_HEIGHT_PX = 420
const TOOLTIP_MIN_MAX_HEIGHT_PX = 80
const TOOLTIP_BODY_CHROME_PX = 46
const SVG_NS = 'http://www.w3.org/2000/svg'
const TOOLTIP_THEME_VARIABLES = [
  '--editor-background',
  '--editor-foreground',
  '--editor-caret-color',
  '--editor-syntax-bracket',
  '--editor-syntax-comment',
  '--editor-syntax-keyword',
  '--editor-syntax-number',
  '--editor-syntax-string',
  '--editor-syntax-type',
] as const

let nextTooltipAnchorId = 0

type TooltipAnchorNames = {
  readonly anchorName: string
  readonly classNamespace: string
}

export type TooltipShowOptions = {
  readonly anchor: DOMRect
  readonly hoverText: string | null
  readonly diagnostics: readonly lsp.Diagnostic[]
  readonly theme: EditorTheme | null
  readonly preferredPlacement?: 'top' | 'bottom'
}

export type TooltipOptions = {
  /**
   * Document used to create tooltip DOM elements and to attach document-level
   * pointer-reentry listeners.
   */
  readonly document: Document
  /**
   * Element whose computed style carries the editor theme CSS variables. The
   * tooltip copies these variables onto itself whenever `show` is called so
   * its presentation follows the active theme.
   */
  readonly themeSource: HTMLElement
  /**
   * Element that, if re-entered while the pointer leaves the tooltip body,
   * should not trigger `scheduleHide`. This is typically the editor scroll
   * element — the plugin's own pointer handlers on that element take over
   * hover/hide scheduling from there.
   */
  readonly reentryElement: HTMLElement
  /** Render additional filled backgrounds behind Markdown inline and fenced code. */
  readonly markdownCodeBackground?: boolean
  readonly classNamespace?: string
}

export type TooltipController = {
  show(options: TooltipShowOptions): void
  hide(): void
  /**
   * Schedule a deferred hide, honoring {@link TOOLTIP_HIDE_DELAY_MS} and the
   * internal pointer-down state. A no-op while the pointer is pressed inside
   * the tooltip.
   */
  scheduleHide(): void
  /** Cancel a pending deferred hide, if one is scheduled. */
  cancelHide(): void
  /** True when `target` is contained by the tooltip DOM. */
  containsTarget(target: EventTarget | null): boolean
  /**
   * True when the given viewport-space point lies inside the padded hover
   * zone formed by the union of the tooltip body and its anchor rect. Used
   * by the plugin's scroll-element pointermove handler to avoid tearing down
   * the tooltip when the pointer crosses into it.
   */
  pointInHoverZone(clientX: number, clientY: number): boolean
  dispose(): void
}

export function createTooltipController(options: TooltipOptions): TooltipController {
  const { document, themeSource, reentryElement } = options
  const classNamespace = options.classNamespace ?? 'lsp-plugin'
  const names = nextTooltipAnchorNames(classNamespace)
  const anchor = createTooltipAnchorElement(document, names)
  const tooltip = createTooltipElement(document, names)
  document.body.append(anchor, tooltip)

  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let pointerDown = false
  let disposed = false

  const cancelHide = (): void => {
    if (!hideTimer) return

    clearTimeout(hideTimer)
    hideTimer = null
  }

  const hide = (): void => {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    pointerDown = false
    tooltip.hidden = true
    anchor.style.display = 'none'
    tooltip.replaceChildren()
  }

  const scheduleHide = (): void => {
    if (pointerDown) return
    if (hideTimer) clearTimeout(hideTimer)

    hideTimer = setTimeout(() => {
      hideTimer = null
      hide()
    }, TOOLTIP_HIDE_DELAY_MS)
  }

  const show = (showOptions: TooltipShowOptions): void => {
    const placement =
      showOptions.preferredPlacement ?? (showOptions.diagnostics.length > 0 ? 'bottom' : 'top')
    positionTooltipAnchor(anchor, showOptions.anchor)
    syncEditorThemeVariables(tooltip, themeSource)
    renderTooltip(tooltip, {
      hoverText: showOptions.hoverText,
      diagnostics: showOptions.diagnostics,
      theme: showOptions.theme,
      markdownCodeBackground: options.markdownCodeBackground ?? false,
      classNamespace,
    })
    placeTooltip(tooltip, showOptions.anchor, placement)
  }

  const containsTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof Node)) return false
    return tooltip.contains(target)
  }

  const pointInHoverZone = (clientX: number, clientY: number): boolean => {
    if (tooltip.hidden) return false

    const tooltipRect = tooltip.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    const hoverZone = expandRect(unionRects(tooltipRect, anchorRect), TOOLTIP_GAP_PX)
    return rectContainsPoint(hoverZone, clientX, clientY)
  }

  const handleTooltipPointerEnter = (): void => {
    cancelHide()
  }

  const handleTooltipPointerLeave = (event: PointerEvent): void => {
    if (pointerDown) return
    if (targetInsideElement(reentryElement, event.relatedTarget)) return

    scheduleHide()
  }

  const handleTooltipPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return

    pointerDown = true
    cancelHide()
  }

  const handleDocumentPointerUp = (): void => {
    pointerDown = false
  }

  tooltip.addEventListener('pointerenter', handleTooltipPointerEnter)
  tooltip.addEventListener('pointerleave', handleTooltipPointerLeave)
  tooltip.addEventListener('pointerdown', handleTooltipPointerDown)
  document.addEventListener('pointerup', handleDocumentPointerUp)
  document.addEventListener('pointercancel', handleDocumentPointerUp)

  const dispose = (): void => {
    if (disposed) return

    disposed = true
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    tooltip.removeEventListener('pointerenter', handleTooltipPointerEnter)
    tooltip.removeEventListener('pointerleave', handleTooltipPointerLeave)
    tooltip.removeEventListener('pointerdown', handleTooltipPointerDown)
    document.removeEventListener('pointerup', handleDocumentPointerUp)
    document.removeEventListener('pointercancel', handleDocumentPointerUp)
    anchor.remove()
    tooltip.remove()
  }

  return {
    show,
    hide,
    scheduleHide,
    cancelHide,
    containsTarget,
    pointInHoverZone,
    dispose,
  }
}

function nextTooltipAnchorNames(classNamespace: string): TooltipAnchorNames {
  nextTooltipAnchorId += 1
  return {
    anchorName: `--editor-${classNamespace}-hover-${nextTooltipAnchorId}`,
    classNamespace,
  }
}

function createTooltipAnchorElement(document: Document, names: TooltipAnchorNames): HTMLDivElement {
  const element = document.createElement('div')
  element.className = tooltipClassName(names.classNamespace, 'anchor')
  Object.assign(element.style, {
    position: 'fixed',
    display: 'none',
    opacity: '0',
    pointerEvents: 'none',
  })
  element.style.setProperty('anchor-name', names.anchorName)
  return element
}

function createTooltipElement(document: Document, names: TooltipAnchorNames): HTMLDivElement {
  const element = document.createElement('div')
  element.className = tooltipClassName(names.classNamespace)
  element.hidden = true
  Object.assign(element.style, {
    position: 'fixed',
    zIndex: '1000',
    width: 'max-content',
    maxWidth: 'min(520px, calc(100vw - 24px))',
    maxHeight: defaultTooltipMaxHeight(),
    overflow: 'hidden',
    padding: '2px 10px 8px',
    border: '1px solid color-mix(in srgb, var(--editor-foreground, #d4d4d8) 24%, transparent)',
    borderRadius: '6px',
    boxSizing: 'border-box',
    background:
      'color-mix(in srgb, var(--editor-background, #18181b) 96%, var(--editor-foreground, #e4e4e7) 4%)',
    color: 'var(--editor-foreground, #e4e4e7)',
    boxShadow: '0 12px 34px color-mix(in srgb, var(--editor-background, #000000) 62%, transparent)',
    display: 'grid',
    gridTemplateRows: 'auto auto',
    gap: '6px',
    font: '12px/1.45 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    whiteSpace: 'normal',
    pointerEvents: 'auto',
    userSelect: 'text',
    cursor: 'text',
  })
  applyCssAnchorPosition(element, names)
  return element
}

function renderTooltip(
  element: HTMLDivElement,
  content: {
    readonly hoverText: string | null
    readonly diagnostics: readonly lsp.Diagnostic[]
    readonly theme?: EditorTheme | null
    readonly markdownCodeBackground: boolean
    readonly classNamespace: string
  },
): void {
  element.replaceChildren()
  element.style.maxHeight = defaultTooltipMaxHeight()

  const body = element.ownerDocument.createElement('div')
  body.className = tooltipClassName(content.classNamespace, 'body')
  Object.assign(body.style, {
    minWidth: '0',
    minHeight: '0',
    maxHeight: defaultTooltipBodyMaxHeight(),
    overflowX: 'hidden',
    overflowY: 'auto',
    paddingRight: '2px',
    scrollbarGutter: 'stable',
  })
  if (content.hoverText) {
    body.append(
      renderTooltipMarkdown(element.ownerDocument, content.hoverText, content.theme, {
        codeBackground: content.markdownCodeBackground,
        classNamespace: content.classNamespace,
      }),
    )
  }
  if (content.diagnostics.length > 0) {
    body.append(diagnosticSection(element.ownerDocument, content.diagnostics))
  }

  element.append(
    createCopyButton(element.ownerDocument, tooltipCopyText(content), content.classNamespace),
    body,
  )
  element.hidden = false
}

function createCopyButton(
  document: Document,
  copyText: string,
  classNamespace: string,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = tooltipClassName(classNamespace, 'copy')
  Object.assign(button.style, {
    display: 'inline-grid',
    placeItems: 'center',
    justifySelf: 'end',
    width: '22px',
    height: '22px',
    margin: '-2px -3px 0 0',
    border: '1px solid transparent',
    borderRadius: '4px',
    padding: '0',
    background: 'transparent',
    color: 'color-mix(in srgb, var(--editor-foreground, #a1a1aa) 72%, transparent)',
    cursor: 'pointer',
    opacity: '0.72',
    userSelect: 'none',
  })
  setCopyButtonState(button, 'idle')
  button.addEventListener('mouseenter', () => styleCopyButtonHover(button, true))
  button.addEventListener('mouseleave', () => styleCopyButtonHover(button, false))
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    void handleCopyButtonClick(button, copyText)
  })
  return button
}

type CopyButtonState = 'idle' | 'copied' | 'failed'

function setCopyButtonState(button: HTMLButtonElement, state: CopyButtonState): void {
  button.title = copyButtonLabel(state)
  button.setAttribute('aria-label', copyButtonLabel(state))
  button.style.color = copyButtonColor(state)
  button.replaceChildren(copyButtonIcon(button.ownerDocument, state))
}

function styleCopyButtonHover(button: HTMLButtonElement, active: boolean): void {
  Object.assign(button.style, {
    background: active
      ? 'color-mix(in srgb, var(--editor-foreground, #a1a1aa) 14%, transparent)'
      : 'transparent',
    borderColor: active
      ? 'color-mix(in srgb, var(--editor-foreground, #a1a1aa) 22%, transparent)'
      : 'transparent',
    opacity: active ? '1' : '0.72',
  })
}

function copyButtonLabel(state: CopyButtonState): string {
  if (state === 'copied') return 'Copied hover text'
  if (state === 'failed') return 'Copy failed'
  return 'Copy hover text'
}

function copyButtonColor(state: CopyButtonState): string {
  if (state === 'copied') return '#86efac'
  if (state === 'failed') return '#f87171'
  return 'color-mix(in srgb, var(--editor-foreground, #a1a1aa) 72%, transparent)'
}

function copyButtonIcon(document: Document, state: CopyButtonState): SVGSVGElement {
  const icon = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('width', '14')
  icon.setAttribute('height', '14')
  icon.setAttribute('aria-hidden', 'true')
  icon.setAttribute('fill', 'none')
  icon.setAttribute('stroke', 'currentColor')
  icon.setAttribute('stroke-width', '2')
  icon.setAttribute('stroke-linecap', 'round')
  icon.setAttribute('stroke-linejoin', 'round')

  for (const pathData of copyButtonIconPaths(state)) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', pathData)
    icon.append(path)
  }

  return icon
}

function copyButtonIconPaths(state: CopyButtonState): readonly string[] {
  if (state === 'copied') return ['M20 6 9 17l-5-5']
  if (state === 'failed') return ['M12 8v5', 'M12 17h.01', 'M10.3 4h3.4L22 19H2L10.3 4Z']
  return ['M8 8h12v12H8Z', 'M4 4h12v2', 'M4 4v12h2']
}

async function handleCopyButtonClick(button: HTMLButtonElement, copyText: string): Promise<void> {
  const copied = await copyTextToClipboard(button.ownerDocument, copyText)
  showCopyButtonStatus(button, copied)
}

function showCopyButtonStatus(button: HTMLButtonElement, copied: boolean): void {
  setCopyButtonState(button, copied ? 'copied' : 'failed')
  setTimeout(() => {
    if (!button.isConnected) return
    setCopyButtonState(button, 'idle')
  }, COPY_BUTTON_RESET_DELAY_MS)
}

async function copyTextToClipboard(document: Document, text: string): Promise<boolean> {
  const clipboard = document.defaultView?.navigator.clipboard
  if (!clipboard) return copyTextWithTextarea(document, text)

  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return copyTextWithTextarea(document, text)
  }
}

function copyTextWithTextarea(document: Document, text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  Object.assign(textarea.style, {
    position: 'fixed',
    top: '-9999px',
    left: '-9999px',
    opacity: '0',
  })
  document.body.append(textarea)
  textarea.select()

  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

function tooltipCopyText(content: {
  readonly hoverText: string | null
  readonly diagnostics: readonly lsp.Diagnostic[]
}): string {
  const parts = [
    plainHoverText(content.hoverText),
    ...content.diagnostics.map(diagnosticCopyText),
  ].filter((part) => part.length > 0)
  return parts.join('\n\n')
}

function plainHoverText(markdown: string | null): string {
  if (!markdown) return ''
  return markdown
    .replace(/^```[^\n]*\n/gm, '')
    .replace(/^```\s*$/gm, '')
    .trim()
}

function diagnosticCopyText(diagnostic: lsp.Diagnostic): string {
  return `${severityForDiagnostic(diagnostic)}: ${diagnostic.message}`.trim()
}

function diagnosticSection(
  document: Document,
  diagnostics: readonly lsp.Diagnostic[],
): HTMLElement {
  const section = document.createElement('div')
  section.style.marginTop = '8px'
  section.style.paddingTop = '8px'
  section.style.borderTop =
    '1px solid color-mix(in srgb, var(--editor-foreground, #a1a1aa) 20%, transparent)'
  for (const diagnostic of diagnostics) section.append(diagnosticRow(document, diagnostic))
  return section
}

function syncEditorThemeVariables(target: HTMLElement, source: HTMLElement): void {
  const style = source.ownerDocument.defaultView?.getComputedStyle(source)
  if (!style) return

  for (const variable of TOOLTIP_THEME_VARIABLES) {
    const value =
      source.style.getPropertyValue(variable).trim() || style.getPropertyValue(variable).trim()
    if (value) target.style.setProperty(variable, value)
  }
}

function diagnosticRow(document: Document, diagnostic: lsp.Diagnostic): HTMLElement {
  const row = document.createElement('div')
  row.style.display = 'grid'
  row.style.gridTemplateColumns = 'auto 1fr'
  row.style.gap = '8px'
  row.style.alignItems = 'baseline'

  const label = document.createElement('span')
  label.textContent = severityForDiagnostic(diagnostic)
  label.style.color = diagnosticColor(diagnostic)

  const message = document.createElement('span')
  message.textContent = diagnostic.message

  row.append(label, message)
  return row
}

function positionTooltipAnchor(element: HTMLDivElement, anchor: DOMRect): void {
  Object.assign(element.style, {
    display: 'block',
    left: `${anchor.left}px`,
    top: `${anchor.top}px`,
    width: `${Math.max(1, anchor.width)}px`,
    height: `${Math.max(1, anchor.height)}px`,
  })
}

function applyCssAnchorPosition(element: HTMLDivElement, names: TooltipAnchorNames): void {
  element.style.setProperty('position-anchor', names.anchorName)
  element.style.setProperty('inset', 'auto')
  applyTooltipPlacement(element, 'top')
}

function placeTooltip(
  element: HTMLDivElement,
  anchor: DOMRect,
  preferredPlacement: 'top' | 'bottom',
): void {
  const viewportHeight = tooltipViewportHeight(element.ownerDocument)
  const tooltipHeight = Math.min(element.getBoundingClientRect().height, TOOLTIP_MAX_HEIGHT_PX)
  const placement = tooltipPlacement(anchor, tooltipHeight, viewportHeight, preferredPlacement)
  const availableHeight = tooltipAvailableHeight(anchor, placement, viewportHeight)
  const maxHeight = tooltipMaxHeight(availableHeight)
  element.style.maxHeight = `${maxHeight}px`
  setTooltipBodyMaxHeight(element, maxHeight)
  applyTooltipPlacement(element, placement)
}

function defaultTooltipMaxHeight(): string {
  return `min(${TOOLTIP_MAX_HEIGHT_PX}px, calc(100vh - ${TOOLTIP_VIEWPORT_MARGIN_PX * 2}px))`
}

function defaultTooltipBodyMaxHeight(): string {
  return `min(${TOOLTIP_MAX_HEIGHT_PX - TOOLTIP_BODY_CHROME_PX}px, calc(100vh - ${
    TOOLTIP_VIEWPORT_MARGIN_PX * 2 + TOOLTIP_BODY_CHROME_PX
  }px))`
}

function setTooltipBodyMaxHeight(element: HTMLDivElement, maxHeight: number): void {
  const body = element.querySelector<HTMLElement>(`.${tooltipClassNameForElement(element, 'body')}`)
  if (!body) return

  body.style.maxHeight = `${Math.max(1, maxHeight - TOOLTIP_BODY_CHROME_PX)}px`
}

function tooltipClassName(classNamespace: string, part?: string): string {
  const base = `editor-${classNamespace}-hover`
  return part ? `${base}-${part}` : base
}

function tooltipClassNameForElement(element: HTMLElement, part: string): string {
  const namespace = tooltipNamespaceFromClassName(element.className)
  return tooltipClassName(namespace, part)
}

function tooltipNamespaceFromClassName(className: string): string {
  const match = /^editor-(.+)-hover(?:\s|$)/.exec(className)
  return match?.[1] ?? 'lsp-plugin'
}

function tooltipViewportHeight(document: Document): number {
  return document.defaultView?.innerHeight ?? TOOLTIP_MAX_HEIGHT_PX
}

function tooltipPlacement(
  anchor: DOMRect,
  tooltipHeight: number,
  viewportHeight: number,
  preferredPlacement: 'top' | 'bottom',
): 'top' | 'bottom' {
  const preferredHeight = tooltipAvailableHeight(anchor, preferredPlacement, viewportHeight)
  if (preferredHeight >= tooltipHeight) return preferredPlacement

  const fallbackPlacement = preferredPlacement === 'top' ? 'bottom' : 'top'
  const fallbackHeight = tooltipAvailableHeight(anchor, fallbackPlacement, viewportHeight)
  if (fallbackHeight >= tooltipHeight) return fallbackPlacement

  const availableTop = tooltipAvailableHeight(anchor, 'top', viewportHeight)
  const availableBottom = tooltipAvailableHeight(anchor, 'bottom', viewportHeight)
  return availableTop >= availableBottom ? 'top' : 'bottom'
}

function tooltipAvailableHeight(
  anchor: DOMRect,
  placement: 'top' | 'bottom',
  viewportHeight: number,
): number {
  if (placement === 'top') return anchor.top - TOOLTIP_GAP_PX - TOOLTIP_VIEWPORT_MARGIN_PX
  return viewportHeight - anchor.bottom - TOOLTIP_GAP_PX - TOOLTIP_VIEWPORT_MARGIN_PX
}

function tooltipMaxHeight(availableHeight: number): number {
  const maxHeight = Math.min(TOOLTIP_MAX_HEIGHT_PX, Math.floor(availableHeight))
  return Math.max(TOOLTIP_MIN_MAX_HEIGHT_PX, maxHeight)
}

function applyTooltipPlacement(element: HTMLDivElement, placement: 'top' | 'bottom'): void {
  element.style.setProperty('position-area', `${placement} center`)
  element.style.setProperty('margin-top', placement === 'bottom' ? `${TOOLTIP_GAP_PX}px` : '0')
  element.style.setProperty('margin-bottom', placement === 'top' ? `${TOOLTIP_GAP_PX}px` : '0')
}

function severityForDiagnostic(diagnostic: lsp.Diagnostic): string {
  if (diagnostic.severity === 2) return 'warning'
  if (diagnostic.severity === 3) return 'info'
  if (diagnostic.severity === 4) return 'hint'
  return 'error'
}

function diagnosticColor(diagnostic: lsp.Diagnostic): string {
  if (diagnostic.severity === 2) return '#fbbf24'
  if (diagnostic.severity === 3) return '#60a5fa'
  if (diagnostic.severity === 4) return '#a1a1aa'
  return '#f87171'
}

function targetInsideElement(element: Element, target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false
  return element.contains(target)
}

function unionRects(left: DOMRect, right: DOMRect): DOMRect {
  const x = Math.min(left.left, right.left)
  const y = Math.min(left.top, right.top)
  const rightEdge = Math.max(left.right, right.right)
  const bottomEdge = Math.max(left.bottom, right.bottom)
  return new DOMRect(x, y, Math.max(0, rightEdge - x), Math.max(0, bottomEdge - y))
}

function expandRect(rect: DOMRect, amount: number): DOMRect {
  return new DOMRect(
    rect.left - amount,
    rect.top - amount,
    rect.width + amount * 2,
    rect.height + amount * 2,
  )
}

function rectContainsPoint(rect: DOMRect, clientX: number, clientY: number): boolean {
  if (clientX < rect.left) return false
  if (clientX > rect.right) return false
  if (clientY < rect.top) return false
  return clientY <= rect.bottom
}
