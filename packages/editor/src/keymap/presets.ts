import { detectPlatform, type RawHotkey } from '@tanstack/hotkeys'
import { EDITOR_FOLD_LEVELS, type EditorCommandId } from '../editor/commands'
import type { KeyChord } from './types'
import { type EditorKeyCondition, editorCommandMutates } from './conditions'
type EditorPlatform = ReturnType<typeof detectPlatform>
export type EditorCommandPack =
  | 'navigation'
  | 'selection'
  | 'find'
  | 'text-editing'
  | 'advanced-editing'
  | 'multi-cursor'
  | 'folding'
  | 'lsp-navigation'
  | 'lsp-editing'
  | 'inline-suggest'

export type EditorKeymapLayerSource = 'core' | 'app'

export type EditorKeyBinding = {
  readonly chord: KeyChord
  readonly when?: readonly EditorKeyCondition[]
  readonly command: EditorCommandId
  readonly preventDefault?: boolean
  readonly stopPropagation?: boolean
}

export type EditorKeymapLayer = {
  readonly id: string
  readonly bindings: readonly EditorKeyBinding[]
  readonly source?: EditorKeymapLayerSource
}

export type EditorKeymapOptions = {
  readonly preset?: 'default' | 'vscode'
  readonly enabled?: boolean
  readonly defaultBindings?: boolean
  readonly layers?: readonly EditorKeymapLayer[]
}

export function editorKeyBindings(options: EditorKeymapOptions = {}): readonly EditorKeyBinding[] {
  return editorKeyBindingsFromLayers(editorKeymapLayers(options))
}

export function editorKeymapLayers(
  options: EditorKeymapOptions = {},
): readonly EditorKeymapLayer[] {
  const defaults =
    options.defaultBindings === false ? [] : presetEditorKeymapLayers(options.preset ?? 'default')

  return defaults.concat(options.layers ?? [])
}

export function editorKeyBindingsFromLayers(
  layers: readonly EditorKeymapLayer[],
  _platform: EditorPlatform = detectPlatform(),
): readonly EditorKeyBinding[] {
  // Later layers take precedence; conditional rows in every layer remain ordered fallbacks.
  return layers.toReversed().flatMap((layer) => layer.bindings)
}

export function defaultEditorKeyBindings(
  platform: EditorPlatform = detectPlatform(),
): readonly EditorKeyBinding[] {
  return editorKeyBindingsFromLayers(defaultEditorKeymapLayers(platform), platform)
}

export const defaultEditorCommandPacks = [
  'navigation',
  'selection',
  'find',
  'text-editing',
  'advanced-editing',
  'multi-cursor',
  'folding',
  'lsp-navigation',
  'lsp-editing',
  'inline-suggest',
] as const satisfies readonly EditorCommandPack[]

export const readonlySafeEditorCommandPacks = [
  'navigation',
  'selection',
  'find',
  // Folding writes nothing back to the document, so a reader of one keeps every one of these keys.
  'folding',
] as const satisfies readonly EditorCommandPack[]

export function defaultEditorKeymapLayers(
  platform: EditorPlatform = detectPlatform(),
): readonly EditorKeymapLayer[] {
  return editorKeymapLayersForCommandPacks(defaultEditorCommandPacks, platform)
}

export function editorKeymapLayersForCommandPacks(
  packs: readonly EditorCommandPack[],
  platform: EditorPlatform = detectPlatform(),
): readonly EditorKeymapLayer[] {
  return packs.map((pack) => editorKeymapLayerForCommandPack(pack, platform))
}

export function editorKeymapLayerForCommandPack(
  pack: EditorCommandPack,
  platform: EditorPlatform = detectPlatform(),
): EditorKeymapLayer {
  return {
    id: `core.${pack}`,
    source: 'core',
    bindings: editorKeyBindingsForCommandPack(pack, platform).map(withEditorConditions),
  }
}

