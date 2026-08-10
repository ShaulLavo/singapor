import type { EditorPlugin, EditorInlineReplacementContext } from '@singapor/core/extensions'
import type { InlineReplacementSpec } from '@singapor/core/rendering'
import { markdownInlineReplacements } from './replacements'
import './style.css'

export { markdownInlineReplacements } from './replacements'

export type MarkdownPreviewPluginOptions = {
  /** Language ids this applies to. Defaults to markdown only, so other files render as source. */
  readonly languageIds?: readonly string[]
}

const DEFAULT_LANGUAGE_IDS = ['markdown']

/**
 * Renders markdown as formatted text while the buffer keeps holding markdown source: fences hide,
 * headings drop their `#`, links collapse to their label, and the source under the caret comes back
 * so it stays editable as text. Include the plugin to turn it on, remove it to turn it off.
 */
export function createMarkdownPreviewPlugin(
  options: MarkdownPreviewPluginOptions = {},
): EditorPlugin {
  const languageIds = new Set(options.languageIds ?? DEFAULT_LANGUAGE_IDS)

  return {
    name: 'markdown-preview',
    activate: (context) => {
      // The contribution is optional on the context, so a host that predates it would otherwise
      // install this plugin and render nothing at all. Say so instead of failing silently.
      if (!context.registerInlineReplacementProvider) {
        context.log?.({
          action: 'markdown.preview.unsupported',
          level: 'warn',
          message:
            'Editor does not support inline replacement providers; markdown preview is inactive.',
        })
        return undefined
      }

      return context.registerInlineReplacementProvider((replacementContext) =>
        replacementsForContext(replacementContext, languageIds),
      )
    },
  }
}

const replacementsForContext = (
  context: EditorInlineReplacementContext,
  languageIds: ReadonlySet<string>,
): readonly InlineReplacementSpec[] => {
  if (context.languageId === null) return []
  if (!languageIds.has(context.languageId)) return []
  return markdownInlineReplacements(context.text, context.captures)
}
