import {
  createEditorOptionSync,
  EDITOR_OPTION_DESCRIPTORS,
  type EditorControlledOptionName,
  type EditorControlledSelection,
  type EditorOptionSync,
} from '@singapor/core'
import {
  Editor,
  type EditorChangeHandler,
  type EditorCommandContext,
  type EditorCommandId,
  type EditorDocumentMode,
  type EditorEditability,
  type EditorEditInput,
  type EditorEditOptions,
  type EditorKeymapOptions,
  type EditorOpenDocumentOptions,
  type EditorOptions,
  type EditorRangeDecoration,
  type EditorScrollMode,
  type EditorScrollPosition,
  type EditorSelectionRevealTarget,
  type EditorSetTextOptions,
  type EditorState,
  type EditorSuspiciousCharactersOptions,
} from '@singapor/core/editor'
import type { DocumentSessionChange, TextSnapshot } from '@singapor/core/document'
import type { EditorSyntaxLanguageId } from '@singapor/core/syntax'
import type { EditorTheme, HiddenCharactersMode } from '@singapor/core/rendering'
import type {
  EditorPlugin,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import { batch, createEffect, createSignal, onCleanup, untrack, type Accessor } from 'solid-js'

export type SolidEditorReactiveValue<T> = T | Accessor<T>

export type SolidEditorDocument = {
  readonly documentId?: string
  readonly revision?: string | number
  readonly text: string
  readonly documentMode?: EditorDocumentMode
  readonly languageId?: EditorSyntaxLanguageId | null
  readonly scrollPosition?: EditorScrollPosition
}

export type SolidEditorSelection = EditorControlledSelection

export type SolidEditorOptions = Omit<
  EditorOptions,
  | 'editability'
  | 'hiddenCharacters'
  | 'keymap'
  | 'lineHeight'
  | 'onChange'
  | 'rangeDecorations'
  | 'rowGap'
  | 'scrollMode'
  | 'suspiciousCharacters'
  | 'tabMovesFocus'
  | 'theme'
  | 'wordWrap'
> & {
  readonly document?: SolidEditorReactiveValue<SolidEditorDocument | null | undefined>
  readonly editability?: SolidEditorReactiveValue<EditorEditability | undefined>
  readonly theme?: SolidEditorReactiveValue<EditorTheme | null | undefined>
  readonly hiddenCharacters?: SolidEditorReactiveValue<HiddenCharactersMode | undefined>
  readonly keymap?: SolidEditorReactiveValue<EditorKeymapOptions | undefined>
  readonly lineHeight?: SolidEditorReactiveValue<number | undefined>
  readonly rangeDecorations?: SolidEditorReactiveValue<readonly EditorRangeDecoration[] | undefined>
  readonly rowGap?: SolidEditorReactiveValue<number | undefined>
  readonly scrollMode?: SolidEditorReactiveValue<EditorScrollMode | undefined>
  readonly selection?: SolidEditorReactiveValue<SolidEditorSelection | null | undefined>
  readonly scrollPosition?: SolidEditorReactiveValue<EditorScrollPosition | null | undefined>
  readonly suspiciousCharacters?: SolidEditorReactiveValue<
    EditorSuspiciousCharactersOptions | undefined
  >
  readonly tabMovesFocus?: SolidEditorReactiveValue<boolean | undefined>
  readonly wordWrap?: SolidEditorReactiveValue<boolean | undefined>
  readonly onChange?: EditorChangeHandler
}

export type SolidEditorCommands = {
  focus(): void
  openDocument(document: EditorOpenDocumentOptions): void
  setText(text: string, options?: EditorSetTextOptions): void
  edit(editOrEdits: EditorEditInput, options?: EditorEditOptions): void
  setSelection(anchor: number, head?: number, reveal?: EditorSelectionRevealTarget): void
  setScrollPosition(scrollPosition: EditorScrollPosition): void
  dispatchCommand(command: EditorCommandId, context?: EditorCommandContext): boolean
  openFind(): boolean
  openFindReplace(): boolean
  closeFind(): boolean
  findNext(): boolean
  findPrevious(): boolean
  replaceOne(): boolean
  replaceAll(): boolean
  selectAllMatches(): boolean
}

export type SolidEditorController = {
  mount(element: HTMLElement): void
  editor: Accessor<Editor | null>
  state: Accessor<EditorState | null>
  snapshot: Accessor<EditorViewSnapshot | null>
  textSnapshot: Accessor<TextSnapshot | null>
  fullText: Accessor<string>
  lastChange: Accessor<DocumentSessionChange | null>
  updateKind: Accessor<EditorViewContributionUpdateKind | null>
  dispose(): void
  readonly commands: SolidEditorCommands
}

type SolidEditorRuntime = {
  readonly getEditor: Accessor<Editor | null>
  readonly setEditor: (editor: Editor | null) => void
  readonly setState: (state: EditorState | null) => void
  readonly setSnapshot: (snapshot: EditorViewSnapshot | null) => void
  readonly setTextSnapshot: (snapshot: TextSnapshot | null) => void
  readonly setLastChange: (change: DocumentSessionChange | null) => void
  readonly setUpdateKind: (kind: EditorViewContributionUpdateKind | null) => void
}

const NO_DOCUMENT = Symbol('no-document')

export function createEditor(options: SolidEditorOptions = {}): SolidEditorController {
  const [editor, setEditor] = createSignal<Editor | null>(null)
  const [state, setState] = createSignal<EditorState | null>(null)
  const [snapshot, setSnapshot] = createSignal<EditorViewSnapshot | null>(null)
  const [textSnapshot, setTextSnapshot] = createSignal<TextSnapshot | null>(null)
  const fullText = createLazyFullTextAccessor(textSnapshot)
  const [lastChange, setLastChange] = createSignal<DocumentSessionChange | null>(null)
  const [updateKind, setUpdateKind] = createSignal<EditorViewContributionUpdateKind | null>(null)
  const runtime = {
    getEditor: editor,
    setEditor,
    setState,
    setSnapshot,
    setTextSnapshot,
    setLastChange,
    setUpdateKind,
  } satisfies SolidEditorRuntime
  const documentState = createDocumentState()
  const optionSync = createEditorOptionSync()

  const dispose = (): void => {
    disposeEditor(runtime)
    documentState.clear()
    optionSync.reset()
  }

  const mount = (element: HTMLElement): void => {
    dispose()
    mountEditor(element, options, runtime, documentState, optionSync)
  }

  createReactiveEffects(options, runtime, documentState, optionSync)
  onCleanup(dispose)

  return {
    mount,
    editor,
    state,
    snapshot,
    textSnapshot,
    fullText,
    lastChange,
    updateKind,
    dispose,
    commands: createCommands(editor, documentState),
  }
}

function createLazyFullTextAccessor(textSnapshot: Accessor<TextSnapshot | null>): Accessor<string> {
  let cachedSnapshot: TextSnapshot | null = null
  let cachedText: string | undefined

  return () => {
    const snapshot = textSnapshot()
    if (!snapshot) {
      cachedSnapshot = null
      cachedText = ''
      return cachedText
    }

    if (snapshot === cachedSnapshot && cachedText !== undefined) return cachedText

    cachedSnapshot = snapshot
    cachedText = snapshot.materializeFullText()
    return cachedText
  }
}

function mountEditor(
  element: HTMLElement,
  options: SolidEditorOptions,
  runtime: SolidEditorRuntime,
  documentState: SolidEditorDocumentState,
  optionSync: EditorOptionSync,
): void {
  const instance = new Editor(element, createConstructorOptions(options, runtime))

  batch(() => {
    runtime.setEditor(instance)
    runtime.setState(instance.getState())
    runtime.setTextSnapshot(instance.getTextSnapshot())
  })

  untrack(() => {
    syncDocument(instance, readReactive(options.document), documentState)
    for (const descriptor of EDITOR_OPTION_DESCRIPTORS) {
      optionSync.apply(instance, descriptor, controlledOptionInput(options, descriptor.name))
    }
  })
}

function createConstructorOptions(
  options: SolidEditorOptions,
  runtime: SolidEditorRuntime,
): EditorOptions {
  const {
    document: _document,
    editability,
    hiddenCharacters,
    keymap,
    lineHeight,
    onChange,
    plugins,
    rangeDecorations,
    rowGap,
    scrollMode,
    scrollPosition: _scrollPosition,
    selection: _selection,
    suspiciousCharacters,
    tabMovesFocus,
    theme,
    wordWrap,
    ...constructorOptions
  } = options

  return untrack(
    (): EditorOptions => ({
      ...constructorOptions,
      editability: readReactive(editability),
      hiddenCharacters: readReactive(hiddenCharacters),
      keymap: readReactive(keymap),
      lineHeight: readReactive(lineHeight),
      rangeDecorations: readReactive(rangeDecorations),
      rowGap: readReactive(rowGap),
      scrollMode: readReactive(scrollMode),
      suspiciousCharacters: readReactive(suspiciousCharacters),
      tabMovesFocus: readReactive(tabMovesFocus),
      theme: readReactive(theme) ?? undefined,
      wordWrap: readReactive(wordWrap),
      plugins: [createSolidSyncPlugin(runtime), ...(plugins ?? [])],
      onChange: (state, change) => {
        syncChange(runtime, state, change)
        onChange?.(state, change)
      },
    }),
  )
}

function createReactiveEffects(
  options: SolidEditorOptions,
  runtime: SolidEditorRuntime,
  documentState: SolidEditorDocumentState,
  optionSync: EditorOptionSync,
): void {
  createEffect(() =>
    syncDocument(runtime.getEditor(), readReactive(options.document), documentState),
  )
  // One effect per descriptor, so each option tracks only the source it was given.
  for (const descriptor of EDITOR_OPTION_DESCRIPTORS) {
    createEffect(() =>
      optionSync.apply(
        runtime.getEditor(),
        descriptor,
        controlledOptionInput(options, descriptor.name),
      ),
    )
  }
}

function controlledOptionInput(
  options: SolidEditorOptions,
  name: EditorControlledOptionName,
): unknown {
  return readReactive(options[name] as SolidEditorReactiveValue<unknown>)
}

function createSolidSyncPlugin(runtime: SolidEditorRuntime): EditorPlugin {
  return {
    name: 'solid-editor-sync',
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          update: (snapshot, kind, change) => syncSnapshot(runtime, snapshot, kind, change ?? null),
          dispose: () => undefined,
        }),
      }),
  }
}

