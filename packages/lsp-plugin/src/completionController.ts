import type { DocumentSessionChange } from '@singapor/core/document'
import type {
  EditorCapabilityToken,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import { offsetToLspPosition, type LspClient } from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

import {
  COMPLETION_REQUEST_DEBOUNCE_MS,
  LANGUAGE_SERVER_COMPLETION_EDIT_FEATURE,
  completionAnchorRange,
  completionApplication,
  completionItems,
  completionNeedsResolve,
  completionTriggerFromChange,
  createCompletionWidgetController,
  type CompletionWidgetController,
  type LanguageServerCompletionEditFeature,
  type LanguageServerCompletionTrigger,
} from './completion'
import type { ActiveDocument } from './pluginTypes'

type CompletionSession = {
  readonly active: ActiveDocument
  readonly offset: number
}

export type CompletionControllerOptions = {
  readonly context: EditorViewContributionContext
  readonly client: LspClient
  readonly completionEditFeature?: EditorCapabilityToken<LanguageServerCompletionEditFeature>
  readonly completionWidgetClassNamespace?: string
  getActiveDocument(): ActiveDocument | null
  ignorePointerTarget(target: EventTarget | null): boolean
  onBeforeShow(): void
  onRequestSuccess?(): void
  onRequestError(error: unknown): void
}

export class CompletionController {
  private readonly context: EditorViewContributionContext
  private readonly client: LspClient
  private readonly completion: CompletionWidgetController
  private completionTimer: ReturnType<typeof setTimeout> | null = null
  private completionAbort: AbortController | null = null
  private completionRequestId = 0
  private completionSession: CompletionSession | null = null
  private disposed = false

  public constructor(private readonly options: CompletionControllerOptions) {
    this.context = options.context
    this.client = options.client
    this.completion = createCompletionWidgetController({
      document: this.context.container.ownerDocument,
      themeSource: this.context.scrollElement,
      classNamespace: options.completionWidgetClassNamespace,
      onSelect: () => {
        this.acceptCompletion()
      },
    })
    this.installHandlers()
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null,
  ): void {
    if (kind === 'document' || kind === 'clear') {
      this.hide()
      return
    }
    if (kind === 'selection' || kind === 'viewport' || kind === 'layout') {
      this.hide()
      return
    }
    if (kind !== 'content') return

    const trigger = completionTriggerFromChange(change)
    if (!trigger) {
      this.hide()
      return
    }

    this.scheduleCompletion(snapshot, trigger)
  }

  public hide(): void {
    this.cancelCompletionRequest()
    this.completionSession = null
    this.completion.hide()
  }

  public containsTarget(target: EventTarget | null): boolean {
    return this.completion.containsTarget(target)
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.uninstallHandlers()
    this.hide()
    this.completion.dispose()
  }

  private installHandlers(): void {
    this.context.scrollElement.addEventListener('keydown', this.handleCompletionKeyDown, {
      capture: true,
    })
    this.context.container.ownerDocument.addEventListener(
      'pointerdown',
      this.handleDocumentPointerDown,
      { capture: true },
    )
  }

  private uninstallHandlers(): void {
    this.context.scrollElement.removeEventListener('keydown', this.handleCompletionKeyDown, {
      capture: true,
    })
    this.context.container.ownerDocument.removeEventListener(
      'pointerdown',
      this.handleDocumentPointerDown,
      { capture: true },
    )
  }

  private scheduleCompletion(
    snapshot: EditorViewSnapshot,
    trigger: LanguageServerCompletionTrigger,
  ): void {
    const active = this.options.getActiveDocument()
    if (!active || !this.client.initialized) return this.hide()

    const selection = primaryCollapsedSelection(snapshot)
    if (!selection) return this.hide()

    const offset = selection.headOffset
    this.cancelCompletionRequest()
    this.completionTimer = setTimeout(() => {
      this.completionTimer = null
      void this.requestCompletion(active, offset, trigger)
    }, COMPLETION_REQUEST_DEBOUNCE_MS)
  }

  private requestManualCompletion(): void {
    const active = this.options.getActiveDocument()
    if (!active || !this.client.initialized) return this.hide()

    const selection = primaryCollapsedSelection(this.context.getSnapshot())
    if (!selection) return this.hide()

    this.cancelCompletionRequest()
    void this.requestCompletion(active, selection.headOffset, { triggerKind: 1 })
  }

  private async requestCompletion(
    active: ActiveDocument,
    offset: number,
    trigger: LanguageServerCompletionTrigger,
  ): Promise<void> {
    this.completionAbort?.abort()
    const requestId = this.completionRequestId + 1
    const abort = new AbortController()
    this.completionRequestId = requestId
    this.completionAbort = abort

    try {
      const result = await this.client.request<
        lsp.CompletionList | readonly lsp.CompletionItem[] | null
      >(
        'textDocument/completion',
        {
          textDocument: { uri: active.uri },
          position: offsetToLspPosition(active.fullText, offset),
          context: trigger,
        } satisfies lsp.CompletionParams,
        { signal: abort.signal },
      )
      this.options.onRequestSuccess?.()
      this.renderCompletionResult(requestId, active, offset, completionItems(result))
    } catch (error) {
      this.options.onRequestError(error)
    }
  }

  private renderCompletionResult(
    requestId: number,
    active: ActiveDocument,
    offset: number,
    items: readonly lsp.CompletionItem[],
  ): void {
    if (requestId !== this.completionRequestId) return
    if (active !== this.options.getActiveDocument()) return
    if (items.length === 0) return this.hide()

    const range = completionAnchorRange(active.fullText, offset)
    const rect = this.context.getRangeClientRect(range.start, range.end)
    if (!rect) return this.hide()

    this.options.onBeforeShow()
    this.completionSession = { active, offset }
    this.completion.show({
      anchor: rect,
      items: items.slice(0, 100),
    })
  }

  private acceptCompletion(): boolean {
    const session = this.completionSession
    const item = this.completion.selectedItem()
    if (!session || !item) return false
    if (session.active !== this.options.getActiveDocument()) return false

    const feature = this.completionEditFeature()
    if (!feature) return false

    this.hide()
    // Most servers send an item without its import edit and expect a resolve round-trip; applying
    // the unresolved item is what silently drops auto-imports.
    if (completionNeedsResolve(item, this.client.serverCapabilities)) {
      void this.applyResolvedCompletion(session, item, feature)
      return true
    }

    return this.applyCompletionItem(session, item, feature)
  }

  private async applyResolvedCompletion(
    session: CompletionSession,
    item: lsp.CompletionItem,
    feature: LanguageServerCompletionEditFeature,
  ): Promise<void> {
    let resolved = item
    try {
      resolved = await this.client.request<lsp.CompletionItem>('completionItem/resolve', item)
      this.options.onRequestSuccess?.()
    } catch (error) {
      // A server that cannot resolve should still get its completion applied, unresolved.
      this.options.onRequestError(error)
    }

    // The document can move between accepting and resolving; applying then would edit the wrong
    // text at the wrong offset.
    if (session.active !== this.options.getActiveDocument()) return

    this.applyCompletionItem(session, resolved, feature)
  }

  private applyCompletionItem(
    session: CompletionSession,
    item: lsp.CompletionItem,
    feature: LanguageServerCompletionEditFeature,
  ): boolean {
    const application = completionApplication(session.active.fullText, session.offset, item)
    if (!application) return false

    return feature.applyCompletion(application)
  }

  private completionEditFeature(): LanguageServerCompletionEditFeature | null {
    const token = this.options.completionEditFeature ?? LANGUAGE_SERVER_COMPLETION_EDIT_FEATURE
    return this.context.getFeature?.(token) ?? null
  }

  private cancelCompletionRequest(): void {
    if (this.completionTimer) clearTimeout(this.completionTimer)
    this.completionTimer = null
    this.completionAbort?.abort()
    this.completionAbort = null
    this.completionRequestId += 1
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    if (this.completion.containsTarget(event.target)) return
    if (this.options.ignorePointerTarget(event.target)) return

    this.hide()
  }

  private readonly handleCompletionKeyDown = (event: KeyboardEvent): void => {
    if (isCompletionManualTrigger(event)) {
      this.consumeCompletionKey(event)
      this.requestManualCompletion()
      return
    }
    if (!this.completion.isVisible()) return

    if (event.key === 'ArrowDown') {
      this.consumeCompletionKey(event)
      this.completion.moveSelection(1)
      return
    }
    if (event.key === 'ArrowUp') {
      this.consumeCompletionKey(event)
      this.completion.moveSelection(-1)
      return
    }
    if (event.key === 'PageDown') {
      this.consumeCompletionKey(event)
      this.completion.moveSelection(8)
      return
    }
    if (event.key === 'PageUp') {
      this.consumeCompletionKey(event)
      this.completion.moveSelection(-8)
      return
    }
    if (event.key === 'Escape') {
      this.consumeCompletionKey(event)
      this.hide()
      return
    }
    if (event.key !== 'Enter' && event.key !== 'Tab') return

    this.consumeCompletionKey(event)
    this.acceptCompletion()
  }

  private consumeCompletionKey(event: KeyboardEvent): void {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}

function primaryCollapsedSelection(
  snapshot: EditorViewSnapshot,
): EditorViewSnapshot['selections'][number] | null {
  const selection = snapshot.selections[0]
  if (!selection) return null
  if (selection.startOffset !== selection.endOffset) return null
  return selection
}

function isCompletionManualTrigger(event: KeyboardEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false
  return event.key === ' ' || event.code === 'Space'
}
