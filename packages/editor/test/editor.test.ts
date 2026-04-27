import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentSession,
  Editor,
  resetEditorInstanceCount,
  resolveSelection,
  setHighlightRegistry,
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
  });

  describe("setContent", () => {
    it("sets the text content", () => {
      editor.setContent("hello world");
      expect(container.querySelector("pre")!.textContent).toBe("hello world");
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

      expect(container.querySelector("pre")!.textContent).toBe("XXabcdef");
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
      expect(container.querySelector("pre")!.textContent).toBe("hello beautiful world");
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
      container.querySelector("pre")!.dispatchEvent(event);

      expect(session.getText()).toBe("abc!");
      expect(container.querySelector("pre")!.textContent).toBe("abc!");
    });

    it("routes undo through a document session", () => {
      const session = createDocumentSession("abc");
      editor.attachSession(session);
      session.applyText("!");

      container.querySelector("pre")!.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "z",
          metaKey: true,
        }),
      );

      expect(session.getText()).toBe("abc");
      expect(container.querySelector("pre")!.textContent).toBe("abc");
    });

    it("keeps browser selections synced to the document session", () => {
      const session = createDocumentSession("abcd");
      editor.attachSession(session);
      const textNode = container.querySelector("pre")!.firstChild!;
      const range = document.createRange();
      range.setStart(textNode, 1);
      range.setEnd(textNode, 3);

      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      container.querySelector("pre")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      const resolved = resolveSelection(
        session.getSnapshot(),
        session.getSelections().selections[0]!,
      );
      expect(resolved.startOffset).toBe(1);
      expect(resolved.endOffset).toBe(3);

      container.querySelector("pre")!.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "X",
          inputType: "insertText",
        }),
      );

      expect(session.getText()).toBe("aXd");
      expect(container.querySelector("pre")!.textContent).toBe("aXd");
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
      const textNode = container.querySelector("pre")!.firstChild!;
      const range = document.createRange();
      range.setStart(before.firstChild!, 0);
      range.setEnd(textNode, 2);

      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      container.querySelector("pre")!.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "X",
          inputType: "insertText",
        }),
      );

      expect(session.getText()).toBe("Xcd");
      expect(container.querySelector("pre")!.textContent).toBe("Xcd");
      before.remove();
      after.remove();
    });

    it("selects the current line on triple click", () => {
      const session = createDocumentSession("one\ntwo\nthree");
      editor.attachSession(session);

      const textNode = container.querySelector("pre")!.firstChild!;
      const range = document.createRange();
      range.setStart(textNode, 5);
      range.setEnd(textNode, 5);
      const originalCaretRangeFromPoint = (
        document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      ).caretRangeFromPoint;
      Object.defineProperty(document, "caretRangeFromPoint", {
        configurable: true,
        value: () => range,
      });

      container.querySelector("pre")!.dispatchEvent(
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

      container.querySelector("pre")!.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "X",
          inputType: "insertText",
        }),
      );

      expect(session.getText()).toBe("one\nX\nthree");
      expect(container.querySelector("pre")!.textContent).toBe("one\nX\nthree");
    });

    it("selects the full document on quad click", () => {
      const session = createDocumentSession("abcd");
      editor.attachSession(session);

      container.querySelector("pre")!.dispatchEvent(
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

      container.querySelector("pre")!.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "X",
          inputType: "insertText",
        }),
      );

      expect(session.getText()).toBe("X");
      expect(container.querySelector("pre")!.textContent).toBe("X");
    });

    it("selects a word on double click", () => {
      const session = createDocumentSession("alpha beta");
      editor.attachSession(session);

      const textNode = container.querySelector("pre")!.firstChild!;
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

      container.querySelector("pre")!.dispatchEvent(
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

      container.querySelector("pre")!.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "X",
          inputType: "insertText",
        }),
      );

      expect(session.getText()).toBe("alpha X");
      expect(container.querySelector("pre")!.textContent).toBe("alpha X");
    });
  });

  describe("clear", () => {
    it("clears content and highlights", () => {
      editor.setContent("test");
      editor.setTokens([{ start: 0, end: 4, style: { color: "#ff0000" } }]);
      editor.clear();
      expect(container.querySelector("pre")!.textContent).toBe("");
      expect(highlightsMap.size).toBe(0);
    });
  });

  describe("dispose", () => {
    it("removes elements from DOM", () => {
      expect(container.querySelector("pre")).not.toBeNull();
      editor.dispose();
      expect(container.querySelector("pre")).toBeNull();
    });
  });
});
