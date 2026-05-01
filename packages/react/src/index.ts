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
  type EditorTheme,
  type EditorViewContributionUpdateKind,
  type EditorViewSnapshot,
  type HiddenCharactersMode,
} from "@editor/core";
import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from "react";

export type ReactEditorDocument = {
  readonly documentId?: string;
  readonly revision?: string | number;
  readonly text: string;
  readonly languageId?: EditorSyntaxLanguageId | null;
  readonly scrollPosition?: EditorScrollPosition;
};

export type ReactEditorSelection = {
  readonly anchor: number;
  readonly head?: number;
  readonly revealOffset?: number;
};

export type ReactEditorOptions = Omit<EditorOptions, "hiddenCharacters" | "onChange" | "theme"> & {
  readonly document?: ReactEditorDocument | null | undefined;
  readonly theme?: EditorTheme | null | undefined;
  readonly hiddenCharacters?: HiddenCharactersMode | undefined;
  readonly selection?: ReactEditorSelection | null | undefined;
  readonly scrollPosition?: EditorScrollPosition | null | undefined;
  readonly onChange?: EditorChangeHandler;
};

export type ReactEditorCommands = {
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

export type ReactEditorStoreSnapshot = {
  readonly editor: Editor | null;
  readonly state: EditorState | null;
  readonly snapshot: EditorViewSnapshot | null;
  readonly text: string;
  readonly lastChange: DocumentSessionChange | null;
  readonly updateKind: EditorViewContributionUpdateKind | null;
};

export type ReactEditorSelector<T> = (snapshot: ReactEditorStoreSnapshot) => T;
export type ReactEditorSelectorEquality<T> = (current: T, next: T) => boolean;

export type ReactEditorController = {
  mount(element: HTMLElement): void;
  dispose(): void;
  getEditor(): Editor | null;
  getState(): EditorState | null;
  getSnapshot(): EditorViewSnapshot | null;
  getText(): string;
  getLastChange(): DocumentSessionChange | null;
  getUpdateKind(): EditorViewContributionUpdateKind | null;
  useEditorInstance(): Editor | null;
  useState(): EditorState | null;
  useSnapshot(): EditorViewSnapshot | null;
  useText(): string;
  useLastChange(): DocumentSessionChange | null;
  useUpdateKind(): EditorViewContributionUpdateKind | null;
  readonly commands: ReactEditorCommands;
};

export type EditorHostProps = {
  readonly controller: ReactEditorController;
  readonly className?: string;
  readonly style?: CSSProperties;
};

type ReactEditorStorePatch = Partial<ReactEditorStoreSnapshot>;

type ReactEditorSelectorSubscription<T> = {
  selector: ReactEditorSelector<T>;
  isEqual: ReactEditorSelectorEquality<T>;
  value: T;
  notify: (() => void) | null;
};

type ReactEditorDocumentState = {
  key(): ReactEditorDocumentKey;
  setKey(key: ReactEditorDocumentKey): void;
  clear(): void;
};

type ReactEditorDocumentKey = string | typeof NO_DOCUMENT;

type ReactEditorControllerPrivate = ReactEditorController & {
  readonly [CONTROLLER_PRIVATE]: ReactEditorControllerImplementation;
};

const CONTROLLER_PRIVATE = Symbol("controller-private");
const NO_DOCUMENT = Symbol("no-document");
const useEditorLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

const selectEditor = (snapshot: ReactEditorStoreSnapshot): Editor | null => snapshot.editor;
const selectState = (snapshot: ReactEditorStoreSnapshot): EditorState | null => snapshot.state;
const selectSnapshot = (snapshot: ReactEditorStoreSnapshot): EditorViewSnapshot | null =>
  snapshot.snapshot;
const selectText = (snapshot: ReactEditorStoreSnapshot): string => snapshot.text;
const selectLastChange = (snapshot: ReactEditorStoreSnapshot): DocumentSessionChange | null =>
  snapshot.lastChange;
const selectUpdateKind = (
  snapshot: ReactEditorStoreSnapshot,
): EditorViewContributionUpdateKind | null => snapshot.updateKind;

export function useEditor(options: ReactEditorOptions = {}): ReactEditorController {
  const controllerRef = useRef<ReactEditorControllerImplementation | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = new ReactEditorControllerImplementation(options);
  }

  const controller = controllerRef.current;
  controller.setOptions(options);
  useControlledOptionSync(controller, options);
  useEffect(() => () => controller.dispose(), [controller]);

  return controller;
}

export function EditorHost({ controller, className, style }: EditorHostProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEditorLayoutEffect(() => {
    const element = hostRef.current;
    if (!element) return;

    controller.mount(element);
    return () => controller.dispose();
  }, [controller]);

  return createElement("div", { ref: hostRef, className, style });
}

