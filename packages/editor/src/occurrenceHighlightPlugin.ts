import {
  EditorDecorationStore,
  type EditorDecorationSpec,
  type EditorDecorationTextSurface,
} from './editor/decorationStore'
import { occurrenceHighlightRanges, type OccurrenceHighlightRange } from './occurrenceHighlights'
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

/**
 * The whole feature paints through one highlight group, which carries the colour, so there is
 * nothing left for a per-decoration payload to say. Declaring the surface is what puts these in the
 * text index; the shared object is what lets the store recognize an unchanged set.
 */
const OCCURRENCE_TEXT_SURFACE: EditorDecorationTextSurface = {}

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
  private readonly decorations = new EditorDecorationStore()

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

    this.apply(snapshot)
  }

  dispose(): void {
    this.clear()
  }

  private apply(snapshot: EditorViewSnapshot): void {
    const ranges = rangesForSnapshot(snapshot)
    // A single occurrence is the word the caret is already in — painting it says nothing.
    const painted = ranges.length > 1 ? ranges : []
    const specs = painted.map(occurrenceDecorationSpec)
    if (!this.decorations.replaceOwner(EDITOR_OCCURRENCE_HIGHLIGHT_PLUGIN_ID, specs)) return

    if (painted.length === 0) {
      this.context.clearRangeHighlight?.(this.highlightName)
      return
    }

    this.context.setRangeHighlight?.(this.highlightName, painted, this.style)
  }

  private clear(): void {
    if (!this.decorations.replaceOwner(EDITOR_OCCURRENCE_HIGHLIGHT_PLUGIN_ID, [])) return

    this.context.clearRangeHighlight?.(this.highlightName)
  }
}

/**
 * Occurrences mark words that are already in the document, so neither edge absorbs what is typed
 * against it: a character typed onto the end of a match makes it a different word, not a longer
 * match. That is the store's default, so the spec only has to say where and on which surface.
 */
function occurrenceDecorationSpec(range: OccurrenceHighlightRange): EditorDecorationSpec {
  return {
    owner: EDITOR_OCCURRENCE_HIGHLIGHT_PLUGIN_ID,
    start: range.start,
    end: range.end,
    text: OCCURRENCE_TEXT_SURFACE,
  }
}

function rangesForSnapshot(snapshot: EditorViewSnapshot): readonly OccurrenceHighlightRange[] {
  const primary = snapshot.selections[0]
  if (!primary) return []
  // A dragged selection has its own meaning; only a resting caret asks "where else is this used".
  if (primary.startOffset !== primary.endOffset) return []

  return occurrenceHighlightRanges(snapshot.visibleRows, primary.headOffset)
}
