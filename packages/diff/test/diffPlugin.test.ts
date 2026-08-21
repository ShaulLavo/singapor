import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@singapor/core/editor'
import {
  createEmptySyntaxResult,
  type EditorSyntaxSessionOptions,
  type EditorToken,
} from '@singapor/core/syntax'
import { createDiffPlugin, createTextDiff, diffSyntaxBackend, joinRenderLines } from '../src'
import { createDiffGutterContribution } from '../src/diffGutter'
import { diffGutterDigits } from '../src/gutters'
import { projectDiffSyntaxTokens } from '../src/diffSyntax'
import type { DiffFile, DiffGutterSide, DiffPlugin, DiffRenderRow, DiffSyntaxBackend } from '../src'
import { installHighlightPolyfill } from './support/highlightPolyfill'

/**
 * The ported behaviour spec (§2.6). `test/DiffView.test.ts` was the only written record of what
 * parity means; its cases live here, minus the ones covering surfaces §2.4 established have no
 * consumers at all — hunk navigation and the entire `splitPane` option layer — and minus split
 * layout, which is host work now (§3.1).
 */

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

const mounted: { editor: Editor; host: HTMLElement }[] = []

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    entry.editor.dispose()
    entry.host.remove()
  }
})

describe('diff plugin — rows and expansion (§C3, §C5)', () => {
  it('publishes rows for the host to push into the editor', () => {
    const { plugin, host } = mountDiff({ file: singleHunkDiff() })

    expect(plugin.getRows().map((row) => row.text)).toEqual(['one', 'two', 'TWO'])
    expect(host.textContent).toContain('TWO')
  })

  it('renders one buffer row per projection row, keeping the §C4 identity', () => {
    const { plugin, host } = mountDiff({ file: prefixSkippedDiff() })

    const indices = [...host.querySelectorAll<HTMLElement>('[data-editor-virtual-row]')].map(
      (element) => Number(element.dataset.editorVirtualRow),
    )
    expect(indices).toEqual(plugin.getRows().map((_row, index) => index))
    expect(plugin.getDocumentModeViolations()).toEqual([])
  })

  it('toggles an expandable hunk row from a gutter click, and shows a pointer over it', () => {
    // Ported from DiffView.test.ts:113-134. The click lands in the gutter band, where no text row
    // sits and `.editor-virtualized-gutter` is pointer-events:none — so this exercises the Y
    // hit-test the plugin carries (§3.4), not `closest()`.
    const { plugin, host } = mountDiff({ file: prefixSkippedDiff() })
    const view = queryScrollElement(host)

    expect(host.textContent).toContain('Show 2 unmodified lines')

    view.dispatchEvent(pointerEvent('mousemove', 0))
    expect(view.style.cursor).toBe('pointer')

    clickGutter(view, 0)

    expect(plugin.getRows().map((row) => row.text)).toContain('Hide 2 unmodified lines')
    expect(host.textContent).toContain('alpha')
    expect(host.textContent).toContain('beta')

    view.dispatchEvent(pointerEvent('mouseleave', 0))
    expect(view.style.cursor).toBe('')
  })

  it('refuses a caret on a separator it cannot expand', () => {
    // A partial diff — a patch with no file text behind it — still shows how much was skipped and
    // cannot open it. The label is real buffer text either way, and a collapsed caret copies its
    // own line, so resting one here would put `Show 2 unmodified lines` on the clipboard.
    const { plugin, host } = mountDiff({ file: partialSkippedDiff() })
    const separator = plugin.getRows().findIndex((row) => row.type === 'hunk')
    expect(separator).toBeGreaterThanOrEqual(0)
    expect(plugin.getRows()[separator]?.expandable).toBe(false)

    // Dispatched at the scroll element, which is where a real press in the gutter band lands and
    // the only place happy-dom delivers one — it does not bubble a mousedown from a row.
    const view = queryScrollElement(host)
    const mousedown = pointerEvent('mousedown', 0)
    view.dispatchEvent(mousedown)

    expect(mousedown.defaultPrevented).toBe(true)
    // And it is still only *expandable* separators that answer a click or show a pointer.
    view.dispatchEvent(pointerEvent('mousemove', 0))
    expect(view.style.cursor).toBe('')
  })

  it('refuses a press on a separator at every click count', async () => {
    // Asserted on FOCUS, which is the one thing that discriminates here.
    // `defaultPrevented` cannot: the editor's own mousedown handler calls `preventDefault()` for
    // its own reasons, so the flag reads true whether or not the plugin refused. Nor can the caret:
    // happy-dom gives every element a zero-sized rect, so the editor's word- and line-selection
    // paths resolve an offset at the end of the document no matter where the press was, with or
    // without this plugin. What IS decisive is that `InputSelectionController.handleMouseDown`
    // calls `view.focusInput()` immediately after its `defaultPrevented` guard — so an editor that
    // never took focus is an editor whose handler never ran.
    const { host } = mountDiff({ file: prefixSkippedDiff() })
    const view = queryScrollElement(host)

    // 2 selects a word of `Show 2 unmodified lines`, 3 the whole line, 4 the whole document.
    for (const detail of [1, 2, 3, 4]) {
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      view.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientY: 0,
          detail,
        }),
      )
      await flushPromises()

      expect(host.contains(document.activeElement)).toBe(false)
    }
  })

  it('toggles the unmodified tail after the last hunk', () => {
    // Ported from DiffView.test.ts:136-151. A trailing region carries `hunkIndex === undefined`
    // (projection.ts:294-310) — the case a hunk-ordinal mirror can never address, which is why
    // §C5 keys on `expandKey` and forbids hosts from mirroring at all.
    const { plugin, host } = mountDiff({ file: suffixSkippedDiff() })

    expect(host.textContent).toContain('Show 2 unmodified lines')
    const separator = plugin.getRows().find((row) => row.type === 'hunk')
    expect(separator?.hunkIndex).toBeUndefined()

    clickRow(host, plugin.getRows().indexOf(separator!))

    expect(host.textContent).toContain('Hide 2 unmodified lines')
    expect(host.textContent).toContain('beta')
    expect(host.textContent).toContain('gamma')
  })

  it('owns expansion state and reports it by region key (§C5)', () => {
    const { plugin, host } = mountDiff({ file: prefixSkippedDiff() })
    const separator = plugin.getRows().find((row) => row.type === 'hunk')!

    expect(plugin.getExpandedRegions()).toEqual(new Set())

    plugin.toggleRegion(separator.expandKey!)
    expect([...plugin.getExpandedRegions()]).toEqual([separator.expandKey])

    plugin.toggleRegion(separator.expandKey!)
    expect(plugin.getExpandedRegions()).toEqual(new Set())
    expect(host.textContent).toContain('Show 2 unmodified lines')
  })

  it('drops expansion state when a different file is pushed', () => {
    const { plugin } = mountDiff({ file: prefixSkippedDiff() })
    plugin.toggleRegion(plugin.getRows().find((row) => row.type === 'hunk')!.expandKey!)
    expect(plugin.getExpandedRegions().size).toBe(1)

    plugin.setFile(otherPathDiff())

    expect(plugin.getExpandedRegions()).toEqual(new Set())
  })
})

