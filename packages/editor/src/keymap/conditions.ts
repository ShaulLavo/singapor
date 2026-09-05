import type { EditorCommandId } from '../editor/commands'

export type EditorKeymapContext = {
  readonly writable: boolean
  readonly hasSelection: boolean
  readonly tabFocusMode: boolean
  readonly findVisible: boolean
  readonly inlineSuggestionVisible: boolean
}
export type EditorKeyCondition = keyof EditorKeymapContext | '!tabFocusMode' | '!findVisible'
export function editorKeyConditionMatches(
  condition: EditorKeyCondition,
  context: EditorKeymapContext,
): boolean {
  if (condition === '!findVisible') return !context.findVisible
  if (condition === '!tabFocusMode') return !context.tabFocusMode
  return context[condition]
}
const mutations = new Set<EditorCommandId>([
  'undo',
  'redo',
  'deleteBackward',
  'deleteForward',
  'deleteWordLeft',
  'deleteWordRight',
  'deleteWordPartLeft',
  'deleteWordPartRight',
  'indentSelection',
  'outdentSelection',
  'replaceOne',
  'replaceAll',
  'editor.action.commentLine',
  'editor.action.blockComment',
  'editor.action.indentLines',
  'editor.action.outdentLines',
  'editor.action.reindentlines',
  'editor.action.reindentselectedlines',
  'editor.action.deleteLines',
  'editor.action.copyLinesUpAction',
  'editor.action.copyLinesDownAction',
  'editor.action.moveLinesUpAction',
  'editor.action.moveLinesDownAction',
  'editor.action.insertLineBefore',
  'editor.action.insertLineAfter',
  'editor.action.trimTrailingWhitespace',
  'editor.action.sortLinesAscending',
  'editor.action.sortLinesDescending',
  'editor.action.joinLines',
  'editor.action.duplicateSelection',
  'editor.action.transformToUppercase',
  'editor.action.transformToLowercase',
  'editor.action.transformToTitlecase',
  'editor.action.formatDocument',
  'editor.action.rename',
  'editor.action.autoFix',
  'editor.action.inlineSuggest.commit',
  'editor.action.inlineSuggest.acceptNextWord',
])
export function editorCommandMutates(command: EditorCommandId): boolean {
  return mutations.has(command)
}
