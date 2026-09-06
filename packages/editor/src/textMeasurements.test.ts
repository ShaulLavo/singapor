import { afterEach, describe, expect, it, vi } from 'vitest'
import { bufferColumnToVisualColumn, visualColumnToBufferColumn } from './displayTransforms'
import { createDocumentTextSnapshot, measureTextSnapshotRange } from './documentTextSnapshot'
import { createEditorBufferSession, createEditorTextBuffer } from './documentSession'
import { containsRTL, isSimpleRowText } from './textCharacters'
import {
  measureString,
  TextMeasurements,
  TextSourceIndex,
  type ColumnMode,
} from './textMeasurements'
import {
  estimatedColumnToBufferColumn,
  estimatedDisplayCellForColumn,
} from './virtualization/virtualizedTextViewGeometry'

const texts = [
  '',
  'abc\tdef\t',
  '\t\t\t',
  '😀e\u0301\t中\u0080x',
  '\ud800x\udc00',
  '𝄞\t\ufe0f\u200d',
  'שלום\tabc',
  'x'.repeat(255) + '𝄞\t' + 'a'.repeat(520),
  'x'.repeat(255) + '\u{1d185}\t\u{e0100}z',
]
const modes: readonly ColumnMode[] = ['utf16', 'estimated']
const biases = ['before', 'after', 'nearest'] as const

afterEach(() => vi.unstubAllGlobals())

describe('indexed text measurements', () => {
  it('matches scalar columns and inverse biases across tabs, controls, and Unicode', () => {
    for (const text of texts) checkMeasurements(text, measureString(text))
  })

  it('composes pairs across source pieces and preserves isolated surrogate slices', () => {
    const parts = ['x'.repeat(255) + '\ud834', '\udd1e\t\ud83d', '\ude00e\u0301\t\ud803', '\udd50z']
    const measured = new TextMeasurements(
      parts.map((text) => ({ source: new TextSourceIndex(text), start: 0, end: text.length })),
    )
    const text = parts.join('')
    checkMeasurements(text, measured)
    for (const [start, end] of [
      [255, 256],
      [256, 258],
      [254, 262],
      [259, 265],
    ]) {
      checkMeasurements(text.slice(start, end), measured.slice(start!, end!))
    }
  })

  it('shares unchanged source indexes across edits, views, undo, and divergent branches', () => {
    const indexedLengths: number[] = []
    vi.stubGlobal(
      '__EDITOR_PERFORMANCE_DIAGNOSTICS__',
      (event: { name: string; detail?: { length?: number } }) => {
        if (event.name === 'textMeasurements.index') indexedLengths.push(event.detail!.length!)
      },
    )
    const original = 'a'.repeat(1_048_576)
    const buffer = createEditorTextBuffer(original)
    const session = createEditorBufferSession(buffer)
    const first = measureTextSnapshotRange(buffer.getTextSnapshot(), 0, original.length)
    expect(first.columnAt(original.length, 4, 'utf16')).toBe(original.length)
    const source = buffer
      .getSnapshot()
      .buffers.textIndexes.get(buffer.getSnapshot().buffers.original)
    session.applyEdits([{ from: 0, to: 0, text: '😀\t' }])
    const changed = measureTextSnapshotRange(buffer.getTextSnapshot(), 0, original.length + 3)
    expect(measureTextSnapshotRange(buffer.getTextSnapshot(), 0, original.length + 3)).toBe(changed)
    expect(changed.columnAt(original.length + 3, 4, 'estimated')).toBe(original.length + 4)
    expect(
      buffer.getSnapshot().buffers.textIndexes.get(buffer.getSnapshot().buffers.original),
    ).toBe(source)
    session.undo()
    session.applyEdits([{ from: 0, to: 0, text: 'ab\t' }])
    const branched = measureTextSnapshotRange(buffer.getTextSnapshot(), 0, original.length + 3)
    expect(branched.isSimple).toBe(true)
    expect(changed.isSimple).toBe(false)
    expect(first.columnAt(original.length, 7, 'estimated')).toBe(original.length)
    expect(branched.columnAt(original.length + 3, 7, 'estimated')).toBe(original.length + 7)
    const restoredWrapper = createDocumentTextSnapshot(buffer.getSnapshot())
    expect(
      measureTextSnapshotRange(restoredWrapper, 0, original.length + 3).columnAt(3, 4, 'utf16'),
    ).toBe(4)
    expect(indexedLengths.filter((length) => length >= original.length)).toEqual([original.length])
  })

  it('bounds far-column character reads independently of line length', () => {
    const small = queryCharacterReads(1_024)
    const large = queryCharacterReads(131_072)
    expect(large).toBeLessThan(200_000)
    expect(large).toBeLessThan(small * 2 + 1_000)
  })

  it('keeps four active tab sizes without indexing a fifth size for classification', () => {
    const builds: number[] = []
    vi.stubGlobal(
      '__EDITOR_PERFORMANCE_DIAGNOSTICS__',
      (event: { name: string; detail?: { tabSize?: number } }) => {
        if (event.name === 'textMeasurements.index') builds.push(event.detail!.tabSize!)
      },
    )
    const text = 'ab\t'.repeat(10_000)
    const source = new TextSourceIndex(text)
    source.root(2)
    for (let revision = 0; revision < 3; revision += 1) {
      const measured = new TextMeasurements([{ source, start: 0, end: text.length }])
      expect(measured.isSimple).toBe(true)
      for (const tabSize of [2, 3, 5, 7]) measured.columnAt(text.length, tabSize, 'utf16')
    }
    source.root(9)
    source.root(3)
    expect(builds).toEqual([2, 3, 5, 7, 9])
  })
})

