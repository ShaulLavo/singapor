import { describe, expect, it, vi } from 'vitest'
import type {
  EditorCapabilityContributionProvider,
  EditorCommandContributionProvider,
  EditorEditContributionProvider,
  EditorPluginContext,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewSnapshot,
} from '@editor/core/extensions'
import {
  createEditorFindContributionProviders,
  createEditorFindPlugin,
  EDITOR_FIND_FEATURE,
} from '../src'

describe('createEditorFindPlugin', () => {
  it('registers public find contribution providers', () => {
    const context = pluginContext()
    const plugin = createEditorFindPlugin()

    const disposable = plugin.activate(context)

    expect(plugin.name).toBe('editor.find')
    expect(disposable).toBeDefined()
    expect(context.registerViewContribution).toHaveBeenCalledOnce()
    expect(context.registerCommandContribution).toHaveBeenCalledOnce()
    expect(context.registerCapabilityContribution).toHaveBeenCalledOnce()
    expect(context.registerEditContribution).toHaveBeenCalledOnce()
  })

  it('exposes a provider factory with a find capability contribution', () => {
    const providers = createEditorFindContributionProviders()
    const registrations: { readonly token: unknown; readonly feature: unknown }[] = []

    const contribution = providers.capability.createContribution({
      registerFeature: (token, feature) => {
        registrations.push({ token, feature })
        return { dispose: vi.fn() }
      },
    })

    expect(registrations).toEqual([
      {
        token: EDITOR_FIND_FEATURE,
        feature: expect.objectContaining({
          openFind: expect.any(Function),
          toggleFind: expect.any(Function),
          replaceAll: expect.any(Function),
        }),
      },
    ])

    contribution?.dispose()
  })

  it('registers the find command surface through a command contribution', () => {
    const providers = createEditorFindContributionProviders()
    const registeredCommands: string[] = []
    const registerCommand = vi.fn((command: string) => {
      registeredCommands.push(command)
      return { dispose: vi.fn() }
    })

    const contribution = providers.command.createContribution({ registerCommand })

    expect(registeredCommands).toEqual([
      'find',
      'findReplace',
      'findNext',
      'findPrevious',
      'closeFind',
      'toggleFindCaseSensitive',
      'toggleFindWholeWord',
      'toggleFindRegex',
      'toggleFindInSelection',
      'togglePreserveCase',
      'replaceOne',
      'replaceAll',
      'selectAllMatches',
    ])

    contribution?.dispose()
  })

  it('keeps widget creation lazy until find opens', () => {
    const providers = createEditorFindContributionProviders()
    const context = viewContext()
    const features: { openFind(): boolean }[] = []
    const viewContribution = providers.view.createContribution(context)

    providers.capability.createContribution({
      registerFeature: (_token, value) => {
        features.push(value as { openFind(): boolean })
        return { dispose: vi.fn() }
      },
    })

    const feature = features[0]
    expect(context.container.querySelector('.editor-find-widget')).toBeNull()
    expect(feature?.openFind()).toBe(true)
    expect(context.container.querySelector('.editor-find-widget')).not.toBeNull()

    viewContribution?.dispose()
  })
})

function pluginContext(): EditorPluginContext {
  return {
    registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
    registerSyntaxProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerViewContribution: vi.fn<EditorPluginContext['registerViewContribution']>(
      (_provider: EditorViewContributionProvider) => ({ dispose: vi.fn() }),
    ),
    registerCommandContribution: vi.fn<EditorPluginContext['registerCommandContribution']>(
      (_provider: EditorCommandContributionProvider) => ({ dispose: vi.fn() }),
    ),
    registerCapabilityContribution: vi.fn<EditorPluginContext['registerCapabilityContribution']>(
      (_provider: EditorCapabilityContributionProvider) => ({ dispose: vi.fn() }),
    ),
    registerEditContribution: vi.fn<EditorPluginContext['registerEditContribution']>(
      (_provider: EditorEditContributionProvider) => ({ dispose: vi.fn() }),
    ),
    registerDecorationContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerBlockProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerInjectedTextRowProvider: vi.fn(() => ({ dispose: vi.fn() })),
  }
}

function viewContext(viewSnapshot = snapshot()): EditorViewContributionContext {
  const container = document.createElement('div')
  const scrollElement = document.createElement('div')
  container.appendChild(scrollElement)
  return {
    container,
    scrollElement,
    highlightPrefix: 'editor-find-test',
    hasDocument: () => true,
    getSnapshot: () => viewSnapshot,
    revealLine: vi.fn(),
    focusEditor: vi.fn(),
    setSelection: vi.fn(),
    setSelections: vi.fn(),
    setScrollTop: vi.fn(),
    reserveOverlayWidth: vi.fn(),
    textOffsetFromPoint: vi.fn(() => null),
    getRangeClientRect: vi.fn(() => null),
    setRangeHighlight: vi.fn(),
    clearRangeHighlight: vi.fn(),
  }
}

function snapshot(): EditorViewSnapshot {
  return {
    documentId: 'find-test',
    languageId: null,
    fullText: 'foo bar foo',
    textVersion: 1,
    lineStarts: [0],
    tokens: [],
    selections: [{ anchorOffset: 0, headOffset: 0, startOffset: 0, endOffset: 0 }],
    metrics: { rowHeight: 20, characterWidth: 8 },
    lineCount: 1,
    contentWidth: 88,
    totalHeight: 20,
    tabSize: 2,
    foldMarkers: [],
    visibleRows: [],
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 20,
      scrollWidth: 88,
      clientHeight: 20,
      clientWidth: 88,
      visibleRange: { start: 0, end: 1 },
    },
  }
}
