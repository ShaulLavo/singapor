import { editorLanguageConfiguration, type EditorAutoClosingPair } from './languageConfiguration'

/**
 * Characters a pair may be auto-closed *before*: whitespace and the closers of
 * other pairs, so typing a quote mid-word does not wrap the rest of the word.
 *
 * The point is that `(` typed immediately before a word should not close: you are almost always
 * wrapping the word that follows, and an inserted `)` would land in the middle of it.
 */
const AUTO_CLOSE_BEFORE = new Set([';', ':', '.', ',', '=', '}', ']', ')', '>', ' ', '\t', '\n'])

export function autoClosingPairsForLanguage(
  languageId: string | null | undefined,
): readonly EditorAutoClosingPair[] {
  return editorLanguageConfiguration(languageId)?.autoClosingPairs ?? []
}

export function autoClosingPairForOpen(
  languageId: string | null | undefined,
  typed: string,
): EditorAutoClosingPair | null {
  return autoClosingPairsForLanguage(languageId).find((pair) => pair.open === typed) ?? null
}

export function autoClosingPairForClose(
  languageId: string | null | undefined,
  typed: string,
): EditorAutoClosingPair | null {
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
export function shouldAutoClose(pair: EditorAutoClosingPair, context: AutoCloseContext): boolean {
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
  readonly pair: EditorAutoClosingPair | null
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
