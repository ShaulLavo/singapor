import { describe, expect, it, vi } from 'vitest'
import type { TextSnapshot } from '@singapor/core/document'
import type { VirtualizedFoldMarker } from '@singapor/core/rendering'
import type {
  EditorPluginContext,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import { createScopeLinesPlugin } from '../src/index'

describe('createScopeLinesPlugin', () => {
  it('registers a view contribution factory', () => {
    const registerViewContribution = vi.fn<EditorPluginContext['registerViewContribution']>(() => ({
      dispose: vi.fn(),
    }))
    const plugin = createScopeLinesPlugin()

    const disposable = plugin.activate(createContext(registerViewContribution))

    expect(plugin.name).toBe('scope-lines')
    expect(disposable).toBeDefined()
    expect(registerViewContribution).toHaveBeenCalledOnce()
  })

  it('returns no contribution when disabled', () => {
    const registration = registeredProvider(createScopeLinesPlugin({ enabled: false }))

    expect(registration?.createContribution(context())).toBeNull()
  })

  it('renders mounted fold scopes and active scope state', () => {
    const registration = registeredProvider(createScopeLinesPlugin())
    const testContext = context(
      snapshot({
        selections: [{ anchorOffset: 29, headOffset: 29, startOffset: 29, endOffset: 29 }],
      }),
    )

    const contribution = registration?.createContribution(testContext)
    const lines = [...testContext.scrollElement.querySelectorAll<HTMLElement>('.editor-scope-line')]

    expect(contribution).not.toBeNull()
    expect(lines).toHaveLength(2)
    expect(lines[0]?.style.left).toBe('0px')
    expect(lines[0]?.style.top).toBe('21px')
    expect(lines[0]?.style.height).toBe('56px')
    expect(lines[0]?.dataset.editorScopeLineLevel).toBe('1')
    expect(lines[0]?.classList.contains('editor-scope-line-active')).toBe(true)
    expect(lines[1]?.style.left).toBe('16px')
    expect(lines[1]?.style.top).toBe('41px')
    expect(lines[1]?.style.height).toBe('16px')
    expect(lines[1]?.dataset.editorScopeLineLevel).toBe('2')
    expect(lines[1]?.classList.contains('editor-scope-line-active')).toBe(true)

    contribution?.dispose()
    expect(testContext.scrollElement.querySelector('.editor-scope-lines')).toBeNull()
  })

  it('aligns scope guides to the configured indent step', () => {
    const registration = registeredProvider(createScopeLinesPlugin())
    const text = 'function f() {\n    if (x) {\n        y()\n    }\n}\n'
    const testContext = context(
      snapshot({
        fullText: text,
        lineStarts: lineStarts(text),
        lineCount: 6,
        tabSize: 4,
        foldMarkers: fourSpaceFoldMarkers(text),
        visibleRows: visibleRows(text),
      }),
    )

    registration?.createContribution(testContext)

    const lines = [...testContext.scrollElement.querySelectorAll<HTMLElement>('.editor-scope-line')]
    expect(lines).toHaveLength(2)
    expect(lines[0]?.style.left).toBe('0px')
    expect(lines[1]?.style.left).toBe('32px')
  })

  it('caches row text within a render pass', () => {
    const registration = registeredProvider(createScopeLinesPlugin())
    const text = 'function f() {\n  if (x) {\n    y()\n  }\n}\n'
    const starts = lineStarts(text)
    const readRows: number[] = []
    const testContext = context(
      snapshot({
        fullText: text,
        textSnapshot: countingTextSnapshot(text, starts, readRows),
        lineStarts: starts,
        foldMarkers: foldMarkers(),
        visibleRows: visibleRows(text),
      }),
    )

    registration?.createContribution(testContext)

    expect(readRows.filter((row) => row === 1)).toHaveLength(1)
  })

  it('skips text reads for fold markers outside the mounted rows', () => {
    const registration = registeredProvider(createScopeLinesPlugin())
    const text = 'root\n  one\n  two\nend\n\nfar\n  child\n  next\nend\n'
    const starts = lineStarts(text)
    const readRows: number[] = []
    const testContext = context(
      snapshot({
        fullText: text,
        textSnapshot: countingTextSnapshot(text, starts, readRows),
        lineStarts: starts,
        lineCount: starts.length,
        foldMarkers: [
          {
            key: 'visible',
            startOffset: starts[0]!,
            endOffset: starts[3]!,
            startRow: 0,
            endRow: 3,
            collapsed: false,
          },
          {
            key: 'offscreen',
            startOffset: starts[5]!,
            endOffset: starts[8]!,
            startRow: 5,
            endRow: 8,
            collapsed: false,
          },
        ],
        visibleRows: visibleRows(text).slice(0, 4),
      }),
    )

    registration?.createContribution(testContext)

    expect(readRows).toContain(1)
    expect(readRows).not.toContain(5)
    expect(readRows).not.toContain(6)
  })

  it('skips collapsed scopes', () => {
    const registration = registeredProvider(createScopeLinesPlugin())
    const marker = foldMarkers()[0]!
    const testContext = context(
      snapshot({
        foldMarkers: [{ ...marker, collapsed: true }],
      }),
    )

    registration?.createContribution(testContext)

    expect(testContext.scrollElement.querySelectorAll('.editor-scope-line')).toHaveLength(0)
  })

  it('updates active scope after selection changes', () => {
    const registration = registeredProvider(createScopeLinesPlugin())
    const inactive = snapshot({
      selections: [{ anchorOffset: 0, headOffset: 0, startOffset: 0, endOffset: 0 }],
    })
    const testContext = context(inactive)
    const contribution = registration?.createContribution(testContext)

    expect(testContext.scrollElement.querySelector('.editor-scope-line-active')).toBeNull()

    contribution?.update(
      snapshot({
        selections: [{ anchorOffset: 29, headOffset: 29, startOffset: 29, endOffset: 29 }],
      }),
      'selection',
    )

    expect(testContext.scrollElement.querySelectorAll('.editor-scope-line-active')).toHaveLength(2)
  })

  it('keeps scope line nodes when content edits leave guide geometry unchanged', () => {
    const registration = registeredProvider(createScopeLinesPlugin())
    const testContext = context(
      snapshot({
        selections: [{ anchorOffset: 29, headOffset: 29, startOffset: 29, endOffset: 29 }],
      }),
    )
    const contribution = registration?.createContribution(testContext)
    const originalLines = [
      ...testContext.scrollElement.querySelectorAll<HTMLElement>('.editor-scope-line'),
    ]

    contribution?.update(
      snapshot({
        textVersion: 2,
        foldMarkers: shiftedFoldMarkers(1),
        selections: [{ anchorOffset: 30, headOffset: 30, startOffset: 30, endOffset: 30 }],
      }),
      'content',
    )

    const nextLines = [
      ...testContext.scrollElement.querySelectorAll<HTMLElement>('.editor-scope-line'),
    ]
    expect(nextLines[0]).toBe(originalLines[0])
    expect(nextLines[1]).toBe(originalLines[1])
  })

  it('renders only the nearest cursor scope in current mode', () => {
    const registration = registeredProvider(createScopeLinesPlugin({ mode: 'current' }))
    const testContext = context(
      snapshot({
        selections: [{ anchorOffset: 29, headOffset: 29, startOffset: 29, endOffset: 29 }],
      }),
    )

    registration?.createContribution(testContext)

    const lines = [...testContext.scrollElement.querySelectorAll<HTMLElement>('.editor-scope-line')]
    expect(lines).toHaveLength(1)
    expect(lines[0]?.style.left).toBe('16px')
    expect(lines[0]?.dataset.editorScopeLineLevel).toBe('2')
    expect(lines[0]?.classList.contains('editor-scope-line-active')).toBe(true)
  })

  it('renders no current-mode scope when the cursor is outside fold ranges', () => {
    const registration = registeredProvider(createScopeLinesPlugin({ mode: 'current' }))
    const testContext = context(
      snapshot({
        selections: [{ anchorOffset: 0, headOffset: 0, startOffset: 0, endOffset: 0 }],
      }),
    )

    registration?.createContribution(testContext)

    expect(testContext.scrollElement.querySelectorAll('.editor-scope-line')).toHaveLength(0)
  })

  it('keeps current-mode rendering separate from active styling', () => {
    const registration = registeredProvider(
      createScopeLinesPlugin({ mode: 'current', showActive: false }),
    )
    const testContext = context(
      snapshot({
        selections: [{ anchorOffset: 29, headOffset: 29, startOffset: 29, endOffset: 29 }],
      }),
    )

    registration?.createContribution(testContext)

    expect(testContext.scrollElement.querySelectorAll('.editor-scope-line')).toHaveLength(1)
    expect(testContext.scrollElement.querySelector('.editor-scope-line-active')).toBeNull()
  })
})

function registeredProvider(plugin: ReturnType<typeof createScopeLinesPlugin>) {
  let registration: EditorViewContributionProvider | undefined
  plugin.activate(
    createContext((provider) => {
      registration = provider
      return { dispose: vi.fn() }
    }),
  )
  return registration
}

function createContext(
  registerViewContribution: EditorPluginContext['registerViewContribution'],
): EditorPluginContext {
  return {
    registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
    registerSyntaxProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerViewContribution,
    registerCommandContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerCapabilityContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerEditContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerDecorationContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerBlockProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerInjectedTextRowProvider: vi.fn(() => ({ dispose: vi.fn() })),
  }
}

function context(viewSnapshot = snapshot()): EditorViewContributionContext {
  const container = document.createElement('div')
  const scrollElement = document.createElement('div')
  container.appendChild(scrollElement)
  return {
    container,
    scrollElement,
    hasDocument: () => true,
    getSnapshot: () => viewSnapshot,
    reserveOverlayWidth: vi.fn(),
    revealLine: vi.fn(),
    focusEditor: vi.fn(),
    setSelection: vi.fn(),
    setSelections: vi.fn(),
    setScrollTop: vi.fn(),
    textOffsetFromPoint: vi.fn(() => null),
    getRangeClientRect: vi.fn(() => null),
  }
}

function snapshot(overrides: Partial<EditorViewSnapshot> = {}): EditorViewSnapshot {
  const text = 'function f() {\n  if (x) {\n    y()\n  }\n}\n'
  return {
    documentId: 'scope-test',
    languageId: 'typescript',
    fullText: text,
    textVersion: 1,
    lineStarts: lineStarts(text),
    tokens: [],
    brackets: [],
    selections: [],
    metrics: { rowHeight: 20, characterWidth: 8 },
    lineCount: 6,
    contentWidth: 160,
    totalHeight: 120,
    tabSize: 2,
    foldMarkers: foldMarkers(),
    visibleRows: visibleRows(text),
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 120,
      scrollWidth: 160,
      clientHeight: 80,
      clientWidth: 120,
      borderBoxHeight: 80,
      borderBoxWidth: 120,
      visibleRange: { start: 0, end: 6 },
    },
    ...overrides,
  }
}

