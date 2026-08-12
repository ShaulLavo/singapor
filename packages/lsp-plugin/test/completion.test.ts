import type { EditorEditContributionContext } from '@singapor/core/extensions'
import { describe, expect, it, vi } from 'vitest'

import {
  completionApplication,
  completionNeedsResolve,
  completionPrefix,
  rankCompletionItems,
  completionTriggerFromChange,
  createCompletionEditFeature,
  createCompletionWidgetController,
} from '../src/completion'

describe('completion helpers', () => {
  it('detects identifier and trigger-character completion changes', () => {
    expect(completionTriggerFromChange(editChange('v'))).toEqual({ triggerKind: 1 })
    expect(completionTriggerFromChange(editChange('.'))).toEqual({
      triggerKind: 2,
      triggerCharacter: '.',
    })
  })

  it('applies completion edits with a configured timing name', () => {
    const context = editContext()
    const feature = createCompletionEditFeature(context, 'testLsp.completion.accept')

    expect(
      feature.applyCompletion({
        edits: [{ from: 0, to: 1, text: 'value' }],
        selection: { anchor: 5, head: 5 },
      }),
    ).toBe(true)
    expect(context.applyEdits).toHaveBeenCalledWith(
      [{ from: 0, to: 1, text: 'value' }],
      'testLsp.completion.accept',
      { anchor: 5, head: 5 },
    )
  })

  it('creates completion applications from LSP primary and additional edits', () => {
    const application = completionApplication('const va = helper', 8, {
      label: 'value',
      textEdit: {
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 8 },
        },
        newText: 'value',
      },
      additionalTextEdits: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: 'import { value } from "module";\n',
        },
      ],
    })

    expect(application).toEqual({
      edits: [
        { from: 6, to: 8, text: 'value' },
        { from: 0, to: 0, text: 'import { value } from "module";\n' },
      ],
      selection: { anchor: 43, head: 43 },
    })
  })

  it('uses a configured widget class namespace for styling and selection targets', () => {
    const themeSource = document.createElement('div')
    const onSelect = vi.fn()
    const controller = createCompletionWidgetController({
      document,
      themeSource,
      classNamespace: 'test-lsp',
      onSelect,
    })

    controller.show({
      anchor: new DOMRect(10, 20, 1, 16),
      items: [{ label: 'value', kind: 6 }],
    })

    const element = document.querySelector<HTMLElement>('.editor-test-lsp-completion')
    const row = document.querySelector<HTMLElement>('.editor-test-lsp-completion-item')
    expect(element?.hidden).toBe(false)
    expect(row?.textContent).toContain('value')

    row?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    expect(onSelect).toHaveBeenCalledWith(0)
    expect(controller.containsTarget(row)).toBe(true)

    controller.dispose()
  })
})

function editContext(): EditorEditContributionContext {
  return {
    hasDocument: () => true,
    materializeFullText: () => '',
    focusEditor: vi.fn(),
    applyEdits: vi.fn(),
    registerFeature: vi.fn(() => ({ dispose: vi.fn() })),
  }
}

function editChange(text: string): Parameters<typeof completionTriggerFromChange>[0] {
  return {
    kind: 'edit',
    edits: [{ from: 0, to: 0, text }],
  } as unknown as Parameters<typeof completionTriggerFromChange>[0]
}

describe('completionNeedsResolve', () => {
  const resolving = { completionProvider: { resolveProvider: true } }

  it('resolves an item whose edits the server deferred', () => {
    expect(completionNeedsResolve({ label: 'value' }, resolving)).toBe(true)
  })

  // The import edit is already in hand; a round-trip would only add latency.
  it('does not resolve an item that already carries its edits', () => {
    expect(completionNeedsResolve({ additionalTextEdits: [], label: 'value' }, resolving)).toBe(
      false,
    )
  })

  it('does not resolve when the server cannot', () => {
    expect(completionNeedsResolve({ label: 'value' }, { completionProvider: {} })).toBe(false)
    expect(completionNeedsResolve({ label: 'value' }, null)).toBe(false)
    expect(completionNeedsResolve({ label: 'value' }, undefined)).toBe(false)
  })
})

describe('snippet completions', () => {
  const snippetItem = (insertText: string) => ({
    insertText,
    insertTextFormat: 2 as const,
    label: 'fn',
  })

  it('expands a snippet and selects its first placeholder', () => {
    const application = completionApplication('const x = f', 11, snippetItem('fn(${1:arg})'))

    expect(application?.edits).toEqual([{ from: 10, to: 11, text: 'fn(arg)' }])
    expect(application?.selection).toEqual({ anchor: 13, head: 16 })
  })

  it('puts the caret at an empty tab stop', () => {
    const application = completionApplication('f', 1, snippetItem('fn($1)'))

    expect(application?.edits[0]?.text).toBe('fn()')
    expect(application?.selection).toEqual({ anchor: 3, head: 3 })
  })

  // Without a stop there is nothing to select, so it behaves like a plain completion.
  it('falls back to the end of the insertion when a snippet has no stops', () => {
    const application = completionApplication('f', 1, snippetItem('fn()'))

    expect(application?.selection).toEqual({ anchor: 4, head: 4 })
  })

  it('leaves a non-snippet completion alone', () => {
    const application = completionApplication('f', 1, { insertText: 'fn(${1:arg})', label: 'fn' })

    expect(application?.edits[0]?.text).toBe('fn(${1:arg})')
  })
})

describe('completionPrefix', () => {
  it('reads the identifier being typed', () => {
    expect(completionPrefix('const val', 9)).toBe('val')
  })

  it('is empty after a non-identifier character', () => {
    expect(completionPrefix('const ', 6)).toBe('')
  })
})

describe('rankCompletionItems', () => {
  const items = (...labels: readonly string[]) => labels.map((label) => ({ label }))

  it('keeps the list untouched with no prefix', () => {
    const list = items('b', 'a')

    expect(rankCompletionItems(list, '')).toBe(list)
  })

  it('drops items that do not match', () => {
    expect(rankCompletionItems(items('value', 'other'), 'val').map((i) => i.label)).toEqual([
      'value',
    ])
  })

  it('prefers an exact-case prefix over a case-insensitive one', () => {
    const ranked = rankCompletionItems(items('Value', 'value'), 'val')

    expect(ranked.map((item) => item.label)).toEqual(['value', 'Value'])
  })

  it('ranks a prefix above a subsequence', () => {
    // verticalAlign contains v-a-l in order; canVerifyLater does not, and is rightly excluded.
    const ranked = rankCompletionItems(items('verticalAlign', 'value'), 'val')

    expect(ranked.map((item) => item.label)).toEqual(['value', 'verticalAlign'])
  })

  // sortText is how a server expresses relevance the client cannot compute.
  it('falls back to the server order for equal matches', () => {
    const ranked = rankCompletionItems(
      [
        { label: 'valueB', sortText: '1' },
        { label: 'valueA', sortText: '0' },
      ],
      'value',
    )

    expect(ranked.map((item) => item.label)).toEqual(['valueA', 'valueB'])
  })

  it('matches on filterText when the server supplies one', () => {
    const ranked = rankCompletionItems([{ filterText: 'value', label: 'Different' }], 'val')

    expect(ranked.map((item) => item.label)).toEqual(['Different'])
  })
})
