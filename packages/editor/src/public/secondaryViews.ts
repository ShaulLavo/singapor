import type { TextSnapshot } from '../documentTextSnapshot'
import type { EditorLineStartsView,
  EditorResolvedSelection,
  EditorViewSnapshot,
  EditorViewportSnapshot,
  EditorVisibleRowSnapshot,
} from '../plugins'
import type { EditorSyntaxLanguageId } from '../syntax'
import type { EditorTheme } from '../theme'
import type { EditorToken } from '../tokens'
import type { BrowserTextMetrics, VirtualizedFoldMarker } from '../virtualization'

export { EditorWorkScheduler as EditorSecondaryViewScheduler } from '../editor/workScheduler'
export { VirtualizedTextView as EditorSecondaryTextView } from '../virtualization'
export type {
  EditorScheduleWorkOptions as EditorSecondaryScheduleWorkOptions,
  EditorScheduledWorkHandle as EditorSecondaryScheduledWorkHandle,
  EditorWorkContext as EditorSecondaryWorkContext,
  EditorWorkEvent as EditorSecondaryWorkEvent,
  EditorWorkEventType as EditorSecondaryWorkEventType,
  EditorWorkPriority as EditorSecondaryWorkPriority,
  EditorWorkSchedulerOptions as EditorSecondaryWorkSchedulerOptions,
  EditorWorkTags as EditorSecondaryWorkTags,
  EditorWorkTaskClass as EditorSecondaryWorkTaskClass,
} from '../editor/workScheduler'
export type {
  VirtualizedTextViewOptions as EditorSecondaryTextViewOptions,
  VirtualizedTextViewState as EditorSecondaryTextViewState,
} from '../virtualization'

export type EditorSecondaryViewTextProjection = {
  readonly snapshot: TextSnapshot | null
  readonly length: number | null
  readonly lineStarts: readonly number[]
  readonly lineStartsView?: EditorLineStartsView
  readonly lineCount: number
  materializeFullText(): string
}

export type EditorSecondaryViewLineModel = {
  readonly kind: 'visible'
  readonly rows: readonly EditorVisibleRowSnapshot[]
  readonly totalLineCount: number
}

export type EditorSecondaryViewSyntaxColors = {
  readonly languageId: EditorSyntaxLanguageId | null
  readonly theme?: EditorTheme | null
  readonly tokens: readonly EditorToken[]
}

export type EditorSecondaryViewDecoration = {
  readonly owner: string
  readonly startLineNumber: number
  readonly endLineNumber: number
  readonly kind?: string
  readonly metadata?: unknown
}

export type EditorSecondaryViewFoldSummary = {
  readonly key: string
  readonly startOffset: number
  readonly endOffset: number
  readonly startLineNumber: number
  readonly endLineNumber: number
  readonly collapsed: boolean
}

export type EditorSecondaryViewProjection = {
  readonly documentId: string | null
  readonly textVersion: number
  readonly text: EditorSecondaryViewTextProjection
  readonly viewport: EditorViewportSnapshot
  readonly metrics: BrowserTextMetrics
  readonly visibleLineModel: EditorSecondaryViewLineModel
  readonly syntaxColors: EditorSecondaryViewSyntaxColors
  readonly selections: readonly EditorResolvedSelection[]
  readonly decorations: readonly EditorSecondaryViewDecoration[]
  readonly foldSummaries: readonly EditorSecondaryViewFoldSummary[]
}

export type EditorSecondaryViewProjectionOptions = {
  readonly decorations?: readonly EditorSecondaryViewDecoration[]
}

export function createEditorSecondaryViewProjection(
  snapshot: EditorViewSnapshot,
  options: EditorSecondaryViewProjectionOptions = {},
): EditorSecondaryViewProjection {
  return {
    documentId: snapshot.documentId,
    textVersion: snapshot.textVersion,
    text: createTextProjection(snapshot),
    viewport: snapshot.viewport,
    metrics: snapshot.metrics,
    visibleLineModel: {
      kind: 'visible',
      rows: snapshot.visibleRows,
      totalLineCount: snapshot.lineCount,
    },
    syntaxColors: {
      languageId: snapshot.languageId,
      theme: snapshot.theme,
      tokens: snapshot.tokens,
    },
    selections: snapshot.selections,
    decorations: options.decorations ?? [],
    foldSummaries: snapshot.foldMarkers.map(foldSummaryFromMarker),
  }
}

function createTextProjection(snapshot: EditorViewSnapshot): EditorSecondaryViewTextProjection {
  const textSnapshot = snapshot.textSnapshot ?? null

  return {
    snapshot: textSnapshot,
    length: textProjectionLength(textSnapshot),
    get lineStarts() {
      return snapshot.lineStarts
    },
    lineStartsView: snapshot.lineStartsView,
    lineCount: snapshot.lineCount,
    materializeFullText: () => materializeProjectionText(snapshot, textSnapshot),
  }
}

function textProjectionLength(textSnapshot: TextSnapshot | null): number | null {
  if (textSnapshot) return textSnapshot.length
  return null
}

function materializeProjectionText(
  snapshot: EditorViewSnapshot,
  textSnapshot: TextSnapshot | null,
): string {
  if (textSnapshot) return textSnapshot.materializeFullText()
  return snapshot.fullText
}

function foldSummaryFromMarker(marker: VirtualizedFoldMarker): EditorSecondaryViewFoldSummary {
  return {
    key: marker.key,
    startOffset: marker.startOffset,
    endOffset: marker.endOffset,
    startLineNumber: marker.startRow + 1,
    endLineNumber: marker.endRow + 1,
    collapsed: marker.collapsed,
  }
}
