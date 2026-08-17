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
