import { afterEach, describe, expect, it } from 'vitest'
import '../src/style.css'

import {
  createEditorBufferSession,
  createEditorTextBuffer,
  type DocumentSessionChange,
} from '../src/documentSession'
import { VirtualizedTextView } from '../src/virtualization'
import {
  estimatedDisplayCellForColumn,
  offsetToX,
  xToOffset,
} from '../src/virtualization/virtualizedTextViewGeometry'
import type { VirtualizedTextViewInternal } from '../src/virtualization/virtualizedTextViewInternals'

const mounted: { host: HTMLElement; view: VirtualizedTextView }[] = []

afterEach(() => {
  for (const { host, view } of mounted) {
    view.dispose()
    host.remove()
  }
  mounted.length = 0
})

describe('indexed long-line geometry', () => {
  it('keeps scrolled caret and hit-test positions through edits, undo, and redo in two tab sizes', () => {
    const original = 'abc\t😀e\u0301xyz\t' + 'a'.repeat(1_048_576)
    const buffer = createEditorTextBuffer(original)
    const session = createEditorBufferSession(buffer)
    const views = [mountView(4), mountView(7)]
    for (const view of views) view.setText(original, buffer.getTextSnapshot())
    for (const offset of [32, 524_288, original.length - 64]) {
      for (const view of views) checkCaret(view, original, offset)
      const inserted = 'Z\t😀e\u0301'
      const change = session.applyEdits([{ from: offset, to: offset, text: inserted }])
      applyChange(views, change)
      const edited = original.slice(0, offset) + inserted + original.slice(offset)
      for (const view of views) checkCaret(view, edited, offset + inserted.length + 8)
      applyChange(views, session.undo())
      for (const view of views) checkCaret(view, original, offset + 8)
      applyChange(views, session.redo())
      for (const view of views) checkCaret(view, edited, offset + inserted.length + 8)
      applyChange(views, session.undo())
    }
    expect(buffer.getTextSnapshot().materializeFullText()).toBe(original)
  })

  it('refreshes line measurements after a split and join, then enables wrapping', () => {
    const text = 'ab\t'.repeat(2_000)
    const buffer = createEditorTextBuffer(text)
    const session = createEditorBufferSession(buffer)
    const view = mountView(7)
    view.setText(text, buffer.getTextSnapshot())
    checkCaret(view, text, 5_400)
    applyChange([view], session.applyEdits([{ from: 3_000, to: 3_000, text: '\n' }]))
    view.setScrollMetrics(0, 100, 360)
    const rows = view.getState().mountedRows
    expect(rows.map((row) => row.text)).toEqual([text.slice(0, 3_000), text.slice(3_000)])
    expect(rows[1]!.measurements!.columnAt(3_000, 7, 'utf16')).toBe(7_000)
    applyChange([view], session.undo())
    checkCaret(view, text, 5_400)
    view.setWrapEnabled(true)
    view.setScrollMetrics(0, 100, 360, 0)
    expect(view.getState().mountedRows.length).toBeGreaterThan(1)
    expect(view.getState().mountedRows.every((row) => row.text.length < 100)).toBe(true)
  })
})

function mountView(tabSize: number): VirtualizedTextView {
  const host = document.createElement('div')
  host.style.width = '360px'
  host.style.height = '100px'
  document.body.appendChild(host)
  const view = new VirtualizedTextView(host, {
    rowHeight: 20,
    tabSize,
    overscan: 0,
    longLineChunkSize: 512,
    longLineChunkThreshold: 1_024,
    horizontalOverscanColumns: 0,
  })
  mounted.push({ host, view })
  return view
}

function applyChange(views: readonly VirtualizedTextView[], change: DocumentSessionChange): void {
  expect(change.edits).toHaveLength(1)
  for (const view of views) view.applyEdit(change.edits[0]!, change.textSnapshot)
}

function checkCaret(view: VirtualizedTextView, text: string, offset: number): void {
  const internal = Reflect.get(view, 'view') as VirtualizedTextViewInternal
  const { characterWidth } = view.getState().metrics
  const column = estimatedDisplayCellForColumn(text, offset, internal.tabSize)
  view.setScrollMetrics(0, 100, 360, Math.max(0, (column - 12) * characterWidth))
  view.setSelection(offset, offset)
  const row = view.getState().mountedRows[0]!
  expect(row.text).toBe(text)
  expect(row.chunks.some((chunk) => chunk.startOffset <= offset && chunk.endOffset >= offset)).toBe(
    true,
  )
  const range = view.createRange(offset, offset)
  expect(range).not.toBeNull()
  const rect = range!.getBoundingClientRect()
  const drawn = rect.left - row.element.getBoundingClientRect().left
  expect(rect.height).toBeGreaterThan(0)
  expect(offsetToX(internal, row, offset)).toBeCloseTo(drawn, 0)
  expect(xToOffset(internal, row, drawn)).toBe(offset)
  expect(view.textOffsetFromDomBoundary(range!.startContainer, range!.startOffset)).toBe(offset)
}
