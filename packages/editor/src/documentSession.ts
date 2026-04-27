import {
  applyTextToSelections,
  backspaceSelections,
  createAnchorSelection,
  createSelectionSet,
  deleteSelections,
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
import {
  createPieceTableSnapshot,
  getPieceTableText,
  type PieceTableAnchor,
  type PieceTableSnapshot,
} from "./pieceTable";

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
  setSelection(anchorOffset: number, headOffset?: number): DocumentSessionChange;
  setTokens(tokens: readonly EditorToken[]): DocumentSessionChange;
  getText(): string;
  getTokens(): readonly EditorToken[];
  getSelections(): SelectionSet<PieceTableAnchor>;
  getSnapshot(): PieceTableSnapshot;
  canUndo(): boolean;
  canRedo(): boolean;
};

class PieceTableDocumentSession implements DocumentSession {
  private history: PieceTableEditorHistory;
  private text: string;
  private tokens: readonly EditorToken[] = [];

  public constructor(text: string) {
    const snapshot = createPieceTableSnapshot(text);
    const selections = createSelectionSet([createAnchorSelection(snapshot, snapshot.length)], true);
    this.history = createEditorHistory(snapshot, selections);
    this.text = text;
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

    this.history = next;
    this.refreshText();
    return appendTiming(this.createChange("undo", []), "session.undo", start);
  }

  public redo(): DocumentSessionChange {
    const start = nowMs();
    const next = redoEditorHistory(this.history);
    if (next === this.history) {
      return appendTiming(this.createChange("none", []), "session.redo", start);
    }

    this.history = next;
    this.refreshText();
    return appendTiming(this.createChange("redo", []), "session.redo", start);
  }

  public setSelection(anchorOffset: number, headOffset = anchorOffset): DocumentSessionChange {
    const start = nowMs();
    const selection = createAnchorSelection(this.history.current, anchorOffset, headOffset);
    const selections = createSelectionSet([selection], true);
    this.history = { ...this.history, selections };
    return appendTiming(this.createChange("selection", []), "session.selection", start);
  }

  public setTokens(tokens: readonly EditorToken[]): DocumentSessionChange {
    const start = nowMs();
    this.tokens = [...tokens];
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

    this.history = commitEditorHistory(this.history, snapshot, selections);
    this.refreshText();
    return this.createChange("edit", edits);
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
