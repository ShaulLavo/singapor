import type { EditorTheme } from '@singapor/core/rendering'
import type {
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import { lspPositionToOffset, offsetToLspPosition, type LspClient } from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

import { anchoredSurfaceFollowsUpdate } from './anchoredSurface'
import {
  identifierRangeAtOffset,
  navigateToTarget,
  preferredDefinitionTarget,
  preferredJumpableDefinitionTarget,
  preferredReferenceTarget,
  requestDefinition,
  requestNavigationTargets,
  sameOffsetRange,
  type DefinitionResult,
  type OffsetRange,
} from './definitionNavigation'
import { diagnosticsAtOffset } from './diagnosticProjection'
import { LINK_HIGHLIGHT_STYLE } from './plugin.styles'
import type { ActiveDocument, LanguageServerNavigationCommand } from './pluginTypes'
import {
  createTooltipController,
  HOVER_REQUEST_DEBOUNCE_MS,
  type TooltipController,
} from './tooltip'
import type {
  LanguageServerDefinitionTarget,
  LanguageServerNavigationKind,
  LanguageServerNavigationOptions,
  LanguageServerReferencesResult,
} from './types'

export type HoverDefinitionControllerOptions = {
  readonly context: EditorViewContributionContext
  readonly client: LspClient
  readonly hoverMarkdownCodeBackground: boolean
  readonly defaultHighlightPrefix?: string
  readonly linkHighlightNameNamespace?: string
  readonly tooltipClassNamespace?: string
  readonly navigationTimingNamePrefix?: string
  getActiveDocument(): ActiveDocument | null
  getDiagnostics(): readonly lsp.Diagnostic[]
  completionContainsTarget(target: EventTarget | null): boolean
  onOpenDefinition?(
    target: LanguageServerDefinitionTarget,
    options?: LanguageServerNavigationOptions,
  ): void | boolean
  onOpenReferences?(result: LanguageServerReferencesResult): void | boolean
  onRequestSuccess?(): void
  onRequestError(error: unknown): void
}

export class HoverDefinitionController {
  private readonly context: EditorViewContributionContext
  private readonly client: LspClient
  private readonly tooltip: TooltipController
  private readonly linkHighlightName: string
  private hoverTimer: ReturnType<typeof setTimeout> | null = null
  private hoverAbort: AbortController | null = null
  private hoverRequestId = 0
  private definitionRequestId = 0
  private definitionHoverRequestId = 0
  private lastPointerOffset: number | null = null
  private linkRange: OffsetRange | null = null
  private currentTheme: EditorTheme | null = null
  private disposed = false

  public constructor(private readonly options: HoverDefinitionControllerOptions) {
    this.context = options.context
    this.client = options.client
    this.linkHighlightName = definitionLinkHighlightName(this.context, options)
    this.tooltip = createTooltipController({
      document: this.context.container.ownerDocument,
      themeSource: this.context.scrollElement,
      reentryElement: this.context.scrollElement,
      markdownCodeBackground: options.hoverMarkdownCodeBackground,
      classNamespace: options.tooltipClassNamespace ?? 'lsp-plugin',
    })
    this.installHandlers()
  }

  public update(snapshot: EditorViewSnapshot, kind: EditorViewContributionUpdateKind): void {
    this.currentTheme = snapshot.theme ?? null
    if (!shouldClearPointerUi(kind)) return

    this.clearPointerUi()
  }

  public runNavigationCommand(command: LanguageServerNavigationCommand): boolean {
    const selection = this.context.getSnapshot().selections[0]
    if (!selection) return false
    return this.requestNavigationAtOffset(selection.headOffset, command)
  }

  public containsTarget(target: EventTarget | null): boolean {
    return this.tooltip.containsTarget(target)
  }

  public clearPointerUi(): void {
    this.hideHover()
    this.clearDefinitionLink()
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.uninstallHandlers()
    this.clearPointerUi()
    this.tooltip.dispose()
  }

  private installHandlers(): void {
    this.context.scrollElement.addEventListener('pointermove', this.handlePointerMove)
    this.context.scrollElement.addEventListener('pointerleave', this.handlePointerLeave)
    this.context.scrollElement.addEventListener('mousedown', this.handleMouseDown, {
      capture: true,
    })
    this.context.container.ownerDocument.addEventListener(
      'pointerdown',
      this.handleDocumentPointerDown,
      { capture: true },
    )
    this.context.container.ownerDocument.addEventListener('keydown', this.handleKeyDown)
    this.context.container.ownerDocument.addEventListener('keyup', this.handleKeyUp)
  }

  private uninstallHandlers(): void {
    this.context.scrollElement.removeEventListener('pointermove', this.handlePointerMove)
    this.context.scrollElement.removeEventListener('pointerleave', this.handlePointerLeave)
    this.context.scrollElement.removeEventListener('mousedown', this.handleMouseDown, {
      capture: true,
    })
    this.context.container.ownerDocument.removeEventListener(
      'pointerdown',
      this.handleDocumentPointerDown,
      { capture: true },
    )
    this.context.container.ownerDocument.removeEventListener('keydown', this.handleKeyDown)
    this.context.container.ownerDocument.removeEventListener('keyup', this.handleKeyUp)
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (event.buttons !== 0) return this.clearPointerUi()

    const inTooltipHoverZone = this.tooltip.pointInHoverZone(event.clientX, event.clientY)
    if (inTooltipHoverZone && !isNavigationModifier(event)) {
      this.lastPointerOffset = null
      this.clearDefinitionLink()
      this.cancelHoverHide()
      return
    }
    if (!this.options.getActiveDocument()) return this.clearPointerUi()

    const offset = this.context.textOffsetFromPoint(event.clientX, event.clientY)
    if (offset === null) {
      if (inTooltipHoverZone) return this.cancelHoverHide()
      return this.clearPointerUi()
    }

    this.lastPointerOffset = offset
    if (isNavigationModifier(event)) {
      this.requestDefinitionLink(offset)
    } else {
      this.clearDefinitionLink()
    }

    this.scheduleHover(offset)
  }

  private readonly handlePointerLeave = (event: PointerEvent): void => {
    this.lastPointerOffset = null
    this.clearDefinitionLink()
    if (this.tooltip.containsTarget(event.relatedTarget)) {
      this.cancelHoverHide()
      return
    }

    this.scheduleHoverHide()
  }

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return
    if (!isNavigationModifier(event)) return

    const offset = this.context.textOffsetFromPoint(event.clientX, event.clientY)
    if (offset === null) return

    event.preventDefault()
    event.stopImmediatePropagation()
    this.context.focusEditor()
    this.goToDefinitionAtOffset(offset)
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    if (this.tooltip.containsTarget(event.target)) return
    if (this.options.completionContainsTarget(event.target)) return

    this.clearPointerUi()
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!isNavigationModifier(event)) return
    if (this.lastPointerOffset === null) return

    this.requestDefinitionLink(this.lastPointerOffset)
    this.scheduleHover(this.lastPointerOffset)
  }

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== 'Meta' && event.key !== 'Control') return

    this.clearDefinitionLink()
  }

  private scheduleHover(offset: number): void {
    this.cancelHoverHide()
    if (this.hoverTimer) clearTimeout(this.hoverTimer)
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null
      void this.requestHover(offset)
    }, HOVER_REQUEST_DEBOUNCE_MS)
  }

  private async requestHover(offset: number): Promise<void> {
    const active = this.options.getActiveDocument()
    if (!active) return
    if (!this.client.initialized) return

    this.hoverAbort?.abort()
    const requestId = this.hoverRequestId + 1
    const abort = new AbortController()
    this.hoverRequestId = requestId
    this.hoverAbort = abort

    try {
      const hover = await this.client.request<lsp.Hover | null>(
        'textDocument/hover',
        {
          textDocument: { uri: active.uri },
          position: offsetToLspPosition(active.fullText, offset),
        } satisfies lsp.TextDocumentPositionParams,
        { signal: abort.signal },
      )
      this.options.onRequestSuccess?.()
      this.renderHoverResult(requestId, active, offset, hover)
    } catch (error) {
      this.options.onRequestError(error)
    }
  }

  private renderHoverResult(
    requestId: number,
    active: ActiveDocument,
    offset: number,
    hover: lsp.Hover | null,
  ): void {
    if (requestId !== this.hoverRequestId) return
    if (active !== this.options.getActiveDocument()) return

    const diagnostics = diagnosticsAtOffset(active.fullText, offset, this.options.getDiagnostics())
    if (!hover && diagnostics.length === 0) {
      this.hideHover()
      return
    }

    const range =
      hoverRangeOffsets(active.fullText, hover) ?? visibleRangeAtOffset(active.fullText, offset)
    const rect = this.context.getRangeClientRect(range.start, range.end)
    if (!rect) return this.hideHover()

    this.tooltip.show({
      anchor: rect,
      hoverText: hoverText(hover),
      diagnostics,
      theme: this.currentTheme,
      preferredPlacement: diagnostics.length > 0 ? 'bottom' : 'top',
    })
  }

  private goToDefinitionAtOffset(offset: number): boolean {
    return this.requestNavigationAtOffset(offset, {
      kind: 'definition',
      openMode: 'default',
    })
  }

  private requestNavigationAtOffset(
    offset: number,
    command: LanguageServerNavigationCommand,
  ): boolean {
    const active = this.options.getActiveDocument()
    if (!active) return false
    if (!this.client.initialized) return false

    this.clearPointerUi()
    const requestId = this.definitionRequestId + 1
    this.definitionRequestId = requestId
    void requestNavigationTargets(this.client, {
      uri: active.uri,
      text: active.fullText,
      offset,
      kind: command.kind,
      includeDeclaration: command.includeDeclaration,
    })
      .then((result) => this.handleNavigationResult(requestId, active, offset, command, result))
      .catch((error: unknown) => this.options.onRequestError(error))
    return true
  }

  private requestDefinitionLink(offset: number): void {
    const active = this.options.getActiveDocument()
    if (!active) return this.clearDefinitionLink()
    if (!this.client.initialized) return this.clearDefinitionLink()

    const range = identifierRangeAtOffset(active.fullText, offset)
    if (!range) return this.clearDefinitionLink()
    if (sameOffsetRange(this.linkRange, range)) return

    const requestId = this.definitionHoverRequestId + 1
    this.definitionHoverRequestId = requestId
    void requestDefinition(this.client, {
      uri: active.uri,
      text: active.fullText,
      offset,
    })
      .then((result) => this.renderDefinitionLink(requestId, active, range, result))
      .catch((error: unknown) => this.options.onRequestError(error))
  }

  private renderDefinitionLink(
    requestId: number,
    active: ActiveDocument,
    range: OffsetRange,
    result: DefinitionResult,
  ): void {
    if (requestId !== this.definitionHoverRequestId) return
    if (active !== this.options.getActiveDocument()) return
    if (!preferredJumpableDefinitionTarget(active.uri, active.fullText, range, result))
      return this.clearDefinitionLink()

    this.linkRange = range
    this.context.setRangeHighlight?.(this.linkHighlightName, [range], LINK_HIGHLIGHT_STYLE)
    this.context.scrollElement.style.cursor = 'pointer'
  }

  private handleNavigationResult(
    requestId: number,
    active: ActiveDocument,
    offset: number,
    command: LanguageServerNavigationCommand,
    result: DefinitionResult,
  ): void {
    if (requestId !== this.definitionRequestId) return
    if (active !== this.options.getActiveDocument()) return

    if (command.kind === 'references') {
      this.handleReferencesResult(active, offset, result)
      return
    }

    const target = preferredDefinitionTarget(active.uri, result)
    if (!target) return
    this.openNavigationTarget(active, target, command)
  }

  private handleReferencesResult(
    active: ActiveDocument,
    offset: number,
    result: DefinitionResult,
  ): void {
    const handled = this.options.onOpenReferences?.({
      uri: active.uri,
      targets: result.targets,
    })
    if (handled) return

    const target = preferredReferenceTarget(active.uri, active.fullText, offset, result)
    if (!target) return
    this.openNavigationTarget(active, target, {
      kind: 'references',
      openMode: 'peek',
    })
  }

  private openNavigationTarget(
    active: ActiveDocument,
    target: LanguageServerDefinitionTarget,
    command: LanguageServerNavigationCommand,
  ): void {
    const shouldOfferExternalOpen = target.uri !== active.uri || command.openMode !== 'default'
    const handled = shouldOfferExternalOpen ? this.openDefinitionTarget(target, command) : false
    if (handled) return
    if (target.uri !== active.uri) return

    navigateToTarget(
      target,
      {
        text: active.fullText,
        setSelection: this.context.setSelection.bind(this.context),
        focusEditor: this.context.focusEditor.bind(this.context),
      },
      this.navigationTimingName(command.kind),
    )
  }

  private navigationTimingName(kind: LanguageServerNavigationKind): string {
    const prefix = this.options.navigationTimingNamePrefix ?? 'lspPlugin'
    if (kind === 'typeDefinition') return `${prefix}.goToTypeDefinition`
    return `${prefix}.goTo${capitalize(kind)}`
  }

  private openDefinitionTarget(
    target: LanguageServerDefinitionTarget,
    command: LanguageServerNavigationCommand,
  ): void | boolean {
    const options = defaultDefinitionOptions(command)
    if (!options) return this.options.onOpenDefinition?.(target)
    return this.options.onOpenDefinition?.(target, options)
  }

  private hideHover(): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer)
    this.hoverTimer = null
    this.hoverAbort?.abort()
    this.hoverAbort = null
    this.hoverRequestId += 1
    this.tooltip.hide()
  }

  private scheduleHoverHide(): void {
    this.tooltip.scheduleHide()
  }

  private cancelHoverHide(): void {
    this.tooltip.cancelHide()
  }

  private clearDefinitionLink(): void {
    this.definitionHoverRequestId += 1
    this.linkRange = null
    this.context.clearRangeHighlight?.(this.linkHighlightName)
    this.context.scrollElement.style.cursor = ''
  }
}