function foldMarkers(): readonly VirtualizedFoldMarker[] {
  return [
    {
      key: 'function:0:40',
      startOffset: 0,
      endOffset: 40,
      startRow: 0,
      endRow: 4,
      collapsed: false,
    },
    {
      key: 'if:15:38',
      startOffset: 15,
      endOffset: 38,
      startRow: 1,
      endRow: 3,
      collapsed: false,
    },
  ]
}

function shiftedFoldMarkers(delta: number): readonly VirtualizedFoldMarker[] {
  return foldMarkers().map((marker) => ({
    ...marker,
    key: `${marker.key}:${delta}`,
    endOffset: marker.endOffset + delta,
  }))
}

function fourSpaceFoldMarkers(text: string): readonly VirtualizedFoldMarker[] {
  const starts = lineStarts(text)
  return [
    {
      key: 'function:0:52',
      startOffset: starts[0]!,
      endOffset: text.length,
      startRow: 0,
      endRow: 4,
      collapsed: false,
    },
    {
      key: 'if:18:50',
      startOffset: starts[1]!,
      endOffset: starts[4]!,
      startRow: 1,
      endRow: 3,
      collapsed: false,
    },
  ]
}

function visibleRows(text: string): EditorViewSnapshot['visibleRows'] {
  const starts = lineStarts(text)
  return starts.map((start, index) => {
    const nextStart = starts[index + 1] ?? text.length + 1
    const end = Math.max(start, Math.min(text.length, nextStart - 1))
    return {
      index,
      bufferRow: index,
      source: 'document',
      startOffset: start,
      endOffset: end,
      text: text.slice(start, end),
      kind: 'text',
      primaryText: true,
      top: index * 20,
      height: 20,
    }
  })
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function countingTextSnapshot(
  text: string,
  starts: readonly number[],
  readRows: number[],
): TextSnapshot {
  return {
    length: text.length,
    materializeFullText: () => {
      throw new Error('unexpected full text materialization')
    },
    readRange: (start, end) => {
      readRows.push(starts.indexOf(start))
      return text.slice(start, end)
    },
    forEachTextChunk: (visit) => visit(text, 0, text.length),
  }
}
