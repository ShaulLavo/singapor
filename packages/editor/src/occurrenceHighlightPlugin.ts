import {
  occurrenceHighlightRanges,
  type OccurrenceHighlightRange,
} from './occurrenceHighlights'
import type {
  EditorPlugin,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from './plugins'
import type { VirtualizedTextHighlightStyle } from './virtualization'

export const EDITOR_OCCURRENCE_HIGHLIGHT_PLUGIN_ID = 'editor.occurrenceHighlight'

const DEFAULT_OCCURRENCE_STYLE: VirtualizedTextHighlightStyle = {
  backgroundColor: 'rgba(128, 128, 128, 0.18)',
}

/** Scrolling changes which rows are mounted, so the viewport is a recompute trigger here. */
const RECOMPUTE_KINDS: ReadonlySet<EditorViewContributionUpdateKind> = new Set([
  'content',
  'document',
  'selection',
  'tokens',
  'viewport',
])

export type EditorOccurrenceHighlightPluginOptions = {
  readonly style?: VirtualizedTextHighlightStyle
}

/**
 * Passively highlights every visible occurrence of the word under the caret, the way an editor
 * shows you where a symbol is used without being asked.
 *
 * Distinct from the `selectHighlights`/`changeAll` commands, which put cursors on occurrences; this
 * only paints, and only within the mounted rows.
 */
export function createOccurrenceHighlightPlugin(
  options: EditorOccurrenceHighlightPluginOptions = {},
): EditorPlugin {
  return {
    name: EDITOR_OCCURRENCE_HIGHLIGHT_PLUGIN_ID,
    activate(context) {
      return context.registerViewContribution({
        createContribution: (contributionContext) =>
          new OccurrenceHighlightController(
            contributionContext,
            options.style ?? DEFAULT_OCCURRENCE_STYLE,
          ),
      })
    },
  }
}

class OccurrenceHighlightController implements EditorViewContribution {
  private readonly highlightName: string
  private painted: readonly OccurrenceHighlightRange[] = []

  constructor(
    private readonly context: EditorViewContributionContext,
    private readonly style: VirtualizedTextHighlightStyle,
  ) {
    this.highlightName = `${context.highlightPrefix ?? 'editor'}-occurrence-highlight`
  }

  update(snapshot: EditorViewSnapshot, kind: EditorViewContributionUpdateKind): void {
    if (kind === 'clear') {
      this.clear()
      return
    }
    if (!RECOMPUTE_KINDS.has(kind)) return

    this.apply(rangesForSnapshot(snapshot))
  }

  dispose(): void {
    this.clear()
  }

  private apply(ranges: readonly OccurrenceHighlightRange[]): void {
    // A single occurrence is the word the caret is already in — painting it says nothing.
    const next = ranges.length > 1 ? ranges : []
    if (sameRanges(this.painted, next)) return

    this.painted = next
    if (next.length === 0) {
      this.context.clearRangeHighlight?.(this.highlightName)
      return
    }

    this.context.setRangeHighlight?.(this.highlightName, next, this.style)
  }

  private clear(): void {
    if (this.painted.length === 0) return

    this.painted = []
    this.context.clearRangeHighlight?.(this.highlightName)
  }
}

function rangesForSnapshot(snapshot: EditorViewSnapshot): readonly OccurrenceHighlightRange[] {
  const primary = snapshot.selections[0]
  if (!primary) return []
  // A dragged selection has its own meaning; only a resting caret asks "where else is this used".
  if (primary.startOffset !== primary.endOffset) return []

  return occurrenceHighlightRanges(snapshot.visibleRows, primary.headOffset)
}

function sameRanges(
  left: readonly OccurrenceHighlightRange[],
  right: readonly OccurrenceHighlightRange[],
): boolean {
  if (left.length !== right.length) return false

  return left.every((range, index) => {
    const other = right[index]
    return other !== undefined && other.start === range.start && other.end === range.end
  })
}
