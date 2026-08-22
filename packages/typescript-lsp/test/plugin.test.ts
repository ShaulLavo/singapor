import type { EditorCommandId } from '@singapor/core/editor'
import type { DocumentSessionChange, TextEdit, TextSnapshot } from '@singapor/core/document'
import type {
  EditorCommandContributionContext,
  EditorCommandHandler,
  EditorEditContributionContext,
  EditorMinimapFeature,
  EditorPluginContext,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewSnapshot,
  SemanticTokenLayer,
} from '@singapor/core/extensions'
import { EDITOR_MINIMAP_FEATURE } from '@singapor/core/extensions'
import type { LspClient, LspWebSocketLike, LspWorkerLike } from '@singapor/lsp'
import { semanticTokensClientCapability } from '@singapor/lsp'
import { HOVER_REQUEST_DEBOUNCE_MS, TOOLTIP_HIDE_DELAY_MS } from '@singapor/lsp-plugin/tooltip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as lsp from 'vscode-languageserver-protocol'
import { createTypeScriptLspPlugin, type TypeScriptLspDiagnosticSummary } from '../src'

type Listener = (event: Event) => void
type JsonMessage = Record<string, unknown>

class FakeWorker implements LspWorkerLike {
  public readonly sent: unknown[] = []
  public terminated = false
  private readonly listeners = new Map<string, Set<Listener>>()

  public postMessage(message: unknown): void {
    this.sent.push(message)
  }

  public addEventListener(type: 'message' | 'error', handler: Listener): void {
    this.listenersFor(type).add(handler)
  }

  public removeEventListener(type: 'message' | 'error', handler: Listener): void {
    this.listenersFor(type).delete(handler)
  }

  public terminate(): void {
    this.terminated = true
  }

  public listenerCount(type: string): number {
    return this.listenersFor(type).size
  }

  public receive(message: unknown): void {
    const event = new MessageEvent('message', { data: message })
    for (const listener of this.listenersFor('message')) listener(event)
  }

  public fail(message: string): void {
    const event = errorEvent(message)
    for (const listener of this.listenersFor('error')) listener(event)
  }

  private listenersFor(type: string): Set<Listener> {
    let listeners = this.listeners.get(type)
    if (listeners) return listeners

    listeners = new Set()
    this.listeners.set(type, listeners)
    return listeners
  }
}

class FakeWebSocket implements LspWebSocketLike {
  public static readonly instances: FakeWebSocket[] = []
  public readonly sent: string[] = []
  public readyState = 0
  private readonly listeners = new Map<string, Set<Listener>>()

  public constructor(
    public readonly url: string | URL,
    public readonly protocols?: string | readonly string[],
  ) {
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

describe('createTypeScriptLspPlugin', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('syncs the active TypeScript document through a worker and renders diagnostics', async () => {
    const worker = new FakeWorker()
    const diagnostics: TypeScriptLspDiagnosticSummary[] = []
    const context = viewContributionContext(editorSnapshot())
    const plugin = createTypeScriptLspPlugin({
      diagnosticDelayMs: 0,
      workerFactory: () => worker,
      onDiagnostics: (summary) => diagnostics.push(summary),
    })
    const provider = activatePlugin(plugin)
    const contribution = provider.createContribution(context)
    if (!contribution) throw new Error('missing contribution')

    const initialize = message(worker.sent[0])
    worker.receive(initializeResponse(initialize))
    await flushPromises()

    expect(sentMethods(worker)).toContain('textDocument/didOpen')
    expect(textDocumentFor(worker.sent.find(hasMethod('textDocument/didOpen')))).toMatchObject({
      uri: 'file:///src/index.ts',
      languageId: 'typescript',
      version: 0,
      text: 'const value: string = 1;',
    })

    worker.receive({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///src/index.ts',
        version: 0,
        diagnostics: [
          {
            severity: 1,
            source: 'typescript',
            message: 'bad assignment',
            range: {
              start: { line: 0, character: 22 },
              end: { line: 0, character: 23 },
            },
          },
        ],
      },
    })

    expect(context.setRangeHighlight).toHaveBeenCalledWith(
      'editor-test-typescript-lsp-error',
      [{ start: 22, end: 23 }],
      expect.objectContaining({
        color: 'var(--editor-lsp-diagnostic-error)',
        textDecoration: expect.stringContaining('wavy'),
      }),
    )
    expect(diagnostics.at(-1)?.counts).toMatchObject({ error: 1, total: 1 })

    contribution.dispose()
    expect(worker.terminated).toBe(true)
  })

  /**
   * The four options a host needs to paint semantic colour through this plugin, and the one thing
   * they must not cost it. A capability block only matters if it reaches `initialize`, a layer only
   * matters if it reaches the host, and a client handle is the only way to ask for tokens at all —
   * while the workspace-file sync this plugin registers on its own connection has to survive a host
   * that also wants the connection.
   */
  it('passes capabilities, a client handle and a semantic token layer through to the host', async () => {
    const worker = new FakeWorker()
    // Held on an object: each of these is assigned inside a callback, and a bare local would be
    // narrowed to `null` for the rest of the test whatever the callback did with it.
    const handed: { client: LspClient | null; layer: SemanticTokenLayer | null } = {
      client: null,
      layer: null,
    }
    const plugin = createTypeScriptLspPlugin({
      diagnosticDelayMs: 0,
      workerFactory: () => worker,
      capabilities: semanticTokensClientCapability({ requests: { full: true, range: true } }),
      clientInfo: { name: 'example-app' },
      semanticTokens: {
        onLayer: (layer) => {
          handed.layer = layer
        },
      },
      onConnectionCreated: (context) => {
        handed.client = context.client
      },
    })
    const provider = activatePlugin(plugin)
    const contribution = provider.createContribution(viewContributionContext(editorSnapshot()))
    if (!contribution) throw new Error('missing contribution')

    const initialize = message(worker.sent[0])
    const params = initialize.params as lsp.InitializeParams
    expect(params.capabilities.textDocument?.semanticTokens?.requests).toEqual({
      full: true,
      range: true,
    })
    expect(params.clientInfo).toEqual({ name: 'example-app' })
    expect(handed.client).not.toBeNull()
    expect(handed.layer).not.toBeNull()

    worker.receive(initializeResponse(initialize))
    await flushPromises()
    plugin.setWorkspaceFiles([{ path: 'src/other.ts', text: 'export const other = 1' }])

    expect(sentMethods(worker)).toContain('editor/typescript/setWorkspaceFiles')

    contribution.dispose()
  })

  it('routes worker crashes through owned worker transport', () => {
    const worker = new FakeWorker()
    const errors: unknown[] = []
    const plugin = createTypeScriptLspPlugin({
      workerFactory: () => worker,
      onError: (error) => errors.push(error),
    })
    const provider = activatePlugin(plugin)
    const contribution = provider.createContribution(viewContributionContext(editorSnapshot()))
    if (!contribution) throw new Error('missing contribution')

    worker.fail('worker crashed')

    expect(errorMessage(errors[0])).toBe('worker crashed')
    expect(worker.terminated).toBe(true)
    expect(worker.listenerCount('message')).toBe(0)
    expect(worker.listenerCount('error')).toBe(0)

    contribution.dispose()
  })

  it('syncs active JavaScript documents through the TypeScript language service', async () => {
    const worker = new FakeWorker()
    const context = viewContributionContext(
      editorSnapshot({
        documentId: 'src/index.js',
        languageId: 'javascript',
        fullText: 'const value = 1;',
      }),
    )
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const provider = activatePlugin(plugin)
    const contribution = provider.createContribution(context)
    if (!contribution) throw new Error('missing contribution')

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()

    expect(textDocumentFor(worker.sent.find(hasMethod('textDocument/didOpen')))).toMatchObject({
      uri: 'file:///src/index.js',
      languageId: 'javascript',
      version: 0,
      text: 'const value = 1;',
    })

    contribution.dispose()
  })

  it('does not attach the TypeScript language service to Markdown documents', async () => {
    const worker = new FakeWorker()
    const context = viewContributionContext(
      editorSnapshot({
        documentId: 'README.md',
        languageId: 'markdown',
        fullText: '# Notes',
      }),
    )
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const provider = activatePlugin(plugin)
    const contribution = provider.createContribution(context)
    if (!contribution) throw new Error('missing contribution')

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()

    expect(sentMethods(worker)).not.toContain('textDocument/didOpen')

    contribution.dispose()
  })

  it('publishes diagnostic line markers to the minimap feature', async () => {
    const worker = new FakeWorker()
    const minimap = minimapFeature()
    const context = viewContributionContext(
      editorSnapshot({
        fullText: 'const value = 1;\nconst next: string = 2;\n',
        lineCount: 3,
        lineStarts: [0, 17, 40],
      }),
      { features: new Map([[EDITOR_MINIMAP_FEATURE, minimap]]) },
    )
    const plugin = createTypeScriptLspPlugin({
      diagnosticDelayMs: 0,
      workerFactory: () => worker,
    })
    const provider = activatePlugin(plugin)
    const contribution = provider.createContribution(context)
    if (!contribution) throw new Error('missing contribution')

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    worker.receive({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///src/index.ts',
        version: 0,
        diagnostics: [
          {
            severity: 1,
            source: 'typescript',
            message: 'bad assignment',
            range: {
              start: { line: 1, character: 21 },
              end: { line: 1, character: 22 },
            },
          },
        ],
      },
    })

    expect(minimap.setDecorations).toHaveBeenCalledWith('editor.typescript-lsp.diagnostics', [
      expect.objectContaining({
        startLineNumber: 2,
        endLineNumber: 2,
        color: 'rgba(239, 68, 68, 1)',
        position: 'inline',
      }),
    ])

    contribution.dispose()
    expect(minimap.clearDecorations).toHaveBeenCalledWith('editor.typescript-lsp.diagnostics')
  })

