import { createError } from '../logging/evlog'
import type { DocumentSessionChange } from '../documentSession'
import type {
  EditorViewContribution,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
  EditorViewportSnapshot,
  EditorVisiblePaintLayer,
} from '../plugins'
import {
  beginEditorViewSnapshotPaint,
  finalizeEditorViewSnapshotPaint,
  invalidateEditorViewSnapshotPaint,
} from './viewSnapshot'
import {
  copyEditorVisiblePaintLayer,
  freezeEditorVisiblePaintLayers,
  MAX_VISIBLE_PAINT_LAYERS,
  MAX_VISIBLE_PAINT_RECTANGLES,
} from './visiblePaint'

export type EditorViewContributionFailurePhase =
  | 'dispose'
  | 'initial-update'
  | 'update'
  | 'viewport'
  | 'capture-visible-paint'

export type EditorViewContributionFailureHandler = (
  contribution: EditorViewContribution,
  phase: EditorViewContributionFailurePhase,
  error: unknown,
) => void

export class EditorViewContributionController {
  private notifying = false
  private activeUpdateKind: EditorViewContributionUpdateKind | null = null
  private pendingLayout = false
  private currentSnapshot: EditorViewSnapshot | null = null
  private readonly contributions: EditorViewContribution[]
  private readonly initialUpdates = new Set<EditorViewContribution>()
  private readonly viewportContributions = new Set<EditorViewContribution>()

  constructor(
    contributions: readonly EditorViewContribution[],
    private readonly createSnapshot: () => EditorViewSnapshot,
    private readonly onFailure: EditorViewContributionFailureHandler = () => undefined,
    private readonly canPresent: () => boolean = () => true,
  ) {
    this.contributions = Array.from(contributions)
    for (const contribution of contributions) {
      if (contribution.updateViewport) this.viewportContributions.add(contribution)
    }
  }

  captureSnapshot(): EditorViewSnapshot {
    if (this.currentSnapshot && this.contributions.length > 0) return this.currentSnapshot
    const snapshot = this.createSnapshot()
    this.currentSnapshot = snapshot
    finalizeEditorViewSnapshotPaint(snapshot, () => this.captureVisiblePaint(snapshot))
    return snapshot
  }

  finishRestoration(): void {
    const snapshot = this.currentSnapshot
    if (!snapshot) return
    const failed = this.removeUnreadyContributions(snapshot)
    if (!failed) return
    this.currentSnapshot = null
    this.notify('document')
  }

  private removeUnreadyContributions(snapshot: EditorViewSnapshot): boolean {
    let failed = false
    this.notifying = true
    try {
      for (const contribution of Array.from(this.contributions)) {
        failed = this.rejectUnreadyContribution(contribution, snapshot) || failed
      }
    } finally {
      this.notifying = false
      this.pendingLayout = false
    }
    return failed
  }

  private rejectUnreadyContribution(
    contribution: EditorViewContribution,
    snapshot: EditorViewSnapshot,
  ): boolean {
    if (!contribution.captureVisiblePaint) return false
    try {
      if (contribution.captureVisiblePaint(snapshot).status === 'ready') return false
      throw createError({
        code: 'EDITOR_RESTORE_CONTRIBUTION_PENDING',
        status: 500,
        message: 'A snapshot contribution did not finish its authoritative paint synchronously',
        why: 'Restoration cannot publish a frame with an unfinished required paint layer.',
        fix: 'Finish the contribution in update, or remove snapshot support from its configuration.',
      })
    } catch (error) {
      this.removeFailedContribution(contribution, 'capture-visible-paint', error)
      return true
    }
  }

  paintConfiguration(): string | null {
    const ids: string[] = []
    for (const contribution of this.contributions) {
      if (contribution.captureVisiblePaint && !contribution.snapshotKey) return null
      if (contribution.snapshotKey) ids.push(contribution.snapshotKey)
    }
    return JSON.stringify(ids.sort())
  }

  add(contribution: EditorViewContribution): void {
    this.invalidateCurrentPaint()
    this.contributions.push(contribution)
    if (contribution.updateViewport) this.viewportContributions.add(contribution)
    this.initialUpdates.add(contribution)
    this.notifyMembershipChange()
  }

  remove(contribution: EditorViewContribution): void {
    const index = this.contributions.indexOf(contribution)
    if (index === -1) return

    this.contributions.splice(index, 1)
    this.viewportContributions.delete(contribution)
    this.initialUpdates.delete(contribution)
    this.disposeContribution(contribution)
    this.notifyMembershipChange()
  }

