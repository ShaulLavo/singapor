import { describe, expect, it } from 'vitest'
import type { EditorGutterWidthContext } from '@singapor/core/extensions'
import {
  createDiffGutterContribution,
  diffGutterIndicatorText,
  diffGutterNumberText,
} from '../src/gutters'
import type { DiffRenderRow } from '../src'

describe('diff gutters', () => {
  it('reserves separate gutters for stacked old/new line numbers', () => {
    const contribution = createDiffGutterContribution('stacked', () => [
      lineRow({ oldLineNumber: 999, newLineNumber: 1001 }),
    ])

    expect(contribution.width(widthContext())).toBe(80)
  })

  it('formats stacked old/new line numbers as separate lane labels', () => {
    const row = lineRow({ oldLineNumber: 193, newLineNumber: 194 })

    expect(diffGutterNumberText(row, 'old')).toBe('193')
    expect(diffGutterNumberText(row, 'new')).toBe('194')
  })

  it('formats change markers as separate indicator labels', () => {
    expect(diffGutterIndicatorText(lineRow({ newLineNumber: 194 }, 'addition'))).toBe('+')
    expect(diffGutterIndicatorText(lineRow({ oldLineNumber: 193 }, 'deletion'))).toBe('-')
  })

  it('reserves width from sparse source line numbers', () => {
    const contribution = createDiffGutterContribution('new', () => [
      lineRow({ newLineNumber: 12345 }),
    ])

    expect(contribution.width(widthContext())).toBe(58)
  })
})

function lineRow(
  lineNumbers: Pick<DiffRenderRow, 'oldLineNumber' | 'newLineNumber'>,
  type: DiffRenderRow['type'] = 'context',
): DiffRenderRow {
  return {
    type,
    text: 'content',
    ...lineNumbers,
  }
}

function widthContext(): EditorGutterWidthContext {
  return {
    lineCount: 1,
    metrics: {
      characterWidth: 8,
      rowHeight: 20,
    },
  }
}
