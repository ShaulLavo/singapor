import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Editor } from '@singapor/core/editor'
import { setEditorSyntaxSessionFactory, setHighlightRegistry } from '@singapor/core/testing'
import {
  createEmptySyntaxResult,
  type EditorSyntaxCapture,
  type EditorSyntaxResult,
  type EditorSyntaxSession,
} from '@singapor/core/syntax'
import type { EditorPluginContext } from '@singapor/core/extensions'
import { createMarkdownPreviewPlugin } from '../src/index'

/**
 * Proves the whole path: plugin registration -> syntax captures -> inline map -> rendered rows. The
 * capture fixtures are exactly what the real grammars emit; replacements.test.ts is what keeps them
 * honest by parsing for real.
 */
const capture = (
  captureName: string,
  startIndex: number,
  endIndex: number,
): EditorSyntaxCapture => ({ captureName, startIndex, endIndex })

const DOCUMENT = '# Title\na **bold** b'

// '# Title' -> atx_h1_marker + inline; 'a **bold** b' -> strong_emphasis + four emphasis delimiters.
const CAPTURES: readonly EditorSyntaxCapture[] = [
  capture('punctuation.special', 0, 1),
  capture('text.title', 2, 7),
  capture('text.strong', 10, 18),
  capture('punctuation.delimiter', 10, 11),
  capture('punctuation.delimiter', 11, 12),
  capture('punctuation.delimiter', 16, 17),
  capture('punctuation.delimiter', 17, 18),
]

const syntaxResult = (): EditorSyntaxResult => ({
  ...createEmptySyntaxResult(),
  captures: CAPTURES,
})

const markdownSyntaxSession = (): EditorSyntaxSession => ({
  refresh: async () => syntaxResult(),
  applyChange: async () => syntaxResult(),
  getResult: () => syntaxResult(),
  getTokens: () => [],
  getSnapshotVersion: () => 0,
  dispose: () => undefined,
})

const highlights = new Map<string, Highlight>()
class MockHighlight extends Set<Range> {}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('markdown preview plugin', () => {
  let container: HTMLElement
  let editor: Editor

  // Read the mounted DOM rather than editor state: what the user actually sees is the assertion.
  const rowTexts = (): readonly string[] =>
    [...container.querySelectorAll('[data-editor-virtual-row]')].map((row) => row.textContent ?? '')

  const openMarkdown = async (languageId = 'markdown'): Promise<void> => {
    editor.openDocument({ documentId: 'notes.md', text: DOCUMENT, languageId })
    await flush()
  }

  beforeEach(() => {
    // @ts-expect-error happy-dom does not provide Highlight.
    globalThis.Highlight = MockHighlight
    setHighlightRegistry({
      set: (name: string, highlight: Highlight) => highlights.set(name, highlight),
      delete: (name: string) => highlights.delete(name),
    })
    setEditorSyntaxSessionFactory(() => markdownSyntaxSession())
    container = document.createElement('div')
    document.body.appendChild(container)
    editor = new Editor(container, { plugins: [createMarkdownPreviewPlugin()] })
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
    highlights.clear()
    setEditorSyntaxSessionFactory(undefined)
    setHighlightRegistry(undefined)
    Reflect.deleteProperty(globalThis, 'Highlight')
  })

  it('renders markdown as formatted text', async () => {
    await openMarkdown()

    expect(rowTexts()).toEqual(['Title', 'a bold b'])
  })

  it('brings the source back under the caret', async () => {
    await openMarkdown()
    editor.setSelection(14, 14)

    expect(rowTexts()).toEqual(['Title', 'a **bold** b'])
  })

  it('re-hides the source once the caret leaves', async () => {
    await openMarkdown()
    editor.setSelection(14, 14)
    editor.setSelection(0, 0)

    expect(rowTexts()[1]).toBe('a bold b')
  })

  it('leaves the buffer holding markdown source', async () => {
    await openMarkdown()

    expect(editor.materializeFullText()).toBe(DOCUMENT)
  })

  it('leaves non-markdown documents as source', async () => {
    await openMarkdown('typescript')

    expect(rowTexts()).toEqual(['# Title', 'a **bold** b'])
  })
})

describe('markdown preview plugin on an unsupported host', () => {
  const pluginContext = (): EditorPluginContext =>
    ({
      registerHighlighter: () => ({ dispose: () => undefined }),
      registerSyntaxProvider: () => ({ dispose: () => undefined }),
      registerViewContribution: () => ({ dispose: () => undefined }),
      registerCommandContribution: () => ({ dispose: () => undefined }),
      registerCapabilityContribution: () => ({ dispose: () => undefined }),
      registerEditContribution: () => ({ dispose: () => undefined }),
      registerDecorationContribution: () => ({ dispose: () => undefined }),
      registerGutterContribution: () => ({ dispose: () => undefined }),
      registerBlockProvider: () => ({ dispose: () => undefined }),
      registerInjectedTextRowProvider: () => ({ dispose: () => undefined }),
    }) satisfies EditorPluginContext

  it('warns instead of silently rendering nothing', () => {
    const logged: string[] = []
    const context = {
      ...pluginContext(),
      log: (event: { action: string }) => logged.push(event.action),
    }

    expect(createMarkdownPreviewPlugin().activate(context)).toBeUndefined()
    expect(logged).toEqual(['markdown.preview.unsupported'])
  })
})