  it('sends loaded workspace files to the worker', async () => {
    const worker = new FakeWorker()
    const plugin = createTypeScriptLspPlugin({
      workerFactory: () => worker,
    })
    const provider = activatePlugin(plugin)
    provider.createContribution(viewContributionContext(editorSnapshot()))

    const initialize = message(worker.sent[0])
    worker.receive(initializeResponse(initialize))
    await flushPromises()
    plugin.setWorkspaceFiles([{ path: 'src/other.ts', text: 'export const other = 1;' }])
    await flushPromises()

    const workspaceMessage = worker.sent
      .toReversed()
      .find(hasMethod('editor/typescript/setWorkspaceFiles'))
    expect(message(workspaceMessage).params).toEqual({
      files: [{ path: 'src/other.ts', text: 'export const other = 1;' }],
    })
  })

  it('stops feature requests after initialization fails', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const errors: unknown[] = []
    const context = viewContributionContext(editorSnapshot())
    const plugin = createTypeScriptLspPlugin({
      timeoutMs: 5,
      workerFactory: () => worker,
      onError: (error) => errors.push(error),
    })
    const provider = activatePlugin(plugin)
    provider.createContribution(context)

    await vi.advanceTimersByTimeAsync(6)
    await flushPromises()

    expect(errors).toHaveLength(1)
    expect(worker.terminated).toBe(true)

    context.scrollElement.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 12, clientY: 16, buttons: 0 }),
    )
    await vi.advanceTimersByTimeAsync(260)
    plugin.setWorkspaceFiles([{ path: 'src/other.ts', text: 'export const other = 1;' }])
    await flushPromises()

    expect(errors).toHaveLength(1)
    expect(worker.sent.filter(hasMethod('textDocument/hover'))).toHaveLength(0)
    expect(worker.sent.filter(hasMethod('editor/typescript/setWorkspaceFiles'))).toHaveLength(0)
  })

  it('reports hover request timeouts through the TypeScript adapter controller', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const errors: unknown[] = []
    const context = viewContributionContext(editorSnapshot())
    const plugin = createTypeScriptLspPlugin({
      timeoutMs: 20,
      workerFactory: () => worker,
      onError: (error) => errors.push(error),
    })
    const provider = activatePlugin(plugin)
    provider.createContribution(context)

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    context.scrollElement.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 12, clientY: 16, buttons: 0 }),
    )
    await vi.advanceTimersByTimeAsync(260)

    expect(worker.sent.some(hasMethod('textDocument/hover'))).toBe(true)

    await vi.advanceTimersByTimeAsync(25)
    await flushPromises()

    expect(errors.map(errorMessage)).toEqual(['LSP request timed out: textDocument/hover'])
  })

  it('cancels stale completion requests through the TypeScript adapter controller', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const errors: unknown[] = []
    const context = viewContributionContext(
      editorSnapshot({
        fullText: 'const va',
        selections: [collapsedSelection(8)],
      }),
    )
    const plugin = createTypeScriptLspPlugin({
      workerFactory: () => worker,
      onError: (error) => errors.push(error),
    })
    const provider = activatePlugin(plugin)
    const contribution = provider.createContribution(context)
    if (!contribution) throw new Error('missing contribution')

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    contribution.update(
      editorSnapshot({
        fullText: 'const val',
        textVersion: 2,
        selections: [collapsedSelection(9)],
      }),
      'content',
      documentChange([{ from: 8, to: 8, text: 'l' }]),
    )
    await vi.advanceTimersByTimeAsync(90)

    const firstRequest = latestMessage(worker.sent, 'textDocument/completion')
    contribution.update(
      editorSnapshot({
        fullText: 'const valu',
        textVersion: 3,
        selections: [collapsedSelection(10)],
      }),
      'content',
      documentChange([{ from: 9, to: 9, text: 'u' }]),
    )
    await flushPromises()

    expect(worker.sent.find(hasCancelRequestFor(firstRequest.id))).toBeTruthy()
    expect(errors).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(90)
    expect(latestMessage(worker.sent, 'textDocument/completion').params).toMatchObject({
      position: { line: 0, character: 10 },
    })
  })

  it('keeps worker and WebSocket transports equivalent for initialization and sync', async () => {
    FakeWebSocket.instances.length = 0
    const worker = new FakeWorker()
    const workerContext = viewContributionContext(
      editorSnapshot({ fullText: 'export const value = 1;' }),
    )
    const workerPlugin = createTypeScriptLspPlugin({
      compilerOptions: { strict: true },
      diagnosticDelayMs: 7,
      workerFactory: () => worker,
    })
    const workerProvider = activatePlugin(workerPlugin)
    workerProvider.createContribution(workerContext)

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()

    const socketContext = viewContributionContext(
      editorSnapshot({ fullText: 'export const value = 1;' }),
    )
    const socketPlugin = createTypeScriptLspPlugin({
      compilerOptions: { strict: true },
      diagnosticDelayMs: 7,
      webSocketRoute: 'ws://localhost/lsp/typescript',
      webSocketTransportOptions: { WebSocketCtor: FakeWebSocket },
    })
    const socketProvider = activatePlugin(socketPlugin)
    socketProvider.createContribution(socketContext)
    const socket = FakeWebSocket.instances[0]
    if (!socket) throw new Error('missing socket')

    socket.open()
    await flushPromises()
    socket.receive(initializeResponse(jsonMessage(socket.sent[0])))
    await flushPromises()

    const workerParity = transportParityMessages(worker.sent.map(message))
    const socketParity = transportParityMessages(socket.sent.map(jsonMessage))
    expect(workerParity).toEqual(socketParity)
    expect(workerParity.map((item) => item.method)).toEqual([
      'initialize',
      'initialized',
      'textDocument/didOpen',
      'editor/typescript/setWorkspaceFiles',
    ])
    expect(workerParity[0]?.params).toMatchObject({
      rootUri: 'file:///',
      initializationOptions: {
        compilerOptions: { strict: true },
        diagnosticDelayMs: 7,
      },
    })
    expect(workerParity[2]?.params).toEqual({
      textDocument: {
        uri: 'file:///src/index.ts',
        languageId: 'typescript',
        version: 0,
        text: 'export const value = 1;',
      },
    })
  })

  it('can connect through a WebSocket route and keep diagnostics and hover working', async () => {
    vi.useFakeTimers()
    FakeWebSocket.instances.length = 0
    const diagnostics: TypeScriptLspDiagnosticSummary[] = []
    const context = viewContributionContext(editorSnapshot())
    const plugin = createTypeScriptLspPlugin({
      webSocketRoute: 'ws://localhost/lsp/typescript',
      webSocketTransportOptions: { WebSocketCtor: FakeWebSocket },
      onDiagnostics: (summary) => diagnostics.push(summary),
    })
    const provider = activatePlugin(plugin)
    provider.createContribution(context)

    const socket = FakeWebSocket.instances[0]
    if (!socket) throw new Error('missing socket')

    socket.open()
    await flushPromises()
    const initialize = jsonMessage(socket.sent[0])
    socket.receive(initializeResponse(initialize))
    await flushPromises()

    expect(sentSocketMethods(socket)).toContain('textDocument/didOpen')
    socket.receive(publishDiagnosticsMessage())
    expect(diagnostics.at(-1)?.counts).toMatchObject({ error: 1, total: 1 })

    context.scrollElement.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 12, clientY: 16, buttons: 0 }),
    )
    await vi.advanceTimersByTimeAsync(260)
    const hoverRequest = jsonMessage(
      socket.sent.toReversed().find(hasSocketMethod('textDocument/hover')),
    )
    socket.receive({
      jsonrpc: '2.0',
      id: hoverRequest.id,
      result: {
        contents: { kind: 'markdown', value: '```ts\nconst value: string\n```' },
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
      },
    })
    await flushPromises()
    await finishHoverReveal()

    expect(tooltipElement().querySelector('pre > code')?.textContent).toBe('const value: string')
  })

  it('ignores stale diagnostics for older document versions', async () => {
    const worker = new FakeWorker()
    const context = viewContributionContext(editorSnapshot())
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const provider = activatePlugin(plugin)
    const contribution = provider.createContribution(context)
    if (!contribution) throw new Error('missing contribution')

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    contribution.update(
      editorSnapshot({ fullText: 'const value: string = 2;', textVersion: 2 }),
      'content',
      documentChange([{ from: 22, to: 23, text: '2' }]),
    )
    vi.mocked(context.setRangeHighlight!).mockClear()

    worker.receive({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///src/index.ts',
        version: 0,
        diagnostics: [
          {
            severity: 1,
            message: 'stale',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
        ],
      },
    })

    expect(context.setRangeHighlight).not.toHaveBeenCalled()
  })

  it('syncs content updates from text snapshots without reading snapshot.fullText', async () => {
    const worker = new FakeWorker()
    const context = viewContributionContext(editorSnapshot())
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const provider = activatePlugin(plugin)
    const contribution = provider.createContribution(context)
    if (!contribution) throw new Error('missing contribution')

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    contribution.update(
      snapshotWithThrowingText('const value: string = 2;', {
        textVersion: 2,
        selections: [collapsedSelection(23)],
      }),
      'content',
      documentChange([{ from: 22, to: 23, text: '2' }]),
    )

    const didChange = message(worker.sent.toReversed().find(hasMethod('textDocument/didChange')))
    expect(contentChangesFor(didChange)).toEqual([
      {
        range: {
          start: { line: 0, character: 22 },
          end: { line: 0, character: 23 },
        },
        text: '2',
      },
    ])
  })

  it('optimistically shortens diagnostic highlights through local deletion', async () => {
    const worker = new FakeWorker()
    const context = viewContributionContext(
      editorSnapshot({ fullText: 'const value: string = 123;' }),
    )
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const provider = activatePlugin(plugin)
    const contribution = provider.createContribution(context)
    if (!contribution) throw new Error('missing contribution')

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    worker.receive(
      publishDiagnosticsMessage({
        range: {
          start: { line: 0, character: 22 },
          end: { line: 0, character: 25 },
        },
      }),
    )

    contribution.update(
      editorSnapshot({ fullText: 'const value: string = 1;', textVersion: 2 }),
      'content',
      documentChange([{ from: 23, to: 25, text: '' }]),
    )

    expect(latestRangeHighlightRanges(context, 'editor-test-typescript-lsp-error')).toEqual([
      { start: 22, end: 23 },
    ])
  })

  it('optimistically clears diagnostic highlights when local deletion removes the range', async () => {
    const worker = new FakeWorker()
    const context = viewContributionContext(
      editorSnapshot({ fullText: 'const value: string = 123;' }),
    )
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const provider = activatePlugin(plugin)
    const contribution = provider.createContribution(context)
    if (!contribution) throw new Error('missing contribution')

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    worker.receive(
      publishDiagnosticsMessage({
        range: {
          start: { line: 0, character: 22 },
          end: { line: 0, character: 25 },
        },
      }),
    )

    contribution.update(
      editorSnapshot({ fullText: 'const value: string = ;', textVersion: 2 }),
      'content',
      documentChange([{ from: 22, to: 25, text: '' }]),
    )

    expect(latestRangeHighlightRanges(context, 'editor-test-typescript-lsp-error')).toEqual([])
  })

  it('renders hover quick info with diagnostics at the pointer', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const context = viewContributionContext(
      editorSnapshot({
        theme: {
          foregroundColor: '#24292f',
          syntax: { keyword: '#cf222e' },
        },
      }),
    )
    context.scrollElement.style.setProperty('--editor-background', 'rgb(250, 250, 250)')
    context.scrollElement.style.setProperty('--editor-foreground', 'rgb(15, 23, 42)')
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const provider = activatePlugin(plugin)
    provider.createContribution(context)

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    worker.receive(publishDiagnosticsMessage())

    context.scrollElement.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 12, clientY: 16, buttons: 0 }),
    )
    await vi.advanceTimersByTimeAsync(260)
    const hoverRequest = message(worker.sent.toReversed().find(hasMethod('textDocument/hover')))
    expect(hoverRequest.params).toMatchObject({
      textDocument: { uri: 'file:///src/index.ts' },
      position: { line: 0, character: 22 },
    })

    worker.receive({
      jsonrpc: '2.0',
      id: hoverRequest.id,
      result: {
        contents: { kind: 'markdown', value: '```ts\nconst value: string\n```' },
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
      },
    })
    await flushPromises()
    await finishHoverReveal()

    expect(document.body.textContent).toContain('const value: string')
    expect(document.body.textContent).toContain('bad assignment')
    expect(tooltipElement().querySelector('pre > code')?.textContent).toBe('const value: string')
    expect(
      tooltipElement()
        .querySelector<HTMLElement>('.editor-typescript-lsp-hover-markdown')
        ?.style.getPropertyValue('--editor-typescript-lsp-hover-code-block-background'),
    ).toBe('')
    expect(tooltipElement().style.getPropertyValue('position-anchor')).toMatch(
      /^--editor-typescript-lsp-hover-/,
    )
    expect(tooltipElement().style.getPropertyValue('position-area')).toBe('top center')
    expect(tooltipElement().style.overflow).toBe('hidden')
    expect(tooltipElement().style.pointerEvents).toBe('auto')
    expect(tooltipElement().style.userSelect).toBe('text')
    expect(tooltipElement().style.getPropertyValue('--editor-background')).toBe(
      'rgb(250, 250, 250)',
    )
    expect(tooltipElement().style.getPropertyValue('--editor-foreground')).toBe('rgb(15, 23, 42)')
    expect(
      tooltipElement()
        .querySelector<HTMLElement>('.editor-typescript-lsp-hover-markdown')
        ?.style.getPropertyValue('--editor-syntax-keyword'),
    ).toBe('#cf222e')
    expect(tooltipBody()?.style.overflowY).toBe('auto')
    expect(tooltipAnchorElement().style.display).toBe('block')
    expect(copyButton().textContent).toBe('')
    expect(copyButton().querySelector('svg')).not.toBeNull()
    expect(copyButton().getAttribute('aria-label')).toBe('Copy hover text')
    expect(copyButton().style.background).toBe('transparent')

    const hoverRequestCount = worker.sent.filter(hasMethod('textDocument/hover')).length
    mockElementRect(tooltipElement(), new DOMRect(0, 0, 160, 72))
    mockElementRect(tooltipAnchorElement(), new DOMRect(12, 78, 40, 18))
    vi.mocked(context.textOffsetFromPoint).mockReturnValue(3)
    context.scrollElement.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 18, clientY: 25, buttons: 0 }),
    )
    context.scrollElement.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 18, clientY: 76, buttons: 0 }),
    )
    await vi.advanceTimersByTimeAsync(260)
    expect(worker.sent.filter(hasMethod('textDocument/hover'))).toHaveLength(hoverRequestCount)

    copyButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('const value: string')
    expect(copyButton().getAttribute('aria-label')).toBe('Copied hover text')

    context.scrollElement.dispatchEvent(new PointerEvent('pointerleave'))
    tooltipElement().dispatchEvent(new PointerEvent('pointerenter'))
    await vi.advanceTimersByTimeAsync(TOOLTIP_HIDE_DELAY_MS + 10)
    expect(tooltipElement().hidden).toBe(false)

    tooltipElement().dispatchEvent(new PointerEvent('pointerleave'))
    await vi.advanceTimersByTimeAsync(TOOLTIP_HIDE_DELAY_MS + 10)
    expect(tooltipElement().hidden).toBe(true)
  })

  it('can opt hover Markdown code backgrounds back in', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const context = viewContributionContext(editorSnapshot())
    const plugin = createTypeScriptLspPlugin({
      hoverMarkdownCodeBackground: true,
      workerFactory: () => worker,
    })
    const provider = activatePlugin(plugin)
    provider.createContribution(context)

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    context.scrollElement.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 12, clientY: 16, buttons: 0 }),
    )
    await vi.advanceTimersByTimeAsync(260)

    const hoverRequest = message(worker.sent.toReversed().find(hasMethod('textDocument/hover')))
    worker.receive({
      jsonrpc: '2.0',
      id: hoverRequest.id,
      result: {
        contents: { kind: 'markdown', value: '`value`\n\n```ts\nconst value: string\n```' },
      },
    })
    await flushPromises()
    await finishHoverReveal()

    expect(
      tooltipElement()
        .querySelector<HTMLElement>('.editor-typescript-lsp-hover-markdown')
        ?.style.getPropertyValue('--editor-typescript-lsp-hover-inline-code-background'),
    ).toContain('color-mix')
    expect(
      tooltipElement()
        .querySelector<HTMLElement>('.editor-typescript-lsp-hover-markdown')
        ?.style.getPropertyValue('--editor-typescript-lsp-hover-code-block-background'),
    ).toContain('color-mix')
  })

  it('caps long hover tooltip content and keeps the body scrollable', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const context = viewContributionContext(editorSnapshot())
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const provider = activatePlugin(plugin)
    provider.createContribution(context)
    mockElementRect(tooltipElement(), new DOMRect(0, 0, 180, 900))

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    context.scrollElement.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 12, clientY: 16, buttons: 0 }),
    )
    await vi.advanceTimersByTimeAsync(260)

    const hoverRequest = message(worker.sent.toReversed().find(hasMethod('textDocument/hover')))
    worker.receive({
      jsonrpc: '2.0',
      id: hoverRequest.id,
      result: {
        contents: {
          kind: 'markdown',
          value: Array.from({ length: 80 }, (_, index) => `Line ${index + 1}`).join('\n\n'),
        },
      },
    })
    await flushPromises()
    await finishHoverReveal()

    expect(tooltipElement().hidden).toBe(false)
    expect(tooltipElement().style.maxHeight).toBe('250px')
    expect(tooltipElement().style.overflow).toBe('hidden')
    expect(tooltipBody()?.style.overflowY).toBe('auto')
    expect(tooltipBody()?.style.minHeight).toBe('0')
  })

  it('jumps to same-file definitions from the current selection', async () => {
    const worker = new FakeWorker()
    const context = viewContributionContext(
      editorSnapshot({
        selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
      }),
    )
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const provider = activatePlugin(plugin)
    const contribution = provider.createContribution(context) as
      | (ReturnType<EditorViewContributionProvider['createContribution']> & {
          goToDefinitionFromSelection(): boolean
        })
      | null
    if (!contribution) throw new Error('missing contribution')

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    expect(contribution.goToDefinitionFromSelection()).toBe(true)

    const definitionRequest = message(
      worker.sent.toReversed().find(hasMethod('textDocument/definition')),
    )
    worker.receive({
      jsonrpc: '2.0',
      id: definitionRequest.id,
      result: [
        {
          uri: 'file:///src/index.ts',
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
        },
      ],
    })
    await flushPromises()

    expect(context.setSelection).toHaveBeenCalledWith(6, 11, 'typescriptLsp.goToDefinition', 6)
  })

  it('underlines jumpable symbols while hovering with a navigation modifier', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const context = viewContributionContext(
      editorSnapshot({ fullText: 'const source = value; const value = 1;' }),
    )
    vi.mocked(context.textOffsetFromPoint).mockReturnValue(15)
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const provider = activatePlugin(plugin)
    provider.createContribution(context)

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    context.scrollElement.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 12,
        clientY: 16,
        ctrlKey: true,
      }),
    )

    const definitionRequest = message(
      worker.sent.toReversed().find(hasMethod('textDocument/definition')),
    )
    expect(definitionRequest.params).toMatchObject({
      textDocument: { uri: 'file:///src/index.ts' },
      position: { line: 0, character: 15 },
    })

    worker.receive({
      jsonrpc: '2.0',
      id: definitionRequest.id,
      result: [
        {
          uri: 'file:///src/index.ts',
          range: {
            start: { line: 0, character: 28 },
            end: { line: 0, character: 33 },
          },
        },
      ],
    })
    await flushPromises()

    expect(context.setRangeHighlight).toHaveBeenCalledWith(
      'editor-test-typescript-lsp-definition-link',
      [{ start: 15, end: 20 }],
      expect.objectContaining({
        color: 'var(--editor-lsp-definition-link)',
        textDecoration: expect.stringContaining('underline'),
      }),
    )
    expect(context.scrollElement.style.cursor).toBe('pointer')

    context.scrollElement.dispatchEvent(new PointerEvent('pointerleave'))
    expect(context.clearRangeHighlight).toHaveBeenCalledWith(
      'editor-test-typescript-lsp-definition-link',
    )
    expect(context.scrollElement.style.cursor).toBe('')
  })

  it('keeps hover tooltip working while hovering with a navigation modifier', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const context = viewContributionContext(
      editorSnapshot({ fullText: 'const source = value; const value = 1;' }),
    )
    vi.mocked(context.textOffsetFromPoint).mockReturnValue(15)
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const provider = activatePlugin(plugin)
    provider.createContribution(context)

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    context.scrollElement.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 12,
        clientY: 16,
        ctrlKey: true,
      }),
    )

    expect(worker.sent.some(hasMethod('textDocument/definition'))).toBe(true)
    await vi.advanceTimersByTimeAsync(260)
    const hoverRequest = message(worker.sent.toReversed().find(hasMethod('textDocument/hover')))
    expect(hoverRequest.params).toMatchObject({
      textDocument: { uri: 'file:///src/index.ts' },
      position: { line: 0, character: 15 },
    })

    worker.receive({
      jsonrpc: '2.0',
      id: hoverRequest.id,
      result: {
        contents: { kind: 'markdown', value: '```ts\nconst value: number\n```' },
        range: {
          start: { line: 0, character: 15 },
          end: { line: 0, character: 20 },
        },
      },
    })
    await flushPromises()
    await finishHoverReveal()

    expect(tooltipElement().hidden).toBe(false)
    expect(tooltipElement().querySelector('pre > code')?.textContent).toBe('const value: number')
  })

  it('does not underline a symbol when its definition is the same range', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const context = viewContributionContext(editorSnapshot())
    vi.mocked(context.textOffsetFromPoint).mockReturnValue(6)
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const provider = activatePlugin(plugin)
    provider.createContribution(context)

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    context.scrollElement.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 12,
        clientY: 16,
        ctrlKey: true,
      }),
    )

    const definitionRequest = message(
      worker.sent.toReversed().find(hasMethod('textDocument/definition')),
    )
    worker.receive({
      jsonrpc: '2.0',
      id: definitionRequest.id,
      result: [
        {
          uri: 'file:///src/index.ts',
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
        },
      ],
    })
    await flushPromises()

    expect(context.setRangeHighlight).not.toHaveBeenCalledWith(
      'editor-test-typescript-lsp-definition-link',
      expect.anything(),
      expect.anything(),
    )
    expect(context.clearRangeHighlight).toHaveBeenCalledWith(
      'editor-test-typescript-lsp-definition-link',
    )
    expect(context.scrollElement.style.cursor).toBe('')
  })

  it('reports cross-file definitions through the open callback', async () => {
    const worker = new FakeWorker()
    const openDefinition = vi.fn()
    const plugin = createTypeScriptLspPlugin({
      workerFactory: () => worker,
      onOpenDefinition: openDefinition,
    })
    const provider = activatePlugin(plugin)
    const contribution = provider.createContribution(
      viewContributionContext(
        editorSnapshot({
          selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
        }),
      ),
    ) as
      | (ReturnType<EditorViewContributionProvider['createContribution']> & {
          goToDefinitionFromSelection(): boolean
        })
      | null
    if (!contribution) throw new Error('missing contribution')

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    expect(contribution.goToDefinitionFromSelection()).toBe(true)

    const definitionRequest = message(
      worker.sent.toReversed().find(hasMethod('textDocument/definition')),
    )
    worker.receive({
      jsonrpc: '2.0',
      id: definitionRequest.id,
      result: [
        {
          uri: 'file:///src/other.ts',
          range: {
            start: { line: 1, character: 7 },
            end: { line: 1, character: 12 },
          },
        },
      ],
    })
    await flushPromises()

    expect(openDefinition).toHaveBeenCalledWith({
      uri: 'file:///src/other.ts',
      path: 'src/other.ts',
      range: {
        start: { line: 1, character: 7 },
        end: { line: 1, character: 12 },
      },
    })
  })

  it('registers VS Code navigation and marker commands at plugin level', () => {
    const plugin = createTypeScriptLspPlugin()
    const { commands } = activatePluginWithCommands(plugin)

    expect([...commands.keys()]).toEqual(
      expect.arrayContaining([
        'goToDefinition',
        'editor.action.goToDefinition',
        'editor.action.goToReferences',
        'editor.action.peekDefinition',
        'editor.action.revealDefinitionAside',
        'editor.action.goToImplementation',
        'editor.action.goToTypeDefinition',
        'editor.action.marker.next',
        'editor.action.marker.prev',
      ]),
    )
  })

  it('requests completions while typing and accepts the selected suggestion', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const container = document.createElement('div')
    const applyEdits = vi.fn<EditorEditContributionContext['applyEdits']>()
    const { provider, features } = activatePluginWithCommands(
      createTypeScriptLspPlugin({ workerFactory: () => worker }),
      { container, applyEdits },
    )
    const context = viewContributionContext(
      editorSnapshot({
        fullText: 'const va',
        selections: [collapsedSelection(8)],
      }),
      { container, features },
    )
    const contribution = provider.createContribution(context)
    if (!contribution) throw new Error('missing contribution')

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    contribution.update(
      editorSnapshot({
        fullText: 'const val',
        textVersion: 2,
        selections: [collapsedSelection(9)],
      }),
      'content',
      documentChange([{ from: 8, to: 8, text: 'l' }]),
    )
    await vi.advanceTimersByTimeAsync(90)

    const request = message(worker.sent.toReversed().find(hasMethod('textDocument/completion')))
    expect(request.params).toMatchObject({
      textDocument: { uri: 'file:///src/index.ts' },
      position: { line: 0, character: 9 },
      context: { triggerKind: 1 },
    })

    worker.receive({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        isIncomplete: false,
        items: [
          {
            label: 'value',
            kind: 6,
            labelDetails: { description: ': number' },
            textEdit: {
              range: {
                start: { line: 0, character: 6 },
                end: { line: 0, character: 9 },
              },
              newText: 'value',
            },
          },
        ],
      },
    })
    await flushPromises()

    expect(completionElement().hidden).toBe(false)
    expect(completionElement().textContent).toContain('value')

    context.scrollElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )

    expect(applyEdits).toHaveBeenCalledWith(
      [{ from: 6, to: 9, text: 'value' }],
      'typescriptLsp.completion.accept',
      { anchor: 11, head: 11 },
    )
    expect(completionElement().hidden).toBe(true)
  })

  it('routes implementation commands through the TypeScript LSP plugin', async () => {
    const worker = new FakeWorker()
    const context = viewContributionContext(
      editorSnapshot({
        selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
      }),
    )
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const { provider, commands } = activatePluginWithCommands(plugin)
    provider.createContribution(context)

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    expect(command(commands, 'editor.action.goToImplementation')({})).toBe(true)

    const request = message(worker.sent.toReversed().find(hasMethod('textDocument/implementation')))
    worker.receive({
      jsonrpc: '2.0',
      id: request.id,
      result: [
        {
          uri: 'file:///src/index.ts',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
        },
      ],
    })
    await flushPromises()

    expect(context.setSelection).toHaveBeenCalledWith(0, 5, 'typescriptLsp.goToImplementation', 0)
  })

  it('routes references commands and jumps to the next same-file reference', async () => {
    const worker = new FakeWorker()
    const context = viewContributionContext(
      editorSnapshot({
        fullText: 'const value = 1; console.log(value);',
        selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
      }),
    )
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const { provider, commands } = activatePluginWithCommands(plugin)
    provider.createContribution(context)

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    expect(command(commands, 'editor.action.goToReferences')({})).toBe(true)

    const request = message(worker.sent.toReversed().find(hasMethod('textDocument/references')))
    expect(request.params).toMatchObject({
      textDocument: { uri: 'file:///src/index.ts' },
      position: { line: 0, character: 6 },
      context: { includeDeclaration: true },
    })

    worker.receive({
      jsonrpc: '2.0',
      id: request.id,
      result: [
        {
          uri: 'file:///src/index.ts',
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
        },
        {
          uri: 'file:///src/index.ts',
          range: {
            start: { line: 0, character: 29 },
            end: { line: 0, character: 34 },
          },
        },
      ],
    })
    await flushPromises()

    expect(context.setSelection).toHaveBeenCalledWith(29, 34, 'typescriptLsp.goToReferences', 29)
  })

  it('moves next and previous marker commands across TypeScript diagnostics', async () => {
    const worker = new FakeWorker()
    const context = viewContributionContext(
      editorSnapshot({
        selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
      }),
    )
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker })
    const { provider, commands } = activatePluginWithCommands(plugin)
    provider.createContribution(context)

    worker.receive(initializeResponse(message(worker.sent[0])))
    await flushPromises()
    worker.receive({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///src/index.ts',
        version: 0,
        diagnostics: [
          {
            severity: 1,
            source: 'typescript',
            message: 'first',
            range: {
              start: { line: 0, character: 2 },
              end: { line: 0, character: 3 },
            },
          },
          {
            severity: 1,
            source: 'typescript',
            message: 'second',
            range: {
              start: { line: 0, character: 22 },
              end: { line: 0, character: 23 },
            },
          },
        ],
      },
    })

    expect(command(commands, 'editor.action.marker.next')({})).toBe(true)
    expect(context.setSelection).toHaveBeenCalledWith(22, 23, 'typescriptLsp.marker.next', 22)

    expect(command(commands, 'editor.action.marker.prev')({})).toBe(true)
    expect(context.setSelection).toHaveBeenCalledWith(2, 3, 'typescriptLsp.marker.previous', 2)
  })
})

