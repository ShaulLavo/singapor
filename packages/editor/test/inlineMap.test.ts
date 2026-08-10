import { describe, expect, it } from 'vitest'

import {
  applyBatchToPieceTable,
  createPieceTableSnapshot,
  deleteFromPieceTable,
  insertIntoPieceTable,
} from '../src/public/document'
import {
  bufferPointToInlinePoint,
  createInlineMap,
  type InlineReplacementSpec,
  inlinePointToBufferPoint,
  inlineReplacementsForBufferRow,
  inlineRowForBufferRow,
  revealInlineMap,
  updateInlineMapForEdit,
} from '../src/inlineMap'

const BOLD_LINE = 'a **bold** b\n'

const boldSpecs = (): InlineReplacementSpec[] => [
  { id: 'open', startIndex: 2, endIndex: 4, text: '', kind: 'marker', groupId: 'bold' },
  { id: 'close', startIndex: 8, endIndex: 10, text: '', kind: 'marker', groupId: 'bold' },
]

describe('InlineMap', () => {
  it('anchors specs to single-line source spans', () => {
    const snapshot = createPieceTableSnapshot(BOLD_LINE)
    const map = createInlineMap(snapshot, boldSpecs())

    expect(map.ranges.map((range) => [range.id, range.startOffset, range.endOffset])).toEqual([
      ['open', 2, 4],
      ['close', 8, 10],
    ])
    expect(map.ranges[0]!.startPoint).toEqual({ row: 0, column: 2 })
    expect(map.ranges[0]!.endPoint).toEqual({ row: 0, column: 4 })
  })

  it('projects a row into display text with the markers hidden', () => {
    const snapshot = createPieceTableSnapshot(BOLD_LINE)
    const map = createInlineMap(snapshot, boldSpecs())
    const row = inlineRowForBufferRow(map, 0, 'a **bold** b')

    expect(row.text).toBe('a bold b')
  })

  it('drops specs that span more than one line', () => {
    const snapshot = createPieceTableSnapshot('one\ntwo\n')
    const map = createInlineMap(snapshot, [
      { id: 'across', startIndex: 2, endIndex: 6, text: '' },
      { id: 'inline', startIndex: 0, endIndex: 2, text: '' },
    ])

    expect(map.ranges.map((range) => range.id)).toEqual(['inline'])
  })

  it('drops replacements nested inside an earlier replacement', () => {
    const snapshot = createPieceTableSnapshot('abcdef\n')
    const map = createInlineMap(snapshot, [
      { id: 'outer', startIndex: 0, endIndex: 6, text: 'X' },
      { id: 'inner', startIndex: 2, endIndex: 4, text: 'Y' },
    ])

    expect(map.ranges.map((range) => range.id)).toEqual(['outer'])
  })

  it('indexes replacements by their buffer row', () => {
    const snapshot = createPieceTableSnapshot('a **b** c\nplain\n# head\n')
    const map = createInlineMap(snapshot, [
      { id: 'open', startIndex: 2, endIndex: 4, text: '' },
      { id: 'close', startIndex: 5, endIndex: 7, text: '' },
      { id: 'hash', startIndex: 16, endIndex: 18, text: '' },
    ])

    expect(inlineReplacementsForBufferRow(map, 0).map((item) => item.id)).toEqual(['open', 'close'])
    expect(inlineReplacementsForBufferRow(map, 1)).toEqual([])
    expect(inlineReplacementsForBufferRow(map, 2).map((item) => item.id)).toEqual(['hash'])
  })
})

