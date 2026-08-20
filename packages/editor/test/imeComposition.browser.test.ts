import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../src/style.css'

import { VirtualizedTextView } from '../src/virtualization'

/**
 * What only a real engine can answer about a composition: whether the reader can actually read the
 * candidate, and whether the box the OS anchors its candidate window on covers the line it is being
 * typed into. Both are questions about painted boxes, which happy-dom reports as empty.
 */
describe.skipIf(typeof globalThis.Highlight === 'undefined')('composing in a real engine', () => {
  let container: HTMLElement
  let view: VirtualizedTextView | null

  beforeEach(() => {
    container = document.createElement('div')
    container.style.height = '120px'
    container.style.width = '360px'
    document.body.appendChild(container)
    view = new VirtualizedTextView(container, { rowHeight: 20, overscan: 0 })
    view.setText('const greeting = 1\nconst farewell = 2')
    view.setScrollMetrics(0, 120, 360, 0)
  })

  afterEach(() => {
    view?.dispose()
    container.remove()
    view = null
  })

  function preedit(): HTMLElement {
    const found = container.querySelector<HTMLElement>('.editor-virtualized-composition')
    if (!found) throw new Error('no preedit was drawn')

    return found
  }

  function input(): HTMLTextAreaElement {
    return container.querySelector('.editor-virtualized-input') as HTMLTextAreaElement
  }

  it('draws the candidate on the line it is being typed into', () => {
    view!.setSelection(6, 6)
    view!.setCompositionPreedit('にほんご')

    const row = container.querySelectorAll('.editor-virtualized-row')[0]!.getBoundingClientRect()
    const drawn = preedit().getBoundingClientRect()

    expect(drawn.width).toBeGreaterThan(0)
    expect(drawn.top).toBeCloseTo(row.top, 0)
    expect(drawn.height).toBeCloseTo(row.height, 0)
  })

  /* The composition is not in the document, so the row underneath still draws whatever the caret
     was sitting in front of — and two runs of text on the same pixels are two runs nobody can read.
     Rows carry no stacking order of their own and mount in whatever order the reader scrolled them
     into, so being painted over them is a tier off the scale rather than a place in the DOM. */
  it('covers the text the row is still drawing underneath it', () => {
    const scroll = container.querySelector('.editor-virtualized') as HTMLElement
    scroll.style.setProperty('--editor-z-inline-surface', '42')
    view!.setSelection(6, 6)
    view!.setCompositionPreedit('にほんご')

    expect(getComputedStyle(preedit()).zIndex).toBe('42')
    expect(getComputedStyle(container.querySelector('.editor-virtualized-row')!).zIndex).toBe(
      'auto',
    )
    expect(getComputedStyle(preedit()).backgroundColor).toBe(
      getComputedStyle(scroll).backgroundColor,
    )
  })

  it('leaves clicks on the row it is covering, so a caret can still be put down under it', () => {
    view!.setSelection(6, 6)
    view!.setCompositionPreedit('にほんご')

    const drawn = preedit().getBoundingClientRect()
    const under = document.elementFromPoint(drawn.left + 2, drawn.top + drawn.height / 2)

    expect(under).toBe(container.querySelectorAll('.editor-virtualized-row')[0])
  })

  it('takes up the height of a row, which is what an emoji or accent picker anchors on', () => {
    view!.setSelection(6, 6)

    expect(input().getBoundingClientRect().height).toBeCloseTo(20, 0)
  })

  it('sits the input on the caret rather than the corner of the viewport', () => {
    view!.setSelection(12, 12)

    const caret = container
      .querySelector<HTMLElement>('.editor-virtualized-caret')!
      .getBoundingClientRect()
    const box = input().getBoundingClientRect()

    expect(box.left).toBeCloseTo(caret.left, 0)
    expect(box.top).toBeCloseTo(caret.top, 0)
  })
})
