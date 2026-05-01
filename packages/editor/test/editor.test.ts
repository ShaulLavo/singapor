import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectPlatform } from "@tanstack/hotkeys";
import { createEditorFindPlugin } from "../../find/src/index.ts";
import { createFoldGutterPlugin, createLineGutterPlugin } from "../../gutters/src/index.ts";
import {
  createDocumentSession,
  createTreeSitterLanguagePlugin,
  Editor,
  resetEditorInstanceCount,
  resolveSelection,
  setEditorSyntaxSessionFactory,
  setHighlightRegistry,
  type DocumentSessionChange,
  type EditorHighlightResult,
  type EditorHighlighterSession,
  type EditorPlugin,
  type EditorTheme,
  type EditorViewContributionContext,
  type EditorViewContributionUpdateKind,
  type EditorViewSnapshot,
  type EditorState,
  type EditorSyntaxResult,
  type EditorSyntaxSession,
  type EditorSyntaxSessionOptions,
} from "../src";

// Mock HighlightRegistry backed by a Map, used to assert highlight state.
const highlightsMap = new Map<string, Highlight>();
const mockRegistry = {
  set: (name: string, highlight: Highlight) => {
    highlightsMap.set(name, highlight);
  },
  delete: (name: string) => highlightsMap.delete(name),
};

// happy-dom doesn't provide the Highlight constructor, so we polyfill it.
class MockHighlight extends Set<Range> {}

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function createSyntaxResult(
  tokens = [{ start: 0, end: 5, style: { color: "#ff0000" } }],
  folds: EditorSyntaxResult["folds"] = [],
) {
  return {
    captures: [],
    folds,
    brackets: [],
    errors: [],
    injections: [],
    tokens,
  } satisfies EditorSyntaxResult;
}

function createMockSyntaxSession(
  overrides: Partial<EditorSyntaxSession> = {},
): EditorSyntaxSession {
  return {
    refresh: async () => createSyntaxResult(),
    applyChange: async () => createSyntaxResult(),
    getResult: () => createSyntaxResult(),
    getTokens: () => [],
    getSnapshotVersion: () => 0,
    dispose: () => undefined,
    ...overrides,
  };
}

function createHighlightResult(
  tokens = [{ start: 0, end: 5, style: { color: "#00ff00" } }],
  theme?: EditorTheme | null,
): EditorHighlightResult {
  if (theme === undefined) return { tokens };
  return { tokens, theme };
}

function createMockHighlighterSession(
  overrides: Partial<EditorHighlighterSession> = {},
): EditorHighlighterSession {
  return {
    refresh: async () => createHighlightResult(),
    applyChange: async () => createHighlightResult(),
    dispose: () => undefined,
    ...overrides,
  };
}

function createHighlighterPlugin(
  session: EditorHighlighterSession,
  options: { readonly loadTheme?: () => Promise<EditorTheme | null | undefined> } = {},
): EditorPlugin {
  return {
    activate: (context) => {
      const provider = {
        createSession: () => session,
      };
      if (!options.loadTheme) return context.registerHighlighter(provider);
      return context.registerHighlighter({ ...provider, loadTheme: options.loadTheme });
    },
  };
}

function createViewContributionPlugin(events: ViewContributionEvent[]): EditorPlugin {
  return {
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          update: (snapshot, kind, change) => {
            events.push({ kind, snapshot, changeKind: change?.kind ?? null });
          },
          dispose: () => {
            events.push({ kind: "dispose", snapshot: null, changeKind: null });
          },
        }),
      }),
  };
}

function requireViewContributionContext(
  context: EditorViewContributionContext | null,
): EditorViewContributionContext {
  if (!context) throw new Error("missing view contribution context");
  return context;
}

function createTestLanguagePlugin(): EditorPlugin {
  return createTreeSitterLanguagePlugin([
    {
      id: "typescript",
      extensions: [".ts"],
      aliases: ["typescript", "ts"],
      wasmUrl: "/typescript.wasm",
    },
  ]);
}

function withTestLanguagePlugins(...plugins: readonly EditorPlugin[]): readonly EditorPlugin[] {
  return [createTestLanguagePlugin(), createEditorFindPlugin(), ...plugins];
}

function withTestGutterPlugins(...plugins: readonly EditorPlugin[]): readonly EditorPlugin[] {
  return withTestLanguagePlugins(createLineGutterPlugin(), createFoldGutterPlugin(), ...plugins);
}

type ViewContributionEvent = {
  readonly kind: EditorViewContributionUpdateKind | "dispose";
  readonly snapshot: EditorViewSnapshot | null;
  readonly changeKind: DocumentSessionChange["kind"] | null;
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushSyntaxDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
  await flushMicrotasks();
}

function createInsertEvent(data: string): InputEvent {
  return new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    data,
    inputType: "insertText",
  });
}

function createLineBreakEvent(): InputEvent {
  return new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "insertLineBreak",
  });
}

function editorRoot(): HTMLElement {
  return document.querySelector(".editor-virtualized") as HTMLElement;
}

function hiddenCharacterKinds(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(".editor-virtualized-hidden-character-marker"),
  ].map((marker) => marker.dataset.editorHiddenCharacter!);
}

function rowTextNode(row = 0): Text {
  const element = document.querySelector(`[data-editor-virtual-row="${row}"]`);
  return element?.firstChild as Text;
}

function setCollapsedDomSelection(offset: number): void {
  const range = document.createRange();
  const textNode = rowTextNode();
  range.setStart(textNode, offset);
  range.setEnd(textNode, offset);

  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  editorRoot().dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

function editorInput(): HTMLTextAreaElement {
  return document.querySelector(".editor-virtualized-input") as HTMLTextAreaElement;
}

function dispatchEditorKey(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...init,
  });
  editorRoot().dispatchEvent(event);
  return event;
}

function createPasteEvent(text: string): ClipboardEvent {
  const clipboardData = {
    getData: (format: string): string => (format === "text/plain" ? text : ""),
    setData: () => undefined,
  };
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { configurable: true, value: clipboardData });
  return event;
}

function createCopyEvent(): {
  readonly event: ClipboardEvent;
  readonly formatCount: () => number;
  readonly getText: () => string;
} {
  const values = new Map<string, string>();
  const clipboardData = {
    getData: (format: string): string => values.get(format) ?? "",
    setData: (format: string, value: string): void => {
      values.set(format, value);
    },
  };
  const event = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { configurable: true, value: clipboardData });

  return {
    event,
    formatCount: () => values.size,
    getText: () => values.get("text/plain") ?? "",
  };
}

function primaryModifier(): KeyboardEventInit {
  return detectPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };
}

function wordNavigationModifier(): KeyboardEventInit {
  return detectPlatform() === "mac" ? { altKey: true } : { ctrlKey: true };
}

function resolvedSelectionRanges(session: ReturnType<typeof createDocumentSession>): readonly {
  readonly anchor: number;
  readonly head: number;
  readonly start: number;
  readonly end: number;
}[] {
  return session.getSelections().selections.map((selection) => {
    const resolved = resolveSelection(session.getSnapshot(), selection);
    return {
      anchor: resolved.anchorOffset,
      head: resolved.headOffset,
      start: resolved.startOffset,
      end: resolved.endOffset,
    };
  });
}

function tokenHighlights(): Highlight[] {
  return [...highlightsMap]
    .filter(([name]) => name.includes("-token-"))
    .map(([, highlight]) => highlight);
}

function tokenHighlightRanges(): AbstractRange[] {
  return tokenHighlights().flatMap((highlight) => [...highlight]);
}

function foldToggle(): HTMLButtonElement {
  return document.querySelector(
    ".editor-virtualized-fold-toggle:not([hidden])",
  ) as HTMLButtonElement;
}

function mockEditorViewport(
  element: HTMLElement,
  width: number,
  height: number,
  scrollHeight = 200,
): void {
  Object.defineProperty(element, "clientHeight", { configurable: true, value: height });
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: height,
      height,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

type ScrollMetricProperty =
  | "clientHeight"
  | "clientWidth"
  | "scrollHeight"
  | "scrollLeft"
  | "scrollTop"
  | "scrollWidth";

function withThrowingScrollMetricReads(element: HTMLElement, callback: () => void): void {
  const descriptors: Record<ScrollMetricProperty, PropertyDescriptor | undefined> = {
    clientHeight: Object.getOwnPropertyDescriptor(element, "clientHeight"),
    clientWidth: Object.getOwnPropertyDescriptor(element, "clientWidth"),
    scrollHeight: Object.getOwnPropertyDescriptor(element, "scrollHeight"),
    scrollLeft: Object.getOwnPropertyDescriptor(element, "scrollLeft"),
    scrollTop: Object.getOwnPropertyDescriptor(element, "scrollTop"),
    scrollWidth: Object.getOwnPropertyDescriptor(element, "scrollWidth"),
  };
  defineThrowingElementProperty(element, "clientHeight");
  defineThrowingElementProperty(element, "clientWidth");
  defineThrowingElementProperty(element, "scrollHeight");
  defineThrowingElementProperty(element, "scrollLeft");
  defineThrowingElementProperty(element, "scrollTop");
  defineThrowingElementProperty(element, "scrollWidth");

  try {
    callback();
  } finally {
    restoreElementProperty(element, "clientHeight", descriptors.clientHeight);
    restoreElementProperty(element, "clientWidth", descriptors.clientWidth);
    restoreElementProperty(element, "scrollHeight", descriptors.scrollHeight);
    restoreElementProperty(element, "scrollLeft", descriptors.scrollLeft);
    restoreElementProperty(element, "scrollTop", descriptors.scrollTop);
    restoreElementProperty(element, "scrollWidth", descriptors.scrollWidth);
  }
}

function defineThrowingElementProperty(element: HTMLElement, property: ScrollMetricProperty): void {
  Object.defineProperty(element, property, {
    configurable: true,
    get: () => {
      throw new Error(`unexpected ${property} read`);
    },
    set: () => undefined,
  });
}

function restoreElementProperty(
  element: HTMLElement,
  property: ScrollMetricProperty,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (!descriptor) {
    Reflect.deleteProperty(element, property);
    return;
  }

  Object.defineProperty(element, property, descriptor);
}

function trackScrollTopWrites(element: HTMLElement): {
  readonly values: readonly number[];
  restore(): void;
} {
  const descriptor = Object.getOwnPropertyDescriptor(element, "scrollTop");
  const values: number[] = [];
  let scrollTop = element.scrollTop;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      values.push(value);
      scrollTop = value;
    },
  });

  return {
    values,
    restore: () => restoreElementProperty(element, "scrollTop", descriptor),
  };
}