describe('InlineMap anchoring', () => {
  it('shifts replacements for edits earlier in the line', () => {
    const snapshot = createPieceTableSnapshot(BOLD_LINE)
    const map = createInlineMap(snapshot, boldSpecs())
    const next = insertIntoPieceTable(snapshot, 0, 'xx')
    const updated = updateInlineMapForEdit(map, { from: 0, to: 0, text: 'xx' }, next)

    expect(updated.map.ranges.map((range) => [range.startOffset, range.endOffset])).toEqual([
      [4, 6],
      [10, 12],
    ])
  })

  it('keeps text typed at a marker edge outside the marker', () => {
    const snapshot = createPieceTableSnapshot(BOLD_LINE)
    const map = createInlineMap(snapshot, boldSpecs())

    const beforeOpen = insertIntoPieceTable(snapshot, 2, 'z')
    const afterOpenEdit = updateInlineMapForEdit(map, { from: 2, to: 2, text: 'z' }, beforeOpen)
    expect(afterOpenEdit.map.ranges[0]!.startOffset).toBe(3)

    const afterClose = insertIntoPieceTable(snapshot, 10, 'z')
    const afterCloseEdit = updateInlineMapForEdit(map, { from: 10, to: 10, text: 'z' }, afterClose)
    expect(afterCloseEdit.map.ranges[1]!.endOffset).toBe(10)
  })

  it('drops a replacement whose source span is deleted', () => {
    const snapshot = createPieceTableSnapshot(BOLD_LINE)
    const map = createInlineMap(snapshot, boldSpecs())
    const next = deleteFromPieceTable(snapshot, 2, 2)
    const updated = updateInlineMapForEdit(map, { from: 2, to: 4, text: '' }, next)

    expect(updated.map.ranges.map((range) => range.id)).toEqual(['close'])
    expect(updated.invalidations.map((item) => item.reason)).toContain('replacement-dropped')
  })
})

describe('InlineMap invalidation', () => {
  it('absorbs edits made wholly inside a hidden span', () => {
    const snapshot = createPieceTableSnapshot('a ***bold*** b\n')
    const map = createInlineMap(snapshot, [
      { id: 'open', startIndex: 2, endIndex: 5, text: '' },
      { id: 'close', startIndex: 9, endIndex: 12, text: '' },
    ])
    const next = insertIntoPieceTable(snapshot, 3, '*')
    const updated = updateInlineMapForEdit(map, { from: 3, to: 3, text: '*' }, next)

    expect(updated.invalidations).toEqual([])
  })

  it('reports a row-granular external edit outside every replacement', () => {
    const snapshot = createPieceTableSnapshot('a **b** c\nsecond\n')
    const map = createInlineMap(snapshot, [{ id: 'open', startIndex: 2, endIndex: 4, text: '' }])
    const next = insertIntoPieceTable(snapshot, 12, 'x')
    const updated = updateInlineMapForEdit(map, { from: 12, to: 12, text: 'x' }, next)

    expect(updated.invalidations).toEqual([
      {
        start: { row: 1, column: 0 },
        end: { row: 2, column: 0 },
        lineCountDelta: 0,
        reason: 'external-edit',
      },
    ])
  })

  it('carries the row delta of a newline insertion', () => {
    const snapshot = createPieceTableSnapshot('a **b** c\n')
    const map = createInlineMap(snapshot, [{ id: 'open', startIndex: 2, endIndex: 4, text: '' }])
    const next = insertIntoPieceTable(snapshot, 9, '\nmore')
    const updated = updateInlineMapForEdit(map, { from: 9, to: 9, text: '\nmore' }, next)

    expect(updated.invalidations.at(-1)?.lineCountDelta).toBe(1)
  })

  it('never reports a row delta for its own replacement invalidations', () => {
    const snapshot = createPieceTableSnapshot(BOLD_LINE)
    const map = createInlineMap(snapshot, boldSpecs())
    const next = applyBatchToPieceTable(snapshot, [{ from: 4, to: 8, text: 'STRONG' }])
    const updated = updateInlineMapForEdit(map, { from: 4, to: 8, text: 'STRONG' }, next)

    for (const invalidation of updated.invalidations) {
      if (invalidation.reason === 'external-edit') continue
      expect(invalidation.lineCountDelta).toBe(0)
    }
  })
})

