import { describe, expect, it } from 'vitest'
import { createStringTextSnapshot } from '@singapor/core/document'
import type { EditorViewSnapshot } from '@singapor/core/extensions'
import {
  createEditorSecondaryViewProjection,
  EditorSecondaryTextView,
  EditorSecondaryViewScheduler,
} from '@singapor/core/secondary-views'

describe('secondary view projections', () => {
  it('projects snapshot-owned view data without reading lazy fullText when a text snapshot exists', () => {
    const sourceText = 'alpha\nbeta'
    const snapshot = editorViewSnapshot(sourceText)

    Object.defineProperty(snapshot, 'fullText', {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error('fullText should not be read')
      },
    })

    const projection = createEditorSecondaryViewProjection(snapshot)

    expect(projection.documentId).toBe('secondary-test')
    expect(projection.textVersion).toBe(7)
    expect(projection.text.length).toBe(sourceText.length)
    expect(projection.text.lineStarts).toEqual([0, 6])
    expect(projection.text.materializeFullText()).toBe(sourceText)
    expect(projection.syntaxColors.tokens).toEqual([
      { start: 0, end: 5, style: { color: '#ff0000' } },
    ])
    expect(projection.selections).toEqual([
      { anchorOffset: 1, headOffset: 3, startOffset: 1, endOffset: 3 },
    ])
    expect(projection.foldSummaries).toEqual([
      {
        key: 'fold:1',
        startOffset: 0,
        endOffset: sourceText.length,
        startLineNumber: 1,
        endLineNumber: 2,
        collapsed: true,
      },
    ])
    expect(projection.visibleLineModel.rows.map((row) => row.text)).toEqual(['alpha'])
  })

  it('exposes the secondary text view and scheduler entry points', () => {
    expect(EditorSecondaryTextView).toBeTypeOf('function')
    expect(EditorSecondaryViewScheduler).toBeTypeOf('function')
  })
})

function editorViewSnapshot(text: string): EditorViewSnapshot {
  return {
    documentId: 'secondary-test',
    languageId: 'typescript',
    textSnapshot: createStringTextSnapshot(text),
    fullText: text,
    textVersion: 7,
    lineStarts: [0, 6],
    tokens: [{ start: 0, end: 5, style: { color: '#ff0000' } }],
    selections: [{ anchorOffset: 1, headOffset: 3, startOffset: 1, endOffset: 3 }],
    metrics: { rowHeight: 20, characterWidth: 8 },
    lineCount: 2,
    contentWidth: 80,
    totalHeight: 40,
    tabSize: 4,
    foldMarkers: [
      {
        key: 'fold:1',
        startOffset: 0,
        endOffset: text.length,
        startRow: 0,
        endRow: 1,
        collapsed: true,
      },
    ],
    visibleRows: [
      {
        index: 0,
        bufferRow: 0,
        source: 'document',
        startOffset: 0,
        endOffset: 5,
        text: 'alpha',
        kind: 'text',
        primaryText: true,
        top: 0,
        height: 20,
      },
    ],
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 40,
      scrollWidth: 80,
      clientHeight: 20,
      clientWidth: 80,
      borderBoxHeight: 20,
      borderBoxWidth: 80,
      visibleRange: { start: 0, end: 1 },
    },
  }
}
