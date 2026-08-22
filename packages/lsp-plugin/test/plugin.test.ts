import type { EditorCommandId } from '@singapor/core/editor'
import type { TextSnapshot } from '@singapor/core/document'
import {
  createEditorCapabilityToken,
  type EditorCommandContributionContext,
  type EditorCommandHandler,
  type EditorEditContributionContext,
  type EditorPluginContext,
  type EditorViewContributionContext,
  type EditorViewContributionProvider,
  type EditorViewSnapshot,
} from '@singapor/core/extensions'
import type { LspManagedTransport, LspTransportHandler, LspWebSocketLike } from '@singapor/lsp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as lsp from 'vscode-languageserver-protocol'

import { type LanguageServerCompletionEditFeature } from '../src/completion'
import {
  LspConnection,
  type LspConnectionCallbacks,
  type LspConnectionOptions,
  type LspConnectionProvider,
} from '../src/lspConnection'
import { createLanguageServerAdapterPlugin, createLanguageServerPlugin } from '../src/plugin'
import type { LanguageServerPlugin } from '../src/types'

type JsonMessage = Record<string, unknown>
type Listener = (event: Event) => void

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

  public closed = false

  public close(): void {
    this.closed = true
    this.handlers.clear()
  }

  public receive(message: unknown): void {
    const text = typeof message === 'string' ? message : JSON.stringify(message)
    for (const handler of this.handlers) handler(text)
  }
}

class FakeWebSocket implements LspWebSocketLike {
  public static readonly instances: FakeWebSocket[] = []
  public readonly sent: string[] = []
  public readyState = 0
  private readonly listeners = new Map<string, Set<Listener>>()

  public constructor(public readonly url: string | URL) {
    FakeWebSocket.instances.push(this)
  }

  public send(message: string): void {
    this.sent.push(message)
  }

  public close(): void {
    this.readyState = 3
    this.emit('close')
  }

  public addEventListener(type: 'open' | 'message' | 'error' | 'close', handler: Listener): void {
    this.listenersFor(type).add(handler)
  }

  public removeEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    handler: Listener,
  ): void {
    this.listenersFor(type).delete(handler)
  }

  public open(): void {
    this.readyState = 1
    this.emit('open')
  }

  public receive(message: unknown): void {
    this.emit('message', JSON.stringify(message))
  }

  private emit(type: string, data?: unknown): void {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data })
    for (const listener of this.listenersFor(type)) listener(event)
  }

  private listenersFor(type: string): Set<Listener> {
    let listeners = this.listeners.get(type)
    if (listeners) return listeners

    listeners = new Set()
    this.listeners.set(type, listeners)
    return listeners
  }
}

