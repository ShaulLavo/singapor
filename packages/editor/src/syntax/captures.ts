import type { EditorToken, EditorTokenStyle } from '../tokens'
import {
  appendEditorTokenIndexEntry,
  createEditorTokenIndexBuilder,
  finishEditorTokenIndex,
} from '../editor/tokenIndex'
import {
  createEditorScopeStyles,
  editorColorReference,
  editorColorValue,
  registerEditorColor,
  type EditorScopeStyleRule,
} from '../theme'
import type { EditorSyntaxCapture } from './session'

// Capture styling reads the registered colour ids rather than variable names of its own, so a theme
// that sets a syntax colour by id and a capture that paints with it cannot drift apart.
const SYNTAX_COLOR = {
  attribute: editorColorValue('syntax.attribute'),
  bracket: editorColorValue('syntax.bracket'),
  comment: editorColorValue('syntax.comment'),
  constant: editorColorValue('syntax.constant'),
  constructor: editorColorValue('syntax.typeDefinition'),
  function: editorColorValue('syntax.function'),
  keyword: editorColorValue('syntax.keyword'),
  keywordDeclaration: editorColorValue('syntax.keywordDeclaration'),
  keywordImport: editorColorValue('syntax.keywordImport'),
  namespace: editorColorValue('syntax.namespace'),
  number: editorColorValue('syntax.number'),
  property: editorColorValue('syntax.property'),
  string: editorColorValue('syntax.string'),
  tag: editorColorValue('syntax.keyword'),
  // Emphasis and strong are the two scopes a theme normally leaves uncoloured, because an editor
  // renders them with a slant and a weight instead — and a highlight pseudo-element cannot apply
  // either (see style-utils). Uncoloured, they painted nothing at all. These ids default to a hue
  // no other markdown scope already claims, and a theme that wants its own says so by id.
  textEmphasis: registerEditorColor('syntax.textEmphasis', editorColorReference('syntax.type')),
  textStrong: registerEditorColor('syntax.textStrong', editorColorReference('syntax.constant')),
  type: editorColorValue('syntax.type'),
  typeDefinition: editorColorValue('syntax.typeDefinition'),
  typeParameter: editorColorValue('syntax.typeParameter'),
  variable: editorColorValue('syntax.variable'),
  variableBuiltin: editorColorValue('syntax.variableBuiltin'),
} as const