export function useEditorSelector<T>(
  controller: ReactEditorController,
  selector: ReactEditorSelector<T>,
  isEqual: ReactEditorSelectorEquality<T> = Object.is,
): T {
  const store = internalController(controller).store;
  const subscriptionRef = useRef<ReactEditorSelectorSubscription<T> | null>(null);

  if (!subscriptionRef.current) {
    subscriptionRef.current = store.createSubscription(selector, isEqual);
  }

  const subscription = subscriptionRef.current;
  store.refreshSubscription(subscription, selector, isEqual);

  const subscribe = useCallback(
    (notify: () => void) => store.subscribe(subscription, notify),
    [store, subscription],
  );
  const getSnapshot = useCallback(() => subscription.value, [subscription]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

class ReactEditorControllerImplementation implements ReactEditorController {
  public readonly [CONTROLLER_PRIVATE] = this;
  public readonly store = new ReactEditorStore();
  public readonly commands: ReactEditorCommands;
  private readonly documentState = createDocumentState();
  private options: ReactEditorOptions;

  public constructor(options: ReactEditorOptions) {
    this.options = options;
    this.commands = createCommands(() => this.getEditor(), this.documentState);
  }

  public mount(element: HTMLElement): void {
    this.dispose();
    this.mountEditor(element);
  }

  public dispose(): void {
    disposeEditor(this.store);
    this.documentState.clear();
  }

  public setOptions(options: ReactEditorOptions): void {
    this.options = options;
  }

  public getEditor(): Editor | null {
    return this.store.read().editor;
  }

  public getState(): EditorState | null {
    return this.store.read().state;
  }

  public getSnapshot(): EditorViewSnapshot | null {
    return this.store.read().snapshot;
  }

  public getText(): string {
    return this.store.read().text;
  }

  public getLastChange(): DocumentSessionChange | null {
    return this.store.read().lastChange;
  }

  public getUpdateKind(): EditorViewContributionUpdateKind | null {
    return this.store.read().updateKind;
  }

  public readonly useEditorInstance = (): Editor | null => useEditorSelector(this, selectEditor);
  public readonly useState = (): EditorState | null => useEditorSelector(this, selectState);
  public readonly useSnapshot = (): EditorViewSnapshot | null =>
    useEditorSelector(this, selectSnapshot);
  public readonly useText = (): string => useEditorSelector(this, selectText);
  public readonly useLastChange = (): DocumentSessionChange | null =>
    useEditorSelector(this, selectLastChange);
  public readonly useUpdateKind = (): EditorViewContributionUpdateKind | null =>
    useEditorSelector(this, selectUpdateKind);

  public syncDocumentOption(): void {
    syncDocument(this.getEditor(), this.options.document, this.documentState);
  }

  public syncThemeOption(): void {
    syncTheme(this.getEditor(), this.options.theme);
  }

  public syncHiddenCharactersOption(): void {
    syncHiddenCharacters(this.getEditor(), this.options.hiddenCharacters);
  }

  public syncSelectionOption(): void {
    syncSelection(this.getEditor(), this.options.selection);
  }

  public syncScrollPositionOption(): void {
    syncScrollPosition(this.getEditor(), this.options.scrollPosition);
  }

  public syncSnapshot(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null,
  ): void {
    this.store.update({
      snapshot,
      text: snapshot.text,
      lastChange: change,
      updateKind: kind,
    });
  }

  public syncChange(state: EditorState, change: DocumentSessionChange | null): void {
    this.store.update({
      state,
      text: this.getEditor()?.getText() ?? "",
      lastChange: change,
    });
  }

  private mountEditor(element: HTMLElement): void {
    const instance = new Editor(element, this.createConstructorOptions());

    this.store.update({
      editor: instance,
      state: instance.getState(),
      text: instance.getText(),
    });
    this.syncMountedOptions(instance);
  }

  private createConstructorOptions(): EditorOptions {
    const {
      document: _document,
      hiddenCharacters,
      onChange: _onChange,
      plugins,
      scrollPosition: _scrollPosition,
      selection: _selection,
      theme,
      ...constructorOptions
    } = this.options;

    return {
      ...constructorOptions,
      hiddenCharacters,
      theme: theme ?? undefined,
      plugins: [createReactSyncPlugin(this), ...(plugins ?? [])],
      onChange: (state, change) => {
        this.syncChange(state, change);
        this.options.onChange?.(state, change);
      },
    };
  }

  private syncMountedOptions(editor: Editor): void {
    syncDocument(editor, this.options.document, this.documentState);
    syncTheme(editor, this.options.theme);
    syncHiddenCharacters(editor, this.options.hiddenCharacters);
    syncSelection(editor, this.options.selection);
    syncScrollPosition(editor, this.options.scrollPosition);
  }
}

class ReactEditorStore {
  private snapshot = createEmptyStoreSnapshot();
  private readonly subscriptions = new Set<ReactEditorSelectorSubscription<unknown>>();
  private version = 0;

  public read(): ReactEditorStoreSnapshot {
    return this.snapshot;
  }

  public update(patch: ReactEditorStorePatch): void {
    if (!hasStorePatchChange(this.snapshot, patch)) return;

    this.snapshot = { ...this.snapshot, ...patch };
    this.version += 1;
    this.notify();
  }

  public createSubscription<T>(
    selector: ReactEditorSelector<T>,
    isEqual: ReactEditorSelectorEquality<T>,
  ): ReactEditorSelectorSubscription<T> {
    return {
      selector,
      isEqual,
      value: selector(this.snapshot),
      notify: null,
    };
  }

  public refreshSubscription<T>(
    subscription: ReactEditorSelectorSubscription<T>,
    selector: ReactEditorSelector<T>,
    isEqual: ReactEditorSelectorEquality<T>,
  ): void {
    subscription.selector = selector;
    subscription.isEqual = isEqual;
    this.refreshSubscriptionValue(subscription);
  }

  public subscribe<T>(
    subscription: ReactEditorSelectorSubscription<T>,
    notify: () => void,
  ): () => void {
    subscription.notify = notify;
    this.refreshSubscriptionValue(subscription);
    this.subscriptions.add(subscription as ReactEditorSelectorSubscription<unknown>);

    return () => {
      this.subscriptions.delete(subscription as ReactEditorSelectorSubscription<unknown>);
      subscription.notify = null;
    };
  }

  private notify(): void {
    for (const subscription of this.subscriptions) {
      this.notifySubscription(subscription);
    }
  }

  private notifySubscription<T>(subscription: ReactEditorSelectorSubscription<T>): void {
    const nextValue = subscription.selector(this.snapshot);
    if (subscription.isEqual(subscription.value, nextValue)) return;

    subscription.value = nextValue;
    subscription.notify?.();
  }

  private refreshSubscriptionValue<T>(subscription: ReactEditorSelectorSubscription<T>): void {
    const nextValue = subscription.selector(this.snapshot);
    if (subscription.isEqual(subscription.value, nextValue)) return;

    subscription.value = nextValue;
  }
}

function useControlledOptionSync(
  controller: ReactEditorControllerImplementation,
  options: ReactEditorOptions,
): void {
  const documentIdentity = documentKey(options.document);
  const selection = options.selection;
  const scrollPosition = options.scrollPosition;

  useEditorLayoutEffect(() => controller.syncDocumentOption(), [controller, documentIdentity]);
  useEditorLayoutEffect(() => controller.syncThemeOption(), [controller, options.theme]);
  useEditorLayoutEffect(
    () => controller.syncHiddenCharactersOption(),
    [controller, options.hiddenCharacters],
  );
  useEditorLayoutEffect(
    () => controller.syncSelectionOption(),
    [controller, selection?.anchor, selection?.head, selection?.revealOffset],
  );
  useEditorLayoutEffect(
    () => controller.syncScrollPositionOption(),
    [controller, scrollPosition?.top, scrollPosition?.left],
  );
}

function createReactSyncPlugin(controller: ReactEditorControllerImplementation): EditorPlugin {
  return {
    name: "react-editor-sync",
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          update: (snapshot, kind, change) =>
            controller.syncSnapshot(snapshot, kind, change ?? null),
          dispose: () => undefined,
        }),
      }),
  };
}

