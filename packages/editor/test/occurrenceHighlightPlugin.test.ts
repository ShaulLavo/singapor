import { describe, expect, it } from 'vitest'

import { createOccurrenceHighlightPlugin } from '../src/occurrenceHighlightPlugin'
import type {
  EditorPluginContext,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewSnapshot,
  EditorVisibleRowSnapshot,
} from '../src/plugins'

type HighlightCall =
  | { readonly kind: 'set'; readonly ranges: readonly { start: number; end: number }[] }
  | { readonly kind: 'clear' }

describe('occurrence highlight contribution', () => {
  it('paints every visible occurrence of the caret word in document offsets', () => {
    const calls: HighlightCall[] = []
    const contribution = createContribution(calls)

    contribution.update(snapshotWithCaret(8), 'selection')

    expect(calls).toEqual([
      {
        kind: 'set',
        ranges: [
          { start: 6, end: 11 },
          { start: 23, end: 28 },
        ],
      },
    ])
  })

  // The store answers "nothing moved" from what it already holds, so the contribution keeps no
  // second copy of what it painted to compare against.
  it('does not repaint when the recomputed set is the one already registered', () => {
    const calls: HighlightCall[] = []
    const contribution = createContribution(calls)

    contribution.update(snapshotWithCaret(8), 'selection')
    contribution.update(snapshotWithCaret(9), 'viewport')

    expect(calls).toHaveLength(1)
  })

  it('clears once when the caret leaves a word, and stays quiet after', () => {
    const calls: HighlightCall[] = []
    const contribution = createContribution(calls)

    contribution.update(snapshotWithCaret(8), 'selection')
    contribution.update(snapshotWithCaret(5), 'selection')
    contribution.update(snapshotWithCaret(5), 'selection')

    expect(calls.map((call) => call.kind)).toEqual(['set', 'clear'])
  })
})

const LINES = ['const value = 1', 'return value']

function createContribution(calls: HighlightCall[]): EditorViewContribution {
  const registered: EditorViewContributionProvider[] = []
  const pluginContext = {
    registerViewContribution: (provider: EditorViewContributionProvider) => {
      registered.push(provider)
      return { dispose: () => {} }
    },
  } as unknown as EditorPluginContext

  createOccurrenceHighlightPlugin().activate(pluginContext)
  const contribution = registered[0]?.createContribution(contributionContext(calls))
  if (!contribution) throw new Error('occurrence highlight contribution was not registered')

  return contribution
}

function contributionContext(calls: HighlightCall[]): EditorViewContributionContext {
  const context: Partial<EditorViewContributionContext> = {
    highlightPrefix: 'editor',
    setRangeHighlight: (_name, ranges) => {
      calls.push({
        kind: 'set',
        ranges: ranges.map((range) => ({ start: range.start, end: range.end })),
      })
    },
    clearRangeHighlight: () => {
      calls.push({ kind: 'clear' })
    },
  }

  return context as EditorViewContributionContext
}

function snapshotWithCaret(caretOffset: number): EditorViewSnapshot {
  return {
    selections: [
      {
        anchorOffset: caretOffset,
        headOffset: caretOffset,
        startOffset: caretOffset,
        endOffset: caretOffset,
      },
    ],
    visibleRows: visibleRows(),
  } as unknown as EditorViewSnapshot
}

function visibleRows(): EditorVisibleRowSnapshot[] {
  let offset = 0

  return LINES.map((text, index) => {
    const row: EditorVisibleRowSnapshot = {
      bufferRow: index,
      endOffset: offset + text.length,
      height: 20,
      index,
      kind: 'text',
      primaryText: true,
      source: 'document',
      startOffset: offset,
      text,
      top: index * 20,
    }
    offset += text.length + 1
    return row
  })
}
