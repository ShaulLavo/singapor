import type { DocumentSessionChange } from '@singapor/core/document'
import type {
  EditorCapabilityToken,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import type * as lsp from 'vscode-languageserver-protocol'

import {
  COMPLETION_REQUEST_DEBOUNCE_MS,
  LANGUAGE_SERVER_COMPLETION_EDIT_FEATURE,
  completionAnchorRange,
  completionApplication,
  completionListResult,
  completionPrefix,
  completionTriggerFromChange,
  createCompletionWidgetController,
  rankCompletionItems,
  type CompletionListResult,
  type CompletionWidgetController,
  type LanguageServerCompletionEditFeature,
  type LanguageServerCompletionTrigger,
} from './completion'
import { completionCommitCharacter, completionCommitFeature } from './completionCommit'
import type {
  EditorCompletionAnswer,
  EditorCompletionRequest,
  EditorCompletionSource,
  EditorCompletionSourceSet,
} from './completionProviders'
import type { ActiveDocument } from './pluginTypes'

/**
 * A list on screen and the document frame its items were measured in.
 *
 * `active` and `offset` stay pinned to the request for as long as the session lives, because an
 * item's ranges are positions in that text and in no other. The word being typed is re-read from
 * each new snapshot instead, so the session can outlive the keystroke that asked for it.
 */
type CompletionSession = {
  readonly active: ActiveDocument
  readonly offset: number
  readonly wordStart: number
  readonly items: readonly lsp.CompletionItem[]
  readonly isIncomplete: boolean
}

/** The word the caret sits in, as the snapshot being handled has it. */
// Longer than any identifier a completion prefix could be read from, so the window never truncates
// a word the caret is standing in.
const COMPLETION_PREFIX_WINDOW = 512

type CompletionCaret = {
  // The document's length rather than its text: what the caret is measured against is how far the
  // text extends, and reading the text itself would put a copy of the document on every keystroke.
  readonly length: number
  readonly offset: number
  readonly wordStart: number
  readonly prefix: string
}

/** One accepted item, measured against the document and caret at the moment of acceptance. */
type CompletionAcceptance = {
  readonly session: CompletionSession
  readonly document: ActiveDocument
  readonly caretOffset: number
}

export type CompletionControllerOptions = {
  readonly context: EditorViewContributionContext
  readonly completionSources: EditorCompletionSourceSet
  readonly completionEditFeature?: EditorCapabilityToken<LanguageServerCompletionEditFeature>
  readonly completionWidgetClassNamespace?: string
  readonly completionAcceptOnCommitCharacter?: boolean
  getActiveDocument(): ActiveDocument | null
  ignorePointerTarget(target: EventTarget | null): boolean
  onBeforeShow(): void
  onRequestSuccess?(): void
  onRequestError(error: unknown): void
}

export class CompletionController {
  private readonly context: EditorViewContributionContext
  private readonly completion: CompletionWidgetController
  // Which source an item came from, kept beside the list rather than on the items: the items are
  // the sources' own objects, and one of them goes back to its source to be resolved.
  private readonly itemSources = new WeakMap<lsp.CompletionItem, EditorCompletionSource>()
  private completionTimer: ReturnType<typeof setTimeout> | null = null
  private completionAbort: AbortController | null = null
  private completionRequestId = 0
  private completionSession: CompletionSession | null = null
  private caret: CompletionCaret | null = null
  private languageId: EditorViewSnapshot['languageId'] = null
  private disposed = false

  public constructor(private readonly options: CompletionControllerOptions) {
    this.context = options.context
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
    // A session's offsets are all read from these snapshots, and the distance between the request
    // and the acceptance is only a distance if both ends were measured on the same clock.
    const caret = completionCaret(snapshot)
    this.caret = caret
    // Which sources answer is the document's language to decide, and a request outlives the update
    // that scheduled it.
    this.languageId = snapshot.languageId
    if (kind === 'document' || kind === 'clear') {
      this.hide()
      return
    }
    if (kind === 'tokens') return
    if (kind !== 'content') {
      if (!this.reanchorSession()) this.hide()
      return
    }

    if (this.refreshSession()) return

    this.hide()
    const trigger = completionTriggerFromChange(change)
    if (!trigger || !caret) return

    this.scheduleCompletion(caret.offset, trigger)
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

  /**
   * Re-shows the live list against the word as it now stands, or reports that there is no longer a
   * session to show.
   *
   * The word the request was made for is what a session is about: while the caret stays inside it
   * every further character is more of the same question, so the answer is narrowed rather than
   * asked again. Failing here is the signal to cancel — the caret has left the word, or something
   * other than the typing moved the text the item ranges were measured in.
   */
  private refreshSession(): boolean {
    const session = this.completionSession
    const caret = this.caret
    if (!session || !caret) return false
    if (!completionSessionSurvives(session, caret)) return false

    const ranked = rankCompletionItems(session.items, caret.prefix)
    if (ranked.length === 0) return false

    // Every character narrows a truncated answer further away from being one, so this is the case
    // worth another round-trip — and the list already on screen stays up while it is in flight.
    if (session.isIncomplete) this.scheduleCompletion(caret.offset, { triggerKind: 3 })

    return this.showRankedItems(ranked, caret)
  }

  /**
   * Moves the live list to where the caret is drawn now, or reports that there is none to move.
   *
   * Reached when the view moved without the text or the caret doing so — a scroll, a resize, an
   * overlay claiming width. The widget is placed in viewport coordinates, so it has to follow;
   * nothing about the items can have changed, so re-filtering and rebuilding the rows on every
   * scroll frame would be work for nothing.
   */
  private reanchorSession(): boolean {
    const caret = this.caret
    if (!this.completionSession || !caret) return false
    if (!completionSessionSurvives(this.completionSession, caret)) return false

    const rect = this.sessionAnchorRect(caret)
    if (!rect) return false

    this.completion.reanchor(rect)
    return true
  }

  private showRankedItems(ranked: readonly lsp.CompletionItem[], caret: CompletionCaret): boolean {
    const rect = this.sessionAnchorRect(caret)
    if (!rect) return false

    const items = ranked.slice(0, 100)
    this.options.onBeforeShow()
    this.completion.show({
      anchor: rect,
      items,
      selectedIndex: focusedCompletionIndex(items, this.completion.selectedItem()),
    })
    return true
  }

  private sessionAnchorRect(caret: CompletionCaret): DOMRect | null {
    const range = completionAnchorRange(caret.length, caret.offset)
    return this.context.getRangeClientRect(range.start, range.end)
  }

  private scheduleCompletion(offset: number, trigger: LanguageServerCompletionTrigger): void {
    const active = this.options.getActiveDocument()
    if (!active) return

    this.cancelCompletionRequest()
    this.completionTimer = setTimeout(() => {
      this.completionTimer = null
      this.requestCompletion(active, offset, trigger)
    }, COMPLETION_REQUEST_DEBOUNCE_MS)
  }

  private requestManualCompletion(): void {
    const active = this.options.getActiveDocument()
    const caret = this.caret
    if (!active || !caret) return this.hide()

    this.cancelCompletionRequest()
    this.requestCompletion(active, caret.offset, { triggerKind: 1 })
  }

  private requestCompletion(
    active: ActiveDocument,
    offset: number,
    trigger: LanguageServerCompletionTrigger,
  ): void {
    this.completionAbort?.abort()
    const requestId = this.completionRequestId + 1
    const abort = new AbortController()
    this.completionRequestId = requestId
    this.completionAbort = abort

    const sources = this.options.completionSources.forLanguage(this.languageId)
    const request: EditorCompletionRequest = {
      uri: active.uri,
      text: active.fullText,
      offset,
      trigger,
      signal: abort.signal,
    }
    // Asked at once and shown once every one of them has answered, so the reader is not made to
    // choose from a list that is still growing under the cursor. Settled rather than all: a source
    // that fails takes itself out of the list and nothing else with it.
    void Promise.allSettled(sources.map((source) => this.askSource(source, request))).then(
      (answers) =>
        this.renderCompletionResult(requestId, active, offset, this.mergeAnswers(sources, answers)),
    )
  }

  private askSource(
    source: EditorCompletionSource,
    request: EditorCompletionRequest,
  ): PromiseLike<EditorCompletionAnswer> | EditorCompletionAnswer {
    try {
      return source.provideCompletionItems(request)
    } catch (error) {
      // A source that throws where it should have rejected is still only one source failing.
      return Promise.reject(error)
    }
  }

  private mergeAnswers(
    sources: readonly EditorCompletionSource[],
    answers: readonly PromiseSettledResult<EditorCompletionAnswer>[],
  ): CompletionListResult {
    const items: lsp.CompletionItem[] = []
    let isIncomplete = false
    for (const [index, answer] of answers.entries()) {
      if (answer.status === 'rejected') {
        this.options.onRequestError(answer.reason)
        continue
      }

      this.options.onRequestSuccess?.()
      const result = completionListResult(answer.value ?? null)
      const source = sources[index]
      for (const item of result.items) {
        if (source) this.itemSources.set(item, source)
        items.push(item)
      }
      // One truncated answer is enough to make the merged list one: the word growing sends every
      // source back to the question, not only the one that said so.
      if (result.isIncomplete) isIncomplete = true
    }

    return { items, isIncomplete }
  }

  private renderCompletionResult(
    requestId: number,
    active: ActiveDocument,
    offset: number,
    result: CompletionListResult,
  ): void {
    if (requestId !== this.completionRequestId) return
    if (active !== this.options.getActiveDocument()) return
    if (result.items.length === 0) return this.hide()

    // Every path that moves the text or the caret between the request and its answer cancels the
    // request too, so this caret is the one the request was measured against.
    const caret = this.caret
    if (!caret) return this.hide()

    const ranked = rankCompletionItems(result.items, caret.prefix)
    if (ranked.length === 0) return this.hide()

    this.completionSession = {
      active,
      offset,
      // The word the answer is about, which is what a session lives or dies by from here on.
      wordStart: caret.wordStart,
      items: result.items,
      isIncomplete: result.isIncomplete,
    }
    if (!this.showRankedItems(ranked, caret)) this.hide()
  }

  private acceptCompletion(commitCharacter: string | null = null): boolean {
    const session = this.completionSession
    const item = this.completion.selectedItem()
    if (!session || !item) return false

    const acceptance = this.completionAcceptance(session)
    if (!acceptance) return false

    const editFeature = this.completionEditFeature()
    if (!editFeature) return false

    const feature = completionCommitFeature(editFeature, commitCharacter)
    // Asked of the source that sent this item, so an item from a source that sends whole ones is
    // applied as it stands even while another source in the same list is still sending stubs.
    const pending = this.itemSources.get(item)?.resolveCompletionItem?.(item) ?? null

    this.hide()
    if (pending) {
      void this.applyResolvedCompletion(acceptance, item, pending, feature)
      return true
    }

    return this.applyCompletionItem(acceptance, item, feature)
  }

  /**
   * What the accepted item is applied against, or null when the list no longer belongs to the
   * document on screen.
   *
   * Document identity would be too strict a test: every keystroke rebuilds the active document, and
   * typing while the list is up is exactly the case the caret is captured for.
   */
  private completionAcceptance(session: CompletionSession): CompletionAcceptance | null {
    const document = this.options.getActiveDocument()
    if (!document || document.uri !== session.active.uri) return null
    if (!this.caret) return null

    return { session, document, caretOffset: this.caret.offset }
  }

  private async applyResolvedCompletion(
    acceptance: CompletionAcceptance,
    item: lsp.CompletionItem,
    pending: PromiseLike<lsp.CompletionItem>,
    feature: LanguageServerCompletionEditFeature,
  ): Promise<void> {
    let resolved = item
    try {
      resolved = await pending
      this.options.onRequestSuccess?.()
    } catch (error) {
      // A server that cannot resolve should still get its completion applied, unresolved.
      this.options.onRequestError(error)
    }

    // The caret was read before the round-trip, so a document that moved during it would be edited
    // against measurements taken of the text it no longer holds.
    if (acceptance.document !== this.options.getActiveDocument()) return

    this.applyCompletionItem(acceptance, resolved, feature)
  }

  private applyCompletionItem(
    acceptance: CompletionAcceptance,
    item: lsp.CompletionItem,
    feature: LanguageServerCompletionEditFeature,
  ): boolean {
    const application = completionApplication(
      {
        text: acceptance.session.active.fullText,
        offset: acceptance.session.offset,
        caretOffset: acceptance.caretOffset,
      },
      item,
    )
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
    const commitCharacter = completionCommitCharacter(
      event,
      this.completion.selectedItem(),
      this.options.completionAcceptOnCommitCharacter === true,
    )
    if (commitCharacter !== null) {
      // Swallowed only once the item is in: an acceptance that could not be applied still owes the
      // reader the character they typed, and taking the key first would eat it on the way out.
      if (this.acceptCompletion(commitCharacter)) this.consumeCompletionKey(event)
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

/**
 * Where the row the user was reading goes in a list that has just been rebuilt.
 *
 * A truncated list is asked again while it is on screen, and the answer arrives as items of its own,
 * so the choice has to be recognised by label rather than by identity. Dropping back to the top would
 * take the arrow keys away from the user between one keystroke and the next.
 */
function focusedCompletionIndex(
  items: readonly lsp.CompletionItem[],
  focused: lsp.CompletionItem | null,
): number {
  if (!focused) return 0

  return Math.max(
    0,
    items.findIndex((item) => item.label === focused.label),
  )
}

function completionCaret(snapshot: EditorViewSnapshot): CompletionCaret | null {
  const selection = snapshot.selections[0]
  if (!selection) return null
  if (selection.startOffset !== selection.endOffset) return null

  const offset = selection.headOffset
  const source = snapshot.textSnapshot
  // A word ends where the caret is, so the window behind it is the whole of what a prefix can be
  // read from. No identifier reaches the end of it.
  const windowStart = Math.max(0, offset - COMPLETION_PREFIX_WINDOW)
  const before = source
    ? source.readRange(windowStart, offset)
    : snapshot.fullText.slice(windowStart, offset)
  const length = source ? source.length : snapshot.fullText.length
  const prefix = completionPrefix(before, before.length)
  return { length, offset, wordStart: offset - prefix.length, prefix }
}

/**
 * Whether the list still describes what the user is doing.
 *
 * A word start that has moved means the caret is in a different word than the one asked about — a
 * new identifier, a trigger character, an outdent, or a foreign edit above the caret. A document
 * whose length no longer accounts for exactly where the caret went means something other than the
 * typing changed the text, and the item ranges — offsets into the text the request captured — would
 * be applied to text that moved underneath them. Backing out of the word entirely ends it too,
 * while backspacing to a shorter prefix inside it does not.
 */
function completionSessionSurvives(session: CompletionSession, caret: CompletionCaret): boolean {
  if (caret.wordStart !== session.wordStart) return false
  if (caret.prefix.length === 0 && caret.offset < session.offset) return false

  return caret.length - session.active.fullText.length === caret.offset - session.offset
}

function isCompletionManualTrigger(event: KeyboardEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false
  return event.key === ' ' || event.code === 'Space'
}
