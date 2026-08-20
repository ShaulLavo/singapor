import { afterEach, describe, expect, it } from 'vitest'

import { createRenameWidgetController } from '../src/renameWidget'

describe('the rename input', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  // Renaming while a rename is open is one keystroke away — the command is on a key — and the second
  // prompt is the one the reader is waiting on: dismissing the first must not take the field with it.
  it('stays on screen when a second rename is asked for while one is open', async () => {
    const controller = createRenameWidgetController({ document, themeSource: document.body })
    const anchor = new DOMRect(10, 20, 40, 18)

    const first = controller.prompt({ anchor, currentName: 'first' })
    const second = controller.prompt({ anchor, currentName: 'second' })

    await expect(first).resolves.toBeNull()
    expect(renameElement().style.display).toBe('block')
    // The surface the field is placed against goes with it, or the field lands wherever it was last.
    expect(renameAnchorElement().style.display).toBe('block')

    renameInput().value = 'renamed'
    renameInput().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )

    await expect(second).resolves.toBe('renamed')
    controller.dispose()
  })
})

function renameElement(): HTMLElement {
  const element = document.body.querySelector<HTMLElement>('.lsp-plugin-rename')
  if (!element) throw new Error('missing rename input')
  return element
}

function renameAnchorElement(): HTMLElement {
  const element = document.body.querySelector<HTMLElement>('.lsp-plugin-rename-anchor')
  if (!element) throw new Error('missing rename anchor')
  return element
}

function renameInput(): HTMLInputElement {
  const input = renameElement().querySelector('input')
  if (!input) throw new Error('missing rename field')
  return input
}
