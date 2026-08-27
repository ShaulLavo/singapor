import { describe, expect, it, vi } from 'vitest'

import {
  createFoldGutterContribution,
  createLineGutterContribution,
} from '../../gutters/src/index.ts'

import { createEditorViewSnapshot } from '../src/editor/viewSnapshot'
import { setEditorTokenIndex } from '../src/editor/tokenIndex'
import { createInlineMap } from '../src/inlineMap'
import { createPieceTableSnapshot } from '../src/public/document'
import type {
  EditorMountedChunkPaintJSON,
  EditorViewSnapshot,
  EditorVisibleRowSnapshot,
} from '../src/plugins'
import type { EditorToken } from '../src/tokens'
import { VirtualizedTextView } from '../src/virtualization'

const TEXT = 'const value = 1'

type SnapshotHarness = {
  readonly snapshot: EditorViewSnapshot
  readonly materializeFullText: ReturnType<typeof vi.fn<() => string>>
  readonly readRange: ReturnType<typeof vi.fn<(start: number, end: number) => string>>
  readonly readLineStarts: ReturnType<typeof vi.fn<() => readonly number[]>>
  readonly lineStartsViewToArray: ReturnType<typeof vi.fn<() => readonly number[]>>
}

describe('editor view snapshot serialization', () => {
  it('attaches non-enumerable methods and keeps compact extraction mounted and bounded', () => {
    const tokens: EditorToken[] = [
      {
        start: 0,
        end: 5,
        style: { color: '#ff0000', fontWeight: 700 },
      },
    ]
    setEditorTokenIndex(tokens, {
      maxEnds: [5],
      monotonicEnd: true,
      nonOverlapping: true,
      sortedByStart: true,
    })
    const harness = snapshotHarness({ tokens })

    expect(Object.keys(harness.snapshot)).not.toContain('toJSON')
    expect(Object.keys(harness.snapshot)).not.toContain('toVisibleSnapshot')
    expect(Object.getOwnPropertyDescriptor(harness.snapshot, 'toJSON')?.enumerable).toBe(false)

    const visible = harness.snapshot.toVisibleSnapshot()

    expect(visible).not.toBeNull()
    expect(harness.materializeFullText).not.toHaveBeenCalled()
    expect(harness.readLineStarts).not.toHaveBeenCalled()
    expect(harness.lineStartsViewToArray).not.toHaveBeenCalled()
    expect(visible?.rows[0]?.chunks[0]).toEqual({
      sourceStartOffset: 0,
      sourceEndOffset: 5,
      rowLocalStart: 0,
      rowLocalEnd: 5,
      parts: [{ kind: 'text', text: 'const' }],
      replayFidelity: 'exact',
      runs: [{ start: 0, end: 5, style: { color: '#ff0000' } }],
    })
    expect(visible?.rows[0]?.chunks[0]).not.toHaveProperty('text')
    expect(Object.getOwnPropertyDescriptor(visible, 'toJSON')?.enumerable).toBe(false)

    const visibleJSON = visible!.toJSON()
    expect(visibleJSON.viewport.borderBoxHeight).toBeNull()
    expect(visible!.toJSON()).toEqual(visibleJSON)
    expect(() => structuredClone(visibleJSON)).not.toThrow()

    const fullJSON = harness.snapshot.toJSON()
    expect(harness.materializeFullText).toHaveBeenCalledTimes(1)
    expect(harness.readLineStarts).toHaveBeenCalledTimes(1)
    expect(harness.lineStartsViewToArray).not.toHaveBeenCalled()
    expect(fullJSON).not.toHaveProperty('documentSyncPoint')
    expect(fullJSON).not.toHaveProperty('changesSinceDocumentSyncPoint')
    expect(fullJSON).not.toHaveProperty('textSnapshot')
    expect(fullJSON.visibleRows[0]?.chunks[0]?.text).toBe('ignored runtime chunk text')
    expect(() => structuredClone(fullJSON)).not.toThrow()
  })

  it('does no source or token work for transformed, injected, core-rendered, or refused paint', () => {
    let tokenReads = 0
    const tokens = new Proxy<readonly EditorToken[]>([], {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) tokenReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const transformed = snapshotHarness({
      tokens,
      chunks: [chunk(0, 1_000_000, [{ kind: 'text', text: 'x' }])],
    })

    expect(transformed.snapshot.toVisibleSnapshot()?.rows[0]?.chunks[0]?.replayFidelity).toBe(
      'plain-transformed',
    )
    expect(transformed.readRange).not.toHaveBeenCalled()
    expect(tokenReads).toBe(0)

    const injected = snapshotHarness({
      rowSource: 'injected',
      chunks: [chunk(0, 5, [{ kind: 'text', text: 'const' }])],
    })
    expect(injected.snapshot.toVisibleSnapshot()?.rows[0]?.chunks[0]?.replayFidelity).toBe(
      'plain-transformed',
    )
    expect(injected.readRange).not.toHaveBeenCalled()

    const control = snapshotHarness({
      chunks: [chunk(0, 1, [{ kind: 'control', text: 'NUL', widthCells: 3 }])],
    })
    expect(control.snapshot.toVisibleSnapshot()?.rows[0]?.chunks[0]).toMatchObject({
      replayFidelity: 'plain-core-rendered',
      parts: [{ kind: 'control', text: 'NUL', widthCells: 3 }],
      runs: [],
    })
    expect(control.readRange).not.toHaveBeenCalled()

    const unsupported = snapshotHarness({ mountedPaintSupport: 'unreplayable-plugin-css' })
    expect(unsupported.snapshot.toVisibleSnapshot()).toBeNull()
    expect(unsupported.readRange).not.toHaveBeenCalled()
  })

  it('scans an unindexed external source once and refuses ambiguous overlap only', () => {
    let tokenReads = 0
    const external = new Proxy<readonly EditorToken[]>(
      [
        { start: 0, end: 4, style: { color: 'red' } },
        { start: 2, end: 5, style: { color: 'blue' } },
      ],
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) tokenReads += 1
          return Reflect.get(target, property, receiver)
        },
      },
    )
    const harness = snapshotHarness({ tokens: external })

    expect(harness.snapshot.toVisibleSnapshot()?.rows[0]?.chunks[0]).toMatchObject({
      replayFidelity: 'plain-overlap',
      runs: [],
    })
    expect(tokenReads).toBe(external.length)
  })

  it('replays indexed built-in overlap in deterministic source order', () => {
    const tokens: EditorToken[] = [
      { start: 0, end: 5, style: { color: 'red' } },
      { start: 2, end: 4, style: { color: 'blue' } },
    ]
    setEditorTokenIndex(tokens, {
      maxEnds: [5, 5],
      monotonicEnd: false,
      nonOverlapping: false,
      sortedByStart: true,
    })
    const harness = snapshotHarness({ tokens })

    expect(harness.snapshot.toVisibleSnapshot()?.rows[0]?.chunks[0]?.runs).toEqual([
      { start: 0, end: 2, style: { color: 'red' } },
      { start: 2, end: 4, style: { color: 'blue' } },
      { start: 4, end: 5, style: { color: 'red' } },
    ])
  })

  it('delegates JSON.stringify and materializes each full-document field once', () => {
    const harness = snapshotHarness()

    const parsed = JSON.parse(JSON.stringify(harness.snapshot))

    expect(parsed).toMatchObject({ kind: 'editor-view', schemaVersion: 1, fullText: TEXT })
    expect(harness.materializeFullText).toHaveBeenCalledTimes(1)
    expect(harness.readLineStarts).toHaveBeenCalledTimes(1)
    expect(harness.lineStartsViewToArray).not.toHaveBeenCalled()
  })

  it('rejects non-finite numeric token style values instead of JSON-null coercion', () => {
    const harness = snapshotHarness({
      tokens: [{ start: 0, end: 5, style: { fontWeight: Number.POSITIVE_INFINITY } }],
    })

    expect(() => harness.snapshot.toJSON()).toThrow(/fontWeight.*finite/)
  })

  it('checks same-length transformed paint before token work and keeps all fallbacks zero-work', () => {
    let tokenReads = 0
    const tokens = new Proxy<readonly EditorToken[]>(
      [{ start: 0, end: 5, style: { color: 'red' } }],
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) tokenReads += 1
          return Reflect.get(target, property, receiver)
        },
      },
    )
    const sameLength = snapshotHarness({
      tokens,
      chunks: [chunk(0, 5, [{ kind: 'text', text: 'other' }])],
    })

    expect(sameLength.snapshot.toVisibleSnapshot()?.rows[0]?.chunks[0]?.replayFidelity).toBe(
      'plain-transformed',
    )
    expect(sameLength.readRange).toHaveBeenCalledTimes(1)
    expect(tokenReads).toBe(0)

    const allFallback = snapshotHarness({
      tokens,
      chunks: [
        chunk(0, 1_000_000, [{ kind: 'text', text: 'tiny' }]),
        chunk(5, 10, [{ kind: 'control', text: '[U+0081]', widthCells: 8 }]),
      ],
    })
    expect(allFallback.snapshot.toVisibleSnapshot()?.rows[0]?.chunks).toHaveLength(2)
    expect(allFallback.readRange).not.toHaveBeenCalled()
    expect(tokenReads).toBe(0)
  })

  it('bounds indexed token reads to the mounted exact chunk', () => {
    const text = 'x'.repeat(100_000)
    const source = Array.from(
      { length: 10_000 },
      (_value, index): EditorToken => ({
        start: index * 10,
        end: index * 10 + 5,
        style: { color: `#${index.toString(16).padStart(6, '0').slice(-6)}` },
      }),
    )
    let tokenReads = 0
    const tokens = new Proxy<readonly EditorToken[]>(source, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) tokenReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    setEditorTokenIndex(tokens, {
      maxEnds: source.map((token) => token.end),
      monotonicEnd: true,
      nonOverlapping: true,
      sortedByStart: true,
    })
    const harness = snapshotHarness({
      text,
      tokens,
      chunks: [chunk(50_000, 50_005, [{ kind: 'text', text: 'xxxxx' }])],
    })

    expect(harness.snapshot.toVisibleSnapshot()?.rows[0]?.chunks[0]?.runs).toHaveLength(1)
    expect(tokenReads).toBeLessThan(64)
    expect(harness.readRange).toHaveBeenCalledWith(50_000, 50_005)
  })

  it('projects many non-overlapping indexed runs in one linear pass', () => {
    const count = 5_000
    const text = 'x'.repeat(count)
    const tokens = Array.from(
      { length: count },
      (_value, index): EditorToken => ({
        start: index,
        end: index + 1,
        style: { color: index % 2 === 0 ? 'red' : 'blue' },
      }),
    )
    setEditorTokenIndex(tokens, {
      maxEnds: tokens.map((token) => token.end),
      monotonicEnd: true,
      nonOverlapping: true,
      sortedByStart: true,
    })
    const harness = snapshotHarness({
      text,
      tokens,
      chunks: [chunk(0, count, [{ kind: 'text', text }])],
    })

    expect(harness.snapshot.toVisibleSnapshot()?.rows[0]?.chunks[0]?.runs).toHaveLength(count)
  })

  it('partitions many exact chunks with one unindexed external token pass', () => {
    const text = 'x'.repeat(2_000)
    const source = Array.from(
      { length: 200 },
      (_value, index): EditorToken => ({
        start: index * 10,
        end: index * 10 + 5,
        style: { color: 'red' },
      }),
    )
    let tokenReads = 0
    const tokens = new Proxy<readonly EditorToken[]>(source, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) tokenReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const chunks = source.map((token) =>
      chunk(token.start, token.end, [{ kind: 'text', text: 'xxxxx' }]),
    )
    const harness = snapshotHarness({ text, tokens, chunks })

    expect(harness.snapshot.toVisibleSnapshot()?.rows[0]?.chunks).toHaveLength(chunks.length)
    expect(tokenReads).toBe(source.length)
  })

  it('copies only live horizontal chunks and source ranges from a huge mounted line', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      textMetrics: { rowHeight: 20, characterWidth: 8 },
      longLineChunkSize: 1_000,
      longLineChunkThreshold: 1_000,
      horizontalOverscanColumns: 0,
    })
    const text = 'x'.repeat(1_000_000)
    view.setText(text)

    for (const scrollLeft of [0, 20_000]) {
      view.setScrollMetrics(0, 20, 80, scrollLeft)
      const harness = snapshotHarnessFromView(view, text)
      const visible = harness.snapshot.toVisibleSnapshot()
      const mountedChunk = view.getState().mountedRows[0]!.chunks[0]!

      expect(visible?.rows[0]?.chunks).toHaveLength(1)
      expect(visible?.rows[0]?.chunks[0]?.parts.map((part) => part.text).join('')).toBe(
        mountedChunk.text,
      )
      expect(harness.readRange).toHaveBeenCalledTimes(1)
      expect(harness.readRange).toHaveBeenCalledWith(
        mountedChunk.startOffset,
        mountedChunk.endOffset,
      )
      expect(mountedChunk.text.length).toBeLessThanOrEqual(1_000)
      if (scrollLeft > 0) expect(visible?.rows[0]?.leftSpacerWidth).toBeGreaterThan(0)
    }

    view.dispose()
    container.remove()
  })

  it('captures mounted C0/C1 labels and bounded oversized BiDi refusal paint', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      textMetrics: { rowHeight: 20, characterWidth: 8 },
    })

    const controls = '\u0000\u0081'
    view.setText(controls)
    view.setScrollMetrics(0, 20, 160)
    const controlHarness = snapshotHarnessFromView(view, controls)
    const controlChunk = controlHarness.snapshot.toVisibleSnapshot()?.rows[0]?.chunks[0]
    expect(controlChunk?.replayFidelity).toBe('plain-core-rendered')
    expect(controlChunk?.parts).toEqual([
      { kind: 'text', text: '\u2400' },
      { kind: 'control', text: '[U+0081]', widthCells: 8 },
    ])
    expect(controlHarness.readRange).not.toHaveBeenCalled()

    const bidi = `${'א'.repeat(32_000)}tail`
    view.setText(bidi)
    view.setScrollMetrics(0, 20, 160)
    const bidiHarness = snapshotHarnessFromView(view, bidi)
    const bidiChunk = bidiHarness.snapshot.toVisibleSnapshot()?.rows[0]?.chunks[0]
    expect(bidiChunk?.replayFidelity).toBe('plain-core-rendered')
    expect(bidiChunk?.parts.every((part) => part.kind === 'refusal')).toBe(true)
    expect(bidiChunk?.parts.map((part) => part.text).join('').length).toBeLessThan(256)
    expect(bidiHarness.readRange).not.toHaveBeenCalled()

    view.dispose()
    container.remove()
  })

  it('refuses arbitrary widget and plugin-class paint before source or token access', () => {
    const text = '# Title'
    const container = document.createElement('div')
    document.body.appendChild(container)
    const view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      textMetrics: { rowHeight: 20, characterWidth: 8 },
    })
    view.setText(text)
    view.setScrollMetrics(0, 20, 160)
    view.setInlineMap(
      createInlineMap(createPieceTableSnapshot(text), [
        {
          id: 'widget',
          startIndex: 2,
          endIndex: 7,
          text: 'W',
          render: (host) => host.append('mounted widget'),
        },
      ]),
    )
    const widget = snapshotHarnessFromView(view, text)
    expect(widget.snapshot.toVisibleSnapshot()).toBeNull()
    expect(widget.readRange).not.toHaveBeenCalled()

    view.setInlineMap(null)
    view.setRowDecorations(
      new Map([[0, { className: 'plugin-row', gutterClassName: 'plugin-gutter' }]]),
    )
    const decorated = snapshotHarnessFromView(view, text)
    expect(decorated.snapshot.toVisibleSnapshot()).toBeNull()
    expect(decorated.readRange).not.toHaveBeenCalled()

    view.setRowDecorations(new Map())
    view.setInlineMap(
      createInlineMap(createPieceTableSnapshot(text), [
        {
          id: 'heading',
          startIndex: 0,
          endIndex: 2,
          text: '',
          kind: 'markdown-heading',
        },
      ]),
    )
    const heading = snapshotHarnessFromView(view, text)
    expect(heading.snapshot.toVisibleSnapshot()).toBeNull()
    expect(heading.readRange).not.toHaveBeenCalled()

    view.dispose()
    container.remove()
  })

  it('captures gutter, fold, wrap, and caret facts without remounting rows or scanning folds', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      textMetrics: { rowHeight: 20, characterWidth: 8 },
      gutterWidth: 7,
      gutterContributions: [createLineGutterContribution(), createFoldGutterContribution()],
      cursorLineHighlight: {
        gutterNumber: true,
        gutterBackground: ['fold-gutter'],
        rowBackground: true,
      },
    })
    const text = 'alpha\nbeta\ngamma'
    const marker = {
      key: 'fold:0',
      startOffset: 0,
      endOffset: 10,
      startRow: 0,
      endRow: 1,
      collapsed: false,
    }
    view.setText(text)
    view.setFoldMarkers([marker])
    view.setScrollMetrics(0, 80, 160)
    view.setSelection(6, 6)
    view.setSelection(0, 0)
    const before = view.getState().mountedRows.map((row) => row.element)
    const first = snapshotHarnessFromView(view, text, unreadableFoldMarkers())
    const firstVisible = first.snapshot.toVisibleSnapshot()!

    expect(firstVisible.gutterLayout.fixedWidth).toBe(7)
    expect(firstVisible.gutterLayout.lanes.map((lane) => lane.id)).toEqual([
      'line-gutter',
      'fold-gutter',
    ])
    expect(firstVisible.rows[0]).toMatchObject({
      contentCursorLine: true,
      gutterNumberCursorLine: true,
      gutterCursorLineBackgroundLaneIds: ['fold-gutter'],
      foldMarker: marker,
    })

    view.setSelection(6, 6)
    const after = view.getState().mountedRows.map((row) => row.element)
    const secondVisible = snapshotHarnessFromView(view, text).snapshot.toVisibleSnapshot()!
    expect(after).toEqual(before)
    expect(secondVisible.rows[0]).toMatchObject({
      contentCursorLine: false,
      gutterNumberCursorLine: false,
      gutterCursorLineBackgroundLaneIds: [],
    })
    expect(secondVisible.rows[1]).toMatchObject({
      contentCursorLine: true,
      gutterNumberCursorLine: true,
      gutterCursorLineBackgroundLaneIds: ['fold-gutter'],
    })

    view.dispose()
    const wrappedView = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      wrap: true,
      textMetrics: { rowHeight: 20, characterWidth: 8 },
      gutterContributions: [createLineGutterContribution()],
    })
    wrappedView.setText('abcdefghij')
    wrappedView.setScrollMetrics(0, 80, 72)
    wrappedView.setSelection(8, 8)
    const wrappedRows = snapshotHarnessFromView(
      wrappedView,
      'abcdefghij',
    ).snapshot.toVisibleSnapshot()!.rows
    expect(wrappedRows.map((row) => row.primaryText)).toEqual([true, false])
    expect(wrappedRows.map((row) => row.contentCursorLine)).toEqual([false, true])
    expect(wrappedRows.map((row) => row.gutterNumberCursorLine)).toEqual([false, false])

    wrappedView.dispose()
    container.remove()
  })

  it('omits cyclic metadata and returns detached JSON-safe copies', () => {
    const metadata: { self?: unknown } = {}
    metadata.self = metadata
    const theme = { foregroundColor: '#ffffff', syntax: { keyword: '#ff0000' } }
    const parts: Extract<EditorMountedChunkPaintJSON, { kind: 'replayable' }>['parts'] = [
      { kind: 'text', text: 'const' },
    ]
    const tokens: EditorToken[] = [
      {
        start: 0,
        end: 5,
        style: { color: '#ff0000', fontStyle: 'italic', fontWeight: 700 },
      },
    ]
    setEditorTokenIndex(tokens, {
      maxEnds: [5],
      monotonicEnd: true,
      nonOverlapping: true,
      sortedByStart: true,
    })
    const harness = snapshotHarness({
      metadata,
      theme,
      tokens,
      chunks: [chunk(0, 5, parts)],
    })
    const visible = harness.snapshot.toVisibleSnapshot()!
    const visibleJSON = visible.toJSON()

    expect(() => harness.snapshot.toJSON()).not.toThrow()
    expect(harness.snapshot.toJSON().visibleRows[0]).not.toHaveProperty('metadata')
    expect(JSON.parse(JSON.stringify(visible))).toEqual(visible.toJSON())
    expect(visible.rows).not.toBe(harness.snapshot.visibleRows)
    expect(visible.rows[0]?.chunks).not.toBe(harness.snapshot.visibleRows[0]?.chunks)
    expect(visible.rows[0]?.chunks[0]?.parts).not.toBe(parts)
    expect(visible.rows[0]?.chunks[0]?.runs[0]?.style).not.toBe(tokens[0]?.style)

    theme.syntax.keyword = '#changed'
    ;(parts[0] as { text: string }).text = 'changed'
    ;(tokens[0]!.style as { color?: string }).color = '#changed'
    ;(visibleJSON.rows[0]!.chunks[0]!.parts[0] as { text: string }).text = 'json changed'
    expect(visible.theme?.syntax?.keyword).toBe('#ff0000')
    expect(visible.rows[0]?.chunks[0]?.parts[0]).toEqual({ kind: 'text', text: 'const' })
    expect(visible.rows[0]?.chunks[0]?.runs[0]).toEqual({
      start: 0,
      end: 5,
      style: { color: '#ff0000' },
    })
    expect(visible.toJSON().rows[0]?.chunks[0]?.parts[0]).toEqual({
      kind: 'text',
      text: 'const',
    })
  })

  it('preserves empty and overscanned mounted viewports without full-document reads', () => {
    const empty = snapshotHarness({
      rows: [],
      viewport: {
        scrollTop: 0,
        scrollLeft: 0,
        scrollHeight: 0,
        scrollWidth: 0,
        clientHeight: 0,
        clientWidth: 0,
        visibleRange: { start: 0, end: 0 },
      },
    })
    expect(empty.snapshot.toVisibleSnapshot()?.rows).toEqual([])
    expect(empty.readRange).not.toHaveBeenCalled()
    expect(empty.materializeFullText).not.toHaveBeenCalled()

    const container = document.createElement('div')
    document.body.appendChild(container)
    const view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 2,
      textMetrics: { rowHeight: 20, characterWidth: 8 },
    })
    const text = Array.from({ length: 20 }, (_value, index) => `line ${index}`).join('\n')
    view.setText(text)
    view.setScrollMetrics(60, 40, 160)
    const state = view.getState()
    const visible = snapshotHarnessFromView(view, text).snapshot.toVisibleSnapshot()!
    expect(visible.rows.map((row) => row.index)).toEqual(state.mountedRows.map((row) => row.index))
    expect(visible.rows.length).toBeGreaterThan(state.visibleRange.end - state.visibleRange.start)

    view.dispose()
    container.remove()
  })

  it('clips half-open token edges to an exact mounted chunk', () => {
    const text = 'abcdefghijklmno'
    const tokens: EditorToken[] = [
      { start: 0, end: 5, style: { color: 'before' } },
      { start: 4, end: 6, style: { color: 'crossing' } },
      { start: 10, end: 12, style: { color: 'after' } },
    ]
    setEditorTokenIndex(tokens, {
      maxEnds: [5, 6, 12],
      monotonicEnd: true,
      nonOverlapping: false,
      sortedByStart: true,
    })
    const harness = snapshotHarness({
      text,
      tokens,
      chunks: [chunk(5, 10, [{ kind: 'text', text: 'fghij' }])],
    })

    expect(harness.snapshot.toVisibleSnapshot()?.rows[0]?.chunks[0]?.runs).toEqual([
      { start: 0, end: 1, style: { color: 'crossing' } },
    ])
  })

  it('preserves a mounted tab and token offsets in buffer coordinates', () => {
    const tokens: EditorToken[] = [{ start: 1, end: 6, style: { color: 'after-tab' } }]
    setEditorTokenIndex(tokens, {
      maxEnds: [6],
      monotonicEnd: true,
      nonOverlapping: true,
      sortedByStart: true,
    })
    const harness = snapshotHarness({
      text: '\talpha',
      tokens,
      chunks: [chunk(0, 6, [{ kind: 'text', text: '\talpha' }])],
    })

    expect(harness.snapshot.toVisibleSnapshot()?.rows[0]?.chunks[0]).toMatchObject({
      parts: [{ kind: 'text', text: '\talpha' }],
      replayFidelity: 'exact',
      runs: [{ start: 1, end: 6, style: { color: 'after-tab' } }],
    })
  })
})

