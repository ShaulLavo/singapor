import {
  EDITOR_MINIMAP_FEATURE,
  type EditorMinimapDecoration,
  type EditorMinimapFeature,
  type EditorViewContributionContext,
} from '@singapor/core/extensions'
import { lspPositionToOffset } from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

import {
  diagnosticHighlightGroups,
  summarizeDiagnostics,
  type LanguageServerDiagnosticSeverity,
} from './diagnostics'
import { DIAGNOSTIC_MARKER_COLORS, DIAGNOSTIC_STYLES } from './plugin.styles'
import type { OffsetRange } from './definitionNavigation'
import type { LanguageServerDiagnosticSummary } from './types'

const LSP_DIAGNOSTIC_ERROR = 1
const LSP_DIAGNOSTIC_WARNING = 2
const LSP_DIAGNOSTIC_INFORMATION = 3
const LSP_DIAGNOSTIC_HINT = 4

const DIAGNOSTIC_SEVERITIES: readonly LanguageServerDiagnosticSeverity[] = [
  'error',
  'warning',
  'information',
  'hint',
]

const DIAGNOSTIC_MINIMAP_Z_INDEX: Record<LanguageServerDiagnosticSeverity, number> = {
  error: 40,
  warning: 30,
  information: 20,
  hint: 10,
}

export type DiagnosticsPresenterActiveDocument = {
  readonly fullText: string
}

export type DiagnosticsPresenterMarkerDirection = 'next' | 'previous'

export type DiagnosticsPresenterOptions = {
  readonly minimapSourceId: string
  readonly highlightNameNamespace: string
  readonly markerTimingNamePrefix: string
  readonly onDiagnostics?: (summary: ReturnType<typeof summarizeDiagnostics>) => void
}

export class DiagnosticsPresenter {
  private readonly highlightNames: Record<LanguageServerDiagnosticSeverity, string>

  public constructor(
    private readonly context: EditorViewContributionContext,
    prefix: string,
    private readonly options: DiagnosticsPresenterOptions,
  ) {
    this.highlightNames = createHighlightNames(prefix, options.highlightNameNamespace)
  }

  public render(text: string, diagnostics: readonly lsp.Diagnostic[]): void {
    this.renderHighlights(text, diagnostics)
    this.renderMinimapMarkers(diagnostics)
  }

  public clear(): void {
    this.clearMinimapMarkers()
    if (!this.context.clearRangeHighlight) return

    for (const name of Object.values(this.highlightNames)) this.context.clearRangeHighlight(name)
  }

  public publishSummary(
    uri: lsp.DocumentUri,
    version: number | null,
    diagnostics: readonly lsp.Diagnostic[],
  ): void {
    this.options.onDiagnostics?.(summarizeDiagnostics(uri, version, diagnostics))
  }

  public moveMarker(
    active: DiagnosticsPresenterActiveDocument | null,
    diagnostics: readonly lsp.Diagnostic[],
    direction: DiagnosticsPresenterMarkerDirection,
  ): boolean {
    if (!active) return false

    const selection = this.context.getSnapshot().selections[0]
    if (!selection) return false

    const range = diagnosticMarkerTarget(
      active.fullText,
      diagnostics,
      selection.headOffset,
      direction,
    )
    if (!range) return false

    const timingName = `${this.options.markerTimingNamePrefix}.${direction}`
    this.context.setSelection(range.start, range.end, timingName, range.start)
    this.context.focusEditor()
    return true
  }

  private renderHighlights(text: string, diagnostics: readonly lsp.Diagnostic[]): void {
    if (!this.context.setRangeHighlight) return

    const groups = diagnosticHighlightGroups(text, diagnostics)
    for (const severity of DIAGNOSTIC_SEVERITIES) {
      this.context.setRangeHighlight(
        this.highlightNames[severity],
        groups[severity],
        DIAGNOSTIC_STYLES[severity],
      )
    }
  }

