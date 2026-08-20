import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorTheme } from '@singapor/core/rendering'
import {
  createEmptySyntaxResult,
  type EditorSyntaxSessionOptions,
  type EditorToken,
} from '@singapor/core/syntax'
import { EditorSecondaryTextView } from '@singapor/core/secondary-views'
import { createTextDiff, DiffView } from '../src'
import { diffSyntaxBackend, projectDiffSyntaxTokens } from '../src/DiffView'
import type {
  DiffFile,
  DiffSplitHandleContext,
  DiffSplitPaneOptions,
  DiffSyntaxBackend,
} from '../src'

const shikiMock = vi.hoisted(() => ({
  canUseShikiWorker: vi.fn(() => true),
  createShikiWorkerOwner: vi.fn(),
  owner: {
    createSession: vi.fn(),
    dispose: vi.fn(async () => undefined),
  },
  refreshTexts: [] as string[],
}))

vi.mock('@singapor/core/shiki', () => ({
  canUseShikiWorker: shikiMock.canUseShikiWorker,
  createShikiWorkerOwner: shikiMock.createShikiWorkerOwner,
}))

beforeAll(() => {
  installHighlightPolyfill()
})

beforeEach(() => {
  shikiMock.refreshTexts.length = 0
  shikiMock.canUseShikiWorker.mockReset()
  shikiMock.canUseShikiWorker.mockReturnValue(true)
  shikiMock.createShikiWorkerOwner.mockReset()
  shikiMock.createShikiWorkerOwner.mockReturnValue(shikiMock.owner)
  shikiMock.owner.dispose.mockClear()
  shikiMock.owner.createSession.mockReset()
  shikiMock.owner.createSession.mockImplementation(() => ({
    dispose: vi.fn(),
    refresh: vi.fn(async (_snapshot, fullText?: string) => {
      shikiMock.refreshTexts.push(fullText ?? '')
      return { tokens: [{ start: 0, end: 3, style: { color: 'gold' } }] }
    }),
  }))
})

