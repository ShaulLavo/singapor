import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../src/style.css'

import { VirtualizedTextView } from '../src/virtualization'
import { clearBrowserTextMetricsCache } from '../src/virtualization/browserMetrics'
import { offsetToX, xToOffset } from '../src/virtualization/virtualizedTextViewGeometry'
import type { VirtualizedTextViewInternal } from '../src/virtualization/virtualizedTextViewInternals'

const ASCII_LINE = 'const value = 42;'
const SCALE = 2

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
