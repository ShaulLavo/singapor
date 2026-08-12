import { documentLinkAtOffset, documentLinksInRows, type DocumentLink } from './documentLinks'
import type {
  EditorPlugin,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from './plugins'
import type { VirtualizedTextHighlightStyle } from './virtualization'

export const EDITOR_DOCUMENT_LINK_PLUGIN_ID = 'editor.documentLink'

const DEFAULT_LINK_STYLE: VirtualizedTextHighlightStyle = {
  textDecoration: 'underline',
}

const RECOMPUTE_KINDS: ReadonlySet<EditorViewContributionUpdateKind> = new Set([
  'content',
  'document',
  'tokens',
  'viewport',
])

export type EditorDocumentLinkPluginOptions = {
  /** Paint for a link that is ready to be followed. */
  readonly style?: VirtualizedTextHighlightStyle
  /**
   * Opens a followed link. Defaults to a new browser tab with `noopener`; a host that renders
   * outside a browser, or wants its own confirmation, supplies its own.
   */
  readonly openLink?: (url: string) => void
}

/**
 * Underlines http(s) URLs in the buffer and opens them on modifier-click, the affordance every
 * editor gives a link in a comment.
 *
 * Only the mounted rows are scanned — an off-screen link cannot be clicked.
 */
export function createDocumentLinkPlugin(
  options: EditorDocumentLinkPluginOptions = {},
): EditorPlugin {
  return {
    name: EDITOR_DOCUMENT_LINK_PLUGIN_ID,
    activate(context) {
      return context.registerViewContribution({
        createContribution: (contributionContext) =>
          new DocumentLinkController(
            contributionContext,
            options.style ?? DEFAULT_LINK_STYLE,
            options.openLink ?? openLinkInNewTab,
          ),
      })
    },
  }
}

class DocumentLinkController implements EditorViewContribution {
  private readonly highlightName: string
  private links: readonly DocumentLink[] = []
  private painted = false

  constructor(
    private readonly context: EditorViewContributionContext,
    private readonly style: VirtualizedTextHighlightStyle,
    private readonly openLink: (url: string) => void,
  ) {
    this.highlightName = `${context.highlightPrefix ?? 'editor'}-document-link`
    this.context.container.addEventListener('click', this.handleClick)
  }

  update(snapshot: EditorViewSnapshot, kind: EditorViewContributionUpdateKind): void {
    if (kind === 'clear') {
      this.clear()
      return
    }
    if (!RECOMPUTE_KINDS.has(kind)) return

    this.apply(documentLinksInRows(snapshot.visibleRows))
  }

  dispose(): void {
    this.context.container.removeEventListener('click', this.handleClick)
    this.clear()
  }

  /**
   * Follows a link on modifier-click only. A plain click has to stay a caret placement, or editing
   * text that happens to contain a URL becomes impossible.
   */
  private readonly handleClick = (event: MouseEvent): void => {
    if (!event.metaKey && !event.ctrlKey) return
    if (this.links.length === 0) return

    const offset = this.context.textOffsetFromPoint(event.clientX, event.clientY)
    if (offset === null) return

    const link = documentLinkAtOffset(this.links, offset)
    if (!link) return

    event.preventDefault()
    this.openLink(link.url)
  }

  private apply(links: readonly DocumentLink[]): void {
    this.links = links
    if (links.length === 0) {
      this.clear()
      return
    }

    this.painted = true
    this.context.setRangeHighlight?.(
      this.highlightName,
      links.map((link) => ({ end: link.end, start: link.start })),
      this.style,
    )
  }

  private clear(): void {
    this.links = []
    if (!this.painted) return

    this.painted = false
    this.context.clearRangeHighlight?.(this.highlightName)
  }
}

function openLinkInNewTab(url: string): void {
  if (typeof window === 'undefined') return

  // noopener so the opened page cannot reach back through window.opener.
  window.open(url, '_blank', 'noopener,noreferrer')
}
