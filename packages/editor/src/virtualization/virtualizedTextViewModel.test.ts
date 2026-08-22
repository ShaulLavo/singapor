import { describe, expect, test } from 'vitest'
import type { DisplayRow } from '../displayTransforms'
import type { TextSnapshot } from '../documentTextSnapshot'
import { createFoldMap } from '../foldMap'
import { createPieceTableSnapshot } from '../pieceTable'
import type { FoldRange } from '../syntax/session'
import { createVirtualizedTextViewModel } from './virtualizedTextViewModel'

describe('virtualized text view model', () => {
  test('builds deterministic rows from range reads', () => {
    const text = 'alpha\nbravo\ncharlie'
    const snapshot = createRangeOnlySnapshot(text)
    const input = {
      textSnapshot: snapshot,
      lineStarts: computeLineStarts(text),
      foldMap: null,
      inlineMap: null,
      injectedTextRows: [
        {
          id: 'hint',
          anchorBufferRow: 0,
          placement: 'before',
          text: 'hint',
        },
      ],
      wrapColumn: 4,
      tabSize: 4,
    } as const

    const first = createVirtualizedTextViewModel(input)
    const second = createVirtualizedTextViewModel(input)

    expect(rowSummaries(first.rows)).toEqual(rowSummaries(second.rows))
    expect(rowSummaries(first.rows)).toEqual([
      'text:injected:hint:0:0',
      'text:document:alph:0:0',
      'text:document:a:0:1',
      'text:document:brav:1:0',
      'text:document:o:1:1',
      'text:document:char:2:0',
      'text:document:lie:2:1',
    ])
    expect(snapshot.rangeReads()).toBeGreaterThan(0)
  })

  test('applies folds while preserving snapshot identity on the model', () => {
    const text = 'one\ntwo\nthree\nfour'
    const lineStarts = computeLineStarts(text)
    const pieceSnapshot = createPieceTableSnapshot(text)
    const foldMap = createFoldMap(pieceSnapshot, [foldRange(text, lineStarts, 1, 2)])
    const textSnapshot = createRangeOnlySnapshot(text)

    const model = createVirtualizedTextViewModel({
      textSnapshot,
      lineStarts,
      foldMap,
      inlineMap: null,
      injectedTextRows: [],
      wrapColumn: null,
      tabSize: 4,
    })

    expect(model.textSnapshot).toBe(textSnapshot)
    expect(model.foldMap).toBe(foldMap)
    expect(model.visibleLineCount).toBe(3)
    expect(rowSummaries(model.rows)).toEqual([
      'text:document:one:0:0',
      'text:document:two:1:0',
      'text:document:four:3:0',
    ])
  })
})

type RangeOnlySnapshot = TextSnapshot & {
  readonly rangeReads: () => number
}

function createRangeOnlySnapshot(text: string): RangeOnlySnapshot {
  let rangeReads = 0
  return {
    length: text.length,
    readRange: (start, end) => {
      rangeReads += 1
      return text.slice(start, end)
    },
    materializeFullText: () => {
      throw new Error('view model must not materialize full text')
    },
    forEachTextChunk: (visit) => {
      if (text.length === 0) return
      visit(text, 0, text.length)
    },
    rangeReads: () => rangeReads,
  }
}

function computeLineStarts(text: string): readonly number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue
    starts.push(index + 1)
  }
  return starts
}

function foldRange(
  text: string,
  lineStarts: readonly number[],
  startLine: number,
  endLine: number,
): FoldRange {
  return {
    startIndex: lineStartOffset(text, lineStarts, startLine),
    endIndex: lineEndOffset(text, lineStarts, endLine),
    startLine,
    endLine,
    type: 'test',
  }
}

function lineStartOffset(text: string, lineStarts: readonly number[], row: number): number {
  return lineStarts[row] ?? text.length
}

function lineEndOffset(text: string, lineStarts: readonly number[], row: number): number {
  const nextLineStart = lineStarts[row + 1]
  if (nextLineStart === undefined) return text.length
  return Math.max(lineStartOffset(text, lineStarts, row), nextLineStart - 1)
}

function rowSummaries(rows: readonly DisplayRow[]): readonly string[] {
  return rows.map(rowSummary)
}

function rowSummary(row: DisplayRow): string {
  return `text:${row.source}:${row.text}:${row.bufferRow}:${row.wrapSegment}`
}
