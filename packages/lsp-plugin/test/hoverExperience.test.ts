import type { EditorViewContributionContext, EditorViewSnapshot } from '@singapor/core/extensions'
import { arrayLspLineStarts, type LspClient } from '@singapor/lsp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as lsp from 'vscode-languageserver-protocol'

import { HoverDefinitionController } from '../src/hoverDefinitionController'
import type { ActiveDocument } from '../src/pluginTypes'
import type { LanguageServerHoverUpdate } from '../src/serverSet'
import {
  createTooltipController,
  HOVER_ASYNC_DISPATCH_DELAY_MS,
  HOVER_LOADING_DELAY_MS,
  HOVER_REQUEST_DEBOUNCE_MS,
  TOOLTIP_HIDE_DELAY_MS,
} from '../src/tooltip'
import { connectedEditor, flushPromises } from './connectedEditor'

describe('hover timing and keyboard access', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('starts semantic work halfway through the delay and paints only after the full delay', async () => {
    vi.useFakeTimers()
    const editor = await connectedEditor('const value = 1', 6)

    editor.pointerMove(40, 60)
    await vi.advanceTimersByTimeAsync(HOVER_ASYNC_DISPATCH_DELAY_MS - 1)
    expect(editor.hoverRequests()).toHaveLength(0)

    editor.pointerMove(41, 60)
    await vi.advanceTimersByTimeAsync(1)
    expect(editor.hoverRequests()).toHaveLength(1)
    editor.answerHover({ contents: { kind: 'markdown', value: 'the answer' } })
    await flushPromises()

    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS - HOVER_ASYNC_DISPATCH_DELAY_MS - 1)
    expect(tooltip().hidden).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(tooltip().hidden).toBe(false)
    expect(tooltip().textContent).toContain('the answer')
  })

  it('shows a delayed loading row and cancels it when the pointer leaves', async () => {
    vi.useFakeTimers()
    const editor = await connectedEditor('const value = 1', 6)

    editor.pointerMove(40, 60)
    await vi.advanceTimersByTimeAsync(HOVER_LOADING_DELAY_MS - 1)
    expect(tooltip().hidden).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    expect(tooltip().textContent).toContain('Loading…')
    expect(tooltip().getAttribute('aria-busy')).toBe('true')

    tooltip().dispatchEvent(new PointerEvent('pointerleave'))
    await vi.advanceTimersByTimeAsync(TOOLTIP_HIDE_DELAY_MS)
    expect(tooltip().hidden).toBe(true)
  })

  it('inserts progressive server answers in feature-rank order', async () => {
    vi.useFakeTimers()
    const request = deferred<lsp.Hover | null>()
    let publish!: (update: LanguageServerHoverUpdate) => void
    const { controller, element } = hoverController((onUpdate) => {
      publish = onUpdate
      return request.promise
    })

    element.dispatchEvent(new PointerEvent('pointermove', { buttons: 0, clientX: 40, clientY: 60 }))
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)

    publish({ hovers: [hover('secondary')], pending: true })
    expect(hoverPartTexts()).toEqual(['secondary'])
    publish({ hovers: [hover('primary'), hover('secondary')], pending: false })
    expect(hoverPartTexts()).toEqual(['primary', 'secondary'])

    request.resolve(hover('primary'))
    await flushPromises()
    controller.dispose()
  })

  it('summons and focuses hover from the caret, then restores editor focus on Escape', async () => {
    const editor = await connectedEditor('const value = 1', 6)

    expect(editor.runCommand('editor.action.showHover')).toBe(true)
    expect(editor.hoverRequests()).toHaveLength(1)
    editor.answerHover({ contents: { kind: 'markdown', value: 'keyboard answer' } })
    await flushPromises()

    const focused = document.activeElement as HTMLElement | null
    expect(focused?.dataset.hoverPartIndex).toBe('0')
    focused?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(tooltip().hidden).toBe(true)
    expect(editor.focusEditor).toHaveBeenCalledTimes(1)
  })
})

