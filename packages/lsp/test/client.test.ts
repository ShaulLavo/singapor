import { arrayLspLineStarts } from '../src/workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  LspClient,
  LspRequestCancelledError,
  LspResponseError,
  LspWorkspace,
  METHOD_NOT_FOUND,
  type LspTextSnapshot,
  type LspTransport,
  type LspTransportHandler,
} from '../src/index.ts'

type JsonMessage = Record<string, unknown>

class TestTransport implements LspTransport {
  public readonly sent: JsonMessage[] = []
  public failSend = false
  private readonly handlers = new Set<LspTransportHandler>()

  public send(message: string): void {
    if (this.failSend) throw new Error('transport send failed')

    this.sent.push(JSON.parse(message) as JsonMessage)
  }

  public subscribe(handler: LspTransportHandler): void {
    this.handlers.add(handler)
  }

  public unsubscribe(handler: LspTransportHandler): void {
    this.handlers.delete(handler)
  }

  public receive(message: JsonMessage): void {
    for (const handler of this.handlers) handler(JSON.stringify(message))
  }

  public message(index: number): JsonMessage {
    const message = this.sent[index]
    if (!message) throw new Error(`missing message ${index}`)
    return message
  }

  public lastMessage(): JsonMessage {
    return this.message(this.sent.length - 1)
  }
}

type InitializedClient = {
  readonly client: LspClient
  readonly transport: TestTransport
}

afterEach(() => {
  vi.useRealTimers()
})

