import {
  detectPlatform,
  getHotkeyManager,
  normalizeRegisterableHotkey,
  type HotkeyRegistrationHandle,
  type RawHotkey,
  type RegisterableHotkey,
} from '@tanstack/hotkeys'
import type { EditorCommandContext, EditorCommandId } from './commands'

type EditorPlatform = ReturnType<typeof detectPlatform>
type EditorKeymapSignature = readonly string[]
type EditorResolvedKeymap = {
  readonly bindings: readonly EditorKeyBinding[]
  readonly signature: EditorKeymapSignature
}

export type EditorCommandPack =
  | 'navigation'
  | 'selection'
  | 'clipboard'
  | 'find'
  | 'text-editing'
  | 'advanced-editing'
  | 'multi-cursor'
  | 'lsp-navigation'

export type EditorKeymapLayerSource = 'core' | 'plugin' | 'app' | 'user'

export type EditorKeyBinding = {
  readonly hotkey: RegisterableHotkey
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
  readonly enabled?: boolean
  readonly defaultBindings?: boolean
  readonly layers?: readonly EditorKeymapLayer[]
}

export type EditorKeymapControllerOptions = {
  readonly target: HTMLElement
  readonly keymap?: EditorKeymapOptions
  readonly dispatch: (command: EditorCommandId, context: EditorCommandContext) => boolean
}

export class EditorKeymapController {
  private readonly handles: HotkeyRegistrationHandle[] = []
  private readonly dispatch: (command: EditorCommandId, context: EditorCommandContext) => boolean
  private readonly target: HTMLElement
  private keymapSignature: EditorKeymapSignature | null = null

  public constructor(options: EditorKeymapControllerOptions) {
    this.dispatch = options.dispatch
    this.target = options.target
    this.setKeymap(options.keymap)
  }

  public setKeymap(keymap: EditorKeymapOptions | undefined): boolean {
    const resolved = resolveEditorKeymap(keymap)
    if (editorKeymapSignaturesEqual(this.keymapSignature, resolved.signature)) {
      return false
    }

    this.unregisterBindings()
    this.keymapSignature = resolved.signature

    for (const binding of resolved.bindings)
      this.registerBinding(this.target, binding, this.dispatch)
    return true
  }

  public dispose(): void {
    this.unregisterBindings()
    this.keymapSignature = null
  }

  private unregisterBindings(): void {
    for (const handle of this.handles) handle.unregister()
    this.handles.length = 0
  }

  private registerBinding(
    target: HTMLElement,
    binding: EditorKeyBinding,
    dispatch: (command: EditorCommandId, context: EditorCommandContext) => boolean,
  ): void {
    const handle = getHotkeyManager().register(
      binding.hotkey,
      (event) => {
        const handled = dispatch(binding.command, { event })

        if (shouldPreventDefault(binding, handled)) event.preventDefault()
        if (shouldStopPropagation(binding, handled)) event.stopPropagation()
      },
      {
        conflictBehavior: 'replace',
        eventType: 'keydown',
        ignoreInputs: false,
        preventDefault: false,
        stopPropagation: false,
        target,
      },
    )
    this.handles.push(handle)
  }
}

function shouldPreventDefault(binding: EditorKeyBinding, handled: boolean): boolean {
  if (binding.preventDefault === true) return true
  if (binding.preventDefault === false) return false
  return handled
}

function shouldStopPropagation(binding: EditorKeyBinding, handled: boolean): boolean {
  if (binding.stopPropagation === true) return true
  if (binding.stopPropagation === false) return false
  return handled
}

function resolveEditorKeymap(options: EditorKeymapOptions | undefined): EditorResolvedKeymap {
  if (options?.enabled === false) {
    return { bindings: [], signature: ['enabled:false'] }
  }

  const platform = detectPlatform()
  const bindings = editorKeyBindingsFromLayers(editorKeymapLayers(options), platform)

  return {
    bindings,
    signature: bindings.map((binding) => editorKeyBindingSignature(binding, platform)),
  }
}

