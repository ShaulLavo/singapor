import { describe, expect, it, vi } from 'vitest'

import { Editor } from '../src/editor/Editor'
import type {
  EditorHighlightResult,
  EditorHighlighterSession,
  EditorInitialPaintEvent,
  EditorPlugin,
  EditorInitialHighlightStatus,
  EditorViewContributionUpdateKind,
} from '../src/plugins'
import type { EditorTheme } from '../src/theme'
import {
  createEmptySyntaxResult,
  type EditorSyntaxResult,
  type EditorSyntaxSession,
  styleForTreeSitterCapture,
  treeSitterCapturesToEditorTokens,
} from '../src/public/syntax'

const TEXT = 'const value = 1'

describe('syntax capture conversion', () => {
  it('maps known capture names to editor token styles', () => {
    expect(styleForTreeSitterCapture('keyword.declaration')).toEqual({
      color: 'var(--editor-syntax-keyword-declaration)',
    })
    expect(styleForTreeSitterCapture('string')).toEqual({
      color: 'var(--editor-syntax-string)',
    })
    expect(styleForTreeSitterCapture('constructor')).toEqual({
      color: 'var(--editor-syntax-type-definition)',
    })
    expect(styleForTreeSitterCapture('text.title')).toEqual({
      color: 'var(--editor-syntax-keyword-declaration)',
      fontWeight: 700,
    })
    expect(styleForTreeSitterCapture('text.uri')).toEqual({
      color: 'var(--editor-syntax-string)',
      textDecoration: 'underline',
    })
    expect(styleForTreeSitterCapture('unknown.scope')).toBeNull()
  })

  it('converts non-empty captures to editor tokens', () => {
    const tokens = treeSitterCapturesToEditorTokens([
      { startIndex: 0, endIndex: 5, captureName: 'keyword.declaration' },
      { startIndex: 6, endIndex: 6, captureName: 'string' },
      { startIndex: 7, endIndex: 10, captureName: 'not.mapped' },
    ])

    expect(tokens).toEqual([
      {
        start: 0,
        end: 5,
        style: { color: 'var(--editor-syntax-keyword-declaration)' },
      },
    ])
  })
})

