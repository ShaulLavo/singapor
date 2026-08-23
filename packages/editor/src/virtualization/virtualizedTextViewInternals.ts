import type { InlineMap } from '../inlineMap'
import type { EditorGutterContribution, EditorGutterWidthContext } from '../plugins'
import type { SelectionAffinity } from '../selections'
import type { EditorToken, EditorTokenStyle } from '../tokens'
import type { BrowserTextMetrics } from './browserMetrics'
import type { FixedRowVirtualizer } from './fixedRowVirtualizer'
import type { LineStartOffsetIndex } from './lineStartIndex'
import type { SuspiciousCharacterSettings } from './virtualizedTextViewHiddenCharacters'
import type { VirtualizedTextViewModelState } from './virtualizedTextViewModel'
import type {
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
  HighlightRegistry,
  MountedVirtualizedTextRow,
  TokenGroup,
  VirtualizedFoldMarker,
  VirtualizedTextViewRowPositioning,
  VirtualizedTextViewScrollMode,
  VirtualizedTextRowDecoration,
} from './virtualizedTextViewTypes'

export type RevealBlock = 'nearest' | 'end'

export type CreateRangeOptions = {
  readonly scrollIntoView?: boolean
}

export type VirtualizedStoredSelection = {
  readonly start: number
  readonly end: number
  readonly head: number
  readonly affinity: SelectionAffinity
}

export type VirtualizedTextSelection = {
  readonly anchorOffset: number
  readonly headOffset: number
  readonly affinity?: SelectionAffinity
}

export type VirtualizedTextHighlightRange = {
  readonly start: number
  readonly end: number
}

export type VirtualizedTextHighlightStyle = {
  readonly backgroundColor?: string
  readonly color?: string
  readonly textDecoration?: string
  // Stacking against other highlight groups, highest paints last. Without it
  // the CSS highlight registry falls back to registration order, which shifts
  // as groups scroll in and out of the mounted window.
  readonly zIndex?: number
}

export type VirtualizedTextHighlightGroup = {
  readonly name: string
  readonly highlight: Highlight
  ranges: readonly VirtualizedTextHighlightRange[]
  style: VirtualizedTextHighlightStyle
  registered: boolean
  signature: string
}

export type TokenRenderEntry = {
  readonly start: number
  readonly end: number
  readonly style: EditorTokenStyle
  readonly styleKey: string
  readonly sourceIndex: number
}

export type SameLineTokenEdit = {
  readonly rowIndex: number
  readonly editedRowPatchedInPlace: boolean
  readonly kind?: 'same-line' | 'multi-line'
}

export interface VirtualizedTextViewInternal {
  readonly scrollElement: HTMLDivElement
  readonly inputElement: HTMLTextAreaElement
  readonly spacer: HTMLDivElement
  readonly gutterElement: HTMLDivElement
  gutterContributions: readonly EditorGutterContribution[]
  readonly gutterWidthProvider: ((context: EditorGutterWidthContext) => number) | null
  readonly caretLayerElement: HTMLDivElement
  readonly caretElement: HTMLDivElement
  readonly secondaryCaretElements: HTMLDivElement[]
  readonly styleEl: HTMLStyleElement
  readonly virtualizer: FixedRowVirtualizer
  scrollMode: VirtualizedTextViewScrollMode
  readonly rowPositioning: VirtualizedTextViewRowPositioning
  readonly longLineChunkSize: number
  readonly longLineChunkThreshold: number
  readonly horizontalOverscanColumns: number
  readonly onFoldToggle: ((marker: VirtualizedFoldMarker) => void) | null
  readonly onViewportChange: (() => void) | null
  readonly cursorLineHighlight: Required<EditorCursorLineHighlightOptions>
  readonly rowElements: Map<number, MountedVirtualizedTextRow>
  readonly rowPool: MountedVirtualizedTextRow[]
  readonly highlightRegistry: HighlightRegistry | null
  readonly selectionHighlightName: string
  readonly selectionHighlight: Highlight | null
  readonly rangeHighlightGroups: Map<string, VirtualizedTextHighlightGroup>
  // A range rule depends only on a group's name and style, so a repaint that moves ranges around
  // cannot change the rule set. Counting the changes that *can* — a group added, removed, or
  // restyled — is what keeps `rebuildStyleRules` off the O(groups^2) path a per-keystroke repaint
  // of many groups would otherwise put it on. Worth about 1% of a keystroke at the live group
  // count, which is smaller than it sounds and was once recorded as far larger. The benchmark and
  // correction live with the regression in test/semanticTokenRepaintCost.test.ts.
  rangeHighlightRuleVersion: number
  renderedRangeHighlightRuleVersion: number
  selectionHighlightRegistered: boolean
  model: VirtualizedTextViewModelState
  text: string
  textRevision: number
  tokens: readonly EditorToken[]
  tokenRenderEntries: readonly TokenRenderEntry[]
  tokenRenderEntryMaxEnds: readonly number[]
  tokenRenderStyles: ReadonlyMap<string, EditorTokenStyle>
  tokenRenderIndexDirty: boolean
  lineStarts: number[]
  lineStartOffsetIndex: LineStartOffsetIndex | null
  foldMarkers: readonly VirtualizedFoldMarker[]
  rowDecorations: ReadonlyMap<number, VirtualizedTextRowDecoration>
  foldMarkerByStartRow: ReadonlyMap<number, VirtualizedFoldMarker>
  foldMarkerByKey: ReadonlyMap<string, VirtualizedFoldMarker>
  wrapEnabled: boolean
  tabSize: number
  tokenGroups: Map<string, TokenGroup>
  rowTokenSignatures: Map<number, string>
  rowTokenRanges: Map<number, Map<string, readonly AbstractRange[]>>
  tokenProjectionDirtyStartRow: number | null
  nextTokenHighlightSlotId: number
  selectionStart: number | null
  selectionEnd: number | null
  selectionHead: number | null
  selections: readonly VirtualizedStoredSelection[]
  /** The inline map as supplied; model.inlineMap is this with the selection's constructs revealed. */
  inlineMapBase: InlineMap | null
  lastSelectionHighlightSignature: string
  lastRenderedRowsKey: string
  lastSpacerHeight: string
  lastSpacerTransform: string
  lastSpacerWidth: string
  gutterContributionWidths: ReadonlyMap<string, number>
  gutterWidthDirty: boolean
  currentGutterWidth: number
  contentWidth: number
  maxVisualColumnsSeen: number
  lastWidthScanStart: number
  lastWidthScanEnd: number
  sameLineTokenEdit: SameLineTokenEdit | null
  lineHeightOverride: number | null
  rowGap: number
  metrics: BrowserTextMetrics
  textMetrics: BrowserTextMetrics | null
  hiddenCharacters: HiddenCharactersMode
  suspiciousCharacters: SuspiciousCharacterSettings
}