function editorKeyBindingSignature(binding: EditorKeyBinding, platform: EditorPlatform): string {
  return [
    editorHotkeyKey(binding.hotkey, platform),
    binding.command,
    binding.preventDefault,
    binding.stopPropagation,
  ].join('\0')
}

function editorKeymapSignaturesEqual(
  left: EditorKeymapSignature | null,
  right: EditorKeymapSignature,
): boolean {
  if (!left) return false
  if (left.length !== right.length) return false

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }

  return true
}

export function editorKeyBindings(options: EditorKeymapOptions = {}): readonly EditorKeyBinding[] {
  return editorKeyBindingsFromLayers(editorKeymapLayers(options))
}

export function editorKeymapLayers(
  options: EditorKeymapOptions = {},
): readonly EditorKeymapLayer[] {
  const defaults = options.defaultBindings === false ? [] : defaultEditorKeymapLayers()

  return defaults.concat(options.layers ?? [])
}

export function editorKeyBindingsFromLayers(
  layers: readonly EditorKeymapLayer[],
  platform: EditorPlatform = detectPlatform(),
): readonly EditorKeyBinding[] {
  const bindingsByHotkey = new Map<string, EditorKeyBinding>()

  for (const layer of layers) {
    for (const binding of layer.bindings) {
      bindingsByHotkey.set(editorHotkeyKey(binding.hotkey, platform), binding)
    }
  }

  return Array.from(bindingsByHotkey.values())
}

export function defaultEditorKeyBindings(
  platform: EditorPlatform = detectPlatform(),
): readonly EditorKeyBinding[] {
  return editorKeyBindingsFromLayers(defaultEditorKeymapLayers(platform), platform)
}

export const defaultEditorCommandPacks = [
  'navigation',
  'selection',
  'clipboard',
  'find',
  'text-editing',
  'advanced-editing',
  'multi-cursor',
  'lsp-navigation',
] as const satisfies readonly EditorCommandPack[]

export const readonlySafeEditorCommandPacks = [
  'navigation',
  'selection',
  'clipboard',
  'find',
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
    bindings: editorKeyBindingsForCommandPack(pack, platform),
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
  if (LSP_NAVIGATION_COMMANDS.has(command)) return 'lsp-navigation'

  return null
}

function editorKeyBindingsForCommandPack(
  pack: EditorCommandPack,
  platform: EditorPlatform,
): readonly EditorKeyBinding[] {
  if (pack === 'navigation') return navigationBindings(platform)
  if (pack === 'selection') return selectionBindings(platform)
  if (pack === 'find') return findBindings()
  if (pack === 'text-editing') return textEditingBindings(platform)
  if (pack === 'advanced-editing') return advancedEditingBindings(platform)
  if (pack === 'multi-cursor') return multiCursorEditingBindings(platform)
  if (pack === 'lsp-navigation') return lspNavigationBindings()

  return []
}