describe('authoritative initial paint', () => {
  it('publishes the terminal plain snapshot before its once-per-generation events', () => {
    const order: string[] = []
    const events: EditorInitialPaintEvent[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, {
      plugins: [snapshotOrderPlugin(order)],
      onInitialPaint: (event) => {
        events.push(event)
        order.push(`event:${event.phase}`)
      },
    })

    editor.openDocument({ documentId: 'plain.ts', text: 'const value = 1' })

    expect(editor.getState().initialHighlightStatus).toBe('plain')
    expect(events.map((event) => event.phase)).toEqual(['text', 'highlight-settled'])
    expect(order.indexOf('snapshot:document:plain')).toBeLessThan(order.indexOf('event:text'))
    expect(order.indexOf('snapshot:document:plain')).toBeLessThan(
      order.indexOf('event:highlight-settled'),
    )

    editor.openDocument({ documentId: 'plain.ts', text: 'const value = 1' })
    const textEvents = events.filter((event) => event.phase === 'text')
    expect(textEvents).toHaveLength(2)
    expect(textEvents[0]?.documentGeneration).not.toBe(textEvents[1]?.documentGeneration)

    editor.dispose()
    container.remove()
  })

  it('waits for highlighter adoption and publishes the terminal snapshot before the event', async () => {
    const result = deferred<EditorHighlightResult>()
    const events: EditorInitialPaintEvent[] = []
    const order: string[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const session: EditorHighlighterSession = {
      refresh: () => result.promise,
      applyChange: () => result.promise,
      dispose: () => undefined,
    }
    const editor = new Editor(container, {
      plugins: [highlighterPlugin(session), snapshotOrderPlugin(order)],
      onInitialPaint: (event) => {
        events.push(event)
        order.push(`event:${event.phase}`)
      },
    })

    editor.openDocument({ documentId: 'highlight.ts', languageId: 'typescript', text: TEXT })
    await nextTask()

    expect(editor.getState().initialHighlightStatus).toBe('loading')
    expect(events.map((event) => event.phase)).toEqual(['text'])

    result.resolve({ tokens: [{ start: 0, end: 5, style: { color: '#ff0000' } }] })
    await nextTask()

    expect(editor.getState().initialHighlightStatus).toBe('painted')
    expect(events.map((event) => event.phase)).toEqual(['text', 'highlight-settled'])
    const terminalSnapshot = order.lastIndexOf('snapshot:tokens:painted')
    expect(terminalSnapshot).toBeGreaterThan(-1)
    expect(terminalSnapshot).toBeLessThan(order.indexOf('event:highlight-settled'))

    editor.dispose()
    container.remove()
  })

  it('resets provider replacement to loading without duplicating an initial event', async () => {
    const result = deferred<EditorHighlightResult>()
    const events: EditorInitialPaintEvent[] = []
    const order: string[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, {
      plugins: [snapshotOrderPlugin(order)],
      onInitialPaint: (event) => events.push(event),
    })
    editor.openDocument({ documentId: 'replace.ts', text: TEXT })
    expect(events).toHaveLength(2)

    editor.addPlugin(
      highlighterPlugin({
        refresh: () => result.promise,
        applyChange: () => result.promise,
        dispose: () => undefined,
      }),
    )
    await nextTask()

    expect(editor.getState().initialHighlightStatus).toBe('loading')
    expect(order).toContain('snapshot:tokens:loading')

    result.resolve({ tokens: [] })
    await nextTask()
    expect(editor.getState().initialHighlightStatus).toBe('painted')
    expect(events).toHaveLength(2)

    editor.dispose()
    container.remove()
  })

  it.each(['structure-first', 'Shiki-first'] as const)(
    'uses the highlighter as the authoritative result when %s',
    async (order) => {
      const structure = deferred<EditorSyntaxResult>()
      const highlight = deferred<EditorHighlightResult>()
      const events: EditorInitialPaintEvent[] = []
      const snapshots: EditorInitialHighlightStatus[] = []
      const container = document.createElement('div')
      document.body.appendChild(container)
      const editor = new Editor(container, {
        plugins: [
          syntaxPlugin(syntaxSession(structure)),
          highlighterPlugin(highlighterSession(highlight)),
          statusSnapshotPlugin(snapshots),
        ],
        onInitialPaint: (event) => events.push(event),
      })

      editor.openDocument({ documentId: 'race.ts', languageId: 'typescript', text: TEXT })
      await nextTask()

      if (order === 'structure-first') {
        structure.resolve(createEmptySyntaxResult())
        await nextTask()
        expect(editor.getState().initialHighlightStatus).toBe('loading')
        expect(events.filter(isHighlightSettled)).toHaveLength(0)
        highlight.resolve({ tokens: [] })
      } else {
        highlight.resolve({ tokens: [] })
        await nextTask()
        expect(editor.getState().initialHighlightStatus).toBe('painted')
        expect(events.filter(isHighlightSettled)).toHaveLength(1)
        structure.resolve(createEmptySyntaxResult())
      }
      await nextTask()

      expect(editor.getState().initialHighlightStatus).toBe('painted')
      expect(events.filter(isHighlightSettled)).toHaveLength(1)
      expect(snapshots.at(-1)).toBe('painted')

      editor.dispose()
      container.remove()
    },
  )

  it('publishes degraded and error as terminal structural outcomes', async () => {
    const degraded = deferred<EditorSyntaxResult>()
    const degradedEvents: EditorInitialPaintEvent[] = []
    const degradedEditor = createSyntaxEditor(degraded, degradedEvents)

    degraded.resolve(
      createEmptySyntaxResult({
        degraded: { kind: 'optional-phase-failed', phase: 'highlights', message: 'unavailable' },
      }),
    )
    await nextTask()

    expect(degradedEditor.editor.getState().initialHighlightStatus).toBe('degraded')
    expect(degradedEvents.filter(isHighlightSettled)).toEqual([
      expect.objectContaining({ status: 'degraded' }),
    ])
    degradedEditor.dispose()

    const failed = deferred<EditorSyntaxResult>()
    const failedEvents: EditorInitialPaintEvent[] = []
    const failedEditor = createSyntaxEditor(failed, failedEvents)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    failed.reject(new Error('parse failed'))
    await nextTask()

    expect(failedEditor.editor.getState().initialHighlightStatus).toBe('error')
    expect(failedEvents.filter(isHighlightSettled)).toEqual([
      expect.objectContaining({ status: 'error' }),
    ])
    warn.mockRestore()
    failedEditor.dispose()
  })

  it('keeps a valid highlighter edit result across structural recovery in the same configuration', async () => {
    const editedHighlight = deferred<EditorHighlightResult>()
    const snapshots: Array<{
      readonly foregroundColor: string | null
      readonly status: EditorInitialHighlightStatus
      readonly tokens: readonly [number, number][]
    }> = []
    let syntaxSessionCount = 0
    const structuralPlugin: EditorPlugin = {
      activate: (context) =>
        context.registerSyntaxProvider({
          createSession: () => {
            syntaxSessionCount += 1
            const failEdits = syntaxSessionCount === 1
            return {
              refresh: async () => createEmptySyntaxResult(),
              applyChange: async () => {
                if (failEdits) throw new Error('edit parse failed')
                return createEmptySyntaxResult()
              },
              getResult: () => createEmptySyntaxResult(),
              getTokens: () => [],
              getSnapshotVersion: () => 0,
              dispose: () => undefined,
            }
          },
        }),
    }
    const highlighter: EditorHighlighterSession = {
      refresh: async () => ({
        tokens: [{ start: 0, end: 5, style: { color: '#ff0000' } }],
      }),
      applyChange: () => editedHighlight.promise,
      dispose: () => undefined,
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, {
      plugins: [structuralPlugin, highlighterPlugin(highlighter), themeSnapshotPlugin(snapshots)],
    })
    editor.openDocument({ documentId: 'edit-recovery.ts', languageId: 'typescript', text: TEXT })
    await nextTask()
    expect(editor.getState().initialHighlightStatus).toBe('painted')

    editor.edit({ from: 0, to: 0, text: 'x' })
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(syntaxSessionCount).toBeGreaterThan(1)

    editedHighlight.resolve({
      tokens: [{ start: 1, end: 6, style: { color: '#00ff00' } }],
    })
    await nextTask()
    expect(snapshots.at(-1)?.tokens).toEqual([[1, 6]])

    editor.dispose()
    warn.mockRestore()
    container.remove()
  })

  it('rejects a stale result from the previous same-id document generation', async () => {
    const first = deferred<EditorHighlightResult>()
    const second = deferred<EditorHighlightResult>()
    const sessions = [highlighterSession(first), highlighterSession(second)]
    const events: EditorInitialPaintEvent[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, {
      plugins: [
        {
          activate: (context) =>
            context.registerHighlighter({ createSession: () => sessions.shift() ?? null }),
        },
      ],
      onInitialPaint: (event) => events.push(event),
    })

    editor.openDocument({ documentId: 'same.ts', languageId: 'typescript', text: TEXT })
    await nextTask()
    editor.openDocument({ documentId: 'same.ts', languageId: 'typescript', text: TEXT })
    await nextTask()
    first.resolve({ tokens: [{ start: 0, end: 5, style: { color: 'stale' } }] })
    await nextTask()

    expect(editor.getState().initialHighlightStatus).toBe('loading')
    expect(events.filter(isHighlightSettled)).toHaveLength(0)

    second.resolve({ tokens: [{ start: 0, end: 5, style: { color: 'fresh' } }] })
    await nextTask()

    const terminal = events.filter(isHighlightSettled)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]?.documentGeneration).toBe(events.filter(isTextPaint)[1]?.documentGeneration)
    editor.dispose()
    container.remove()
  })

  it('keeps provider replacement authoritative across a lower-priority theme update', async () => {
    const replacement = deferred<EditorHighlightResult>()
    const events: EditorInitialPaintEvent[] = []
    const snapshots: EditorInitialHighlightStatus[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, {
      plugins: [statusSnapshotPlugin(snapshots)],
      onInitialPaint: (event) => events.push(event),
    })
    editor.openDocument({ documentId: 'overlap.ts', text: TEXT })
    expect(events.filter(isHighlightSettled)).toHaveLength(1)

    editor.addPlugin(highlighterPlugin(highlighterSession(replacement)))
    await nextTask()
    const loadingSnapshot = snapshots.lastIndexOf('loading')
    editor.setTheme({ foregroundColor: '#abcdef' })
    await new Promise((resolve) => setTimeout(resolve, 375))

    expect(editor.getState().initialHighlightStatus).toBe('loading')
    expect(snapshots.slice(loadingSnapshot + 1)).not.toContain('plain')
    expect(snapshots.slice(loadingSnapshot + 1)).not.toContain('painted')
    expect(events.filter(isHighlightSettled)).toHaveLength(1)

    replacement.resolve({ tokens: [] })
    await nextTask()
    expect(editor.getState().initialHighlightStatus).toBe('painted')
    expect(events.filter(isHighlightSettled)).toHaveLength(1)

    editor.dispose()
    container.remove()
  })

  it('waits to publish a terminal provider replacement until its deferred theme is adopted', async () => {
    const highlight = deferred<EditorHighlightResult>()
    const theme = deferred<EditorTheme | null | undefined>()
    const events: EditorInitialPaintEvent[] = []
    const snapshots: Array<{
      readonly foregroundColor: string | null
      readonly status: EditorInitialHighlightStatus
      readonly tokens: readonly [number, number][]
    }> = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, {
      plugins: [themeSnapshotPlugin(snapshots)],
      onInitialPaint: (event) => events.push(event),
    })
    editor.openDocument({ documentId: 'provider-theme.ts', languageId: 'typescript', text: TEXT })
    expect(events.filter(isHighlightSettled)).toHaveLength(1)

    editor.addPlugin(highlighterPlugin(highlighterSession(highlight), () => theme.promise))
    await nextTask()
    expect(editor.getState().initialHighlightStatus).toBe('loading')

    highlight.resolve({ tokens: [{ start: 0, end: 5, style: { color: '#ff0000' } }] })
    await nextTask()
    expect(editor.getState().initialHighlightStatus).toBe('loading')
    expect(events.filter(isHighlightSettled)).toHaveLength(1)

    editor.edit({ from: 0, to: 0, text: 'x' })
    editor.setTokens([{ start: 1, end: 6, style: { color: '#00ff00' } }])

    theme.resolve({ foregroundColor: '#123456' })
    await nextTask()
    expect(editor.getState().initialHighlightStatus).toBe('painted')
    expect(snapshots.at(-1)).toEqual({
      foregroundColor: '#123456',
      status: 'painted',
      tokens: [[1, 6]],
    })
    expect(events.filter(isHighlightSettled)).toHaveLength(1)

    editor.dispose()
    container.remove()
  })

  it('rejects a removed provider theme that resolves after its request is cancelled', async () => {
    const highlight = deferred<EditorHighlightResult>()
    const theme = deferred<EditorTheme | null | undefined>()
    const snapshots: Array<{
      readonly foregroundColor: string | null
      readonly status: EditorInitialHighlightStatus
      readonly tokens: readonly [number, number][]
    }> = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, { plugins: [themeSnapshotPlugin(snapshots)] })
    editor.openDocument({ documentId: 'removed-theme.ts', languageId: 'typescript', text: TEXT })

    const registration = editor.addPlugin(
      highlighterPlugin(highlighterSession(highlight), () => theme.promise),
    )
    await nextTask()
    highlight.resolve({ tokens: [] })
    await nextTask()
    expect(editor.getState().initialHighlightStatus).toBe('loading')

    registration.dispose()
    await nextTask()
    expect(editor.getState().initialHighlightStatus).toBe('plain')
    expect(snapshots.at(-1)?.foregroundColor).toBeNull()

    theme.resolve({ foregroundColor: '#abcdef' })
    await nextTask()
    expect(editor.getState().initialHighlightStatus).toBe('plain')
    expect(snapshots.at(-1)?.foregroundColor).toBeNull()

    editor.dispose()
    container.remove()
  })

  it('keeps an initial applicable result live across a theme update', async () => {
    const initial = deferred<EditorHighlightResult>()
    const events: EditorInitialPaintEvent[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, {
      plugins: [highlighterPlugin(highlighterSession(initial))],
      onInitialPaint: (event) => events.push(event),
    })
    editor.openDocument({ documentId: 'initial-theme.ts', languageId: 'typescript', text: TEXT })
    await nextTask()

    editor.setTheme({ foregroundColor: '#abcdef' })
    expect(editor.getState().initialHighlightStatus).toBe('loading')
    initial.resolve({ tokens: [] })
    await nextTask()

    expect(editor.getState().initialHighlightStatus).toBe('painted')
    expect(events.filter(isHighlightSettled)).toHaveLength(1)

    editor.dispose()
    container.remove()
  })

  it('refreshes theme and syntax configuration snapshots without repeating the initial event', async () => {
    const initial = deferred<EditorHighlightResult>()
    const syntax = deferred<EditorSyntaxResult>()
    const events: EditorInitialPaintEvent[] = []
    const snapshots: EditorInitialHighlightStatus[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, {
      plugins: [highlighterPlugin(highlighterSession(initial)), statusSnapshotPlugin(snapshots)],
      onInitialPaint: (event) => events.push(event),
    })
    editor.openDocument({ documentId: 'config.ts', languageId: 'typescript', text: TEXT })
    await nextTask()
    initial.resolve({ tokens: [] })
    await nextTask()
    expect(events.filter(isHighlightSettled)).toHaveLength(1)

    editor.setTheme({ backgroundColor: '#101010' })
    expect(snapshots.slice(-2)).toEqual(['loading', 'painted'])
    expect(events.filter(isHighlightSettled)).toHaveLength(1)

    editor.addPlugin(syntaxPlugin(syntaxSession(syntax)))
    await nextTask()
    expect(editor.getState().initialHighlightStatus).toBe('loading')
    syntax.resolve(createEmptySyntaxResult())
    await nextTask()
    expect(editor.getState().initialHighlightStatus).toBe('painted')
    expect(events.filter(isHighlightSettled)).toHaveLength(1)

    editor.dispose()
    container.remove()
  })

  it('settles a non-applicable syntax replacement from existing highlighter paint', async () => {
    const initial = deferred<EditorHighlightResult>()
    const events: EditorInitialPaintEvent[] = []
    const snapshots: EditorInitialHighlightStatus[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = new Editor(container, {
      plugins: [highlighterPlugin(highlighterSession(initial)), statusSnapshotPlugin(snapshots)],
      onInitialPaint: (event) => events.push(event),
    })
    editor.openDocument({ documentId: 'non-applicable.ts', languageId: 'typescript', text: TEXT })
    await nextTask()
    initial.resolve({ tokens: [] })
    await nextTask()

    editor.addPlugin({
      activate: (context) =>
        context.registerSyntaxProvider({
          createSession: () => null,
        }),
    })

    expect(editor.getState().initialHighlightStatus).toBe('painted')
    expect(snapshots.slice(-2)).toEqual(['loading', 'painted'])
    expect(events.filter(isHighlightSettled)).toHaveLength(1)

    editor.dispose()
    container.remove()
  })

  it('preserves an existing highlighter error across a non-applicable syntax replacement', async () => {
    const initial = deferred<EditorHighlightResult>()
    const snapshots: EditorInitialHighlightStatus[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const editor = new Editor(container, {
      plugins: [highlighterPlugin(highlighterSession(initial)), statusSnapshotPlugin(snapshots)],
    })
    editor.openDocument({ documentId: 'error.ts', languageId: 'typescript', text: TEXT })
    await nextTask()
    initial.reject(new Error('highlight failed'))
    await nextTask()
    expect(editor.getState().initialHighlightStatus).toBe('error')

    editor.addPlugin({
      activate: (context) =>
        context.registerSyntaxProvider({
          createSession: () => null,
        }),
    })

    expect(editor.getState().initialHighlightStatus).toBe('error')
    expect(snapshots.slice(-2)).toEqual(['loading', 'error'])

    editor.dispose()
    warn.mockRestore()
    container.remove()
  })
})

