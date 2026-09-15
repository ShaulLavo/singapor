import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTooltipController } from '../src/tooltip'

describe('tooltip content', () => {
  afterEach(() => document.body.replaceChildren())

  it('runs actions and drops them when the hover is replaced', () => {
    const controller = tooltipController()
    const run = vi.fn()
    controller.show({ ...showOptions(), actions: [{ label: 'Adjust settings', run }] })
    const button = document.querySelector<HTMLButtonElement>('.editor-test-hover-action button')
    expect(button?.textContent).toBe('Adjust settings')
    button?.click()
    expect(run).toHaveBeenCalledOnce()
    controller.show(showOptions())
    expect(document.querySelector('.editor-test-hover-action')).toBeNull()
    controller.dispose()
  })

  it('renders notes as labelled rows and prefers the bottom placement for them', () => {
    const controller = tooltipController()
    controller.show({
      ...showOptions(),
      preferredPlacement: undefined,
      notes: [{ label: 'warning', color: 'rgb(1, 2, 3)', text: 'Looks like a hyphen' }],
    })
    const section = document.querySelector<HTMLElement>('.editor-test-hover-notes')
    expect(section?.getAttribute('aria-label')).toBe('warning: Looks like a hyphen')
    const label = section?.querySelector('span')
    expect(label?.textContent).toBe('warning')
    expect(label?.style.color).toBe('rgb(1, 2, 3)')
    expect(document.querySelector('.editor-test-hover')?.getAttribute('data-editor-popup')).toBe('')
    controller.dispose()
  })
})

function tooltipController() {
  const editor = document.createElement('div')
  editor.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700)
  document.body.append(editor)
  return createTooltipController({
    document,
    themeSource: editor,
    reentryElement: editor,
    classNamespace: 'test',
  })
}

function showOptions() {
  return {
    anchor: new DOMRect(100, 400, 20, 20),
    hoverText: 'hover text',
    theme: null,
    preferredPlacement: 'top' as const,
  }
}