describe('diff plugin — gutter (§3.3)', () => {
  it('labels stacked lanes with old and new numbers and a change indicator', () => {
    const { host } = mountDiff({ file: singleHunkDiff(), side: 'stacked' })

    expect(gutterLaneTexts(host)).toContainEqual(['1', '1', ''])
    expect(gutterLaneTexts(host)).toContainEqual(['2', '', '-'])
    expect(gutterLaneTexts(host)).toContainEqual(['', '2', '+'])
  })

  it('tones the new lane and not the old one for an addition (§3.3, trap 2)', () => {
    const { host } = mountDiff({ file: singleHunkDiff(), side: 'stacked' })
    const addition = gutterCellForIndicator(host, '+')

    expect(laneTone(addition, 'old')).toBe('default')
    expect(laneTone(addition, 'new')).toBe('added')
    expect(laneTone(addition, 'indicator')).toBe('added')
  })

  it('tones the old lane and not the new one for a deletion (§3.3, trap 2)', () => {
    const { host } = mountDiff({ file: singleHunkDiff(), side: 'stacked' })
    const deletion = gutterCellForIndicator(host, '-')

    expect(laneTone(deletion, 'old')).toBe('deleted')
    expect(laneTone(deletion, 'new')).toBe('default')
    expect(laneTone(deletion, 'indicator')).toBe('deleted')
  })

  it('shows only its own side’s number lane in split mode', () => {
    const { host } = mountDiff({ file: singleHunkDiff(), side: 'old' })

    for (const cell of gutterCells(host)) {
      expect(cell.querySelector('.editor-diff-gutter-lane-new')).toBeNull()
      expect(cell.querySelector('.editor-diff-gutter-lane-old')).not.toBeNull()
    }
  })

  it('publishes lane geometry as CSS columns rather than approximating it (§3.3, trap 1)', () => {
    const { host } = mountDiff({ file: singleHunkDiff(), side: 'stacked' })
    const columns = queryScrollElement(host).style.getPropertyValue('--editor-diff-gutter-columns')

    // Three lanes, all in px: two number lanes from `ceil(chars * charWidth + 6)` and a 12px
    // indicator. A `1fr` anywhere here means the geometry was guessed.
    expect(columns.split(' ')).toHaveLength(3)
    expect(columns).not.toContain('fr')
    expect(columns.endsWith('12px')).toBe(true)
  })

  it('republishes columns when the lane split changes but the total does not', () => {
    // The stacked total is `ceil(old*cw + 6) + ceil(new*cw + 6) + 12`, which is SYMMETRIC in the
    // two lane character counts — so a file whose old/new digit widths are transposed has an
    // identical total and a different split. Memoizing the publish on the total therefore keeps
    // serving the previous columns, and since lanes are `overflow: hidden; text-align: right`, the
    // under-sized one silently clips its leading digit.
    //
    // Driven at the contribution directly: producing a transposed split from real projections
    // needs a contrived pair of files, because the projected row count floors both lanes equally.
    const published: string[] = []
    let digits = diffGutterDigits([numberedRow(1000, 10)])
    const contribution = createDiffGutterContribution({
      side: 'stacked',
      getDigits: () => digits,
      resolveRow: () => null,
      onLayout: (layout) => published.push(layout.lanes.map((lane) => lane.width).join(',')),
    })

    const width = () => contribution.width({ lineCount: 1, metrics: laneMetrics })
    const first = width()
    digits = diffGutterDigits([numberedRow(10, 1000)])
    const second = width()

    expect(second).toBe(first)
    expect(published).toEqual(['38,22,12', '22,38,12'])
  })

  it('never queries the DOM to update a cell (§3.3, trap 3)', () => {
    const { host, plugin } = mountDiff({ file: prefixSkippedDiff(), side: 'stacked' })
    const cells = gutterCells(host)
    expect(cells.length).toBeGreaterThan(0)

    const spies = cells.map((cell) => vi.spyOn(cell, 'querySelector'))
    try {
      // Force a full row update: every mounted cell is asked to re-render.
      plugin.toggleRegion(plugin.getRows().find((row) => row.type === 'hunk')!.expandKey!)

      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

describe('diff plugin — syntax (§C10, §C11)', () => {
  it('projects full-file syntax tokens into split diff rows', () => {
    // Unchanged from DiffView.test.ts:166-193 — a pure function over the projection.
    const tokens = projectDiffSyntaxTokens({
      rows: [{ newLineNumber: 2, oldLineNumber: 2, text: 'beta', type: 'context' }],
      side: 'old',
      sources: [
        {
          lineStarts: [0, 6, 11],
          side: 'old',
          tokens: [{ start: 6, end: 10, style: { color: 'red' } }],
        },
      ],
    })

    expect(tokens).toEqual([{ start: 0, end: 4, style: { color: 'red' } }])
  })

  it('projects stacked rows from old and new full-file token streams', () => {
    // Unchanged from DiffView.test.ts:195-228.
    const tokens = projectDiffSyntaxTokens({
      rows: [
        { oldLineNumber: 1, text: 'old', type: 'deletion' },
        { newLineNumber: 1, text: 'new', type: 'addition' },
      ],
      side: 'stacked',
      sources: [
        { lineStarts: [0], side: 'old', tokens: [{ start: 0, end: 3, style: { color: 'red' } }] },
        { lineStarts: [0], side: 'new', tokens: [{ start: 0, end: 3, style: { color: 'blue' } }] },
      ],
    })

    expect(tokens).toEqual([
      { start: 0, end: 3, style: { color: 'red' } },
      { start: 4, end: 7, style: { color: 'blue' } },
    ])
  })

  it('defaults syntax highlighting to tree-sitter instead of shiki', () => {
    expect(diffSyntaxBackend(undefined)).toEqual({ kind: 'tree-sitter' })
    expect(diffSyntaxBackend({ kind: 'shiki', shikiTheme: 'github-light' })).toEqual({
      kind: 'shiki',
      shikiTheme: 'github-light',
    })
  })

  it('passes full file text to the tree-sitter syntax backend', async () => {
    const parsedTexts: string[] = []
    mountDiff({
      file: singleHunkDiff(),
      syntaxBackend: createRecordingSyntaxBackend(parsedTexts),
      syntaxHighlight: true,
    })

    await flushPromises()

    expect(parsedTexts).toContain('one\ntwo\n')
  })

  it('disposes a shiki worker owner even when the parse is cancelled mid-flight', async () => {
    // The tree-sitter backend has no `dispose` at all, which is why every other syntax test here
    // is blind to this: only the shiki path owns a worker. Superseding the file while
    // `createShikiWorkerOwner` is still in flight used to strand the owner, because its disposal
    // was registered *after* the staleness check that bails. `setFile` cancels on every call, so
    // clicking through a file tree leaked one owner per click.
    const { plugin } = mountDiff({
      file: typescriptDiff(),
      syntaxBackend: { kind: 'shiki', shikiTheme: 'github-light' },
      syntaxHighlight: true,
    })

    // Supersede before the awaited service resolves.
    plugin.setFile(otherPathDiff())
    await flushUntil(() => shikiMock.owner.dispose.mock.calls.length > 0)

    expect(shikiMock.owner.dispose).toHaveBeenCalled()
  })

  it('creates tree-sitter sessions from diff syntax service requests', async () => {
    const sessionOptions: EditorSyntaxSessionOptions[] = []
    mountDiff({
      file: typescriptDiff(),
      syntaxBackend: createRecordingSyntaxBackend([], sessionOptions),
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

  it('routes shiki highlighting through full-file syntax service documents', async () => {
    mountDiff({
      file: typescriptDiff(),
      syntaxBackend: { kind: 'shiki', shikiTheme: 'github-light' },
      syntaxHighlight: true,
    })

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

  it('exposes projected tokens for the host to re-apply after setText', async () => {
    const { plugin } = mountDiff({
      file: typescriptDiff(),
      syntaxBackend: createTokenSyntaxBackend(),
      syntaxHighlight: true,
    })

    await flushUntil(() => plugin.getTokens().length >= 2)

    expect(plugin.getTokens()).toEqual(
      expect.arrayContaining([expect.objectContaining({ style: { color: 'rgb(1, 2, 3)' } })]),
    )
  })

  it('announces tokens to the host when the parse lands, not just on a row change', async () => {
    // The parse is async and rows do not change when it settles, so `onDidChangeTokens` is the
    // ONLY path that colours the first render. Polling `getTokens()` cannot see that: silence the
    // emitter and every other syntax assertion here still passes, while a real §C3 host mounts
    // permanently uncoloured. So assert what actually reaches the editor.
    const setTokens = vi.spyOn(Editor.prototype, 'setTokens')
    try {
      const { plugin } = mountDiff({
        file: typescriptDiff(),
        syntaxBackend: createTokenSyntaxBackend(),
        syntaxHighlight: true,
      })
      await flushUntil(() => plugin.getTokens().length >= 2)
      await flushUntil(() => appliedTokens(setTokens).length > 0)

      expect(appliedTokens(setTokens).at(-1)).toEqual(plugin.getTokens())
    } finally {
      setTokens.mockRestore()
    }
  })

  it('re-projects tokens onto the new rows across an expansion toggle (§C10)', async () => {
    // `DiffView` re-ran the whole parse per toggle and leaned on re-applying a cached token array
    // (DiffView.ts:558). The parse does not depend on expansion, so the streams are cached and
    // re-projected synchronously instead — `getTokens()` is already correct when `toggleRegion`
    // returns, before the host's `setText` runs.
    //
    // Asserted on OFFSETS, not on a count. Expansion inserts rows above the changed lines and so
    // moves every offset after them; the token count is identical before and after, which means a
    // count assertion stays green with the re-projection deleted entirely. Offsets are the only
    // thing that distinguishes "re-projected" from "stale", and a stale projection is precisely
    // the §C10 failure — colour smeared across `alpha`/`beta` with `old`/`new` left bare.
    const { plugin } = mountDiff({
      file: prefixSkippedTypescriptDiff(),
      syntaxBackend: createTokenSyntaxBackend(),
      syntaxHighlight: true,
    })
    await flushUntil(() => plugin.getTokens().length > 0)

    const collapsed = joinRenderLines(plugin.getRows())
    expect(tokenTexts(plugin.getTokens(), collapsed)).toEqual(['old', 'new'])

    plugin.toggleRegion(plugin.getRows().find((row) => row.type === 'hunk')!.expandKey!)

    // Same tokens, re-anchored: they must still land on `old`/`new` in the now-longer buffer.
    const expanded = joinRenderLines(plugin.getRows())
    expect(expanded).not.toBe(collapsed)
    expect(tokenTexts(plugin.getTokens(), expanded)).toEqual(['old', 'new'])
  })

  it('leaves the editor’s own document language null (§C11)', () => {
    const { editor } = mountDiff({ file: typescriptDiff() })

    // A real language here would tree-sitter-parse the *interleaved* buffer and feed that parse
    // into folds, brackets and injections (syntaxController.ts:655-668).
    expect(editor.getState().languageId).toBeNull()
  })
})

describe('diff plugin — host-owned document (§C3, §C6)', () => {
  it('applies a theme without rebuilding the editor', () => {
    // `DiffViewOptions.theme` had no setter, so platform rebuilt the whole view on a colour-mode
    // change (diff-view.tsx:69). `Editor.setTheme` exists.
    const { editor, host } = mountDiff({ file: singleHunkDiff() })

    editor.setTheme({ foregroundColor: '#abcdef', syntax: { keyword: '#123456' } })

    const view = queryScrollElement(host)
    expect(view.style.getPropertyValue('--editor-foreground')).toBe('#abcdef')
    expect(view.style.getPropertyValue('--editor-syntax-keyword')).toBe('#123456')
  })

  it('renders no changes for an identical file', () => {
    const { plugin, host } = mountDiff({
      file: createTextDiff({
        oldFile: { path: 'note.txt', text: 'same\n' },
        newFile: { path: 'note.txt', text: 'same\n' },
      }),
    })

    expect(plugin.getRows().map((row) => row.type)).toEqual(['empty'])
    expect(host.textContent).toContain('No changes')
  })

  it('clears its rows when the file is removed', () => {
    const { plugin } = mountDiff({ file: singleHunkDiff() })

    plugin.setFile(null)

    expect(plugin.getRows()).toEqual([])
  })
})

// ------------------------------------------------------------------------------------- harness

type MountOptions = {
  readonly file?: DiffFile
  readonly side?: DiffGutterSide
  readonly syntaxBackend?: DiffSyntaxBackend
  readonly syntaxHighlight?: boolean
}

/**
 * The host half of §C3, in miniature: construct the editor with the option bag §C6/§C10/§C11
 * require, push the plugin's rows in as text, and re-apply its tokens after every `setText`.
 * Platform's shared mount component does exactly this — see the platform plan §3.
 */
function mountDiff(options: MountOptions = {}): {
  editor: Editor
  host: HTMLElement
  plugin: DiffPlugin
} {
  const host = document.createElement('div')
  host.className = 'editor-diff-view'
  document.body.appendChild(host)

  const plugin = createDiffPlugin({
    mode: 'document',
    side: options.side ?? 'stacked',
    syntaxBackend: options.syntaxBackend,
    syntaxHighlight: options.syntaxHighlight ?? false,
  })
  const editor = new Editor(host, {
    cursorLineHighlight: { gutterNumber: false, gutterBackground: false, rowBackground: false },
    documentMode: 'static',
    editability: 'readonly',
    keymap: { defaultBindings: false, layers: [] },
    plugins: [plugin],
    tabSize: 4,
  })
  mounted.push({ editor, host })

  const push = (): void => {
    editor.setText(joinRenderLines(plugin.getRows()), { languageId: null })
    editor.setTokens(plugin.getTokens())
  }
  plugin.onDidChangeRows(push)
  plugin.onDidChangeTokens(() => editor.setTokens(plugin.getTokens()))

  plugin.setFile(options.file ?? singleHunkDiff())
  return { editor, host, plugin }
}

/** A patch with no file text behind it: separators that report a skipped range but cannot open it. */
function partialSkippedDiff(): DiffFile {
  const file = prefixSkippedDiff()
  return { ...file, isPartial: true, oldLines: [], newLines: [] }
}

function singleHunkDiff(): DiffFile {
  return createTextDiff({
    oldFile: { path: 'note.txt', text: 'one\ntwo\n' },
    newFile: { path: 'note.txt', text: 'one\nTWO\n' },
  })
}

function otherPathDiff(): DiffFile {
  return createTextDiff({
    oldFile: { path: 'other.txt', text: 'one\ntwo\n' },
    newFile: { path: 'other.txt', text: 'one\nTWO\n' },
  })
}

function prefixSkippedDiff(): DiffFile {
  return createTextDiff({
    contextLines: 0,
    oldFile: { path: 'note.txt', text: 'alpha\nbeta\ngamma\n' },
    newFile: { path: 'note.txt', text: 'alpha\nbeta\nGAMMA\n' },
  })
}

function prefixSkippedTypescriptDiff(): DiffFile {
  return createTextDiff({
    contextLines: 0,
    oldFile: { path: 'note.ts', text: 'alpha\nbeta\nold\n', languageId: 'typescript' },
    newFile: { path: 'note.ts', text: 'alpha\nbeta\nnew\n', languageId: 'typescript' },
  })
}

function suffixSkippedDiff(): DiffFile {
  return createTextDiff({
    contextLines: 0,
    oldFile: { path: 'note.txt', text: 'alpha\nbeta\ngamma\n' },
    newFile: { path: 'note.txt', text: 'ALPHA\nbeta\ngamma\n' },
  })
}

function typescriptDiff(): DiffFile {
  return createTextDiff({
    contextLines: 0,
    oldFile: { path: 'note.ts', text: 'keep\nold\nskip\n', languageId: 'typescript' },
    newFile: { path: 'note.ts', text: 'keep\nnew\nskip\n', languageId: 'typescript' },
  })
}

const laneMetrics = { characterWidth: 8, rowHeight: 20 }

function numberedRow(oldLineNumber: number, newLineNumber: number): DiffRenderRow {
  return { type: 'context', text: 'content', oldLineNumber, newLineNumber }
}

function queryScrollElement(host: HTMLElement): HTMLElement {
  const view = host.querySelector<HTMLElement>('.editor-virtualized')
  if (!view) throw new Error('Expected a mounted editor')
  return view
}

function gutterCells(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('.editor-diff-gutter')].filter(
    (cell) => !cell.hidden,
  )
}

function gutterLaneTexts(host: HTMLElement): string[][] {
  return gutterCells(host).map((cell) =>
    [...cell.querySelectorAll<HTMLElement>('.editor-diff-gutter-lane')].map(
      (lane) => lane.textContent ?? '',
    ),
  )
}

function gutterCellForIndicator(host: HTMLElement, indicator: string): HTMLElement {
  const cell = gutterCells(host).find(
    (candidate) =>
      candidate.querySelector('.editor-diff-gutter-lane-indicator')?.textContent === indicator,
  )
  if (!cell) throw new Error(`Expected a gutter cell showing "${indicator}"`)
  return cell
}

function laneTone(cell: HTMLElement, lane: string): string {
  const element = cell.querySelector<HTMLElement>(`.editor-diff-gutter-lane-${lane}`)
  if (!element) throw new Error(`Expected a ${lane} lane`)
  return element.dataset.diffTone ?? ''
}

function clickGutter(view: HTMLElement, y: number): void {
  view.dispatchEvent(pointerEvent('mousedown', y))
  view.dispatchEvent(pointerEvent('click', y))
}

function clickRow(host: HTMLElement, row: number): void {
  const element = host.querySelector<HTMLElement>(`[data-editor-virtual-row="${row}"]`)
  if (!element) throw new Error(`Expected virtual row ${row}`)
  element.dispatchEvent(pointerEvent('mousedown', 0))
  element.dispatchEvent(pointerEvent('click', 0))
}

/** `cancelable`, or `preventDefault()` is a no-op and `defaultPrevented` can never be true. */
function pointerEvent(type: string, clientY: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY, detail: 1 })
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
          applyChange: async () => createEmptySyntaxResult(),
          dispose: () => undefined,
          getResult: () => createEmptySyntaxResult(),
          getSnapshotVersion: () => 0,
          getTokens: () => [],
          refresh: async () => createEmptySyntaxResult(),
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
  const tokens: EditorToken[] =
    start === -1 ? [] : [{ end: start + target.length, start, style: { color: 'rgb(1, 2, 3)' } }]

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

/** The text each token actually covers, so an assertion pins anchoring rather than a count. */
function tokenTexts(tokens: readonly EditorToken[], text: string): string[] {
  return tokens.map((token) => text.slice(token.start, token.end))
}

type SetTokensSpy = { readonly mock: { readonly calls: readonly [readonly EditorToken[]][] } }

/** Non-empty token arrays that reached a real `Editor`, in call order. */
function appliedTokens(setTokens: SetTokensSpy): readonly (readonly EditorToken[])[] {
  return setTokens.mock.calls.map(([tokens]) => tokens).filter((tokens) => tokens.length > 0)
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

async function flushUntil(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (done()) return
    await flushPromises()
  }
}
