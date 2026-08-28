import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createPieceTableSnapshot } from '../../src'
import type {
  EditorDisposable,
  EditorHighlighterProvider,
  EditorPlugin,
  EditorPluginContext,
} from '../../src/plugins'
import {
  createShikiHighlighterPlugin,
  createShikiHighlighterProvider,
  type ShikiHighlighterPluginOptions,
  type ShikiHighlighterSessionOptions,
  type ShikiWorkerOwner,
} from '../../src/shiki'

const workerOwner = vi.hoisted(() => ({
  canUseWorker: vi.fn(() => true),
  createSession: vi.fn(() => null),
  dispose: vi.fn(async () => undefined),
  loadTheme: vi.fn(),
}))
const createShikiWorkerOwner = vi.hoisted(() => vi.fn(() => workerOwner))
const DEFAULT_SHIKI_WORKER_OWNER_KEY = Symbol.for('@singapor/core/shiki/default-worker-owner')

vi.mock('../../src/shiki/workerClient', () => ({
  createShikiWorkerOwner,
}))

describe('createShikiHighlighterPlugin', () => {
  beforeEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[DEFAULT_SHIKI_WORKER_OWNER_KEY]
    createShikiWorkerOwner.mockClear()
    workerOwner.canUseWorker.mockClear()
    workerOwner.canUseWorker.mockReturnValue(true)
    workerOwner.createSession.mockClear()
    workerOwner.dispose.mockClear()
    workerOwner.loadTheme.mockClear()
  })

  it('maps .tsx TypeScript documents to Shiki TSX', () => {
    const provider = activateHighlighterProvider()
    const text = 'const el = <div className="x" />'

    provider.createSession({
      documentId: 'App.tsx',
      languageId: 'typescript',
      fullText: text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(workerOwner.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        lang: 'tsx',
      }),
    )
  })

  it('keeps the source extension when a secondary view adds a document fragment', () => {
    const provider = createShikiHighlighterProvider(pluginOptions())
    const text = 'const el = <div />'

    provider.createSession({
      documentId: 'App.tsx#diff-old',
      languageId: 'typescript',
      fullText: text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(workerOwner.createSession).toHaveBeenCalledWith(expect.objectContaining({ lang: 'tsx' }))
  })

  it('creates a provider that can be shared without activating an editor plugin', () => {
    const provider = createShikiHighlighterProvider(pluginOptions())
    const text = 'const value = 1'

    provider.createSession({
      documentId: 'index.ts',
      languageId: 'typescript',
      fullText: text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(workerOwner.createSession).toHaveBeenCalledTimes(1)
  })

  it('maps .jsx JavaScript documents to Shiki JSX', () => {
    const provider = activateHighlighterProvider()
    const text = 'const el = <div className="x" />'

    provider.createSession({
      documentId: 'App.jsx',
      languageId: 'javascript',
      fullText: text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(workerOwner.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        lang: 'jsx',
      }),
    )
  })

  it('keeps explicit language overrides ahead of extension inference', () => {
    const provider = activateHighlighterProvider({
      languages: { typescript: 'typescript' },
    })
    const text = 'const el = <div className="x" />'

    provider.createSession({
      documentId: 'App.tsx',
      languageId: 'typescript',
      fullText: text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(workerOwner.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        lang: 'typescript',
      }),
    )
  })

  it('reuses one default worker owner across activations', () => {
    const first = activateHighlighterProvider({
      preloadLanguages: ['typescript', 'tsx'],
      preloadThemes: ['github-dark'],
    })
    const second = activateHighlighterProvider({
      preloadLanguages: ['tsx', 'typescript'],
      preloadThemes: ['github-dark'],
    })

    expect(createShikiWorkerOwner).toHaveBeenCalledTimes(1)
    expect(second).not.toBe(first)
  })

  it('keeps the default worker owner alive when the plugin disposes', () => {
    const disposables = activateWithDisposables()

    for (const disposable of disposables) disposable.dispose()

    expect(workerOwner.dispose).not.toHaveBeenCalled()
  })

  it('re-registers a fresh provider when the theme changes and honors unsubscribe', () => {
    let listener: (() => void) | null = null
    const unsubscribe = vi.fn()
    const registrations: {
      provider: EditorHighlighterProvider
      disposed: boolean
    }[] = []
    const context: Partial<EditorPluginContext> = {
      registerHighlighter: (provider) => {
        const registration = { provider, disposed: false }
        registrations.push(registration)
        return {
          dispose: () => {
            registration.disposed = true
          },
        }
      },
    }

    const disposables = toDisposables(
      createShikiHighlighterPlugin(
        pluginOptions({
          onThemeChanged: (nextListener) => {
            listener = nextListener
            return unsubscribe
          },
        }),
      ).activate(context as EditorPluginContext),
    )

    expect(registrations).toHaveLength(1)
    expect(listener).not.toBeNull()

    listener!()

    expect(registrations).toHaveLength(2)
    expect(registrations[0]!.disposed).toBe(true)
    expect(registrations[1]!.disposed).toBe(false)
    expect(registrations[1]!.provider).not.toBe(registrations[0]!.provider)

    for (const disposable of disposables) disposable.dispose()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(registrations[1]!.disposed).toBe(true)
  })

  it('uses a provided worker owner for sessions without disposing it', () => {
    const sharedOwner = {
      canUseWorker: vi.fn(() => true),
      createSession: vi.fn(() => null),
      dispose: vi.fn(async () => undefined),
      loadTheme: vi.fn(),
    }
    const provider = activateHighlighterProvider({
      workerOwner: sharedOwner as unknown as ShikiWorkerOwner,
    })
    const text = 'const value = 1'

    provider.createSession({
      documentId: 'index.ts',
      languageId: 'typescript',
      fullText: text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(sharedOwner.createSession).toHaveBeenCalledTimes(1)
    expect(workerOwner.createSession).not.toHaveBeenCalled()
    expect(createShikiWorkerOwner).not.toHaveBeenCalled()
  })

  it('keeps a provided worker owner alive when the plugin disposes', () => {
    const sharedOwner = {
      canUseWorker: vi.fn(() => true),
      createSession: vi.fn(() => null),
      dispose: vi.fn(async () => undefined),
      loadTheme: vi.fn(),
    }
    const disposables = activateWithDisposables({
      workerOwner: sharedOwner as unknown as ShikiWorkerOwner,
    })

    for (const disposable of disposables) disposable.dispose()

    expect(sharedOwner.dispose).not.toHaveBeenCalled()
    expect(workerOwner.dispose).not.toHaveBeenCalled()
  })

  it('passes resolved theme registrations through to worker sessions', async () => {
    const themeRegistration = {
      name: 'my-custom-theme',
      colors: { 'editor.background': '#101010' },
      tokenColors: [],
    }
    const provider = activateHighlighterProvider({
      theme: 'my-custom-theme',
      resolveTheme: async () => themeRegistration,
    })
    const text = 'const value = 1'

    provider.createSession({
      documentId: 'index.ts',
      languageId: 'typescript',
      fullText: text,
      snapshot: createPieceTableSnapshot(text),
    })

    const call = workerOwner.createSession.mock.calls.at(-1) as unknown as
      | [ShikiHighlighterSessionOptions]
      | undefined
    const options = call?.[0]
    expect(options?.theme).toBe('my-custom-theme')
    await expect(options?.registrations).resolves.toMatchObject({
      themeRegistration: { name: 'my-custom-theme' },
    })
  })

  it('requires a non-empty name on resolved theme registrations', async () => {
    const provider = activateHighlighterProvider({
      resolveTheme: async () => ({ name: '' }),
    })
    const text = 'const value = 1'

    provider.createSession({
      documentId: 'index.ts',
      languageId: 'typescript',
      fullText: text,
      snapshot: createPieceTableSnapshot(text),
    })

    const call = workerOwner.createSession.mock.calls.at(-1) as unknown as
      | [ShikiHighlighterSessionOptions]
      | undefined
    const options = call?.[0]
    await expect(options?.registrations).rejects.toThrow(
      'Shiki theme registrations require a non-empty name',
    )
  })
})

function activateHighlighterProvider(
  options: Partial<ShikiHighlighterPluginOptions> = {},
): EditorHighlighterProvider {
  let provider: EditorHighlighterProvider | null = null
  const context: Partial<EditorPluginContext> = {
    registerHighlighter: (nextProvider) => {
      provider = nextProvider
      return { dispose: () => undefined }
    },
  }

  createShikiHighlighterPlugin(pluginOptions(options)).activate(context as EditorPluginContext)
  if (!provider) throw new Error('Expected Shiki plugin to register a highlighter')
  return provider
}

function activateWithDisposables(
  options: Partial<ShikiHighlighterPluginOptions> = {},
): readonly EditorDisposable[] {
  const context: Partial<EditorPluginContext> = {
    registerHighlighter: () => ({ dispose: () => undefined }),
  }

  return toDisposables(
    createShikiHighlighterPlugin(pluginOptions(options)).activate(context as EditorPluginContext),
  )
}

function pluginOptions(
  overrides: Partial<ShikiHighlighterPluginOptions> = {},
): ShikiHighlighterPluginOptions {
  return {
    resolveLanguage: async (language) => [languageRegistration(language)],
    resolveTheme: async (theme) => ({ name: theme }),
    ...overrides,
  }
}

function languageRegistration(name: string) {
  return {
    name,
    patterns: [],
    repository: {},
    scopeName: `source.${name}`,
  }
}

function toDisposables(result: ReturnType<EditorPlugin['activate']>): readonly EditorDisposable[] {
  if (!result) return []
  // `dispose` only exists on the single-disposable arm of the activate() union.
  return 'dispose' in result ? [result] : result
}
