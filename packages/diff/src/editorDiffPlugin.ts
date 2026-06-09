import type {
  EditorDecorationContribution,
  EditorDecorationContributionContext,
  EditorDisposable,
  EditorGutterContribution,
  EditorGutterRowContext,
  EditorInjectedTextRow,
  EditorPlugin,
} from '@singapor/core/extensions'
import { createLiveDiffProjection, type LiveDiffProjection } from './liveProjection'
import { createTextDiff } from './model'
import {
  diffGutterIndicatorText,
  diffGutterNumberText,
  diffGutterWidth,
  type DiffGutterNumberSide,
} from './gutters'
import type { DiffRenderRow, DiffTextFile } from './types'

export type EditorDiffPlugin = EditorPlugin & {
  setBaseFile(file: DiffTextFile | null): void
  setEnabled(enabled: boolean): void
}

type EditorDiffPluginState = {
  baseFile: DiffTextFile | null
  enabled: boolean
  projection: LiveDiffProjection
}

const EMPTY_PROJECTION: LiveDiffProjection = {
  injectedRows: [],
  rowDecorations: new Map(),
  rows: [],
  rowsByBufferRow: new Map(),
}
const ROW_DECORATION_SOURCE = 'editor.diff'

export function createEditorDiffPlugin(): EditorDiffPlugin {
  const state: EditorDiffPluginState = {
    baseFile: null,
    enabled: false,
    projection: EMPTY_PROJECTION,
  }
  const runtime = new EditorDiffPluginRuntime(state)

  return {
    name: 'editor-diff',
    activate(context) {
      return runtime.activate(context)
    },
    setBaseFile(file) {
      state.baseFile = file
      runtime.refresh()
    },
    setEnabled(enabled) {
      state.enabled = enabled
      runtime.refresh()
    },
  }
}

class EditorDiffPluginRuntime {
  private feature: EditorDiffFeatureContribution | null = null
  private injectedTextRowsListener: (() => void) | null = null

  constructor(private readonly state: EditorDiffPluginState) {}

  activate(context: Parameters<EditorPlugin['activate']>[0]): EditorDisposable[] {
    return [
      context.registerInjectedTextRowProvider({
        getInjectedTextRows: () => this.injectedRows(),
        onDidChangeInjectedTextRows: (listener) => this.setInjectedTextRowsListener(listener),
      }),
      context.registerGutterContribution(createEditorDiffGutterContribution(this.state)),
      context.registerDecorationContribution({
        createContribution: (featureContext) => this.createFeatureContribution(featureContext),
      }),
    ]
  }

  refresh(): void {
    this.feature?.refresh()
  }

  notifyInjectedTextRowsChanged(): void {
    this.injectedTextRowsListener?.()
  }

  private injectedRows(): readonly EditorInjectedTextRow[] {
    if (!this.state.enabled) return []
    return this.state.projection.injectedRows
  }

  private setInjectedTextRowsListener(listener: () => void): EditorDisposable {
    this.injectedTextRowsListener = listener
    return {
      dispose: () => {
        if (this.injectedTextRowsListener === listener) this.injectedTextRowsListener = null
      },
    }
  }

  private createFeatureContribution(
    context: EditorDecorationContributionContext,
  ): EditorDecorationContribution {
    const contribution = new EditorDiffFeatureContribution(context, this.state, () =>
      this.notifyInjectedTextRowsChanged(),
    )
    this.feature = contribution
    contribution.refresh()
    return {
      handleEditorChange: () => contribution.refresh(),
      dispose: () => {
        if (this.feature === contribution) this.feature = null
        contribution.dispose()
      },
    }
  }
}

class EditorDiffFeatureContribution {
  constructor(
    private readonly context: EditorDecorationContributionContext,
    private readonly state: EditorDiffPluginState,
    private readonly notifyInjectedTextRowsChanged: () => void,
  ) {}

