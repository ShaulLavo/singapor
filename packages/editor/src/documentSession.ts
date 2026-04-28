import {
  applyTextToSelections,
  backspaceSelections,
  createAnchorSelection,
  createSelectionSet,
  deleteSelections,
  type SelectionGoal,
  type SelectionSet,
} from "./selections";
import {
  commitEditorHistory,
  createEditorHistory,
  redoEditorHistory,
  undoEditorHistory,
  type PieceTableEditorHistory,
} from "./history";
import type { EditorToken, TextEdit } from "./tokens";
import type { Anchor as PieceTableAnchor, PieceTableSnapshot } from "./pieceTable/pieceTableTypes";
import { getPieceTableText } from "./pieceTable/reads";
import { createPieceTableSnapshot } from "./pieceTable/snapshot";

export type DocumentSessionChangeKind = "edit" | "selection" | "undo" | "redo" | "none";

export type EditorTimingMeasurement = {
  readonly name: string;
  readonly durationMs: number;
};

export type DocumentSessionChange = {
  readonly kind: DocumentSessionChangeKind;
  readonly edits: readonly TextEdit[];
  readonly snapshot: PieceTableSnapshot;
  readonly selections: SelectionSet<PieceTableAnchor>;
  readonly text: string;
  readonly tokens: readonly EditorToken[];
  readonly timings: readonly EditorTimingMeasurement[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
};

export type DocumentSession = {
  applyText(text: string): DocumentSessionChange;
  backspace(): DocumentSessionChange;
  deleteSelection(): DocumentSessionChange;
  undo(): DocumentSessionChange;
  redo(): DocumentSessionChange;
  setSelection(
    anchorOffset: number,
    headOffset?: number,
    options?: DocumentSessionSelectionOptions,
  ): DocumentSessionChange;
  setTokens(tokens: readonly EditorToken[]): DocumentSessionChange;
  adoptTokens(tokens: readonly EditorToken[]): DocumentSessionChange;
  getText(): string;
  getTokens(): readonly EditorToken[];
  getSelections(): SelectionSet<PieceTableAnchor>;
  getSnapshot(): PieceTableSnapshot;
  canUndo(): boolean;
  canRedo(): boolean;
};

export type DocumentSessionSelectionOptions = {
  readonly goal?: SelectionGoal;
};

class PieceTableDocumentSession implements DocumentSession {
  private history: PieceTableEditorHistory;
  private text: string;
  private tokens: readonly EditorToken[] = [];
  private undoEdits: readonly (readonly TextEdit[])[];
  private redoEdits: readonly (readonly TextEdit[])[];

  public constructor(text: string) {
    const snapshot = createPieceTableSnapshot(text);
    const selections = createSelectionSet([createAnchorSelection(snapshot, snapshot.length)], true);
    this.history = createEditorHistory(snapshot, selections);
    this.text = text;
    this.undoEdits = [];
    this.redoEdits = [];
  }

  public applyText(text: string): DocumentSessionChange {
    const start = nowMs();
    if (text.length === 0) {
      return appendTiming(this.createChange("none", []), "session.applyText", start);
    }

    const result = applyTextToSelections(this.history.current, this.history.selections, text);
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits),
      "session.applyText",
      start,
    );
  }

  public backspace(): DocumentSessionChange {
    const start = nowMs();
    const result = backspaceSelections(this.history.current, this.history.selections);
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits),
      "session.backspace",
      start,
    );
  }

  public deleteSelection(): DocumentSessionChange {
    const start = nowMs();
    const result = deleteSelections(this.history.current, this.history.selections);
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits),
      "session.delete",
      start,
    );
  }

  public undo(): DocumentSessionChange {
    const start = nowMs();
    const next = undoEditorHistory(this.history);
    if (next === this.history) {
      return appendTiming(this.createChange("none", []), "session.undo", start);
    }

    const previousSnapshot = this.history.current;
    this.history = next;
    this.refreshText();
    const edits = this.consumeUndoEdits(previousSnapshot);
    return appendTiming(this.createChange("undo", edits), "session.undo", start);
  }

  public redo(): DocumentSessionChange {
    const start = nowMs();
    const next = redoEditorHistory(this.history);
    if (next === this.history) {
      return appendTiming(this.createChange("none", []), "session.redo", start);
    }

    const previousSnapshot = this.history.current;
    this.history = next;
    this.refreshText();
    const edits = this.consumeRedoEdits(previousSnapshot);
    return appendTiming(this.createChange("redo", edits), "session.redo", start);
  }

  public setSelection(
    anchorOffset: number,
    headOffset = anchorOffset,
    options: DocumentSessionSelectionOptions = {},
  ): DocumentSessionChange {
    const start = nowMs();
    const selection = createAnchorSelection(this.history.current, anchorOffset, headOffset, {
      goal: options.goal,
    });
    const selections = createSelectionSet([selection], true);
    this.history = { ...this.history, selections };
    return appendTiming(this.createChange("selection", []), "session.selection", start);
  }

  public setTokens(tokens: readonly EditorToken[]): DocumentSessionChange {
    return this.adoptTokens([...tokens]);
  }

  public adoptTokens(tokens: readonly EditorToken[]): DocumentSessionChange {
    const start = nowMs();
    this.tokens = tokens;
    return appendTiming(this.createChange("none", []), "session.setTokens", start);
  }

  public getText(): string {
    return this.text;
  }

  public getTokens(): readonly EditorToken[] {
    return this.tokens;
  }

  public getSelections(): SelectionSet<PieceTableAnchor> {
    return this.history.selections;
  }

  public getSnapshot(): PieceTableSnapshot {
    return this.history.current;
  }

  public canUndo(): boolean {
    return this.history.undo !== null;
  }

  public canRedo(): boolean {
    return this.history.redo !== null;
  }

  private commitEdit(
    snapshot: PieceTableSnapshot,
    selections: SelectionSet<PieceTableAnchor>,
    edits: readonly TextEdit[],
  ): DocumentSessionChange {
    if (edits.length === 0) return this.createChange("none", []);

    this.recordEditHistory(edits);
    this.history = commitEditorHistory(this.history, snapshot, selections);
    this.refreshText();
    return this.createChange("edit", edits);
  }

  private recordEditHistory(edits: readonly TextEdit[]): void {
    const undoEdits = invertTextEdits(this.history.current, edits);
    this.undoEdits = [...this.undoEdits, undoEdits];
    this.redoEdits = [];
  }

  private consumeUndoEdits(previousSnapshot: PieceTableSnapshot): readonly TextEdit[] {
    const edits = this.undoEdits.at(-1) ?? [];
    this.undoEdits = this.undoEdits.slice(0, -1);
    this.redoEdits = [...this.redoEdits, invertTextEdits(previousSnapshot, edits)];
    return edits;
  }

  private consumeRedoEdits(previousSnapshot: PieceTableSnapshot): readonly TextEdit[] {
    const edits = this.redoEdits.at(-1) ?? [];
    this.redoEdits = this.redoEdits.slice(0, -1);
    this.undoEdits = [...this.undoEdits, invertTextEdits(previousSnapshot, edits)];
    return edits;
  }

  private refreshText(): void {
    this.text = getPieceTableText(this.history.current);
  }

  private createChange(
    kind: DocumentSessionChangeKind,
    edits: readonly TextEdit[],
  ): DocumentSessionChange {
    return {
      kind,
      edits,
      snapshot: this.history.current,
      selections: this.history.selections,
      text: this.text,
      tokens: this.tokens,
      timings: [],
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    };
  }
}

export function createDocumentSession(text: string): DocumentSession {
  return new PieceTableDocumentSession(text);
}

function invertTextEdits(
  snapshot: PieceTableSnapshot,
  edits: readonly TextEdit[],
): readonly TextEdit[] {
  let delta = 0;
  const inverse: TextEdit[] = [];
  const sorted = edits.toSorted((left, right) => left.from - right.from || left.to - right.to);

  for (const edit of sorted) {
    const from = edit.from + delta;
    const to = from + edit.text.length;
    inverse.push({
      from,
      to,
      text: getPieceTableText(snapshot, edit.from, edit.to),
    });
    delta += edit.text.length - (edit.to - edit.from);
  }

  return inverse;
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function appendTiming(
  change: DocumentSessionChange,
  name: string,
  startMs: number,
): DocumentSessionChange {
  return {
    ...change,
    timings: [...change.timings, { name, durationMs: nowMs() - startMs }],
  };
}
