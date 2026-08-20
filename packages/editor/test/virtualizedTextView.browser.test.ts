import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../src/style.css'
import {
  createFoldGutterContribution,
  createLineGutterContribution,
} from '../../gutters/src/index.ts'

import { VirtualizedTextView } from '../src/virtualization'
import { projectTokensThroughEdit } from '../src/editor/tokenProjection'
import type { EditorToken } from '../src/public/syntax'

describe.skipIf(typeof globalThis.Highlight === 'undefined')(
  'VirtualizedTextView native browser geometry',
  () => {
    let container: HTMLElement
    let view: VirtualizedTextView | null

    beforeEach(() => {
      container = document.createElement('div')
      container.style.height = '120px'
      container.style.width = '360px'
      document.body.appendChild(container)
      view = new VirtualizedTextView(container, { rowHeight: 20, overscan: 0 })
    })

    afterEach(() => {
      view?.dispose()
      container.remove()
      view = null
    })

    it('keeps caret, selection, and hit testing inside mounted rows', () => {
      view!.setHiddenCharacters('show')
      view!.setText('abcdef\nsecond')
      view!.setScrollMetrics(0, 40)

      const row = view!.getState().mountedRows[0]
      const chunk = row?.chunks[0]
      expect(chunk).toBeDefined()

      const selection = document.createRange()
      selection.setStart(chunk!.textNode, 1)
      selection.setEnd(chunk!.textNode, 4)
      expect(selection.getClientRects().length).toBeGreaterThan(0)

      const rowRect = row!.element.getBoundingClientRect()
      const offset = view!.textOffsetFromPoint(rowRect.left + 4, rowRect.top + 10)
      expect(offset).not.toBeNull()

      const validation = view!.validateMountedNativeGeometry()
      expect(validation.failures).toEqual([])
      expect(validation.caretChecks).toBeGreaterThan(0)
      expect(validation.selectionChecks).toBeGreaterThan(0)
    })

    it('paints decoded-binary-like controls without native caret hit-testing', () => {
      view!.setText('\u0000PNG\u0000\uFFFD')
      view!.setScrollMetrics(0, 20)
      view!.setSelection(0, 6)

      const row = view!.getState().mountedRows[0]!
      const selection = container.querySelector<HTMLElement>('.editor-virtualized-selection-range')
      const rowRect = row.element.getBoundingClientRect()

      expect(view!.scrollElement.textContent).toContain('\u2400PNG\u2400\uFFFD')
      expect(selection).not.toBeNull()
      expect(Number.parseFloat(selection!.style.width)).toBeGreaterThan(0)

      withThrowingNativeCaretApis(document, () => {
        expect(view!.textOffsetFromPoint(rowRect.left + 8, rowRect.top + 10)).not.toBeNull()
      })
    })

    it('sets deterministic gutter CSS variables without marker measurement', () => {
      view?.dispose()
      view = new VirtualizedTextView(container, {
        rowHeight: 20,
        overscan: 0,
        gutterContributions: [createLineGutterContribution(), createFoldGutterContribution()],
      })
      view!.setText(Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join('\n'))
      view!.setScrollMetrics(9_999 * 20, 20, 360)

      expect(view!.scrollElement.style.getPropertyValue('--editor-gutter-label-columns')).toBe('')
      expect(view!.scrollElement.style.getPropertyValue('--editor-gutter-width')).toMatch(/px$/)
    })

    it('uses the editor font for line gutter labels by default', () => {
      view?.dispose()
      view = new VirtualizedTextView(container, {
        rowHeight: 20,
        overscan: 0,
        gutterContributions: [createLineGutterContribution()],
      })
      view!.setText('first\nsecond')
      view!.setScrollMetrics(0, 40, 360)

      const label = container.querySelector<HTMLElement>('.editor-virtualized-gutter-label')
      expect(label).not.toBeNull()

      const editorStyle = getComputedStyle(view!.scrollElement)
      const labelStyle = getComputedStyle(label!)
      expect(labelStyle.fontFamily).toBe(editorStyle.fontFamily)
      expect(labelStyle.fontSize).toBe(editorStyle.fontSize)
      expect(labelStyle.fontWeight).toBe(editorStyle.fontWeight)
    })

    it('keeps fold gutter cursor-line backgrounds above fold button base styles', () => {
      view?.dispose()
      view = new VirtualizedTextView(container, {
        rowHeight: 20,
        overscan: 0,
        gutterContributions: [createLineGutterContribution(), createFoldGutterContribution()],
        cursorLineHighlight: {
          gutterBackground: ['fold-gutter'],
          rowBackground: false,
        },
      })
      view!.scrollElement.style.setProperty(
        '--editor-cursor-line-gutter-background',
        'rgb(12, 34, 56)',
      )
      view!.setText('alpha\nbeta\ngamma')
      view!.setFoldMarkers([
        {
          key: 'fold-0',
          startOffset: 0,
          endOffset: 10,
          startRow: 0,
          endRow: 1,
          collapsed: false,
        },
      ])
      view!.setSelection(0, 0)
      view!.setScrollMetrics(0, 80)

      const foldCell = container.querySelector<HTMLElement>(
        '[data-editor-virtual-gutter-row="0"] [data-editor-gutter-contribution="fold-gutter"]',
      )
      const foldButton = foldCell?.querySelector<HTMLButtonElement>(
        '.editor-virtualized-fold-toggle',
      )

      expect(foldCell).not.toBeNull()
      expect(foldButton).not.toBeNull()
      expect(foldButton?.hidden).toBe(false)
      expect(getComputedStyle(foldCell!).backgroundColor).toBe('rgb(12, 34, 56)')
      expect(getComputedStyle(foldButton!).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    })

    it('keeps line numbers in the line gutter when hidden fold cells collapse', () => {
      view?.dispose()
      view = new VirtualizedTextView(container, {
        rowHeight: 20,
        overscan: 0,
        gutterContributions: [createLineGutterContribution(), createFoldGutterContribution()],
      })

      const hiddenFoldStyle = document.createElement('style')
      hiddenFoldStyle.textContent = '.editor-virtualized-fold-toggle[hidden] { display: none; }'
      document.head.appendChild(hiddenFoldStyle)

      view!.setText('alpha\nbeta\ngamma')
      view!.setFoldMarkers([
        {
          key: 'fold-0',
          startOffset: 0,
          endOffset: 10,
          startRow: 0,
          endRow: 1,
          collapsed: false,
        },
      ])
      view!.setScrollMetrics(0, 80, 360)

      const foldableLineNumber = container.querySelector<HTMLElement>(
        '[data-editor-virtual-gutter-row="0"] [data-editor-gutter-contribution="line-gutter"]',
      )
      const plainLineNumber = container.querySelector<HTMLElement>(
        '[data-editor-virtual-gutter-row="1"] [data-editor-gutter-contribution="line-gutter"]',
      )

      expect(foldableLineNumber).not.toBeNull()
      expect(plainLineNumber).not.toBeNull()
      expect(Math.round(plainLineNumber!.getBoundingClientRect().left)).toBe(
        Math.round(foldableLineNumber!.getBoundingClientRect().left),
      )
      hiddenFoldStyle.remove()
    })

    it('recreates native token ranges for rows below same-line edits', () => {
      view?.dispose()
      view = new VirtualizedTextView(container, {
        rowHeight: 20,
        overscan: 0,
        selectionHighlightName: 'native-token-test',
      })
      let text = 'aa\nbb\ncc'
      let tokens: readonly EditorToken[] = [
        { start: 0, end: 2, style: { color: '#ff0000' } },
        { start: 3, end: 5, style: { color: '#ff0000' } },
        { start: 6, end: 8, style: { color: '#ff0000' } },
      ]
      view.setText(text)
      view.setScrollMetrics(0, 60)
      view.setTokens(tokens)

      const rowOne = view.getState().mountedRows.find((row) => row.index === 1)!
      const previous = nativeTokenRangeForNode(rowOne.textNode)
      expect(previous).toBeDefined()

      const edit = { from: 1, to: 1, text: 'X' }
      const nextText = `${text.slice(0, edit.from)}${edit.text}${text.slice(edit.to)}`
      view.applyEdit(edit, nextText)
      tokens = [...projectTokensThroughEdit(tokens, edit, text)]
      view.setTokens(tokens)
      text = nextText

      // The edit is on the row above, so this row's own text and the offsets
      // into it are untouched — what must survive is that its token still
      // covers exactly the characters it did, against the node it did.
      const next = nativeTokenRangeForNode(rowOne.textNode)
      expect(previous!.startOffset).toBe(0)
      expect(next).toBeDefined()
      expect(next!.startContainer).toBe(rowOne.textNode)
      expect(next!.startOffset).toBe(0)
      expect(next!.endOffset).toBe(2)
      expect(rowOne.textNode.data).toBe('bb')
      expect(text).toBe('aXa\nbb\ncc')
    })
  },
)

// Token highlights are pooled across every mounted view rather than named per
// view, so the range for a row has to be looked up by the node it covers.
function nativeTokenRangeForNode(node: Text): AbstractRange | undefined {
  for (const [name, highlight] of CSS.highlights.entries()) {
    if (!name.startsWith('editor-shared-token-')) continue

    const range = [...highlight].find((entry) => entry.startContainer === node)
    if (range) return range
  }

  return undefined
}

function withThrowingNativeCaretApis(document: Document, callback: () => void): void {
  const caretPosition = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
  const caretRange = Object.getOwnPropertyDescriptor(document, 'caretRangeFromPoint')
  Object.defineProperty(document, 'caretPositionFromPoint', {
    configurable: true,
    value: () => {
      throw new Error('unexpected native caretPositionFromPoint')
    },
  })
  Object.defineProperty(document, 'caretRangeFromPoint', {
    configurable: true,
    value: () => {
      throw new Error('unexpected native caretRangeFromPoint')
    },
  })

  try {
    callback()
  } finally {
    restoreDocumentProperty(document, 'caretPositionFromPoint', caretPosition)
    restoreDocumentProperty(document, 'caretRangeFromPoint', caretRange)
  }
}

function restoreDocumentProperty(
  document: Document,
  property: 'caretPositionFromPoint' | 'caretRangeFromPoint',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(document, property, descriptor)
    return
  }

  Reflect.deleteProperty(document, property)
}
