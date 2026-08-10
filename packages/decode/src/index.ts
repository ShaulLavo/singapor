import type {
  EditorPlugin,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import {
  resolveDecodeOptions,
  type DecodePluginOptions,
  type ResolvedDecodeOptions,
} from './options'
import { ACTIVE_CLASS, collectRevealRows } from './rows'
import { runReveal, type RevealHandle } from './reveal'
import { runDiffusion } from './diffusion'
import './style.css'

export type { DecodeMode, DecodePluginOptions } from './options'

// How long to wait for syntax tokens before revealing anyway (e.g. plaintext,
// which never tokenizes). Keeps the reveal syntax-coloured without hanging.
const TOKENS_WAIT_MS = 200
const INPUT_EVENTS = ['keydown', 'pointerdown', 'wheel'] as const

/**
 * File-open "writes itself" animation. Including this plugin turns the effect on;
 * removing it turns it off. There is no command, setting, or UI — presence is the switch.
 */
export function createDecodePlugin(options: DecodePluginOptions = {}): EditorPlugin {
  const resolved = resolveDecodeOptions(options)
  return {
    name: 'editor.decode',
    activate: (context) =>
      context.registerViewContribution({
        createContribution: (viewContext) => new DecodeViewContribution(viewContext, resolved),
      }),
  }
}

class DecodeViewContribution implements EditorViewContribution {
  private animatedDocumentId: string | null = null
  private pendingDocumentId: string | null = null
  private reveal: RevealHandle | null = null
  private tokensTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  public constructor(
    private readonly context: EditorViewContributionContext,
    private readonly options: ResolvedDecodeOptions,
  ) {}

  public update(snapshot: EditorViewSnapshot, kind: EditorViewContributionUpdateKind): void {
    if (this.disposed) return
    if (reducedMotion(this.context)) return

    if (kind === 'document') {
      this.handleDocumentOpen(snapshot)
      return
    }
    // Later ticks (notably 'tokens') are how a reveal that is waiting for
    // syntax colours actually starts.
    if (this.pendingDocumentId !== null) this.maybeStart(snapshot, false)
  }

  public dispose(): void {
    this.disposed = true
    this.teardown()
  }

  private handleDocumentOpen(snapshot: EditorViewSnapshot): void {
    const documentId = snapshot.documentId
    if (!documentId || documentId === this.animatedDocumentId) return
    if (snapshot.fullText.length === 0) return

    // A fresh document supersedes any in-flight reveal.
    this.teardown()
    this.animatedDocumentId = documentId
    this.pendingDocumentId = documentId

    // Hide the real rows immediately (CSS clip) so there is no flash of the
    // fully-painted file before the reveal — even while we wait for tokens.
    this.context.scrollElement.classList.add(ACTIVE_CLASS)
    this.tokensTimer = setTimeout(
      () => this.maybeStart(this.context.getSnapshot(), true),
      TOKENS_WAIT_MS,
    )

    // Cached/already-tokenized documents can start right away.
    this.maybeStart(snapshot, false)
  }

  /** Start once the rows exist and (tokens are painted OR we have waited enough). */
  private maybeStart(snapshot: EditorViewSnapshot, force: boolean): void {
    if (this.pendingDocumentId === null) return
    if (snapshot.documentId !== this.pendingDocumentId) return
    if (!force && snapshot.tokens.length === 0) return

    const rows = collectRevealRows(this.context, snapshot, this.options.maxRows)
    if (rows.length === 0) {
      if (force) this.teardown() // gave up waiting and there is nothing to reveal
      return
    }

    this.clearTokensTimer()
    this.pendingDocumentId = null
    this.beginReveal(snapshot, rows)
  }

  private beginReveal(
    snapshot: EditorViewSnapshot,
    rows: ReturnType<typeof collectRevealRows>,
  ): void {
    this.addInputListeners()
    this.context.log?.({
      level: 'info',
      action: 'decode.reveal',
      mode: this.options.mode,
      lineCount: rows.length,
      languageId: snapshot.languageId,
      tokenized: snapshot.tokens.length > 0,
    })
    this.reveal = this.startEngine(snapshot, rows)
  }

  private startEngine(
    snapshot: EditorViewSnapshot,
    rows: ReturnType<typeof collectRevealRows>,
  ): RevealHandle {
    const onDone = () => this.teardown()
    // Scale the timings by the speed option here, so the engines stay unaware of
    // the speed concept — they just get faster numbers.
    const options = scaleTimings(this.options, this.options.speed)
    // Diffusion keeps the real rows clipped-hidden (like the clip family) and
    // reveals a colour-faithful scramble overlay instead; the real rows are
    // un-clipped only at completion in `teardown`.
    if (options.mode === 'diffusion') {
      return runDiffusion(this.context, rows, snapshot.tokens, options, onDone)
    }
    return runReveal(this.context, rows, options, onDone)
  }

  /**
   * Tear everything down (natural completion, input cancel, new document, dispose).
   * Remove the hide class *before* cancelling the animations so a row never flips
   * hidden→shown between the two operations.
   */
  private teardown(): void {
    this.clearTokensTimer()
    this.removeInputListeners()
    this.pendingDocumentId = null
    this.context.scrollElement.classList.remove(ACTIVE_CLASS)
    this.reveal?.cancel()
    this.reveal = null
  }

  private clearTokensTimer(): void {
    if (this.tokensTimer === null) return
    clearTimeout(this.tokensTimer)
    this.tokensTimer = null
  }

  private readonly cancelOnInput = (): void => this.teardown()

  private addInputListeners(): void {
    for (const type of INPUT_EVENTS) {
      this.context.scrollElement.addEventListener(type, this.cancelOnInput, { capture: true })
    }
  }

  private removeInputListeners(): void {
    for (const type of INPUT_EVENTS) {
      this.context.scrollElement.removeEventListener(type, this.cancelOnInput, { capture: true })
    }
  }
}

// Divide every time field by the multiplier (speed > 1 ⇒ shorter ⇒ faster).
// `mode`/`maxRows` are not timings, so they pass through unchanged.
function scaleTimings(options: ResolvedDecodeOptions, speed: number): ResolvedDecodeOptions {
  return {
    ...options,
    perCharMs: options.perCharMs / speed,
    perTokenMs: options.perTokenMs / speed,
    maxDurationMs: options.maxDurationMs / speed,
    staggerMs: options.staggerMs / speed,
  }
}

function reducedMotion(context: EditorViewContributionContext): boolean {
  const view = context.scrollElement.ownerDocument.defaultView
  return view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
