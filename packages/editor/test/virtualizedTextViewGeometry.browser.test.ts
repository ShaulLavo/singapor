import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../src/style.css'

import { VirtualizedTextView } from '../src/virtualization'
import { clearBrowserTextMetricsCache } from '../src/virtualization/browserMetrics'
import {
  clearRowGeometryCache,
  offsetToX,
  xToOffset,
} from '../src/virtualization/virtualizedTextViewGeometry'
import type { VirtualizedTextViewInternal } from '../src/virtualization/virtualizedTextViewInternals'

const ASCII_LINE = 'const value = 42;'
const SCALE = 2
/** Non-ASCII, so the row is measured through the DOM rather than multiplied out arithmetically. */
const WIDE_LINE = '日本語の段落です。'.repeat(30)

/**
 * Every advance a row reads comes back through a Range, so counting those calls counts exactly the
 * work a column costs — which is the thing under test here, not the number that comes out.
 */
function countRangeReads(run: () => void): number {
  const rects = Range.prototype.getClientRects
  const bounding = Range.prototype.getBoundingClientRect
  let reads = 0
  Range.prototype.getClientRects = function getClientRects(this: Range) {
    reads += 1
    return rects.call(this)
  }
  Range.prototype.getBoundingClientRect = function getBoundingClientRect(this: Range) {
    reads += 1
    return bounding.call(this)
  }
  try {
    run()
  } finally {
    Range.prototype.getClientRects = rects
    Range.prototype.getBoundingClientRect = bounding
  }

  return reads
}

function internals(view: VirtualizedTextView): VirtualizedTextViewInternal {
  return Reflect.get(view, 'view') as VirtualizedTextViewInternal
}

/**
 * A host that scales what it contains is the one case where the space a measurement arrives in and
 * the space the geometry is consumed in come apart, and only a real engine reports the difference:
 * everywhere else the client rects and the layout boxes are the same numbers.
 */
describe.skipIf(typeof globalThis.Highlight === 'undefined')(
  'virtualized text view geometry under a scaled host',
  () => {
    let container: HTMLElement
    let view: VirtualizedTextView | null

    beforeEach(() => {
      container = document.createElement('div')
      container.style.height = '120px'
      container.style.width = '360px'
      container.style.transformOrigin = '0 0'
      container.style.transform = `scale(${SCALE})`
      document.body.appendChild(container)
      // The metrics are probed through the host, so they have to be probed through this one.
      clearBrowserTextMetricsCache()
      view = new VirtualizedTextView(container, { rowHeight: 20, overscan: 0 })
      view.setText(ASCII_LINE)
      view.setScrollMetrics(0, 40)
    })

    afterEach(() => {
      view?.dispose()
      container.remove()
      clearBrowserTextMetricsCache()
      view = null
    })

    it('places a short row’s columns in the row’s own space', () => {
      const row = view!.getState().mountedRows[0]!
      const upToColumn = document.createRange()
      upToColumn.setStart(row.chunks[0]!.textNode, 0)
      upToColumn.setEnd(row.chunks[0]!.textNode, 10)
      const drawn =
        (upToColumn.getBoundingClientRect().right - row.element.getBoundingClientRect().left) /
        SCALE

      expect(drawn).toBeGreaterThan(0)
      expect(offsetToX(internals(view!), row, 10)).toBeCloseTo(drawn, 0)
    })

    it('inverts a short row through the cell width it was placed with', () => {
      const internal = internals(view!)
      const row = view!.getState().mountedRows[0]!

      for (const column of [1, 5, 10, ASCII_LINE.length]) {
        expect(xToOffset(internal, row, offsetToX(internal, row, column))).toBe(column)
      }
    })
  },
)

describe.skipIf(typeof globalThis.Highlight === 'undefined')(
  'virtualized text view geometry reads advances on demand',
  () => {
    let container: HTMLElement
    let view: VirtualizedTextView | null

    beforeEach(() => {
      container = document.createElement('div')
      container.style.height = '120px'
      container.style.width = '360px'
      document.body.appendChild(container)
      view = new VirtualizedTextView(container, { rowHeight: 20, overscan: 0 })
      view.setText(WIDE_LINE)
      view.setScrollMetrics(0, 40)
    })

    afterEach(() => {
      view?.dispose()
      container.remove()
      view = null
    })

    it('costs one advance for one column, not one per grapheme in the row', () => {
      const internal = internals(view!)
      const row = view!.getState().mountedRows[0]!

      expect(row.text.length).toBeGreaterThan(200)
      const reads = countRangeReads(() => {
        offsetToX(internal, row, row.startOffset + 120)
      })

      expect(reads).toBeLessThanOrEqual(2)
    })

    it('keeps what it read, so the same column is free the second time', () => {
      const internal = internals(view!)
      const row = view!.getState().mountedRows[0]!
      offsetToX(internal, row, row.startOffset + 120)

      const reads = countRangeReads(() => {
        offsetToX(internal, row, row.startOffset + 120)
      })

      expect(reads).toBe(0)
    })

    it('spends a read per column asked and no more across a scattered walk', () => {
      const internal = internals(view!)
      const row = view!.getState().mountedRows[0]!
      const columns = [10, 40, 90, 150, 210]

      const reads = countRangeReads(() => {
        for (const column of columns) offsetToX(internal, row, row.startOffset + column)
      })

      expect(reads).toBeLessThanOrEqual(columns.length * 2)
      expect(reads).toBeLessThan(row.text.length / 4)
    })

    it('answers with the advance the engine reports, one column at a time', () => {
      const internal = internals(view!)
      const row = view!.getState().mountedRows[0]!
      const node = row.chunks[0]!.textNode
      const rowLeft = row.element.getBoundingClientRect().left

      for (const column of [3, 17, 64, 121]) {
        const upTo = document.createRange()
        upTo.setStart(node, 0)
        upTo.setEnd(node, column)
        expect(offsetToX(internal, row, row.startOffset + column)).toBeCloseTo(
          upTo.getBoundingClientRect().right - rowLeft,
          0,
        )
      }
    })

    /**
     * A boundary two advances meet at belongs to the later of them. Reading columns one at a time
     * has to land on the same value as reading the row through, or a caret placed by one path and a
     * selection edge drawn by the other disagree about the same column.
     */
    it('places a column the same whether it is read alone or with the whole row', () => {
      const internal = internals(view!)
      const row = view!.getState().mountedRows[0]!
      const columns = [0, 1, 8, 33, 100, 209, row.text.length]

      const alone = columns.map((column) => {
        clearRowGeometryCache(row)
        return offsetToX(internal, row, row.startOffset + column)
      })

      clearRowGeometryCache(row)
      // An x→offset question cannot be bounded to one column, so it reads the row through first.
      xToOffset(internal, row, 40)
      expect(columns.map((column) => offsetToX(internal, row, row.startOffset + column))).toEqual(
        alone,
      )
    })

    it('reads the row through only for the question that needs the whole row', () => {
      const internal = internals(view!)
      const row = view!.getState().mountedRows[0]!

      const reads = countRangeReads(() => {
        xToOffset(internal, row, 40)
      })

      expect(reads).toBeGreaterThan(row.text.length / 2)
    })
  },
)
