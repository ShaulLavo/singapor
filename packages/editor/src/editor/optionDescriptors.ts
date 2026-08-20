import { normalizeEditorEditability } from './editorDocument'
import { normalizeRowGap, normalizeScrollMode } from '../virtualization/virtualizedTextViewHelpers'
import { normalizeHiddenCharactersMode } from '../virtualization/virtualizedTextViewHiddenCharacters'
import {
  type EditorSuspiciousCharactersOptions,
  normalizeSuspiciousCharactersOptions,
  sameSuspiciousCharactersOptions,
} from '../unicodeHighlight'
import type { Editor } from './Editor'
import type { EditorKeymapOptions } from './keymap'
import type { EditorSelectionRevealTarget } from './selectionReveal'
import type {
  EditorEditability,
  EditorRangeDecoration,
  EditorScrollMode,
  EditorScrollPosition,
} from './types'
import type { EditorTheme } from '../theme'
import type { HiddenCharactersMode } from '../virtualization/virtualizedTextViewTypes'

/** Selection driven from outside the editor, in the shape `setSelection` consumes. */
export type EditorControlledSelection = {
  readonly anchor: number
  readonly head?: number
  readonly reveal?: boolean
  readonly revealOffset?: number
}

type EditorControlledOptions = {
  readonly editability?: EditorEditability
  readonly hiddenCharacters?: HiddenCharactersMode
  readonly keymap?: EditorKeymapOptions
  readonly rangeDecorations?: readonly EditorRangeDecoration[]
  readonly rowGap?: number
  readonly scrollMode?: EditorScrollMode
  readonly scrollPosition?: EditorScrollPosition | null
  readonly selection?: EditorControlledSelection | null
  readonly suspiciousCharacters?: EditorSuspiciousCharactersOptions
  readonly tabMovesFocus?: boolean
  readonly theme?: EditorTheme | null
}

export type EditorControlledOptionName = keyof EditorControlledOptions

type EditorControlledOptionValue = EditorControlledOptions[EditorControlledOptionName]

type EditorOptionDefinition<K extends EditorControlledOptionName> = {
  readonly name: K
  // Read by nothing on the way to the editor: it stands next to the validator that has to
  // produce it, so the validator can be held to it.
  readonly defaultValue: EditorControlledOptions[K]
  // Whatever comes back reaches the editor unfiltered, so input the option cannot use has to
  // leave here as a value the option can live with rather than as a failure.
  validate(input: unknown): EditorControlledOptions[K]
  /**
   * Guards the setter call. Object identity is enough for the options whose setters already
   * compare contents before doing work; the ones a host rebuilds inline on every update compare
   * field by field, so an unchanged value never re-enters the editor and overrides the user.
   */
  equals(left: EditorControlledOptions[K], right: EditorControlledOptions[K]): boolean
  /**
   * `undefined` arrives here rather than being filtered out earlier, because its meaning is
   * per-option: where the setter is also the reset path it asks for the editor default, and
   * everywhere else it says this host does not control the option at all.
   */
  applyTo(editor: Editor, value: EditorControlledOptions[K]): void
}

export type EditorOptionDescriptor<
  K extends EditorControlledOptionName = EditorControlledOptionName,
> = EditorOptionDefinition<K> & {
  // Handed out by position when the registry below is built, so it means nothing away from that
  // array — which is what lets change tracking keep its per-option state in a plain dense list.
  readonly id: number
}

export type EditorOptionSync = {
  apply(editor: Editor | null, descriptor: EditorOptionDescriptor, input: unknown): void
  reset(): void
}

type AppliedOption = {
  readonly value: EditorControlledOptionValue
}

/**
 * Every option a host binding keeps in sync with a live editor.
 *
 * Bindings apply options by iterating this array instead of naming options one at a time: a list
 * written out by hand inside a binding drifts from the next binding's list without anything
 * noticing, because nothing relates the two.
 */