const CAPTURE_STYLE_RULES: readonly EditorScopeStyleRule[] = [
  { scope: 'attribute', style: { color: SYNTAX_COLOR.attribute } },
  { scope: 'comment', style: { color: SYNTAX_COLOR.comment, fontStyle: 'italic' } },
  { scope: 'constant', style: { color: SYNTAX_COLOR.constant } },
  { scope: 'constant.builtin', style: { color: SYNTAX_COLOR.constant } },
  { scope: 'constructor', style: { color: SYNTAX_COLOR.constructor } },
  { scope: 'function', style: { color: SYNTAX_COLOR.function } },
  { scope: 'function.method', style: { color: SYNTAX_COLOR.function } },
  { scope: 'keyword', style: { color: SYNTAX_COLOR.keyword } },
  { scope: 'keyword.control', style: { color: SYNTAX_COLOR.keyword } },
  { scope: 'keyword.declaration', style: { color: SYNTAX_COLOR.keywordDeclaration } },
  { scope: 'keyword.import', style: { color: SYNTAX_COLOR.keywordImport } },
  { scope: 'keyword.type', style: { color: SYNTAX_COLOR.typeParameter } },
  { scope: 'namespace', style: { color: SYNTAX_COLOR.namespace } },
  { scope: 'number', style: { color: SYNTAX_COLOR.number } },
  { scope: 'operator', style: { color: SYNTAX_COLOR.bracket } },
  { scope: 'property', style: { color: SYNTAX_COLOR.property } },
  { scope: 'punctuation', style: { color: SYNTAX_COLOR.bracket } },
  { scope: 'punctuation.bracket', style: { color: SYNTAX_COLOR.bracket } },
  { scope: 'string', style: { color: SYNTAX_COLOR.string } },
  { scope: 'tag', style: { color: SYNTAX_COLOR.tag } },
  { scope: 'text.emphasis', style: { color: SYNTAX_COLOR.textEmphasis, fontStyle: 'italic' } },
  { scope: 'text.literal', style: { color: SYNTAX_COLOR.string } },
  { scope: 'text.reference', style: { color: SYNTAX_COLOR.property } },
  { scope: 'text.strong', style: { color: SYNTAX_COLOR.textStrong, fontWeight: 700 } },
  { scope: 'text.title', style: { color: SYNTAX_COLOR.keywordDeclaration, fontWeight: 700 } },
  { scope: 'text.uri', style: { color: SYNTAX_COLOR.string, textDecoration: 'underline' } },
  { scope: 'type', style: { color: SYNTAX_COLOR.type } },
  { scope: 'type.builtin', style: { color: SYNTAX_COLOR.type } },
  { scope: 'type.definition', style: { color: SYNTAX_COLOR.typeDefinition } },
  { scope: 'type.parameter', style: { color: SYNTAX_COLOR.typeParameter } },
  { scope: 'variable', style: { color: SYNTAX_COLOR.variable } },
  { scope: 'variable.builtin', style: { color: SYNTAX_COLOR.variableBuiltin } },
  { scope: 'variable.parameter', style: { color: SYNTAX_COLOR.keywordImport } },
]

const CAPTURE_SCOPE_STYLES = createEditorScopeStyles(CAPTURE_STYLE_RULES)

/**
 * Which capture wins when two of them cover exactly the same span, most specific first.
 *
 * Exact-span overlaps are ordinary rather than exotic: in a `.ts` file `const MAX = 10` produces
 * @variable, @constant, @constructor and @type over the same three characters, from four separate
 * rules across two shipped query files. Each resolves to a different style, each style gets its own
 * `Highlight`, all of them sit at the same priority, and equal-priority highlights paint in
 * registry insertion order — which is "the first time this session's shared registry saw that style
 * key". Without a rule between them the colour of an identifier was a function of which document
 * the session happened to open first.
 *
 * The principle is how much of the span's meaning the capture pins down. A `*.builtin` names one
 * specific known thing. A declaration role — `type.definition`, `constant`, `function.method` —
 * says what the identifier is for. A lexical kind — `type`, `string`, `number` — says only what
 * shape it has. `variable` is the fallback every identifier gets, so anything else matching the
 * same span knows strictly more than it does.
 *
 * `constant` sits above `constructor` and `type` because all three are heuristics over a
 * capitalised identifier and `constant`'s is the strictest of them: `^[A-Z_][A-Z\d_]+$` where the
 * other two ask only for `^[A-Z]`.
 *
 * Only exact-span duplicates are resolved. A capture nested inside a larger one is a different
 * question with a different answer, and stays exactly as it was.
 */
const CAPTURE_SPECIFICITY: readonly string[] = [
  // Named a specific known thing.
  'variable.builtin',
  'constant.builtin',
  'type.builtin',
  'function.builtin',
  'string.escape',
  'string.special',
  'punctuation.special',
  // Named a role in a declaration.
  'type.definition',
  'type.parameter',
  'keyword.type',
  'keyword.declaration',
  'keyword.import',
  'keyword.control',
  'constant',
  'function.method',
  'function',
  'constructor',
  'namespace',
  'attribute',
  'property',
  'variable.parameter',
  // Named a lexical kind.
  'type',
  'tag',
  'text.title',
  'text.strong',
  'text.emphasis',
  'text.uri',
  'text.literal',
  'text.reference',
  'comment',
  'string',
  'number',
  'keyword',
  'punctuation.bracket',
  'punctuation.delimiter',
  'punctuation',
  'operator',
  // The fallback every identifier gets.
  'variable',
]