function activatePlugin(
  plugin: ReturnType<typeof createTypeScriptLspPlugin>,
): EditorViewContributionProvider {
  let provider: EditorViewContributionProvider | null = null
  plugin.activate({
    registerHighlighter: () => ({ dispose: () => undefined }),
    registerSyntaxProvider: () => ({ dispose: () => undefined }),
    registerViewContribution: (value) => {
      provider = value
      return { dispose: () => undefined }
    },
    registerCommandContribution: () => ({ dispose: () => undefined }),
    registerCapabilityContribution: () => ({ dispose: () => undefined }),
    registerEditContribution: () => ({ dispose: () => undefined }),
    registerDecorationContribution: () => ({ dispose: () => undefined }),
    registerGutterContribution: () => ({ dispose: () => undefined }),
    registerInjectedTextRowProvider: () => ({ dispose: () => undefined }),
  } satisfies EditorPluginContext)

  if (!provider) throw new Error('missing provider')
  return provider
}

function activatePluginWithCommands(
  plugin: ReturnType<typeof createTypeScriptLspPlugin>,
  options?: FeatureContributionContextOptions,
): {
  readonly provider: EditorViewContributionProvider
  readonly commands: ReadonlyMap<EditorCommandId, EditorCommandHandler>
  readonly features: ReadonlyMap<unknown, unknown>
}
function activatePluginWithCommands(
  plugin: ReturnType<typeof createTypeScriptLspPlugin>,
  options?: FeatureContributionContextOptions,
): {
  readonly provider: EditorViewContributionProvider
  readonly commands: ReadonlyMap<EditorCommandId, EditorCommandHandler>
  readonly features: ReadonlyMap<unknown, unknown>
} {
  let provider: EditorViewContributionProvider | null = null
  const commands = new Map<EditorCommandId, EditorCommandHandler>()
  const features = options?.features ?? new Map<string, unknown>()
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
    registerDecorationContribution: () => ({ dispose: () => undefined }),
    registerEditContribution: (value) => {
      value.createContribution(editContributionContext({ ...options, features }))
      return { dispose: () => undefined }
    },
    registerGutterContribution: () => ({ dispose: () => undefined }),
    registerInjectedTextRowProvider: () => ({ dispose: () => undefined }),
  } satisfies EditorPluginContext)

  if (!provider) throw new Error('missing provider')
  return { provider, commands, features }
}

