import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@singapor/core/editor'
import { createEditorDiffPlugin } from '../src'

describe('createEditorDiffPlugin', () => {
  let container: HTMLElement | null = null
  let editor: Editor | null = null

  afterEach(() => {
    editor?.dispose()
    container?.remove()
    editor = null
    container = null
  })

  it('renders live injected deletions, recomputes after edits, and clears when disabled', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const plugin = createEditorDiffPlugin()
    editor = new Editor(container, { plugins: [plugin] })

    editor.openDocument({ documentId: 'note.txt', text: 'a\nb\nadd\n' })
    plugin.setBaseFile({ path: 'note.txt', text: 'a\nremove\nb\n' })
    plugin.setEnabled(true)

    expect(container.querySelector('.editor-diff-row-deletion')?.textContent).toBe('remove')
    expect(container.querySelector('.editor-diff-row-addition')?.textContent).toBe('add')
    expect(visibleDiffGutterTexts()).toContain('2-')
    expect(visibleDiffGutterTexts()).toContain('3+')

    editor.edit({
      from: editor.materializeFullText().length,
      to: editor.materializeFullText().length,
      text: 'more\n',
    })

    expect([...container.querySelectorAll('.editor-diff-row-addition')].at(-1)?.textContent).toBe(
      'more',
    )

    plugin.setEnabled(false)

    expect(container.querySelector('.editor-diff-row-deletion')).toBeNull()
    expect(container.querySelector('.editor-diff-row-addition')).toBeNull()
    expect(visibleDiffGutterTexts()).toEqual([])
  })
})

function visibleDiffGutterTexts(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.editor-live-diff-gutter')]
    .filter((element) => !element.hidden)
    .map((element) => element.textContent ?? '')
}
