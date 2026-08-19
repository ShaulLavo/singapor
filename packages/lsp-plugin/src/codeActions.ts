import type { TextEdit } from '@singapor/core'
import type {
  EditorCapabilityToken,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
} from '@singapor/core/extensions'
import type { LspClient } from '@singapor/lsp'
import { lspPositionToOffset, offsetToLspPosition } from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

import type { LanguageServerCompletionEditFeature } from './completion'
import type { OffsetRange } from './definitionNavigation'
import { formattingEdits } from './formatting'
import type { ActiveDocument } from './pluginTypes'
import {
  workspaceEditForDocument,
  workspaceEditPlan,
  workspaceEditTouchesOtherDocuments,
} from './workspaceEdit'

/**
 * Long enough that a held arrow key or a burst of typing asks once, short enough that the answer is
 * already there when the hand leaves the keyboard and reaches for the fix.
 */
const CODE_ACTION_DEBOUNCE_MS = 250

const CODE_ACTION_TRIGGER_AUTOMATIC = 2

/** Root of the kind subtree the auto fix draws from. */
const CODE_ACTION_QUICK_FIX_KIND = 'quickfix'

export type CodeActionResponse = readonly (lsp.Command | lsp.CodeAction)[] | null

/**
 * The one action `editor.action.autoFix` applies, or null when the answer holds none.
 *
 * Nothing else in the answer is kept. There is no menu to put a second candidate in, and a ranked
 * list no surface can draw would be a promise the editor does not keep.
 *
 * `isPreferred` is the server naming the action it would pick itself, and the first such is taken
 * rather than re-ordered: the order the answer arrived in is the only other ranking it gave us.
 * `resolvable` says whether the server fills an action's edit in on request — without that, one
 * that arrived carrying only a command is a fix this client has no way to carry out, and taking it
 * would swallow the chord to do nothing.
 */
export function preferredQuickFix(
  response: CodeActionResponse,
  resolvable: boolean,
): lsp.CodeAction | null {
  if (!response) return null

  for (const entry of response) {
    // A server that declines the literal form answers with bare commands, which carry neither a
    // kind nor a preference and so can never be the action asked for here.
    if (isCommand(entry)) continue
    if (entry.isPreferred !== true || entry.disabled) continue
    if (!resolvable && !entry.edit) continue
    if (!isQuickFixKind(entry.kind)) continue

    return entry
  }

  return null
}

/**
 * The range an automatic request asks about, or null when there is nothing at the caret to ask
 * about.
 *
 * A caret sitting between two blanks is inside indentation or trailing space, where no server has an
 * action to offer; asking anyway would spend a request per settled keystroke while a line is being
 * indented. A drawn selection always asks, because the user pointed at something.
 */
export function codeActionAutoTriggerRange(
  text: string,
  start: number,
  end: number,
): OffsetRange | null {
  if (start !== end) return { start, end }

  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const lineBreak = text.indexOf('\n', start)
  const lineEnd = lineBreak === -1 ? text.length : lineBreak
  if (lineEnd === lineStart) return null
  if (start === lineStart) return isWhitespace(text[lineStart]) ? null : { start, end }
  if (start === lineEnd) return isWhitespace(text[lineEnd - 1]) ? null : { start, end }

  return isWhitespace(text[start - 1]) && isWhitespace(text[start]) ? null : { start, end }
}

export type CodeActionControllerOptions = {
  readonly client: LspClient
  readonly context: EditorViewContributionContext
  readonly editFeature: EditorCapabilityToken<LanguageServerCompletionEditFeature>
  readonly getActiveDocument: () => ActiveDocument | null
  readonly getDiagnostics: () => readonly lsp.Diagnostic[]
  readonly onRequestError: (error: unknown) => void
}

/**
 * Keeps the fix available at the caret, and applies it on request.
 *
 * It is refreshed by a debounced oracle rather than fetched when the fix is asked for, because the
 * two events that change the answer — the caret moving and the server republishing diagnostics —
 * are exactly the two the user is waiting on: by the time a squiggle is visible under the caret, its
 * fix is already in hand. Anything that could invalidate it drops it first, so a stale answer is
 * never applied to text it was not computed against.
 */
export class CodeActionController {
  private fix: lsp.CodeAction | null = null
  private seenDiagnostics: readonly lsp.Diagnostic[] | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private abort: AbortController | null = null
  private requestId = 0
  private disposed = false

  public constructor(private readonly options: CodeActionControllerOptions) {}

  public update(kind: EditorViewContributionUpdateKind): void {
    if (kind === 'document' || kind === 'clear') {
      this.clear()
      return
    }
    if (kind !== 'selection' && kind !== 'content') return

    this.schedule()
  }

  /**
   * Reruns the oracle when the server republished the active document's diagnostics.
   *
   * Publishes the document sync refused — another file, or a version the buffer has moved past — leave
   * the list identical, and re-asking on those would answer for a document nobody is looking at.
   */
  public diagnosticsChanged(): void {
    const diagnostics = this.options.getDiagnostics()
    if (diagnostics === this.seenDiagnostics) return

    this.seenDiagnostics = diagnostics
    this.schedule()
  }

  /**
   * Applies the preferred quick fix at the caret.
   *
   * Reports handled as soon as the edit is on its way: an action the server has not filled in yet
   * needs a round trip, and returning false would let the keystroke fall through to another binding
   * after the fix was already committed to.
   */
  public applyAutoFix(): boolean {
    if (this.disposed) return false

    const active = this.options.getActiveDocument()
    if (!active) return false

    const fix = this.fix
    if (!fix) return false

    void this.runAction(active, fix)
    return true
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.clear()
  }