type FeatureContributionContextOptions = {
  readonly container?: HTMLDivElement
  readonly features?: Map<unknown, unknown>
  readonly applyEdits?: EditorEditContributionContext['applyEdits']
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
  options: FeatureContributionContextOptions = {},
): EditorEditContributionContext {
  return {
    hasDocument: () => true,
    materializeFullText: () => '',
    getTextSnapshot: () => null,
    focusEditor: vi.fn(),
    applyEdits: options.applyEdits ?? vi.fn(),
    registerFeature: (id, feature) => {
      options.features?.set(id, feature)
      return { dispose: () => options.features?.delete(id) }
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
  options: {
    readonly container?: HTMLDivElement
    readonly features?: ReadonlyMap<unknown, unknown>
  } = {},
): EditorViewContributionContext {
  const element = options.container ?? document.createElement('div')
  const getFeature = vi.fn((token: unknown): unknown | null => {
    const feature = options.features?.get(token)
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
    textOffsetFromPoint: vi.fn(() => 22),
    getRangeClientRect: vi.fn(() => new DOMRect(10, 20, 40, 18)),
    setRangeHighlight: vi.fn(),
    clearRangeHighlight: vi.fn(),
  }
}

function minimapFeature(): EditorMinimapFeature {
  return {
    setDecorations: vi.fn(),
    clearDecorations: vi.fn(),
    getDecorations: vi.fn(() => []),
    subscribe: vi.fn(() => ({ dispose: vi.fn() })),
  }
}

function editorSnapshot(options: Partial<EditorViewSnapshot> = {}): EditorViewSnapshot {
  const fullText = options.fullText ?? 'const value: string = 1;'
  return {
    documentId: 'src/index.ts',
    languageId: 'typescript',
    fullText,
    textVersion: 1,
    lineStarts: [0],
    tokens: [],
    brackets: [],
    selections: [],
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
    ...options,
  }
}

function snapshotWithThrowingText(
  text: string,
  options: Partial<EditorViewSnapshot> = {},
): EditorViewSnapshot {
  const snapshot = editorSnapshot({
    ...options,
    fullText: text,
    textSnapshot: stringTextSnapshot(text),
    lineStarts: lineStarts(text),
  })
  Object.defineProperty(snapshot, 'fullText', {
    configurable: true,
    enumerable: true,
    get: () => {
      throw new Error('unexpected snapshot.fullText materialization')
    },
  })
  return snapshot
}

function stringTextSnapshot(text: string): TextSnapshot {
  return {
    length: text.length,
    materializeFullText: () => text,
    readRange: (start, end) => text.slice(start, end),
    forEachTextChunk: (visit) => visit(text, 0, text.length),
  }
}

function lineStarts(text: string): number[] {
  const starts = [0]
  let index = text.indexOf('\n')

  while (index !== -1) {
    starts.push(index + 1)
    index = text.indexOf('\n', index + 1)
  }

  return starts
}

function collapsedSelection(offset: number): EditorViewSnapshot['selections'][number] {
  return {
    anchorOffset: offset,
    headOffset: offset,
    startOffset: offset,
    endOffset: offset,
  }
}

function documentChange(edits: readonly TextEdit[]): DocumentSessionChange {
  return {
    kind: 'edit',
    edits,
    tokens: [],
    timings: [],
    canUndo: false,
    canRedo: false,
  } as unknown as DocumentSessionChange
}

function initializeResponse(request: JsonMessage): JsonMessage {
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: 2,
        },
        completionProvider: {
          resolveProvider: false,
          triggerCharacters: ['.'],
        },
        definitionProvider: true,
        hoverProvider: true,
        implementationProvider: true,
        referencesProvider: true,
        typeDefinitionProvider: true,
      },
    },
  }
}

