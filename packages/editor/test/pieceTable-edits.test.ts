import { describe, expect, it } from 'vitest'

import {
  applyBatchToPieceTable,
  deleteFromPieceTable,
  insertIntoPieceTable,
  snapBatchEditRanges,
} from '../src/pieceTable/edits.ts'
import { createPieceTableSnapshot } from '../src/pieceTable/pieceTable.ts'
import { materializePieceTableFullText } from '../src/pieceTable/reads.ts'

describe('piece table edits', () => {
  it('inserts and deletes text while preserving the original snapshot', () => {
    const initial = createPieceTableSnapshot('hello')
    const inserted = insertIntoPieceTable(initial, 5, ' world')
    const deleted = deleteFromPieceTable(inserted, 5, 1)

    expect(materializePieceTableFullText(initial)).toBe('hello')
    expect(materializePieceTableFullText(inserted)).toBe('hello world')
    expect(materializePieceTableFullText(deleted)).toBe('helloworld')
  })

  it('returns the same snapshot for no-op edits', () => {
    const snapshot = createPieceTableSnapshot('abc')

    expect(insertIntoPieceTable(snapshot, 1, '')).toBe(snapshot)
    expect(deleteFromPieceTable(snapshot, 1, 0)).toBe(snapshot)
    expect(applyBatchToPieceTable(snapshot, [])).toBe(snapshot)
  })

  it('applies non-overlapping batch edits against the original text', () => {
    const snapshot = createPieceTableSnapshot('abcdef')
    const edited = applyBatchToPieceTable(snapshot, [
      { from: 1, to: 3, text: 'XX' },
      { from: 4, to: 6, text: 'Y' },
    ])

    expect(materializePieceTableFullText(edited)).toBe('aXXdY')
    expect(materializePieceTableFullText(snapshot)).toBe('abcdef')
  })

  it('rejects invalid or overlapping ranges', () => {
    const snapshot = createPieceTableSnapshot('abc')

    expect(() => insertIntoPieceTable(snapshot, 4, 'x')).toThrow(RangeError)
    expect(() => deleteFromPieceTable(snapshot, 1, 4)).toThrow(RangeError)
    expect(() =>
      applyBatchToPieceTable(snapshot, [
        { from: 0, to: 2, text: 'x' },
        { from: 1, to: 3, text: 'y' },
      ]),
    ).toThrow(RangeError)
  })
})

// 'a😀b' is 'a', high surrogate, low surrogate, 'b' — offset 2 splits the pair.
const EMOJI_TEXT = 'a\u{1F600}b'

const hasLoneSurrogate = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xdc00 && code <= 0xdfff) return true
    if (code < 0xd800 || code > 0xdbff) continue

    const next = text.charCodeAt(index + 1)
    if (!(next >= 0xdc00 && next <= 0xdfff)) return true
    index += 1
  }

  return false
}

