import type {
  EditorDecorationContribution,
  EditorDecorationContributionContext,
  EditorDisposable,
  EditorGutterRowContext,
  EditorInjectedTextRow,
  EditorPlugin,
  EditorPluginContext,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import type { DocumentSessionChange } from '@singapor/core/document'
import type { EditorToken } from '@singapor/core/syntax'
import { createDiffGutterContribution } from './diffGutter'
import {
  diffInlineHighlightRanges,
  diffRowDecorations,
  documentModeViolations,
  type DiffDocumentModeViolation,
} from './diffRows'
import { DiffSyntaxController } from './diffSyntax'
import type { DiffGutterLayout, DiffGutterSide } from './gutters'
import { createLiveDiffProjection, type LiveDiffProjection } from './liveProjection'
import { createTextDiff } from './model'
import { createSplitProjection, createStackedProjection } from './projection'
import type { DiffFile, DiffRenderRow, DiffSyntaxBackend, DiffTextFile } from './types'

export type DiffPluginMode = 'document' | 'overlay'

export type DiffPluginOptions = {
  /** §C1. `document` is the parity path; `overlay` is explicitly non-parity — see §C2. */
  readonly mode?: DiffPluginMode
  readonly side?: DiffGutterSide
  readonly syntaxBackend?: DiffSyntaxBackend
  readonly syntaxHighlight?: boolean
}

export type DiffPlugin = EditorPlugin & {
  /** `document` mode: the file to project. The host owns the editor's text — §C3. */
  setFile(file: DiffFile | null): void
  getRows(): readonly DiffRenderRow[]
  /**
   * Projected syntax tokens for the current rows. `Editor.setText` clears tokens
   * (Editor.ts:648), so the host applies these immediately after every `setText` or an expansion
   * toggle repaints uncoloured — §C10.
   */
  getTokens(): readonly EditorToken[]
  onDidChangeRows(listener: () => void): EditorDisposable
  onDidChangeTokens(listener: () => void): EditorDisposable
  /** §C5. Hosts must not mirror this. */
  getExpandedRegions(): ReadonlySet<string>
  toggleRegion(key: string): void
  /** Empty unless the row-index identity §C4 depends on has been broken. */
  getDocumentModeViolations(): readonly DiffDocumentModeViolation[]

  /** `overlay` mode: the buffer the live editor text is diffed against. */
  setBaseFile(file: DiffTextFile | null): void
  setEnabled(enabled: boolean): void
}

const EMPTY_PROJECTION: LiveDiffProjection = {
  injectedRows: [],
  rowDecorations: new Map(),
  rows: [],
  rowsByBufferRow: new Map(),
}
const ROW_DECORATION_SOURCE = 'editor.diff'
const INLINE_HIGHLIGHT_STYLE = { backgroundColor: 'rgba(255, 255, 255, 0.18)' } as const

let nextDiffPluginId = 0

/**
 * The one diff plugin (§C1), carrying two internal row-delivery modes.
 *
 * `document` — the editor holds a synthetic buffer of the projected rows and the plugin publishes
 * them for the host to push in. Everything works because the rows are real document lines.
 *
 * `overlay` — the editor holds the host's live, editable buffer and deletions arrive as injected
 * rows. Non-parity by construction; see §C2 and test/overlayModeLimits.test.ts before reaching for
 * it.
 */
export function createDiffPlugin(options: DiffPluginOptions = {}): DiffPlugin {
  const runtime = new DiffPluginRuntime(options)

  return {
    name: `editor-diff-${options.mode ?? 'document'}`,
    activate(context) {
      return runtime.activate(context)
    },
    setFile: (file) => runtime.setFile(file),
    getRows: () => runtime.getRows(),
    getTokens: () => runtime.getTokens(),
    onDidChangeRows: (listener) => runtime.onDidChangeRows(listener),
    onDidChangeTokens: (listener) => runtime.onDidChangeTokens(listener),
    getExpandedRegions: () => runtime.getExpandedRegions(),
    toggleRegion: (key) => runtime.toggleRegion(key),
    getDocumentModeViolations: () => runtime.getDocumentModeViolations(),
    setBaseFile: (file) => runtime.setBaseFile(file),
    setEnabled: (enabled) => runtime.setEnabled(enabled),
  }
}

class DiffPluginRuntime {
  private readonly id = nextDiffPluginId++
  private readonly mode: DiffPluginMode
  private readonly side: DiffGutterSide
  private syntax: DiffSyntaxController
  private readonly rowListeners = new Set<() => void>()
  private readonly tokenListeners = new Set<() => void>()

  private file: DiffFile | null = null
  private rows: readonly DiffRenderRow[] = []
  private expandedRegions = new Set<string>()
  private violations: readonly DiffDocumentModeViolation[] = []

  private baseFile: DiffTextFile | null = null
  private enabled: boolean
  private liveProjection: LiveDiffProjection = EMPTY_PROJECTION

  private decoration: DiffDecorationContribution | null = null
  private view: DiffViewContribution | null = null
  private injectedRowsListener: (() => void) | null = null
  private lastGutterLayout: DiffGutterLayout | null = null

  constructor(private readonly options: DiffPluginOptions) {
    this.mode = options.mode ?? 'document'
    this.side = options.side ?? 'stacked'
    // Overlay mode is switched on by the host once it has a base file; document mode is live from
    // the moment it has one.
    this.enabled = this.mode === 'document'
    this.syntax = this.createSyntaxController()
  }

  activate(context: EditorPluginContext): EditorDisposable[] {
    // A controller disposed by a previous deactivation is dead for good — its scheduler is
    // terminal, so `schedule()` returns an inactive handle forever and the diff would render
    // permanently uncoloured after a remove-then-re-add. The core supports that cycle
    // (`Editor.setPlugins`), so the controller's lifetime is the activation's, not the plugin's.
    //
    // Only a *replacement* controller needs the file pushed into it. Doing it unconditionally
    // re-parses a file the surviving controller is already holding — and when the host sets the
    // file before constructing the editor, which is the natural order, that means cancelling an
    // in-flight parse to start an identical one. Under shiki that is two worker owners for one
    // file.
    if (this.syntax.isDisposed()) {
      this.syntax = this.createSyntaxController()
      if (this.file) this.syntax.setFile(this.file, this.rows)
    }

    const disposables: EditorDisposable[] = [
      context.registerGutterContribution(
        createDiffGutterContribution({
          side: this.side,
          getRows: () => this.gutterRows(),
          resolveRow: (row) => this.resolveGutterRow(row),
          isEnabled: () => this.enabled,
          onLayout: (layout) => this.publishGutterLayout(layout),
        }),
      ),
      context.registerDecorationContribution({
        createContribution: (featureContext) => this.createDecorationContribution(featureContext),
      }),
      context.registerViewContribution({
        createContribution: (viewContext) => this.createViewContribution(viewContext),
      }),
      { dispose: () => this.syntax.dispose() },
    ]

    if (this.mode === 'overlay') {
      disposables.push(
        context.registerInjectedTextRowProvider({
          getInjectedTextRows: () => this.injectedRows(),
          onDidChangeInjectedTextRows: (listener) => this.setInjectedRowsListener(listener),
        }),
      )
    }

    return disposables
  }

  // ---------------------------------------------------------------- document mode (§C3, §C5)

  setFile(file: DiffFile | null): void {
    if (this.mode !== 'document') return

    // Expansion state is keyed by region identity, not ordinal (§C5), but it still belongs to one
    // file — carrying it onto a different path would expand unrelated regions.
    if (file?.path !== this.file?.path) this.expandedRegions = new Set()
    this.file = file
    this.rebuildRows()
    this.syntax.setFile(file, this.rows)
    this.notifyRows()
  }

  getRows(): readonly DiffRenderRow[] {
    if (this.mode === 'overlay') return this.liveProjection.rows
    return this.rows
  }

  getTokens(): readonly EditorToken[] {
    return this.syntax.getTokens()
  }

  getExpandedRegions(): ReadonlySet<string> {
    return this.expandedRegions
  }

  toggleRegion(key: string): void {
    if (this.mode !== 'document') return
    if (!this.file) return

    if (!this.expandedRegions.delete(key)) this.expandedRegions.add(key)
    this.rebuildRows()
    // Same file, different rows: the parsed token streams still apply, so this re-projects
    // synchronously and `getTokens()` is correct before the host's `setText` returns (§C10).
    this.syntax.setRows(this.rows)
    this.notifyRows()
  }

  getDocumentModeViolations(): readonly DiffDocumentModeViolation[] {
    return this.violations
  }

  onDidChangeRows(listener: () => void): EditorDisposable {
    this.rowListeners.add(listener)
    return { dispose: () => this.rowListeners.delete(listener) }
  }

  onDidChangeTokens(listener: () => void): EditorDisposable {
    this.tokenListeners.add(listener)
    return { dispose: () => this.tokenListeners.delete(listener) }
  }

  private rebuildRows(): void {
    this.rows = projectRows(this.file, this.side, this.expandedRegions)
  }

  private notifyRows(): void {
    for (const listener of this.rowListeners) listener()
    this.decoration?.refresh()
    this.view?.refreshRows()
  }

  private notifyTokens(): void {
    for (const listener of this.tokenListeners) listener()
  }

  // ---------------------------------------------------------------- overlay mode

  setBaseFile(file: DiffTextFile | null): void {
    if (this.mode !== 'overlay') return

    this.baseFile = file
    this.decoration?.refresh()
  }

  setEnabled(enabled: boolean): void {
    if (this.mode !== 'overlay') return

    this.enabled = enabled
    this.decoration?.refresh()
  }

  private injectedRows(): readonly EditorInjectedTextRow[] {
    if (!this.enabled) return []
    return this.liveProjection.injectedRows
  }

  private setInjectedRowsListener(listener: () => void): EditorDisposable {
    this.injectedRowsListener = listener
    return {
      dispose: () => {
        if (this.injectedRowsListener === listener) this.injectedRowsListener = null
      },
    }
  }

  private gutterRows(): readonly DiffRenderRow[] {
    if (this.mode === 'overlay') return this.liveProjection.rows
    return this.rows
  }

  /**
   * Which diff row a rendered gutter row is showing. The two modes cannot share an answer.
   *
   * `document` — §C4 holds, so the projection index is the buffer row and a positional lookup is
   * correct.
   *
   * `overlay` — the projection array interleaves injected deletion rows, so position and buffer
   * row diverge from the first deletion onwards; the mapping the projection publishes for exactly
   * this purpose is `rowsByBufferRow`, keyed `newLineNumber - 1`. An injected row is not in that
   * map at all and carries its own row as metadata instead.
   */
  private resolveGutterRow(row: EditorGutterRowContext): DiffRenderRow | null {
    if (this.mode === 'overlay') {
      if (row.source === 'injected') return injectedDiffRow(row)
      if (row.source !== 'document') return null
      return this.liveProjection.rowsByBufferRow.get(row.bufferRow) ?? null
    }

    if (row.source !== 'document') return null
    return this.rows[row.bufferRow] ?? null
  }

  // ---------------------------------------------------------------- contributions

  private createDecorationContribution(
    context: EditorDecorationContributionContext,
  ): EditorDecorationContribution {
    const contribution = new DiffDecorationContribution(context, {
      mode: this.mode,
      getRows: () => this.rows,
      buildLiveProjection: () => this.buildLiveProjection(context),
      setLiveProjection: (projection) => {
        this.liveProjection = projection
      },
      notifyInjectedRowsChanged: () => this.injectedRowsListener?.(),
    })
    this.decoration = contribution
    contribution.refresh()
    return {
      handleEditorChange: (change) => contribution.handleEditorChange(change),
      dispose: () => {
        if (this.decoration === contribution) this.decoration = null
        contribution.dispose()
      },
    }
  }

  private buildLiveProjection(context: EditorDecorationContributionContext): LiveDiffProjection {
    if (!this.enabled) return EMPTY_PROJECTION
    if (!this.baseFile) return EMPTY_PROJECTION
    if (!context.hasDocument()) return EMPTY_PROJECTION

    const file = createTextDiff({
      oldFile: this.baseFile,
      newFile: {
        path: this.baseFile.path,
        text: context.materializeFullText(),
        languageId: this.baseFile.languageId,
      },
    })
    return createLiveDiffProjection(file)
  }

  private createViewContribution(
    context: EditorViewContributionContext,
  ): EditorViewContribution | null {
    const contribution = new DiffViewContribution(context, {
      highlightName: `editor-diff-${this.id}-${this.side}-inline`,
      mode: this.mode,
      side: this.side,
      getRows: () => this.getRows(),
      toggleRegion: (key) => this.toggleRegion(key),
      reportViolations: (violations) => {
        this.violations = violations
      },
      detach: (disposed) => {
        if (this.view === disposed) this.view = null
      },
    })
    this.view = contribution
    if (this.lastGutterLayout) contribution.applyGutterLayout(this.lastGutterLayout)
    return contribution
  }

  private publishGutterLayout(layout: DiffGutterLayout): void {
    // Retained, never consumed. `width()` can run before a view contribution exists, and a
    // contribution can be torn down and rebuilt later on a fresh scroll element carrying none of
    // these custom properties. The gutter memoizes on the layout, so it will not republish an
    // unchanged one — leaving a replacement contribution with no other way to learn the geometry,
    // and `.editor-diff-gutter` falling back to `1fr 1fr 12px`, which is the drift the whole
    // custom-property dance exists to avoid.
    this.lastGutterLayout = layout
    this.view?.applyGutterLayout(layout)
  }

  private createSyntaxController(): DiffSyntaxController {
    return new DiffSyntaxController({
      side: this.side,
      backend: this.options.syntaxBackend,
      enabled: this.options.syntaxHighlight !== false,
      onDidChangeTokens: () => this.notifyTokens(),
    })
  }
}

function projectRows(
  file: DiffFile | null,
  side: DiffGutterSide,
  expandedRegions: ReadonlySet<string>,
): readonly DiffRenderRow[] {
  if (!file) return []
  if (side === 'stacked') return createStackedProjection(file, { expandedRegions }).rows

  const projection = createSplitProjection(file, { expandedRegions })
  return side === 'old' ? projection.leftRows : projection.rightRows
}

type DiffDecorationOptions = {
  readonly mode: DiffPluginMode
  readonly getRows: () => readonly DiffRenderRow[]
  readonly buildLiveProjection: () => LiveDiffProjection
  readonly setLiveProjection: (projection: LiveDiffProjection) => void
  readonly notifyInjectedRowsChanged: () => void
}

class DiffDecorationContribution {
  private lastTextSnapshot: unknown = undefined

  constructor(
    private readonly context: EditorDecorationContributionContext,
    private readonly options: DiffDecorationOptions,
  ) {}

  /**
   * The editor's notification, which is not the same thing as "the text changed".
   *
   * Rebuilding an overlay projection materializes the whole document and runs `structuredPatch`
   * over it, synchronously. `handleEditorChange` also fires for selection-only changes —
   * `DocumentSessionChange.kind` is one of edit/selection/undo/redo/none — and a caret move cannot
   * alter the diff, so paying for one is pure waste on the typing path. Text-snapshot identity is
   * the second guard, for the notification paths that carry no change object at all.
   *
   * Plugin-state changes (`setBaseFile`, `setEnabled`) call `refresh()` directly and are never
   * skipped: the text is the same but the diff it produces is not.
   */
  handleEditorChange(change: DocumentSessionChange | null): void {
    if (this.options.mode === 'overlay') {
      if (change?.kind === 'selection') return

      const snapshot = this.context.getTextSnapshot?.() ?? null
      if (snapshot !== null && snapshot === this.lastTextSnapshot) return
    }

    this.refresh()
  }

  refresh(): void {
    this.lastTextSnapshot = this.context.getTextSnapshot?.() ?? null
    if (this.options.mode === 'document') {
      this.context.setRowDecorations(
        ROW_DECORATION_SOURCE,
        diffRowDecorations(this.options.getRows()),
      )
      return
    }

    this.applyLiveProjection(this.options.buildLiveProjection())
  }

  dispose(): void {
    if (this.options.mode === 'overlay') this.applyLiveProjection(EMPTY_PROJECTION)
    this.context.clearRowDecorations(ROW_DECORATION_SOURCE)
  }

  /**
   * These three steps are ordered, and the order is load-bearing.
   *
   * Announcing the injected-row change first would rebuild the row set before the cells are
   * repainted, and a row that the rebuild unmounts keeps whatever its cell last rendered — a
   * disabled live diff would leave a stale `4+` behind on a detached cell. Repainting first, while
   * that row is still mounted, is what clears it.
   *
   * The stored projection has to be current before the repaint, because the gutter reads its rows
   * from it.
   */
  private applyLiveProjection(projection: LiveDiffProjection): void {
    this.options.setLiveProjection(projection)
    this.context.setRowDecorations(ROW_DECORATION_SOURCE, projection.rowDecorations)
    this.options.notifyInjectedRowsChanged()
  }
}

type DiffViewOptions = {
  readonly highlightName: string
  readonly mode: DiffPluginMode
  readonly side: DiffGutterSide
  readonly getRows: () => readonly DiffRenderRow[]
  readonly toggleRegion: (key: string) => void
  readonly reportViolations: (violations: readonly DiffDocumentModeViolation[]) => void
  readonly detach: (contribution: DiffViewContribution) => void
}

/**
 * Pointer handling and inline word-diff highlights.
 *
 * The pointer half is not optional decoration — see §3.4. A click in the gutter band cannot be
 * resolved with `closest('[data-editor-virtual-row]')`: `.editor-virtualized-gutter` is
 * `pointer-events: none` (editor/style.css:132) so the click lands on the scroll element, gutter
 * rows carry `data-editor-virtual-gutter-row` rather than the text row's attribute
 * (virtualizedTextViewRows.ts:1845 vs :580), and text rows start at `left: var(--editor-gutter-width)`
 * so none of them sits under the band. Expanding a region by clicking its gutter — the half of an
 * expandable separator users actually aim at — needs the Y hit-test, and so does the pointer cursor.
 */
class DiffViewContribution implements EditorViewContribution {
  private snapshot: EditorViewSnapshot | null = null
  private lastHighlightRows: readonly DiffRenderRow[] | null = null

  constructor(
    private readonly context: EditorViewContributionContext,
    private readonly options: DiffViewOptions,
  ) {
    this.context.scrollElement.dataset.editorDiffSide = options.side
    // Registration order puts this ahead of the editor's own mousedown handler
    // (Editor.ts:580 creates view contributions, :633 installs input handling), which is what lets
    // a gutter-toggle click suppress caret placement. `stopImmediatePropagation` in the handler is
    // what makes that ordering actually decisive.
    this.context.scrollElement.addEventListener('mousedown', this.handleMouseDown)
    this.context.scrollElement.addEventListener('click', this.handleClick)
    this.context.scrollElement.addEventListener('mousemove', this.handleMouseMove)
    this.context.scrollElement.addEventListener('mouseleave', this.handleMouseLeave)
  }

  update(snapshot: EditorViewSnapshot): void {
    this.snapshot = snapshot
    if (this.options.mode !== 'document') return

    this.options.reportViolations(documentModeViolations(snapshot, this.options.getRows()))
    this.applyInlineHighlights()
  }

  refreshRows(): void {
    this.lastHighlightRows = null
    this.applyInlineHighlights()
  }

  applyGutterLayout(layout: DiffGutterLayout): void {
    // §3.3 trap 1: the canvas derived lane geometry arithmetically, so a DOM gutter has to hand CSS
    // the same numbers rather than approximate them with `1fr 1fr 12px`.
    const style = this.context.scrollElement.style
    const columns = layout.lanes.map((lane) => `${lane.width}px`).join(' ')
    style.setProperty('--editor-diff-gutter-columns', columns)
    style.setProperty('--editor-diff-gutter-total-width', `${layout.width}px`)
  }

  dispose(): void {
    this.context.scrollElement.removeEventListener('mousedown', this.handleMouseDown)
    this.context.scrollElement.removeEventListener('click', this.handleClick)
    this.context.scrollElement.removeEventListener('mousemove', this.handleMouseMove)
    this.context.scrollElement.removeEventListener('mouseleave', this.handleMouseLeave)
    this.context.scrollElement.style.cursor = ''
    this.context.clearRangeHighlight?.(this.options.highlightName)
    // Or the runtime keeps writing highlights and gutter geometry through a torn-down context,
    // and holds its scroll element alive for the plugin's lifetime.
    this.options.detach(this)
  }

  private applyInlineHighlights(): void {
    const rows = this.options.getRows()
    if (rows === this.lastHighlightRows) return

    this.lastHighlightRows = rows
    this.context.setRangeHighlight?.(
      this.options.highlightName,
      diffInlineHighlightRanges(rows),
      INLINE_HIGHLIGHT_STYLE,
    )
  }

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return
    if (event.detail !== 1) return
    if (!this.expandableRowAt(event)) return

    // Beats the editor's own mousedown, which would otherwise place a caret on the separator.
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  private readonly handleClick = (event: MouseEvent): void => {
    if (event.button !== 0) return

    const row = this.expandableRowAt(event)
    if (!row?.expandKey) return

    event.preventDefault()
    event.stopImmediatePropagation()
    this.options.toggleRegion(row.expandKey)
  }

  private readonly handleMouseMove = (event: MouseEvent): void => {
    const cursor = this.expandableRowAt(event) ? 'pointer' : ''
    if (this.context.scrollElement.style.cursor === cursor) return

    this.context.scrollElement.style.cursor = cursor
  }

  private readonly handleMouseLeave = (): void => {
    if (!this.context.scrollElement.style.cursor) return

    this.context.scrollElement.style.cursor = ''
  }

  private expandableRowAt(event: MouseEvent): DiffRenderRow | null {
    if (this.options.mode !== 'document') return null

    const index = this.rowIndexAt(event)
    if (index === null) return null

    const row = this.options.getRows()[index]
    if (row?.type !== 'hunk') return null
    return row.expandable ? row : null
  }

  private rowIndexAt(event: MouseEvent): number | null {
    const target = event.target
    if (target instanceof Element) {
      const rowElement = target.closest<HTMLElement>('[data-editor-virtual-row]')
      if (rowElement) return Number(rowElement.dataset.editorVirtualRow)
    }

    return this.rowIndexFromPoint(event.clientY)
  }

  /** Ported from `DiffView.paneRowIndexFromPoint` (DiffView.ts:849-862) — see the class comment. */
  private rowIndexFromPoint(clientY: number): number | null {
    const snapshot = this.snapshot
    if (!snapshot) return null

    const bounds = this.context.scrollElement.getBoundingClientRect()
    if (clientY < bounds.top || clientY > bounds.bottom) return null

    const y = clientY - bounds.top + snapshot.viewport.scrollTop
    for (const row of snapshot.visibleRows) {
      if (row.source !== 'document') continue
      if (row.startOffset !== snapshot.lineStarts[row.bufferRow]) continue
      if (y < row.top || y >= row.top + row.height) continue
      return row.bufferRow
    }

    return null
  }
}

function injectedDiffRow(row: EditorGutterRowContext): DiffRenderRow | null {
  const metadata = row.metadata
  if (!metadata || typeof metadata !== 'object') return null
  return 'type' in metadata && 'text' in metadata ? (metadata as DiffRenderRow) : null
}
