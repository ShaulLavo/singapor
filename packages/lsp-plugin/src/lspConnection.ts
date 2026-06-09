import {
  createWebSocketLspTransport,
  createWorkerLspTransport,
  LspClient,
  LspWorkspace,
  type LspManagedTransport,
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
  createTransport(): LspManagedTransport | Promise<LspManagedTransport>
}

export type LspConnectionCallbacks = {
  onConnected(): void
  onUnavailable(): void
  onPublishDiagnostics(params: unknown): void
  onStatusChange?: (status: LanguageServerStatus) => void
  onError?: (error: unknown) => void
}

export class LspConnection {
  public readonly workspace = new LspWorkspace()
  public readonly client: LspClient

  private transport: LspManagedTransport | null = null
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
    this.client.disconnect()
    this.transport?.close()
    this.transport = null
    this.setStatus('idle')
  }

  private createClient(): LspClient {
    return new LspClient({
      rootUri: this.options.rootUri,
      workspaceFolders: null,
      workspace: this.workspace,
      timeoutMs: this.options.timeoutMs,
      initializationOptions: this.options.initializationOptions,
      notificationHandlers: {
        'textDocument/publishDiagnostics': (_client, params) => {
          this.callbacks.onPublishDiagnostics(params)
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

  private closeFailedConnection(): void {
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
