import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Editor } from '../src/editor/Editor'
import {
  resetEditorInstanceCount,
  setEditorSyntaxSessionFactory,
  setHighlightRegistry,
} from '../src/public/testing'
import type { EditorPlugin } from '../src/plugins'

/**
 * Token ranges arrive in buffer offsets while replaced rows render display text. The chunk reuse
 * path used to store `startOffset + text.length` as the chunk's buffer end, which clipped every
 * token to the display length before the boundary math mapped it — heading colors stopped short by
 * exactly the hidden marker width.
 */

const TEXT = '## Summary\nplain\n'
const TOKEN_STYLE = { color: '#ff0000' }

const highlightsMap = new Map<string, Set<AbstractRange>>()
const mockRegistry = {
  delete: (name: string) => highlightsMap.delete(name),
  set: (name: string, highlight: Set<AbstractRange>) => {
    highlightsMap.set(name, highlight)
  },
}

class MockHighlight extends Set<AbstractRange> {}

describe('token painting over inline replacements', () => {
  let container: HTMLElement
  let editor: Editor

  beforeEach(() => {
    highlightsMap.clear()
    // @ts-expect-error happy-dom has no Highlight constructor
    globalThis.Highlight = MockHighlight
    setHighlightRegistry(mockRegistry)
    resetEditorInstanceCount()
    container = document.createElement('div')
    document.body.appendChild(container)
    editor = new Editor(container, { plugins: [highlighterPlugin()] })
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
    setHighlightRegistry(undefined)
    setEditorSyntaxSessionFactory(undefined)
  })

  it('paints the full display text when the token covers the buffer line', async () => {
    await openWithHeadingReplacement()

    const summary = paintedRanges().find((range) => range.text === 'Summary')
    expect(summary).toBeDefined()
    expect([summary!.start, summary!.end]).toEqual([0, 7])
  })

  it('mirrors replacement kinds onto the row element as classes', async () => {
    await openWithHeadingReplacement()

    const row = container.querySelector('.editor-inline-heading-marker-2')
    expect(row).not.toBeNull()
    expect(row!.textContent).toBe('Summary')
  })

  it('drops the kind classes when the replacements go away', async () => {
    await openWithHeadingReplacement()
    expect(container.querySelector('.editor-inline-heading-marker-2')).not.toBeNull()

    editor.setInlineReplacementProvider(null)
    await flush()

    expect(container.querySelector('.editor-inline-heading-marker-2')).toBeNull()
  })

  async function openWithHeadingReplacement(): Promise<void> {
    editor.openDocument({ documentId: 'x.md', languageId: 'markdown', text: TEXT })
    await flush()
    editor.setInlineReplacementProvider(() => [
      {
        id: 'h',
        startIndex: 0,
        endIndex: 3,
        text: '',
        kind: 'heading-marker-2',
        groupId: 'h',
      },
    ])
    await flush()
  }
})

function paintedRanges(): readonly { start: number; end: number; text: string | null }[] {
  const ranges = []
  for (const highlight of highlightsMap.values()) {
    for (const range of highlight) {
      ranges.push({
        start: range.startOffset,
        end: range.endOffset,
        text: range.startContainer.textContent,
      })
    }
  }
  return ranges
}

function highlighterPlugin(): EditorPlugin {
  return {
    name: 'test.highlighter',
    activate: (context) =>
      context.registerHighlighter({
        createSession: () => ({
          refresh: async () => ({ tokens: [{ start: 0, end: 10, style: TOKEN_STYLE }] }),
          applyChange: async () => ({ tokens: [{ start: 0, end: 10, style: TOKEN_STYLE }] }),
          dispose: () => undefined,
        }),
      }),
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 180))
  await Promise.resolve()
  await Promise.resolve()
}
