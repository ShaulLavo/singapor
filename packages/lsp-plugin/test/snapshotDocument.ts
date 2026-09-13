import {
  arrayLspLineStarts,
  type LspTextDocumentSnapshot,
  type LspTextSnapshot,
} from '@singapor/lsp'

/** A document whose full text cannot be read, so a test fails if a path rescans it. */
export function snapshotDocument(text: string): LspTextDocumentSnapshot {
  return {
    textSnapshot: throwingFullTextSnapshot(text),
    lineStarts: arrayLspLineStarts(lineStartsOf(text)),
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

export function lineStartsOf(text: string): number[] {
  const starts = [0]
  let index = text.indexOf('\n')

  while (index !== -1) {
    starts.push(index + 1)
    index = text.indexOf('\n', index + 1)
  }

  return starts
}
