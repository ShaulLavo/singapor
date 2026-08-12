import {
  bracketJumpTargetOffset,
  findBracketMatchAtCaret,
  type BracketMatch,
} from './editor/bracketMatching'
import type {
  EditorPlugin,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from './plugins'
import type { VirtualizedTextHighlightStyle } from './virtualization'

export const EDITOR_BRACKET_MATCH_PLUGIN_ID = 'editor.bracketMatch'

const DEFAULT_BRACKET_MATCH_STYLE: VirtualizedTextHighlightStyle = {
  backgroundColor: 'rgba(128, 128, 128, 0.28)',
}

/** Updates that can change which bracket the caret touches, or which brackets exist. */
const RECOMPUTE_KINDS: ReadonlySet<EditorViewContributionUpdateKind> = new Set([
  'content',
  'document',
  'selection',
  'tokens',
])

export type EditorBracketMatchPluginOptions = {
  /** Paint applied to both brackets of the pair. */
  readonly style?: VirtualizedTextHighlightStyle
}

/**
 * Highlights the bracket pair around the caret and contributes `editor.action.jumpToBracket`.
 *
 * Pairing uses the bracket list from the structural parse rather than a text scan, so brackets
 * inside strings and comments are already excluded. When the parse has not produced brackets for
 * the caret's region yet, nothing is painted — a missing highlight is honest, a wrong one is not.
 */
export function createBracketMatchPlugin(
  options: EditorBracketMatchPluginOptions = {},
): EditorPlugin {
  let controller: BracketMatchController | null = null

  return {
    name: EDITOR_BRACKET_MATCH_PLUGIN_ID,
    activate(context) {
      return [
        context.registerViewContribution({
          createContribution(contributionContext) {
            controller = new BracketMatchController(
              contributionContext,
              options.style ?? DEFAULT_BRACKET_MATCH_STYLE,
            )
            return controller
          },
        }),
        context.registerCommandContribution({
          createContribution(commandContext) {
            // Resolved on invoke, not on registration: contribution creation order between the
            // view and command registries is not guaranteed.
            return commandContext.registerCommand('editor.action.jumpToBracket', () =>
              controller ? controller.jumpToMatch() : false,
            )
          },
        }),
      ]
    },
  }
}

class BracketMatchController implements EditorViewContribution {
  private readonly highlightName: string
  private painted: BracketMatch | null = null

  constructor(
    private readonly context: EditorViewContributionContext,
    private readonly style: VirtualizedTextHighlightStyle,
  ) {
    this.highlightName = `${context.highlightPrefix ?? 'editor'}-bracket-match`
  }

  update(snapshot: EditorViewSnapshot, kind: EditorViewContributionUpdateKind): void {
    if (kind === 'clear') {
      this.clear()
      return
    }
    if (!RECOMPUTE_KINDS.has(kind)) return

    this.apply(matchForSnapshot(snapshot))
  }

  jumpToMatch(): boolean {
    const snapshot = this.context.getSnapshot()
    const caret = caretOffset(snapshot)
    if (caret === null) return false

    const target = bracketJumpTargetOffset(snapshot.brackets, caret)
    if (target === null) return false

    this.context.setSelection(target, target, 'editor.jumpToBracket', target)
    return true
  }

  dispose(): void {
    this.clear()
  }

  private apply(match: BracketMatch | null): void {
    if (sameMatch(this.painted, match)) return

    this.painted = match
    if (!match) {
      this.context.clearRangeHighlight?.(this.highlightName)
      return
    }

    this.context.setRangeHighlight?.(
      this.highlightName,
      [
        { end: match.openOffset + 1, start: match.openOffset },
        { end: match.closeOffset + 1, start: match.closeOffset },
      ],
      this.style,
    )
  }

  private clear(): void {
    if (!this.painted) return

    this.painted = null
    this.context.clearRangeHighlight?.(this.highlightName)
  }
}

/**
 * Caret of the primary selection, or null when there is no single caret to match against. A
 * non-empty selection is skipped so that selecting a region does not paint an unrelated pair.
 */
function caretOffset(snapshot: EditorViewSnapshot): number | null {
  const primary = snapshot.selections[0]
  if (!primary) return null
  if (primary.startOffset !== primary.endOffset) return null

  return primary.headOffset
}

function matchForSnapshot(snapshot: EditorViewSnapshot): BracketMatch | null {
  const caret = caretOffset(snapshot)
  if (caret === null) return null

  return findBracketMatchAtCaret(snapshot.brackets, caret)
}

function sameMatch(left: BracketMatch | null, right: BracketMatch | null): boolean {
  if (!left || !right) return left === right

  return left.openOffset === right.openOffset && left.closeOffset === right.closeOffset
}