export const EDITOR_OPTION_DESCRIPTORS: readonly EditorOptionDescriptor[] = [
  defineOption({
    name: 'editability',
    defaultValue: 'editable',
    validate: (input) =>
      input === undefined ? undefined : normalizeEditorEditability(input as EditorEditability),
    equals: Object.is,
    applyTo: (editor, editability) => {
      if (editability === undefined) return

      editor.setEditability(editability)
    },
  }),
  defineOption({
    name: 'hiddenCharacters',
    defaultValue: 'show-on-selection',
    validate: (input) =>
      input === undefined
        ? undefined
        : normalizeHiddenCharactersMode(input as HiddenCharactersMode),
    equals: Object.is,
    applyTo: (editor, hiddenCharacters) => {
      if (hiddenCharacters === undefined) return

      editor.setHiddenCharacters(hiddenCharacters)
    },
  }),
  defineOption({
    name: 'keymap',
    defaultValue: undefined,
    validate: (input) => (isRecord(input) ? (input as EditorKeymapOptions) : undefined),
    equals: Object.is,
    applyTo: (editor, keymap) => editor.setKeymap(keymap),
  }),
  defineOption({
    name: 'rangeDecorations',
    defaultValue: [],
    validate: (input) => {
      if (input === undefined) return undefined

      return Array.isArray(input) ? (input as readonly EditorRangeDecoration[]) : []
    },
    equals: Object.is,
    applyTo: (editor, rangeDecorations) => {
      if (rangeDecorations === undefined) return

      editor.setRangeDecorations(rangeDecorations)
    },
  }),
  defineOption({
    name: 'rowGap',
    defaultValue: 0,
    validate: (input) => (input === undefined ? undefined : normalizeRowGap(input as number)),
    equals: Object.is,
    applyTo: (editor, rowGap) => {
      if (rowGap === undefined) return

      editor.setRowGap(rowGap)
    },
  }),
  defineOption({
    name: 'scrollMode',
    defaultValue: 'virtualized',
    validate: (input) =>
      input === undefined ? undefined : normalizeScrollMode(input as EditorScrollMode),
    equals: Object.is,
    applyTo: (editor, scrollMode) => editor.setScrollMode(scrollMode),
  }),
  defineOption({
    name: 'selection',
    defaultValue: null,
    validate: (input) => validateSelection(input),
    equals: (left, right) => selectionsEqual(left, right),
    applyTo: (editor, selection) => {
      if (!selection) return

      editor.setSelection(selection.anchor, selection.head, selectionRevealTarget(selection))
    },
  }),
  // After the selection, whose reveal scrolls: a host driving both wants the position it asked
  // for, not the one the caret implied.
  defineOption({
    name: 'scrollPosition',
    defaultValue: null,
    validate: (input) => validateScrollPosition(input),
    equals: (left, right) => scrollPositionsEqual(left, right),
    applyTo: (editor, scrollPosition) => {
      if (!scrollPosition) return

      editor.setScrollPosition(scrollPosition)
    },
  }),
  defineOption({
    name: 'suspiciousCharacters',
    defaultValue: normalizeSuspiciousCharactersOptions(undefined),
    validate: (input) =>
      isRecord(input)
        ? normalizeSuspiciousCharactersOptions(input as EditorSuspiciousCharactersOptions)
        : undefined,
    equals: sameSuspiciousCharactersOptions,
    applyTo: (editor, suspiciousCharacters) => {
      if (suspiciousCharacters === undefined) return

      editor.setSuspiciousCharacters(suspiciousCharacters)
    },
  }),
  defineOption({
    name: 'tabMovesFocus',
    defaultValue: false,
    validate: (input) => (typeof input === 'boolean' ? input : undefined),
    equals: Object.is,
    applyTo: (editor, tabMovesFocus) => {
      if (tabMovesFocus === undefined) return

      editor.setTabMovesFocus(tabMovesFocus)
    },
  }),
  defineOption({
    name: 'theme',
    defaultValue: null,
    validate: (input) => (isRecord(input) ? (input as EditorTheme) : null),
    equals: Object.is,
    applyTo: (editor, theme) => editor.setTheme(theme),
  }),
].map((definition, id): EditorOptionDescriptor => ({ ...definition, id }))

export function createEditorOptionSync(): EditorOptionSync {
  const applied: (AppliedOption | undefined)[] = []

  return {
    apply: (editor, descriptor, input) => {
      if (!editor) return

      const value = descriptor.validate(input)
      const previous = applied[descriptor.id]
      if (previous && descriptor.equals(previous.value, value)) return

      applied[descriptor.id] = { value }
      descriptor.applyTo(editor, value)
    },
    // A new editor knows none of the values this tracker recorded for the previous one.
    reset: () => {
      applied.length = 0
    },
  }
}

function defineOption<K extends EditorControlledOptionName>(
  definition: EditorOptionDefinition<K>,
): EditorOptionDefinition<K> {
  return definition
}

function validateSelection(input: unknown): EditorControlledSelection | null {
  if (!isRecord(input)) return null

  const anchor = validateOffset(input.anchor)
  if (anchor === undefined) return null

  return {
    anchor,
    head: validateOffset(input.head),
    reveal: typeof input.reveal === 'boolean' ? input.reveal : undefined,
    revealOffset: validateOffset(input.revealOffset),
  }
}

function selectionRevealTarget(
  selection: EditorControlledSelection,
): EditorSelectionRevealTarget | undefined {
  if (selection.reveal === false) return { reveal: false }

  return selection.revealOffset
}

function selectionsEqual(
  left: EditorControlledSelection | null | undefined,
  right: EditorControlledSelection | null | undefined,
): boolean {
  if (!left || !right) return left === right

  return (
    left.anchor === right.anchor &&
    left.head === right.head &&
    left.reveal === right.reveal &&
    left.revealOffset === right.revealOffset
  )
}

function validateScrollPosition(input: unknown): EditorScrollPosition | null {
  if (!isRecord(input)) return null

  const top = validateOffset(input.top)
  const left = validateOffset(input.left)
  if (top === undefined && left === undefined) return null

  return { top, left }
}

function scrollPositionsEqual(
  left: EditorScrollPosition | null | undefined,
  right: EditorScrollPosition | null | undefined,
): boolean {
  if (!left || !right) return left === right

  return left.top === right.top && left.left === right.left
}

function validateOffset(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null
}