describe("Editor", () => {
  let container: HTMLElement;
  let editor: Editor;

  beforeEach(() => {
    highlightsMap.clear();
    // @ts-expect-error — polyfilling Highlight constructor for tests
    globalThis.Highlight = MockHighlight;
    setHighlightRegistry(mockRegistry);
    resetEditorInstanceCount();
    container = document.createElement("div");
    document.body.appendChild(container);
    editor = new Editor(container, { plugins: withTestLanguagePlugins() });
  });

  afterEach(() => {
    editor.dispose();
    container.remove();
    setHighlightRegistry(undefined);
    setEditorSyntaxSessionFactory(undefined);
  });

  describe("constructor", () => {
    it("creates anonymous initial text without notifying a change", () => {
      const states: EditorState[] = [];
      editor.dispose();

      editor = new Editor(container, {
        defaultText: "abc",
        onChange: (state) => states.push(state),
      });

      expect(editor.getText()).toBe("abc");
      expect(editorRoot().textContent).toBe("abc");
      expect(editor.getState()).toMatchObject({
        documentId: null,
        languageId: null,
        length: 3,
        canUndo: false,
        canRedo: false,
      });
      expect(states).toHaveLength(0);
    });

    it("treats empty defaultText as an editable anonymous buffer", () => {
      editor.dispose();
      editor = new Editor(container, { defaultText: "" });

      editorRoot().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "x",
          inputType: "insertText",
        }),
      );

      expect(editor.getText()).toBe("x");
      expect(editor.getState()).toMatchObject({
        documentId: null,
        length: 1,
        canUndo: true,
      });
    });

    it("forwards hidden character mode to the text view", () => {
      editor.dispose();
      editor = new Editor(container, {
        defaultText: "a b\tc",
        hiddenCharacters: "show",
      });

      expect(hiddenCharacterKinds()).toEqual(["space", "tab"]);
      expect(editorRoot().textContent).toBe("a b\tc");
    });

    it("uses the larger default line height", () => {
      expect(editorRoot().style.getPropertyValue("--editor-row-height")).toBe("24px");
    });

    it("forwards configured line height to the text view", () => {
      editor.dispose();
      editor = new Editor(container, {
        defaultText: "a\nb",
        lineHeight: 26,
      });

      expect(editorRoot().style.getPropertyValue("--editor-row-height")).toBe("26px");
    });

    it("applies configured theme variables for Tree-sitter capture themes", () => {
      editor.dispose();
      editor = new Editor(container, {
        plugins: withTestLanguagePlugins(),
        theme: {
          backgroundColor: "#ffffff",
          foregroundColor: "#24292e",
          gutterForegroundColor: "#1b1f234d",
          caretColor: "#044289",
          syntax: { keywordDeclaration: "#d73a49", string: "#032f62" },
        },
      });

      const root = editorRoot();
      expect(root.style.getPropertyValue("--editor-background")).toBe("#ffffff");
      expect(root.style.getPropertyValue("--editor-foreground")).toBe("#24292e");
      expect(root.style.getPropertyValue("--editor-gutter-foreground")).toBe("#1b1f234d");
      expect(root.style.getPropertyValue("--editor-caret-color")).toBe("#044289");
      expect(root.style.getPropertyValue("--editor-syntax-keyword-declaration")).toBe("#d73a49");
      expect(root.style.getPropertyValue("--editor-syntax-string")).toBe("#032f62");
    });
  });

  describe("setTheme", () => {
    it("updates and clears configured editor theme variables", () => {
      editor.setTheme({ backgroundColor: "#ffffff", foregroundColor: "#24292e" });

      expect(editorRoot().style.getPropertyValue("--editor-background")).toBe("#ffffff");
      expect(editorRoot().style.getPropertyValue("--editor-foreground")).toBe("#24292e");

      editor.setTheme(null);

      expect(editorRoot().style.getPropertyValue("--editor-background")).toBe("");
      expect(editorRoot().style.getPropertyValue("--editor-foreground")).toBe("");
    });
  });

  describe("setLineHeight", () => {
    it("updates the text view line height", () => {
      editor.setLineHeight(28);

      expect(editorRoot().style.getPropertyValue("--editor-row-height")).toBe("28px");
    });
  });

  describe("setHiddenCharacters", () => {
    it("updates hidden character rendering for mounted rows", () => {
      editor.setText("a b\tc");

      expect(hiddenCharacterKinds()).toEqual([]);

      editor.setHiddenCharacters("show");

      expect(hiddenCharacterKinds()).toEqual(["space", "tab"]);

      editor.setHiddenCharacters("hidden");

      expect(hiddenCharacterKinds()).toEqual([]);
      expect(editorRoot().textContent).toBe("a b\tc");
    });
  });

  describe("setContent", () => {
    it("sets the text content", () => {
      editor.setContent("hello world");
      expect(editorRoot().textContent).toBe("hello world");
    });

    it("clears highlights when setting content", () => {
      editor.setContent("const x = 1");
      editor.setTokens([{ start: 0, end: 5, style: { color: "#ff0000" } }]);
      expect(highlightsMap.size).toBeGreaterThan(0);

      editor.setContent("new content");
      expect(highlightsMap.size).toBe(0);
    });
  });

  describe("setTokens", () => {
    it("creates highlights for tokens", () => {
      editor.setContent("const x = 1");
      editor.setTokens([
        { start: 0, end: 5, style: { color: "#ff0000" } },
        { start: 6, end: 7, style: { color: "#00ff00" } },
      ]);

      expect(highlightsMap.size).toBe(2);
    });

    it("groups tokens with the same style", () => {
      editor.setContent("const x = 1");
      editor.setTokens([
        { start: 0, end: 5, style: { color: "#ff0000" } },
        { start: 10, end: 11, style: { color: "#ff0000" } },
      ]);

      // Same color → same group → only 1 highlight entry
      expect(highlightsMap.size).toBe(1);
    });

    it("skips tokens with no style", () => {
      editor.setContent("hello");
      editor.setTokens([{ start: 0, end: 5, style: {} }]);
      expect(highlightsMap.size).toBe(0);
    });

    it("does nothing for empty text", () => {
      editor.setContent("");
      editor.setTokens([{ start: 0, end: 5, style: { color: "#ff0000" } }]);
      expect(highlightsMap.size).toBe(0);
    });
  });

  describe("view contribution plugins", () => {
    it("receives document, token, selection, and content updates", () => {
      const events: ViewContributionEvent[] = [];
      editor.dispose();
      editor = new Editor(container, { plugins: [createViewContributionPlugin(events)] });

      editor.openDocument({ documentId: "test.ts", text: "const a = 1;" });
      editor.setTokens([{ start: 0, end: 5, style: { color: "#ff0000" } }]);
      editorRoot().dispatchEvent(createInsertEvent("!"));

      expect(events.some((event) => event.kind === "document")).toBe(true);
      expect(events.some((event) => event.kind === "tokens")).toBe(true);
      expect(events.some((event) => event.kind === "selection")).toBe(true);
      expect(events.some((event) => event.kind === "content" && event.changeKind === "edit")).toBe(
        true,
      );
      expect(events.at(-1)?.snapshot?.text).toBe("const a = 1;!");
    });

    it("uses cached scroll metrics when creating snapshots", () => {
      const events: ViewContributionEvent[] = [];
      editor.dispose();
      editor = new Editor(container, { plugins: [createViewContributionPlugin(events)] });

      withThrowingScrollMetricReads(editorRoot(), () => {
        editor.openDocument({ documentId: "test.ts", text: "const a = 1;" });
      });

      expect(events.at(-1)?.snapshot?.viewport.scrollTop).toBe(0);
      expect(events.at(-1)?.snapshot?.viewport.scrollLeft).toBe(0);
      expect(events.at(-1)?.snapshot?.viewport.scrollHeight).toBeGreaterThan(0);
      expect(events.at(-1)?.snapshot?.viewport.scrollWidth).toBeGreaterThan(0);
      expect(events.at(-1)?.snapshot?.viewport.clientHeight).toBe(0);
      expect(events.at(-1)?.snapshot?.viewport.clientWidth).toBe(0);
    });

    it("resets scroll when opening a new document without an explicit position", () => {
      const events: ViewContributionEvent[] = [];
      editor.dispose();
      editor = new Editor(container, { plugins: [createViewContributionPlugin(events)] });

      editor.openDocument({
        documentId: "large.txt",
        text: Array.from({ length: 200 }, (_value, index) => `line ${index}`).join("\n"),
        scrollPosition: { top: 120 },
      });

      editor.openDocument({ documentId: "small.txt", text: "short" });

      expect(editorRoot().scrollTop).toBe(0);
      expect(editor.getScrollPosition()).toEqual({ top: 0, left: 0 });
      expect(events.at(-1)?.snapshot?.viewport.scrollTop).toBe(0);
    });

    it("accepts an initial scroll position when opening a document", () => {
      const text = Array.from({ length: 200 }, (_value, index) => `line ${index}`).join("\n");

      editor.openDocument({
        documentId: "large.txt",
        text,
        scrollPosition: { top: 120 },
      });

      expect(editorRoot().scrollTop).toBe(120);
      expect(editor.getScrollPosition()).toEqual({ top: 120, left: 0 });
    });

    it("preserves and clamps scroll when replacing text", () => {
      editor.openDocument({
        documentId: "large.txt",
        text: Array.from({ length: 200 }, (_value, index) => `line ${index}`).join("\n"),
        scrollPosition: { top: 120 },
      });

      editor.setText("short");

      expect(editorRoot().scrollTop).toBeLessThan(120);
      expect(editor.getScrollPosition()).toEqual({ top: editorRoot().scrollTop, left: 0 });
    });

    it("uses cached line starts when reserving overlay width", () => {
      let contributionContext: EditorViewContributionContext | null = null;
      const plugin: EditorPlugin = {
        activate: (context) =>
          context.registerViewContribution({
            createContribution: (context) => {
              contributionContext = context;
              return {
                update: () => undefined,
                dispose: () => undefined,
              };
            },
          }),
      };
      editor.dispose();
      editor = new Editor(container, { plugins: [plugin] });

      const text = Array.from({ length: 10_000 }, (_, row) => `line ${row}`).join("\n");
      editor.openDocument({ documentId: "long.txt", text });
      const context = requireViewContributionContext(contributionContext);

      const originalIndexOf = String.prototype.indexOf;
      let lineStartScans = 0;
      String.prototype.indexOf = function indexOfSpy(
        this: string,
        searchString: string,
        position?: number,
      ): number {
        if (String(this) === text && searchString === "\n") lineStartScans += 1;
        return originalIndexOf.call(this, searchString, position);
      };

      try {
        context.reserveOverlayWidth("right", 120);
      } finally {
        String.prototype.indexOf = originalIndexOf;
      }

      expect(lineStartScans).toBe(0);
    });

    it("skips layout updates for unchanged overlay reservations", () => {
      const events: EditorViewContributionUpdateKind[] = [];
      let contributionContext: EditorViewContributionContext | null = null;
      const plugin: EditorPlugin = {
        activate: (context) =>
          context.registerViewContribution({
            createContribution: (context) => {
              contributionContext = context;
              return {
                update: (_snapshot, kind) => {
                  events.push(kind);
                },
                dispose: () => undefined,
              };
            },
          }),
      };
      editor.dispose();
      editor = new Editor(container, { plugins: [plugin] });
      const context = requireViewContributionContext(contributionContext);

      context.reserveOverlayWidth("right", 80);
      context.reserveOverlayWidth("right", 80);

      expect(events.filter((kind) => kind === "layout")).toHaveLength(1);
    });

    it("coalesces overlay reservations triggered during contribution updates", () => {
      const events: EditorViewContributionUpdateKind[] = [];
      let contributionContext: EditorViewContributionContext | null = null;
      const plugin: EditorPlugin = {
        activate: (context) =>
          context.registerViewContribution({
            createContribution: (context) => {
              contributionContext = context;
              return {
                update: (_snapshot, kind) => {
                  events.push(kind);
                  if (events.length > 8) throw new Error("recursive contribution update");
                  requireViewContributionContext(contributionContext).reserveOverlayWidth(
                    "right",
                    80 + events.length,
                  );
                },
                dispose: () => undefined,
              };
            },
          }),
      };
      editor.dispose();
      editor = new Editor(container, { plugins: [plugin] });

      editor.setContent("abc");

      expect(events).toEqual(["viewport", "layout", "tokens", "layout", "content", "layout"]);
    });

    it("disposes view contributions with the editor", () => {
      const events: ViewContributionEvent[] = [];
      editor.dispose();
      editor = new Editor(container, { plugins: [createViewContributionPlugin(events)] });

      editor.dispose();

      expect(events.at(-1)?.kind).toBe("dispose");
    });
  });

  describe("editor feature plugins", () => {
    it("registers editor commands and receives document changes", () => {
      let commandCalls = 0;
      const changes: (DocumentSessionChange["kind"] | null)[] = [];
      const plugin: EditorPlugin = {
        activate: (context) =>
          context.registerEditorFeatureContribution({
            createContribution: (context) => {
              const command = context.registerCommand("findNext", () => {
                commandCalls += 1;
                return true;
              });
              return {
                handleEditorChange: (change) => changes.push(change?.kind ?? null),
                dispose: () => command.dispose(),
              };
            },
          }),
      };

      editor.dispose();
      editor = new Editor(container, { plugins: [plugin] });

      expect(editor.dispatchCommand("findNext")).toBe(true);
      editor.setText("abc");

      expect(commandCalls).toBe(1);
      expect(changes).toContain(null);
    });
  });

  describe("applyEdit", () => {
    it("shifts tokens after the edit region", () => {
      editor.setContent("abcdef");
      editor.setTokens([{ start: 4, end: 6, style: { color: "#ff0000" } }]);

      // Insert "XX" at position 0 → delta = +2
      editor.applyEdit({ from: 0, to: 0, text: "XX" }, [
        { start: 6, end: 8, style: { color: "#ff0000" } },
      ]);

      expect(editorRoot().textContent).toBe("XXabcdef");
    });

    it("removes tokens overlapping the edit region", () => {
      editor.setContent("abcdef");
      editor.setTokens([{ start: 2, end: 4, style: { color: "#ff0000" } }]);
      expect(highlightsMap.size).toBe(1);

      // Replace "cd" at positions 2-4 with "XY"
      editor.applyEdit(
        { from: 2, to: 4, text: "XY" },
        [], // No replacement tokens
      );

      // The overlapping token should be removed, group cleaned up
      expect(highlightsMap.size).toBe(0);
    });

    it("preserves tokens before the edit region", () => {
      editor.setContent("abcdef");
      editor.setTokens([
        { start: 0, end: 2, style: { color: "#ff0000" } },
        { start: 4, end: 6, style: { color: "#00ff00" } },
      ]);

      // Edit in the middle (positions 2-4)
      editor.applyEdit({ from: 2, to: 4, text: "XX" }, [
        { start: 2, end: 4, style: { color: "#0000ff" } },
      ]);

      // Token at 0-2 should be untouched, so its group persists
      expect(highlightsMap.size).toBeGreaterThanOrEqual(1);
    });

    it("adds new tokens for the edit region", () => {
      editor.setContent("abcdef");
      editor.setTokens([]);

      editor.applyEdit({ from: 2, to: 4, text: "XY" }, [
        { start: 2, end: 4, style: { color: "#ff0000" } },
      ]);

      expect(highlightsMap.size).toBe(1);
    });

    it("updates text content correctly", () => {
      editor.setContent("hello world");
      editor.applyEdit({ from: 5, to: 5, text: " beautiful" }, []);
      expect(editorRoot().textContent).toBe("hello beautiful world");
    });
  });

  describe("attachSession", () => {
    it("focuses the real input surface", () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);

      editor.focus();

      expect(document.activeElement).toBe(editorInput());
    });

    it("preserves the viewport when focusing the real input surface", () => {
      const root = editorRoot();
      const session = createDocumentSession("abc");
      editor.attachSession(session);
      root.scrollTop = 120;
      root.scrollLeft = 16;
      vi.spyOn(editorInput(), "setSelectionRange").mockImplementation(() => {
        root.scrollTop = 0;
        root.scrollLeft = 0;
      });

      editor.focus();

      expect(root.scrollTop).toBe(120);
      expect(root.scrollLeft).toBe(16);
    });

    it("routes text input through a document session", () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);

      const event = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "!",
        inputType: "insertText",
      });
      editorRoot().dispatchEvent(event);

      expect(session.getText()).toBe("abc!");
      expect(editorRoot().textContent).toBe("abc!");
    });

    it("routes real input-surface events through a document session", () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);

      editorInput().dispatchEvent(createInsertEvent("!"));

      expect(session.getText()).toBe("abc!");
      expect(editor.getText()).toBe("abc!");
    });

    it("falls back to keydown text when native beforeinput never arrives", async () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);
      editor.focus();

      editorInput().dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "X",
        }),
      );
      await flushTimers();

      expect(session.getText()).toBe("abcX");
      expect(editor.getText()).toBe("abcX");
    });

    it("prevents browser scroll defaults when Space uses keydown fallback", async () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);

      const event = dispatchEditorKey(" ");
      await flushTimers();

      expect(event.defaultPrevented).toBe(true);
      expect(session.getText()).toBe("abc ");
      expect(editor.getText()).toBe("abc ");
    });

    it("prevents browser scroll defaults when focused input receives Space", async () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);
      editor.focus();

      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: " ",
      });
      const dispatched = editorInput().dispatchEvent(event);
      await flushTimers();

      expect(dispatched).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(session.getText()).toBe("abc ");
      expect(editor.getText()).toBe("abc ");
    });

    it("inserts a literal tab at collapsed selections", () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);

      const event = dispatchEditorKey("Tab");

      expect(event.defaultPrevented).toBe(true);
      expect(session.getText()).toBe("abc\t");
      expect(editor.getText()).toBe("abc\t");
    });

    it("indents selected lines with Tab and keeps the edit undoable", () => {
      const session = createDocumentSession("a\nb\nc");
      session.setSelection(0, 3);
      editor.attachSession(session);

      dispatchEditorKey("Tab");

      expect(session.getText()).toBe("\ta\n\tb\nc");

      dispatchEditorKey("z", primaryModifier());

      expect(session.getText()).toBe("a\nb\nc");
    });

    it("outdents selected lines with Shift+Tab using the configured tab size", () => {
      editor.dispose();
      editor = new Editor(container, { tabSize: 2 });
      const session = createDocumentSession("  a\n\tb\nc");
      session.setSelection(0, 6);
      editor.attachSession(session);

      const event = dispatchEditorKey("Tab", { shiftKey: true });

      expect(event.defaultPrevented).toBe(true);
      expect(session.getText()).toBe("a\nb\nc");
    });

    it("falls back to keydown line breaks when native beforeinput never arrives", async () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);
      editor.focus();

      editorInput().dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }),
      );
      await flushTimers();

      expect(session.getText()).toBe("abc\n");
      expect(editor.getText()).toBe("abc\n");
    });

    it("measures input timing from the browser event timestamp", () => {
      const changes: DocumentSessionChange[] = [];
      editor.dispose();
      editor = new Editor(container, {
        onChange: (_state, change) => {
          if (change) changes.push(change);
        },
      });
      editor.attachSession(createDocumentSession("abc"));

      const event = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "!",
        inputType: "insertText",
      });
      Object.defineProperty(event, "timeStamp", { configurable: true, value: 1 });
      editorRoot().dispatchEvent(event);

      const timing = changes.at(-1)?.timings.find(({ name }) => name === "input.beforeinput");
      expect(timing?.durationMs).toBeGreaterThan(1);
    });

    it("routes undo through a document session", () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);
      session.applyText("!");

      editorInput().dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "z",
          ...primaryModifier(),
        }),
      );

      expect(session.getText()).toBe("abc");
      expect(editorRoot().textContent).toBe("abc");
    });

    it("routes delete commands through the keymap layer", () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);

      dispatchEditorKey("Backspace");

      expect(session.getText()).toBe("ab");
      expect(editor.getText()).toBe("ab");
    });

    it("selects the full document with Mod+A", () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);

      dispatchEditorKey("a", primaryModifier());

      const resolved = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect(resolved.startOffset).toBe(0);
      expect(resolved.endOffset).toBe(3);
    });

    it("copies selected text as plain text", () => {
      const session = createDocumentSession("alpha beta");
      session.setSelection(6, 10);
      editor.attachSession(session);

      const copy = createCopyEvent();
      editorRoot().dispatchEvent(copy.event);

      expect(copy.getText()).toBe("beta");
      expect(copy.event.defaultPrevented).toBe(true);
    });

    it("does not intercept copy for collapsed selections", () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);

      const copy = createCopyEvent();
      editorRoot().dispatchEvent(copy.event);

      expect(copy.formatCount()).toBe(0);
      expect(copy.event.defaultPrevented).toBe(false);
    });

    it("copies the full document after Mod+A", () => {
      editor.setText("abc");

      dispatchEditorKey("a", primaryModifier());
      const copy = createCopyEvent();
      editorRoot().dispatchEvent(copy.event);

      expect(copy.getText()).toBe("abc");
      expect(copy.event.defaultPrevented).toBe(true);
    });

    it("opens long documents without revealing the initial end selection", () => {
      const root = editorRoot();
      const text = Array.from({ length: 80 }, (_value, index) => `line ${index}`).join("\n");
      mockEditorViewport(root, 80, 40, 2_000);

      editor.setText(text);

      expect(editor.getState().cursor).toEqual({ row: 79, column: 7 });
      expect(root.scrollTop).toBe(0);
    });

    it("scrolls to the bottom of pasted text", () => {
      const pasted = Array.from({ length: 8 }, (_value, index) => `line ${index}`).join("\n");
      editor.setText("");
      mockEditorViewport(editorRoot(), 80, 40);
      editor.focus();

      editorInput().dispatchEvent(createPasteEvent(pasted));

      expect(editor.getText()).toBe(pasted);
      expect(editor.getState().cursor).toEqual({ row: 7, column: 6 });
      expect(editorRoot().scrollTop).toBeGreaterThan(0);
    });

    it("writes scrollTop once when revealing pasted text at the viewport end", () => {
      const pasted = Array.from({ length: 8 }, (_value, index) => `line ${index}`).join("\n");
      const root = editorRoot();
      editor.setText("");
      mockEditorViewport(root, 80, 40);
      editor.focus();
      const scrollTopWrites = trackScrollTopWrites(root);

      try {
        editorInput().dispatchEvent(createPasteEvent(pasted));
      } finally {
        scrollTopWrites.restore();
      }

      expect(scrollTopWrites.values).toHaveLength(1);
      expect(scrollTopWrites.values[0]).toBeGreaterThan(0);
    });

    it("moves a collapsed caret with arrow keys", () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);

      dispatchEditorKey("ArrowLeft");

      expect(editor.getState().cursor).toEqual({ row: 0, column: 2 });
      const resolved = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect(resolved.headOffset).toBe(2);
    });

    it("moves all collapsed cursors with arrow keys", () => {
      const session = createDocumentSession("abc\ndef");
      session.setSelections([{ anchor: 3 }, { anchor: 7 }]);
      editor.attachSession(session);

      dispatchEditorKey("ArrowLeft");

      expect(resolvedSelectionRanges(session)).toEqual([
        { anchor: 2, head: 2, start: 2, end: 2 },
        { anchor: 6, head: 6, start: 6, end: 6 },
      ]);
      expect(container.querySelectorAll(".editor-virtualized-caret:not([hidden])")).toHaveLength(2);
    });

    it("extends selections with shift arrow keys", () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);

      dispatchEditorKey("ArrowLeft", { shiftKey: true });

      const resolved = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect(resolved.anchorOffset).toBe(3);
      expect(resolved.headOffset).toBe(2);
      expect(resolved.startOffset).toBe(2);
      expect(resolved.endOffset).toBe(3);
      expect(highlightsMap.get("editor-token-0-selection")?.size).toBe(1);
    });

    it("extends all cursors with shift arrow keys", () => {
      const session = createDocumentSession("abcdef");
      session.setSelections([{ anchor: 2 }, { anchor: 5 }]);
      editor.attachSession(session);

      dispatchEditorKey("ArrowRight", { shiftKey: true });

      expect(resolvedSelectionRanges(session)).toEqual([
        { anchor: 2, head: 3, start: 2, end: 3 },
        { anchor: 5, head: 6, start: 5, end: 6 },
      ]);
      expect(container.querySelectorAll(".editor-virtualized-caret:not([hidden])")).toHaveLength(2);
    });

    it("keeps vertical navigation on the preferred visual column", () => {
      const session = createDocumentSession("abcdef\nx\n12345");
      editor.attachSession(session);

      dispatchEditorKey("ArrowUp");
      dispatchEditorKey("ArrowUp");

      expect(editor.getState().cursor).toEqual({ row: 0, column: 5 });
    });

    it("keeps independent visual columns while vertically moving all cursors", () => {
      const session = createDocumentSession("abcde\nx\n123456789\nABCDE\ny\n987654321");
      session.setSelections([{ anchor: 13 }, { anchor: 34 }]);
      editor.attachSession(session);

      dispatchEditorKey("ArrowUp");
      expect(resolvedSelectionRanges(session)).toEqual([
        { anchor: 7, head: 7, start: 7, end: 7 },
        { anchor: 25, head: 25, start: 25, end: 25 },
      ]);

      dispatchEditorKey("ArrowDown");
      expect(resolvedSelectionRanges(session)).toEqual([
        { anchor: 13, head: 13, start: 13, end: 13 },
        { anchor: 34, head: 34, start: 34, end: 34 },
      ]);
    });

    it("keeps multi-cursor navigation for word, line, page, and document commands", () => {
      const wordSession = createDocumentSession("one two three four five six");
      wordSession.setSelections([{ anchor: 4 }, { anchor: 19 }]);
      editor.attachSession(wordSession);

      dispatchEditorKey("ArrowRight", wordNavigationModifier());
      expect(wordSession.getSelections().selections).toHaveLength(2);

      const lineSession = createDocumentSession("abc\ndef");
      lineSession.setSelections([{ anchor: 1 }, { anchor: 5 }]);
      editor.attachSession(lineSession);

      dispatchEditorKey("End");
      expect(resolvedSelectionRanges(lineSession)).toEqual([
        { anchor: 3, head: 3, start: 3, end: 3 },
        { anchor: 7, head: 7, start: 7, end: 7 },
      ]);

      const pageSession = createDocumentSession(
        Array.from({ length: 12 }, (_value, index) => `line ${index}`).join("\n"),
      );
      pageSession.setSelections([{ anchor: 0 }, { anchor: 7 }]);
      mockEditorViewport(editorRoot(), 80, 40);
      editor.attachSession(pageSession);

      dispatchEditorKey("PageDown");
      expect(pageSession.getSelections().selections).toHaveLength(2);

      const documentSession = createDocumentSession("abc\ndef");
      documentSession.setSelections([{ anchor: 1 }, { anchor: 5 }]);
      editor.attachSession(documentSession);

      const documentEndKey = detectPlatform() === "mac" ? "ArrowDown" : "End";
      const documentEndModifier =
        detectPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };
      dispatchEditorKey(documentEndKey, documentEndModifier);
      expect(resolvedSelectionRanges(documentSession)).toEqual([
        { anchor: 7, head: 7, start: 7, end: 7 },
      ]);
    });

    it("scrolls the caret into view while navigating by keyboard", () => {
      const session = createDocumentSession("0\n1\n2\n3\n4\n5");
      session.setSelection(0);
      mockEditorViewport(editorRoot(), 80, 40);
      editor.attachSession(session);

      for (let index = 0; index < 5; index += 1) dispatchEditorKey("ArrowDown");

      expect(editorRoot().scrollTop).toBeGreaterThan(0);
      expect(editor.getState().cursor).toEqual({ row: 5, column: 0 });
    });

    it("can disable default keymap bindings", () => {
      editor.dispose();
      editor = new Editor(container, { keymap: { enabled: false } });
      editor.setText("abc");

      dispatchEditorKey("ArrowLeft");

      expect(editor.getState().cursor).toEqual({ row: 0, column: 3 });
    });

    it("keeps browser selections synced to the document session", () => {
      const session = createDocumentSession("abcd");
      editor.attachSession(session);
      const textNode = rowTextNode();
      const range = document.createRange();
      range.setStart(textNode, 1);
      range.setEnd(textNode, 3);

      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      editorRoot().dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      const resolved = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect(resolved.startOffset).toBe(1);
      expect(resolved.endOffset).toBe(3);

      editorRoot().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "X",
          inputType: "insertText",
        }),
      );

      expect(session.getText()).toBe("aXd");
      expect(editorRoot().textContent).toBe("aXd");
    });

    it("renders range selections with a custom highlight", () => {
      const session = createDocumentSession("abcd");
      editor.attachSession(session);
      const textNode = rowTextNode();
      const range = document.createRange();
      range.setStart(textNode, 1);
      range.setEnd(textNode, 3);

      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      editorRoot().dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      expect(highlightsMap.get("editor-token-0-selection")?.size).toBe(1);

      editorRoot().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "X",
          inputType: "insertText",
        }),
      );

      expect(highlightsMap.has("editor-token-0-selection")).toBe(false);
    });

    it("adds an Option-click cursor and edits all cursors together", () => {
      const session = createDocumentSession("abcdef");
      session.setSelection(1);
      editor.attachSession(session);
      const textNode = rowTextNode();
      const originalCaretRangeFromPoint = (
        document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      ).caretRangeFromPoint;
      Object.defineProperty(document, "caretRangeFromPoint", {
        configurable: true,
        value: () => {
          const range = document.createRange();
          range.setStart(textNode, 4);
          range.setEnd(textNode, 4);
          return range;
        },
      });

      try {
        editorRoot().dispatchEvent(
          new MouseEvent("mousedown", {
            altKey: true,
            bubbles: true,
            cancelable: true,
            detail: 1,
          }),
        );
        editorRoot().dispatchEvent(createInsertEvent("X"));
      } finally {
        if (originalCaretRangeFromPoint) {
          Object.defineProperty(document, "caretRangeFromPoint", {
            configurable: true,
            value: originalCaretRangeFromPoint,
          });
        } else {
          Reflect.deleteProperty(document, "caretRangeFromPoint");
        }
      }

      expect(session.getSelections().selections).toHaveLength(2);
      expect(editor.getText()).toBe("aXbcdXef");
      expect(container.querySelectorAll(".editor-virtualized-caret")).toHaveLength(2);
    });

    it("clears secondary cursors with Escape", () => {
      const session = createDocumentSession("abcdef");
      session.setSelection(1);
      session.addSelection(4);
      editor.attachSession(session);

      dispatchEditorKey("Escape");

      expect(session.getSelections().selections).toHaveLength(1);
      expect(container.querySelectorAll(".editor-virtualized-caret:not([hidden])")).toHaveLength(1);
    });

    it("selects the current word then adds the next exact occurrence with Mod+D", () => {
      const session = createDocumentSession("foo bar foo");
      session.setSelection(1);
      editor.attachSession(session);

      dispatchEditorKey("d", primaryModifier());

      let ranges = session.getSelections().selections.map((selection) => {
        const resolved = resolveSelection(session.getSnapshot(), selection);
        return { start: resolved.startOffset, end: resolved.endOffset };
      });
      expect(ranges).toEqual([{ start: 0, end: 3 }]);

      dispatchEditorKey("d", primaryModifier());

      ranges = session.getSelections().selections.map((selection) => {
        const resolved = resolveSelection(session.getSnapshot(), selection);
        return { start: resolved.startOffset, end: resolved.endOffset };
      });
      expect(ranges).toEqual([
        { start: 0, end: 3 },
        { start: 8, end: 11 },
      ]);
      expect(container.querySelectorAll(".editor-virtualized-caret")).toHaveLength(2);
    });

    it("reveals the wrapped occurrence when Mod+D loops to the top", () => {
      const session = createDocumentSession("foo\nx\nfoo\nx\nfoo");
      session.setSelection(7);
      editor.attachSession(session);
      mockEditorViewport(editorRoot(), 80, 40);

      dispatchEditorKey("d", primaryModifier());
      dispatchEditorKey("d", primaryModifier());

      expect(editorRoot().scrollTop).toBeGreaterThan(0);

      dispatchEditorKey("d", primaryModifier());

      const ranges = session.getSelections().selections.map((selection) => {
        const resolved = resolveSelection(session.getSnapshot(), selection);
        return { start: resolved.startOffset, end: resolved.endOffset };
      });
      expect(ranges).toEqual([
        { start: 0, end: 3 },
        { start: 6, end: 9 },
        { start: 12, end: 15 },
      ]);
      expect(editorRoot().scrollTop).toBe(0);
    });

    it("prevents browser defaults for no-op editor key commands", () => {
      editor.setText(" ");

      const addOccurrence = dispatchEditorKey("d", primaryModifier());
      const clearSecondary = dispatchEditorKey("Escape");

      expect(addOccurrence.defaultPrevented).toBe(true);
      expect(clearSecondary.defaultPrevented).toBe(true);
    });

    it("opens find, navigates matches, and paints find highlights", () => {
      const session = createDocumentSession("foo bar foo");
      editor.attachSession(session);

      dispatchEditorKey("f", primaryModifier());
      expect(container.querySelector(".editor-find-widget")).not.toBeNull();

      const findInput = container.querySelector(".editor-find-input") as HTMLInputElement;
      findInput.value = "foo";
      findInput.dispatchEvent(new Event("input", { bubbles: true }));

      expect([...highlightsMap.keys()].filter((name) => name.includes("find-match"))).toHaveLength(
        1,
      );
      let selection = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect({ start: selection.startOffset, end: selection.endOffset }).toEqual({
        start: 0,
        end: 3,
      });

      expect(editor.findNext()).toBe(true);
      selection = resolveSelection(session.getSnapshot(), session.getSelections().selections[0]!);
      expect({ start: selection.startOffset, end: selection.endOffset }).toEqual({
        start: 8,
        end: 11,
      });
    });

    it("toggles find closed from the editor and find input", () => {
      const session = createDocumentSession("foo");
      editor.attachSession(session);

      dispatchEditorKey("f", primaryModifier());
      const widget = container.querySelector(".editor-find-widget") as HTMLDivElement;
      const findInput = container.querySelector(".editor-find-input") as HTMLInputElement;

      expect(widget.hidden).toBe(false);

      const inputEvent = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "f",
        ...primaryModifier(),
      });
      findInput.dispatchEvent(inputEvent);

      expect(inputEvent.defaultPrevented).toBe(true);
      expect(widget.hidden).toBe(true);

      dispatchEditorKey("f", primaryModifier());
      expect(widget.hidden).toBe(false);

      dispatchEditorKey("f", primaryModifier());
      expect(widget.hidden).toBe(true);
    });

    it("replaces one and replace-all is one undoable edit", () => {
      const session = createDocumentSession("foo foo foo");
      editor.attachSession(session);

      editor.openFindReplace();
      const inputs = container.querySelectorAll(".editor-find-input");
      const findInput = inputs[0] as HTMLInputElement;
      const replaceInput = inputs[1] as HTMLInputElement;
      findInput.value = "foo";
      findInput.dispatchEvent(new Event("input", { bubbles: true }));
      replaceInput.value = "bar";
      replaceInput.dispatchEvent(new Event("input", { bubbles: true }));

      expect(editor.replaceOne()).toBe(true);
      expect(editor.getText()).toBe("bar foo foo");

      expect(editor.replaceAll()).toBe(true);
      expect(editor.getText()).toBe("bar bar bar");

      editor.dispatchCommand("undo");
      expect(editor.getText()).toBe("bar foo foo");
    });

    it("toggles the replace row from the find widget", () => {
      const session = createDocumentSession("foo");
      editor.attachSession(session);

      expect(editor.openFind()).toBe(true);
      const replaceRow = container.querySelector(".editor-find-replace-row") as HTMLDivElement;
      const toggle = container.querySelector(".editor-find-replace-toggle") as HTMLButtonElement;
      const matchCase = container.querySelector('button[title="Match Case (Off)"]');

      expect(replaceRow.hidden).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.title).toBe("Show Replace");
      expect(matchCase).not.toBeNull();

      toggle.click();

      expect(replaceRow.hidden).toBe(false);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.title).toBe("Hide Replace");
    });

    it("find-in-selection and select-all matches create multi-selections", () => {
      const session = createDocumentSession("foo outside foo inside foo");
      session.setSelection(12, 26);
      editor.attachSession(session);

      editor.openFind();
      expect(editor.dispatchCommand("toggleFindInSelection")).toBe(true);
      const findInput = container.querySelector(".editor-find-input") as HTMLInputElement;
      findInput.value = "foo";
      findInput.dispatchEvent(new Event("input", { bubbles: true }));
      expect(editor.selectAllMatches()).toBe(true);

      const ranges = session.getSelections().selections.map((selection) => {
        const resolved = resolveSelection(session.getSnapshot(), selection);
        return { start: resolved.startOffset, end: resolved.endOffset };
      });
      expect(ranges).toEqual([
        { start: 12, end: 15 },
        { start: 23, end: 26 },
      ]);
    });

    it("updates custom selection immediately while dragging", () => {
      const session = createDocumentSession("abcd");
      editor.attachSession(session);
      const textNode = rowTextNode();
      const originalCaretRangeFromPoint = (
        document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      ).caretRangeFromPoint;
      Object.defineProperty(document, "caretRangeFromPoint", {
        configurable: true,
        value: (x: number) => {
          const range = document.createRange();
          const offset = x < 20 ? 1 : 3;
          range.setStart(textNode, offset);
          range.setEnd(textNode, offset);
          return range;
        },
      });

      const mouseDown = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        detail: 1,
      });
      editorRoot().dispatchEvent(mouseDown);
      document.dispatchEvent(new MouseEvent("mousemove", { cancelable: true, clientX: 30 }));

      expect(mouseDown.defaultPrevented).toBe(true);
      expect(highlightsMap.get("editor-token-0-selection")?.size).toBe(1);

      let resolved = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect(resolved.startOffset).toBe(1);
      expect(resolved.endOffset).toBe(3);

      document.dispatchEvent(new MouseEvent("mouseup", { cancelable: true, clientX: 30 }));

      if (originalCaretRangeFromPoint) {
        Object.defineProperty(document, "caretRangeFromPoint", {
          configurable: true,
          value: originalCaretRangeFromPoint,
        });
      } else {
        Reflect.deleteProperty(document, "caretRangeFromPoint");
      }

      resolved = resolveSelection(session.getSnapshot(), session.getSelections().selections[0]!);
      expect(resolved.startOffset).toBe(1);
      expect(resolved.endOffset).toBe(3);
    });

    it("continues dragging selection when pointer hit-testing leaves the text", () => {
      const session = createDocumentSession("abcd");
      editor.attachSession(session);
      mockEditorViewport(editorRoot(), 120, 40);

      const textNode = rowTextNode();
      const originalCaretRangeFromPoint = (
        document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      ).caretRangeFromPoint;
      Object.defineProperty(document, "caretRangeFromPoint", {
        configurable: true,
        value: (x: number) => {
          if (x !== 10) return null;

          const range = document.createRange();
          range.setStart(textNode, 1);
          range.setEnd(textNode, 1);
          return range;
        },
      });

      editorRoot().dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
          detail: 1,
        }),
      );
      document.dispatchEvent(
        new MouseEvent("mousemove", {
          cancelable: true,
          clientX: 120,
          clientY: 10,
        }),
      );
      document.dispatchEvent(
        new MouseEvent("mouseup", {
          cancelable: true,
          clientX: 120,
          clientY: 10,
        }),
      );

      if (originalCaretRangeFromPoint) {
        Object.defineProperty(document, "caretRangeFromPoint", {
          configurable: true,
          value: originalCaretRangeFromPoint,
        });
      } else {
        Reflect.deleteProperty(document, "caretRangeFromPoint");
      }

      const resolved = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect(resolved.startOffset).toBe(1);
      expect(resolved.endOffset).toBe(4);
    });

    it("auto-scrolls while dragging selection past the viewport edge", () => {
      const session = createDocumentSession("0\n1\n2\n3\n4\n5");
      editor.attachSession(session);
      mockEditorViewport(editorRoot(), 80, 40);

      const textNode = rowTextNode();
      const originalCaretRangeFromPoint = (
        document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      ).caretRangeFromPoint;
      Object.defineProperty(document, "caretRangeFromPoint", {
        configurable: true,
        value: (x: number) => {
          if (x !== 0) return null;

          const range = document.createRange();
          range.setStart(textNode, 0);
          range.setEnd(textNode, 0);
          return range;
        },
      });

      editorRoot().dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: 0,
          clientY: 5,
          detail: 1,
        }),
      );
      document.dispatchEvent(
        new MouseEvent("mousemove", {
          cancelable: true,
          clientX: 80,
          clientY: 45,
        }),
      );
      document.dispatchEvent(
        new MouseEvent("mouseup", {
          cancelable: true,
          clientX: 80,
          clientY: 45,
        }),
      );

      if (originalCaretRangeFromPoint) {
        Object.defineProperty(document, "caretRangeFromPoint", {
          configurable: true,
          value: originalCaretRangeFromPoint,
        });
      } else {
        Reflect.deleteProperty(document, "caretRangeFromPoint");
      }

      const resolved = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect(editorRoot().scrollTop).toBeGreaterThan(0);
      expect(resolved.endOffset).toBeGreaterThan(4);
    });

    it("snaps to the bottom visible line end when dragging below the viewport", () => {
      const session = createDocumentSession("alpha\nbeta");
      editor.attachSession(session);
      mockEditorViewport(editorRoot(), 80, 40, 40);

      const textNode = rowTextNode();
      const originalCaretRangeFromPoint = (
        document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      ).caretRangeFromPoint;
      Object.defineProperty(document, "caretRangeFromPoint", {
        configurable: true,
        value: (x: number) => {
          if (x !== 0) return null;

          const range = document.createRange();
          range.setStart(textNode, 0);
          range.setEnd(textNode, 0);
          return range;
        },
      });

      editorRoot().dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: 0,
          clientY: 5,
          detail: 1,
        }),
      );
      document.dispatchEvent(
        new MouseEvent("mousemove", {
          cancelable: true,
          clientX: 8,
          clientY: 45,
        }),
      );
      document.dispatchEvent(
        new MouseEvent("mouseup", {
          cancelable: true,
          clientX: 8,
          clientY: 45,
        }),
      );

      if (originalCaretRangeFromPoint) {
        Object.defineProperty(document, "caretRangeFromPoint", {
          configurable: true,
          value: originalCaretRangeFromPoint,
        });
      } else {
        Reflect.deleteProperty(document, "caretRangeFromPoint");
      }

      const resolved = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect(resolved.startOffset).toBe(0);
      expect(resolved.endOffset).toBe(10);
    });

    it("clamps cross-boundary browser selections before text input", () => {
      const before = document.createElement("span");
      before.textContent = "outside before";
      const after = document.createElement("span");
      after.textContent = "outside after";
      container.before(before);
      container.after(after);

      const session = createDocumentSession("abcd");
      editor.attachSession(session);
      const textNode = rowTextNode();
      const range = document.createRange();
      range.setStart(before.firstChild!, 0);
      range.setEnd(textNode, 2);

      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      editorRoot().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "X",
          inputType: "insertText",
        }),
      );

      expect(session.getText()).toBe("Xcd");
      expect(editorRoot().textContent).toBe("Xcd");
      before.remove();
      after.remove();
    });

    it("selects the current line on triple click", () => {
      const session = createDocumentSession("one\ntwo\nthree");
      editor.attachSession(session);

      const textNode = rowTextNode(1);
      const range = document.createRange();
      range.setStart(textNode, 1);
      range.setEnd(textNode, 1);
      const originalCaretRangeFromPoint = (
        document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      ).caretRangeFromPoint;
      Object.defineProperty(document, "caretRangeFromPoint", {
        configurable: true,
        value: () => range,
      });

      editorRoot().dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
          detail: 3,
        }),
      );
      if (originalCaretRangeFromPoint) {
        Object.defineProperty(document, "caretRangeFromPoint", {
          configurable: true,
          value: originalCaretRangeFromPoint,
        });
      } else {
        Reflect.deleteProperty(document, "caretRangeFromPoint");
      }

      const resolved = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect(resolved.startOffset).toBe(4);
      expect(resolved.endOffset).toBe(7);

      editorRoot().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "X",
          inputType: "insertText",
        }),
      );

      expect(session.getText()).toBe("one\nX\nthree");
      expect(editor.getText()).toBe("one\nX\nthree");
    });

    it("selects the full document on quad click", () => {
      const session = createDocumentSession("abcd");
      editor.attachSession(session);

      editorRoot().dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          detail: 4,
        }),
      );

      const resolved = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect(resolved.startOffset).toBe(0);
      expect(resolved.endOffset).toBe(4);

      editorRoot().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "X",
          inputType: "insertText",
        }),
      );

      expect(session.getText()).toBe("X");
      expect(editorRoot().textContent).toBe("X");
    });

    it("selects a word on double click", () => {
      const session = createDocumentSession("alpha beta");
      editor.attachSession(session);

      const textNode = rowTextNode();
      const range = document.createRange();
      range.setStart(textNode, 8);
      range.setEnd(textNode, 8);
      const originalCaretRangeFromPoint = (
        document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      ).caretRangeFromPoint;
      Object.defineProperty(document, "caretRangeFromPoint", {
        configurable: true,
        value: () => range,
      });

      editorRoot().dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
          detail: 2,
        }),
      );
      if (originalCaretRangeFromPoint) {
        Object.defineProperty(document, "caretRangeFromPoint", {
          configurable: true,
          value: originalCaretRangeFromPoint,
        });
      } else {
        Reflect.deleteProperty(document, "caretRangeFromPoint");
      }

      const resolved = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect(resolved.startOffset).toBe(6);
      expect(resolved.endOffset).toBe(10);

      editorRoot().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "X",
          inputType: "insertText",
        }),
      );

      expect(session.getText()).toBe("alpha X");
      expect(editorRoot().textContent).toBe("alpha X");
    });

    it("keeps a multi-click selection when stale DOM selection events arrive", () => {
      const session = createDocumentSession("alpha beta");
      editor.attachSession(session);

      const textNode = rowTextNode();
      const range = document.createRange();
      range.setStart(textNode, 8);
      range.setEnd(textNode, 8);
      const originalCaretRangeFromPoint = (
        document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      ).caretRangeFromPoint;
      Object.defineProperty(document, "caretRangeFromPoint", {
        configurable: true,
        value: () => range,
      });

      editorRoot().dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
          detail: 2,
        }),
      );
      if (originalCaretRangeFromPoint) {
        Object.defineProperty(document, "caretRangeFromPoint", {
          configurable: true,
          value: originalCaretRangeFromPoint,
        });
      } else {
        Reflect.deleteProperty(document, "caretRangeFromPoint");
      }

      const staleRange = document.createRange();
      staleRange.setStart(textNode, 0);
      staleRange.setEnd(textNode, 0);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(staleRange);
      editorRoot().dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      document.dispatchEvent(new Event("selectionchange"));

      const resolved = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect(resolved.startOffset).toBe(6);
      expect(resolved.endOffset).toBe(10);
      expect(highlightsMap.get("editor-token-0-selection")?.size).toBe(1);

      editorRoot().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "X",
          inputType: "insertText",
        }),
      );

      expect(session.getText()).toBe("alpha X");
      expect(editorRoot().textContent).toBe("alpha X");
    });
  });

  describe("openDocument", () => {
    it("sets anonymous text buffers without document identity", () => {
      editor.setText("abc", { languageId: "typescript" });

      expect(editor.getText()).toBe("abc");
      expect(editorRoot().textContent).toBe("abc");
      expect(editor.getState()).toMatchObject({
        documentId: null,
        languageId: "typescript",
        length: 3,
        canUndo: false,
        canRedo: false,
      });
    });

    it("opens editable documents and exposes editor state", () => {
      editor.openDocument({ documentId: "note.txt", text: "abc" });

      expect(editor.getText()).toBe("abc");
      expect(editorRoot().textContent).toBe("abc");
      expect(editor.getState()).toMatchObject({
        documentId: "note.txt",
        languageId: null,
        syntaxStatus: "plain",
        length: 3,
        canUndo: false,
        canRedo: false,
      });
    });

    it("routes text input through the owned document session", () => {
      const states: EditorState[] = [];
      editor.dispose();
      editor = new Editor(container, {
        onChange: (state) => states.push(state),
      });
      editor.openDocument({ documentId: "note.txt", text: "abc" });

      editorRoot().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "!",
          inputType: "insertText",
        }),
      );

      expect(editor.getText()).toBe("abc!");
      expect(editor.getState().canUndo).toBe(true);
      expect(states.at(-1)?.length).toBe(4);
    });

    it("routes undo through the owned document session", () => {
      editor.openDocument({ documentId: "note.txt", text: "abc" });
      editorRoot().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "!",
          inputType: "insertText",
        }),
      );

      editorRoot().dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "z",
          ...primaryModifier(),
        }),
      );

      expect(editor.getText()).toBe("abc");
      expect(editor.getState()).toMatchObject({ canUndo: false, canRedo: true });
    });

    it("clears owned documents", () => {
      editor.openDocument({ documentId: "note.txt", text: "abc" });
      editor.setTokens([{ start: 0, end: 3, style: { color: "#ff0000" } }]);

      editor.clearDocument();

      expect(editor.getText()).toBe("");
      expect(editor.getState()).toMatchObject({
        documentId: null,
        languageId: null,
        syntaxStatus: "plain",
        length: 0,
      });
      expect(highlightsMap.size).toBe(0);
    });

    it("applies focused programmatic edits", () => {
      editor.setText("abcdef");

      editor.edit({ from: 1, to: 4, text: "X" });

      expect(editor.getText()).toBe("aXef");
      expect(editor.getState()).toMatchObject({
        canUndo: true,
        cursor: { row: 0, column: 4 },
      });
    });

    it("creates an anonymous buffer before editing when needed", () => {
      editor.edit({ from: 0, to: 0, text: "hi" });

      expect(editor.getText()).toBe("hi");
      expect(editor.getState()).toMatchObject({
        documentId: null,
        length: 2,
        canUndo: true,
      });
    });

    it("applies batch edits as one editor change and one undo step", () => {
      const changes: DocumentSessionChange[] = [];
      editor.dispose();
      editor = new Editor(container, {
        onChange: (_state, change) => {
          if (change) changes.push(change);
        },
      });
      editor.setText("abcd");

      editor.edit([
        { from: 3, to: 3, text: "Y" },
        { from: 1, to: 2, text: "X" },
      ]);

      expect(editor.getText()).toBe("aXcYd");
      expect(changes).toHaveLength(1);
      expect(changes[0]?.edits).toEqual([
        { from: 1, to: 2, text: "X" },
        { from: 3, to: 3, text: "Y" },
      ]);

      editor.dispatchCommand("undo");
      expect(editor.getText()).toBe("abcd");
    });

    it("skips undo history for configured programmatic edits", () => {
      editor.setText("abc");

      editor.edit({ from: 3, to: 3, text: "!" }, { history: "skip" });

      expect(editor.getText()).toBe("abc!");
      expect(editor.getState().canUndo).toBe(false);
    });

    it("does not clear existing redo history for skipped programmatic edits", () => {
      editor.setText("abc");
      editor.edit({ from: 3, to: 3, text: "!" });
      editor.dispatchCommand("undo");

      expect(editor.getState().canRedo).toBe(true);
      editor.edit({ from: 3, to: 3, text: "?" }, { history: "skip" });

      expect(editor.getText()).toBe("abc?");
      expect(editor.getState().canRedo).toBe(true);
    });

    it("rejects invalid and overlapping programmatic edits without changing text", () => {
      editor.setText("abcd");

      expect(() => {
        editor.edit([
          { from: 1, to: 3, text: "X" },
          { from: 2, to: 4, text: "Y" },
        ]);
      }).toThrow(RangeError);
      expect(() => {
        editor.edit({ from: 10, to: 10, text: "!" });
      }).toThrow(RangeError);
      expect(editor.getText()).toBe("abcd");
    });

    it("supports explicit post-edit selections", () => {
      editor.setText("abcdef");

      editor.edit({ from: 0, to: 3, text: "let" }, { selection: { anchor: 1, head: 3 } });

      expect(editor.getState().cursor).toEqual({ row: 0, column: 3 });
      expect(window.getSelection()?.toString()).toBe("et");
    });

    it("uses explicit language ids for syntax highlights", async () => {
      const created: EditorSyntaxSessionOptions[] = [];
      setEditorSyntaxSessionFactory((options) => {
        created.push(options);
        return createMockSyntaxSession();
      });

      editor.openDocument({
        documentId: "main.ts",
        languageId: "typescript",
        text: "const a = 1;",
      });
      await flushMicrotasks();

      expect(created).toEqual([
        expect.objectContaining({
          documentId: "main.ts",
          includeHighlights: true,
          languageId: "typescript",
          text: "const a = 1;",
        }),
      ]);
      expect(editor.getState().syntaxStatus).toBe("ready");
      expect(highlightsMap.size).toBe(1);
    });

    it("does not infer language from document ids", async () => {
      const created: EditorSyntaxSessionOptions[] = [];
      setEditorSyntaxSessionFactory((options) => {
        created.push(options);
        return createMockSyntaxSession();
      });

      editor.openDocument({ documentId: "main.ts", text: "const a = 1;" });
      await flushMicrotasks();

      expect(created).toEqual([]);
      expect(editor.getState()).toMatchObject({
        languageId: null,
        syntaxStatus: "plain",
      });
      expect(highlightsMap.size).toBe(0);
    });

    it("uses plugin highlights instead of Tree-sitter tokens", async () => {
      const created: EditorSyntaxSessionOptions[] = [];
      const highlighter = createMockHighlighterSession({
        refresh: async () =>
          createHighlightResult([{ start: 6, end: 7, style: { color: "#00ff00" } }]),
      });
      editor.dispose();
      editor = new Editor(container, {
        plugins: withTestGutterPlugins(createHighlighterPlugin(highlighter)),
      });
      setEditorSyntaxSessionFactory((options) => {
        created.push(options);
        return createMockSyntaxSession({
          refresh: async () =>
            createSyntaxResult([{ start: 0, end: 5, style: { color: "#ff0000" } }]),
        });
      });

      editor.openDocument({
        documentId: "main.ts",
        languageId: "typescript",
        text: "const a = 1;",
      });
      await flushMicrotasks();

      expect(created[0]).toEqual(expect.objectContaining({ includeHighlights: false }));
      expect(tokenHighlightRanges()).toHaveLength(1);
      expect(tokenHighlightRanges()[0]?.startOffset).toBe(6);
    });

    it("applies highlighter theme colors without dropping configured Tree-sitter syntax colors", async () => {
      const highlighter = createMockHighlighterSession({
        refresh: async () =>
          createHighlightResult([], {
            backgroundColor: "#ffffff",
            foregroundColor: "#24292e",
            gutterForegroundColor: "#6e7781",
          }),
      });
      editor.dispose();
      editor = new Editor(container, {
        plugins: withTestLanguagePlugins(createHighlighterPlugin(highlighter)),
        theme: { syntax: { keyword: "#cf222e" } },
      });
      setEditorSyntaxSessionFactory(() => createMockSyntaxSession());

      editor.openDocument({
        documentId: "main.ts",
        languageId: "typescript",
        text: "const a = 1;",
      });
      await flushMicrotasks();

      const root = editorRoot();
      expect(root.style.getPropertyValue("--editor-background")).toBe("#ffffff");
      expect(root.style.getPropertyValue("--editor-foreground")).toBe("#24292e");
      expect(root.style.getPropertyValue("--editor-gutter-foreground")).toBe("#6e7781");
      expect(root.style.getPropertyValue("--editor-syntax-keyword")).toBe("#cf222e");
    });

    it("applies highlighter provider theme colors before a document is opened", async () => {
      const highlighter = createMockHighlighterSession();
      editor.dispose();
      editor = new Editor(container, {
        plugins: withTestLanguagePlugins(
          createHighlighterPlugin(highlighter, {
            loadTheme: async () => ({
              backgroundColor: "#ffffff",
              foregroundColor: "#24292e",
            }),
          }),
        ),
      });
      await flushMicrotasks();

      const root = editorRoot();
      expect(root.style.getPropertyValue("--editor-background")).toBe("#ffffff");
      expect(root.style.getPropertyValue("--editor-foreground")).toBe("#24292e");
      expect(editor.getState()).toMatchObject({ length: 0, canUndo: false });
    });

    it("keeps highlighter provider theme colors after clearing a document", async () => {
      const highlighter = createMockHighlighterSession({
        refresh: async () =>
          createHighlightResult([], {
            backgroundColor: "#0d1117",
          }),
      });
      editor.dispose();
      editor = new Editor(container, {
        plugins: withTestLanguagePlugins(
          createHighlighterPlugin(highlighter, {
            loadTheme: async () => ({ backgroundColor: "#ffffff" }),
          }),
        ),
      });
      await flushMicrotasks();

      editor.openDocument({
        documentId: "main.ts",
        languageId: "typescript",
        text: "const a = 1;",
      });
      await flushMicrotasks();
      expect(editorRoot().style.getPropertyValue("--editor-background")).toBe("#0d1117");

      editor.clearDocument();

      expect(editorRoot().style.getPropertyValue("--editor-background")).toBe("#ffffff");
    });

    it("keeps Tree-sitter folds when plugin highlights are active", async () => {
      const text = "if (x) {\n  y();\n}\nz();";
      const foldEnd = text.indexOf("\nz();");
      const highlighter = createMockHighlighterSession({
        refresh: async () =>
          createHighlightResult([{ start: 3, end: 4, style: { color: "#00ff00" } }]),
      });
      editor.dispose();
      editor = new Editor(container, {
        plugins: withTestGutterPlugins(createHighlighterPlugin(highlighter)),
      });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () =>
            createSyntaxResult(
              [{ start: 0, end: 2, style: { color: "#ff0000" } }],
              [
                {
                  startIndex: 0,
                  endIndex: foldEnd,
                  startLine: 0,
                  endLine: 2,
                  type: "statement_block",
                  languageId: "typescript",
                },
              ],
            ),
        }),
      );

      editor.openDocument({ documentId: "main.ts", languageId: "typescript", text });
      await flushMicrotasks();

      expect(foldToggle().dataset.editorFoldState).toBe("expanded");
      expect(tokenHighlightRanges()[0]?.startOffset).toBe(3);
    });

    it("renders syntax fold controls and toggles collapsed rows", async () => {
      const text = "if (x) {\n  y();\n}\nz();";
      const foldEnd = text.indexOf("\nz();");
      editor.dispose();
      editor = new Editor(container, { plugins: withTestGutterPlugins() });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () =>
            createSyntaxResult(
              [],
              [
                {
                  startIndex: 0,
                  endIndex: foldEnd,
                  startLine: 0,
                  endLine: 2,
                  type: "statement_block",
                  languageId: "typescript",
                },
              ],
            ),
        }),
      );

      editor.openDocument({ documentId: "main.ts", languageId: "typescript", text });
      await flushMicrotasks();

      expect(foldToggle().dataset.editorFoldState).toBe("expanded");
      expect(editorRoot().textContent).toContain("  y();");

      foldToggle().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

      expect(foldToggle().dataset.editorFoldState).toBe("collapsed");
      expect(editorRoot().textContent).toContain("...");
      expect(editorRoot().textContent).not.toContain("  y();");

      foldToggle().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

      expect(foldToggle().dataset.editorFoldState).toBe("expanded");
      expect(editorRoot().textContent).toContain("  y();");
    });

    it("hides fold controls on rows without fold candidates", async () => {
      const text = "if (x) {\n  y();\n}\nz();";
      const foldEnd = text.indexOf("\nz();");
      editor.dispose();
      editor = new Editor(container, { plugins: withTestGutterPlugins() });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () =>
            createSyntaxResult(
              [],
              [
                {
                  startIndex: 0,
                  endIndex: foldEnd,
                  startLine: 0,
                  endLine: 2,
                  type: "statement_block",
                  languageId: "typescript",
                },
              ],
            ),
        }),
      );

      editor.openDocument({ documentId: "main.ts", languageId: "typescript", text });
      await flushMicrotasks();

      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>(".editor-virtualized-fold-toggle"),
      ];
      const visible = buttons.filter((button) => !button.hidden);
      const hidden = buttons.filter((button) => button.hidden);

      expect(visible).toHaveLength(1);
      expect(hidden.length).toBeGreaterThan(0);
      expect(hidden.every((button) => button.disabled && button.tabIndex === -1)).toBe(true);
      expect(
        visible[0]
          ?.closest("[data-editor-virtual-gutter-row]")
          ?.getAttribute("data-editor-virtual-gutter-row"),
      ).toBe("0");
      expect(
        visible[0]?.previousElementSibling?.classList.contains("editor-virtualized-line-number"),
      ).toBe(true);
    });

    it("refreshes syntax after edits", async () => {
      const changes: string[] = [];
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          applyChange: async (change) => {
            changes.push(change.text);
            return createSyntaxResult([{ start: 6, end: 7, style: { color: "#00ff00" } }]);
          },
        }),
      );

      editor.openDocument({
        documentId: "main.ts",
        languageId: "typescript",
        text: "const a = 1;",
      });
      await flushMicrotasks();
      editorRoot().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "!",
          inputType: "insertText",
        }),
      );
      await flushMicrotasks();

      expect(changes).toEqual([]);
      await flushSyntaxDebounce();
      expect(changes).toEqual(["const a = 1;!"]);
      expect(editor.getState().syntaxStatus).toBe("ready");
      expect(highlightsMap.size).toBe(1);
    });

    it("keeps projected syntax highlights until edit syntax finishes", async () => {
      const editResult = createDeferred<EditorSyntaxResult>();
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () =>
            createSyntaxResult([{ start: 0, end: 5, style: { color: "#ff0000" } }]),
          applyChange: () => editResult.promise,
        }),
      );

      editor.openDocument({ documentId: "main.ts", languageId: "typescript", text: "world" });
      await flushMicrotasks();
      setCollapsedDomSelection(2);
      editorRoot().dispatchEvent(createInsertEvent("X"));

      const ranges = [...tokenHighlights()[0]!];
      expect(editor.getText()).toBe("woXrld");
      expect(ranges).toHaveLength(1);
      expect(ranges[0]!.startOffset).toBe(0);

      await flushSyntaxDebounce();
      editResult.resolve(createSyntaxResult([{ start: 0, end: 6, style: { color: "#00ff00" } }]));
      await flushMicrotasks();

      expect(editor.getState().syntaxStatus).toBe("ready");
      expect(tokenHighlights()).toHaveLength(1);
    });

    it("keeps syntax fold controls until edit syntax finishes", async () => {
      const text = "if (x) {\n  y();\n}\nz();";
      const foldEnd = text.indexOf("\nz();");
      const editResult = createDeferred<EditorSyntaxResult>();
      editor.dispose();
      editor = new Editor(container, { plugins: withTestGutterPlugins() });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () =>
            createSyntaxResult(
              [],
              [
                {
                  startIndex: 0,
                  endIndex: foldEnd,
                  startLine: 0,
                  endLine: 2,
                  type: "statement_block",
                  languageId: "typescript",
                },
              ],
            ),
          applyChange: () => editResult.promise,
        }),
      );

      editor.openDocument({ documentId: "main.ts", languageId: "typescript", text });
      await flushMicrotasks();
      editorRoot().dispatchEvent(createInsertEvent("!"));

      expect(editor.getText()).toBe(`${text}!`);
      expect(foldToggle().dataset.editorFoldState).toBe("expanded");

      await flushSyntaxDebounce();
      editResult.resolve(createSyntaxResult([], []));
      await flushMicrotasks();

      expect(document.querySelector(".editor-virtualized-fold-toggle:not([hidden])")).toBeNull();
    });

    it("keeps projected highlights and folds through undo while syntax is pending", async () => {
      const text = "if (x) {\n  y();\n}\nz();";
      const foldEnd = text.indexOf("\nz();");
      const changes: DocumentSessionChange[] = [];
      let refreshCount = 0;
      editor.dispose();
      editor = new Editor(container, { plugins: withTestGutterPlugins() });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () => {
            refreshCount += 1;
            return createSyntaxResult(
              [{ start: 0, end: 2, style: { color: "#ff0000" } }],
              [
                {
                  startIndex: 0,
                  endIndex: foldEnd,
                  startLine: 0,
                  endLine: 2,
                  type: "statement_block",
                  languageId: "typescript",
                },
              ],
            );
          },
          applyChange: async (change) => {
            changes.push(change);
            return createSyntaxResult(
              [{ start: 0, end: 2, style: { color: "#00ff00" } }],
              [
                {
                  startIndex: 0,
                  endIndex: foldEnd,
                  startLine: 0,
                  endLine: 2,
                  type: "statement_block",
                  languageId: "typescript",
                },
              ],
            );
          },
        }),
      );

      editor.openDocument({ documentId: "main.ts", languageId: "typescript", text });
      await flushMicrotasks();
      editorRoot().dispatchEvent(createInsertEvent("!"));
      editorRoot().dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "z",
          ...primaryModifier(),
        }),
      );

      expect(editor.getText()).toBe(text);
      expect(tokenHighlightRanges()).toHaveLength(1);
      expect(foldToggle().dataset.editorFoldState).toBe("expanded");
      expect(refreshCount).toBe(1);

      await flushSyntaxDebounce();
      expect(refreshCount).toBe(1);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        kind: "undo",
        edits: [{ from: text.length, to: text.length + 1, text: "" }],
      });
    });

    it("moves syntax fold controls through line edits while syntax is pending", async () => {
      const text = "a\nif (x) {\n  y();\n}\nz();";
      const foldStart = text.indexOf("if");
      const foldEnd = text.indexOf("\nz();");
      const editResult = createDeferred<EditorSyntaxResult>();
      editor.dispose();
      editor = new Editor(container, { plugins: withTestGutterPlugins() });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () =>
            createSyntaxResult(
              [],
              [
                {
                  startIndex: foldStart,
                  endIndex: foldEnd,
                  startLine: 1,
                  endLine: 3,
                  type: "statement_block",
                  languageId: "typescript",
                },
              ],
            ),
          applyChange: () => editResult.promise,
        }),
      );

      editor.openDocument({ documentId: "main.ts", languageId: "typescript", text });
      await flushMicrotasks();
      foldToggle().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      setCollapsedDomSelection(0);
      editorRoot().dispatchEvent(createLineBreakEvent());

      const gutterRow = foldToggle()
        .closest("[data-editor-virtual-gutter-row]")
        ?.getAttribute("data-editor-virtual-gutter-row");
      expect(gutterRow).toBe("2");
      expect(foldToggle().dataset.editorFoldState).toBe("collapsed");
      expect(editorRoot().textContent).toContain("...");
      expect(editorRoot().textContent).not.toContain("  y();");

      await flushSyntaxDebounce();
      editResult.resolve(createSyntaxResult([], []));
      await flushMicrotasks();
    });

    it("debounces rapid edit syntax requests to the latest text", async () => {
      const changes: string[] = [];
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () => createSyntaxResult([]),
          applyChange: async (change) => {
            changes.push(change.text);
            return createSyntaxResult([{ start: 0, end: 5, style: { color: "#00ff00" } }]);
          },
        }),
      );

      editor.openDocument({
        documentId: "main.ts",
        languageId: "typescript",
        text: "const a = 1;",
      });
      await flushMicrotasks();
      editorRoot().dispatchEvent(createInsertEvent("!"));
      editorRoot().dispatchEvent(createInsertEvent("?"));

      await flushSyntaxDebounce();
      expect(changes).toEqual(["const a = 1;!?"]);
      expect(editor.getText()).toBe("const a = 1;!?");
      expect(highlightsMap.size).toBe(1);
    });

    it("ignores stale syntax results after a newer edit", async () => {
      const initial = createDeferred<EditorSyntaxResult>();
      const firstEdit = createDeferred<EditorSyntaxResult>();
      const secondEdit = createDeferred<EditorSyntaxResult>();
      const editResults = [firstEdit, secondEdit];
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: () => initial.promise,
          applyChange: () => editResults.shift()!.promise,
        }),
      );

      editor.openDocument({
        documentId: "main.ts",
        languageId: "typescript",
        text: "const a = 1;",
      });
      initial.resolve(createSyntaxResult([]));
      await flushMicrotasks();
      editorRoot().dispatchEvent(createInsertEvent("!"));
      await flushSyntaxDebounce();
      editorRoot().dispatchEvent(createInsertEvent("?"));
      await flushSyntaxDebounce();

      secondEdit.resolve(createSyntaxResult([{ start: 0, end: 5, style: { color: "#00ff00" } }]));
      await flushMicrotasks();
      expect(highlightsMap.size).toBe(1);

      firstEdit.resolve(createSyntaxResult([{ start: 6, end: 7, style: { color: "#ff0000" } }]));
      await flushMicrotasks();
      expect(editor.getText()).toBe("const a = 1;!?");
      expect(highlightsMap.size).toBe(1);
    });

    it("debounces rapid edit plugin highlight requests to the latest text", async () => {
      const changes: string[] = [];
      const highlighter = createMockHighlighterSession({
        refresh: async () => createHighlightResult([]),
        applyChange: async (change) => {
          changes.push(change.text);
          return createHighlightResult([{ start: 0, end: 5, style: { color: "#00ff00" } }]);
        },
      });
      editor.dispose();
      editor = new Editor(container, {
        plugins: withTestLanguagePlugins(createHighlighterPlugin(highlighter)),
      });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () => createSyntaxResult([]),
          applyChange: async () => createSyntaxResult([]),
        }),
      );

      editor.openDocument({
        documentId: "main.ts",
        languageId: "typescript",
        text: "const a = 1;",
      });
      await flushMicrotasks();
      editorRoot().dispatchEvent(createInsertEvent("!"));
      editorRoot().dispatchEvent(createInsertEvent("?"));

      await flushSyntaxDebounce();
      expect(changes).toEqual(["const a = 1;!?"]);
      expect(tokenHighlightRanges()[0]?.startOffset).toBe(0);
    });

    it("sends undo edits to plugin highlighter sessions", async () => {
      const changes: DocumentSessionChange[] = [];
      const highlighter = createMockHighlighterSession({
        refresh: async () => createHighlightResult([]),
        applyChange: async (change) => {
          changes.push(change);
          return createHighlightResult([]);
        },
      });
      editor.dispose();
      editor = new Editor(container, {
        plugins: withTestLanguagePlugins(createHighlighterPlugin(highlighter)),
      });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () => createSyntaxResult([]),
          applyChange: async () => createSyntaxResult([]),
        }),
      );

      editor.openDocument({
        documentId: "main.ts",
        languageId: "typescript",
        text: "const a = 1;",
      });
      await flushMicrotasks();
      editorRoot().dispatchEvent(createInsertEvent("!"));
      editorRoot().dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "z",
          ...primaryModifier(),
        }),
      );

      await flushSyntaxDebounce();
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        kind: "undo",
        edits: [{ from: 12, to: 13, text: "" }],
      });
    });

    it("ignores stale plugin highlight results after a newer edit", async () => {
      const firstEdit = createDeferred<EditorHighlightResult>();
      const secondEdit = createDeferred<EditorHighlightResult>();
      const editResults = [firstEdit, secondEdit];
      const highlighter = createMockHighlighterSession({
        refresh: async () => createHighlightResult([]),
        applyChange: () => editResults.shift()!.promise,
      });
      editor.dispose();
      editor = new Editor(container, {
        plugins: withTestLanguagePlugins(createHighlighterPlugin(highlighter)),
      });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () => createSyntaxResult([]),
          applyChange: async () => createSyntaxResult([]),
        }),
      );

      editor.openDocument({
        documentId: "main.ts",
        languageId: "typescript",
        text: "const a = 1;",
      });
      await flushMicrotasks();
      editorRoot().dispatchEvent(createInsertEvent("!"));
      await flushSyntaxDebounce();
      editorRoot().dispatchEvent(createInsertEvent("?"));
      await flushSyntaxDebounce();

      secondEdit.resolve(
        createHighlightResult([{ start: 0, end: 5, style: { color: "#00ff00" } }]),
      );
      await flushMicrotasks();
      expect(tokenHighlightRanges()[0]?.startOffset).toBe(0);

      firstEdit.resolve(createHighlightResult([{ start: 6, end: 7, style: { color: "#ff0000" } }]));
      await flushMicrotasks();
      expect(editor.getText()).toBe("const a = 1;!?");
      expect(tokenHighlightRanges()[0]?.startOffset).toBe(0);
    });

    it("keeps structural syntax ready when plugin highlighting fails", async () => {
      const highlighter = createMockHighlighterSession({
        refresh: async () => {
          throw new Error("highlight failed");
        },
      });
      editor.dispose();
      editor = new Editor(container, {
        plugins: withTestLanguagePlugins(createHighlighterPlugin(highlighter)),
      });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () => createSyntaxResult([]),
        }),
      );

      editor.openDocument({
        documentId: "main.ts",
        languageId: "typescript",
        text: "const a = 1;",
      });
      await flushMicrotasks();

      expect(editor.getState().syntaxStatus).toBe("ready");
      expect(tokenHighlights()).toHaveLength(0);
    });

    it("falls back to plain text for unknown languages", async () => {
      const created: EditorSyntaxSessionOptions[] = [];
      setEditorSyntaxSessionFactory((options) => {
        created.push(options);
        return createMockSyntaxSession();
      });

      editor.openDocument({ documentId: "README", text: "hello" });
      await flushMicrotasks();

      expect(created).toEqual([]);
      expect(editor.getState().syntaxStatus).toBe("plain");
      expect(highlightsMap.size).toBe(0);
    });

    it("keeps explicit but unregistered languages editable", async () => {
      editor.dispose();
      editor = new Editor(container);

      editor.openDocument({ documentId: "main.rs", languageId: "rust", text: "fn main() {}" });
      await flushMicrotasks();
      editorRoot().dispatchEvent(createLineBreakEvent());
      await flushSyntaxDebounce();

      expect(editor.getText()).toBe("fn main() {}\n");
      expect(editor.getState()).toMatchObject({
        languageId: "rust",
        syntaxStatus: "ready",
      });
      expect(highlightsMap.size).toBe(0);
    });

    it("marks syntax errors without blocking editing", async () => {
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () => {
            throw new Error("parse failed");
          },
        }),
      );

      editor.openDocument({
        documentId: "main.ts",
        languageId: "typescript",
        text: "const a = 1;",
      });
      await flushMicrotasks();
      expect(editor.getState().syntaxStatus).toBe("error");
      editorRoot().dispatchEvent(createInsertEvent("!"));

      expect(editor.getText()).toBe("const a = 1;!");
    });
  });

  describe("clear", () => {
    it("clears content and highlights", () => {
      editor.setContent("test");
      editor.setTokens([{ start: 0, end: 4, style: { color: "#ff0000" } }]);
      editor.clear();
      expect(editorRoot().textContent).toBe("");
      expect(highlightsMap.size).toBe(0);
    });
  });

  describe("dispose", () => {
    it("removes elements from DOM", () => {
      expect(container.querySelector(".editor-virtualized")).not.toBeNull();
      editor.dispose();
      expect(container.querySelector(".editor-virtualized")).toBeNull();
    });
  });
});