function editorHotkeyKey(hotkey: RegisterableHotkey, platform: EditorPlatform): string {
  return normalizeRegisterableHotkey(hotkey, platform)
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
  'editor.action.deleteLines',
  'editor.action.copyLinesUpAction',
  'editor.action.copyLinesDownAction',
  'editor.action.moveLinesUpAction',
  'editor.action.moveLinesDownAction',
  'editor.action.insertLineBefore',
  'editor.action.insertLineAfter',
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

const LSP_NAVIGATION_COMMANDS = new Set<EditorCommandId>([
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

function navigationBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return horizontalNavigationBindings(platform).concat(verticalNavigationBindings(platform))
}

const key = (keyName: string, modifiers: Omit<RawHotkey, 'key'> = {}): RawHotkey => ({
  key: keyName,
  ...modifiers,
})

/**
 * Subword shortcuts take both of the modifiers a word shortcut picks between, on every platform.
 *
 * Whichever one a platform spends on word motion, the pair is still free, so the subword shortcut
 * can never shadow the word shortcut it refines, and reads as an extension of it either way.
 */
const WORD_PART_MODIFIER: Omit<RawHotkey, 'key'> = { alt: true, ctrl: true }

function textEditingBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const platformBindings: readonly EditorKeyBinding[] =
    platform === 'mac' ? [] : [{ hotkey: key('Y', { ctrl: true }), command: 'redo' }]

  return [
    { hotkey: key('Backspace'), command: 'deleteBackward' },
    { hotkey: key('Delete'), command: 'deleteForward' },
    { hotkey: key('Tab'), command: 'indentSelection' },
    { hotkey: key('Tab', { shift: true }), command: 'outdentSelection' },
    { hotkey: key('H', { mod: true }), command: 'findReplace' },
    { hotkey: key('Enter', { mod: true, alt: true }), command: 'replaceAll' },
    { hotkey: key('Z', { mod: true }), command: 'undo' },
    { hotkey: key('Z', { mod: true, shift: true }), command: 'redo' },
    { hotkey: key('U', { mod: true }), command: 'cursorUndo' },
    { hotkey: key('U', { mod: true, shift: true }), command: 'cursorRedo' },
    ...platformBindings,
  ]
}

function findBindings(): readonly EditorKeyBinding[] {
  return [
    { hotkey: key('Escape'), command: 'closeFind' },
    { hotkey: key('F', { mod: true }), command: 'find' },
    { hotkey: key('F3'), command: 'findNext' },
    { hotkey: key('F3', { shift: true }), command: 'findPrevious' },
    { hotkey: key('C', { alt: true }), command: 'toggleFindCaseSensitive' },
    { hotkey: key('W', { alt: true }), command: 'toggleFindWholeWord' },
    { hotkey: key('R', { alt: true }), command: 'toggleFindRegex' },
    { hotkey: key('L', { alt: true }), command: 'toggleFindInSelection' },
    { hotkey: key('P', { alt: true }), command: 'togglePreserveCase' },
  ]
}

function advancedEditingBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const copyLineModifier =
    platform === 'linux' ? { mod: true, alt: true, shift: true } : { alt: true, shift: true }
  const blockCommentModifier =
    platform === 'linux' ? { mod: true, shift: true } : { alt: true, shift: true }
  const wordDeleteModifier = platform === 'mac' ? { alt: true } : { ctrl: true }
  return [
    { hotkey: key('Backspace', wordDeleteModifier), command: 'deleteWordLeft' },
    { hotkey: key('Delete', wordDeleteModifier), command: 'deleteWordRight' },
    { hotkey: key('Backspace', WORD_PART_MODIFIER), command: 'deleteWordPartLeft' },
    { hotkey: key('Delete', WORD_PART_MODIFIER), command: 'deleteWordPartRight' },
    { hotkey: key('K', { mod: true, shift: true }), command: 'editor.action.deleteLines' },
    { hotkey: key('ArrowUp', copyLineModifier), command: 'editor.action.copyLinesUpAction' },
    { hotkey: key('ArrowDown', copyLineModifier), command: 'editor.action.copyLinesDownAction' },
    { hotkey: key('ArrowUp', { alt: true }), command: 'editor.action.moveLinesUpAction' },
    { hotkey: key('ArrowDown', { alt: true }), command: 'editor.action.moveLinesDownAction' },
    { hotkey: key('Enter', { mod: true, shift: true }), command: 'editor.action.insertLineBefore' },
    { hotkey: key('Enter', { mod: true }), command: 'editor.action.insertLineAfter' },
    { hotkey: key('/', { mod: true }), command: 'editor.action.commentLine' },
    { hotkey: key('A', blockCommentModifier), command: 'editor.action.blockComment' },
    { hotkey: key(']', { mod: true }), command: 'editor.action.indentLines' },
    { hotkey: key('[', { mod: true }), command: 'editor.action.outdentLines' },
  ]
}

function multiCursorEditingBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { hotkey: key('D', { mod: true }), command: 'addNextOccurrence' },
    { hotkey: key('Enter', { alt: true }), command: 'selectAllMatches' },
    ...multiCursorBindings(platform),
  ]
}

function lspNavigationBindings(): readonly EditorKeyBinding[] {
  return [{ hotkey: key('F12'), command: 'goToDefinition' }]
}

function multiCursorBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  if (platform === 'linux') {
    return [
      {
        hotkey: key('ArrowUp', { alt: true, shift: true }),
        command: 'editor.action.insertCursorAbove',
      },
      {
        hotkey: key('ArrowDown', { alt: true, shift: true }),
        command: 'editor.action.insertCursorBelow',
      },
      {
        hotkey: key('ArrowUp', { mod: true, shift: true }),
        command: 'editor.action.insertCursorAbove',
      },
      {
        hotkey: key('ArrowDown', { mod: true, shift: true }),
        command: 'editor.action.insertCursorBelow',
      },
      { hotkey: key('L', { mod: true, shift: true }), command: 'editor.action.selectHighlights' },
      { hotkey: key('F2', { mod: true }), command: 'editor.action.changeAll' },
    ]
  }

  return [
    {
      hotkey: key('ArrowUp', { mod: true, alt: true }),
      command: 'editor.action.insertCursorAbove',
    },
    {
      hotkey: key('ArrowDown', { mod: true, alt: true }),
      command: 'editor.action.insertCursorBelow',
    },
    { hotkey: key('L', { mod: true, shift: true }), command: 'editor.action.selectHighlights' },
    { hotkey: key('F2', { mod: true }), command: 'editor.action.changeAll' },
  ]
}

function horizontalNavigationBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { hotkey: key('ArrowLeft'), command: 'cursorLeft' },
    { hotkey: key('ArrowRight'), command: 'cursorRight' },
    ...wordNavigationBindings(platform),
    ...lineBoundaryBindings(platform),
  ]
}

function verticalNavigationBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { hotkey: key('ArrowUp'), command: 'cursorUp' },
    { hotkey: key('ArrowDown'), command: 'cursorDown' },
    { hotkey: key('PageUp'), command: 'cursorPageUp' },
    { hotkey: key('PageDown'), command: 'cursorPageDown' },
    ...documentBoundaryBindings(platform),
  ]
}

function selectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { hotkey: key('A', { mod: true }), command: 'selectAll' },
    ...smartSelectBindings(platform),
    ...horizontalSelectionBindings(platform),
    ...verticalSelectionBindings(platform),
    ...columnSelectionBindings(platform),
  ]
}

/**
 * Where the rectangle's moving corner can be pushed from the keyboard.
 *
 * Every chord wants the pair the mouse draws the box with plus the primary modifier, which the page
 * keys get everywhere. The arrows cannot always have it: where the primary modifier collapses onto
 * ctrl that pair is already subword selection, so the horizontal axis drops to alt alone, and on
 * linux the vertical pair is already line copying, so it drops to the primary modifier alone. Each
 * axis keeps a chord on every platform because a rectangle only a mouse can start does not exist
 * for someone working from the keyboard.
 */
function columnSelectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const box = { mod: true, alt: true, shift: true }
  const horizontal = platform === 'mac' ? box : { alt: true }
  const vertical = platform === 'linux' ? { mod: true } : box

  return [
    { hotkey: key('ArrowLeft', horizontal), command: 'cursorColumnSelectLeft' },
    { hotkey: key('ArrowRight', horizontal), command: 'cursorColumnSelectRight' },
    { hotkey: key('ArrowUp', vertical), command: 'cursorColumnSelectUp' },
    { hotkey: key('ArrowDown', vertical), command: 'cursorColumnSelectDown' },
    { hotkey: key('PageUp', box), command: 'cursorColumnSelectPageUp' },
    { hotkey: key('PageDown', box), command: 'cursorColumnSelectPageDown' },
  ]
}

function smartSelectBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  // Alt+Shift is the free pair everywhere except mac, where alt is already the word modifier and
  // taking it would shadow word selection.
  const modifier =
    platform === 'mac' ? { mod: true, ctrl: true, shift: true } : { alt: true, shift: true }

  return [
    { hotkey: key('ArrowRight', modifier), command: 'editor.action.smartSelect.expand' },
    { hotkey: key('ArrowLeft', modifier), command: 'editor.action.smartSelect.shrink' },
  ]
}

function horizontalSelectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { hotkey: key('ArrowLeft', { shift: true }), command: 'selectLeft' },
    { hotkey: key('ArrowRight', { shift: true }), command: 'selectRight' },
    ...wordSelectionBindings(platform),
    ...lineBoundarySelectionBindings(platform),
  ]
}

function verticalSelectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { hotkey: key('ArrowUp', { shift: true }), command: 'selectUp' },
    { hotkey: key('ArrowDown', { shift: true }), command: 'selectDown' },
    { hotkey: key('PageUp', { shift: true }), command: 'selectPageUp' },
    { hotkey: key('PageDown', { shift: true }), command: 'selectPageDown' },
    ...documentBoundarySelectionBindings(platform),
  ]
}

function wordNavigationBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const modifier = platform === 'mac' ? { alt: true } : { ctrl: true }
  return [
    { hotkey: key('ArrowLeft', modifier), command: 'cursorWordLeft' },
    { hotkey: key('ArrowRight', modifier), command: 'cursorWordRight' },
    { hotkey: key('ArrowLeft', WORD_PART_MODIFIER), command: 'cursorWordPartLeft' },
    { hotkey: key('ArrowRight', WORD_PART_MODIFIER), command: 'cursorWordPartRight' },
  ]
}

function wordSelectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const modifier = platform === 'mac' ? { alt: true } : { ctrl: true }
  return [
    { hotkey: key('ArrowLeft', { ...modifier, shift: true }), command: 'selectWordLeft' },
    { hotkey: key('ArrowRight', { ...modifier, shift: true }), command: 'selectWordRight' },
    {
      hotkey: key('ArrowLeft', { ...WORD_PART_MODIFIER, shift: true }),
      command: 'cursorWordPartLeftSelect',
    },
    {
      hotkey: key('ArrowRight', { ...WORD_PART_MODIFIER, shift: true }),
      command: 'cursorWordPartRightSelect',
    },
  ]
}

function lineBoundaryBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const macBindings: readonly EditorKeyBinding[] =
    platform === 'mac'
      ? [
          { hotkey: key('ArrowLeft', { meta: true }), command: 'cursorLineStart' },
          { hotkey: key('ArrowRight', { meta: true }), command: 'cursorLineEnd' },
        ]
      : []

  return [
    { hotkey: key('Home'), command: 'cursorLineStart' },
    { hotkey: key('End'), command: 'cursorLineEnd' },
    ...macBindings,
  ]
}

function lineBoundarySelectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const macBindings: readonly EditorKeyBinding[] =
    platform === 'mac'
      ? [
          { hotkey: key('ArrowLeft', { meta: true, shift: true }), command: 'selectLineStart' },
          { hotkey: key('ArrowRight', { meta: true, shift: true }), command: 'selectLineEnd' },
        ]
      : []

  return [
    { hotkey: key('Home', { shift: true }), command: 'selectLineStart' },
    { hotkey: key('End', { shift: true }), command: 'selectLineEnd' },
    ...macBindings,
  ]
}

function documentBoundaryBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  if (platform === 'mac') {
    return [
      { hotkey: key('ArrowUp', { meta: true }), command: 'cursorDocumentStart' },
      { hotkey: key('ArrowDown', { meta: true }), command: 'cursorDocumentEnd' },
    ]
  }

  return [
    { hotkey: key('Home', { ctrl: true }), command: 'cursorDocumentStart' },
    { hotkey: key('End', { ctrl: true }), command: 'cursorDocumentEnd' },
  ]
}

function documentBoundarySelectionBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  if (platform === 'mac') {
    return [
      { hotkey: key('ArrowUp', { meta: true, shift: true }), command: 'selectDocumentStart' },
      { hotkey: key('ArrowDown', { meta: true, shift: true }), command: 'selectDocumentEnd' },
    ]
  }

  return [
    { hotkey: key('Home', { ctrl: true, shift: true }), command: 'selectDocumentStart' },
    { hotkey: key('End', { ctrl: true, shift: true }), command: 'selectDocumentEnd' },
  ]
}