describe('createLanguageServerAdapterPlugin', () => {
  afterEach(() => {
    FakeWebSocket.instances.length = 0
    document.body.replaceChildren()
  })

  it('owns generic LSP document sync, diagnostics, and adapter naming', async () => {
    const transport = new FakeTransport()
    const completionToken = createEditorCapabilityToken<LanguageServerCompletionEditFeature>(
      'test.lsp-plugin.completion',
    )
    const applyEdits = vi.fn<EditorEditContributionContext['applyEdits']>()
    const { commands, features, provider } = activatePlugin(
      createLanguageServerAdapterPlugin({
        name: 'editor.test-lsp',
        createTransport: () => transport,
        defaultHighlightPrefix: 'editor-test',
        diagnostics: {
          minimapSourceId: 'editor.test-lsp.diagnostics',
          highlightNameNamespace: 'test-lsp',
          markerTimingNamePrefix: 'testLsp.marker',
        },
        completion: {
          editFeature: completionToken,
          acceptTimingName: 'testLsp.completion.accept',
          widgetClassNamespace: 'test-lsp',
        },
        hoverDefinition: {
          linkHighlightNameNamespace: 'test-lsp',
          tooltipClassNamespace: 'test-lsp',
          navigationTimingNamePrefix: 'testLsp',
        },
      }),
      { applyEdits },
    )
    const context = viewContributionContext(editorSnapshot(), { features })
    const contribution = provider.createContribution(context)
    if (!contribution) throw new Error('missing contribution')

    transport.receive(initializeResponse(jsonMessage(transport.sent[0])))
    await flushPromises()

    expect(textDocumentFor(transport.sent.find(hasMethod('textDocument/didOpen')))).toEqual({
      uri: 'file:///README.md',
      languageId: 'markdown',
      version: 0,
      text: '# Notes',
    })

    transport.receive(publishDiagnosticsMessage())
    expect(context.setRangeHighlight).toHaveBeenCalledWith(
      'editor-test-test-lsp-error',
      [{ start: 0, end: 1 }],
      expect.any(Object),
    )
    expect(command(commands, 'editor.action.marker.next')({})).toBe(true)
    expect(context.setSelection).toHaveBeenCalledWith(0, 1, 'testLsp.marker.next', 0)

    const completionFeature = features.get(completionToken) as
      | LanguageServerCompletionEditFeature
      | undefined
    expect(
      completionFeature?.applyCompletion({
        edits: [{ from: 0, to: 1, text: 'value' }],
        selection: { anchor: 5, head: 5 },
      }),
    ).toBe(true)
    expect(applyEdits).toHaveBeenCalledWith(
      [{ from: 0, to: 1, text: 'value' }],
      'testLsp.completion.accept',
      { anchor: 5, head: 5 },
    )
  })

  // A formatter answers with the whole file even when one line moved, and applying that verbatim
  // retires every anchor, decoration, fold and selection inside it.
  it('applies a whole-document formatting reply as the one edit that differs', async () => {
    const transport = new FakeTransport()
    const applyEdits = vi.fn<EditorEditContributionContext['applyEdits']>()
    const text = '# Notes\n\n- one\n-  two\n'
    const { commands, features, provider } = activatePlugin(
      createLanguageServerAdapterPlugin({
        name: 'editor.test-lsp',
        createTransport: () => transport,
        defaultHighlightPrefix: 'editor-test',
        completion: { acceptTimingName: 'testLsp.completion.accept' },
      }),
      { applyEdits },
    )
    const contribution = provider.createContribution(
      viewContributionContext(editorSnapshot(text), { features }),
    )
    if (!contribution) throw new Error('missing contribution')

    transport.receive(
      initializeResponse(jsonMessage(transport.sent[0]), { documentFormattingProvider: true }),
    )
    await flushPromises()

    expect(command(commands, 'editor.action.formatDocument')({})).toBe(true)

    const request = transport.sent.findLast(hasMethod('textDocument/formatting'))
    if (!request) throw new Error('missing formatting request')
    transport.receive({
      jsonrpc: '2.0',
      id: jsonMessage(request).id,
      result: [
        {
          newText: '# Notes\n\n- one\n- two\n',
          range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
        },
      ],
    })
    await flushPromises()

    expect(applyEdits).toHaveBeenCalledWith(
      [{ from: 17, text: '', to: 18 }],
      'testLsp.completion.accept',
      { anchor: 0, head: 0 },
    )
  })

  it('keeps the public custom-server plugin as the bring-your-own-server path', async () => {
    const statuses: string[] = []
    const applyEdits = vi.fn<EditorEditContributionContext['applyEdits']>()
    const { provider, features } = activatePlugin(
      createLanguageServerPlugin({
        webSocketRoute: 'ws://localhost/lsp/custom',
        rootUri: 'file:///repo',
        webSocketTransportOptions: { WebSocketCtor: FakeWebSocket },
        onStatusChange: (status) => statuses.push(status),
      }),
      { applyEdits },
    )
    const context = viewContributionContext(editorSnapshot(), { features })
    const contribution = provider.createContribution(context)
    if (!contribution) throw new Error('missing contribution')

    const socket = FakeWebSocket.instances[0]
    if (!socket) throw new Error('missing socket')

    socket.open()
    await flushPromises()
    socket.receive(initializeResponse(jsonMessage(socket.sent[0])))
    await flushPromises()

    expect(socket.url).toBe('ws://localhost/lsp/custom')
    expect(sentMethods(socket)).toEqual(['initialize', 'initialized', 'textDocument/didOpen'])
    expect(textDocumentFor(socket.sent[2])).toEqual({
      uri: 'file:///README.md',
      languageId: 'markdown',
      version: 0,
      text: '# Notes',
    })
    expect(statuses).toEqual(['loading', 'ready'])
  })
})

type ActivationOptions = {
  readonly applyEdits: EditorEditContributionContext['applyEdits']
}