describe('InlineMap reveal', () => {
  it('reveals every replacement in a touched group', () => {
    const snapshot = createPieceTableSnapshot(BOLD_LINE)
    const map = createInlineMap(snapshot, boldSpecs())
    const revealed = revealInlineMap(map, [{ start: 5, end: 5 }])

    expect(revealed.ranges).toEqual([])
    expect(inlineRowForBufferRow(revealed, 0, 'a **bold** b').text).toBe('a **bold** b')
  })

  it('leaves untouched constructs hidden', () => {
    const snapshot = createPieceTableSnapshot('a **b** and _i_ c\n')
    const map = createInlineMap(snapshot, [
      { id: 'bold-open', startIndex: 2, endIndex: 4, text: '', groupId: 'bold' },
      { id: 'bold-close', startIndex: 5, endIndex: 7, text: '', groupId: 'bold' },
      { id: 'em-open', startIndex: 12, endIndex: 13, text: '', groupId: 'em' },
      { id: 'em-close', startIndex: 14, endIndex: 15, text: '', groupId: 'em' },
    ])
    const revealed = revealInlineMap(map, [{ start: 6, end: 6 }])

    expect(revealed.ranges.map((range) => range.id)).toEqual(['em-open', 'em-close'])
  })

  it('reveals a construct when the caret sits on either edge', () => {
    const snapshot = createPieceTableSnapshot(BOLD_LINE)
    const map = createInlineMap(snapshot, boldSpecs())

    expect(revealInlineMap(map, [{ start: 2, end: 2 }]).ranges).toEqual([])
    expect(revealInlineMap(map, [{ start: 10, end: 10 }]).ranges).toEqual([])
    expect(revealInlineMap(map, [{ start: 12, end: 12 }]).ranges).toHaveLength(2)
  })
})

describe('InlinePoint conversion', () => {
  it('collapses both sides of a hidden marker onto one display column', () => {
    const snapshot = createPieceTableSnapshot(BOLD_LINE)
    const map = createInlineMap(snapshot, boldSpecs())
    const row = inlineRowForBufferRow(map, 0, 'a **bold** b')

    expect(bufferPointToInlinePoint(row, { row: 0, column: 2 })).toEqual({ row: 0, column: 2 })
    expect(bufferPointToInlinePoint(row, { row: 0, column: 4 })).toEqual({ row: 0, column: 2 })
    expect(bufferPointToInlinePoint(row, { row: 0, column: 8 })).toEqual({ row: 0, column: 6 })
    expect(bufferPointToInlinePoint(row, { row: 0, column: 10 })).toEqual({ row: 0, column: 6 })
  })

  it('resolves an ambiguous display column by motion bias', () => {
    const snapshot = createPieceTableSnapshot(BOLD_LINE)
    const map = createInlineMap(snapshot, boldSpecs())
    const row = inlineRowForBufferRow(map, 0, 'a **bold** b')
    const atOpenMarker = { row: 0, column: 2 } as never

    expect(inlinePointToBufferPoint(row, atOpenMarker, 'before')).toEqual({ row: 0, column: 2 })
    expect(inlinePointToBufferPoint(row, atOpenMarker, 'after')).toEqual({ row: 0, column: 4 })
    expect(inlinePointToBufferPoint(row, atOpenMarker)).toEqual({ row: 0, column: 2 })
  })

  it('round-trips display columns through source space', () => {
    const snapshot = createPieceTableSnapshot(BOLD_LINE)
    const map = createInlineMap(snapshot, boldSpecs())
    const row = inlineRowForBufferRow(map, 0, 'a **bold** b')

    for (let column = 0; column <= row.text.length; column += 1) {
      const point = { row: 0, column } as never
      const source = inlinePointToBufferPoint(row, point)
      expect(bufferPointToInlinePoint(row, source)).toEqual({ row: 0, column })
    }
  })

  it('leaves the row untouched because the layer only rewrites columns', () => {
    const snapshot = createPieceTableSnapshot(`x\n${BOLD_LINE}`)
    const map = createInlineMap(snapshot, [
      { id: 'open', startIndex: 4, endIndex: 6, text: '' },
      { id: 'close', startIndex: 10, endIndex: 12, text: '' },
    ])
    const row = inlineRowForBufferRow(map, 1, 'a **bold** b')

    expect(bufferPointToInlinePoint(row, { row: 1, column: 6 }).row).toBe(1)
  })
})