  private renderMinimapMarkers(diagnostics: readonly lsp.Diagnostic[]): void {
    const minimap = this.minimapFeature()
    if (!minimap) return

    minimap.setDecorations(
      this.options.minimapSourceId,
      diagnosticMinimapDecorations(this.context.getSnapshot().lineCount, diagnostics),
    )
  }

  private clearMinimapMarkers(): void {
    this.minimapFeature()?.clearDecorations(this.options.minimapSourceId)
  }

  private minimapFeature(): EditorMinimapFeature | null {
    return this.context.getFeature?.(EDITOR_MINIMAP_FEATURE) ?? null
  }
}

type DiagnosticBatch = {
  readonly diagnostics: readonly lsp.Diagnostic[]
  readonly text: string
  readonly uri: lsp.DocumentUri | null
  readonly version: number | null
}

export type CompositeDiagnosticsLanePresenter = {
  clear(): void
  render(text: string, diagnostics: readonly lsp.Diagnostic[]): void
  publishSummary(
    uri: lsp.DocumentUri,
    version: number | null,
    diagnostics: readonly lsp.Diagnostic[],
  ): void
}

export class CompositeDiagnosticsPresenter {
  readonly #batches = new Map<string, DiagnosticBatch>()
  #diagnostics: readonly lsp.Diagnostic[] = []

  public constructor(
    private readonly presenter: DiagnosticsPresenter,
    private readonly laneIds: readonly string[],
    private readonly onDiagnostics?: (summary: LanguageServerDiagnosticSummary) => void,
  ) {}

  public get diagnostics(): readonly lsp.Diagnostic[] {
    return this.#diagnostics
  }

  public forLane(
    laneId: string,
    onDiagnostics?: (summary: LanguageServerDiagnosticSummary) => void,
  ): CompositeDiagnosticsLanePresenter {
    return {
      clear: () => {
        const current = this.#batches.get(laneId)
        if (!current) return

        this.#batches.set(laneId, { ...current, diagnostics: [] })
        this.refreshDiagnostics()
        this.renderCombined()
      },
      render: (text, diagnostics) => {
        const current = this.#batches.get(laneId)
        this.#batches.set(laneId, {
          diagnostics,
          text,
          uri: current?.uri ?? null,
          version: current?.version ?? null,
        })
        this.refreshDiagnostics()
        this.renderCombined()
      },
      publishSummary: (uri, version, diagnostics) => {
        const current = this.#batches.get(laneId)
        if (!current && diagnostics.length === 0) {
          onDiagnostics?.(summarizeDiagnostics(uri, version, diagnostics))
          this.publishCombinedSummary()
          return
        }

        this.#batches.set(laneId, {
          diagnostics,
          text: current?.text ?? '',
          uri,
          version,
        })
        this.refreshDiagnostics()
        onDiagnostics?.(summarizeDiagnostics(uri, version, diagnostics))
        this.publishCombinedSummary()
      },
    }
  }

  public clear(): void {
    this.#batches.clear()
    this.refreshDiagnostics()
    this.presenter.clear()
  }

  public moveMarker(
    active: DiagnosticsPresenterActiveDocument | null,
    direction: DiagnosticsPresenterMarkerDirection,
  ): boolean {
    return this.presenter.moveMarker(active, this.diagnostics, direction)
  }

  private renderCombined(): void {
    const text = this.currentText()
    if (text === null) {
      this.presenter.clear()
      return
    }

    this.presenter.render(text, this.diagnostics)
  }

  private refreshDiagnostics(): void {
    this.#diagnostics = this.laneIds.flatMap((id) => this.#batches.get(id)?.diagnostics ?? [])
  }

  private publishCombinedSummary(): void {
    const current = this.currentBatch()
    this.onDiagnostics?.(
      summarizeDiagnostics(current?.uri ?? null, current?.version ?? null, this.diagnostics),
    )
  }

  private currentText(): string | null {
    for (const id of this.laneIds) {
      const batch = this.#batches.get(id)
      if (batch && batch.diagnostics.length > 0) return batch.text
    }

    for (const id of this.laneIds) {
      const batch = this.#batches.get(id)
      if (batch) return batch.text
    }

    return null
  }

  private currentBatch(): DiagnosticBatch | null {
    for (const id of this.laneIds) {
      const batch = this.#batches.get(id)
      if (batch && batch.diagnostics.length > 0) return batch
    }

    for (const id of this.laneIds) {
      const batch = this.#batches.get(id)
      if (batch) return batch
    }

    return null
  }
}

