import { createFoldMap } from "../foldMap";
import type { PieceTableSnapshot } from "../pieceTable/pieceTableTypes";
import type { FoldRange } from "../syntax/session";
import type {
  VirtualizedFoldMarker,
  VirtualizedTextView,
} from "../virtualization/virtualizedTextView";
import {
  EMPTY_FOLD_MARKERS,
  EMPTY_SYNTAX_FOLDS,
  foldMarkerFromRange,
  foldRangeKey,
  foldRangesEqual,
  type SyntaxFoldProjection,
} from "./folds";

type FoldView = Pick<VirtualizedTextView, "setFoldState">;

export class EditorFoldState {
  private readonly view: FoldView;
  private readonly getSnapshot: () => PieceTableSnapshot | null;
  private syntaxFolds: readonly FoldRange[] = EMPTY_SYNTAX_FOLDS;
  private collapsedFoldKeys = new Set<string>();

  public constructor(view: FoldView, getSnapshot: () => PieceTableSnapshot | null) {
    this.view = view;
    this.getSnapshot = getSnapshot;
  }

  public get folds(): readonly FoldRange[] {
    return this.syntaxFolds;
  }

  public setSyntaxFolds(folds: readonly FoldRange[]): void {
    if (foldRangesEqual(this.syntaxFolds, folds)) return;

    this.syntaxFolds = folds.length === 0 ? EMPTY_SYNTAX_FOLDS : [...folds];
    this.pruneCollapsedFolds();
    this.syncFoldView();
  }

  public clear(): void {
    this.syntaxFolds = EMPTY_SYNTAX_FOLDS;
    if (this.collapsedFoldKeys.size > 0) this.collapsedFoldKeys.clear();
    this.view.setFoldState(EMPTY_FOLD_MARKERS, null);
  }

  public applyProjection(projection: SyntaxFoldProjection | null): void {
    if (!projection) return;

    this.remapCollapsedFoldKeys(projection.keyMap);
    this.setSyntaxFolds(projection.folds);
  }

  public toggle(marker: VirtualizedFoldMarker): void {
    if (this.collapsedFoldKeys.has(marker.key)) {
      this.collapsedFoldKeys.delete(marker.key);
      this.syncFoldView();
      return;
    }

    this.collapsedFoldKeys.add(marker.key);
    this.syncFoldView();
  }

  private remapCollapsedFoldKeys(keyMap: ReadonlyMap<string, string>): void {
    if (this.collapsedFoldKeys.size === 0) return;
    if (keyMap.size === 0) return;

    const nextKeys = new Set<string>();
    for (const key of this.collapsedFoldKeys) {
      nextKeys.add(keyMap.get(key) ?? key);
    }
    this.collapsedFoldKeys = nextKeys;
  }

  private pruneCollapsedFolds(): void {
    const foldKeys = new Set(this.syntaxFolds.map((fold) => foldRangeKey(fold)));
    for (const key of this.collapsedFoldKeys) {
      if (foldKeys.has(key)) continue;
      this.collapsedFoldKeys.delete(key);
    }
  }

  private syncFoldView(): void {
    const snapshot = this.getSnapshot();
    if (!snapshot || this.syntaxFolds.length === 0) {
      this.view.setFoldState(EMPTY_FOLD_MARKERS, null);
      return;
    }

    const markers = this.syntaxFolds.map((fold) =>
      foldMarkerFromRange(fold, this.collapsedFoldKeys),
    );
    const collapsedFolds = this.syntaxFolds.filter((fold) => {
      return this.collapsedFoldKeys.has(foldRangeKey(fold));
    });

    const foldMap = collapsedFolds.length > 0 ? createFoldMap(snapshot, collapsedFolds) : null;
    this.view.setFoldState(markers, foldMap);
  }
}