describe('piece table surrogate pair snapping', () => {
  it('expands a non-empty range outward to swallow a split code point', () => {
    const snapshot = createPieceTableSnapshot(EMOJI_TEXT)

    expect(
      materializePieceTableFullText(
        applyBatchToPieceTable(snapshot, [{ from: 0, to: 2, text: 'X' }]),
      ),
    ).toBe('Xb')
    expect(
      materializePieceTableFullText(
        applyBatchToPieceTable(snapshot, [{ from: 2, to: 4, text: 'Y' }]),
      ),
    ).toBe('aY')
    expect(materializePieceTableFullText(deleteFromPieceTable(snapshot, 1, 1))).toBe('ab')
  })

  it('expands both ends when a range splits two different pairs', () => {
    const snapshot = createPieceTableSnapshot('a\u{1F600}\u{1F600}b')
    const edited = applyBatchToPieceTable(snapshot, [{ from: 2, to: 4, text: '-' }])

    expect(materializePieceTableFullText(edited)).toBe('a-b')
  })

  it('moves a collapsed range left instead of expanding it into a selection', () => {
    const snapshot = createPieceTableSnapshot(EMOJI_TEXT)

    expect(materializePieceTableFullText(insertIntoPieceTable(snapshot, 2, 'X'))).toBe(
      'aX\u{1F600}b',
    )
    expect(
      materializePieceTableFullText(
        applyBatchToPieceTable(snapshot, [{ from: 2, to: 2, text: 'X' }]),
      ),
    ).toBe('aX\u{1F600}b')
  })

  it('leaves an edit alone when its replacement completes the pair it splits', () => {
    // What syncTextEdit produces for one emoji swapped for another: it diffs by
    // code unit, so only the low half differs. Widening this to swallow the
    // high half would delete the character the caller was building.
    const snapshot = createPieceTableSnapshot(EMOJI_TEXT)
    const edited = applyBatchToPieceTable(snapshot, [{ from: 2, to: 3, text: '\uDE01' }])

    expect(materializePieceTableFullText(edited)).toBe('a\u{1F601}b')
    expect(snapBatchEditRanges(snapshot, [{ from: 2, to: 3, text: '\uDE01' }])).toEqual([
      { from: 2, to: 3, text: '\uDE01' },
    ])
  })

  it('applies adjacent edits that between them consume a whole pair', () => {
    // Neither edit orphans anything: the half each one leaves is removed by its
    // neighbour. Snapping them apart would make them overlap, and the batch
    // would fail out of an ordinary multi-cursor replace.
    const snapshot = createPieceTableSnapshot(EMOJI_TEXT)
    const edits = [
      { from: 0, to: 2, text: 'A' },
      { from: 2, to: 4, text: 'B' },
    ]

    expect(materializePieceTableFullText(applyBatchToPieceTable(snapshot, edits))).toBe('AB')
    expect(snapBatchEditRanges(snapshot, edits)).toEqual(edits)
  })

  it('reports the ranges it applied, not the ranges it was handed', () => {
    const snapshot = createPieceTableSnapshot(EMOJI_TEXT)
    const applied = snapBatchEditRanges(snapshot, [{ from: 1, to: 2, text: 'X' }])

    expect(applied).toEqual([{ from: 1, to: 3, text: 'X' }])
    // Idempotent, so a caller may report these and still apply them.
    expect(snapBatchEditRanges(snapshot, applied)).toEqual(applied)
  })

  it('still rejects a batch that overlapped before snapping', () => {
    const snapshot = createPieceTableSnapshot('abcdef')

    expect(() =>
      applyBatchToPieceTable(snapshot, [
        { from: 0, to: 3, text: 'X' },
        { from: 2, to: 5, text: 'Y' },
      ]),
    ).toThrow(RangeError)
  })

  it('leaves no lone surrogate behind on any edit path', () => {
    const snapshot = createPieceTableSnapshot('a\u{1F600}b\u{1F600}')

    for (let from = 0; from <= snapshot.length; from += 1) {
      expect(
        hasLoneSurrogate(materializePieceTableFullText(insertIntoPieceTable(snapshot, from, 'x'))),
      ).toBe(false)

      for (let to = from; to <= snapshot.length; to += 1) {
        const batched = applyBatchToPieceTable(snapshot, [{ from, to, text: 'x' }])
        const text = materializePieceTableFullText(batched)
        expect(hasLoneSurrogate(text)).toBe(false)

        // The reported range has to describe that same text, or every consumer
        // of the change is patching a document it does not have.
        const source = materializePieceTableFullText(snapshot)
        const applied = snapBatchEditRanges(snapshot, [{ from, to, text: 'x' }])
        expect(
          applied.reduce(
            (result, edit) => result.slice(0, edit.from) + edit.text + result.slice(edit.to),
            source,
          ),
        ).toBe(text)

        const deleted = deleteFromPieceTable(snapshot, from, to - from)
        expect(hasLoneSurrogate(materializePieceTableFullText(deleted))).toBe(false)
      }
    }
  })
})