describe('connectionProvider', () => {
  /**
   * A host that owns the connection, counting what the contributions ask of it.
   *
   * The real one keys by workspace root and server id; this one has a single key,
   * because what is under test is that two contributions get the *same*
   * connection and that neither of them closes it.
   */
  function testProvider() {
    let connection: LspConnection | null = null
    const counts = { acquired: 0, released: 0 }

    return {
      counts,
      provider: {
        acquire: (options: LspConnectionOptions, callbacks: LspConnectionCallbacks) => {
          counts.acquired += 1
          if (!connection) {
            connection = new LspConnection(options, callbacks)
            connection.connect()
          }
          const held = connection
          return {
            connection: held,
            release: () => {
              counts.released += 1
            },
          }
        },
      } satisfies LspConnectionProvider,
    }
  }

  function pluginWith(provider: LspConnectionProvider, transport: FakeTransport) {
    return createLanguageServerAdapterPlugin({
      name: 'editor.test-lsp',
      createTransport: () => transport,
      connectionProvider: provider,
      defaultHighlightPrefix: 'editor-test',
      completion: { acceptTimingName: 'testLsp.completion.accept' },
    })
  }

  it('runs one initialize for two contributions on one connection', async () => {
    const transport = new FakeTransport()
    const { provider: connectionProvider, counts } = testProvider()
    const first = activatePlugin(pluginWith(connectionProvider, transport), { applyEdits: vi.fn() })
    const second = activatePlugin(pluginWith(connectionProvider, transport), {
      applyEdits: vi.fn(),
    })

    first.provider.createContribution(
      viewContributionContext(editorSnapshot('# One', 'one.md'), { features: first.features }),
    )
    transport.receive(initializeResponse(jsonMessage(transport.sent[0])))
    await flushPromises()
    second.provider.createContribution(
      viewContributionContext(editorSnapshot('# Two', 'two.md'), { features: second.features }),
    )
    await flushPromises()

    expect(counts.acquired).toBe(2)
    // One handshake, two documents. Before the seam existed this was two of
    // everything, because the connection died with the view that built it.
    expect(transport.sent.map((sent) => jsonMessage(sent).method)).toEqual([
      'initialize',
      'initialized',
      'textDocument/didOpen',
      'textDocument/didOpen',
    ])
    expect(transport.sent.filter(hasMethod('textDocument/didOpen')).map(textDocumentFor)).toEqual([
      expect.objectContaining({ uri: 'file:///one.md' }),
      expect.objectContaining({ uri: 'file:///two.md' }),
    ])
  })

  it('leaves the connection open when a contribution goes away', async () => {
    const transport = new FakeTransport()
    const { provider: connectionProvider, counts } = testProvider()
    const { features, provider } = activatePlugin(pluginWith(connectionProvider, transport), {
      applyEdits: vi.fn(),
    })
    const contribution = provider.createContribution(
      viewContributionContext(editorSnapshot('# One', 'one.md'), { features }),
    )
    if (!contribution) throw new Error('missing contribution')
    transport.receive(initializeResponse(jsonMessage(transport.sent[0])))
    await flushPromises()

    contribution.dispose()

    // Told the server this view's document is gone, and nothing more: closing the
    // socket is the provider's call, and it was not asked to.
    expect(transport.sent.filter(hasMethod('textDocument/didClose'))).toHaveLength(1)
    expect(counts.released).toBe(1)
    expect(transport.closed).toBe(false)
  })

  it('tells a contribution that joined a live connection that it is connected', async () => {
    const transport = new FakeTransport()
    const { provider: connectionProvider } = testProvider()
    const first = activatePlugin(pluginWith(connectionProvider, transport), { applyEdits: vi.fn() })
    first.provider.createContribution(
      viewContributionContext(editorSnapshot('# One', 'one.md'), { features: first.features }),
    )
    transport.receive(initializeResponse(jsonMessage(transport.sent[0])))
    await flushPromises()

    const onConnected = vi.fn()
    const late = activatePlugin(
      createLanguageServerAdapterPlugin({
        name: 'editor.test-lsp',
        createTransport: () => transport,
        connectionProvider: {
          acquire: (options, callbacks) => {
            const lease = connectionProvider.acquire(options, callbacks)
            // What the pool does for a late joiner, in the shape the contract
            // requires: never synchronously, because the caller is mid-constructor.
            queueMicrotask(() => callbacks.onConnected())
            return lease
          },
        },
        defaultHighlightPrefix: 'editor-test',
        completion: { acceptTimingName: 'testLsp.completion.accept' },
        onConnected,
      }),
      { applyEdits: vi.fn() },
    )
    late.provider.createContribution(
      viewContributionContext(editorSnapshot('# Two', 'two.md'), { features: late.features }),
    )
    await flushPromises()

    expect(onConnected).toHaveBeenCalledTimes(1)
  })
})

function activatePlugin(
  plugin: LanguageServerPlugin,
  options: ActivationOptions,
): {
  readonly provider: EditorViewContributionProvider
  readonly commands: ReadonlyMap<EditorCommandId, EditorCommandHandler>
  readonly features: ReadonlyMap<unknown, unknown>
} {
  let provider: EditorViewContributionProvider | null = null
  const commands = new Map<EditorCommandId, EditorCommandHandler>()
  const features = new Map<unknown, unknown>()
  plugin.activate({
    registerHighlighter: () => ({ dispose: () => undefined }),
    registerSyntaxProvider: () => ({ dispose: () => undefined }),
    registerViewContribution: (value) => {
      provider = value
      return { dispose: () => undefined }
    },
    registerCommandContribution: (value) => {
      value.createContribution(commandContributionContext(commands))
      return { dispose: () => undefined }
    },
    registerCapabilityContribution: () => ({ dispose: () => undefined }),
    registerEditContribution: (value) => {
      value.createContribution(editContributionContext(features, options.applyEdits))
      return { dispose: () => undefined }
    },
    registerDecorationContribution: () => ({ dispose: () => undefined }),
    registerGutterContribution: () => ({ dispose: () => undefined }),
    registerBlockProvider: () => ({ dispose: () => undefined }),
    registerInjectedTextRowProvider: () => ({ dispose: () => undefined }),
  } satisfies EditorPluginContext)

  if (!provider) throw new Error('missing provider')
  return { provider, commands, features }
}