function highlighterPlugin(
  session: EditorHighlighterSession,
  loadTheme?: () => Promise<EditorTheme | null | undefined>,
): EditorPlugin {
  return {
    activate: (context) => {
      const provider = {
        createSession: () => session,
      }
      if (!loadTheme) return context.registerHighlighter(provider)
      return context.registerHighlighter({ ...provider, loadTheme })
    },
  }
}

function highlighterSession(
  result: ReturnType<typeof deferred<EditorHighlightResult>>,
): EditorHighlighterSession {
  return {
    refresh: () => result.promise,
    applyChange: () => result.promise,
    dispose: () => undefined,
  }
}

function syntaxPlugin(session: EditorSyntaxSession): EditorPlugin {
  return {
    activate: (context) =>
      context.registerSyntaxProvider({
        createSession: () => session,
      }),
  }
}

function syntaxSession(
  result: ReturnType<typeof deferred<EditorSyntaxResult>>,
): EditorSyntaxSession {
  return {
    refresh: () => result.promise,
    applyChange: () => result.promise,
    getResult: () => createEmptySyntaxResult(),
    getTokens: () => [],
    getSnapshotVersion: () => 0,
    dispose: () => undefined,
  }
}

function statusSnapshotPlugin(statuses: EditorInitialHighlightStatus[]): EditorPlugin {
  return {
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          update: (snapshot) => statuses.push(snapshot.initialHighlightStatus),
          dispose: () => undefined,
        }),
      }),
  }
}

