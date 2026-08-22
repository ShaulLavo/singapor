import type { LspManagedTransport, LspTransportHandler } from '@singapor/lsp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  LanguageServerStatus,
  LspConnectionCallbacks,
  LspConnectionLease,
  LspConnectionOptions,
  LspConnectionPoolEvent,
} from '../src/index.ts'
import { LspConnectionPool } from '../src/index.ts'

/** The socket the pool is supposed to stop rebuilding. */
class FakeTransport implements LspManagedTransport {
  public static readonly created: FakeTransport[] = []
  public readonly sent: string[] = []
  public closed = false
  private readonly handlers = new Set<LspTransportHandler>()

  public constructor() {
    FakeTransport.created.push(this)
  }

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
    this.closed = true
    this.handlers.clear()
  }

  public receive(message: unknown): void {
    for (const handler of this.handlers) handler(JSON.stringify(message))
  }

  public methods(): readonly unknown[] {
    return this.sent.map((message) => (JSON.parse(message) as { method?: unknown }).method)
  }
}

function connectionOptions(overrides: Partial<LspConnectionOptions> = {}): LspConnectionOptions {
  return {
    capabilities: {},
    createTransport: () => new FakeTransport(),
    initializationOptions: undefined,
    notificationHandlers: { 'custom/refresh': () => true },
    rootUri: 'file:///w',
    timeoutMs: 5_000,
    ...overrides,
  }
}

function callbacks() {
  return {
    onConnected: vi.fn<() => void>(),
    onPublishDiagnostics: vi.fn<(params: unknown) => void>(),
    onStatusChange: vi.fn<(status: LanguageServerStatus) => void>(),
    onUnavailable: vi.fn<() => void>(),
    onError: vi.fn<(error: unknown) => void>(),
  } satisfies LspConnectionCallbacks
}