describe('LspClient', () => {
  it('sends initialize first, then initialized after the server responds', async () => {
    const transport = new TestTransport()
    const client = new LspClient({ rootUri: 'file:///repo', timeoutMs: 1000 })
    const initializing = client.connect(transport)

    const initialize = transport.message(0)
    expect(initialize.method).toBe('initialize')
    expect(initializeParams(initialize).rootUri).toBe('file:///repo')
    expect(transport.sent).toHaveLength(1)

    transport.receive(initializeResponse(initialize, { textDocumentSync: 2 }))
    await initializing

    expect(transport.message(1).method).toBe('initialized')
    expect(client.serverCapabilities?.textDocumentSync).toBe(2)
  })

  it('routes successful and failed request responses', async () => {
    const { client, transport } = await initializedClient()

    const success = client.request('test/success', { value: 1 })
    const successRequest = transport.lastMessage()
    transport.receive({
      jsonrpc: '2.0',
      id: successRequest.id,
      result: { ok: true },
    })
    await expect(success).resolves.toEqual({ ok: true })

    const failed = client.request('test/failure', {})
    const failedRequest = transport.lastMessage()
    transport.receive({
      jsonrpc: '2.0',
      id: failedRequest.id,
      error: { code: -32000, message: 'server failed' },
    })
    await expect(failed).rejects.toBeInstanceOf(LspResponseError)
    await expect(failed).rejects.toMatchObject({ code: -32000 })
  })

  it('rejects requests and disconnects when the transport send fails', async () => {
    const { client, transport } = await initializedClient()
    transport.failSend = true

    await expect(client.request('test/sendFailure', {})).rejects.toThrow('transport send failed')

    expect(client.connected).toBe(false)
  })

  it('returns rejected notify promises when the transport send fails', async () => {
    const { client, transport } = await initializedClient()
    transport.failSend = true

    await expect(client.notify('test/event', {})).rejects.toThrow('transport send failed')

    expect(client.connected).toBe(false)
  })

  it('enforces request timeouts', async () => {
    vi.useFakeTimers()
    const { client } = await initializedClient({}, 10)

    const request = client.request('test/slow', {})
    const rejected = expect(request).rejects.toThrow('LSP request timed out: test/slow')
    await vi.advanceTimersByTimeAsync(11)

    await rejected
  })

  it('sends cancellation notifications for explicit request handles', async () => {
    const { client, transport } = await initializedClient()

    const request = client.requestHandle('workspace/symbol', { query: 'name' })
    request.response.catch(() => undefined)
    const pendingRequest = transport.lastMessage()

    request.cancel()

    const cancel = transport.lastMessage()
    expect(cancel.method).toBe('$/cancelRequest')
    expect(cancel.params).toEqual({ id: request.id })
    expect(request.id).toBe(pendingRequest.id)
    await expect(request.response).rejects.toBeInstanceOf(LspRequestCancelledError)

    client.disconnect()
  })

  it('routes server messages to the configured handler without logging by default', async () => {
    const serverMessageHandler = vi.fn()
    const { transport } = await initializedClientWithConfig({ serverMessageHandler })

    transport.receive({
      jsonrpc: '2.0',
      method: 'window/logMessage',
      params: { type: 2, message: 'indexing' },
    })

    expect(serverMessageHandler).toHaveBeenCalledWith(expect.any(LspClient), {
      method: 'window/logMessage',
      type: 2,
      message: 'indexing',
      params: { type: 2, message: 'indexing' },
    })
  })

  it('dispatches configured notifications and reports unhandled notifications', async () => {
    const handled = vi.fn(() => true)
    const unhandled = vi.fn()
    const { transport } = await initializedClientWithConfig({
      notificationHandlers: { 'custom/event': handled },
      unhandledNotification: unhandled,
    })

    transport.receive({ jsonrpc: '2.0', method: 'custom/event', params: { value: 1 } })
    transport.receive({ jsonrpc: '2.0', method: 'unknown/event', params: { value: 2 } })

    expect(handled).toHaveBeenCalledWith(
      expect.any(LspClient),
      { value: 1 },
      expect.objectContaining({ method: 'custom/event' }),
    )
    expect(unhandled).toHaveBeenCalledWith(
      expect.any(LspClient),
      'unknown/event',
      { value: 2 },
      expect.objectContaining({ method: 'unknown/event' }),
    )
  })

  it('responds to unknown server requests with MethodNotFound', async () => {
    const { transport } = await initializedClient()

    transport.receive({
      jsonrpc: '2.0',
      id: 'server-request',
      method: 'workspace/configuration',
      params: {},
    })

    const response = transport.lastMessage()
    expect(response.id).toBe('server-request')
    expect(response.error).toEqual({
      code: METHOD_NOT_FOUND,
      message: 'Method not implemented: workspace/configuration',
    })
  })

  it('queues document opens until initialization completes', async () => {
    const workspace = new LspWorkspace()
    workspace.openDocument({
      uri: 'file:///repo/index.ts',
      languageId: 'typescript',
      text: 'const a = 1;',
    })
    workspace.updateDocument('file:///repo/index.ts', 'const aa = 1;', {
      edits: [{ from: 7, to: 8, text: 'aa' }],
    })

    const transport = new TestTransport()
    const client = new LspClient({ workspace, timeoutMs: 1000 })
    const initializing = client.connect(transport)

    expect(transport.sent).toHaveLength(1)
    transport.receive(initializeResponse(transport.message(0), { textDocumentSync: 2 }))
    await initializing

    const didOpen = transport.message(2)
    expect(didOpen.method).toBe('textDocument/didOpen')
    expect(didOpenTextDocument(didOpen)).toEqual({
      uri: 'file:///repo/index.ts',
      languageId: 'typescript',
      version: 1,
      text: 'const aa = 1;',
    })
  })

  it('sends full document changes when the server requests full sync', async () => {
    const { client, transport } = await initializedClient({ textDocumentSync: 1 })

    client.workspace.openDocument({
      uri: 'file:///repo/a.ts',
      languageId: 'typescript',
      text: 'abc',
    })
    client.workspace.updateDocument('file:///repo/a.ts', 'abcX', {
      edits: [{ from: 3, to: 3, text: 'X' }],
    })

    const didChange = transport.lastMessage()
    expect(didChange.method).toBe('textDocument/didChange')
    expect(didChangeTextDocument(didChange)).toEqual({ uri: 'file:///repo/a.ts', version: 1 })
    expect(didChangeContentChanges(didChange)).toEqual([{ text: 'abcX' }])
  })

  it('does not throw from workspace sync when the transport send fails', async () => {
    const { client, transport } = await initializedClient({ textDocumentSync: 1 })
    transport.failSend = true

    expect(() =>
      client.workspace.openDocument({
        uri: 'file:///repo/a.ts',
        languageId: 'typescript',
        text: 'abc',
      }),
    ).not.toThrow()

    expect(client.connected).toBe(false)
  })

  it('sends incremental document changes when the server requests incremental sync', async () => {
    const { client, transport } = await initializedClient({ textDocumentSync: 2 })

    client.workspace.openDocument({
      uri: 'file:///repo/a.ts',
      languageId: 'typescript',
      text: 'ab\ncd',
    })
    client.workspace.updateDocument('file:///repo/a.ts', 'aXb\ncd', {
      edits: [{ from: 1, to: 1, text: 'X' }],
    })

    const didChange = transport.lastMessage()
    expect(didChangeTextDocument(didChange)).toEqual({ uri: 'file:///repo/a.ts', version: 1 })
    expect(didChangeContentChanges(didChange)).toEqual([
      {
        range: {
          start: { line: 0, character: 1 },
          end: { line: 0, character: 1 },
        },
        text: 'X',
      },
    ])
  })

  it('sends snapshot incremental changes without materializing the next full text', async () => {
    const { client, transport } = await initializedClient({ textDocumentSync: 2 })

    client.workspace.openDocument({
      uri: 'file:///repo/a.ts',
      languageId: 'typescript',
      text: 'ab\ncd',
    })
    client.workspace.updateDocumentSnapshot('file:///repo/a.ts', {
      textSnapshot: throwingFullTextSnapshot('aXb\ncd'),
      lineStarts: arrayLspLineStarts([0, 4]),
      edits: [{ from: 1, to: 1, text: 'X' }],
    })

    const didChange = transport.lastMessage()
    expect(didChangeTextDocument(didChange)).toEqual({ uri: 'file:///repo/a.ts', version: 1 })
    expect(didChangeContentChanges(didChange)).toEqual([
      {
        range: {
          start: { line: 0, character: 1 },
          end: { line: 0, character: 1 },
        },
        text: 'X',
      },
    ])
  })

  it('materializes snapshot text when the server requests full sync', async () => {
    const { client, transport } = await initializedClient({ textDocumentSync: 1 })

    client.workspace.openDocument({
      uri: 'file:///repo/a.ts',
      languageId: 'typescript',
      text: 'abc',
    })
    client.workspace.updateDocumentSnapshot('file:///repo/a.ts', {
      textSnapshot: stringTextSnapshot('abcX'),
      lineStarts: arrayLspLineStarts([0]),
      edits: [{ from: 3, to: 3, text: 'X' }],
    })

    const didChange = transport.lastMessage()
    expect(didChangeTextDocument(didChange)).toEqual({ uri: 'file:///repo/a.ts', version: 1 })
    expect(didChangeContentChanges(didChange)).toEqual([{ text: 'abcX' }])
  })

  it('skips document sync notifications when the server does not opt in', async () => {
    const { client, transport } = await initializedClient({})

    client.workspace.openDocument({
      uri: 'file:///repo/plain.txt',
      languageId: 'plaintext',
      text: 'abc',
    })
    client.workspace.updateDocument('file:///repo/plain.txt', 'abcd', {
      edits: [{ from: 3, to: 3, text: 'd' }],
    })
    client.workspace.closeDocument('file:///repo/plain.txt')

    expect(transport.sent.map((message) => message.method)).toEqual(['initialize', 'initialized'])
  })

  it('sends didClose for synced documents', async () => {
    const { client, transport } = await initializedClient({ textDocumentSync: 1 })

    client.workspace.openDocument({
      uri: 'file:///repo/close.ts',
      languageId: 'typescript',
      text: 'abc',
    })
    client.workspace.closeDocument('file:///repo/close.ts')

    const didClose = transport.lastMessage()
    expect(didClose.method).toBe('textDocument/didClose')
    expect(didClose.params).toEqual({
      textDocument: { uri: 'file:///repo/close.ts' },
    })
  })

  it('sends open, change, save, and close in document lifecycle order', async () => {
    const { client, transport } = await initializedClientWithConfig(
      {
        capabilities: { textDocument: { synchronization: { didSave: true } } },
        timeoutMs: 1000,
      },
      { textDocumentSync: { openClose: true, change: 2, save: { includeText: true } } },
    )

    client.workspace.openDocument({
      uri: 'file:///repo/lifecycle.ts',
      languageId: 'typescript',
      text: 'let value = 1;',
    })
    client.workspace.updateDocument('file:///repo/lifecycle.ts', 'let value = 2;', {
      edits: [{ from: 12, to: 13, text: '2' }],
    })
    client.workspace.saveDocument('file:///repo/lifecycle.ts')
    client.workspace.closeDocument('file:///repo/lifecycle.ts')

    expect(transport.sent.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didSave',
      'textDocument/didClose',
    ])
    expect(transport.message(4).params).toEqual({
      textDocument: { uri: 'file:///repo/lifecycle.ts' },
      text: 'let value = 2;',
    })
  })
})

