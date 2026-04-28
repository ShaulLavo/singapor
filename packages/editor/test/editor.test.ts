import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectPlatform } from "@tanstack/hotkeys";
import {
  createDocumentSession,
  Editor,
  resetEditorInstanceCount,
  resolveSelection,
  setEditorSyntaxSessionFactory,
  setHighlightRegistry,
  type DocumentSessionChange,
  type EditorHighlightResult,
  type EditorHighlighterSession,
  type EditorPlugin,
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
): EditorHighlightResult {
  return { tokens };
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

function createHighlighterPlugin(session: EditorHighlighterSession): EditorPlugin {
  return {
    activate: (context) =>
      context.registerHighlighter({
        createSession: () => session,
      }),
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

function primaryModifier(): KeyboardEventInit {
  return detectPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };
}

function tokenHighlights(): Highlight[] {
  return [...highlightsMap]
    .filter(([name]) => name.includes("-token-"))
    .map(([, highlight]) => highlight);
}

function tokenHighlightRanges(): Range[] {
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
    editor = new Editor(container);
  });

  afterEach(() => {
    editor.dispose();
    container.remove();
    setHighlightRegistry(undefined);
    setEditorSyntaxSessionFactory(undefined);
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

    it("disposes view contributions with the editor", () => {
      const events: ViewContributionEvent[] = [];
      editor.dispose();
      editor = new Editor(container, { plugins: [createViewContributionPlugin(events)] });

      editor.dispose();

      expect(events.at(-1)?.kind).toBe("dispose");
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

    it("keeps vertical navigation on the preferred visual column", () => {
      const session = createDocumentSession("abcdef\nx\n12345");
      editor.attachSession(session);

      dispatchEditorKey("ArrowUp");
      dispatchEditorKey("ArrowUp");

      expect(editor.getState().cursor).toEqual({ row: 0, column: 5 });
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
      editor.openDocument({ text: "abc" });

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

    it("infers language and applies initial syntax highlights", async () => {
      const created: EditorSyntaxSessionOptions[] = [];
      setEditorSyntaxSessionFactory((options) => {
        created.push(options);
        return createMockSyntaxSession();
      });

      editor.openDocument({ documentId: "main.ts", text: "const a = 1;" });
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

    it("uses plugin highlights instead of Tree-sitter tokens", async () => {
      const created: EditorSyntaxSessionOptions[] = [];
      const highlighter = createMockHighlighterSession({
        refresh: async () =>
          createHighlightResult([{ start: 6, end: 7, style: { color: "#00ff00" } }]),
      });
      editor.dispose();
      editor = new Editor(container, { plugins: [createHighlighterPlugin(highlighter)] });
      setEditorSyntaxSessionFactory((options) => {
        created.push(options);
        return createMockSyntaxSession({
          refresh: async () =>
            createSyntaxResult([{ start: 0, end: 5, style: { color: "#ff0000" } }]),
        });
      });

      editor.openDocument({ documentId: "main.ts", text: "const a = 1;" });
      await flushMicrotasks();

      expect(created[0]).toEqual(expect.objectContaining({ includeHighlights: false }));
      expect(tokenHighlightRanges()).toHaveLength(1);
      expect(tokenHighlightRanges()[0]?.startOffset).toBe(6);
    });

    it("keeps Tree-sitter folds when plugin highlights are active", async () => {
      const text = "if (x) {\n  y();\n}\nz();";
      const foldEnd = text.indexOf("\nz();");
      const highlighter = createMockHighlighterSession({
        refresh: async () =>
          createHighlightResult([{ start: 3, end: 4, style: { color: "#00ff00" } }]),
      });
      editor.dispose();
      editor = new Editor(container, { plugins: [createHighlighterPlugin(highlighter)] });
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

      editor.openDocument({ documentId: "main.ts", text });
      await flushMicrotasks();

      expect(foldToggle().dataset.editorFoldState).toBe("expanded");
      expect(tokenHighlightRanges()[0]?.startOffset).toBe(3);
    });

    it("renders syntax fold controls and toggles collapsed rows", async () => {
      const text = "if (x) {\n  y();\n}\nz();";
      const foldEnd = text.indexOf("\nz();");
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

      editor.openDocument({ documentId: "main.ts", text });
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

      editor.openDocument({ documentId: "main.ts", text });
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

      editor.openDocument({ documentId: "main.ts", text: "const a = 1;" });
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

      editor.openDocument({ documentId: "main.ts", text: "world" });
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

      editor.openDocument({ documentId: "main.ts", text });
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

      editor.openDocument({ documentId: "main.ts", text });
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

      editor.openDocument({ documentId: "main.ts", text });
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

      editor.openDocument({ documentId: "main.ts", text: "const a = 1;" });
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

      editor.openDocument({ documentId: "main.ts", text: "const a = 1;" });
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
      editor = new Editor(container, { plugins: [createHighlighterPlugin(highlighter)] });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () => createSyntaxResult([]),
          applyChange: async () => createSyntaxResult([]),
        }),
      );

      editor.openDocument({ documentId: "main.ts", text: "const a = 1;" });
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
      editor = new Editor(container, { plugins: [createHighlighterPlugin(highlighter)] });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () => createSyntaxResult([]),
          applyChange: async () => createSyntaxResult([]),
        }),
      );

      editor.openDocument({ documentId: "main.ts", text: "const a = 1;" });
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
      editor = new Editor(container, { plugins: [createHighlighterPlugin(highlighter)] });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () => createSyntaxResult([]),
          applyChange: async () => createSyntaxResult([]),
        }),
      );

      editor.openDocument({ documentId: "main.ts", text: "const a = 1;" });
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
      editor = new Editor(container, { plugins: [createHighlighterPlugin(highlighter)] });
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () => createSyntaxResult([]),
        }),
      );

      editor.openDocument({ documentId: "main.ts", text: "const a = 1;" });
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

    it("marks syntax errors without blocking editing", async () => {
      setEditorSyntaxSessionFactory(() =>
        createMockSyntaxSession({
          refresh: async () => {
            throw new Error("parse failed");
          },
        }),
      );

      editor.openDocument({ documentId: "main.ts", text: "const a = 1;" });
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
