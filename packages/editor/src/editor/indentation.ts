/**
 * The single authority for what indentation a new line gets.
 *
 * Auto-close defers to this rather than growing its own rule, so there is one place that decides
 * how a line is indented instead of two that can disagree.
 */

export type LineBreakIndent = {
  /** Text inserted at the caret: the newline and the new line's indentation. */
  readonly insert: string
  /**
   * Text inserted *after* the caret, used when a closing delimiter has to be pushed onto its own
   * line. Empty for an ordinary line break.
   */
  readonly trailing: string
}

export type LineBreakIndentOptions = {
  /** The current line's text from its start up to the caret. */
  readonly lineTextBeforeCaret: string
  /** Character immediately before the caret, or null. */
  readonly charBefore: string | null
  /** Character at the caret, or null. */
  readonly charAfter: string | null
  /** True when `charBefore` opens a pair whose closer is `charAfter`. */
  readonly betweenPair: boolean
  /** True when `charBefore` opens a block, whether or not its closer follows. */
  readonly afterOpener: boolean
  readonly tabSize: number
}

/**
 * Indentation for a line break.
 *
 * Three cases, in order of specificity:
 * - between an opener and its closer: the closer moves to its own line and the caret lands on a
 *   blank line indented one level deeper
 * - directly after an opener: one level deeper, closer untouched
 * - otherwise: the previous line's indentation, continued
 */
export function lineBreakIndent(options: LineBreakIndentOptions): LineBreakIndent {
  const base = leadingWhitespace(options.lineTextBeforeCaret)
  const unit = indentUnit(base, options.tabSize)

  if (options.betweenPair) {
    return { insert: `\n${base}${unit}`, trailing: `\n${base}` }
  }
  if (options.afterOpener) {
    return { insert: `\n${base}${unit}`, trailing: '' }
  }

  return { insert: `\n${base}`, trailing: '' }
}

/** Leading whitespace of a line, which is what a continued line copies verbatim. */
export function leadingWhitespace(lineText: string): string {
  const match = /^[ \t]*/.exec(lineText)
  return match?.[0] ?? ''
}

/**
 * One indent level, inferred from the line rather than configured.
 *
 * A file indented with tabs keeps getting tabs; anything else gets spaces. Inferring beats a
 * setting here because the wrong choice is visible on the very next line.
 */
function indentUnit(base: string, tabSize: number): string {
  if (base.includes('\t')) return '\t'

  return ' '.repeat(Math.max(1, tabSize))
}
