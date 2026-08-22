import type { LspClient, LspNotificationHandler } from '@singapor/lsp'

import {
  LspConnection,
  type LspConnectionCallbacks,
  type LspConnectionLease,
  type LspConnectionOptions,
  type LspConnectionProvider,
} from './lspConnection'
import type { LanguageServerStatus } from './types'

/**
 * How long a connection with no borrowers is kept. A file switch drops the lease count to zero for a
 * tick or two on its way from one view to the next; the cost of holding on is one idle socket, the
 * cost of letting go early is another handshake against a server that may still be indexing.
 */
const DEFAULT_IDLE_GRACE_MS = 30_000

/** What a pooled connection just did, for a host that wants to log it. */
export type LspConnectionPoolEvent = {
  readonly kind:
    | 'created'
    | 'reused'
    | 'ready'
    | 'released'
    | 'closed'
    | 'retired'
    | 'error'
    | 'handler_ignored'
  readonly key: string
  readonly leaseCount: number
  readonly status: LanguageServerStatus
  /** Time to `initialize` for `ready`; the connection's whole life for `closed`. */
  readonly durationMs?: number
  readonly reachedReady?: boolean
  readonly error?: unknown
  /** Methods a late borrower declared that this connection cannot dispatch. */
  readonly methods?: readonly string[]
}

export type LspConnectionPoolOptions = {
  readonly idleGraceMs?: number
  readonly onEvent?: (event: LspConnectionPoolEvent) => void
}

type NotificationHandlers = Readonly<Record<string, LspNotificationHandler<LspClient>>>

/** Handlers are per borrower: the first one's are bound to a view the reader may have left. */
type ConnectionLease = {
  readonly callbacks: LspConnectionCallbacks
  readonly notificationHandlers: NotificationHandlers
}

