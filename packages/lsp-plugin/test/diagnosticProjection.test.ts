import type { DocumentSessionChange, TextEdit } from '@singapor/core/document'
import type { LspTextDocumentSnapshot, LspTextSnapshot } from '@singapor/lsp'
import { describe, expect, it } from 'vitest'
import type * as lsp from 'vscode-languageserver-protocol'

import { projectDiagnosticsInSnapshot } from '../src/diagnosticProjection'

describe('diagnostic projection', () => {
  it('projects diagnostics through snapshot-backed edits without materializing text', () => {
    const diagnostics = [diagnostic(0, 1, 3)]
    const projected = projectDiagnosticsInSnapshot(diagnostics, {
      previousDocument: snapshotDocument('abc'),
      nextDocument: snapshotDocument('aXbc'),
      change: documentChange([{ from: 1, to: 1, text: 'X' }]),
    })

    expect(projected).toEqual([
      {
        severity: 1,
        source: 'lsp-plugin',
        message: 'message',
        range: {
          start: { line: 0, character: 2 },
          end: { line: 0, character: 4 },
        },
      },
    ])
  })

  it('keeps empty diagnostic arrays by reference', () => {
    const diagnostics: readonly lsp.Diagnostic[] = []
    const projected = projectDiagnosticsInSnapshot(diagnostics, {
      previousDocument: snapshotDocument('abc'),
      nextDocument: snapshotDocument('abcd'),
      change: documentChange([{ from: 3, to: 3, text: 'd' }]),
    })

    expect(projected).toBe(diagnostics)
  })
})

function diagnostic(line: number, start: number, end: number): lsp.Diagnostic {
  return {
    severity: 1,
    source: 'lsp-plugin',
    message: 'message',
    range: {
      start: { line, character: start },
      end: { line, character: end },
    },
  }
}

function documentChange(edits: readonly TextEdit[]): DocumentSessionChange {
  return {
    kind: 'edit',
    edits,
    text: '',
    tokens: [],
    timings: [],
    canUndo: false,
    canRedo: false,
  } as unknown as DocumentSessionChange
}

function snapshotDocument(text: string): LspTextDocumentSnapshot {
  return {
    textSnapshot: throwingFullTextSnapshot(text),
    lineStarts: lineStarts(text),
  }
}

function throwingFullTextSnapshot(text: string): LspTextSnapshot {
  return {
    length: text.length,
    materializeFullText: () => {
      throw new Error('unexpected full text materialization')
    },
    readRange: (start, end) => text.slice(start, end),
  }
}

function lineStarts(text: string): number[] {
  const starts = [0]
  let index = text.indexOf('\n')

  while (index !== -1) {
    starts.push(index + 1)
    index = text.indexOf('\n', index + 1)
  }

  return starts
}
