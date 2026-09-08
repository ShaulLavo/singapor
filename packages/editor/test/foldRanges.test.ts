import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFoldGutterContribution,
  createLineGutterContribution,
} from '../../gutters/src/index.ts'
import type { Editor } from '../src/editor'
import { createVisibleEditor } from './factories/visibleEditor'
import type { EditorPlugin, EditorViewSnapshot } from '../src/plugins'
import {
  createEmptySyntaxResult,
  createEmptySyntaxSession,
  type EditorSyntaxResult,
} from '../src/public/syntax'
import {
  resetEditorInstanceCount,
  setHighlightRegistry,
  setEditorSyntaxSessionFactory,
} from '../src/public/testing'

/**
 * The gutter package types itself against the published `@singapor/core` facade, so the plugin
 * objects its own `create*Plugin` helpers build carry dist's `EditorPlugin` — a nominally different
 * type from the src one this Editor takes. The contributions are plain structural types that do
 * cross that line, so they are registered here through the same one-line wrapper the package uses.
 */
function lineGutterPlugin(): EditorPlugin {
  const contribution = createLineGutterContribution()
  return {
    name: 'line-gutter',
    activate: (context) => context.registerGutterContribution(contribution),
  }
}

function foldGutterPlugin(): EditorPlugin {
  const contribution = createFoldGutterContribution()
  return {
    name: 'fold-gutter',
    activate: (context) => context.registerGutterContribution(contribution),
  }
}

const highlightsMap = new Map<string, Highlight>()
const mockRegistry = {
  set: (name: string, highlight: Highlight) => {
    highlightsMap.set(name, highlight)
  },
  delete: (name: string) => highlightsMap.delete(name),
}

class MockHighlight extends Set<Range> {}

/** A trailing blank line inside the block is what the off-side rule decides the fate of. */
const INDENTED_TEXT = ['def outer():', '    first()', '    second()', '', 'after()'].join('\n')
const BODY_END = INDENTED_TEXT.indexOf('\n\nafter()')
const HEADER_END = INDENTED_TEXT.indexOf('\n    first()')

/** A tab and a run of spaces that stand at one column only where the tab is worth two of them. */
const TAB_TEXT = ['head:', '\tone', '  two'].join('\n')

/**
 * The two rule shapes the walk itself behaves differently for: a block that is its own indentation,
 * and one a token closes. Which shape each language we ship gets is pinned on the records themselves,
 * in test/languageConfiguration.test.ts.
 */
const FOLDING_RULE_SHAPES = [
  { languageId: 'python', comment: '#', offSide: true },
  { languageId: 'typescript', comment: '//', offSide: false },
] as const

/** A region marked in `comment` syntax, on rows sharing one indentation so only a marker can fold. */
function markedText(comment: string): string {
  return [
    `${comment} region imports`,
    'import a',
    'import b',
    `${comment} endregion`,
    'main()',
  ].join('\n')
}

/** Another language's comment opener, which the rules for an unnamed document would still accept. */
function otherComment(comment: string): string {
  return comment === '#' ? '//' : '#'
}

function editorRoot(): HTMLElement {
  return document.querySelector('.editor-virtualized') as HTMLElement
}

/** Retired rows keep the text they last showed, so only the mounted ones say what is on screen. */
function visibleText(): string {
  return [...document.querySelectorAll('.editor-virtualized-row:not([hidden])')]
    .map((row) => row.textContent ?? '')
    .join('\n')
}

function foldToggles(): readonly HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      '.editor-virtualized-fold-toggle:not([hidden])',
    ),
  ]
}

function foldKeys(): readonly string[] {
  return foldToggles().map((toggle) => toggle.dataset.editorFoldKey ?? '')
}

function foldStates(): readonly string[] {
  return foldToggles().map((toggle) => toggle.dataset.editorFoldState ?? '')
}

function clickFoldToggle(index = 0): void {
  foldToggles()[index]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function typeCharacter(data: string): void {
  editorRoot().dispatchEvent(
    new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data,
      inputType: 'insertText',
    }),
  )
}