function createHighlightNames(
  prefix: string,
  namespace: string,
): Record<LanguageServerDiagnosticSeverity, string> {
  return {
    error: `${prefix}-${namespace}-error`,
    warning: `${prefix}-${namespace}-warning`,
    information: `${prefix}-${namespace}-information`,
    hint: `${prefix}-${namespace}-hint`,
  }
}

function diagnosticMinimapDecorations(
  lineCount: number,
  diagnostics: readonly lsp.Diagnostic[],
): readonly EditorMinimapDecoration[] {
  return diagnostics.flatMap((diagnostic) => diagnosticMinimapDecoration(lineCount, diagnostic))
}

function diagnosticMinimapDecoration(
  lineCount: number,
  diagnostic: lsp.Diagnostic,
): readonly EditorMinimapDecoration[] {
  if (lineCount <= 0) return []

  const severity = minimapSeverityForDiagnostic(diagnostic)
  const startLineNumber = clampLineNumber(diagnostic.range.start.line + 1, lineCount)
  const endLineNumber = Math.max(
    startLineNumber,
    clampLineNumber(diagnosticEndLineNumber(diagnostic), lineCount),
  )
  return [
    {
      startLineNumber,
      startColumn: 1,
      endLineNumber,
      endColumn: 1,
      color: DIAGNOSTIC_MARKER_COLORS[severity],
      position: 'inline',
      zIndex: DIAGNOSTIC_MINIMAP_Z_INDEX[severity],
    },
  ]
}

function diagnosticEndLineNumber(diagnostic: lsp.Diagnostic): number {
  const start = diagnostic.range.start
  const end = diagnostic.range.end
  if (end.line > start.line && end.character === 0) return end.line
  return end.line + 1
}

function minimapSeverityForDiagnostic(
  diagnostic: lsp.Diagnostic,
): LanguageServerDiagnosticSeverity {
  if (diagnostic.severity === LSP_DIAGNOSTIC_WARNING) return 'warning'
  if (diagnostic.severity === LSP_DIAGNOSTIC_INFORMATION) return 'information'
  if (diagnostic.severity === LSP_DIAGNOSTIC_HINT) return 'hint'
  if (diagnostic.severity === LSP_DIAGNOSTIC_ERROR) return 'error'
  return 'error'
}

function clampLineNumber(lineNumber: number, lineCount: number): number {
  return Math.min(Math.max(1, lineNumber), lineCount)
}

function diagnosticMarkerTarget(
  text: string,
  diagnostics: readonly lsp.Diagnostic[],
  offset: number,
  direction: DiagnosticsPresenterMarkerDirection,
): OffsetRange | null {
  const ranges = diagnostics
    .flatMap((diagnostic) => diagnosticRange(text, diagnostic))
    .sort(compareOffsetRanges)
  if (ranges.length === 0) return null
  if (direction === 'next') return ranges.find((range) => range.start > offset) ?? ranges[0] ?? null

  return ranges.toReversed().find((range) => range.start < offset) ?? ranges.at(-1) ?? null
}

function diagnosticRange(text: string, diagnostic: lsp.Diagnostic): readonly OffsetRange[] {
  const start = lspPositionToOffset(text, diagnostic.range.start)
  const end = lspPositionToOffset(text, diagnostic.range.end)
  if (end < start) return []
  return [{ start, end }]
}

function compareOffsetRanges(left: OffsetRange, right: OffsetRange): number {
  return left.start - right.start || left.end - right.end
}
