import { describe, expect, it, vi } from 'vitest'
import {
  createEditorBufferSession,
  createEditorTextBuffer,
  createEditorViewSession,
} from '../src/documentSession'
import { Editor } from '../src/editor/Editor'
import { createEditorPreparedDocument } from '../src/editor/preparedDocument'
import type {
  EditorHighlighterProvider,
  EditorHighlighterSession,
  EditorPlugin,
} from '../src/plugins'
import { createPieceTableSnapshot } from '../src/pieceTable/snapshot'
import {
  createEmptySyntaxResult,
  type EditorSyntaxProvider,
  type EditorSyntaxSession,
} from '../src/syntax/session'

describe('prepared editor documents', () => {
  it('transfers exact structural and highlighter sessions once', async () => {
    const buffer = createEditorTextBuffer('const value = 1;\n')
    const structuralSession = syntaxSession()
    const highlighterSession = highlightSession()
    const structuralProvider: EditorSyntaxProvider = {
      createSession: vi.fn(() => structuralSession),
    }
    const highlighterProvider: EditorHighlighterProvider = {
      createSession: vi.fn(() => highlighterSession),
    }
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 4,
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })
    const abortController = new AbortController()
    const structuralOutcome = prepared.startStage({
      abortSignal: abortController.signal,
      configuration: structuralConfiguration,
      configurationTag: ['tree-sitter', 1],
      family: 'structural',
      provider: structuralProvider,
      range: { startIndex: 0, endIndex: buffer.getSnapshot().length },
    })
    const highlighterOutcome = prepared.startStage({
      abortSignal: abortController.signal,
      configurationTag: ['shiki', 'dark'],
      family: 'highlighter',
      provider: highlighterProvider,
      range: 'full',
    })

    await expect(structuralOutcome).resolves.toBe('ready')
    await expect(highlighterOutcome).resolves.toBe('ready')
    const claimed = prepared.take(match(buffer, structuralProvider, highlighterProvider))

    expect(claimed?.lineStarts).toEqual([0, 17])
    expect(claimed?.structural?.runtimeSessionId).not.toBe(claimed?.highlighter?.runtimeSessionId)
    expect(claimed?.structural?.readyResult).toBe(structuralSession.getResult())
    expect(claimed?.highlighter?.readyResult?.tokens).toEqual([])
    expect(prepared.take(match(buffer, structuralProvider, highlighterProvider))).toBeNull()

    prepared.dispose()
    expect(structuralSession.dispose).not.toHaveBeenCalled()
    expect(highlighterSession.dispose).not.toHaveBeenCalled()
    claimed?.structural?.dispose()
    claimed?.structural?.dispose()
    claimed?.highlighter?.dispose()
    claimed?.highlighter?.dispose()
    expect(structuralSession.dispose).toHaveBeenCalledTimes(1)
    expect(highlighterSession.dispose).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale snapshot and disposes unfinished ownership', () => {
    const buffer = createEditorTextBuffer('alpha\n')
    const session = syntaxSession()
    const provider: EditorSyntaxProvider = { createSession: () => session }
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 2,
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })
    prepared.startStage({
      abortSignal: new AbortController().signal,
      configuration: structuralConfiguration,
      configurationTag: ['tree-sitter', 1],
      family: 'structural',
      provider,
      range: { startIndex: 0, endIndex: 6 },
    })

    const claimed = prepared.take({
      ...match(buffer, provider, null),
      snapshot: createPieceTableSnapshot('alpha\n'),
    })

    expect(claimed).toBeNull()
    expect(session.dispose).toHaveBeenCalledTimes(1)
  })

  it('drops only the family whose configuration no longer matches', async () => {
    const buffer = createEditorTextBuffer('alpha\n')
    const structuralSession = syntaxSession()
    const highlighterSession = highlightSession()
    const structuralProvider: EditorSyntaxProvider = {
      createSession: () => structuralSession,
    }
    const highlighterProvider: EditorHighlighterProvider = {
      createSession: () => highlighterSession,
    }
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 2,
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })
    prepared.startStage({
      abortSignal: new AbortController().signal,
      configuration: structuralConfiguration,
      configurationTag: ['tree-sitter', 1],
      family: 'structural',
      provider: structuralProvider,
      range: { startIndex: 0, endIndex: 6 },
    })
    prepared.startStage({
      abortSignal: new AbortController().signal,
      configurationTag: ['shiki', 'dark'],
      family: 'highlighter',
      provider: highlighterProvider,
      range: 'full',
    })

    const claimed = prepared.take({
      ...match(buffer, structuralProvider, highlighterProvider),
      highlighterConfigurationTag: ['shiki', 'light'],
    })
    await Promise.resolve()

    expect(claimed?.structural?.session).toBe(structuralSession)
    expect(claimed?.highlighter).toBeNull()
    expect(highlighterSession.dispose).toHaveBeenCalledTimes(1)
    claimed?.structural?.dispose()
  })

  it('attaches transferred sessions without repeating covered preparation', async () => {
    const buffer = createEditorTextBuffer('const value = 1;\n')
    const structuralSession = syntaxSession()
    const highlighterSession = highlightSession()
    const structuralProvider: EditorSyntaxProvider = {
      createSession: vi.fn(() => structuralSession),
    }
    const highlighterProvider: EditorHighlighterProvider = {
      createSession: vi.fn(() => highlighterSession),
    }
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 4,
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })
    const structuralOutcome = prepared.startStage({
      abortSignal: new AbortController().signal,
      configuration: structuralConfiguration,
      configurationTag: ['tree-sitter', 1],
      family: 'structural',
      provider: structuralProvider,
      range: { startIndex: 0, endIndex: buffer.getSnapshot().length },
    })
    const highlighterOutcome = prepared.startStage({
      abortSignal: new AbortController().signal,
      configurationTag: ['shiki', 'dark'],
      family: 'highlighter',
      provider: highlighterProvider,
      range: 'full',
    })
    await Promise.all([structuralOutcome, highlighterOutcome])
    const plugin: EditorPlugin = {
      activate: (context) => [
        context.registerSyntaxProvider(structuralProvider),
        context.registerHighlighter(highlighterProvider),
      ],
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, { plugins: [plugin] })

    editor.attachSession(
      createEditorBufferSession(buffer, createEditorViewSession(buffer, 'prepared-view')),
      {
        documentConfigurationTag: [],
        documentId: 'file.ts',
        highlighterConfigurationTag: ['shiki', 'dark'],
        languageId: 'typescript',
        preparedDocument: prepared,
        structuralConfigurationTag: ['tree-sitter', 1],
      },
    )
    await Promise.resolve()

    expect(structuralProvider.createSession).toHaveBeenCalledTimes(1)
    expect(highlighterProvider.createSession).toHaveBeenCalledTimes(1)
    expect(structuralSession.refresh).toHaveBeenCalledTimes(1)
    expect(highlighterSession.refresh).toHaveBeenCalledTimes(1)
    expect(editor.getState()).toMatchObject({
      initialHighlightStatus: 'painted',
      syntaxStatus: 'ready',
    })

    editor.dispose()
    container.remove()
    expect(structuralSession.dispose).toHaveBeenCalledTimes(1)
    expect(highlighterSession.dispose).toHaveBeenCalledTimes(1)
  })

  it('adopts an in-flight structural session without opening a replacement', async () => {
    const buffer = createEditorTextBuffer('const value = 1;\n')
    const completion = deferred<ReturnType<typeof createEmptySyntaxResult>>()
    const structuralSession = syntaxSession()
    structuralSession.refresh = vi.fn(() => completion.promise)
    const structuralProvider: EditorSyntaxProvider = {
      createSession: vi.fn(() => structuralSession),
    }
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 4,
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })
    prepared.startStage({
      abortSignal: new AbortController().signal,
      configuration: { ...structuralConfiguration, includeHighlights: true },
      configurationTag: ['tree-sitter', 1],
      family: 'structural',
      provider: structuralProvider,
      range: { startIndex: 0, endIndex: buffer.getSnapshot().length },
    })
    const plugin: EditorPlugin = {
      activate: (context) => context.registerSyntaxProvider(structuralProvider),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, { plugins: [plugin] })

    editor.attachSession(
      createEditorBufferSession(buffer, createEditorViewSession(buffer, 'pending-view')),
      {
        documentConfigurationTag: [],
        documentId: 'file.ts',
        highlighterConfigurationTag: ['shiki', 'dark'],
        languageId: 'typescript',
        preparedDocument: prepared,
        structuralConfigurationTag: ['tree-sitter', 1],
      },
    )
    expect(structuralProvider.createSession).toHaveBeenCalledOnce()

    completion.resolve(createEmptySyntaxResult())
    await vi.waitFor(() => expect(editor.getState().syntaxStatus).toBe('ready'))

    expect(structuralProvider.createSession).toHaveBeenCalledOnce()
    expect(structuralSession.refresh).toHaveBeenCalledOnce()
    editor.dispose()
    container.remove()
  })

  it('finishes an aborted stage and disposes its session once', async () => {
    const buffer = createEditorTextBuffer('alpha\n')
    const completion = deferred<ReturnType<typeof createEmptySyntaxResult>>()
    const session = syntaxSession()
    session.refresh = vi.fn(() => completion.promise)
    const provider: EditorSyntaxProvider = { createSession: () => session }
    const abortController = new AbortController()
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 4,
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })
    const outcome = prepared.startStage({
      abortSignal: abortController.signal,
      configuration: structuralConfiguration,
      configurationTag: ['tree-sitter', 1],
      family: 'structural',
      provider,
      range: { startIndex: 0, endIndex: buffer.getSnapshot().length },
    })

    abortController.abort()
    completion.resolve(createEmptySyntaxResult())

    await expect(outcome).resolves.toBe('aborted')
    prepared.dispose()
    expect(session.dispose).toHaveBeenCalledOnce()
  })
})