export function editorKeymapLayersForBindings(
  bindings: readonly EditorKeyBinding[],
  packs: readonly EditorCommandPack[] = defaultEditorCommandPacks,
  options: {
    readonly idPrefix?: string
    readonly source?: EditorKeymapLayerSource
  } = {},
): readonly EditorKeymapLayer[] {
  const idPrefix = options.idPrefix ?? 'custom'
  const source = options.source ?? 'app'

  return packs.flatMap((pack) => {
    const packBindings = bindings.filter(
      (binding) => editorCommandPackForCommand(binding.command) === pack,
    )
    if (packBindings.length === 0) return []

    return [{ id: `${idPrefix}.${pack}`, source, bindings: packBindings }]
  })
}

export function filterEditorKeymapLayersByCommandPacks(
  layers: readonly EditorKeymapLayer[],
  packs: readonly EditorCommandPack[],
): readonly EditorKeymapLayer[] {
  const enabledPacks = new Set(packs)

  return layers.flatMap((layer) => {
    const bindings = layer.bindings.filter((binding) =>
      editorCommandInPacks(binding.command, enabledPacks),
    )
    if (bindings.length === 0) return []

    return [{ ...layer, bindings }]
  })
}

export function editorCommandPackForCommand(command: EditorCommandId): EditorCommandPack | null {
  if (NAVIGATION_COMMANDS.has(command)) return 'navigation'
  if (SELECTION_COMMANDS.has(command)) return 'selection'
  if (FIND_COMMANDS.has(command)) return 'find'
  if (TEXT_EDITING_COMMANDS.has(command)) return 'text-editing'
  if (ADVANCED_EDITING_COMMANDS.has(command)) return 'advanced-editing'
  if (MULTI_CURSOR_COMMANDS.has(command)) return 'multi-cursor'
  if (FOLDING_COMMANDS.has(command)) return 'folding'
  if (LSP_NAVIGATION_COMMANDS.has(command)) return 'lsp-navigation'
  if (LSP_EDITING_COMMANDS.has(command)) return 'lsp-editing'
  if (INLINE_SUGGEST_COMMANDS.has(command)) return 'inline-suggest'

  return null
}

function editorKeyBindingsForCommandPack(
  pack: EditorCommandPack,
  platform: EditorPlatform,
): readonly EditorKeyBinding[] {
  if (pack === 'navigation') return navigationBindings(platform)
  if (pack === 'selection') return selectionBindings(platform)
  if (pack === 'find') return findBindings(platform)
  if (pack === 'text-editing') return textEditingBindings(platform)
  if (pack === 'advanced-editing') return advancedEditingBindings(platform)
  if (pack === 'multi-cursor') return multiCursorEditingBindings(platform)
  if (pack === 'folding') return foldingBindings(platform)
  if (pack === 'lsp-navigation') return lspNavigationBindings()
  if (pack === 'lsp-editing') return lspEditingBindings(platform)
  if (pack === 'inline-suggest') return inlineSuggestBindings(platform)

  return []
}

function editorCommandInPacks(
  command: EditorCommandId,
  packs: ReadonlySet<EditorCommandPack>,
): boolean {
  const pack = editorCommandPackForCommand(command)
  if (!pack) return false

  return packs.has(pack)
}

const NAVIGATION_COMMANDS = new Set<EditorCommandId>([
  'cursorLeft',
  'cursorRight',
  'cursorUp',
  'cursorDown',
  'cursorWordLeft',
  'cursorWordRight',
  'cursorWordPartLeft',
  'cursorWordPartRight',
  'cursorLineStart',
  'cursorLineEnd',
  'cursorPageUp',
  'cursorPageDown',
  'cursorDocumentStart',
  'cursorDocumentEnd',
  'editor.action.jumpToBracket',
  // Soft wrap decides whether a long line is walked sideways or read down the page, which is a
  // question for whoever is reading the document rather than whoever is writing it — so it is
  // offered and withdrawn with the rest of the keys for getting through one.
  'editor.action.toggleWordWrap',
])

const SELECTION_COMMANDS = new Set<EditorCommandId>([
  'selectAll',
  'editor.action.smartSelect.expand',
  'editor.action.smartSelect.shrink',
  'selectLeft',
  'selectRight',
  'selectUp',
  'selectDown',
  'selectWordLeft',
  'selectWordRight',
  'cursorWordPartLeftSelect',
  'cursorWordPartRightSelect',
  'selectLineStart',
  'selectLineEnd',
  'selectPageUp',
  'selectPageDown',
  'selectDocumentStart',
  'selectDocumentEnd',
  'cursorColumnSelectLeft',
  'cursorColumnSelectRight',
  'cursorColumnSelectUp',
  'cursorColumnSelectDown',
  'cursorColumnSelectPageUp',
  'cursorColumnSelectPageDown',
])