describe('DiffView split panes', () => {
  it('renders a resizable handle between old and new panes', () => {
    const { container } = renderDiffView()
    const split = querySplit(container)
    const children = Array.from(split.children)
    const handle = children[1] as HTMLElement | undefined

    expect(children).toHaveLength(3)
    expect(children[0]?.classList.contains('editor-diff-pane-old')).toBe(true)
    expect(handle?.matches('[data-editor-pane-handle]')).toBe(true)
    expect(handle?.getAttribute('role')).toBe('separator')
    expect(children[2]?.classList.contains('editor-diff-pane-new')).toBe(true)
  })

  it('mounts custom split handles with file-aware context', () => {
    const createHandle = vi.fn((context: DiffSplitHandleContext) => {
      const handle = context.document.createElement('div')
      handle.className = 'custom-diff-handle'
      return handle
    })
    const { container } = renderDiffView({ createHandle })

    expect(createHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        beforePaneId: 'old',
        afterPaneId: 'new',
        file: expect.objectContaining({ path: 'note.txt' }),
        orientation: 'horizontal',
      }),
    )
    expect(container.querySelector('.custom-diff-handle')).not.toBeNull()
    expect(container.querySelector('.editor-diff-split-handle')).toBeNull()
  })

  it('removes the handle when switching to stacked mode', () => {
    const { container, diffView } = renderDiffView()

    expect(container.querySelector('[data-editor-pane-handle]')).not.toBeNull()

    diffView.setMode('stacked')

    expect(container.querySelector('[data-editor-pane-handle]')).toBeNull()
    expect(container.querySelector('.editor-diff-split')).toBeNull()
    expect(container.querySelector('.editor-diff-pane-stacked')).not.toBeNull()
  })

  it('reveals next and previous hunks with wrapping', () => {
    const { diffView } = renderDiffView({ file: multiHunkDiff() })

    expect(diffView.getCurrentHunk()?.index).toBe(0)
    expect(diffView.revealNextHunk()).toBe(true)
    expect(diffView.getCurrentHunk()?.index).toBe(1)
    expect(diffView.revealNextHunk()).toBe(false)
    expect(diffView.revealNextHunk({ wrap: true })).toBe(true)
    expect(diffView.getCurrentHunk()?.index).toBe(0)
    expect(diffView.revealPreviousHunk({ wrap: true })).toBe(true)
    expect(diffView.getCurrentHunk()?.index).toBe(1)
  })

  it('toggles expandable hunk rows from gutter clicks', () => {
    const { container } = renderDiffView({
      file: prefixSkippedDiff(),
      mode: 'stacked',
    })
    const pane = queryPane(container, 'stacked')
    const view = queryVirtualizedView(pane)

    expect(pane.textContent).toContain('Show 2 unmodified lines')

    moveVirtualizedGutter(view, 0)
    expect(view.style.cursor).toBe('pointer')

    clickVirtualizedGutter(view, 0)

    expect(pane.textContent).toContain('Hide 2 unmodified lines')
    expect(pane.textContent).toContain('alpha')
    expect(pane.textContent).toContain('beta')

    view.dispatchEvent(pointerEvent('mouseleave', 0))
    expect(view.style.cursor).toBe('')
  })

  it('toggles the unmodified tail after the last hunk', () => {
    const { container } = renderDiffView({
      file: suffixSkippedDiff(),
      mode: 'stacked',
    })
    const pane = queryPane(container, 'stacked')
    const view = queryVirtualizedView(pane)

    expect(pane.textContent).toContain('Show 2 unmodified lines')

    clickVirtualizedRow(view, 2)

    expect(pane.textContent).toContain('Hide 2 unmodified lines')
    expect(pane.textContent).toContain('beta')
    expect(pane.textContent).toContain('gamma')
  })

  it('applies configured editor theme variables to panes', () => {
    const { container } = renderDiffView({
      theme: {
        foregroundColor: '#abcdef',
        syntax: { keyword: '#123456' },
      },
    })
    const pane = container.querySelector<HTMLElement>('.editor-diff-text')

    expect(pane?.style.getPropertyValue('--editor-foreground')).toBe('#abcdef')
    expect(pane?.style.getPropertyValue('--editor-syntax-keyword')).toBe('#123456')
  })

  it('projects full-file syntax tokens into split diff rows', () => {
    const tokens = projectDiffSyntaxTokens({
      rows: [
        {
          newLineNumber: 2,
          oldLineNumber: 2,
          text: 'beta',
          type: 'context',
        },
      ],
      side: 'old',
      sources: [
        {
          lineStarts: [0, 6, 11],
          side: 'old',
          tokens: [{ start: 6, end: 10, style: { color: 'red' } }],
        },
      ],
    })

    expect(tokens).toEqual([
      {
        start: 0,
        end: 4,
        style: { color: 'red' },
      },
    ])
  })

  it('projects stacked rows from old and new full-file token streams', () => {
    const tokens = projectDiffSyntaxTokens({
      rows: [
        {
          oldLineNumber: 1,
          text: 'old',
          type: 'deletion',
        },
        {
          newLineNumber: 1,
          text: 'new',
          type: 'addition',
        },
      ],
      side: 'stacked',
      sources: [
        {
          lineStarts: [0],
          side: 'old',
          tokens: [{ start: 0, end: 3, style: { color: 'red' } }],
        },
        {
          lineStarts: [0],
          side: 'new',
          tokens: [{ start: 0, end: 3, style: { color: 'blue' } }],
        },
      ],
    })

    expect(tokens).toEqual([
      { start: 0, end: 3, style: { color: 'red' } },
      { start: 4, end: 7, style: { color: 'blue' } },
    ])
  })

  it('passes full file text to the tree-sitter syntax backend', async () => {
    const parsedTexts: string[] = []
    const syntaxBackend = createRecordingSyntaxBackend(parsedTexts)

    renderDiffView({
      syntaxBackend,
      syntaxHighlight: true,
    })

    await flushPromises()

    expect(parsedTexts).toContain('one\ntwo\n')
  })

  it('creates tree-sitter sessions from diff syntax service requests', async () => {
    const sessionOptions: EditorSyntaxSessionOptions[] = []
    const syntaxBackend = createRecordingSyntaxBackend([], sessionOptions)

    renderDiffView({
      file: typescriptDiff(),
      syntaxBackend,
      syntaxHighlight: true,
    })

    await flushPromises()

    expect(sessionOptions).toContainEqual(
      expect.objectContaining({
        documentId: 'note.ts:old',
        fullText: 'keep\nold\nskip\n',
        includeCaptures: true,
        includeHighlights: true,
        languageId: 'typescript',
        syntaxMode: 'full',
      }),
    )
    expect(sessionOptions[0]?.textSnapshot?.readRange(0, 4)).toBe('keep')
  })

  it('applies tree-sitter syntax service tokens to rendered diff panes', async () => {
    const setTokens = vi.spyOn(EditorSecondaryTextView.prototype, 'setTokens')

    try {
      renderDiffView({
        file: typescriptDiff(),
        syntaxBackend: createTokenSyntaxBackend(),
        syntaxHighlight: true,
      })

      await flushUntil(() => treeSitterTokenCalls(setTokens).length >= 2)

      const tokenCalls = treeSitterTokenCalls(setTokens)
      expect(tokenCalls).toHaveLength(2)
      expect(tokenCalls.flat()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            end: expect.any(Number),
            start: expect.any(Number),
            style: { color: 'rgb(1, 2, 3)' },
          }),
        ]),
      )
    } finally {
      setTokens.mockRestore()
    }
  })

  it('routes shiki highlighting through full-file syntax service documents', async () => {
    renderDiffView({
      file: typescriptDiff(),
      syntaxBackend: { kind: 'shiki', shikiTheme: 'github-light' },
      syntaxHighlight: true,
    })

    await flushPromises()
    await flushUntil(() => shikiMock.refreshTexts.length >= 2)

    expect(shikiMock.owner.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'note.ts:old',
        fullText: 'keep\nold\nskip\n',
        lang: 'typescript',
        languageId: 'typescript',
        theme: 'github-light',
      }),
    )
    expect(shikiMock.refreshTexts).toContain('keep\nold\nskip\n')
    expect(shikiMock.refreshTexts).toContain('keep\nnew\nskip\n')
  })

  it('defaults syntax highlighting to tree-sitter instead of shiki', () => {
    expect(diffSyntaxBackend({})).toEqual({ kind: 'tree-sitter' })
    expect(diffSyntaxBackend({ theme: { backgroundColor: '#ffffff' } })).toEqual({
      kind: 'tree-sitter',
    })
    expect(
      diffSyntaxBackend({
        syntaxBackend: { kind: 'shiki', shikiTheme: 'github-light' },
        theme: { backgroundColor: '#ffffff' },
      }),
    ).toEqual({ kind: 'shiki', shikiTheme: 'github-light' })
  })
})

