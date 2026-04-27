import { describe, expect, it } from "vitest";
import {
  createDocumentSession,
  getPieceTableText,
  resolveSelection,
  type DocumentSession,
} from "../src";

function resolvedOffsets(session: DocumentSession): { start: number; end: number } {
  const selection = session.getSelections().selections[0]!;
  const resolved = resolveSelection(session.getSnapshot(), selection);
  return { start: resolved.startOffset, end: resolved.endOffset };
}

describe("DocumentSession", () => {
  it("creates a piece-table snapshot with a collapsed selection at the end", () => {
    const session = createDocumentSession("abc");

    expect(getPieceTableText(session.getSnapshot())).toBe("abc");
    expect(session.getText()).toBe("abc");
    expect(resolvedOffsets(session)).toEqual({ start: 3, end: 3 });
    expect(session.canUndo()).toBe(false);
  });

  it("applies inserted text and records undo history", () => {
    const session = createDocumentSession("abc");
    const change = session.applyText("!");

    expect(change.kind).toBe("edit");
    expect(change.edits).toEqual([{ from: 3, to: 3, text: "!" }]);
    expect(session.getText()).toBe("abc!");
    expect(resolvedOffsets(session)).toEqual({ start: 4, end: 4 });
    expect(session.canUndo()).toBe(true);
  });

  it("backspaces by code point", () => {
    const session = createDocumentSession("a😀b");
    session.setSelection(3);
    session.backspace();

    expect(session.getText()).toBe("ab");
    expect(resolvedOffsets(session)).toEqual({ start: 1, end: 1 });
  });

  it("replaces selected ranges and collapses after inserted text", () => {
    const session = createDocumentSession("abcdef");
    session.setSelection(1, 4);
    const change = session.applyText("X");

    expect(change.edits).toEqual([{ from: 1, to: 4, text: "X" }]);
    expect(session.getText()).toBe("aXef");
    expect(resolvedOffsets(session)).toEqual({ start: 2, end: 2 });
  });

  it("undoes and redoes snapshot and selection state together", () => {
    const session = createDocumentSession("abc");
    session.applyText("!");
    const undone = session.undo();
    const redone = session.redo();

    expect(undone.text).toBe("abc");
    expect(redone.text).toBe("abc!");
    expect(session.getText()).toBe("abc!");
    expect(resolvedOffsets(session)).toEqual({ start: 4, end: 4 });
  });
});
