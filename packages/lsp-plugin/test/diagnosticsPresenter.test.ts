import type { EditorViewContributionContext } from '@singapor/core/extensions'
import { describe, expect, it, vi } from 'vitest'
import type * as lsp from 'vscode-languageserver-protocol'

import { DiagnosticsPresenter } from '../src/diagnosticsPresenter'

describe('DiagnosticsPresenter', () => {
  it('uses configured highlight names, minimap source, and marker timing names', () => {
    const minimap = new TestMinimap()
    const context = editorContext(minimap)
    const presenter = new DiagnosticsPresenter(context, 'editor-test', {
      minimapSourceId: 'editor.test.diagnostics',
      highlightNameNamespace: 'test-lsp',
      markerTimingNamePrefix: 'testLsp.marker',
    })
    const diagnosticItem = diagnostic(1, 1, 2)

    presenter.render('abc', [diagnosticItem])
    presenter.moveMarker({ fullText: 'abc' }, [diagnosticItem], 'next')
    presenter.clear()

    expect(context.setRangeHighlight).toHaveBeenCalledWith(
      'editor-test-test-lsp-error',
      [{ start: 1, end: 2 }],
      expect.any(Object),
    )
    expect(minimap.setDecorations).toHaveBeenCalledWith('editor.test.diagnostics', [
      expect.objectContaining({ startLineNumber: 1, color: 'rgba(239, 68, 68, 1)' }),
    ])
    expect(context.setSelection).toHaveBeenCalledWith(1, 2, 'testLsp.marker.next', 1)
    expect(minimap.clearDecorations).toHaveBeenCalledWith('editor.test.diagnostics')
  })

  it('publishes summarized diagnostics through the configured callback', () => {
    const onDiagnostics = vi.fn()
    const presenter = new DiagnosticsPresenter(editorContext(new TestMinimap()), 'editor-test', {
      minimapSourceId: 'editor.test.diagnostics',
      highlightNameNamespace: 'test-lsp',
      markerTimingNamePrefix: 'testLsp.marker',
      onDiagnostics,
    })

    presenter.publishSummary('file:///src/index.ts', 2, [diagnostic(2, 0, 0)])

    expect(onDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: 'file:///src/index.ts',
        version: 2,
        counts: expect.objectContaining({ warning: 1, total: 1 }),
      }),
    )
  })
})

class TestMinimap {
  public readonly setDecorations = vi.fn()
  public readonly clearDecorations = vi.fn()
}

function editorContext(minimap: TestMinimap): EditorViewContributionContext {
  return {
    getSnapshot: () => ({
      lineCount: 1,
      selections: [{ headOffset: 0 }],
    }),
    getFeature: () => minimap,
    setRangeHighlight: vi.fn(),
    clearRangeHighlight: vi.fn(),
    setSelection: vi.fn(),
    focusEditor: vi.fn(),
  } as unknown as EditorViewContributionContext
}

function diagnostic(severity: lsp.DiagnosticSeverity, start: number, end: number): lsp.Diagnostic {
  return {
    severity,
    message: 'message',
    range: {
      start: { line: 0, character: start },
      end: { line: 0, character: end },
    },
  }
}
