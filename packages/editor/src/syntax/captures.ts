import type { EditorToken, EditorTokenStyle } from '../tokens'
import {
  appendEditorTokenIndexEntry,
  createEditorTokenIndexBuilder,
  finishEditorTokenIndex,
} from '../editor/tokenIndex'
import { createEditorScopeStyles, editorColorValue, type EditorScopeStyleRule } from '../theme'
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
  { scope: 'text.emphasis', style: { fontStyle: 'italic' } },
  { scope: 'text.literal', style: { color: SYNTAX_COLOR.string } },
  { scope: 'text.reference', style: { color: SYNTAX_COLOR.property } },
  { scope: 'text.strong', style: { fontWeight: 700 } },
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

  for (const capture of captures) {
    const token = captureToEditorToken(capture)
    if (!token) continue

    tokens.push(token)
    appendEditorTokenIndexEntry(indexBuilder, token)
  }

  finishEditorTokenIndex(tokens, indexBuilder)
  return tokens
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