function themeSnapshotPlugin(
  snapshots: Array<{
    readonly foregroundColor: string | null
    readonly status: EditorInitialHighlightStatus
    readonly tokens: readonly [number, number][]
  }>,
): EditorPlugin {
  return {
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          update: (snapshot) => {
            snapshots.push({
              foregroundColor: snapshot.theme?.foregroundColor ?? null,
              status: snapshot.initialHighlightStatus,
              tokens: snapshot.tokens.map((token) => [token.start, token.end]),
            })
          },
          dispose: () => undefined,
        }),
      }),
  }
}

function createSyntaxEditor(
  result: ReturnType<typeof deferred<EditorSyntaxResult>>,
  events: EditorInitialPaintEvent[],
): { readonly editor: Editor; dispose(): void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const editor = new Editor(container, {
    plugins: [syntaxPlugin(syntaxSession(result))],
    onInitialPaint: (event) => events.push(event),
  })
  editor.openDocument({ documentId: 'structural.ts', languageId: 'typescript', text: TEXT })
  return {
    editor,
    dispose: () => {
      editor.dispose()
      container.remove()
    },
  }
}

function snapshotOrderPlugin(order: string[]): EditorPlugin {
  return {
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          update: (snapshot, kind: EditorViewContributionUpdateKind) => {
            order.push(`snapshot:${kind}:${snapshot.initialHighlightStatus}`)
          },
          dispose: () => undefined,
        }),
      }),
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

function isHighlightSettled(
  event: EditorInitialPaintEvent,
): event is Extract<EditorInitialPaintEvent, { phase: 'highlight-settled' }> {
  return event.phase === 'highlight-settled'
}

function isTextPaint(
  event: EditorInitialPaintEvent,
): event is Extract<EditorInitialPaintEvent, { phase: 'text' }> {
  return event.phase === 'text'
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}
