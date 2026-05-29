import type { DocumentSessionChange } from '../documentSession'
import type {
  EditorViewContribution,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '../plugins'

export type EditorViewContributionFailurePhase = 'dispose' | 'initial-update' | 'update'

export type EditorViewContributionFailureHandler = (
  contribution: EditorViewContribution,
  phase: EditorViewContributionFailurePhase,
  error: unknown,
) => void

export class EditorViewContributionController {
  private notifying = false
  private activeUpdateKind: EditorViewContributionUpdateKind | null = null
  private pendingLayout = false
  private readonly contributions: EditorViewContribution[]

  constructor(
    contributions: readonly EditorViewContribution[],
    private readonly createSnapshot: () => EditorViewSnapshot,
    private readonly onFailure: EditorViewContributionFailureHandler = () => undefined,
  ) {
    this.contributions = Array.from(contributions)
  }

  add(contribution: EditorViewContribution): void {
    this.contributions.push(contribution)
    this.updateContribution(contribution, this.createSnapshot(), 'document', null, 'initial-update')
  }

  remove(contribution: EditorViewContribution): void {
    const index = this.contributions.indexOf(contribution)
    if (index === -1) return

    this.contributions.splice(index, 1)
    this.disposeContribution(contribution)
  }

  dispose(): void {
    while (this.contributions.length > 0) {
      const contribution = this.contributions.pop()
      if (contribution) this.disposeContribution(contribution)
    }
  }

  notify(
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null = null,
  ): void {
    if (this.contributions.length === 0) return
    if (this.notifying) {
      this.queueReentrantUpdate(kind)
      return
    }

    this.notifying = true
    try {
      this.update(kind, change)
      this.flushPendingLayout()
    } finally {
      this.notifying = false
      this.activeUpdateKind = null
      this.pendingLayout = false
    }
  }

  private queueReentrantUpdate(kind: EditorViewContributionUpdateKind): void {
    if (kind !== 'layout') return
    if (this.activeUpdateKind === 'layout') return

    this.pendingLayout = true
  }

  private flushPendingLayout(): void {
    if (!this.pendingLayout) return

    this.pendingLayout = false
    this.update('layout', null)
  }

  private update(
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null,
  ): void {
    const snapshot = this.createSnapshot()
    this.activeUpdateKind = kind
    try {
      for (const contribution of Array.from(this.contributions))
        this.updateContribution(contribution, snapshot, kind, change, 'update')
    } finally {
      this.activeUpdateKind = null
    }
  }

  private updateContribution(
    contribution: EditorViewContribution,
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null,
    phase: EditorViewContributionFailurePhase,
  ): void {
    if (!this.contributions.includes(contribution)) return

    try {
      contribution.update(snapshot, kind, change)
    } catch (error) {
      this.removeFailedContribution(contribution, phase, error)
    }
  }

  private removeFailedContribution(
    contribution: EditorViewContribution,
    phase: EditorViewContributionFailurePhase,
    error: unknown,
  ): void {
    this.onFailure(contribution, phase, error)
    const index = this.contributions.indexOf(contribution)
    if (index !== -1) this.contributions.splice(index, 1)
    this.disposeContribution(contribution)
  }

  private disposeContribution(contribution: EditorViewContribution): void {
    try {
      contribution.dispose()
    } catch (error) {
      this.onFailure(contribution, 'dispose', error)
    }
  }
}