type PooledConnection = {
  readonly key: string
  readonly leases: Set<ConnectionLease>
  readonly createdAt: number
  /** Fixed at construction, when the client reads the record. A later borrower outside it is a defect. */
  readonly notificationMethods: ReadonlySet<string>
  connection: LspConnection
  status: LanguageServerStatus
  connected: boolean
  readyAt: number | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

/**
 * One connection per key, outliving the views that borrow it. A view contribution is rebuilt on
 * every file switch, and a connection it owns dies with it — thirteen handshakes in twenty-two
 * seconds, measured. The key is opaque: how a server session is named is the host's vocabulary.
 */
export class LspConnectionPool {
  readonly #entries = new Map<string, PooledConnection>()
  readonly #idleGraceMs: number
  readonly #onEvent?: (event: LspConnectionPoolEvent) => void

  public constructor(options: LspConnectionPoolOptions = {}) {
    this.#idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS
    this.#onEvent = options.onEvent
  }

  /** A provider bound to one key, in the shape the plugin takes. */
  public provider(key: string): LspConnectionProvider {
    return { acquire: (options, callbacks) => this.acquire(key, options, callbacks) }
  }

  public acquire(
    key: string,
    options: LspConnectionOptions,
    callbacks: LspConnectionCallbacks,
  ): LspConnectionLease {
    const existing = this.#entries.get(key)
    const entry = existing ?? this.#create(key, options)
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }

    const lease: ConnectionLease = {
      callbacks,
      notificationHandlers: options.notificationHandlers ?? {},
    }
    this.#reportUndispatchable(entry, lease)
    entry.leases.add(lease)
    this.#emit(entry, existing ? 'reused' : 'created')
    this.#replayTo(entry, lease)

    return {
      connection: entry.connection,
      release: () => this.#release(entry, lease),
    }
  }

  /** Closes every connection. For teardown and for tests, not for routine use. */
  public dispose(): void {
    for (const entry of this.#entries.values()) {
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
      entry.connection.dispose()
    }
    this.#entries.clear()
  }

  #create(key: string, options: LspConnectionOptions): PooledConnection {
    const notificationMethods = new Set(Object.keys(options.notificationHandlers ?? {}))
    const entry: PooledConnection = {
      connected: false,
      connection: null as unknown as LspConnection,
      createdAt: now(),
      idleTimer: null,
      key,
      leases: new Set(),
      notificationMethods,
      readyAt: null,
      status: 'idle',
    }
    // Assigned after the record exists because the callbacks close over it: the
    // connection reports `loading` from inside `connect()`, which is before any
    // `new LspConnection(...)` expression could have returned.
    entry.connection = new LspConnection(
      { ...options, notificationHandlers: this.#dispatchers(entry, notificationMethods) },
      this.#fanOut(entry),
    )
    this.#entries.set(key, entry)
    entry.connection.connect()

    return entry
  }

  /** Handled is the disjunction: one view claiming a notification must not hide it from another. */
  #dispatchers(entry: PooledConnection, methods: ReadonlySet<string>): NotificationHandlers {
    const handlers: Record<string, LspNotificationHandler<LspClient>> = {}
    for (const method of methods) {
      handlers[method] = (client, params, message) => {
        let handled = false
        for (const lease of leasesOf(entry))
          handled =
            (lease.notificationHandlers[method]?.(client, params, message) ?? false) || handled

        return handled
      }
    }

    return handlers
  }

  /** Diagnostics broadcast rather than routed: `DocumentSync` already drops uris it does not hold. */
  #fanOut(entry: PooledConnection): LspConnectionCallbacks {
    return {
      onConnected: () => {
        entry.connected = true
        entry.readyAt = now()
        this.#emit(entry, 'ready', { durationMs: Math.round(entry.readyAt - entry.createdAt) })
        for (const lease of leasesOf(entry)) lease.callbacks.onConnected()
      },
      onDiagnosticRefresh: () => {
        for (const lease of leasesOf(entry)) lease.callbacks.onDiagnosticRefresh?.()
      },
      onUnavailable: () => {
        entry.connected = false
        this.#retire(entry)
        for (const lease of leasesOf(entry)) lease.callbacks.onUnavailable()
      },
      onPublishDiagnostics: (params) => {
        for (const lease of leasesOf(entry)) lease.callbacks.onPublishDiagnostics(params)
      },
      onStatusChange: (status) => {
        entry.status = status
        for (const lease of leasesOf(entry)) lease.callbacks.onStatusChange?.(status)
      },
      onError: (error) => {
        this.#emit(entry, 'error', { error })
        for (const lease of leasesOf(entry)) lease.callbacks.onError?.(error)
      },
    }
  }

  /** A microtask, not a straight call: `acquire` runs inside the contribution's constructor. */
  #replayTo(entry: PooledConnection, lease: ConnectionLease): void {
    if (entry.status === 'idle') return

    const status = entry.status
    const connected = entry.connected
    queueMicrotask(() => {
      if (!entry.leases.has(lease)) return

      lease.callbacks.onStatusChange?.(status)
      if (connected) lease.callbacks.onConnected()
    })
  }

  #release(entry: PooledConnection, lease: ConnectionLease): void {
    if (!entry.leases.delete(lease)) return

    this.#emit(entry, 'released')
    if (entry.leases.size > 0) return
    if (this.#entries.get(entry.key) !== entry) return

    entry.idleTimer = setTimeout(() => this.#closeIdle(entry), this.#idleGraceMs)
  }

  #closeIdle(entry: PooledConnection): void {
    entry.idleTimer = null
    if (entry.leases.size > 0) return
    if (this.#entries.get(entry.key) !== entry) return

    this.#entries.delete(entry.key)
    entry.connection.dispose()
    this.#emit(entry, 'closed', {
      durationMs: Math.round(now() - entry.createdAt),
      reachedReady: entry.readyAt !== null,
    })
  }

  #retire(entry: PooledConnection): void {
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    entry.idleTimer = null
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key)
    entry.connection.dispose()
    this.#emit(entry, 'retired', {
      durationMs: Math.round(now() - entry.createdAt),
      reachedReady: entry.readyAt !== null,
    })
  }

  #reportUndispatchable(entry: PooledConnection, lease: ConnectionLease): void {
    const methods = Object.keys(lease.notificationHandlers).filter(
      (method) => !entry.notificationMethods.has(method),
    )
    if (methods.length === 0) return

    this.#emit(entry, 'handler_ignored', { methods })
  }

  #emit(
    entry: PooledConnection,
    kind: LspConnectionPoolEvent['kind'],
    extra: Omit<LspConnectionPoolEvent, 'kind' | 'key' | 'leaseCount' | 'status'> = {},
  ): void {
    this.#onEvent?.({
      key: entry.key,
      kind,
      leaseCount: entry.leases.size,
      status: entry.status,
      ...extra,
    })
  }
}

/** Snapshotted: a callback can release its own lease mid-iteration. */
function leasesOf(entry: PooledConnection): readonly ConnectionLease[] {
  return Array.from(entry.leases)
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}