const FIND_COMMANDS = new Set<EditorCommandId>([
  'find',
  'findNext',
  'findPrevious',
  'closeFind',
  'toggleFindCaseSensitive',
  'toggleFindWholeWord',
  'toggleFindRegex',
  'toggleFindInSelection',
  'togglePreserveCase',
])

const TEXT_EDITING_COMMANDS = new Set<EditorCommandId>([
  'undo',
  'redo',
  'cursorUndo',
  'cursorRedo',
  'deleteBackward',
  'deleteForward',
  'indentSelection',
  'outdentSelection',
  // Handing Tab back to the page belongs with the keys that took it, so a host cannot end up
  // offering the trap without the way out of it.
  'editor.action.toggleTabFocusMode',
  'findReplace',
  'replaceOne',
  'replaceAll',
])

const ADVANCED_EDITING_COMMANDS = new Set<EditorCommandId>([
  'deleteWordLeft',
  'deleteWordRight',
  'deleteWordPartLeft',
  'deleteWordPartRight',
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
])

const MULTI_CURSOR_COMMANDS = new Set<EditorCommandId>([
  'addNextOccurrence',
  'clearSecondarySelections',
  'selectAllMatches',
  'editor.action.insertCursorAbove',
  'editor.action.insertCursorBelow',
  'editor.action.selectHighlights',
  'editor.action.changeAll',
  'editor.action.moveSelectionToNextFindMatch',
])

const FOLDING_COMMANDS = new Set<EditorCommandId>([
  'editor.fold',
  'editor.unfold',
  'editor.foldRecursively',
  'editor.unfoldRecursively',
  'editor.foldAll',
  'editor.unfoldAll',
  'editor.createFoldingRangeFromSelection',
  'editor.removeManualFoldingRanges',
  ...EDITOR_FOLD_LEVELS.map((level) => `editor.foldLevel${level}` as const),
])

const LSP_NAVIGATION_COMMANDS = new Set<EditorCommandId>([
  'editor.action.showHover',
  'goToDefinition',
  'editor.action.goToDefinition',
  'editor.action.goToReferences',
  'editor.action.peekDefinition',
  'editor.action.revealDefinitionAside',
  'editor.action.goToImplementation',
  'editor.action.goToTypeDefinition',
  'editor.action.marker.next',
  'editor.action.marker.prev',
])

const LSP_EDITING_COMMANDS = new Set<EditorCommandId>([
  'editor.action.formatDocument',
  'editor.action.rename',
  'editor.action.autoFix',
])

const INLINE_SUGGEST_COMMANDS = new Set<EditorCommandId>([
  'editor.action.inlineSuggest.commit',
  'editor.action.inlineSuggest.acceptNextWord',
])

function navigationBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return horizontalNavigationBindings(platform).concat(verticalNavigationBindings(platform))
}

const key = (keyName: string, modifiers: Omit<RawHotkey, 'key'> = {}): RawHotkey => ({
  key: keyName,
  ...modifiers,
})

const WORD_PART_MODIFIER: Omit<RawHotkey, 'key'> = { alt: true, ctrl: true }

function textEditingBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const platformBindings: readonly EditorKeyBinding[] =
    platform === 'mac' ? [] : [{ chord: [key('Y', { ctrl: true })], command: 'redo' }]

  return [
    { chord: [key('Backspace')], command: 'deleteBackward' },
    { chord: [key('Delete')], command: 'deleteForward' },
    { chord: [key('Tab')], command: 'indentSelection' },
    { chord: [key('Tab', { shift: true })], command: 'outdentSelection' },
    ...tabFocusBindings(platform),
    {
      chord: [platform === 'mac' ? key('F', { mod: true, alt: true }) : key('H', { mod: true })],
      command: 'findReplace',
    },
    { chord: [key('Enter', { mod: true, alt: true })], command: 'replaceAll' },
    { chord: [key('Z', { mod: true })], command: 'undo' },
    { chord: [key('Z', { mod: true, shift: true })], command: 'redo' },
    { chord: [key('U', { mod: true })], command: 'cursorUndo' },
    { chord: [key('U', { mod: true, shift: true })], command: 'cursorRedo' },
    ...platformBindings,
  ]
}

function tabFocusBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const toggle = platform === 'mac' ? { ctrl: true, shift: true } : { ctrl: true }

  return [{ chord: [key('M', toggle)], command: 'editor.action.toggleTabFocusMode' }]
}

function findBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { chord: [key('Escape')], command: 'closeFind' },
    { chord: [key('Escape')], command: 'clearSecondarySelections', when: ['!findVisible'] },
    { chord: [key('F', { mod: true })], command: 'find' },
    { chord: [platform === 'mac' ? key('G', { mod: true }) : key('F3')], command: 'findNext' },
    {
      chord: [
        platform === 'mac' ? key('G', { mod: true, shift: true }) : key('F3', { shift: true }),
      ],
      command: 'findPrevious',
    },
    { chord: [key('C', { alt: true })], command: 'toggleFindCaseSensitive' },
    { chord: [key('W', { alt: true })], command: 'toggleFindWholeWord' },
    { chord: [key('R', { alt: true })], command: 'toggleFindRegex' },
    { chord: [key('L', { alt: true })], command: 'toggleFindInSelection' },
    { chord: [key('P', { alt: true })], command: 'togglePreserveCase' },
  ]
}

function advancedEditingBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const copyLineModifier =
    platform === 'linux' ? { mod: true, alt: true, shift: true } : { alt: true, shift: true }
  const blockCommentModifier =
    platform === 'linux' ? { mod: true, shift: true } : { alt: true, shift: true }
  const wordDeleteModifier = platform === 'mac' ? { alt: true } : { ctrl: true }
  return [
    { chord: [key('Backspace', wordDeleteModifier)], command: 'deleteWordLeft' },
    { chord: [key('Delete', wordDeleteModifier)], command: 'deleteWordRight' },
    { chord: [key('Backspace', WORD_PART_MODIFIER)], command: 'deleteWordPartLeft' },
    { chord: [key('Delete', WORD_PART_MODIFIER)], command: 'deleteWordPartRight' },
    { chord: [key('K', { mod: true, shift: true })], command: 'editor.action.deleteLines' },
    { chord: [key('ArrowUp', copyLineModifier)], command: 'editor.action.copyLinesUpAction' },
    { chord: [key('ArrowDown', copyLineModifier)], command: 'editor.action.copyLinesDownAction' },
    { chord: [key('ArrowUp', { alt: true })], command: 'editor.action.moveLinesUpAction' },
    { chord: [key('ArrowDown', { alt: true })], command: 'editor.action.moveLinesDownAction' },
    {
      chord: [key('Enter', { mod: true, shift: true })],
      command: 'editor.action.insertLineBefore',
    },
    { chord: [key('Enter', { mod: true })], command: 'editor.action.insertLineAfter' },
    { chord: [key('/', { mod: true })], command: 'editor.action.commentLine' },
    { chord: [key('A', blockCommentModifier)], command: 'editor.action.blockComment' },
    { chord: [key(']', { mod: true })], command: 'editor.action.indentLines' },
    { chord: [key('[', { mod: true })], command: 'editor.action.outdentLines' },
    ...reindentBindings(),
  ]
}

function reindentBindings(): readonly EditorKeyBinding[] {
  return [
    {
      chord: [key('I', { alt: true, shift: true })],
      command: 'editor.action.reindentselectedlines',
    },
    {
      chord: [key('I', { mod: true, alt: true, shift: true })],
      command: 'editor.action.reindentlines',
    },
  ]
}

function multiCursorEditingBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { chord: [key('D', { mod: true })], command: 'addNextOccurrence' },
    { chord: [key('Enter', { alt: true })], command: 'selectAllMatches' },
    ...multiCursorBindings(platform),
  ]
}

function lspNavigationBindings(): readonly EditorKeyBinding[] {
  return [{ chord: [key('F12')], command: 'goToDefinition' }]
}

function lspEditingBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const autoFix = platform === 'mac' ? { mod: true, alt: true } : { alt: true, shift: true }

  return [{ chord: [key('.', autoFix)], command: 'editor.action.autoFix' }]
}

function inlineSuggestBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  if (platform !== 'mac') return []

  return [
    {
      chord: [key('ArrowRight', { mod: true, alt: true })],
      command: 'editor.action.inlineSuggest.acceptNextWord',
    },
  ]
}

function foldingBindings(_platform: EditorPlatform): readonly EditorKeyBinding[] {
  const prefix = key('K', { mod: true })
  const pair = (name: string): KeyChord => [prefix, key(name, { mod: true })]
  return [
    { chord: pair('['), command: 'editor.fold' },
    { chord: pair(']'), command: 'editor.unfold' },
    { chord: [prefix, key('[', { mod: true, shift: true })], command: 'editor.foldRecursively' },
    { chord: [prefix, key(']', { mod: true, shift: true })], command: 'editor.unfoldRecursively' },
    { chord: pair('0'), command: 'editor.foldAll' },
    { chord: pair('J'), command: 'editor.unfoldAll' },
    ...EDITOR_FOLD_LEVELS.map(
      (level): EditorKeyBinding => ({
        chord: pair(String(level)),
        command: `editor.foldLevel${level}`,
      }),
    ),
    { chord: pair(','), command: 'editor.createFoldingRangeFromSelection' },
    {
      chord: [prefix, key(',', { mod: true, shift: true })],
      command: 'editor.removeManualFoldingRanges',
    },
  ]
}

function multiCursorBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  if (platform === 'linux') {
    return [
      {
        chord: [key('ArrowUp', { alt: true, shift: true })],
        command: 'editor.action.insertCursorAbove',
      },
      {
        chord: [key('ArrowDown', { alt: true, shift: true })],
        command: 'editor.action.insertCursorBelow',
      },
      {
        chord: [key('ArrowUp', { mod: true, shift: true })],
        command: 'editor.action.insertCursorAbove',
      },
      {
        chord: [key('ArrowDown', { mod: true, shift: true })],
        command: 'editor.action.insertCursorBelow',
      },
      { chord: [key('L', { mod: true, shift: true })], command: 'editor.action.selectHighlights' },
      { chord: [key('F2', { mod: true })], command: 'editor.action.changeAll' },
    ]
  }

  return [
    {
      chord: [key('ArrowUp', { mod: true, alt: true })],
      command: 'editor.action.insertCursorAbove',
    },
    {
      chord: [key('ArrowDown', { mod: true, alt: true })],
      command: 'editor.action.insertCursorBelow',
    },
    { chord: [key('L', { mod: true, shift: true })], command: 'editor.action.selectHighlights' },
    { chord: [key('F2', { mod: true })], command: 'editor.action.changeAll' },
  ]
}

function horizontalNavigationBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { chord: [key('ArrowLeft')], command: 'cursorLeft' },
    { chord: [key('ArrowRight')], command: 'cursorRight' },
    ...wordNavigationBindings(platform),
    ...lineBoundaryBindings(platform),
  ]
}

function verticalNavigationBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { chord: [key('ArrowUp')], command: 'cursorUp' },
    { chord: [key('ArrowDown')], command: 'cursorDown' },
    { chord: [key('PageUp')], command: 'cursorPageUp' },
    { chord: [key('PageDown')], command: 'cursorPageDown' },
    ...documentBoundaryBindings(platform),
  ]
}

function selectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { chord: [key('A', { mod: true })], command: 'selectAll' },
    ...smartSelectBindings(platform),
    ...horizontalSelectionBindings(platform),
    ...verticalSelectionBindings(platform),
    ...columnSelectionBindings(platform),
  ]
}

function columnSelectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const box = { mod: true, alt: true, shift: true }
  const horizontal = platform === 'mac' ? box : { alt: true }
  const vertical = platform === 'linux' ? { mod: true } : box

  return [
    { chord: [key('ArrowLeft', horizontal)], command: 'cursorColumnSelectLeft' },
    { chord: [key('ArrowRight', horizontal)], command: 'cursorColumnSelectRight' },
    { chord: [key('ArrowUp', vertical)], command: 'cursorColumnSelectUp' },
    { chord: [key('ArrowDown', vertical)], command: 'cursorColumnSelectDown' },
    { chord: [key('PageUp', box)], command: 'cursorColumnSelectPageUp' },
    { chord: [key('PageDown', box)], command: 'cursorColumnSelectPageDown' },
  ]
}

function smartSelectBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  // Alt+Shift is the free pair everywhere except mac, where alt is already the word modifier and
  // taking it would shadow word selection.
  const modifier =
    platform === 'mac' ? { mod: true, ctrl: true, shift: true } : { alt: true, shift: true }

  return [
    { chord: [key('ArrowRight', modifier)], command: 'editor.action.smartSelect.expand' },
    { chord: [key('ArrowLeft', modifier)], command: 'editor.action.smartSelect.shrink' },
  ]
}

function horizontalSelectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { chord: [key('ArrowLeft', { shift: true })], command: 'selectLeft' },
    { chord: [key('ArrowRight', { shift: true })], command: 'selectRight' },
    ...wordSelectionBindings(platform),
    ...lineBoundarySelectionBindings(platform),
  ]
}

function verticalSelectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { chord: [key('ArrowUp', { shift: true })], command: 'selectUp' },
    { chord: [key('ArrowDown', { shift: true })], command: 'selectDown' },
    { chord: [key('PageUp', { shift: true })], command: 'selectPageUp' },
    { chord: [key('PageDown', { shift: true })], command: 'selectPageDown' },
    ...documentBoundarySelectionBindings(platform),
  ]
}

function wordNavigationBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const modifier = platform === 'mac' ? { alt: true } : { ctrl: true }
  return [
    { chord: [key('ArrowLeft', modifier)], command: 'cursorWordLeft' },
    { chord: [key('ArrowRight', modifier)], command: 'cursorWordRight' },
    { chord: [key('ArrowLeft', WORD_PART_MODIFIER)], command: 'cursorWordPartLeft' },
    { chord: [key('ArrowRight', WORD_PART_MODIFIER)], command: 'cursorWordPartRight' },
  ]
}

function wordSelectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const modifier = platform === 'mac' ? { alt: true } : { ctrl: true }
  return [
    { chord: [key('ArrowLeft', { ...modifier, shift: true })], command: 'selectWordLeft' },
    { chord: [key('ArrowRight', { ...modifier, shift: true })], command: 'selectWordRight' },
    {
      chord: [key('ArrowLeft', { ...WORD_PART_MODIFIER, shift: true })],
      command: 'cursorWordPartLeftSelect',
    },
    {
      chord: [key('ArrowRight', { ...WORD_PART_MODIFIER, shift: true })],
      command: 'cursorWordPartRightSelect',
    },
  ]
}

function lineBoundaryBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const macBindings: readonly EditorKeyBinding[] =
    platform === 'mac'
      ? [
          { chord: [key('ArrowLeft', { meta: true })], command: 'cursorLineStart' },
          { chord: [key('ArrowRight', { meta: true })], command: 'cursorLineEnd' },
        ]
      : []

  return [
    { chord: [key('Home')], command: 'cursorLineStart' },
    { chord: [key('End')], command: 'cursorLineEnd' },
    ...macBindings,
  ]
}

function lineBoundarySelectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const macBindings: readonly EditorKeyBinding[] =
    platform === 'mac'
      ? [
          { chord: [key('ArrowLeft', { meta: true, shift: true })], command: 'selectLineStart' },
          { chord: [key('ArrowRight', { meta: true, shift: true })], command: 'selectLineEnd' },
        ]
      : []

  return [
    { chord: [key('Home', { shift: true })], command: 'selectLineStart' },
    { chord: [key('End', { shift: true })], command: 'selectLineEnd' },
    ...macBindings,
  ]
}

function documentBoundaryBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  if (platform === 'mac') {
    return [
      { chord: [key('ArrowUp', { meta: true })], command: 'cursorDocumentStart' },
      { chord: [key('ArrowDown', { meta: true })], command: 'cursorDocumentEnd' },
    ]
  }

  return [
    { chord: [key('Home', { ctrl: true })], command: 'cursorDocumentStart' },
    { chord: [key('End', { ctrl: true })], command: 'cursorDocumentEnd' },
  ]
}

function documentBoundarySelectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  if (platform === 'mac') {
    return [
      { chord: [key('ArrowUp', { meta: true, shift: true })], command: 'selectDocumentStart' },
      { chord: [key('ArrowDown', { meta: true, shift: true })], command: 'selectDocumentEnd' },
    ]
  }

  return [
    { chord: [key('Home', { ctrl: true, shift: true })], command: 'selectDocumentStart' },
    { chord: [key('End', { ctrl: true, shift: true })], command: 'selectDocumentEnd' },
  ]
}

function withEditorConditions(binding: EditorKeyBinding): EditorKeyBinding {
  const when: EditorKeyCondition[] = [...(binding.when ?? [])]
  if (editorCommandMutates(binding.command)) when.push('writable')
  if (binding.command === 'indentSelection' || binding.command === 'outdentSelection')
    when.push('!tabFocusMode')
  if (
    binding.command === 'closeFind' ||
    binding.command.startsWith('toggleFind') ||
    binding.command === 'togglePreserveCase'
  )
    when.push('findVisible')
  if (binding.command.startsWith('editor.action.inlineSuggest.'))
    when.push('inlineSuggestionVisible')
  if (binding.command === 'editor.createFoldingRangeFromSelection') when.push('hasSelection')
  return when.length ? { ...binding, when } : binding
}
export function presetEditorKeymapLayers(
  preset: 'default' | 'vscode',
  platform: EditorPlatform = detectPlatform(),
): readonly EditorKeymapLayer[] {
  if (preset === 'default') return defaultEditorKeymapLayers(platform)
  return editorKeymapLayersForBindings(
    vscodeEditorKeyBindings(platform),
    defaultEditorCommandPacks,
    { idPrefix: 'vscode', source: 'core' },
  )
}
export function vscodeEditorKeyBindings(
  platform: EditorPlatform = detectPlatform(),
): readonly EditorKeyBinding[] {
  const bracket = platform === 'mac' ? { mod: true, alt: true } : { mod: true, shift: true }
  const prefix = key('K', { mod: true })
  const overrides: readonly EditorKeyBinding[] = [
    { chord: [key('[', bracket)], command: 'editor.fold' },
    { chord: [key(']', bracket)], command: 'editor.unfold' },
    { chord: [prefix, key('[', { mod: true })], command: 'editor.foldRecursively' },
    { chord: [prefix, key(']', { mod: true })], command: 'editor.unfoldRecursively' },
    { chord: [prefix, key('.', { mod: true })], command: 'editor.removeManualFoldingRanges' },
    { chord: [prefix, key('I', { mod: true })], command: 'editor.action.showHover' },
    { chord: [prefix, key('C', { mod: true })], command: 'editor.action.commentLine' },
    { chord: [key('F2')], command: 'editor.action.rename' },
    { chord: [key('F12', { shift: true })], command: 'editor.action.goToReferences' },
    { chord: [key('F12', { alt: true })], command: 'editor.action.peekDefinition' },
    { chord: [key('F12', { mod: true })], command: 'editor.action.goToImplementation' },
    { chord: [prefix, key('F12')], command: 'editor.action.revealDefinitionAside' },
    { chord: [key('F', { alt: true, shift: true })], command: 'editor.action.formatDocument' },
    { chord: [key('F8')], command: 'editor.action.marker.next' },
    { chord: [key('F8', { shift: true })], command: 'editor.action.marker.prev' },
    { chord: [key('\\', { mod: true, shift: true })], command: 'editor.action.jumpToBracket' },
    { chord: [key('Z', { alt: true })], command: 'editor.action.toggleWordWrap' },
    { chord: [prefix, key('X', { mod: true })], command: 'editor.action.trimTrailingWhitespace' },
    { chord: [key('Tab')], command: 'editor.action.inlineSuggest.commit', when: ['!tabFocusMode'] },
  ]
  const replaced = new Set(overrides.map((binding) => binding.command))
  // The line-comment single stroke remains an alias of its chord.
  replaced.delete('editor.action.commentLine')
  return [
    ...overrides.map(withEditorConditions),
    ...defaultEditorKeyBindings(platform).filter((binding) => !replaced.has(binding.command)),
  ]
}