function publishDiagnosticsMessage(
  options: {
    readonly range?: {
      readonly start: { readonly line: number; readonly character: number }
      readonly end: { readonly line: number; readonly character: number }
    }
  } = {},
): JsonMessage {
  return {
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri: 'file:///src/index.ts',
      version: 0,
      diagnostics: [
        {
          severity: 1,
          source: 'typescript',
          message: 'bad assignment',
          range: options.range ?? {
            start: { line: 0, character: 22 },
            end: { line: 0, character: 23 },
          },
        },
      ],
    },
  }
}

function sentMethods(worker: FakeWorker): readonly unknown[] {
  return worker.sent.map((item) => message(item).method)
}

function sentSocketMethods(socket: FakeWebSocket): readonly unknown[] {
  return socket.sent.map((item) => jsonMessage(item).method)
}

function textDocumentFor(item: unknown): unknown {
  const params = message(item).params as { readonly textDocument: unknown }
  return params.textDocument
}

function contentChangesFor(item: JsonMessage): unknown {
  const params = item.params as { readonly contentChanges: unknown }
  return params.contentChanges
}

function latestMessage(items: readonly unknown[], method: string): JsonMessage {
  return message(items.toReversed().find(hasMethod(method)))
}

function hasCancelRequestFor(id: unknown): (item: unknown) => boolean {
  return (item) => {
    const current = message(item)
    const params = current.params as { readonly id?: unknown } | undefined
    return current.method === '$/cancelRequest' && params?.id === id
  }
}