const CAPTURE_RANKS = new Map(CAPTURE_SPECIFICITY.map((name, index) => [name, index]))
// A name the table does not list ranks below every name it does, and ties are settled by arrival
// order — deterministic for a given tree, and never a function of anything outside this call.
const UNRANKED_CAPTURE_RANK = CAPTURE_SPECIFICITY.length

/**
 * The rank of a capture name, read the same way its style is: longest prefix first.
 *
 * Styles resolve through a trie, so `keyword.declaration.function` picks up `keyword.declaration`
 * and a grammar is free to name captures as deep as it likes — the shipped queries stop at two
 * segments, but a grammar contributed through `registerLanguage` need not. Ranking by exact lookup
 * would drop every such name to the bottom of the table, below `variable`, and hand the span to the
 * one capture the table calls the fallback. The specific name would lose to the generic one, which
 * is the opposite of the rule this table exists to enforce.
 */
const captureRank = (captureName: string): number => {
  for (let end = captureName.length; end > 0; end = captureName.lastIndexOf('.', end - 1)) {
    const rank = CAPTURE_RANKS.get(captureName.slice(0, end))
    if (rank !== undefined) return rank
  }

  return UNRANKED_CAPTURE_RANK
}

export const styleForTreeSitterCapture = (captureName: string): EditorTokenStyle | null => {
  const style = sharedStyleForTreeSitterCapture(captureName)
  return style ? { ...style } : null
}

const sharedStyleForTreeSitterCapture = (captureName: string): EditorTokenStyle | null =>
  CAPTURE_SCOPE_STYLES.resolve(captureName)

export const treeSitterCapturesToEditorTokens = (
  captures: readonly EditorSyntaxCapture[],
): EditorToken[] => {
  const tokens: EditorToken[] = []
  const indexBuilder = createEditorTokenIndexBuilder()
  const winners = exactSpanWinners(captures)

  for (let index = 0; index < captures.length; index += 1) {
    const capture = captures[index]
    if (!capture) continue
    if (winners.get(captureSpanKey(capture)) !== index) continue

    const token = captureToEditorToken(capture)
    if (!token) continue

    tokens.push(token)
    appendEditorTokenIndexEntry(indexBuilder, token)
  }

  finishEditorTokenIndex(tokens, indexBuilder)
  return tokens
}

const captureSpanKey = (capture: EditorSyntaxCapture): string =>
  `${capture.startIndex}:${capture.endIndex}`

/**
 * The index of the capture that gets to paint each exactly-duplicated span.
 *
 * Only captures that would produce a token at all are candidates: a capture whose name resolves to
 * no style paints nothing today, and letting one win a span would swallow a sibling that does
 * resolve — turning an ordering defect into a missing colour.
 */
const exactSpanWinners = (captures: readonly EditorSyntaxCapture[]): Map<string, number> => {
  const winners = new Map<string, number>()
  const ranks = new Map<string, number>()

  for (let index = 0; index < captures.length; index += 1) {
    const capture = captures[index]
    if (!capture) continue
    if (capture.endIndex <= capture.startIndex) continue
    if (!sharedStyleForTreeSitterCapture(capture.captureName)) continue

    const key = captureSpanKey(capture)
    const rank = captureRank(capture.captureName)
    const incumbent = ranks.get(key)
    if (incumbent !== undefined && incumbent <= rank) continue

    ranks.set(key, rank)
    winners.set(key, index)
  }

  return winners
}

const captureToEditorToken = (capture: EditorSyntaxCapture): EditorToken | null => {
  if (capture.endIndex <= capture.startIndex) return null

  const style = sharedStyleForTreeSitterCapture(capture.captureName)
  if (!style) return null

  return {
    start: capture.startIndex,
    end: capture.endIndex,
    style,
  }
}
