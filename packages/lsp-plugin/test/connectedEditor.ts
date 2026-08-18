/*
 * An editor with a language server behind it, for the suites that cannot ask a completion question
 * without one: the answer arrives over a wire, is drawn into the page, and is steered by keystrokes.
 *
 * It lives in one module rather than one per suite because a copied harness drifts from its
 * original, and a drifted harness lets two suites disagree about what the editor does while both
 * stay green.
 */

import type { DocumentSessionChange, TextEdit } from '@singapor/core/document'
import type {
  EditorEditContributionContext,
  EditorPluginContext,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import type { LspManagedTransport, LspTransportHandler } from '@singapor/lsp'
import { vi } from 'vitest'
import type * as lsp from 'vscode-languageserver-protocol'

import { createLanguageServerAdapterPlugin } from '../src/plugin'

type JsonMessage = Record<string, unknown>

export const COMPLETION_ACCEPT_TIMING_NAME = 'testLsp.completion.accept'

class FakeTransport implements LspManagedTransport {
  public readonly sent: string[] = []
  private readonly handlers = new Set<LspTransportHandler>()

  public send(message: string): void {
    this.sent.push(message)
  }

  public subscribe(handler: LspTransportHandler): void {
    this.handlers.add(handler)
  }

  public unsubscribe(handler: LspTransportHandler): void {
    this.handlers.delete(handler)
  }

  public close(): void {
    this.handlers.clear()
  }

  public receive(message: unknown): void {
    for (const handler of this.handlers) handler(JSON.stringify(message))
  }
}

export type ConnectedEditor = {
  readonly applyEdits: ReturnType<typeof vi.fn<EditorEditContributionContext['applyEdits']>>
  type(character: string): void
  backspace(): void
  moveCaret(offset: number): void
  selectRange(start: number, end: number): void
  scroll(by: number): void
  editElsewhere(edit: TextEdit): void
  pressKey(key: string, modifiers?: KeyboardEventInit): KeyboardEvent
  breakAcceptance(): void
  answerCompletion(items: readonly lsp.CompletionItem[], isIncomplete?: boolean): void
  answerResolve(item: lsp.CompletionItem): void
  completionElement(): HTMLElement
  completionLabels(): readonly string[]
  focusedCompletionLabel(): string | null
  completionRequests(): readonly lsp.CompletionParams[]
}

export type ConnectedEditorOptions = {
  readonly capabilities?: lsp.ServerCapabilities
  readonly acceptOnCommitCharacter?: boolean
}

/**
 * The plugin driven the way the editor drives it: one coalesced content update per keystroke, a
 * live view snapshot, and the completion edit feature the edit contribution registers.
 */
export async function connectedEditor(
  text: string,
  caretOffset: number,
  options: ConnectedEditorOptions = {},
): Promise<ConnectedEditor> {
  const transport = new FakeTransport()
  const applyEdits = vi.fn<EditorEditContributionContext['applyEdits']>()
  const features = new Map<unknown, unknown>()
  const element = document.createElement('div')
  let snapshot = editorSnapshot(text, caretOffset, 1)
  let anchorRect = new DOMRect(10, 20, 40, 18)

  const provider = activateProvider(transport, features, applyEdits, options)
  const contribution = provider.createContribution(
    viewContributionContext({
      element,
      getSnapshot: () => snapshot,
      getRangeClientRect: () => anchorRect,
      getFeature: (token) => features.get(token) ?? null,
    }),
  )
  if (!contribution) throw new Error('missing contribution')

  transport.receive({
    jsonrpc: '2.0',
    id: jsonMessage(transport.sent[0]).id,
    result: {
      capabilities: { textDocumentSync: { openClose: true, change: 2 }, ...options.capabilities },
    },
  })
  await flushPromises()

  const answer = (method: string, result: unknown): void => {
    const request = transport.sent.map(jsonMessage).findLast((sent) => sent.method === method)
    if (!request) throw new Error(`missing request ${method}`)
    transport.receive({ jsonrpc: '2.0', id: request.id, result })
  }

  const applyChange = (edit: TextEdit, caretOffset: number): void => {
    const next = `${snapshot.fullText.slice(0, edit.from)}${edit.text}${snapshot.fullText.slice(edit.to)}`
    snapshot = editorSnapshot(next, caretOffset, snapshot.textVersion + 1)
    contribution.update(snapshot, 'content', documentChange([edit]))
  }

  return {
    applyEdits,
    type: (character) => {
      const at = caretOffsetOf(snapshot)
      applyChange({ from: at, to: at, text: character }, at + character.length)
    },
    backspace: () => {
      const at = caretOffsetOf(snapshot)
      applyChange({ from: at - 1, to: at, text: '' }, at - 1)
    },
    editElsewhere: (edit) => applyChange(edit, caretOffsetOf(snapshot)),
    moveCaret: (offset) => {
      snapshot = editorSnapshot(snapshot.fullText, offset, snapshot.textVersion)
      contribution.update(snapshot, 'selection', null)
    },
    selectRange: (start, end) => {
      snapshot = editorSnapshot(snapshot.fullText, end, snapshot.textVersion, start)
      contribution.update(snapshot, 'selection', null)
    },
    scroll: (by) => {
      anchorRect = new DOMRect(anchorRect.x, anchorRect.y - by, anchorRect.width, anchorRect.height)
      contribution.update(snapshot, 'viewport', null)
    },
    pressKey: (key, modifiers = {}) => {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      })
      element.dispatchEvent(event)
      return event
    },
    // Takes the edit feature away, which is what an acceptance needs to apply an item at all — the
    // state a session can genuinely be in when the document stops being editable under it.
    breakAcceptance: () => features.clear(),
    answerCompletion: (items, isIncomplete = false) =>
      answer('textDocument/completion', { isIncomplete, items }),
    answerResolve: (item) => answer('completionItem/resolve', item),
    completionElement: () => {
      const widget = document.querySelector<HTMLElement>('.editor-test-lsp-completion')
      if (!widget) throw new Error('missing completion widget')
      return widget
    },
    completionLabels: () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('.editor-test-lsp-completion [role="option"]'),
        (row) => row.children[1]?.textContent ?? '',
      ),
    focusedCompletionLabel: () =>
      document.querySelector<HTMLElement>('.editor-test-lsp-completion [aria-selected="true"]')
        ?.children[1]?.textContent ?? null,
    completionRequests: () =>
      transport.sent
        .map(jsonMessage)
        .filter((sent) => sent.method === 'textDocument/completion')
        .map((sent) => sent.params as lsp.CompletionParams),
  }
}