function syncSnapshot(
  runtime: SolidEditorRuntime,
  snapshot: EditorViewSnapshot,
  kind: EditorViewContributionUpdateKind,
  change: DocumentSessionChange | null,
): void {
  batch(() => {
    runtime.setSnapshot(snapshot)
    runtime.setTextSnapshot(snapshot.textSnapshot ?? null)
    runtime.setLastChange(change)
    runtime.setUpdateKind(kind)
  })
}

function syncChange(
  runtime: SolidEditorRuntime,
  state: EditorState,
  change: DocumentSessionChange | null,
): void {
  const editor = runtime.getEditor()

  batch(() => {
    runtime.setState(state)
    runtime.setTextSnapshot(editor?.getTextSnapshot() ?? null)
    runtime.setLastChange(change)
  })
}

function syncDocument(
  editor: Editor | null,
  document: SolidEditorDocument | null | undefined,
  state: SolidEditorDocumentState,
): void {
  if (!editor) return

  const key = documentKey(document)
  if (key === state.key()) return

  state.setKey(key)
  if (!document) {
    editor.clearDocument()
    return
  }

  editor.openDocument({
    documentId: document.documentId,
    documentMode: document.documentMode,
    languageId: document.languageId,
    scrollPosition: document.scrollPosition,
    text: document.text,
  })
}