function snapshotHarness(
  options: {
    readonly text?: string
    readonly metadata?: unknown
    readonly theme?: EditorViewSnapshot['theme']
    readonly tokens?: readonly EditorToken[]
    readonly chunks?: readonly EditorVisibleRowSnapshot['chunks'][number][]
    readonly rows?: readonly EditorVisibleRowSnapshot[]
    readonly rowSource?: EditorVisibleRowSnapshot['source']
    readonly mountedPaintSupport?: EditorVisibleRowSnapshot['mountedPaintSupport']
    readonly gutterWidth?: number
    readonly gutterLayout?: EditorViewSnapshot['gutterLayout']
    readonly foldMarkers?: EditorViewSnapshot['foldMarkers']
    readonly viewport?: EditorViewSnapshot['viewport']
  } = {},
): SnapshotHarness {
  const text = options.text ?? TEXT
  const materializeFullText = vi.fn(() => text)
  const readRange = vi.fn((start: number, end: number) => text.slice(start, end))
  const readLineStarts = vi.fn(() => [0])
  const lineStartsViewToArray = vi.fn(() => [0])
  const textSnapshot = {
    length: text.length,
    readRange,
    materializeFullText,
    forEachTextChunk: vi.fn(),
  }
  const row: EditorVisibleRowSnapshot = {
    index: 0,
    bufferRow: 0,
    source: options.rowSource ?? 'document',
    metadata: options.metadata,
    startOffset: 0,
    endOffset: text.length,
    text: 'logical row text must not enter the compact DTO',
    kind: 'text',
    primaryText: true,
    top: 0,
    height: 20,
    leftSpacerWidth: 12,
    contentCursorLine: true,
    gutterNumberCursorLine: true,
    gutterCursorLineBackgroundLaneIds: ['fold-gutter'],
    mountedPaintSupport: options.mountedPaintSupport ?? 'replayable',
    chunks: options.chunks ?? [chunk(0, 5, [{ kind: 'text', text: 'const' }])],
    foldMarker: {
      key: 'fold:0',
      startOffset: 0,
      endOffset: text.length,
      startRow: 0,
      endRow: 1,
      collapsed: false,
    },
  }
  const runtime = {
    documentId: 'snapshot.ts',
    languageId: 'typescript' as const,
    theme: options.theme ?? { foregroundColor: '#ffffff', syntax: { keyword: '#ff0000' } },
    textSnapshot,
    get fullText() {
      return materializeFullText()
    },
    textVersion: 4,
    initialHighlightStatus: 'painted' as const,
    documentSyncPoint: {
      revision: 4,
      segment: Object.freeze({}) as EditorViewSnapshot['documentSyncPoint']['segment'],
      textVersion: 4,
    },
    changesSinceDocumentSyncPoint: () => null,
    get lineStarts() {
      return readLineStarts()
    },
    lineStartsView: {
      length: 1,
      at: () => 0,
      indexForOffset: () => 0,
      firstIndexAtOrAfter: () => 0,
      toArray: lineStartsViewToArray,
    },
    tokens: options.tokens ?? [],
    brackets: [{ index: 0, char: '{', depth: 0 }],
    selections: [
      { anchorOffset: 0, headOffset: 0, startOffset: 0, endOffset: 0, affinity: 'after' as const },
    ],
    metrics: { rowHeight: 20, characterWidth: 8 },
    lineCount: 1,
    contentWidth: 160,
    totalHeight: 20,
    gutterWidth: options.gutterWidth ?? 32,
    gutterLayout: options.gutterLayout ?? {
      fixedWidth: 0,
      lanes: [{ id: 'line-gutter', width: 32 }],
    },
    tabSize: 2,
    foldMarkers: options.foldMarkers ?? (row.foldMarker ? [row.foldMarker] : []),
    visibleRows: options.rows ?? [row],
    viewport:
      options.viewport ??
      ({
        scrollTop: 0,
        scrollLeft: 24,
        scrollHeight: 20,
        scrollWidth: 160,
        clientHeight: 20,
        clientWidth: 80,
        visibleRange: { start: 0, end: 1 },
      } satisfies EditorViewSnapshot['viewport']),
  }

  return {
    snapshot: createEditorViewSnapshot(runtime),
    materializeFullText,
    readRange,
    readLineStarts,
    lineStartsViewToArray,
  }
}

