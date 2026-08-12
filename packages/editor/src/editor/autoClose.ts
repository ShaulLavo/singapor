export type AutoClosingPair = {
  readonly open: string
  readonly close: string
  /** Quotes use one character for both ends, which changes several rules below. */
  readonly quote?: boolean
}

const CODE_PAIRS: readonly AutoClosingPair[] = [
  { close: ')', open: '(' },
  { close: ']', open: '[' },
  { close: '}', open: '{' },
  { close: "'", open: "'", quote: true },
  { close: '"', open: '"', quote: true },
  { close: '`', open: '`', quote: true },
]

/** Markdown and plain prose: brackets still help, but apostrophes are punctuation, not delimiters. */
const PROSE_PAIRS: readonly AutoClosingPair[] = [
  { close: ')', open: '(' },
  { close: ']', open: '[' },
  { close: '}', open: '{' },
  { close: '`', open: '`', quote: true },
]

const PAIRS_BY_LANGUAGE: Record<string, readonly AutoClosingPair[]> = {
  css: CODE_PAIRS,
  html: CODE_PAIRS,
  javascript: CODE_PAIRS,
  javascriptreact: CODE_PAIRS,
  json: CODE_PAIRS,
  jsonc: CODE_PAIRS,
  jsx: CODE_PAIRS,
  markdown: PROSE_PAIRS,
  md: PROSE_PAIRS,
  scss: CODE_PAIRS,
  ts: CODE_PAIRS,
  tsx: CODE_PAIRS,
  typescript: CODE_PAIRS,
  typescriptreact: CODE_PAIRS,
}

/**
 * Characters a pair may be auto-closed *before*. Mirrors VS Code's default `autoCloseBefore`.
 *
 * The point is that `(` typed immediately before a word should not close: you are almost always
 * wrapping the word that follows, and an inserted `)` would land in the middle of it.
 */
const AUTO_CLOSE_BEFORE = new Set([';', ':', '.', ',', '=', '}', ']', ')', '>', ' ', '\t', '\n'])

export function autoClosingPairsForLanguage(
  languageId: string | null | undefined,
): readonly AutoClosingPair[] {
  if (!languageId) return []

  return PAIRS_BY_LANGUAGE[languageId] ?? []
}

export function autoClosingPairForOpen(
  languageId: string | null | undefined,
  typed: string,
): AutoClosingPair | null {
  return autoClosingPairsForLanguage(languageId).find((pair) => pair.open === typed) ?? null
}

export function autoClosingPairForClose(
  languageId: string | null | undefined,
  typed: string,
): AutoClosingPair | null {
  return autoClosingPairsForLanguage(languageId).find((pair) => pair.close === typed) ?? null
}

export type AutoCloseContext = {
  /** Character at the caret, or null at end of document. */
  readonly charAfter: string | null
  /** Character immediately before the caret, or null at the start. */
  readonly charBefore: string | null
}

/**
 * Whether typing `pair.open` at a collapsed caret should insert the closer too.
 *
 * Two rules, both about not getting in the way:
 * - only close before whitespace, end of line, or a character that ends an expression — never
 *   directly before a word, where the closer would land mid-identifier
 * - for quotes, additionally never close right after a word character, so an apostrophe in `don't`
 *   or `it's` stays an apostrophe
 */
export function shouldAutoClose(pair: AutoClosingPair, context: AutoCloseContext): boolean {
  if (context.charAfter !== null && !AUTO_CLOSE_BEFORE.has(context.charAfter)) return false
  if (!pair.quote) return true

  // `''` and `""` would otherwise nest endlessly as you type a second quote to close the first.
  if (context.charBefore === pair.open) return false

  return !isWordCharacter(context.charBefore)
}

/**
 * Whether typing `pair.close` should step over an existing closer instead of inserting one.
 *
 * Only true when the character at the caret is that closer AND this editor put it there — typing
 * `)` before a hand-written `)` must still insert, or deleting text you meant to keep becomes
 * impossible.
 */
export function shouldTypeOverCloser(options: {
  readonly charAfter: string | null
  readonly close: string
  readonly trackedAtCaret: boolean
}): boolean {
  if (!options.trackedAtCaret) return false

  return options.charAfter === options.close
}

/**
 * Whether backspacing at a collapsed caret should delete a whole pair.
 *
 * Same rule as type-over: only a pair this editor inserted, still intact, with the caret still
 * between its halves.
 */
export function shouldDeletePair(options: {
  readonly charAfter: string | null
  readonly charBefore: string | null
  readonly pair: AutoClosingPair | null
  readonly trackedAtCaret: boolean
}): boolean {
  if (!options.trackedAtCaret) return false
  if (!options.pair) return false

  return options.charBefore === options.pair.open && options.charAfter === options.pair.close
}

function isWordCharacter(char: string | null): boolean {
  if (char === null) return false

  return /[\p{L}\p{N}_$]/u.test(char)
}