function disposeEditor(runtime: SolidEditorRuntime): void {
  const editor = runtime.getEditor()
  if (!editor) return

  editor.dispose()
  batch(() => {
    runtime.setEditor(null)
    runtime.setState(null)
    runtime.setSnapshot(null)
    runtime.setTextSnapshot(null)
    runtime.setLastChange(null)
    runtime.setUpdateKind(null)
  })
}

function createCommands(
  editor: Accessor<Editor | null>,
  documentState: SolidEditorDocumentState,
): SolidEditorCommands {
  return {
    focus: () => editor()?.focus(),
    openDocument: (document) => {
      documentState.setKey(documentKey(document))
      editor()?.openDocument(document)
    },
    setText: (text, options) => editor()?.setText(text, options),
    edit: (editOrEdits, options) => editor()?.edit(editOrEdits, options),
    setSelection: (anchor, head, reveal) => editor()?.setSelection(anchor, head, reveal),
    setScrollPosition: (scrollPosition) => editor()?.setScrollPosition(scrollPosition),
    dispatchCommand: (command, context) => editor()?.dispatchCommand(command, context) ?? false,
    openFind: () => editor()?.openFind() ?? false,
    openFindReplace: () => editor()?.openFindReplace() ?? false,
    closeFind: () => editor()?.closeFind() ?? false,
    findNext: () => editor()?.findNext() ?? false,
    findPrevious: () => editor()?.findPrevious() ?? false,
    replaceOne: () => editor()?.replaceOne() ?? false,
    replaceAll: () => editor()?.replaceAll() ?? false,
    selectAllMatches: () => editor()?.selectAllMatches() ?? false,
  }
}

type SolidEditorDocumentState = {
  key(): SolidEditorDocumentKey
  setKey(key: SolidEditorDocumentKey): void
  clear(): void
}

type SolidEditorDocumentKey = string | typeof NO_DOCUMENT

function createDocumentState(): SolidEditorDocumentState {
  let key: SolidEditorDocumentKey = NO_DOCUMENT

  return {
    key: () => key,
    setKey: (nextKey) => {
      key = nextKey
    },
    clear: () => {
      key = NO_DOCUMENT
    },
  }
}

function documentKey(document: SolidEditorDocument | null | undefined): SolidEditorDocumentKey {
  if (!document) return NO_DOCUMENT

  return `${document.documentId ?? ''}\u0000${document.documentMode ?? ''}\u0000${
    document.revision ?? ''
  }`
}

function readReactive<T>(value: SolidEditorReactiveValue<T> | undefined): T | undefined {
  if (typeof value !== 'function') return value

  return (value as Accessor<T>)()
}