function snapshotHarnessFromView(
  view: VirtualizedTextView,
  text: string,
  foldMarkers?: EditorViewSnapshot['foldMarkers'],
): SnapshotHarness {
  const state = view.getState()
  const rows: EditorVisibleRowSnapshot[] = state.mountedRows.map((row) => ({
    index: row.index,
    bufferRow: row.bufferRow,
    source: row.source,
    injectedTextRowId: row.injectedTextRowId,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    text: row.text,
    kind: 'text',
    primaryText: row.primaryText,
    top: row.top,
    height: row.height,
    leftSpacerWidth: row.leftSpacerWidth,
    contentCursorLine: row.cursorLineContentActive,
    gutterNumberCursorLine: row.gutterNumberCursorLine,
    gutterCursorLineBackgroundLaneIds: row.gutterCursorLineBackgroundLaneIds,
    mountedPaintSupport: row.mountedPaintSupport,
    chunks: row.chunks.map((mounted) => ({
      sourceStartOffset: mounted.startOffset,
      sourceEndOffset: mounted.endOffset,
      rowLocalStart: mounted.localStart,
      rowLocalEnd: mounted.localEnd,
      text: mounted.text,
      mountedPaint: mounted.mountedPaint,
    })),
    foldMarker: row.foldMarker,
  }))

  return snapshotHarness({
    text,
    rows,
    gutterWidth: state.gutterWidth,
    gutterLayout: state.gutterLayout,
    foldMarkers: foldMarkers ?? state.foldMarkers,
    viewport: {
      scrollTop: state.scrollTop,
      scrollLeft: state.scrollLeft,
      scrollHeight: state.scrollHeight,
      scrollWidth: state.scrollWidth,
      clientHeight: state.viewportHeight,
      clientWidth: state.viewportWidth,
      visibleRange: state.visibleRange,
    },
  })
}

function unreadableFoldMarkers(): EditorViewSnapshot['foldMarkers'] {
  return new Proxy([] as unknown as EditorViewSnapshot['foldMarkers'], {
    get(_target, property) {
      if (property === 'length') return 10_000
      throw new Error(`compact snapshot must not read foldMarkers.${String(property)}`)
    },
  })
}

function chunk(
  sourceStartOffset: number,
  sourceEndOffset: number,
  parts: Extract<EditorMountedChunkPaintJSON, { kind: 'replayable' }>['parts'],
): EditorVisibleRowSnapshot['chunks'][number] {
  return {
    sourceStartOffset,
    sourceEndOffset,
    rowLocalStart: 0,
    rowLocalEnd: sourceEndOffset - sourceStartOffset,
    text: 'ignored runtime chunk text',
    mountedPaint: { kind: 'replayable', parts },
  }
}
