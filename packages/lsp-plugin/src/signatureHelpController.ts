import type * as lsp from 'vscode-languageserver-protocol'

import type {
  EditorTheme,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapor/core'
import type { DocumentSessionChange } from '@singapor/core'
import { offsetToLspPosition } from '@singapor/lsp'

import { anchoredSurfaceFollowsUpdate } from './anchoredSurface'
import type { ActiveDocument } from './pluginTypes'
import type { LanguageServerFeatureRouter } from './serverSet'
import {
  formatSignatureHelp,
  nextSignatureIndex,
  signatureHelpTriggerFromChange,
  type SignatureHelpDisplay,
} from './signatureHelp'
import { createTooltipController, type TooltipController } from './tooltip'

export type SignatureHelpControllerOptions = {
  readonly context: EditorViewContributionContext
  readonly router: LanguageServerFeatureRouter
  readonly getActiveDocument: () => ActiveDocument | null
  readonly tooltipClassNamespace?: string
  readonly onRequestSuccess?: () => void
  readonly onRequestError: (error: unknown) => void
}

/**
 * Shows the signature of the call the caret is inside, requested when an argument list opens or the
 * caret moves to the next argument.
 *
 * Reuses the hover tooltip rather than introducing a second floating surface, so signature text
 * inherits the same theming, markdown rendering, and placement behaviour.
 */
export class SignatureHelpController {
  private readonly context: EditorViewContributionContext
  private readonly tooltip: TooltipController
  private abort: AbortController | null = null
  private requestId = 0
  private currentTheme: EditorTheme | null = null
  private lastHelp: lsp.SignatureHelp | null = null
  private display: SignatureHelpDisplay | null = null
  private disposed = false

  public constructor(private readonly options: SignatureHelpControllerOptions) {
    this.context = options.context
    this.tooltip = createTooltipController({
      classNamespace: options.tooltipClassNamespace ?? 'lsp-plugin',
      document: this.context.container.ownerDocument,
      reentryElement: this.context.scrollElement,
      themeSource: this.context.scrollElement,
    })
    this.context.scrollElement.addEventListener('keydown', this.handleKeyDown, { capture: true })
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null,
  ): void {
    this.currentTheme = snapshot.theme ?? null
    if (kind === 'document' || kind === 'clear') {
      this.hide()
      return
    }
    if (anchoredSurfaceFollowsUpdate(kind)) {
      this.reanchor()
      return
    }
    if (kind !== 'content') return

    const trigger = signatureHelpTriggerFromChange(change)
    if (!trigger) return
    if (trigger.kind === 'close') {
      this.hide()
      return
    }

    void this.request(trigger.triggerCharacter)
  }

  public hide(): void {
    this.abort?.abort()
    this.abort = null
    this.lastHelp = null
    this.display = null
    this.tooltip.hide()
  }

  public containsTarget(target: EventTarget | null): boolean {
    return this.tooltip.containsTarget(target)
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.context.scrollElement.removeEventListener('keydown', this.handleKeyDown, { capture: true })
    this.hide()
    this.tooltip.dispose()
  }

  /** Escape dismisses; Up/Down cycle overloads while the widget is showing several. */
  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.display) return

    if (event.key === 'Escape') {
      this.hide()
      return
    }
    if (this.display.signatureCount < 2) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return

    const delta = event.key === 'ArrowDown' ? 1 : -1
    event.preventDefault()
    event.stopPropagation()
    this.showSignature(
      nextSignatureIndex(this.display.activeSignature, this.display.signatureCount, delta),
    )
  }

  private async request(triggerCharacter: '(' | ','): Promise<void> {
    const active = this.options.getActiveDocument()
    const selection = this.context.getSnapshot().selections[0]
    if (!active || !selection) {
      this.hide()
      return
    }
    if (!this.options.router.hasReady('signatureHelp', 'textDocument/signatureHelp')) return

    this.abort?.abort()
    const abort = new AbortController()
    const requestId = this.requestId + 1
    this.requestId = requestId
    this.abort = abort

    try {
      const help = await this.options.router.request<lsp.SignatureHelp | null>(
        'textDocument/signatureHelp',
        {
          context: { isRetrigger: false, triggerCharacter, triggerKind: 2 },
          position: offsetToLspPosition(active.fullText, selection.headOffset),
          textDocument: { uri: active.uri },
        },
        { signal: abort.signal },
      )
      this.options.onRequestSuccess?.()
      // A newer request, a document swap, or a teardown between send and receive all mean this
      // answer describes a call the caret is no longer in.
      if (requestId !== this.requestId) return
      if (this.disposed) return
      if (active !== this.options.getActiveDocument()) return

      this.lastHelp = help ?? null
      this.showSignature(help?.activeSignature ?? 0)
    } catch (error) {
      this.options.onRequestError(error)
    }
  }

  private showSignature(signatureIndex: number): void {
    const display = formatSignatureHelp(this.lastHelp, signatureIndex)
    this.display = display
    if (!display) {
      this.tooltip.hide()
      return
    }

    const anchor = this.caretAnchor()
    if (!anchor) {
      this.tooltip.hide()
      return
    }

    this.tooltip.show({
      anchor,
      diagnostics: [],
      hoverText: display.markdown,
      // Above the caret: the argument being typed sits below it, and covering that is the one
      // thing the widget must not do.
      preferredPlacement: 'top',
      theme: this.currentTheme,
    })
  }

  /**
   * Follows the caret when the view moves under the signature.
   *
   * The call being typed is where the signature belongs, and a caret that has scrolled out of the
   * rendered rows has no rect to belong to any more — leaving the widget parked over unrelated code
   * is worse than losing it, and the next keystroke in the argument list asks for it again.
   */
  private reanchor(): void {
    if (!this.display) return

    const anchor = this.caretAnchor()
    if (!anchor) {
      this.hide()
      return
    }

    this.tooltip.reanchor(anchor)
  }

  private caretAnchor(): DOMRect | null {
    const selection = this.context.getSnapshot().selections[0]
    if (!selection) return null

    return this.context.getRangeClientRect(selection.headOffset, selection.headOffset)
  }
}