describe('fold ranges without a grammar', () => {
  let container: HTMLElement
  let editor: Editor

  function mount(options: { readonly tabSize?: number } = {}): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    editor = createVisibleEditor(container, {
      plugins: [lineGutterPlugin(), foldGutterPlugin()],
      ...options,
    })
  }

  /** The tab width is fixed at construction, so a test that picks one needs its own editor. */
  function remount(options: { readonly tabSize: number }): void {
    editor.dispose()
    container.remove()
    mount(options)
  }

  beforeEach(() => {
    highlightsMap.clear()
    // @ts-expect-error — polyfilling Highlight constructor for tests
    globalThis.Highlight = MockHighlight
    setHighlightRegistry(mockRegistry)
    resetEditorInstanceCount()
    mount()
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
    setHighlightRegistry(undefined)
    setEditorSyntaxSessionFactory(undefined)
  })

  it.each(['supported', 'pending'] as const)(
    'hides provisional indentation while %s structural folds settle',
    async (foldingSupport) => {
      let resolveResult!: (result: EditorSyntaxResult) => void
      const pending = new Promise<EditorSyntaxResult>((resolve) => {
        resolveResult = resolve
      })
      const snapshots: EditorViewSnapshot[] = []
      let support = foldingSupport
      setEditorSyntaxSessionFactory(() => ({
        ...createEmptySyntaxSession(),
        get foldingSupport() {
          return support
        },
        refresh: () => pending,
      }))
      editor.addPlugin({
        activate: (context) =>
          context.registerViewContribution({
            createContribution: () => ({
              update: (snapshot) => {
                snapshots.push(snapshot)
              },
              dispose() {},
            }),
          }),
      })
      editor.openDocument({
        documentId: 'config.js',
        languageId: 'javascript',
        text: INDENTED_TEXT,
      })
      expect(foldKeys()).toEqual([])
      expect(snapshots.at(-1)?.syntaxStatus).toBe('loading')
      expect(snapshots.at(-1)?.paintLayers).toBeNull()

      support = 'supported'
      resolveResult({
        ...createEmptySyntaxResult(),
        folds: [
          {
            startIndex: HEADER_END - 1,
            endIndex: BODY_END,
            startLine: 0,
            endLine: 2,
            type: 'object',
            languageId: 'javascript',
          },
        ],
      })
      await vi.waitFor(() => expect(snapshots.at(-1)?.syntaxStatus).toBe('ready'))
      expect(foldKeys()).toEqual([`javascript:object:${HEADER_END - 1}:${BODY_END}`])
      expect(
        snapshots
          .filter((snapshot) => snapshot.syntaxStatus === 'ready')
          .every((snapshot) =>
            snapshot.foldMarkers.every((marker) => !marker.key.includes(':indent:')),
          ),
      ).toBe(true)
    },
  )

  it('treats a supported empty fold result as authoritative', async () => {
    setEditorSyntaxSessionFactory(() => ({
      ...createEmptySyntaxSession(),
      foldingSupport: 'supported',
    }))
    editor.openDocument({ documentId: 'config.js', languageId: 'javascript', text: INDENTED_TEXT })
    await vi.waitFor(() => expect(editor.getState().syntaxStatus).toBe('ready'))
    expect(foldKeys()).toEqual([])
  })

  it('restores indentation folding if the pending structural provider fails', async () => {
    setEditorSyntaxSessionFactory(() => ({
      ...createEmptySyntaxSession(),
      foldingSupport: 'pending',
      refresh: async () => {
        throw new RangeError('Parser unavailable')
      },
    }))
    editor.openDocument({ documentId: 'config.js', languageId: 'javascript', text: INDENTED_TEXT })
    expect(foldKeys()).toEqual([])
    await vi.waitFor(() => expect(editor.getState().syntaxStatus).toBe('error'))
    expect(foldKeys()).toHaveLength(1)
  })

  it('keeps indentation folding when the syntax provider has no folding support', async () => {
    setEditorSyntaxSessionFactory(() => createEmptySyntaxSession())
    editor.openDocument({ documentId: 'config.js', languageId: 'javascript', text: INDENTED_TEXT })
    expect(foldKeys()).toHaveLength(1)
    await vi.waitFor(() => expect(editor.getState().syntaxStatus).toBe('ready'))
    expect(foldKeys()).toHaveLength(1)
  })

  it('folds a document no grammar can describe by its indentation', () => {
    editor.openDocument({ documentId: 'main.py', languageId: 'python', text: INDENTED_TEXT })

    expect(foldStates()).toEqual(['expanded'])
    clickFoldToggle()

    expect(visibleText()).toContain('def outer():')
    expect(visibleText()).toContain('after()')
    expect(visibleText()).not.toContain('first()')
    expect(visibleText()).not.toContain('second()')
  })

  // Both halves are what naming the language buys: a document we cannot name is read as prose, whose
  // blank line separates blocks and whose regions may be marked in any comment syntax at all.
  it.each(FOLDING_RULE_SHAPES)(
    'reads $languageId by its own blank-line rule and comment syntax',
    ({ languageId, comment, offSide }) => {
      editor.openDocument({ documentId: `blank.${languageId}`, languageId, text: INDENTED_TEXT })
      const bodyEnd = offSide ? BODY_END : BODY_END + 1
      expect(foldKeys()).toEqual([`${languageId}:indent:${HEADER_END}:${bodyEnd}`])

      const own = markedText(comment)
      editor.openDocument({ documentId: `own.${languageId}`, languageId, text: own })
      expect(foldKeys()).toEqual([
        `${languageId}:region:${own.indexOf('\nimport a')}:${own.indexOf('\nmain()')}`,
      ])

      const other = markedText(otherComment(comment))
      editor.openDocument({ documentId: `other.${languageId}`, languageId, text: other })
      expect(foldKeys()).toEqual([])
    },
  )

  // Refusing a marker because we cannot name the language would mark nothing in an unnamed file at
  // all, and a document with no grammar is indistinguishable from prose.
  it('reads a document with no language off-side, after any comment opener', () => {
    editor.openDocument({ documentId: 'notes', text: INDENTED_TEXT })
    expect(foldKeys()).toEqual([`plain:indent:${HEADER_END}:${BODY_END}`])

    const marked = markedText('--')
    editor.openDocument({ documentId: 'marked', text: marked })

    expect(foldKeys()).toEqual([
      `plain:region:${marked.indexOf('\nimport a')}:${marked.indexOf('\nmain()')}`,
    ])
  })

  it('measures a tab in the columns it stands for before comparing indentation', () => {
    remount({ tabSize: 2 })
    editor.openDocument({ documentId: 'main.py', languageId: 'python', text: TAB_TEXT })

    // One region, not two: the space-indented row is beside the tab-indented one, not inside it.
    expect(foldKeys()).toEqual([`python:indent:${TAB_TEXT.indexOf('\n\tone')}:${TAB_TEXT.length}`])
    clickFoldToggle()

    expect(visibleText()).toContain('head:')
    expect(visibleText()).not.toContain('one')
    expect(visibleText()).not.toContain('two')
  })

  it('folds an explicit region its lines share one indentation with', () => {
    const text = markedText('#')
    editor.openDocument({ documentId: 'main.py', languageId: 'python', text })

    expect(foldKeys()).toEqual([
      `python:region:${text.indexOf('\nimport a')}:${text.indexOf('\nmain()')}`,
    ])
    clickFoldToggle()

    expect(visibleText()).toContain('# region imports')
    expect(visibleText()).toContain('main()')
    expect(visibleText()).not.toContain('import a')
    expect(visibleText()).not.toContain('# endregion')
  })

  it('finds a region a keystroke creates, once the walk catches up', async () => {
    editor.openDocument({ documentId: 'main.py', languageId: 'python', text: 'def outer():\npass' })
    expect(foldToggles()).toHaveLength(0)

    editor.dispatchCommand('cursorDocumentEnd')
    editor.dispatchCommand('cursorLineStart')
    typeCharacter(' ')

    expect(editor.materializeFullText()).toBe('def outer():\n pass')
    // Reading the whole document is not a cost the keystroke carries, so the
    // region appears on the frame after it rather than inside it.
    expect(foldToggles()).toHaveLength(0)

    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(foldStates()).toEqual(['expanded'])
    clickFoldToggle()
    expect(visibleText()).not.toContain('pass')
  })

  it('keeps a region collapsed when the grammar takes over the rows it described', () => {
    editor.openDocument({ documentId: 'main.py', languageId: 'python', text: INDENTED_TEXT })
    clickFoldToggle()
    expect(foldStates()).toEqual(['collapsed'])

    editor.setSyntaxFolds([
      {
        startIndex: HEADER_END - 1,
        endIndex: BODY_END,
        startLine: 0,
        endLine: 2,
        type: 'function_definition',
        languageId: 'python',
      },
    ])

    expect(foldKeys()).toEqual([`python:function_definition:${HEADER_END - 1}:${BODY_END}`])
    expect(foldStates()).toEqual(['collapsed'])
    expect(visibleText()).not.toContain('second()')
  })

  it('keeps folding a language whose grammar describes no folds at all', () => {
    editor.openDocument({ documentId: 'main.py', languageId: 'python', text: INDENTED_TEXT })
    expect(foldKeys()).toHaveLength(1)

    // Fold queries ship per language. A grammar that parses but was never asked
    // for folds has not answered none of them, and the file still folds.
    editor.setSyntaxFolds([])

    expect(foldKeys()).toHaveLength(1)
    clickFoldToggle()
    expect(visibleText()).not.toContain('second()')
  })
})
