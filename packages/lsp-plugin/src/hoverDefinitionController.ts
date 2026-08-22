import type { EditorTheme } from '@singapor/core/rendering'
import type {
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import {
  lspPositionToOffset,
  offsetToLspPosition,
  type LspClient,
  type LspRequestOptions,
} from '@singapor/lsp'
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
  HOVER_ASYNC_DISPATCH_DELAY_MS,
  HOVER_LOADING_DELAY_MS,
  HOVER_REQUEST_DEBOUNCE_MS,
  type TooltipController,
} from './tooltip'
import type { LanguageServerHoverUpdate } from './serverSet'
import type {
  LanguageServerDefinitionTarget,
  LanguageServerNavigationKind,
  LanguageServerNavigationOptions,
  LanguageServerReferencesResult,
} from './types'

export type HoverDefinitionControllerOptions = {
  readonly context: EditorViewContributionContext
  readonly client: LspClient
  requestHover(
    params: lsp.TextDocumentPositionParams,
    options: LspRequestOptions,
    onUpdate: (update: LanguageServerHoverUpdate) => void,
  ): Promise<lsp.Hover | null>
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

type HoverOperation = {
  readonly id: number
  readonly active: ActiveDocument
  readonly offset: number
  readonly targetRange: OffsetRange
  readonly diagnostics: readonly lsp.Diagnostic[]
  readonly focusOnShow: boolean
  hovers: readonly lsp.Hover[]
  pending: boolean
  revealed: boolean
  loading: boolean
  shown: boolean
  dispatchTimer: ReturnType<typeof setTimeout> | null
  revealTimer: ReturnType<typeof setTimeout> | null
  loadingTimer: ReturnType<typeof setTimeout> | null
}

export class HoverDefinitionController {
  private readonly context: EditorViewContributionContext
  private readonly client: LspClient
  private readonly tooltip: TooltipController
  private readonly linkHighlightName: string
  private hoverOperation: HoverOperation | null = null
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
      onDidHide: () => this.cancelHoverOperation(),
      onRequestEditorFocus: () => this.context.focusEditor(),
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

  public showHoverFromSelection(): boolean {
    const selection = this.context.getSnapshot().selections[0]
    if (!selection) return false

    const active = this.options.getActiveDocument()
    if (!active || !this.client.initialized) return false

    const range = hoverTargetRange(active.fullText, selection.headOffset)
    this.startHover(active, selection.headOffset, range, true)
    return true
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

    const inTooltipHoverZone = this.tooltip.shouldKeepForPointer(event.clientX, event.clientY)
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
    const active = this.options.getActiveDocument()
    if (!active || !this.client.initialized) return

    const range = hoverTargetRange(active.fullText, offset)
    const current = this.hoverOperation
    if (current?.active === active && sameOffsetRange(current.targetRange, range)) return

    this.startHover(active, offset, range, false)
  }

  private startHover(
    active: ActiveDocument,
    offset: number,
    targetRange: OffsetRange,
    focusOnShow: boolean,
  ): void {
    this.cancelHoverOperation()
    this.tooltip.hide()
    const id = this.hoverRequestId + 1
    this.hoverRequestId = id
    const operation: HoverOperation = {
      id,
      active,
      offset,
      targetRange,
      diagnostics: diagnosticsAtOffset(active.fullText, offset, this.options.getDiagnostics()),
      focusOnShow,
      hovers: [],
      pending: true,
      revealed: focusOnShow,
      loading: false,
      shown: false,
      dispatchTimer: null,
      revealTimer: null,
      loadingTimer: null,
    }
    this.hoverOperation = operation
    operation.loadingTimer = setTimeout(() => this.revealHoverLoading(id), HOVER_LOADING_DELAY_MS)
    if (focusOnShow) {
      void this.dispatchHover(operation)
      return
    }

    operation.dispatchTimer = setTimeout(() => {
      operation.dispatchTimer = null
      void this.dispatchHover(operation)
    }, HOVER_ASYNC_DISPATCH_DELAY_MS)
    operation.revealTimer = setTimeout(() => {
      operation.revealTimer = null
      this.revealHover(id)
    }, HOVER_REQUEST_DEBOUNCE_MS)
  }

  private async dispatchHover(operation: HoverOperation): Promise<void> {
    if (!this.isCurrentHover(operation)) return

    this.hoverAbort?.abort()
    const abort = new AbortController()
    this.hoverAbort = abort
    try {
      const hover = await this.options.requestHover(
        {
          textDocument: { uri: operation.active.uri },
          position: offsetToLspPosition(operation.active.fullText, operation.offset),
        },
        { signal: abort.signal },
        (update) => this.updateHover(operation.id, update),
      )
      if (!this.isCurrentHover(operation)) return

      this.options.onRequestSuccess?.()
      this.finishHover(operation.id, hover)
    } catch (error) {
      if (!isAbortError(error)) this.options.onRequestError(error)
      this.finishHover(operation.id, null)
    }
  }

  private updateHover(requestId: number, update: LanguageServerHoverUpdate): void {
    const operation = this.currentHover(requestId)
    if (!operation) return

    operation.hovers = update.hovers
    operation.pending = update.pending
    this.renderHover(operation)
  }

  private finishHover(requestId: number, hover: lsp.Hover | null): void {
    const operation = this.currentHover(requestId)
    if (!operation) return

    if (operation.hovers.length === 0 && hover) operation.hovers = [hover]
    operation.pending = false
    this.hoverAbort = null
    if (operation.loadingTimer) clearTimeout(operation.loadingTimer)
    operation.loadingTimer = null
    this.renderHover(operation)
  }

  private revealHover(requestId: number): void {
    const operation = this.currentHover(requestId)
    if (!operation) return

    operation.revealed = true
    this.renderHover(operation)
  }

  private revealHoverLoading(requestId: number): void {
    const operation = this.currentHover(requestId)
    if (!operation || !operation.pending) return

    operation.revealed = true
    operation.loading = true
    operation.loadingTimer = null
    this.renderHover(operation)
  }

  private renderHover(operation: HoverOperation): void {
    if (!this.isCurrentHover(operation)) return
    if (!operation.revealed) return

    const hoverParts = operation.hovers.flatMap((hover) => {
      const text = hoverText(hover)
      return text ? [text] : []
    })
    const hasContent = hoverParts.length > 0 || operation.diagnostics.length > 0
    if (!hasContent && operation.pending && !operation.loading) return
    if (!hasContent && !operation.pending) return this.hideHover()

    const range = hoverRangeForOperation(operation)
    const rect = this.context.getRangeClientRect(range.start, range.end)
    if (!rect) return this.hideHover()

    this.tooltip.show({
      anchor: rect,
      hoverText: null,
      hoverParts,
      diagnostics: operation.diagnostics,
      theme: this.currentTheme,
      loading: operation.loading && operation.pending,
      focus: operation.focusOnShow && !operation.shown,
      preferredPlacement: 'top',
    })
    operation.shown = true
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
    this.cancelHoverOperation()
    this.tooltip.hide()
  }

  private cancelHoverOperation(): void {
    const operation = this.hoverOperation
    if (operation) this.clearHoverTimers(operation)
    this.hoverOperation = null
    this.hoverAbort?.abort()
    this.hoverAbort = null
    this.hoverRequestId += 1
  }

  private clearHoverTimers(operation: HoverOperation): void {
    if (operation.dispatchTimer) clearTimeout(operation.dispatchTimer)
    if (operation.revealTimer) clearTimeout(operation.revealTimer)
    if (operation.loadingTimer) clearTimeout(operation.loadingTimer)
    operation.dispatchTimer = null
    operation.revealTimer = null
    operation.loadingTimer = null
  }

  private currentHover(requestId: number): HoverOperation | null {
    const operation = this.hoverOperation
    if (!operation || operation.id !== requestId) return null
    if (operation.active !== this.options.getActiveDocument()) return null
    return operation
  }

  private isCurrentHover(operation: HoverOperation): boolean {
    return this.currentHover(operation.id) === operation
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

function hoverRangeForOperation(operation: HoverOperation): OffsetRange {
  for (const hover of operation.hovers) {
    const range = hoverRangeOffsets(operation.active.fullText, hover)
    if (range) return range
  }
  return operation.targetRange
}

function hoverTargetRange(text: string, offset: number): OffsetRange {
  return identifierRangeAtOffset(text, offset) ?? visibleRangeAtOffset(text, offset)
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

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (typeof error !== 'object' || error === null) return false
  return 'name' in error && error.name === 'LspRequestCancelledError'
}

function definitionLinkHighlightName(
  context: EditorViewContributionContext,
  options: HoverDefinitionControllerOptions,
): string {
  const prefix = context.highlightPrefix ?? options.defaultHighlightPrefix ?? 'editor-lsp-plugin'
  const namespace = options.linkHighlightNameNamespace ?? 'lsp-plugin'
  return `${prefix}-${namespace}-definition-link`
}