  private schedule(): void {
    this.clear()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.request()
    }, CODE_ACTION_DEBOUNCE_MS)
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.abort?.abort()
    this.abort = null
    this.requestId += 1
    this.fix = null
  }

  private async request(): Promise<void> {
    const active = this.options.getActiveDocument()
    if (!active) return
    if (!this.options.client.serverCapabilities?.codeActionProvider) return

    const selection = this.options.context.getSnapshot().selections[0]
    if (!selection) return

    const range = codeActionAutoTriggerRange(
      active.fullText,
      selection.startOffset,
      selection.endOffset,
    )
    if (!range) return

    const abort = new AbortController()
    const requestId = this.requestId + 1
    this.requestId = requestId
    this.abort = abort

    try {
      const response = await this.options.client.request<CodeActionResponse>(
        'textDocument/codeAction',
        {
          context: {
            diagnostics: diagnosticsOverlapping(
              active.fullText,
              this.options.getDiagnostics(),
              range,
            ),
            // The auto fix can apply nothing else, so asking for the wider hierarchy would make
            // every settled keystroke pay for refactors that are thrown away on arrival.
            only: [CODE_ACTION_QUICK_FIX_KIND],
            triggerKind: CODE_ACTION_TRIGGER_AUTOMATIC,
          },
          range: {
            end: offsetToLspPosition(active.fullText, range.end),
            start: offsetToLspPosition(active.fullText, range.start),
          },
          textDocument: { uri: active.uri },
        },
        { signal: abort.signal },
      )
      if (requestId !== this.requestId) return
      if (this.disposed) return
      if (active !== this.options.getActiveDocument()) return

      // Narrowed again on arrival, because `only` is a hint the server is free to ignore.
      this.fix = preferredQuickFix(response, this.resolvesActions())
    } catch (error) {
      this.options.onRequestError(error)
    }
  }

  private async runAction(active: ActiveDocument, action: lsp.CodeAction): Promise<void> {
    try {
      // Servers that compute fixes lazily answer the list with titles and a `data` handle alone, so
      // an edit that is missing here is one that has not been asked for yet.
      const resolved = action.edit
        ? action
        : ((await this.options.client.request<lsp.CodeAction>('codeAction/resolve', action)) ??
          action)
      if (this.disposed) return
      if (active !== this.options.getActiveDocument()) return

      this.applyAction(active, resolved)
    } catch (error) {
      this.options.onRequestError(error)
    }
  }

  private resolvesActions(): boolean {
    const provider = this.options.client.serverCapabilities?.codeActionProvider
    return typeof provider === 'object' && provider.resolveProvider === true
  }

  private applyAction(active: ActiveDocument, action: lsp.CodeAction): void {
    if (!action.edit) {
      // The server means to carry this one out itself, over a `workspace/executeCommand` round trip
      // this client has no half of. The chord was reported handled the moment the fix was chosen,
      // so saying so is all that stops it from looking like a keystroke the editor ate.
      this.options.onRequestError(
        new Error(
          `"${action.title}" is applied by a server command, which this editor cannot run.`,
        ),
      )
      return
    }

    const plan = workspaceEditPlan(action.edit)
    if (workspaceEditTouchesOtherDocuments(plan, active.uri)) {
      this.options.onRequestError(
        new Error(`"${action.title}" spans several files, which this editor cannot apply yet.`),
      )
      return
    }

    const edits = formattingEdits(active.fullText, workspaceEditForDocument(plan, active.uri))
    if (edits.length === 0) return

    this.applyEdits(edits)
  }

  private applyEdits(edits: readonly TextEdit[]): void {
    const feature = this.options.context.getFeature?.(this.options.editFeature)
    if (!feature) return

    // Pinned to its offset rather than mapped through the fix: a quick fix rewrites the text the
    // caret is sitting in, and the offset it was at is closer to what the user was looking at than
    // any position derived from the replacement.
    const head = this.options.context.getSnapshot().selections[0]?.headOffset ?? 0
    feature.applyCompletion({ edits, selection: { anchor: head, head } })
  }
}

/** A literal's own `command` is an object; only the bare form names its command with a string. */
function isCommand(entry: lsp.Command | lsp.CodeAction): entry is lsp.Command {
  return typeof (entry as lsp.Command).command === 'string'
}

/**
 * Whether `kind` is the quick-fix kind or sits beneath it in the dotted hierarchy.
 *
 * Containment, not equality: a server that names its actions precisely answers `quickfix.import`,
 * and comparing the strings whole would reject every one of those. An action that named no kind at
 * all placed itself nowhere, so it is not in this subtree either.
 */
function isQuickFixKind(kind: string | undefined): boolean {
  if (kind === undefined) return false

  return kind === CODE_ACTION_QUICK_FIX_KIND || kind.startsWith(`${CODE_ACTION_QUICK_FIX_KIND}.`)
}

function diagnosticsOverlapping(
  text: string,
  diagnostics: readonly lsp.Diagnostic[],
  range: OffsetRange,
): lsp.Diagnostic[] {
  return diagnostics.filter((diagnostic) => {
    const start = lspPositionToOffset(text, diagnostic.range.start)
    const end = lspPositionToOffset(text, diagnostic.range.end)
    return start <= range.end && end >= range.start
  })
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character)
}