describe('hover surface interaction and presentation', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('keeps the hover while the pointer approaches it, but not after it turns away', () => {
    const controller = tooltipController()
    const element = tooltip()
    element.getBoundingClientRect = () => new DOMRect(100, 30, 200, 60)
    controller.show(showOptions(new DOMRect(100, 100, 20, 20)))

    expect(controller.shouldKeepForPointer(110, 110)).toBe(true)
    expect(controller.shouldKeepForPointer(110, 98)).toBe(true)
    expect(controller.shouldKeepForPointer(110, 94)).toBe(true)
    expect(controller.shouldKeepForPointer(400, 400)).toBe(false)

    controller.dispose()
  })

  it('uses editor-sized rows, contextual copy actions, keyboard scrolling, and remembered sashes', () => {
    const controller = tooltipController()
    const element = tooltip()
    element.getBoundingClientRect = () => measuredTooltipRect(element)
    controller.show(showOptions(new DOMRect(100, 400, 20, 20)))

    expect(element.getAttribute('role')).toBe('dialog')
    expect(element.style.minWidth).toBe('150px')
    expect(element.style.maxWidth).toBe('750px')
    expect(element.style.borderRadius).toBe('4px')
    expect(element.style.fontFamily).toContain('--editor-font-family')
    expect(element.style.boxShadow).toContain('28px')

    const part = element.querySelector<HTMLElement>('[data-hover-part-index="0"]')
    const copy = element.querySelector<HTMLButtonElement>('[aria-label="Copy hover text"]')
    if (!part || !copy) throw new Error('missing hover row')
    expect(copy.style.opacity).toBe('0')
    part.dispatchEvent(new MouseEvent('mouseenter'))
    expect(copy.style.opacity).toBe('1')

    const body = element.querySelector<HTMLElement>('.editor-test-hover-body')
    if (!body) throw new Error('missing hover body')
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 800 })
    part.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(body.scrollTop).toBe(800)

    const bottom = element.querySelector<HTMLElement>('.editor-test-hover-resize-bottom')
    const top = element.querySelector<HTMLElement>('.editor-test-hover-resize-top')
    const right = element.querySelector<HTMLElement>('.editor-test-hover-resize-right')
    if (!bottom || !top || !right) throw new Error('missing hover sashes')
    expect(bottom.hidden).toBe(false)
    expect(top.hidden).toBe(true)
    right.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 200, clientY: 100 }),
    )
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 280, clientY: 100 }))
    document.dispatchEvent(new PointerEvent('pointerup'))
    expect(element.style.width).toBe('280px')

    controller.hide()
    controller.show(showOptions(new DOMRect(100, 400, 20, 20)))
    expect(element.style.width).toBe('280px')
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

function hoverController(
  requestHover: (
    onUpdate: (update: LanguageServerHoverUpdate) => void,
  ) => Promise<lsp.Hover | null>,
) {
  const element = document.createElement('div')
  document.body.append(element)
  const active = activeDocument()
  const snapshot = hoverSnapshot(active)
  const context = {
    container: element,
    scrollElement: element,
    getSnapshot: () => snapshot,
    focusEditor: vi.fn(),
    textOffsetFromPoint: vi.fn(() => 6),
    getRangeClientRect: vi.fn(() => new DOMRect(10, 20, 40, 18)),
    setSelection: vi.fn(),
    clearRangeHighlight: vi.fn(),
  } as unknown as EditorViewContributionContext
  const client = {
    initialized: true,
    serverCapabilities: { hoverProvider: true },
    request: vi.fn(),
  } as unknown as LspClient
  const controller = new HoverDefinitionController({
    context,
    client,
    requestHover: (_params, _options, onUpdate) => requestHover(onUpdate),
    hoverMarkdownCodeBackground: false,
    getActiveDocument: () => active,
    getDiagnostics: () => [],
    completionContainsTarget: () => false,
    onRequestError: vi.fn(),
  })
  return { controller, element }
}

function activeDocument(): ActiveDocument {
  return {
    uri: 'file:///index.ts',
    languageId: 'typescript',
    textSnapshot: {} as ActiveDocument['textSnapshot'],
    lineStarts: arrayLspLineStarts([0]),
    fullText: 'const value = 1',
    textVersion: 1,
    lspVersion: 1,
  }
}

function hoverSnapshot(active: ActiveDocument): EditorViewSnapshot {
  return {
    documentId: 'index.ts',
    languageId: active.languageId,
    fullText: active.fullText,
    textVersion: active.textVersion,
    lineStarts: active.lineStarts.toArray(),
    tokens: [],
    selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
  } as unknown as EditorViewSnapshot
}

function hover(value: string): lsp.Hover {
  return { contents: { kind: 'markdown', value } }
}

function hoverPartTexts(): readonly string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-hover-part-index]'), (part) =>
    part.textContent?.trim(),
  ).filter((text): text is string => Boolean(text))
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function showOptions(anchor: DOMRect) {
  return {
    anchor,
    hoverText: 'hover text',
    diagnostics: [],
    theme: null,
    preferredPlacement: 'top' as const,
  }
}

function measuredTooltipRect(element: HTMLElement): DOMRect {
  const styledWidth = Number.parseFloat(element.style.width)
  const styledHeight = Number.parseFloat(element.style.height)
  const width = Number.isFinite(styledWidth) ? styledWidth : 200
  const height = Number.isFinite(styledHeight) ? styledHeight : 100
  return new DOMRect(0, 0, width, height)
}

function tooltip(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!element) throw new Error('missing tooltip')
  return element
}
