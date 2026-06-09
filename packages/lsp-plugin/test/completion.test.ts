import type { EditorEditContributionContext } from '@singapor/core/extensions'
import { describe, expect, it, vi } from 'vitest'

import {
  completionApplication,
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
