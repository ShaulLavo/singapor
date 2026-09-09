import { describe, expect, it, vi } from 'vitest'
import type { EditorPluginContext } from '@singapor/core/extensions'
import {
  createFoldGutterContribution,
  createFoldGutterPlugin,
  createLineGutterContribution,
  createLineGutterPlugin,
} from '../src/index'

describe('gutter plugins', () => {
  it('registers the line gutter contribution', () => {
    const registerGutterContribution = vi.fn<EditorPluginContext['registerGutterContribution']>(
      () => ({ dispose: vi.fn() }),
    )
    const plugin = createLineGutterPlugin()

    const disposable = plugin.activate(createContext(registerGutterContribution))

    expect(plugin.name).toBe('line-gutter')
    expect(disposable).toBeDefined()
    expect(registerGutterContribution).toHaveBeenCalledOnce()
    expect(registerGutterContribution.mock.calls[0]?.[0].id).toBe('line-gutter')
  })

  it('registers the fold gutter contribution', () => {
    const registerGutterContribution = vi.fn<EditorPluginContext['registerGutterContribution']>(
      () => ({ dispose: vi.fn() }),
    )
    const plugin = createFoldGutterPlugin()

    const disposable = plugin.activate(createContext(registerGutterContribution))

    expect(plugin.name).toBe('fold-gutter')
    expect(disposable).toBeDefined()
    expect(registerGutterContribution).toHaveBeenCalledOnce()
    expect(registerGutterContribution.mock.calls[0]?.[0].id).toBe('fold-gutter')
  })

  it('updates line gutter cells with CSS counters', () => {
    const contribution = createLineGutterContribution({ counterStyle: 'decimal-leading-zero' })
    const cell = contribution.createCell(document)

    contribution.updateCell(cell, {
      index: 0,
      bufferRow: 4,
      source: 'document',
      startOffset: 0,
      endOffset: 0,
      text: '',
      kind: 'text',
      primaryText: true,
      cursorLine: true,
      cursorLineHighlight: {
        gutterBackground: true,
        gutterNumber: true,
        rowBackground: true,
      },
      foldMarker: null,
      lineCount: 10,
      toggleFold: vi.fn(),
    })

    expect(cell.style.counterSet).toBe('editor-line 5')
    expect(cell.style.getPropertyValue('--editor-line-gutter-counter-style')).toBe(
      'decimal-leading-zero',
    )
    expect(cell.classList.contains('editor-virtualized-line-number-active')).toBe(true)

    const paint = contribution.snapshotRenderer?.capture(cell)
    const restored = contribution.createCell(document)
    expect(contribution.snapshotRenderer?.restore(restored, paint ?? '')).toBe(true)
    expect(restored.style.counterSet).toBe('editor-line 5')
    expect(restored.classList.contains('editor-virtualized-line-number-active')).toBe(true)
    expect(
      contribution.snapshotRenderer?.restore(
        restored,
        '{"counter":"url(evil)","hidden":false,"active":true}',
      ),
    ).toBe(false)
  })

  it('supports source line offsets and minimum digits', () => {
    const contribution = createLineGutterContribution({ minDigits: 4, startLine: 811 })
    const cell = contribution.createCell(document)

    contribution.updateCell(cell, {
      index: 0,
      bufferRow: 2,
      source: 'document',
      startOffset: 0,
      endOffset: 0,
      text: '',
      kind: 'text',
      primaryText: true,
      cursorLine: false,
      cursorLineHighlight: {
        gutterBackground: true,
        gutterNumber: true,
        rowBackground: true,
      },
      foldMarker: null,
      lineCount: 3,
      toggleFold: vi.fn(),
    })

    const width = contribution.width({
      lineCount: 3,
      metrics: { characterWidth: 7, rowHeight: 20 },
    })

    expect(cell.style.counterSet).toBe('editor-line 813')
    expect(width).toBeGreaterThanOrEqual(36)
  })

  it('renders custom line labels', () => {
    const contribution = createLineGutterContribution({
      labelForRow: (row) => (row.bufferRow === 1 ? null : 100 + row.bufferRow),
      minDigits: 3,
    })
    const cell = contribution.createCell(document)

    contribution.updateCell(cell, {
      index: 0,
      bufferRow: 0,
      source: 'document',
      startOffset: 0,
      endOffset: 0,
      text: '',
      kind: 'text',
      primaryText: true,
      cursorLine: true,
      cursorLineHighlight: {
        gutterBackground: true,
        gutterNumber: true,
        rowBackground: true,
      },
      foldMarker: null,
      lineCount: 3,
      toggleFold: vi.fn(),
    })

    expect(cell.textContent).toBe('100')
    expect(cell.style.counterSet).toBe('')
    expect(cell.classList.contains('editor-virtualized-line-number-active')).toBe(true)

    contribution.updateCell(cell, {
      index: 1,
      bufferRow: 1,
      source: 'document',
      startOffset: 0,
      endOffset: 0,
      text: '',
      kind: 'text',
      primaryText: true,
      cursorLine: true,
      cursorLineHighlight: {
        gutterBackground: true,
        gutterNumber: true,
        rowBackground: true,
      },
      foldMarker: null,
      lineCount: 3,
      toggleFold: vi.fn(),
    })

    expect(cell.hidden).toBe(true)
    expect(cell.textContent).toBe('')
    expect(cell.classList.contains('editor-virtualized-line-number-active')).toBe(false)
  })

  it('renders fold gutter icons from DOM factories', () => {
    const contribution = createFoldGutterContribution({
      icon: ({ document }) => {
        const icon = document.createElement('span')
        icon.dataset.testFoldIcon = 'custom'
        return icon
      },
    })
    const cell = contribution.createCell(document)
    const toggleFold = vi.fn()
    const button = cell.querySelector<HTMLButtonElement>('.editor-virtualized-fold-toggle')

    contribution.updateCell(cell, {
      index: 0,
      bufferRow: 0,
      source: 'document',
      startOffset: 0,
      endOffset: 0,
      text: '',
      kind: 'text',
      primaryText: true,
      cursorLine: false,
      cursorLineHighlight: {
        gutterBackground: true,
        gutterNumber: false,
        rowBackground: true,
      },
      foldMarker: {
        key: 'fold-0',
        startRow: 0,
        endRow: 3,
        startOffset: 0,
        endOffset: 12,
        collapsed: false,
      },
      lineCount: 4,
      toggleFold,
    })

    expect(button).not.toBeNull()
    expect(button?.hidden).toBe(false)
    expect(button?.dataset.editorFoldKey).toBe('fold-0')
    expect(cell.querySelector("[data-test-fold-icon='custom']")).not.toBeNull()
    button?.click()
    expect(toggleFold).toHaveBeenCalledOnce()
    expect(contribution.snapshotRenderer).toBeUndefined()
  })

  it('restores fold paint without source identity or input handlers', () => {
    const contribution = createFoldGutterContribution({
      width: 16,
      expandedIndicator: '⌄',
      collapsedIndicator: '›',
      iconClassName: 'custom-fold-icon',
    })
    const cell = contribution.createCell(document)
    const toggleFold = vi.fn()
    const row = {
      index: 0,
      bufferRow: 0,
      source: 'document',
      startOffset: 0,
      endOffset: 12,
      text: '',
      kind: 'text',
      primaryText: true,
      cursorLine: false,
      cursorLineHighlight: { gutterBackground: true, gutterNumber: false, rowBackground: true },
      foldMarker: {
        key: 'live-fold',
        startRow: 0,
        endRow: 3,
        startOffset: 0,
        endOffset: 12,
        collapsed: true,
      },
      lineCount: 4,
      toggleFold,
    } satisfies Parameters<typeof contribution.updateCell>[1]
    contribution.updateCell(cell, row)
    const paint = contribution.snapshotRenderer?.capture(cell)
    const restored = contribution.createCell(document)
    expect(contribution.snapshotRenderer?.restore(restored, paint ?? '')).toBe(true)
    const button = restored.querySelector<HTMLButtonElement>('.editor-virtualized-fold-toggle')
    expect(button?.textContent).toBe('›')
    expect(button?.disabled).toBe(true)
    expect(button?.dataset.editorFoldKey).toBeUndefined()
    expect(button?.dataset.editorFoldState).toBe('collapsed')
    expect(restored.querySelector('.custom-fold-icon')).not.toBeNull()
    button?.click()
    expect(toggleFold).not.toHaveBeenCalled()
    expect(contribution.snapshotRenderer?.restore(restored, '<script>')).toBe(false)

    const toggleCurrentFold = vi.fn()
    contribution.updateCell(restored, {
      ...row,
      foldMarker: { ...row.foldMarker, key: 'current-fold', collapsed: false },
      toggleFold: toggleCurrentFold,
    })
    expect(restored.querySelector('.editor-virtualized-fold-toggle')).toBe(button)
    expect(button?.disabled).toBe(false)
    expect(button?.textContent).toBe('⌄')
    expect(button?.dataset.editorFoldKey).toBe('current-fold')
    button?.click()
    expect(toggleFold).not.toHaveBeenCalled()
    expect(toggleCurrentFold).toHaveBeenCalledWith(expect.objectContaining({ key: 'current-fold' }))
  })
})

function createContext(
  registerGutterContribution: EditorPluginContext['registerGutterContribution'],
): EditorPluginContext {
  return {
    registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
    registerSyntaxProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerViewContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerCommandContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerCapabilityContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerEditContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerDecorationContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerGutterContribution,
    registerInjectedTextRowProvider: vi.fn(() => ({ dispose: vi.fn() })),
  }
}
