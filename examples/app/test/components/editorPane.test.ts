import { describe, expect, it } from 'vitest'

import { createEditorPane } from '../../src/components/editorPane.ts'

describe('createEditorPane', () => {
  it('creates the editor host', () => {
    const pane = createEditorPane()

    expect(pane.element).toBeInstanceOf(HTMLDivElement)
    expect(pane.element.id).toBe('editor-container')
    expect(pane.editorHost.id).toBe('editor-host')
  })
})
