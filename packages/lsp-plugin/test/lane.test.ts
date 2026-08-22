import type { LspClient, LspWorkspace } from '@singapor/lsp'
import { describe, expect, it, vi } from 'vitest'

import { acquireLanguageServerLane } from '../src/lane'
import type {
  LspConnectionCallbacks,
  LspConnectionOptions,
  LspConnectionProvider,
} from '../src/lspConnection'

describe('language-server lane acquisition', () => {
  it('delegates each lane to its supplied provider and releases independently', async () => {
    const first = providerHarness()
    const second = providerHarness()
    const firstLane = acquireLanguageServerLane(laneOptions('first', first.provider))
    const secondLane = acquireLanguageServerLane(laneOptions('second', second.provider))

    first.connect()
    second.connect()
    await Promise.all([firstLane.ready, secondLane.ready])

    expect(first.acquired).toHaveLength(1)
    expect(second.acquired).toHaveLength(1)
    expect(first.acquired[0]?.rootUri).toBe('file:///workspace')
    expect(first.acquired[0]?.timeoutMs).toBe(15_000)
    expect(first.notifications).toEqual([['workspace/configurationChanged', { complete: true }]])
    firstLane.release()
    secondLane.release()
    expect(first.released).toBe(1)
    expect(second.released).toBe(1)
  })

  it('holds readiness behind named notifications without blocking another lane', async () => {
    const healthy = providerHarness()
    const failed = providerHarness({ notificationError: new Error('rejected') })
    const healthyLane = acquireLanguageServerLane(laneOptions('healthy', healthy.provider))
    const failedLane = acquireLanguageServerLane(laneOptions('failed', failed.provider))

    healthy.connect()
    failed.connect()

    await expect(healthyLane.ready).resolves.toMatchObject({ client: healthy.client })
    await expect(failedLane.ready).rejects.toThrow('rejected')
    expect(healthyLane.isReady()).toBe(true)
    expect(failedLane.isReady()).toBe(false)
  })

  it('replays complete ready notifications for every pooled acquisition', async () => {
    const shared = providerHarness()
    const first = acquireLanguageServerLane(laneOptions('shared', shared.provider))
    shared.connect(0)
    await first.ready
    first.release()

    const second = acquireLanguageServerLane(laneOptions('shared', shared.provider))
    shared.connect(1)
    await second.ready

    expect(shared.notifications).toEqual([
      ['workspace/configurationChanged', { complete: true }],
      ['workspace/configurationChanged', { complete: true }],
    ])
    second.release()
  })

  it('finishes lane-owned readiness work before reporting the connection externally', async () => {
    const harness = providerHarness()
    const events: string[] = []
    const lane = acquireLanguageServerLane(
      {
        ...laneOptions('ordered', harness.provider),
        onConnected: () => events.push('connected'),
      },
      { onReady: () => events.push('ready') },
    )

    harness.connect()
    await lane.ready

    expect(events).toEqual(['ready', 'connected'])
    lane.release()
  })
})

function laneOptions(id: string, connectionProvider: LspConnectionProvider) {
  return {
    id,
    features: { hover: 0 },
    connectionProvider,
    readyNotifications: [{ method: 'workspace/configurationChanged', params: { complete: true } }],
    rootUri: 'file:///workspace',
    webSocketRoute: `ws://localhost/${id}`,
  }
}

function providerHarness(options: { notificationError?: Error } = {}) {
  const acquired: LspConnectionOptions[] = []
  const notifications: [string, unknown][] = []
  const callbacks: LspConnectionCallbacks[] = []
  let released = 0
  const workspace = {} as LspWorkspace
  const client = {
    notify: vi.fn(async (method: string, params: unknown) => {
      notifications.push([method, params])
      if (options.notificationError) throw options.notificationError
    }),
  } as unknown as LspClient
  const connection = { client, workspace }
  const provider: LspConnectionProvider = {
    acquire: (connectionOptions, connectionCallbacks) => {
      acquired.push(connectionOptions)
      callbacks.push(connectionCallbacks)
      return {
        connection: connection as never,
        release: () => {
          released += 1
        },
      }
    },
  }

  return {
    acquired,
    client,
    notifications,
    provider,
    get released() {
      return released
    },
    connect: (index = 0) => {
      callbacks[index]?.onStatusChange?.('loading')
      callbacks[index]?.onConnected()
    },
  }
}
