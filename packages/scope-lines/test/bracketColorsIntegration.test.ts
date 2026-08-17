import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Editor } from '@singapor/core/editor'
import {
  resetEditorInstanceCount,
  setEditorSyntaxSessionFactory,
  setHighlightRegistry,
} from '@singapor/core/testing'
import { createEmptySyntaxResult } from '@singapor/core/syntax'
import type { BracketInfo, EditorSyntaxResult, EditorSyntaxSession } from '@singapor/core/syntax'
import { createBracketColorsPlugin } from '../src/index'

/**
 * Proves the path the plugin tests stop short of: a structural parse carrying brackets reaches the
 * view snapshot, the plugin buckets them by depth, and both the highlight the renderer paints from
 * and the rule that colours it exist — with the real Editor in between.
 */

const TEXT = 'fn(a[b])\n'
const BRACKETS: readonly BracketInfo[] = [
  { char: '(', depth: 1, index: 2 },
  { char: '[', depth: 2, index: 4 },
  { char: ']', depth: 2, index: 6 },
  { char: ')', depth: 1, index: 7 },
]

const highlights = new Map<string, unknown>()
const registry = {
  delete: (name: string) => highlights.delete(name),
  set: (name: string, highlight: unknown) => {
    highlights.set(name, highlight)
  },
}

class MockHighlight extends Set<Range> {
  public priority = 0
}

describe('bracket colours inside a real editor', () => {
  let container: HTMLElement
  let editor: Editor

  beforeEach(() => {
    highlights.clear()
    // @ts-expect-error — happy-dom has no Highlight constructor
    globalThis.Highlight = MockHighlight
    setHighlightRegistry(registry)
    resetEditorInstanceCount()
    setEditorSyntaxSessionFactory(() => bracketSyntaxSession())
    container = document.createElement('div')
    document.body.appendChild(container)
    editor = new Editor(container, { plugins: [createBracketColorsPlugin()] })
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
    setHighlightRegistry(undefined)
    setEditorSyntaxSessionFactory(undefined)
    document.head.querySelectorAll('style').forEach((element) => element.remove())
  })

  it('registers one highlight per occupied nesting level', async () => {
    await openDocument()

    expect(levelHighlightNames()).toHaveLength(2)
  })

  it('paints the outer and inner pair through different level colours', async () => {
    await openDocument()

    expect(highlightRules()).toContain('color: var(--editor-brackets-level0);')
    expect(highlightRules()).toContain('color: var(--editor-brackets-level1);')
  })

  it('outranks the token colouring of the same characters', async () => {
    await openDocument()
    const names = levelHighlightNames()

    expect(names).not.toHaveLength(0)
    for (const name of names) {
      expect((highlights.get(name) as MockHighlight).priority).toBe(1)
    }
  })

  // A finished parse reaches view contributions on the first update the editor publishes after it,
  // rather than on one of its own, so the caret move stands in for whatever the reader does next.
  async function openDocument(): Promise<void> {
    editor.openDocument({ documentId: 'main.ts', languageId: 'typescript', text: TEXT })
    await flushSyntaxDebounce()
    editor.setSelection(0, 0)
    await flushMicrotasks()
  }
})

function levelHighlightNames(): readonly string[] {
  return [...highlights.keys()].filter((name) => name.includes('bracket-level'))
}

function highlightRules(): string {
  return [...document.head.querySelectorAll('style')]
    .map((element) => element.textContent ?? '')
    .filter((text) => text.includes('::highlight('))
    .join('\n')
}

function bracketSyntaxSession(): EditorSyntaxSession {
  const result: EditorSyntaxResult = { ...createEmptySyntaxResult(), brackets: BRACKETS }
  return {
    applyChange: async () => result,
    dispose: () => undefined,
    getResult: () => result,
    getSnapshotVersion: () => 0,
    getTokens: () => [],
    refresh: async () => result,
  }
}

async function flushSyntaxDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 160))
  await flushMicrotasks()
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
