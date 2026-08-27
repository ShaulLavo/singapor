import type { DocumentSessionChange } from './documentSession'
import {
  parseMergeConflicts,
  resolveMergeConflict,
  type MergeConflictRegion,
  type MergeConflictResolution,
} from './mergeConflicts'
import type {
  EditorDisposable,
  EditorFeatureContribution,
  EditorFeatureContributionContext,
  EditorInternalPluginContext,
  EditorPlugin,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from './plugins'
import { createEditorCapabilityToken } from './plugins'
import type { TextEdit } from './tokens'
import type { VirtualizedTextHighlightStyle } from './virtualization'
import type { EditorSetSelectionOptions } from './editor/selectionReveal'

export const EDITOR_MERGE_CONFLICT_FEATURE_ID = 'editor.mergeConflicts'

export type EditorMergeConflictFeature = {
  getConflicts(): readonly MergeConflictRegion[]
  resolveConflict(index: number, resolution: MergeConflictResolution): boolean
  revealConflict(index: number): boolean
}

export const EDITOR_MERGE_CONFLICT_FEATURE =
  createEditorCapabilityToken<EditorMergeConflictFeature>(EDITOR_MERGE_CONFLICT_FEATURE_ID)

export type EditorMergeConflictPluginOptions = {
  readonly actions?: boolean
}

type MergeConflictHost = {
  hasDocument(): boolean
  materializeFullText(): string
  focusEditor(): void
  setSelection(
    anchor: number,
    head: number,
    timingName: string,
    options?: EditorSetSelectionOptions,
  ): void
  applyEdits(
    edits: readonly TextEdit[],
    timingName: string,
    selection?: { readonly anchor: number; readonly head: number },
  ): void
  setRangeHighlight(
    name: string,
    ranges: readonly { readonly start: number; readonly end: number }[],
    style: VirtualizedTextHighlightStyle,
  ): void
  clearRangeHighlight(name: string): void
}

type ConflictListener = () => void

const MERGE_CONFLICT_OUTER_STYLE = { backgroundColor: 'rgba(245, 158, 11, 0.16)' }
const MERGE_CONFLICT_OURS_STYLE = { backgroundColor: 'rgba(34, 197, 94, 0.18)' }
const MERGE_CONFLICT_BASE_STYLE = { backgroundColor: 'rgba(161, 161, 170, 0.18)' }
const MERGE_CONFLICT_THEIRS_STYLE = { backgroundColor: 'rgba(59, 130, 246, 0.18)' }
const MERGE_CONFLICT_MARKER_CHAR_PATTERN = /[<=>|\r\n]/

export function createMergeConflictPlugin(
  options: EditorMergeConflictPluginOptions = {},
): EditorPlugin {
  let controller: EditorMergeConflictController | null = null

  return {
    name: EDITOR_MERGE_CONFLICT_FEATURE_ID,
    activate(context) {
      const internalContext = context as EditorInternalPluginContext
      return [
        internalContext.registerEditorFeatureContribution({
          createContribution(contributionContext) {
            controller = new EditorMergeConflictController(
              featureHost(contributionContext),
              contributionContext.highlightPrefix,
            )
            return createMergeConflictFeatureContribution(contributionContext, controller)
          },
        }),
        context.registerViewContribution({
          createContribution(contributionContext) {
            if (!controller) return null
            if (options.actions === false) return null
            return new MergeConflictActionsContribution(contributionContext, controller)
          },
        }),
      ]
    },
  }
}

class EditorMergeConflictController {
  private readonly outerHighlightName: string
  private readonly oursHighlightName: string
  private readonly baseHighlightName: string
  private readonly theirsHighlightName: string
  private readonly listeners = new Set<ConflictListener>()
  private conflicts: readonly MergeConflictRegion[] = []
  private signature = ''

  public constructor(
    private readonly host: MergeConflictHost,
    highlightPrefix: string,
  ) {
    this.outerHighlightName = `${highlightPrefix}-merge-conflict-outer`
    this.oursHighlightName = `${highlightPrefix}-merge-conflict-ours`
    this.baseHighlightName = `${highlightPrefix}-merge-conflict-base`
    this.theirsHighlightName = `${highlightPrefix}-merge-conflict-theirs`
  }

  public dispose(): void {
    this.clearHighlights()
    this.listeners.clear()
  }

  public subscribe(listener: ConflictListener): EditorDisposable {
    this.listeners.add(listener)
    return {
      dispose: () => this.listeners.delete(listener),
    }
  }

  public handleEditorChange(change: DocumentSessionChange | null): void {
    if (!change) return
    if (change.kind === 'selection' || change.kind === 'synchronize' || change.kind === 'none') {
      return
    }
    if (this.canSkipRefreshForChange(change)) return

    this.refresh()
  }

  public getConflicts(): readonly MergeConflictRegion[] {
    this.refresh()
    return this.conflicts
  }

  public peekConflicts(): readonly MergeConflictRegion[] {
    return this.conflicts
  }

  public activateFromSnapshot(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
  ): void {
    if (kind === 'document' || kind === 'clear') this.setConflicts([])
    if (this.conflicts.length > 0) return
    if (!snapshotMayContainMergeConflict(snapshot)) return

    this.refresh()
  }

  public resolveConflict(index: number, resolution: MergeConflictResolution): boolean {
    this.refresh()
    const text = this.host.materializeFullText()
    const conflict = this.conflicts[index]
    if (!conflict) return false

    const resolved = resolveMergeConflict(text, conflict, resolution)
    if (!resolved) return false

    this.host.applyEdits(
      [{ from: resolved.range.start, to: resolved.range.end, text: resolved.replacement }],
      'input.resolveMergeConflict',
      {
        anchor: resolved.selection.start,
        head: resolved.selection.end,
      },
    )
    return true
  }

  public revealConflict(index: number): boolean {
    this.refresh()
    const conflict = this.conflicts[index]
    if (!conflict) return false

    this.host.setSelection(
      conflict.range.start,
      conflict.range.start,
      'input.revealMergeConflict',
      { revealOffset: conflict.range.start },
    )
    this.host.focusEditor()
    return true
  }

  private refresh(): void {
    if (!this.host.hasDocument()) {
      this.setConflicts([])
      return
    }

    this.setConflicts(parseMergeConflicts(this.host.materializeFullText()))
  }

  private canSkipRefreshForChange(change: DocumentSessionChange | null): boolean {
    if (!change) return false
    if (this.conflicts.length > 0) return false

    return change.edits.every(isMergeConflictNeutralInsertion)
  }

  private setConflicts(conflicts: readonly MergeConflictRegion[]): void {
    const signature = conflictSignature(conflicts)
    if (this.signature === signature) return

    this.conflicts = conflicts
    this.signature = signature
    this.updateHighlights()
    this.emitChange()
  }

  private updateHighlights(): void {
    this.host.setRangeHighlight(
      this.outerHighlightName,
      this.conflictRanges(),
      MERGE_CONFLICT_OUTER_STYLE,
    )
    this.host.setRangeHighlight(
      this.oursHighlightName,
      this.oursRanges(),
      MERGE_CONFLICT_OURS_STYLE,
    )
    this.host.setRangeHighlight(
      this.baseHighlightName,
      this.baseRanges(),
      MERGE_CONFLICT_BASE_STYLE,
    )
    this.host.setRangeHighlight(
      this.theirsHighlightName,
      this.theirsRanges(),
      MERGE_CONFLICT_THEIRS_STYLE,
    )
  }

  private clearHighlights(): void {
    this.host.clearRangeHighlight(this.outerHighlightName)
    this.host.clearRangeHighlight(this.oursHighlightName)
    this.host.clearRangeHighlight(this.baseHighlightName)
    this.host.clearRangeHighlight(this.theirsHighlightName)
  }

  private conflictRanges(): readonly { readonly start: number; readonly end: number }[] {
    return this.conflicts.map((conflict) => conflict.range)
  }

  private oursRanges(): readonly { readonly start: number; readonly end: number }[] {
    return this.conflicts.map((conflict) => conflict.ours)
  }

  private baseRanges(): readonly { readonly start: number; readonly end: number }[] {
    return this.conflicts.flatMap((conflict) => (conflict.base ? [conflict.base] : []))
  }

  private theirsRanges(): readonly { readonly start: number; readonly end: number }[] {
    return this.conflicts.map((conflict) => conflict.theirs)
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener()
  }
}

class MergeConflictActionsContribution implements EditorViewContribution {
  private readonly root: HTMLDivElement
  private readonly subscription: EditorDisposable
  private latestSnapshot: EditorViewSnapshot

  public constructor(
    context: EditorViewContributionContext,
    private readonly controller: EditorMergeConflictController,
  ) {
    const document = context.scrollElement.ownerDocument
    this.latestSnapshot = context.getSnapshot()
    this.root = document.createElement('div')
    this.root.className = 'editor-merge-conflict-actions-layer'
    context.scrollElement.appendChild(this.root)
    this.subscription = controller.subscribe(() => this.render(context.getSnapshot()))
    this.controller.activateFromSnapshot(this.latestSnapshot, 'document')
    this.render(this.latestSnapshot)
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    _change?: DocumentSessionChange | null,
  ): void {
    this.controller.activateFromSnapshot(snapshot, kind)
    this.latestSnapshot = snapshot
    this.render(snapshot)
  }

  public dispose(): void {
    this.subscription.dispose()
    this.root.remove()
  }

  private render(snapshot: EditorViewSnapshot): void {
    this.root.textContent = ''
    for (const conflict of this.visibleConflicts(snapshot)) {
      this.root.appendChild(this.createActionRow(snapshot, conflict))
    }
  }

  private visibleConflicts(snapshot: EditorViewSnapshot): readonly MergeConflictRegion[] {
    const rows = snapshot.visibleRows
    if (rows.length === 0) return []

    const first = rows[0]!
    const last = rows[rows.length - 1]!
    return this.controller.peekConflicts().filter((conflict) => {
      if (conflict.range.end < first.startOffset) return false
      return conflict.range.start <= last.endOffset + 1
    })
  }

  private createActionRow(
    snapshot: EditorViewSnapshot,
    conflict: MergeConflictRegion,
  ): HTMLDivElement {
    const document = this.root.ownerDocument
    const row = document.createElement('div')
    row.className = 'editor-merge-conflict-actions'
    row.style.transform = `translate3d(0, ${this.actionTop(snapshot, conflict)}px, 0)`
    row.append(
      this.createResolveButton(conflict.index, {
        icon: 'ours',
        label: `Use ${shortConflictSideLabel(conflict.oursLabel, 'Local')}`,
        resolution: 'ours',
        title: `Use ${conflict.oursLabel}`,
      }),
      this.createResolveButton(conflict.index, {
        icon: 'theirs',
        label: `Use ${shortConflictSideLabel(conflict.theirsLabel, 'Remote')}`,
        resolution: 'theirs',
        title: `Use ${conflict.theirsLabel}`,
      }),
      this.createResolveButton(conflict.index, {
        icon: 'both',
        label: 'Use Both',
        resolution: 'both',
        title: 'Use both local and remote changes',
      }),
    )
    if (conflict.base)
      row.appendChild(
        this.createResolveButton(conflict.index, {
          icon: 'base',
          label: `Use ${shortConflictSideLabel(conflict.baseLabel ?? 'Base', 'Base')}`,
          resolution: 'base',
          title: `Use ${conflict.baseLabel ?? 'Base'}`,
        }),
      )
    return row
  }

  private actionTop(snapshot: EditorViewSnapshot, conflict: MergeConflictRegion): number {
    const row = visibleRowForOffset(snapshot, conflict.range.start)
    if (!row) return snapshot.viewport.scrollTop
    return Math.max(0, row.top)
  }

  private createResolveButton(index: number, action: MergeConflictAction): HTMLButtonElement {
    const button = this.root.ownerDocument.createElement('button')
    button.type = 'button'
    button.className = 'editor-merge-conflict-action'
    button.ariaLabel = action.title
    button.dataset.tooltip = action.title
    button.title = action.title
    button.append(createActionIcon(this.root.ownerDocument, action.icon), action.label)
    addResolveButtonListeners(button, () =>
      this.controller.resolveConflict(index, action.resolution),
    )
    return button
  }
}

type MergeConflictActionIcon = 'ours' | 'theirs' | 'both' | 'base'

type MergeConflictAction = {
  readonly icon: MergeConflictActionIcon
  readonly label: string
  readonly resolution: MergeConflictResolution
  readonly title: string
}

function createMergeConflictFeatureContribution(
  context: EditorFeatureContributionContext,
  controller: EditorMergeConflictController,
): EditorFeatureContribution {
  const feature: EditorMergeConflictFeature = {
    getConflicts: () => controller.getConflicts(),
    resolveConflict: (index, resolution) => controller.resolveConflict(index, resolution),
    revealConflict: (index) => controller.revealConflict(index),
  }
  const registration = context.registerFeature(EDITOR_MERGE_CONFLICT_FEATURE, feature)

  return {
    handleEditorChange: (change) => controller.handleEditorChange(change),
    dispose() {
      registration.dispose()
      controller.dispose()
    },
  }
}

function featureHost(context: EditorFeatureContributionContext): MergeConflictHost {
  return {
    hasDocument: () => context.hasDocument(),
    materializeFullText: () => context.materializeFullText(),
    focusEditor: () => context.focusEditor(),
    setSelection: (anchor, head, timingName, options) =>
      context.setSelection(anchor, head, timingName, options),
    applyEdits: (edits, timingName, selection) => context.applyEdits(edits, timingName, selection),
    setRangeHighlight: (name, ranges, style) => context.setRangeHighlight(name, ranges, style),
    clearRangeHighlight: (name) => context.clearRangeHighlight(name),
  }
}

function visibleRowForOffset(
  snapshot: EditorViewSnapshot,
  offset: number,
): EditorViewSnapshot['visibleRows'][number] | null {
  for (const row of snapshot.visibleRows) {
    if (offset < row.startOffset) continue
    if (offset <= row.endOffset + 1) return row
  }

  return snapshot.visibleRows[0] ?? null
}

function conflictSignature(conflicts: readonly MergeConflictRegion[]): string {
  return conflicts
    .map((conflict) =>
      [
        conflict.range.start,
        conflict.range.end,
        conflict.ours.start,
        conflict.ours.end,
        conflict.base?.start ?? '',
        conflict.base?.end ?? '',
        conflict.theirs.start,
        conflict.theirs.end,
        conflict.oursLabel,
        conflict.baseLabel ?? '',
        conflict.theirsLabel,
      ].join(':'),
    )
    .join('|')
}

function isMergeConflictNeutralInsertion(edit: TextEdit): boolean {
  if (edit.from !== edit.to) return false
  return !MERGE_CONFLICT_MARKER_CHAR_PATTERN.test(edit.text)
}

function snapshotMayContainMergeConflict(snapshot: EditorViewSnapshot): boolean {
  return snapshot.visibleRows.some((row) => lineStartsWithMergeConflictMarker(row.text))
}

function lineStartsWithMergeConflictMarker(text: string): boolean {
  if (text.startsWith('<<<<<<<')) return true
  if (text.startsWith('|||||||')) return true
  if (text.startsWith('=======')) return true
  return text.startsWith('>>>>>>>')
}

function shortConflictSideLabel(label: string, fallback: string): string {
  const separatorIndex = label.indexOf(':')
  const candidate = separatorIndex > 0 ? label.slice(0, separatorIndex).trim() : label.trim()
  if (!candidate) return fallback
  if (candidate.length > 14) return fallback

  return candidate
}

function createActionIcon(document: Document, icon: MergeConflictActionIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', `editor-merge-conflict-action-icon icon-${icon}`)
  svg.setAttribute('viewBox', '0 0 16 16')
  for (const pathData of actionIconPaths(icon)) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', pathData)
    svg.appendChild(path)
  }

  return svg
}

function actionIconPaths(icon: MergeConflictActionIcon): readonly string[] {
  if (icon === 'ours') return ['M3.5 8.2 6.5 11 12.5 4.8']
  if (icon === 'theirs') return ['M9 3.5 13.5 8 9 12.5', 'M2.5 8h10.5']
  if (icon === 'base') return ['M8 2.5a5.5 5.5 0 1 0 5.5 5.5', 'M8 5v3l2 1.5']

  return ['M4 3.5v9', 'M12 3.5v9', 'M5.5 8h5']
}

function addResolveButtonListeners(button: HTMLButtonElement, resolve: () => boolean): void {
  let handledPointerDown = false

  button.addEventListener('pointerdown', (event) => {
    handledPointerDown = true
    consumeResolveEvent(event)
    resolve()
  })
  button.addEventListener('click', (event) => {
    consumeResolveEvent(event)
    if (handledPointerDown) {
      handledPointerDown = false
      return
    }

    resolve()
  })
}

function consumeResolveEvent(event: Event): void {
  event.preventDefault()
  event.stopPropagation()
}
