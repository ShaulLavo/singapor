import type { DocumentSessionChange } from "../documentSession";
import type {
  EditorViewContribution,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from "../plugins";

export class EditorViewContributionController {
  private notifying = false;
  private activeUpdateKind: EditorViewContributionUpdateKind | null = null;
  private pendingLayout = false;

  constructor(
    private readonly contributions: readonly EditorViewContribution[],
    private readonly createSnapshot: () => EditorViewSnapshot,
  ) {}

  notify(
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null = null,
  ): void {
    if (this.contributions.length === 0) return;
    if (this.notifying) {
      this.queueReentrantUpdate(kind);
      return;
    }

    this.notifying = true;
    try {
      this.update(kind, change);
      this.flushPendingLayout();
    } finally {
      this.notifying = false;
      this.activeUpdateKind = null;
      this.pendingLayout = false;
    }
  }

  private queueReentrantUpdate(kind: EditorViewContributionUpdateKind): void {
    if (kind !== "layout") return;
    if (this.activeUpdateKind === "layout") return;

    this.pendingLayout = true;
  }

  private flushPendingLayout(): void {
    if (!this.pendingLayout) return;

    this.pendingLayout = false;
    this.update("layout", null);
  }

  private update(
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null,
  ): void {
    const snapshot = this.createSnapshot();
    this.activeUpdateKind = kind;
    try {
      for (const contribution of this.contributions) {
        contribution.update(snapshot, kind, change);
      }
    } finally {
      this.activeUpdateKind = null;
    }
  }
}