const structuralConfiguration = {
  includeCaptures: false,
  includeHighlights: false,
  syntaxMode: 'range' as const,
}

function match(
  buffer: ReturnType<typeof createEditorTextBuffer>,
  structuralProvider: EditorSyntaxProvider | null,
  highlighterProvider: EditorHighlighterProvider | null,
) {
  return {
    documentConfigurationTag: [] as const,
    documentId: 'file.ts',
    highlighterConfigurationTag: ['shiki', 'dark'] as const,
    highlighterProvider,
    languageId: 'typescript',
    snapshot: buffer.getSnapshot(),
    structuralConfiguration,
    structuralConfigurationTag: ['tree-sitter', 1] as const,
    structuralProvider,
  }
}

function syntaxSession(): EditorSyntaxSession {
  const result = createEmptySyntaxResult()
  return {
    applyChange: vi.fn(async () => result),
    dispose: vi.fn(),
    getResult: () => result,
    getSnapshotVersion: () => 0,
    getTokens: () => result.tokens,
    queryRange: vi.fn(async () => result),
    refresh: vi.fn(async () => result),
  }
}

function highlightSession(): EditorHighlighterSession {
  return {
    applyChange: vi.fn(async () => ({ tokens: [] })),
    dispose: vi.fn(),
    refresh: vi.fn(async () => ({ tokens: [] })),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