async function initializedClient(
  capabilities: JsonMessage = {},
  timeoutMs = 1000,
): Promise<InitializedClient> {
  return initializedClientWithConfig({ timeoutMs }, capabilities)
}

async function initializedClientWithConfig(
  config: ConstructorParameters<typeof LspClient>[0],
  capabilities: JsonMessage = {},
): Promise<InitializedClient> {
  const transport = new TestTransport()
  const client = new LspClient(config)
  const initializing = client.connect(transport)
  transport.receive(initializeResponse(transport.message(0), capabilities))
  await initializing
  return { client, transport }
}

function initializeResponse(request: JsonMessage, capabilities: JsonMessage): JsonMessage {
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: { capabilities },
  }
}

function initializeParams(message: JsonMessage): Record<string, unknown> {
  return message.params as Record<string, unknown>
}

function didOpenTextDocument(message: JsonMessage): Record<string, unknown> {
  const params = message.params as { readonly textDocument: Record<string, unknown> }
  return params.textDocument
}

function didChangeTextDocument(message: JsonMessage): Record<string, unknown> {
  const params = message.params as { readonly textDocument: Record<string, unknown> }
  return params.textDocument
}

function didChangeContentChanges(message: JsonMessage): readonly unknown[] {
  const params = message.params as { readonly contentChanges: readonly unknown[] }
  return params.contentChanges
}

function throwingFullTextSnapshot(text: string): LspTextSnapshot {
  return {
    length: text.length,
    materializeFullText: () => {
      throw new Error('unexpected full text materialization')
    },
    readRange: (start, end) => text.slice(start, end),
  }
}

function stringTextSnapshot(text: string): LspTextSnapshot {
  return {
    length: text.length,
    materializeFullText: () => text,
    readRange: (start, end) => text.slice(start, end),
  }
}
