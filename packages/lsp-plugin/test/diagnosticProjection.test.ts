import { arrayLspLineStarts } from '@singapor/lsp'
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

  // Neither edge takes in what is typed against it, so a keystroke at the boundary of a squiggle
  // leaves the squiggle where it was rather than widening it over text the server never saw.
  it('keeps text typed at either edge outside the diagnostic', () => {
    const diagnostics = [diagnostic(0, 1, 4)]

    const atStart = projectDiagnosticsInSnapshot(diagnostics, {
      previousDocument: snapshotDocument('abcdef'),
      nextDocument: snapshotDocument('aZbcdef'),
      change: documentChange([{ from: 1, to: 1, text: 'Z' }]),
    })
    const atEnd = projectDiagnosticsInSnapshot(diagnostics, {
      previousDocument: snapshotDocument('abcdef'),
      nextDocument: snapshotDocument('abcdZef'),
      change: documentChange([{ from: 4, to: 4, text: 'Z' }]),
    })

    expect(atStart.map((item) => item.range)).toEqual([characterRange(2, 5)])
    expect(atEnd.map((item) => item.range)).toEqual([characterRange(1, 4)])
  })

  // Both answers to "an edit removed part of what was flagged" are defensible — shorten the marker,
  // or withhold it until the server speaks again — and no other assertion here can tell them apart,
  // so this one pins the choice: the marker survives, over less text than the server described.
  it('keeps a shortened marker over what survives an edit into either end of the span', () => {
    const tailRemoved = projectDiagnosticsInSnapshot([diagnostic(0, 1, 4)], {
      previousDocument: snapshotDocument('abcdef'),
      nextDocument: snapshotDocument('abcf'),
      change: documentChange([{ from: 3, to: 5, text: '' }]),
    })
    const headRemoved = projectDiagnosticsInSnapshot([diagnostic(0, 1, 4)], {
      previousDocument: snapshotDocument('abcdef'),
      nextDocument: snapshotDocument('cdef'),
      change: documentChange([{ from: 0, to: 2, text: '' }]),
    })

    expect(tailRemoved.map((item) => item.range)).toEqual([characterRange(1, 3)])
    expect(headRemoved.map((item) => item.range)).toEqual([characterRange(0, 2)])
  })

  it('drops a diagnostic whose text an edit removed entirely', () => {
    const swallowed = projectDiagnosticsInSnapshot([diagnostic(0, 1, 4)], {
      previousDocument: snapshotDocument('abcdef'),
      nextDocument: snapshotDocument('xf'),
      change: documentChange([{ from: 0, to: 5, text: 'x' }]),
    })

    expect(swallowed).toEqual([])
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

function characterRange(start: number, end: number): lsp.Range {
  return { start: { line: 0, character: start }, end: { line: 0, character: end } }
}

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
    lineStarts: arrayLspLineStarts(lineStarts(text)),
  }
}

function throwingFullTextSnapshot(text: string): LspTextSnapshot {
  return {
    length: text.length,
    materializeFullText: () => {
      throw new Error('unexpected full text materialization')
    },
    readRange: (start, end) => text.slice(start, end),
    forEachTextChunk: (visit) => visit(text, 0, text.length),
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