function queryCharacterReads(repetitions: number): number {
  const text = 'ab\t😀e\u0301中'.repeat(repetitions)
  const measured = measureString(text)
  measured.columnAt(text.length, 4, 'estimated')
  const charCodeAt = String.prototype.charCodeAt
  const codePointAt = String.prototype.codePointAt
  let reads = 0
  String.prototype.charCodeAt = function (index) {
    reads += 1
    return charCodeAt.call(this, index)
  }
  String.prototype.codePointAt = function (index) {
    reads += 1
    return codePointAt.call(this, index)
  }
  try {
    for (let sample = 0; sample < 64; sample += 1) {
      const offset = text.length - 1_024 + sample * 13
      const column = measured.columnAt(offset, 4, 'estimated')
      measured.offsetAt(column, 'nearest', 4, 'estimated')
    }
  } finally {
    String.prototype.charCodeAt = charCodeAt
    String.prototype.codePointAt = codePointAt
  }
  return reads
}

function checkMeasurements(text: string, measured: TextMeasurements): void {
  expect(measured.isSimple).toBe(isSimpleRowText(text))
  expect(measured.containsRTL).toBe(containsRTL(text))
  expect(measured.hasTabs).toBe(text.includes('\t'))
  for (const tabSize of [1, 2, 4, 7]) checkTabSize(text, measured, tabSize)
}

function checkTabSize(text: string, measured: TextMeasurements, tabSize: number): void {
  for (const mode of modes) checkMode(text, measured, tabSize, mode)
}

function checkMode(
  text: string,
  measured: TextMeasurements,
  tabSize: number,
  mode: ColumnMode,
): void {
  const forward = mode === 'utf16' ? bufferColumnToVisualColumn : estimatedDisplayCellForColumn
  const inverse = mode === 'utf16' ? visualColumnToBufferColumn : estimatedColumnToBufferColumn
  for (let offset = 0; offset <= text.length; offset += 1) {
    expect(
      measured.columnAt(offset, tabSize, mode),
      `${mode} offset ${offset} tab ${tabSize}`,
    ).toBe(forward(text, offset, tabSize))
  }
  const width = forward(text, text.length, tabSize)
  for (let column = 0; column <= width + 1; column += 0.5) {
    for (const bias of biases)
      expect(
        measured.offsetAt(column, bias, tabSize, mode),
        `${mode} column ${column} ${bias} tab ${tabSize}`,
      ).toBe(inverse(text, column, bias, tabSize))
  }
}
