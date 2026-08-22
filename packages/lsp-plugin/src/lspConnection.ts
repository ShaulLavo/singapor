import {
  createWebSocketLspTransport,
  createWorkerLspTransport,
  LspClient,
  LspWorkspace,
  type LspManagedTransport,
  type LspNotificationHandler,
  type LspWebSocketTransportOptions,
  type LspWorkerLike,
} from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

import type { LanguageServerStatus } from './types'

export type LspConnectionTransportFactory = () => LspManagedTransport | Promise<LspManagedTransport>

export type LspConnectionOptions = {
  readonly rootUri: lsp.DocumentUri | null
  readonly initializationOptions: unknown
  readonly timeoutMs: number
  /**
   * Merged over `defaultClientCapabilities()` by the client itself, so a host declares only what it
   * adds. This is how a host turns on a feature the defaults deliberately leave off —
   * `textDocument.semanticTokens` among them, which no server sends without being asked.
   */
  readonly capabilities?: lsp.ClientCapabilities
  /**
   * Load-bearing rather than cosmetic: at least one real server branches on the client name and
   * withholds a request from clients it does not recognise. The value is the host's to pick.
   */
  readonly clientInfo?: lsp.InitializeParams['clientInfo']
  /**
   * Merged around the connection's own handlers rather than replacing them. See createClient.
   */
  readonly notificationHandlers?: Readonly<Record<string, LspNotificationHandler<LspClient>>>
  createTransport(): LspManagedTransport | Promise<LspManagedTransport>
}

export type LspConnectionCallbacks = {
  onConnected(): void
  onUnavailable(): void
  onPublishDiagnostics(params: unknown): void
  onStatusChange?: (status: LanguageServerStatus) => void
  onError?: (error: unknown) => void
}

/** A connection a view borrows. `release` ends its interest; closing is the provider's call. */
export type LspConnectionLease = {
  readonly connection: LspConnection
  release(): void
}

/**
 * Supplies connections that outlive one view, so a file switch does not pay a handshake and an
 * `initialize` round trip. `options` is the connection the plugin would have built: build from it on
 * a new key, ignore it on a known one.
 *
 * **`callbacks.onConnected` must never fire synchronously from `acquire`** — the caller is
 * mid-construction. Replay it on a microtask.
 */
export type LspConnectionProvider = {
  acquire(options: LspConnectionOptions, callbacks: LspConnectionCallbacks): LspConnectionLease
}

export class LspConnection {
  public readonly workspace = new LspWorkspace()
  public readonly client: LspClient

  private transport: LspManagedTransport | null = null
  private removeTransportCloseListener: (() => void) | null = null
  private disposed = false
  private status: LanguageServerStatus = 'idle'

  public constructor(
    private readonly options: LspConnectionOptions,
    private readonly callbacks: LspConnectionCallbacks,
  ) {
    this.client = this.createClient()
  }

  public connect(): void {
    this.setStatus('loading')
    this.connectTransport()
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.removeTransportCloseListener?.()
    this.removeTransportCloseListener = null
    this.client.disconnect()
    this.transport?.close()
    this.transport = null
    this.setStatus('idle')
  }

  private createClient(): LspClient {
    const hostHandlers = this.options.notificationHandlers
    return new LspClient({
      rootUri: this.options.rootUri,
      workspaceFolders: null,
      workspace: this.workspace,
      timeoutMs: this.options.timeoutMs,
      initializationOptions: this.options.initializationOptions,
      capabilities: this.options.capabilities,
      clientInfo: this.options.clientInfo,
      // Host handlers are merged *around* the connection's own rather than replacing them: the
      // whole diagnostics feature hangs off publishDiagnostics, so a host that happens to want that
      // notification too must not be able to take it away. Its handler runs after ours.
      notificationHandlers: {
        ...hostHandlers,
        'textDocument/publishDiagnostics': (client, params, message) => {
          this.callbacks.onPublishDiagnostics(params)
          hostHandlers?.['textDocument/publishDiagnostics']?.(client, params, message)
          return true
        },
      },
    })
  }

  private connectTransport(): void {
    try {
      const transport = this.options.createTransport()
      if (isTransportPromise(transport)) {
        void transport
          .then((value) => this.connectManagedTransport(value))
          .catch((error) => {
            this.handleConnectError(error)
          })
        return
      }

      this.connectManagedTransport(transport)
    } catch (error) {
      this.handleConnectError(error)
    }
  }

  private connectManagedTransport(transport: LspManagedTransport): void {
    if (this.disposed) {
      transport.close()
      return
    }

    this.transport = transport
    this.removeTransportCloseListener = transport.onDidClose(() => this.handleTransportClose())
    void this.client
      .connect(transport)
      .then(() => this.handleConnected())
      .catch((error: unknown) => this.handleConnectError(error))
  }

  private handleConnected(): void {
    if (this.disposed) return

    this.setStatus('ready')
    this.callbacks.onConnected()
  }

  private handleConnectError(error: unknown): void {
    if (this.disposed) return

    this.closeFailedConnection()
    this.setStatus('error')
    this.handleError(error)
  }

  private handleTransportClose(): void {
    if (this.disposed) return

    this.removeTransportCloseListener?.()
    this.removeTransportCloseListener = null
    this.transport = null
    this.client.disconnect()
    this.setStatus('error')
    this.callbacks.onUnavailable()
    this.handleError(new Error('LSP transport closed'))
  }

  private closeFailedConnection(): void {
    this.removeTransportCloseListener?.()
    this.removeTransportCloseListener = null
    this.client.disconnect()
    this.transport?.close()
    this.transport = null
    this.callbacks.onUnavailable()
  }

  private setStatus(status: LanguageServerStatus): void {
    if (this.status === status) return

    this.status = status
    this.callbacks.onStatusChange?.(status)
  }

  private handleError(error: unknown): void {
    this.callbacks.onError?.(error)
  }
}

export function createWebSocketLspTransportFactory(
  route: string | URL,
  options?: LspWebSocketTransportOptions,
): LspConnectionTransportFactory {
  return () =>
    createWebSocketLspTransport(route, {
      protocols: options?.protocols,
      WebSocketCtor: options?.WebSocketCtor,
    })
}

export function createWorkerLspTransportFactory(
  workerFactory: () => LspWorkerLike,
): LspConnectionTransportFactory {
  return () =>
    createWorkerLspTransport(workerFactory(), {
      messageFormat: 'json',
      terminateOnClose: true,
    })
}

function isTransportPromise(
  value: LspManagedTransport | Promise<LspManagedTransport>,
): value is Promise<LspManagedTransport> {
  return typeof (value as Promise<LspManagedTransport>).then === 'function'
}