function commandContributionContext(
  commands: Map<EditorCommandId, EditorCommandHandler>,
): EditorCommandContributionContext {
  return {
    registerCommand: (commandId, handler) => {
      commands.set(commandId, handler)
      return { dispose: () => commands.delete(commandId) }
    },
  }
}

function editContributionContext(
  features: Map<unknown, unknown>,
  applyEdits: EditorEditContributionContext['applyEdits'],
): EditorEditContributionContext {
  return {
    hasDocument: () => true,
    materializeFullText: () => '',
    getTextSnapshot: () => null,
    focusEditor: vi.fn(),
    applyEdits,
    registerFeature: (id, feature) => {
      features.set(id, feature)
      return { dispose: () => features.delete(id) }
    },
  }
}

function command(
  commands: ReadonlyMap<EditorCommandId, EditorCommandHandler>,
  commandId: EditorCommandId,
): EditorCommandHandler {
  const handler = commands.get(commandId)
  if (!handler) throw new Error(`missing command ${commandId}`)
  return handler
}

function viewContributionContext(
  snapshot: EditorViewSnapshot,
  options: { readonly features: ReadonlyMap<unknown, unknown> },
): EditorViewContributionContext {
  const element = document.createElement('div')
  const getFeature = vi.fn((token: unknown): unknown | null => {
    const feature = options.features.get(token)
    return feature === undefined ? null : feature
  }) as EditorViewContributionContext['getFeature']
  return {
    container: element,
    scrollElement: element,
    highlightPrefix: 'editor-test',
    hasDocument: () => true,
    getSnapshot: () => snapshot,
    getFeature,
    revealLine: vi.fn(),
    focusEditor: vi.fn(),
    setSelection: vi.fn(),
    setSelections: vi.fn(),
    setScrollTop: vi.fn(),
    reserveOverlayWidth: vi.fn(),
    textOffsetFromPoint: vi.fn(() => 0),
    getRangeClientRect: vi.fn(() => new DOMRect(10, 20, 40, 18)),
    setRangeHighlight: vi.fn(),
    clearRangeHighlight: vi.fn(),
  }
}

function editorSnapshot(fullText = '# Notes', documentId = 'README.md'): EditorViewSnapshot {
  const lineStarts = [0]
  for (let index = 0; index < fullText.length; index += 1) {
    if (fullText.charCodeAt(index) === 10) lineStarts.push(index + 1)
  }
  return {
    documentId,
    languageId: 'markdown',
    fullText,
    textVersion: 1,
    lineStarts,
    textSnapshot: stringTextSnapshot(fullText),
    tokens: [],
    brackets: [],
    selections: [{ anchorOffset: 0, headOffset: 0, startOffset: 0, endOffset: 0 }],
    metrics: {} as EditorViewSnapshot['metrics'],
    lineCount: lineStarts.length,
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

function stringTextSnapshot(text: string): TextSnapshot {
  return {
    length: text.length,
    materializeFullText: () => text,
    readRange: (start, end) => text.slice(start, end),
    forEachTextChunk: (visit) => visit(text, 0, text.length),
  }
}

function initializeResponse(
  request: JsonMessage,
  capabilities: lsp.ServerCapabilities = {},
): JsonMessage {
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: 2,
        },
        ...capabilities,
      },
    },
  }
}

function publishDiagnosticsMessage(): JsonMessage {
  return {
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri: 'file:///README.md',
      version: 0,
      diagnostics: [
        {
          severity: 1,
          message: 'heading',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
        },
      ],
    },
  }
}

function textDocumentFor(item: unknown): unknown {
  const params = jsonMessage(item).params as { readonly textDocument: unknown }
  return params.textDocument
}

function jsonMessage(item: unknown): JsonMessage {
  if (typeof item !== 'string') throw new Error('missing JSON message')
  return JSON.parse(item) as JsonMessage
}

function hasMethod(method: string): (item: string) => boolean {
  return (item) => jsonMessage(item).method === method
}

function sentMethods(socket: FakeWebSocket): readonly unknown[] {
  return socket.sent.map((message) => jsonMessage(message).method)
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