type RenderDiffViewOptions = {
  readonly createHandle?: DiffSplitPaneOptions['createHandle']
  readonly file?: DiffFile
  readonly mode?: 'split' | 'stacked'
  readonly syntaxBackend?: DiffSyntaxBackend
  readonly syntaxHighlight?: boolean
  readonly theme?: EditorTheme | null
}

function renderDiffView(options: RenderDiffViewOptions = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const diffView = new DiffView(container, {
    mode: options.mode,
    showFileList: false,
    syntaxBackend: options.syntaxBackend,
    splitPane: {
      createHandle: options.createHandle,
    },
    syntaxHighlight: options.syntaxHighlight ?? false,
    theme: options.theme,
  })
  diffView.setFiles([options.file ?? singleHunkDiff()])
  return { container, diffView }
}

function singleHunkDiff() {
  return createTextDiff({
    oldFile: { path: 'note.txt', text: 'one\ntwo\n' },
    newFile: { path: 'note.txt', text: 'one\nTWO\n' },
  })
}

function multiHunkDiff() {
  return createTextDiff({
    contextLines: 0,
    oldFile: { path: 'note.txt', text: 'one\ntwo\nthree\nfour\nfive\nsix\n' },
    newFile: { path: 'note.txt', text: 'ONE\ntwo\nthree\nFOUR\nfive\nsix\n' },
  })
}

function prefixSkippedDiff() {
  return createTextDiff({
    contextLines: 0,
    oldFile: { path: 'note.txt', text: 'alpha\nbeta\ngamma\n' },
    newFile: { path: 'note.txt', text: 'alpha\nbeta\nGAMMA\n' },
  })
}

function suffixSkippedDiff() {
  return createTextDiff({
    contextLines: 0,
    oldFile: { path: 'note.txt', text: 'alpha\nbeta\ngamma\n' },
    newFile: { path: 'note.txt', text: 'ALPHA\nbeta\ngamma\n' },
  })
}

function typescriptDiff() {
  return createTextDiff({
    contextLines: 0,
    oldFile: { path: 'note.ts', text: 'keep\nold\nskip\n', languageId: 'typescript' },
    newFile: { path: 'note.ts', text: 'keep\nnew\nskip\n', languageId: 'typescript' },
  })
}

function querySplit(container: HTMLElement): HTMLElement {
  const split = container.querySelector<HTMLElement>('.editor-diff-split')
  if (!split) throw new Error('Expected split diff')
  return split
}

