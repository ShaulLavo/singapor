import { describe, expect, it, vi } from 'vitest'
import {
  createEditorBufferSession,
  createEditorTextBuffer,
  createEditorViewSession,
} from '../src/documentSession'
import { Editor } from '../src/editor/Editor'
import { createEditorPreparedDocument } from '../src/editor/preparedDocument'
import type {
  EditorHighlightResult,
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
      tabSizePolicy: 'detect-indentation',
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
    expect(prepared.runtimeSessionIds()).toMatchObject({
      highlighter: [expect.any(String)],
      structural: [expect.any(String)],
    })
    const claimed = prepared.take(match(buffer, structuralProvider, highlighterProvider))

    expect(claimed?.lineStarts).toEqual([0, 17])
    expect(claimed?.structural?.runtimeSessionId).not.toBe(claimed?.highlighter?.runtimeSessionId)
    expect(claimed?.structural?.readyResult).toBe(structuralSession.getResult())
    expect(claimed?.highlighter?.readyResult?.tokens).toEqual([])
    expect(structuralProvider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ fullText: 'const value = 1;\n' }),
    )
    expect(structuralSession.refresh).toHaveBeenCalledWith(
      buffer.getSnapshot(),
      'const value = 1;\n',
    )
    expect(highlighterProvider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ fullText: 'const value = 1;\n' }),
    )
    expect(highlighterSession.refresh).toHaveBeenCalledWith(
      buffer.getSnapshot(),
      'const value = 1;\n',
    )
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
      tabSizePolicy: 'detect-indentation',
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
      ...match(buffer, provider, null, 2),
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
      tabSizePolicy: 'detect-indentation',
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
      ...match(buffer, structuralProvider, highlighterProvider, 2),
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
      tabSizePolicy: 'detect-indentation',
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

  it('installs ready prepared tokens without publishing an empty initial token state', async () => {
    const buffer = createEditorTextBuffer('const value = 1;\n')
    const readyTokens = [{ start: 0, end: 5, style: { color: 'prepared-token' } }] as const
    const highlighterSession = highlightSession()
    highlighterSession.refresh = vi.fn(async () => ({ tokens: readyTokens }))
    const highlighterProvider: EditorHighlighterProvider = {
      createSession: vi.fn(() => highlighterSession),
    }
    const observedTokenColors: Array<readonly (string | undefined)[]> = []
    const plugin: EditorPlugin = {
      activate: (context) => [
        context.registerHighlighter(highlighterProvider),
        context.registerViewContribution({
          createContribution: () => ({
            update: (snapshot) => {
              observedTokenColors.push(snapshot.tokens.map((token) => token.style.color))
            },
            dispose: () => undefined,
          }),
        }),
      ],
    }
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 4,
      tabSizePolicy: 'detect-indentation',
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })
    const outcome = prepared.startStage({
      abortSignal: new AbortController().signal,
      configurationTag: ['shiki', 'dark'],
      family: 'highlighter',
      provider: highlighterProvider,
      range: 'full',
    })
    await expect(outcome).resolves.toBe('ready')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, { plugins: [plugin] })
    observedTokenColors.length = 0

    editor.attachSession(
      createEditorBufferSession(buffer, createEditorViewSession(buffer, 'ready-highlight-view')),
      {
        documentConfigurationTag: [],
        documentId: 'file.ts',
        highlighterConfigurationTag: ['shiki', 'dark'],
        languageId: 'typescript',
        preparedDocument: prepared,
      },
    )

    expect(observedTokenColors[0]).toEqual(['prepared-token'])
    expect(observedTokenColors).not.toContainEqual([])
    editor.dispose()
    container.remove()
  })

  it('publishes prepared tab size and fallback folds with the first document snapshot', () => {
    const buffer = createEditorTextBuffer('root\n  child\n    grandchild\nnext\n')
    const snapshots: Array<{
      readonly foldCount: number
      readonly tabSize: number
    }> = []
    const plugin: EditorPlugin = {
      activate: (context) =>
        context.registerViewContribution({
          createContribution: () => ({
            dispose: () => undefined,
            update: (snapshot, kind) => {
              if (kind !== 'content') return

              snapshots.push({
                foldCount: snapshot.foldMarkers.length,
                tabSize: snapshot.tabSize,
              })
            },
          }),
        }),
    }
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 4,
      tabSizePolicy: 'detect-indentation',
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, { plugins: [plugin] })
    snapshots.length = 0

    editor.attachSession(
      createEditorBufferSession(buffer, createEditorViewSession(buffer, 'prepared-layout-view')),
      {
        documentConfigurationTag: [],
        documentId: 'file.ts',
        languageId: 'typescript',
        preparedDocument: prepared,
      },
    )

    expect(snapshots[0]).toEqual({ foldCount: 2, tabSize: 2 })
    editor.dispose()
    container.remove()
  })

  it('installs prepared text and fallback folds in one render pass', () => {
    const buffer = createEditorTextBuffer('root\n  child\n    grandchild\nnext\n')
    const firstRowFoldStates: boolean[] = []
    const plugin: EditorPlugin = {
      activate: (context) =>
        context.registerGutterContribution({
          id: 'prepared-render-counter',
          createCell: (document) => document.createElement('div'),
          width: () => 10,
          updateCell: (_element, row) => {
            if (row.index === 0) firstRowFoldStates.push(row.foldMarker !== null)
          },
        }),
    }
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 4,
      tabSizePolicy: 'detect-indentation',
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, { plugins: [plugin] })
    firstRowFoldStates.length = 0

    editor.attachSession(
      createEditorBufferSession(buffer, createEditorViewSession(buffer, 'atomic-layout-view')),
      {
        documentConfigurationTag: [],
        documentId: 'file.ts',
        languageId: 'typescript',
        preparedDocument: prepared,
      },
    )

    expect(firstRowFoldStates).toEqual([true])
    editor.dispose()
    container.remove()
  })

  it('publishes a ready prepared structural fold in the first document snapshot', async () => {
    const buffer = createEditorTextBuffer('a\nb\nc\n')
    const structuralResult = {
      ...createEmptySyntaxResult(),
      folds: [
        {
          endIndex: 3,
          endLine: 1,
          startIndex: 1,
          startLine: 0,
          type: 'syntax' as const,
        },
      ],
    }
    const structuralSession = syntaxSession()
    structuralSession.refresh = vi.fn(async () => structuralResult)
    structuralSession.queryRange = vi.fn(async () => structuralResult)
    const structuralProvider: EditorSyntaxProvider = {
      createSession: vi.fn(() => structuralSession),
    }
    const foldCounts: number[] = []
    const plugin: EditorPlugin = {
      activate: (context) => [
        context.registerSyntaxProvider(structuralProvider),
        context.registerViewContribution({
          createContribution: () => ({
            dispose: () => undefined,
            update: (snapshot, kind) => {
              if (kind === 'content') foldCounts.push(snapshot.foldMarkers.length)
            },
          }),
        }),
      ],
    }
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 4,
      tabSizePolicy: 'detect-indentation',
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })
    const outcome = prepared.startStage({
      abortSignal: new AbortController().signal,
      configuration: { ...structuralConfiguration, includeHighlights: true },
      configurationTag: ['tree-sitter', 1],
      family: 'structural',
      provider: structuralProvider,
      range: { startIndex: 0, endIndex: buffer.getSnapshot().length },
    })
    await expect(outcome).resolves.toBe('ready')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, { plugins: [plugin] })
    foldCounts.length = 0

    editor.attachSession(
      createEditorBufferSession(buffer, createEditorViewSession(buffer, 'prepared-fold-view')),
      {
        documentConfigurationTag: [],
        documentId: 'file.ts',
        languageId: 'typescript',
        preparedDocument: prepared,
        structuralConfigurationTag: ['tree-sitter', 1],
      },
    )

    expect(foldCounts[0]).toBe(1)
    editor.dispose()
    container.remove()
  })

  it('queries only the uncovered visible range after partial structural adoption', async () => {
    const text = Array.from({ length: 200 }, (_, index) => `const value${index} = ${index};`).join(
      '\n',
    )
    const buffer = createEditorTextBuffer(text)
    const structuralSession = syntaxSession()
    const structuralProvider: EditorSyntaxProvider = {
      createSession: vi.fn(() => structuralSession),
    }
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 4,
      tabSizePolicy: 'detect-indentation',
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })
    const outcome = prepared.startStage({
      abortSignal: new AbortController().signal,
      configuration: { ...structuralConfiguration, includeHighlights: true },
      configurationTag: ['tree-sitter', 1],
      family: 'structural',
      provider: structuralProvider,
      range: { startIndex: 0, endIndex: 5 },
    })
    await expect(outcome).resolves.toBe('ready')
    const plugin: EditorPlugin = {
      activate: (context) => context.registerSyntaxProvider(structuralProvider),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, { plugins: [plugin] })
    const viewport = container.querySelector('.editor-virtualized')
    if (!(viewport instanceof HTMLElement)) throw new TypeError('missing editor viewport')
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 80 })
    Object.defineProperty(viewport, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        bottom: 80,
        height: 80,
        left: 0,
        right: 400,
        top: 0,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    })

    editor.attachSession(
      createEditorBufferSession(buffer, createEditorViewSession(buffer, 'partial-range-view')),
      {
        documentConfigurationTag: [],
        documentId: 'file.ts',
        languageId: 'typescript',
        preparedDocument: prepared,
        structuralConfigurationTag: ['tree-sitter', 1],
      },
    )

    await vi.waitFor(() => expect(structuralSession.queryRange).toHaveBeenCalledTimes(2))
    expect(structuralSession.queryRange).toHaveBeenLastCalledWith(
      expect.objectContaining({ endIndex: expect.any(Number) }),
    )
    const uncoveredRange = vi.mocked(structuralSession.queryRange!).mock.calls.at(-1)?.[0]
    expect(uncoveredRange?.startIndex).toBe(5)
    expect(uncoveredRange?.endIndex).toBeGreaterThan(5)
    expect(structuralProvider.createSession).toHaveBeenCalledOnce()
    editor.dispose()
    container.remove()
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
      tabSizePolicy: 'detect-indentation',
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

  it('does not paint an in-flight prepared highlight after the document is edited', async () => {
    const buffer = createEditorTextBuffer('const value = 1;\n')
    const completion = deferred<EditorHighlightResult>()
    const highlighterSession = highlightSession()
    highlighterSession.refresh = vi.fn(() => completion.promise)
    const highlighterProvider: EditorHighlighterProvider = {
      createSession: vi.fn(() => highlighterSession),
    }
    const observedTokenColors: Array<readonly (string | undefined)[]> = []
    const plugin: EditorPlugin = {
      activate: (context) => [
        context.registerHighlighter(highlighterProvider),
        context.registerViewContribution({
          createContribution: () => ({
            update: (snapshot) => {
              observedTokenColors.push(snapshot.tokens.map((token) => token.style.color))
            },
            dispose: () => undefined,
          }),
        }),
      ],
    }
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 4,
      tabSizePolicy: 'detect-indentation',
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })
    prepared.startStage({
      abortSignal: new AbortController().signal,
      configurationTag: ['shiki', 'dark'],
      family: 'highlighter',
      provider: highlighterProvider,
      range: 'full',
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, { plugins: [plugin] })

    editor.attachSession(
      createEditorBufferSession(buffer, createEditorViewSession(buffer, 'pending-highlight-view')),
      {
        documentConfigurationTag: [],
        documentId: 'file.ts',
        highlighterConfigurationTag: ['shiki', 'dark'],
        languageId: 'typescript',
        preparedDocument: prepared,
      },
    )
    editor.edit({ from: 0, to: 0, text: 'x' })
    completion.resolve({
      tokens: [{ start: 0, end: 5, style: { color: 'stale-prepared-token' } }],
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(observedTokenColors.flat()).not.toContain('stale-prepared-token')
    expect(editor.getState().initialHighlightStatus).toBe('loading')

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
      tabSizePolicy: 'detect-indentation',
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

  it('does not create or refresh a stage whose signal is already aborted', async () => {
    const buffer = createEditorTextBuffer('alpha\n')
    const session = highlightSession()
    const provider: EditorHighlighterProvider = {
      createSession: vi.fn(() => session),
    }
    const abortController = new AbortController()
    abortController.abort()
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 4,
      tabSizePolicy: 'detect-indentation',
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })

    const outcome = prepared.startStage({
      abortSignal: abortController.signal,
      configurationTag: ['shiki', 'dark'],
      family: 'highlighter',
      provider,
      range: 'full',
    })

    await expect(outcome).resolves.toBe('aborted')
    expect(provider.createSession).not.toHaveBeenCalled()
    expect(session.refresh).not.toHaveBeenCalled()
    expect(session.dispose).not.toHaveBeenCalled()
  })

  it('rejects prepared layout computed with a different configured tab size', () => {
    const buffer = createEditorTextBuffer('\talpha\n')
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 2,
      tabSizePolicy: 'detect-indentation',
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })

    const claimed = prepared.take({
      ...match(buffer, null, null, 2),
      configuredTabSize: 4,
    })

    expect(claimed).toBeNull()
  })

  it('rejects guessed prepared layout for an editor with an explicit tab size', () => {
    const buffer = createEditorTextBuffer('\talpha\n')
    const prepared = createEditorPreparedDocument({
      buffer,
      configuredTabSize: 4,
      tabSizePolicy: 'detect-indentation',
      documentConfigurationTag: [],
      documentId: 'file.ts',
      languageId: 'typescript',
    })

    const claimed = prepared.take({
      ...match(buffer, null, null, 4),
      tabSizePolicy: 'fixed',
    })

    expect(claimed).toBeNull()
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
  configuredTabSize = 4,
) {
  return {
    configuredTabSize,
    tabSizePolicy: 'detect-indentation' as const,
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
