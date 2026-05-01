import {
  Editor,
  type DocumentSessionChange,
  type EditorChangeHandler,
  type EditorCommandContext,
  type EditorCommandId,
  type EditorEditInput,
  type EditorEditOptions,
  type EditorOpenDocumentOptions,
  type EditorOptions,
  type EditorPlugin,
  type EditorScrollPosition,
  type EditorSetTextOptions,
  type EditorState,
  type EditorSyntaxLanguageId,
  type EditorViewContributionUpdateKind,
  type EditorViewSnapshot,
  type HiddenCharactersMode,
  type EditorTheme,
} from "@editor/core";
import { batch, createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js";

export type SolidEditorReactiveValue<T> = T | Accessor<T>;

export type SolidEditorDocument = {
  readonly documentId?: string;
  readonly revision?: string | number;
  readonly text: string;
  readonly languageId?: EditorSyntaxLanguageId | null;
  readonly scrollPosition?: EditorScrollPosition;
};

export type SolidEditorSelection = {
  readonly anchor: number;
  readonly head?: number;
  readonly revealOffset?: number;
};

export type SolidEditorOptions = Omit<EditorOptions, "hiddenCharacters" | "onChange" | "theme"> & {
  readonly document?: SolidEditorReactiveValue<SolidEditorDocument | null | undefined>;
  readonly theme?: SolidEditorReactiveValue<EditorTheme | null | undefined>;
  readonly hiddenCharacters?: SolidEditorReactiveValue<HiddenCharactersMode | undefined>;
  readonly selection?: SolidEditorReactiveValue<SolidEditorSelection | null | undefined>;
  readonly scrollPosition?: SolidEditorReactiveValue<EditorScrollPosition | null | undefined>;
  readonly onChange?: EditorChangeHandler;
};

export type SolidEditorCommands = {
  focus(): void;
  openDocument(document: EditorOpenDocumentOptions): void;
  setText(text: string, options?: EditorSetTextOptions): void;
  edit(editOrEdits: EditorEditInput, options?: EditorEditOptions): void;
  setSelection(anchor: number, head?: number, revealOffset?: number): void;
  setScrollPosition(scrollPosition: EditorScrollPosition): void;
  dispatchCommand(command: EditorCommandId, context?: EditorCommandContext): boolean;
  openFind(): boolean;
  openFindReplace(): boolean;
  closeFind(): boolean;
  findNext(): boolean;
  findPrevious(): boolean;
  replaceOne(): boolean;
  replaceAll(): boolean;
  selectAllMatches(): boolean;
};

export type SolidEditorController = {
  mount(element: HTMLElement): void;
  editor: Accessor<Editor | null>;
  state: Accessor<EditorState | null>;
  snapshot: Accessor<EditorViewSnapshot | null>;
  text: Accessor<string>;
  lastChange: Accessor<DocumentSessionChange | null>;
  updateKind: Accessor<EditorViewContributionUpdateKind | null>;
  dispose(): void;
  readonly commands: SolidEditorCommands;
};

type SolidEditorRuntime = {
  readonly getEditor: Accessor<Editor | null>;
  readonly setEditor: (editor: Editor | null) => void;
  readonly setState: (state: EditorState | null) => void;
  readonly setSnapshot: (snapshot: EditorViewSnapshot | null) => void;
  readonly setText: (text: string) => void;
  readonly setLastChange: (change: DocumentSessionChange | null) => void;
  readonly setUpdateKind: (kind: EditorViewContributionUpdateKind | null) => void;
};

const NO_DOCUMENT = Symbol("no-document");

export function createEditor(options: SolidEditorOptions = {}): SolidEditorController {
  const [editor, setEditor] = createSignal<Editor | null>(null);
  const [state, setState] = createSignal<EditorState | null>(null);
  const [snapshot, setSnapshot] = createSignal<EditorViewSnapshot | null>(null);
  const [text, setText] = createSignal("");
  const [lastChange, setLastChange] = createSignal<DocumentSessionChange | null>(null);
  const [updateKind, setUpdateKind] = createSignal<EditorViewContributionUpdateKind | null>(null);
  const runtime = {
    getEditor: editor,
    setEditor,
    setState,
    setSnapshot,
    setText,
    setLastChange,
    setUpdateKind,
  } satisfies SolidEditorRuntime;
  const documentState = createDocumentState();

  const dispose = (): void => {
    disposeEditor(runtime);
    documentState.clear();
  };

  const mount = (element: HTMLElement): void => {
    dispose();
    mountEditor(element, options, runtime, documentState);
  };

  createReactiveEffects(options, runtime, documentState);
  onCleanup(dispose);

  return {
    mount,
    editor,
    state,
    snapshot,
    text,
    lastChange,
    updateKind,
    dispose,
    commands: createCommands(editor, documentState),
  };
}

function mountEditor(
  element: HTMLElement,
  options: SolidEditorOptions,
  runtime: SolidEditorRuntime,
  documentState: SolidEditorDocumentState,
): void {
  const instance = new Editor(element, createConstructorOptions(options, runtime));

  batch(() => {
    runtime.setEditor(instance);
    runtime.setState(instance.getState());
    runtime.setText(instance.getText());
  });

  untrack(() => {
    syncDocument(instance, readReactive(options.document), documentState);
    syncTheme(instance, readReactive(options.theme));
    syncHiddenCharacters(instance, readReactive(options.hiddenCharacters));
    syncSelection(instance, readReactive(options.selection));
    syncScrollPosition(instance, readReactive(options.scrollPosition));
  });
}

function createConstructorOptions(
  options: SolidEditorOptions,
  runtime: SolidEditorRuntime,
): EditorOptions {
  const {
    document: _document,
    hiddenCharacters,
    onChange,
    plugins,
    scrollPosition: _scrollPosition,
    selection: _selection,
    theme,
    ...constructorOptions
  } = options;

  return {
    ...constructorOptions,
    hiddenCharacters: untrack(() => readReactive(hiddenCharacters)),
    theme: untrack(() => readReactive(theme) ?? undefined),
    plugins: [createSolidSyncPlugin(runtime), ...(plugins ?? [])],
    onChange: (state, change) => {
      syncChange(runtime, state, change);
      onChange?.(state, change);
    },
  };
}

function createReactiveEffects(
  options: SolidEditorOptions,
  runtime: SolidEditorRuntime,
  documentState: SolidEditorDocumentState,
): void {
  createEffect(() =>
    syncDocument(runtime.getEditor(), readReactive(options.document), documentState),
  );
  createEffect(() => syncTheme(runtime.getEditor(), readReactive(options.theme)));
  createEffect(() =>
    syncHiddenCharacters(runtime.getEditor(), readReactive(options.hiddenCharacters)),
  );
  createEffect(() => syncSelection(runtime.getEditor(), readReactive(options.selection)));
  createEffect(() => syncScrollPosition(runtime.getEditor(), readReactive(options.scrollPosition)));
}

function createSolidSyncPlugin(runtime: SolidEditorRuntime): EditorPlugin {
  return {
    name: "solid-editor-sync",
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          update: (snapshot, kind, change) => syncSnapshot(runtime, snapshot, kind, change ?? null),
          dispose: () => undefined,
        }),
      }),
  };
}