/** Answers the handshake the pool starts the moment a key is first acquired. */
function completeHandshake(transport: FakeTransport): void {
  const request = JSON.parse(transport.sent[0] ?? '{}') as { id?: unknown }
  transport.receive({
    id: request.id,
    jsonrpc: '2.0',
    result: { capabilities: { textDocumentSync: { change: 2, openClose: true } } },
  })
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

const KEY = 'w\u0000typescript'

let pool: LspConnectionPool
let events: LspConnectionPoolEvent[]

beforeEach(() => {
  events = []
  pool = new LspConnectionPool({ onEvent: (event) => events.push(event) })
})

afterEach(() => {
  pool.dispose()
  FakeTransport.created.length = 0
  vi.useRealTimers()
})

describe('LspConnectionPool', () => {
  it('opens one connection for repeated acquires of the same root and server', () => {
    const provider = pool.provider(KEY)

    const first = provider.acquire(connectionOptions(), callbacks())
    const second = provider.acquire(connectionOptions(), callbacks())

    // The measured defect was thirteen of these in twenty-two seconds.
    expect(FakeTransport.created).toHaveLength(1)
    expect(first.connection).toBe(second.connection)
  })

  it('opens a separate connection per server on one root', () => {
    pool.provider(KEY).acquire(connectionOptions(), callbacks())
    pool.provider('w\u0000python').acquire(connectionOptions(), callbacks())

    expect(FakeTransport.created).toHaveLength(2)
  })

  it('keeps the connection alive across the gap between two views', () => {
    vi.useFakeTimers()
    const provider = pool.provider(KEY)
    const lease = provider.acquire(connectionOptions(), callbacks())

    // A file switch disposes the old contribution before building the next, so
    // the lease count touches zero in between. Closing on that would be the bug.
    lease.release()
    vi.advanceTimersByTime(1_000)
    provider.acquire(connectionOptions(), callbacks())
    vi.advanceTimersByTime(120_000)

    expect(FakeTransport.created).toHaveLength(1)
    expect(FakeTransport.created[0]?.closed).toBe(false)
  })

  it('closes a connection nothing has borrowed once the grace period passes', () => {
    vi.useFakeTimers()
    const lease = pool.provider(KEY).acquire(connectionOptions(), callbacks())

    lease.release()
    vi.advanceTimersByTime(60_000)

    expect(FakeTransport.created[0]?.closed).toBe(true)
  })

  it('tells a view that joined a live connection it is already connected', async () => {
    const provider = pool.provider(KEY)
    provider.acquire(connectionOptions(), callbacks())
    const transport = FakeTransport.created[0]
    if (!transport) throw new Error('missing transport')
    completeHandshake(transport)
    await flush()

    const late = callbacks()
    provider.acquire(connectionOptions(), late)
    // Never synchronously: the borrower is mid-construction and the semantic
    // token layer this callback feeds does not exist yet.
    expect(late.onConnected).not.toHaveBeenCalled()
    await flush()

    expect(late.onConnected).toHaveBeenCalledTimes(1)
    expect(late.onStatusChange).toHaveBeenCalledWith('ready')
  })

  it('delivers diagnostics to every borrower', async () => {
    const provider = pool.provider(KEY)
    const first = callbacks()
    const second = callbacks()
    provider.acquire(connectionOptions(), first)
    provider.acquire(connectionOptions(), second)
    const transport = FakeTransport.created[0]
    if (!transport) throw new Error('missing transport')
    completeHandshake(transport)
    await flush()

    transport.receive({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { diagnostics: [], uri: 'file:///w/a.ts' },
    })

    expect(first.onPublishDiagnostics).toHaveBeenCalledTimes(1)
    expect(second.onPublishDiagnostics).toHaveBeenCalledTimes(1)
  })

  it('stops delivering to a borrower that released', async () => {
    const provider = pool.provider(KEY)
    const gone = callbacks()
    const lease: LspConnectionLease = provider.acquire(connectionOptions(), gone)
    provider.acquire(connectionOptions(), callbacks())
    const transport = FakeTransport.created[0]
    if (!transport) throw new Error('missing transport')
    completeHandshake(transport)
    await flush()
    lease.release()

    transport.receive({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { diagnostics: [], uri: 'file:///w/a.ts' },
    })

    expect(gone.onPublishDiagnostics).not.toHaveBeenCalled()
  })

  it('routes a notification to the handler of every borrower, not just the first', async () => {
    const provider = pool.provider(KEY)
    const firstHandler = vi.fn(() => true)
    const secondHandler = vi.fn(() => true)
    provider.acquire(
      connectionOptions({ notificationHandlers: { 'custom/refresh': firstHandler } }),
      callbacks(),
    )
    provider.acquire(
      connectionOptions({ notificationHandlers: { 'custom/refresh': secondHandler } }),
      callbacks(),
    )
    const transport = FakeTransport.created[0]
    if (!transport) throw new Error('missing transport')
    completeHandshake(transport)
    await flush()

    transport.receive({ jsonrpc: '2.0', method: 'custom/refresh', params: {} })

    // The controller a refresh is for belongs to whichever surface is showing the
    // file, which is never reliably the one that happened to connect first.
    expect(firstHandler).toHaveBeenCalledTimes(1)
    expect(secondHandler).toHaveBeenCalledTimes(1)
  })

  it('reports the lifecycle a host needs to log', async () => {
    vi.useFakeTimers()
    const provider = pool.provider(KEY)
    const first = provider.acquire(connectionOptions(), callbacks())
    provider.acquire(connectionOptions(), callbacks())
    const transport = FakeTransport.created[0]
    if (!transport) throw new Error('missing transport')
    completeHandshake(transport)
    await vi.advanceTimersByTimeAsync(0)
    first.release()
    vi.advanceTimersByTime(60_000)

    expect(events.map((event) => event.kind)).toEqual(['created', 'reused', 'ready', 'released'])
    // `closed` is absent on purpose: one borrower is still holding it.
    expect(events.at(-1)?.leaseCount).toBe(1)
    expect(events.find((event) => event.kind === 'ready')?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports a close only once nothing holds the connection', () => {
    vi.useFakeTimers()
    const lease = pool.provider(KEY).acquire(connectionOptions(), callbacks())

    lease.release()
    vi.advanceTimersByTime(60_000)

    const closed = events.find((event) => event.kind === 'closed')
    expect(closed?.key).toBe(KEY)
    expect(closed?.reachedReady).toBe(false)
  })

  it('names a notification a later borrower declared that this connection cannot dispatch', () => {
    const provider = pool.provider(KEY)
    provider.acquire(connectionOptions({ notificationHandlers: {} }), callbacks())
    provider.acquire(
      connectionOptions({ notificationHandlers: { 'custom/late': () => true } }),
      callbacks(),
    )

    // Silently dropping it is how a refresh notification stops arriving and
    // nothing anywhere says so.
    expect(events.find((event) => event.kind === 'handler_ignored')?.methods).toEqual([
      'custom/late',
    ])
  })
})