function transportParityMessages(
  messages: readonly JsonMessage[],
): readonly { readonly id: unknown; readonly method: unknown; readonly params: unknown }[] {
  const methods = new Set([
    'initialize',
    'initialized',
    'textDocument/didOpen',
    'editor/typescript/setWorkspaceFiles',
  ])
  return messages
    .filter((item) => typeof item.method === 'string' && methods.has(item.method))
    .map((item) => ({ id: item.id, method: item.method, params: item.params }))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function errorEvent(message: string): Event {
  if (typeof ErrorEvent !== 'undefined') return new ErrorEvent('error', { message })
  return { message } as ErrorEvent
}

function latestRangeHighlightRanges(
  context: EditorViewContributionContext,
  name: string,
): readonly { readonly start: number; readonly end: number }[] {
  const calls = vi.mocked(context.setRangeHighlight!).mock.calls
  for (const call of calls.toReversed()) {
    if (call[0] === name) return call[1]
  }

  throw new Error(`Missing range highlight call: ${name}`)
}

function tooltipElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.editor-typescript-lsp-hover')
  if (!element) throw new Error('missing tooltip')
  return element
}

function tooltipAnchorElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.editor-typescript-lsp-hover-anchor')
  if (!element) throw new Error('missing tooltip anchor')
  return element
}

function tooltipBody(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.editor-typescript-lsp-hover-body')
}

function copyButton(): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>('.editor-typescript-lsp-hover-copy')
  if (!element) throw new Error('missing copy button')
  return element
}

function completionElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.editor-typescript-lsp-completion')
  if (!element) throw new Error('missing completion widget')
  return element
}

function mockElementRect(element: HTMLElement, rect: DOMRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect,
  })
}

function message(item: unknown): JsonMessage {
  if (!isRecord(item)) throw new Error('missing message')
  return item
}

function jsonMessage(item: unknown): JsonMessage {
  if (typeof item !== 'string') throw new Error('missing JSON message')
  return JSON.parse(item) as JsonMessage
}

function hasMethod(method: string): (item: unknown) => boolean {
  return (item) => message(item).method === method
}

function hasSocketMethod(method: string): (item: unknown) => boolean {
  return (item) => typeof item === 'string' && jsonMessage(item).method === method
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function finishHoverReveal(): Promise<void> {
  await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS - 260)
}