function syncSnapshot(
  runtime: SolidEditorRuntime,
  snapshot: EditorViewSnapshot,
  kind: EditorViewContributionUpdateKind,
  change: DocumentSessionChange | null,
): void {
  batch(() => {
    runtime.setSnapshot(snapshot);
    runtime.setText(snapshot.text);
    runtime.setLastChange(change);
    runtime.setUpdateKind(kind);
  });
}

function syncChange(
  runtime: SolidEditorRuntime,
  state: EditorState,
  change: DocumentSessionChange | null,
): void {
  const editor = runtime.getEditor();

  batch(() => {
    runtime.setState(state);
    runtime.setText(editor?.getText() ?? "");
    runtime.setLastChange(change);
  });
}

function syncDocument(
  editor: Editor | null,
  document: SolidEditorDocument | null | undefined,
  state: SolidEditorDocumentState,
): void {
  if (!editor) return;

  const key = documentKey(document);
  if (key === state.key()) return;

  state.setKey(key);
  if (!document) {
    editor.clearDocument();
    return;
  }

  editor.openDocument({
    documentId: document.documentId,
    languageId: document.languageId,
    scrollPosition: document.scrollPosition,
    text: document.text,
  });
}

function syncTheme(editor: Editor | null, theme: EditorTheme | null | undefined): void {
  if (!editor) return;

  editor.setTheme(theme);
}

function syncHiddenCharacters(
  editor: Editor | null,
  hiddenCharacters: HiddenCharactersMode | undefined,
): void {
  if (!editor || hiddenCharacters === undefined) return;

  editor.setHiddenCharacters(hiddenCharacters);
}

function syncSelection(
  editor: Editor | null,
  selection: SolidEditorSelection | null | undefined,
): void {
  if (!editor || !selection) return;

  editor.setSelection(selection.anchor, selection.head, selection.revealOffset);
}

function syncScrollPosition(
  editor: Editor | null,
  scrollPosition: EditorScrollPosition | null | undefined,
): void {
  if (!editor || !scrollPosition) return;

  editor.setScrollPosition(scrollPosition);
}

function disposeEditor(runtime: SolidEditorRuntime): void {
  const editor = runtime.getEditor();
  if (!editor) return;

  editor.dispose();
  batch(() => {
    runtime.setEditor(null);
    runtime.setState(null);
    runtime.setSnapshot(null);
    runtime.setText("");
    runtime.setLastChange(null);
    runtime.setUpdateKind(null);
  });
}

function createCommands(
  editor: Accessor<Editor | null>,
  documentState: SolidEditorDocumentState,
): SolidEditorCommands {
  return {
    focus: () => editor()?.focus(),
    openDocument: (document) => {
      documentState.setKey(documentKey(document));
      editor()?.openDocument(document);
    },
    setText: (text, options) => editor()?.setText(text, options),
    edit: (editOrEdits, options) => editor()?.edit(editOrEdits, options),
    setSelection: (anchor, head, revealOffset) =>
      editor()?.setSelection(anchor, head, revealOffset),
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
  };
}

type SolidEditorDocumentState = {
  key(): SolidEditorDocumentKey;
  setKey(key: SolidEditorDocumentKey): void;
  clear(): void;
};

type SolidEditorDocumentKey = string | typeof NO_DOCUMENT;

function createDocumentState(): SolidEditorDocumentState {
  let key: SolidEditorDocumentKey = NO_DOCUMENT;

  return {
    key: () => key,
    setKey: (nextKey) => {
      key = nextKey;
    },
    clear: () => {
      key = NO_DOCUMENT;
    },
  };
}

function documentKey(document: SolidEditorDocument | null | undefined): SolidEditorDocumentKey {
  if (!document) return NO_DOCUMENT;

  return `${document.documentId ?? ""}\u0000${document.revision ?? ""}`;
}

function readReactive<T>(value: SolidEditorReactiveValue<T> | undefined): T | undefined {
  if (typeof value !== "function") return value;

  return (value as Accessor<T>)();
}