function queryPane(container: HTMLElement, side: 'old' | 'new' | 'stacked'): HTMLElement {
  const pane = container.querySelector<HTMLElement>(`.editor-diff-pane-${side}`)
  if (!pane) throw new Error(`Expected ${side} diff pane`)
  return pane
}

function queryVirtualizedView(container: HTMLElement): HTMLElement {
  const view = container.querySelector<HTMLElement>('.editor-virtualized')
  if (!view) throw new Error('Expected virtualized diff view')
  return view
}

function clickVirtualizedRow(view: HTMLElement, row: number): void {
  const element = view.querySelector<HTMLElement>(`[data-editor-virtual-row="${row}"]`)
  if (!element) throw new Error(`Expected virtual row ${row}`)
  element.dispatchEvent(pointerEvent('mousedown', 0))
  element.dispatchEvent(pointerEvent('click', 0))
}

function clickVirtualizedGutter(view: HTMLElement, y: number): void {
  view.dispatchEvent(pointerEvent('mousedown', y))
  view.dispatchEvent(pointerEvent('click', y))
}

function moveVirtualizedGutter(view: HTMLElement, y: number): void {
  view.dispatchEvent(pointerEvent('mousemove', y))
}

function pointerEvent(type: string, clientY: number): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientY,
    detail: 1,
  })
}

function createRecordingSyntaxBackend(
  parsedTexts: string[],
  sessionOptions: EditorSyntaxSessionOptions[] = [],
): DiffSyntaxBackend {
  return {
    kind: 'tree-sitter',
    provider: {
      createSession(options) {
        sessionOptions.push(options)
        parsedTexts.push(options.fullText)
        return {
          applyChange: async () => emptySyntaxResult(),
          dispose: () => undefined,
          getResult: () => emptySyntaxResult(),
          getSnapshotVersion: () => 0,
          getTokens: () => [],
          refresh: async () => emptySyntaxResult(),
        }
      },
    },
  }
}

function createTokenSyntaxBackend(): DiffSyntaxBackend {
  return {
    kind: 'tree-sitter',
    provider: {
      createSession(options) {
        return {
          applyChange: async () => syntaxResultForOptions(options),
          dispose: () => undefined,
          getResult: () => syntaxResultForOptions(options),
          getSnapshotVersion: () => 0,
          getTokens: () => syntaxResultForOptions(options).tokens,
          refresh: async () => syntaxResultForOptions(options),
        }
      },
    },
  }
}

function syntaxResultForOptions(options: EditorSyntaxSessionOptions) {
  const target = options.documentId.endsWith(':old') ? 'old' : 'new'
  const start = options.fullText.indexOf(target)
  const tokens =
    start === -1
      ? []
      : [
          {
            end: start + target.length,
            start,
            style: { color: 'rgb(1, 2, 3)' },
          },
        ]

  return {
    ...createEmptySyntaxResult({
      language: {
        includeCaptures: true,
        includeHighlights: true,
        languageId: options.languageId,
        mode: 'full',
      },
      requestedRanges: [{ startIndex: 0, endIndex: options.snapshot.length }],
      snapshot: {
        documentId: options.documentId,
        length: options.snapshot.length,
        version: 1,
      },
    }),
    tokens,
  }
}

function emptySyntaxResult() {
  return createEmptySyntaxResult()
}

type SetTokensSpy = {
  readonly mock: {
    readonly calls: readonly [readonly EditorToken[]][]
  }
}

function treeSitterTokenCalls(setTokens: SetTokensSpy) {
  return setTokens.mock.calls
    .map(([tokens]) => tokens)
    .filter((tokens) => tokens.some((token) => token.style.color === 'rgb(1, 2, 3)'))
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

async function flushUntil(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (done()) return
    await flushPromises()
  }
}

type HighlightConstructor = new (...ranges: AbstractRange[]) => Highlight

class TestHighlight {
  private readonly ranges = new Set<AbstractRange>()

  public constructor(...ranges: AbstractRange[]) {
    for (const range of ranges) this.ranges.add(range)
  }

  public add(range: AbstractRange): this {
    this.ranges.add(range)
    return this
  }

  public clear(): void {
    this.ranges.clear()
  }

  public delete(range: AbstractRange): boolean {
    return this.ranges.delete(range)
  }
}

function installHighlightPolyfill(): void {
  const global = globalThis as typeof globalThis & {
    Highlight?: HighlightConstructor
  }
  if (global.Highlight) return
  global.Highlight = TestHighlight as unknown as HighlightConstructor
}