  dispose(): void {
    this.invalidateCurrentPaint()
    this.currentSnapshot = null
    this.initialUpdates.clear()
    this.viewportContributions.clear()
    while (this.contributions.length > 0) {
      const contribution = this.contributions.pop()
      if (contribution) this.disposeContribution(contribution)
    }
  }

  notifyViewport(createViewport: () => EditorViewportSnapshot): void {
    if (!this.canPresent() || this.notifying || this.viewportContributions.size === 0) return
    this.notifying = true
    try {
      const viewport = createViewport()
      if (viewport.clientHeight === 0) return
      for (const contribution of this.viewportContributions) {
        this.updateContributionViewport(contribution, viewport)
      }
      this.flushPendingLayout()
    } finally {
      this.notifying = false
      this.activeUpdateKind = null
      this.pendingLayout = false
    }
  }

  private updateContributionViewport(
    contribution: EditorViewContribution,
    viewport: EditorViewportSnapshot,
  ): void {
    try {
      contribution.updateViewport?.(viewport)
    } catch (error) {
      this.removeFailedContribution(contribution, 'viewport', error)
      this.notifyMembershipChange()
    }
  }

  notify(
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null = null,
  ): void {
    if (!this.canPresent() || this.contributions.length === 0) return
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
    this.invalidateCurrentPaint()
    const snapshot = this.createSnapshot()
    this.currentSnapshot = snapshot
    beginEditorViewSnapshotPaint(snapshot)
    this.activeUpdateKind = kind
    try {
      for (const contribution of Array.from(this.contributions))
        this.updateContribution(contribution, snapshot, kind, change)
      finalizeEditorViewSnapshotPaint(snapshot, () => this.captureVisiblePaint(snapshot))
    } finally {
      this.activeUpdateKind = null
    }
  }

  private captureVisiblePaint(
    snapshot: EditorViewSnapshot,
  ): readonly EditorVisiblePaintLayer[] | null {
    if (snapshot !== this.currentSnapshot || snapshot.syntaxStatus === 'loading') return null
    const layers: EditorVisiblePaintLayer[] = []
    const ids = new Set<string>()
    let remainingRectangles = MAX_VISIBLE_PAINT_RECTANGLES
    for (const contribution of Array.from(this.contributions)) {
      const layer = this.captureContribution(contribution, snapshot, ids, remainingRectangles)
      if (layer === null) return null
      if (layer === undefined) continue
      layers.push(layer)
      ids.add(layer.id)
      remainingRectangles -= layer.rectangles.length
    }
    if (snapshot !== this.currentSnapshot) return null
    return freezeEditorVisiblePaintLayers(layers)
  }

  private captureContribution(
    contribution: EditorViewContribution,
    snapshot: EditorViewSnapshot,
    ids: ReadonlySet<string>,
    remainingRectangles: number,
  ): EditorVisiblePaintLayer | null | undefined {
    if (!contribution.captureVisiblePaint || !this.contributions.includes(contribution)) return
    try {
      const capture = contribution.captureVisiblePaint(snapshot)
      if (capture.status === 'pending') return null
      if (ids.size >= MAX_VISIBLE_PAINT_LAYERS || ids.has(capture.id)) {
        throw new RangeError('Editor snapshot paint layers must have bounded, unique ids')
      }
      return copyEditorVisiblePaintLayer(capture, remainingRectangles)
    } catch (error) {
      this.removeFailedContribution(contribution, 'capture-visible-paint', error)
      this.notifyMembershipChange()
      return null
    }
  }

  private invalidateCurrentPaint(): void {
    if (this.currentSnapshot) invalidateEditorViewSnapshotPaint(this.currentSnapshot)
  }

  private notifyMembershipChange(): void {
    this.invalidateCurrentPaint()
    if (this.notifying) {
      this.pendingLayout = true
      return
    }
    this.notify('layout')
  }

  private updateContribution(
    contribution: EditorViewContribution,
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null,
  ): void {
    if (!this.contributions.includes(contribution)) return
    const initialUpdate = this.initialUpdates.delete(contribution)
    try {
      contribution.update(
        snapshot,
        initialUpdate ? 'document' : kind,
        initialUpdate ? null : change,
      )
    } catch (error) {
      this.removeFailedContribution(
        contribution,
        initialUpdate ? 'initial-update' : 'update',
        error,
      )
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
    this.viewportContributions.delete(contribution)
    this.initialUpdates.delete(contribution)
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
