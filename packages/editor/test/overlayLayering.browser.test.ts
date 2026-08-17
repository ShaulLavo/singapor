import { describe, expect, it } from 'vitest'

import '../src/style.css'
import { VirtualizedTextView } from '../src/virtualization'

describe('overlay stacking scale', () => {
  it('layers the gutter from the scale rather than a literal', () => {
    const scroll = document.createElement('div')
    const gutter = document.createElement('div')
    scroll.className = 'editor-virtualized'
    scroll.style.setProperty('--editor-z-gutter', '42')
    gutter.className = 'editor-virtualized-gutter'
    scroll.append(gutter)
    document.body.append(scroll)

    expect(getComputedStyle(gutter).zIndex).toBe('42')

    scroll.remove()
  })

  it('paints overlay tiers in order and leaves room between them', () => {
    const host = document.createElement('div')
    host.style.height = '200px'
    host.style.isolation = 'isolate'
    host.style.position = 'relative'
    host.style.width = '200px'
    // Appended below every tier it must end up under, so DOM order alone would
    // produce the opposite answer.
    const popup = overlayBox(host, 'var(--editor-z-overlay-popup)')
    const between = overlayBox(host, 'calc(var(--editor-z-overlay-widget) + 10)')
    const widget = overlayBox(host, 'var(--editor-z-overlay-widget)')
    const surface = overlayBox(host, 'var(--editor-z-overlay-surface)')
    document.body.append(host)
    const box = host.getBoundingClientRect()

    expect(document.elementFromPoint(box.left + 10, box.top + 10)).toBe(popup)
    popup.remove()
    expect(document.elementFromPoint(box.left + 10, box.top + 10)).toBe(between)
    between.remove()
    expect(document.elementFromPoint(box.left + 10, box.top + 10)).toBe(widget)
    widget.remove()
    expect(document.elementFromPoint(box.left + 10, box.top + 10)).toBe(surface)

    host.remove()
  })

  it('layers the shipped overlay rules from the scale rather than a literal', () => {
    const host = document.createElement('div')
    host.style.setProperty('--editor-z-overlay-surface', '111')
    host.style.setProperty('--editor-z-overlay-popup', '333')
    const layer = document.createElement('div')
    const action = document.createElement('button')
    layer.className = 'editor-merge-conflict-actions-layer'
    action.className = 'editor-merge-conflict-action'
    action.dataset.tooltip = 'Accept'
    host.append(layer, action)
    document.body.append(host)

    expect(getComputedStyle(layer).zIndex).toBe('111')
    expect(getComputedStyle(action, '::after').zIndex).toBe('333')

    host.remove()
  })
})

describe('overlay width reservation', () => {
  it('pads the edge the overlay actually sits on', () => {
    const container = document.createElement('div')
    container.style.height = '120px'
    container.style.width = '360px'
    document.body.append(container)
    const view = new VirtualizedTextView(container, { rowHeight: 20, overscan: 0 })
    const scroll = container.querySelector<HTMLElement>('.editor-virtualized')!

    view.reserveOverlayWidth('right', 96)

    expect(getComputedStyle(scroll).paddingRight).toBe('96px')
    expect(getComputedStyle(scroll).paddingLeft).toBe('0px')

    view.reserveOverlayWidth('right', 0)
    view.reserveOverlayWidth('left', 48)

    expect(getComputedStyle(scroll).paddingLeft).toBe('48px')
    expect(getComputedStyle(scroll).paddingRight).toBe('0px')

    view.dispose()
    container.remove()
  })
})

function overlayBox(host: HTMLElement, zIndex: string): HTMLElement {
  const box = host.ownerDocument.createElement('div')
  box.style.inset = '0'
  box.style.position = 'absolute'
  box.style.zIndex = zIndex
  host.append(box)
  return box
}
