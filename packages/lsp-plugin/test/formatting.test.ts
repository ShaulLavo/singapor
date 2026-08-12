import { describe, expect, it } from 'vitest'

import { formattingChangesText, formattingEdits, formattingOptions } from '../src/formatting'

const edit = (startLine: number, startChar: number, endLine: number, endChar: number, newText: string) => ({
  newText,
  range: {
    end: { character: endChar, line: endLine },
    start: { character: startChar, line: startLine },
  },
})

describe('formattingEdits', () => {
  it('converts positions to offsets', () => {
    const result = formattingEdits('const a=1', [edit(0, 7, 0, 8, ' = ')])

    expect(result).toEqual([{ from: 7, text: ' = ', to: 8 }])
  })

  it('has nothing to do for an empty or absent result', () => {
    expect(formattingEdits('a', [])).toEqual([])
    expect(formattingEdits('a', null)).toEqual([])
  })

  // The batch applicator rejects overlaps outright, so a formatter returning a whole-document edit
  // alongside a nested one must not be handed both.
  it('drops an edit nested inside another', () => {
    const result = formattingEdits('abcdef', [edit(0, 0, 0, 6, 'XYZ'), edit(0, 2, 0, 3, 'q')])

    expect(result).toEqual([{ from: 0, text: 'XYZ', to: 6 }])
  })

  it('returns edits in descending order so they apply without shifting each other', () => {
    const result = formattingEdits('ab\ncd', [edit(0, 0, 0, 1, 'A'), edit(1, 0, 1, 1, 'C')])

    expect(result.map((entry) => entry.from)).toEqual([3, 0])
  })

  it('keeps adjacent edits that merely touch', () => {
    const result = formattingEdits('abcd', [edit(0, 0, 0, 2, 'X'), edit(0, 2, 0, 4, 'Y')])

    expect(result).toHaveLength(2)
  })
})

describe('formattingChangesText', () => {
  it('is false when every edit rewrites text to what it already is', () => {
    expect(formattingChangesText('a = 1', [{ from: 0, text: 'a', to: 1 }])).toBe(false)
  })

  it('is true when any edit changes something', () => {
    expect(formattingChangesText('a=1', [{ from: 1, text: ' = ', to: 2 }])).toBe(true)
  })
})

describe('formattingOptions', () => {
  it('passes the editor tab size through', () => {
    expect(formattingOptions(4)).toEqual({ insertSpaces: true, tabSize: 4 })
  })

  it('never asks for a zero-width tab', () => {
    expect(formattingOptions(0).tabSize).toBe(1)
  })
})