function syncDocument(
  editor: Editor | null,
  document: ReactEditorDocument | null | undefined,
  state: ReactEditorDocumentState,
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
  selection: ReactEditorSelection | null | undefined,
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

function disposeEditor(store: ReactEditorStore): void {
  const editor = store.read().editor;
  editor?.dispose();
  store.update(createEmptyStoreSnapshot());
}

function createCommands(
  editor: () => Editor | null,
  documentState: ReactEditorDocumentState,
): ReactEditorCommands {
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

function createDocumentState(): ReactEditorDocumentState {
  let key: ReactEditorDocumentKey = NO_DOCUMENT;

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

function documentKey(
  document:
    | (Readonly<{ readonly documentId?: string; readonly revision?: string | number }> & object)
    | null
    | undefined,
): ReactEditorDocumentKey {
  if (!document) return NO_DOCUMENT;

  return `${document.documentId ?? ""}\u0000${document.revision ?? ""}`;
}

function createEmptyStoreSnapshot(): ReactEditorStoreSnapshot {
  return {
    editor: null,
    state: null,
    snapshot: null,
    text: "",
    lastChange: null,
    updateKind: null,
  };
}

function hasStorePatchChange(
  snapshot: ReactEditorStoreSnapshot,
  patch: ReactEditorStorePatch,
): boolean {
  for (const key of Object.keys(patch) as (keyof ReactEditorStoreSnapshot)[]) {
    if (!Object.is(snapshot[key], patch[key])) return true;
  }

  return false;
}

function internalController(
  controller: ReactEditorController,
): ReactEditorControllerImplementation {
  return (controller as ReactEditorControllerPrivate)[CONTROLLER_PRIVATE];
}