export async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

export function singleLineRange(start: number, end: number): lsp.Range {
  return { start: { line: 0, character: start }, end: { line: 0, character: end } }
}

function activateProvider(
  transport: LspManagedTransport,
  features: Map<unknown, unknown>,
  applyEdits: EditorEditContributionContext['applyEdits'],
  options: ConnectedEditorOptions,
): EditorViewContributionProvider {
  let provider: EditorViewContributionProvider | null = null
  const disposable = { dispose: () => undefined }
  createLanguageServerAdapterPlugin({
    name: 'editor.test-lsp',
    createTransport: () => transport,
    defaultHighlightPrefix: 'editor-test',
    completion: {
      acceptTimingName: COMPLETION_ACCEPT_TIMING_NAME,
      widgetClassNamespace: 'test-lsp',
      acceptOnCommitCharacter: options.acceptOnCommitCharacter ?? false,
    },
  }).activate({
    registerHighlighter: () => disposable,
    registerSyntaxProvider: () => disposable,
    registerViewContribution: (value) => {
      provider = value
      return disposable
    },
    registerCommandContribution: () => disposable,
    registerCapabilityContribution: () => disposable,
    registerEditContribution: (value) => {
      value.createContribution({
        hasDocument: () => true,
        materializeFullText: () => '',
        focusEditor: vi.fn(),
        applyEdits,
        registerFeature: (id, feature) => {
          features.set(id, feature)
          return { dispose: () => features.delete(id) }
        },
      })
      return disposable
    },
    registerDecorationContribution: () => disposable,
    registerGutterContribution: () => disposable,
    registerBlockProvider: () => disposable,
    registerInjectedTextRowProvider: () => disposable,
  } satisfies EditorPluginContext)

  if (!provider) throw new Error('missing provider')
  return provider
}

function viewContributionContext(options: {
  element: HTMLDivElement
  getSnapshot(): EditorViewSnapshot
  getRangeClientRect(): DOMRect
  getFeature(token: unknown): unknown
}): EditorViewContributionContext {
  return {
    container: options.element,
    scrollElement: options.element,
    highlightPrefix: 'editor-test',
    hasDocument: () => true,
    getSnapshot: options.getSnapshot,
    getFeature: options.getFeature as EditorViewContributionContext['getFeature'],
    revealLine: vi.fn(),
    focusEditor: vi.fn(),
    setSelection: vi.fn(),
    setSelections: vi.fn(),
    setScrollTop: vi.fn(),
    reserveOverlayWidth: vi.fn(),
    textOffsetFromPoint: vi.fn(() => 0),
    getRangeClientRect: () => options.getRangeClientRect(),
    setRangeHighlight: vi.fn(),
    clearRangeHighlight: vi.fn(),
  }
}

function editorSnapshot(
  fullText: string,
  caretOffset: number,
  textVersion: number,
  anchorOffset = caretOffset,
): EditorViewSnapshot {
  return {
    documentId: 'src/index.ts',
    languageId: 'typescript',
    fullText,
    textVersion,
    lineStarts: [0],
    tokens: [],
    brackets: [],
    selections: [
      {
        anchorOffset,
        headOffset: caretOffset,
        startOffset: Math.min(anchorOffset, caretOffset),
        endOffset: Math.max(anchorOffset, caretOffset),
      },
    ],
    metrics: {} as EditorViewSnapshot['metrics'],
    lineCount: 1,
    contentWidth: 0,
    totalHeight: 0,
    tabSize: 4,
    foldMarkers: [],
    visibleRows: [],
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 0,
      scrollWidth: 0,
      clientHeight: 0,
      clientWidth: 0,
      visibleRange: { start: 0, end: 1 } as EditorViewSnapshot['viewport']['visibleRange'],
    },
  }
}

function caretOffsetOf(snapshot: EditorViewSnapshot): number {
  const selection = snapshot.selections[0]
  if (!selection) throw new Error('missing selection')
  return selection.headOffset
}

function documentChange(edits: readonly TextEdit[]): DocumentSessionChange {
  return { kind: 'edit', edits } as unknown as DocumentSessionChange
}

function jsonMessage(item: unknown): JsonMessage {
  if (typeof item !== 'string') throw new Error('missing JSON message')
  return JSON.parse(item) as JsonMessage
}