/**
 * This surface answers a view that moved by closing, where the others follow it.
 *
 * A hover is summoned by the pointer and stays keyed to it: once the text has slid out from under
 * a pointer that never moved, the tooltip describes a token that is no longer there, and the link
 * underline is pointing at the wrong word. Both belong to the old frame, so both go.
 */
function shouldClearPointerUi(kind: EditorViewContributionUpdateKind): boolean {
  if (anchoredSurfaceFollowsUpdate(kind)) return true
  return kind === 'content' || kind === 'document' || kind === 'clear'
}

function defaultDefinitionOptions(
  command: LanguageServerNavigationCommand,
): LanguageServerNavigationOptions | null {
  if (command.kind === 'definition' && command.openMode === 'default') return null

  return {
    kind: command.kind,
    openMode: command.openMode,
  }
}

function hoverText(hover: lsp.Hover | null): string | null {
  if (!hover) return null

  const text = hoverContentsText(hover.contents).trim()
  if (!text) return null
  return text
}

function hoverContentsText(contents: lsp.Hover['contents']): string {
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) return contents.map(markedStringText).join('\n\n')
  if ('kind' in contents) return contents.value
  return markedStringText(contents)
}

function markedStringText(value: lsp.MarkedString): string {
  if (typeof value === 'string') return value
  return ['```' + value.language, value.value, '```'].join('\n')
}

function hoverRangeOffsets(
  text: string,
  hover: lsp.Hover | null,
): { readonly start: number; readonly end: number } | null {
  if (!hover?.range) return null

  const start = lspPositionToOffset(text, hover.range.start)
  const end = lspPositionToOffset(text, hover.range.end)
  if (end > start) return { start, end }
  return null
}

function visibleRangeAtOffset(text: string, offset: number): OffsetRange {
  const start = Math.max(0, Math.min(offset, Math.max(0, text.length - 1)))
  return { start, end: Math.min(text.length, start + 1) }
}

function isNavigationModifier(event: {
  readonly metaKey: boolean
  readonly ctrlKey: boolean
}): boolean {
  return event.metaKey || event.ctrlKey
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

function definitionLinkHighlightName(
  context: EditorViewContributionContext,
  options: HoverDefinitionControllerOptions,
): string {
  const prefix = context.highlightPrefix ?? options.defaultHighlightPrefix ?? 'editor-lsp-plugin'
  const namespace = options.linkHighlightNameNamespace ?? 'lsp-plugin'
  return `${prefix}-${namespace}-definition-link`
}