  refresh(): void {
    this.state.projection = this.createProjection()
    if (this.projectionIsEmpty()) {
      this.context.setRowDecorations(ROW_DECORATION_SOURCE, this.state.projection.rowDecorations)
      this.notifyInjectedTextRowsChanged()
      return
    }

    this.notifyInjectedTextRowsChanged()
    this.context.setRowDecorations(ROW_DECORATION_SOURCE, this.state.projection.rowDecorations)
  }

  dispose(): void {
    this.state.projection = EMPTY_PROJECTION
    this.context.clearRowDecorations(ROW_DECORATION_SOURCE)
    this.notifyInjectedTextRowsChanged()
  }

  private createProjection(): LiveDiffProjection {
    if (!this.state.enabled) return EMPTY_PROJECTION
    if (!this.state.baseFile) return EMPTY_PROJECTION
    if (!this.context.hasDocument()) return EMPTY_PROJECTION

    const file = createTextDiff({
      oldFile: this.state.baseFile,
      newFile: {
        path: this.state.baseFile.path,
        text: this.context.materializeFullText(),
        languageId: this.state.baseFile.languageId,
      },
    })
    return createLiveDiffProjection(file)
  }

  private projectionIsEmpty(): boolean {
    if (this.state.projection.injectedRows.length > 0) return false
    return this.state.projection.rowDecorations.size === 0
  }
}

function createEditorDiffGutterContribution(
  state: EditorDiffPluginState,
): EditorGutterContribution {
  return {
    id: 'editor-diff-gutter',
    className: 'editor-live-diff-gutter-cell',
    createCell(document) {
      return createEditorDiffGutterCell(document)
    },
    width(context) {
      if (!state.enabled) return 0
      return diffGutterWidth(
        'stacked',
        state.projection.rows,
        context.lineCount,
        context.metrics.characterWidth,
      )
    },
    updateCell(element, row) {
      updateEditorDiffGutterCell(element, row, state)
    },
  }
}

function createEditorDiffGutterCell(document: Document): HTMLElement {
  const element = document.createElement('span')
  element.className = 'editor-live-diff-gutter'
  element.setAttribute('aria-hidden', 'true')
  for (const lane of ['old', 'new', 'indicator'] as const) {
    const laneElement = document.createElement('span')
    laneElement.className = `editor-live-diff-gutter-lane editor-live-diff-gutter-${lane}`
    element.appendChild(laneElement)
  }
  return element
}

function updateEditorDiffGutterCell(
  element: HTMLElement,
  row: EditorGutterRowContext,
  state: EditorDiffPluginState,
): void {
  const metadata = liveDiffRowForGutterRow(row, state)
  element.hidden = !metadata
  if (!metadata) {
    setGutterLaneText(element, 'old', '')
    setGutterLaneText(element, 'new', '')
    setGutterLaneText(element, 'indicator', '')
    delete element.dataset.diffRowType
    return
  }

  setGutterLaneText(element, 'old', diffGutterNumberText(metadata, 'old'))
  setGutterLaneText(element, 'new', diffGutterNumberText(metadata, 'new'))
  setGutterLaneText(element, 'indicator', diffGutterIndicatorText(metadata))
  element.dataset.diffRowType = metadata.type
}

function liveDiffRowForGutterRow(
  row: EditorGutterRowContext,
  state: EditorDiffPluginState,
): DiffRenderRow | null {
  if (!state.enabled) return null
  if (row.source === 'injected') return injectedDiffRow(row.metadata)
  if (row.source !== 'document') return null
  return state.projection.rowsByBufferRow.get(row.bufferRow) ?? null
}

function injectedDiffRow(metadata: unknown): DiffRenderRow | null {
  if (!isDiffRenderRow(metadata)) return null
  return metadata
}

function isDiffRenderRow(value: unknown): value is DiffRenderRow {
  if (!value || typeof value !== 'object') return false
  return 'type' in value && 'text' in value
}

function setGutterLaneText(
  element: HTMLElement,
  lane: DiffGutterNumberSide | 'indicator',
  text: string,
): void {
  const laneElement = element.querySelector<HTMLElement>(`.editor-live-diff-gutter-${lane}`)
  if (!laneElement) return
  if (laneElement.textContent === text) return
  laneElement.textContent = text
}
