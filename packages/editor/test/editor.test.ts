import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentSession,
  Editor,
  resetEditorInstanceCount,
  resolveSelection,
  setEditorSyntaxSessionFactory,
  setHighlightRegistry,
  type DocumentSessionChange,
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

function createSyntaxResult(tokens = [{ start: 0, end: 5, style: { color: "#ff0000" } }]) {
  return {
    captures: [],
    folds: [],
    brackets: [],
    errors: [],
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
    dispose: () => undefined,
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createInsertEvent(data: string): InputEvent {
  return new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    data,
    inputType: "insertText",
  });
}

function editorRoot(): HTMLElement {
  return document.querySelector(".editor-virtualized") as HTMLElement;
}

function rowTextNode(row = 0): Text {
  const element = document.querySelector(`[data-editor-virtual-row="${row}"]`);
  return element?.firstChild as Text;
}

function editorInput(): HTMLTextAreaElement {
  return document.querySelector(".editor-virtualized-input") as HTMLTextAreaElement;
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
          metaKey: true,
        }),
      );

      expect(session.getText()).toBe("abc");
      expect(editorRoot().textContent).toBe("abc");
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
          metaKey: true,
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
        {
          documentId: "main.ts",
          languageId: "typescript",
          text: "const a = 1;",
        },
      ]);
      expect(editor.getState().syntaxStatus).toBe("ready");
      expect(highlightsMap.size).toBe(1);
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

      expect(changes).toEqual(["const a = 1;!"]);
      expect(editor.getState().syntaxStatus).toBe("ready");
      expect(highlightsMap.size).toBe(1);
    });

    it("ignores stale syntax results after rapid edits", async () => {
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
      editorRoot().dispatchEvent(createInsertEvent("?"));

      secondEdit.resolve(createSyntaxResult([{ start: 0, end: 5, style: { color: "#00ff00" } }]));
      await flushMicrotasks();
      expect(highlightsMap.size).toBe(1);

      firstEdit.resolve(createSyntaxResult([{ start: 6, end: 7, style: { color: "#ff0000" } }]));
      await flushMicrotasks();
      expect(editor.getText()).toBe("const a = 1;!?");
      expect(highlightsMap.size).toBe(1);
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
