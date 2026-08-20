import type { InlineMap } from '../inlineMap'
import type { BlockLane, DisplayRow } from '../displayTransforms'
import type { EditorGutterContribution, EditorGutterWidthContext } from '../plugins'
import type { EditorToken, EditorTokenStyle } from '../tokens'
import type { BrowserTextMetrics } from './browserMetrics'
import type { FixedRowVirtualizer } from './fixedRowVirtualizer'
import type { LineStartOffsetIndex } from './lineStartIndex'
import type { RowHeightIndex } from './rowHeightIndex'
import type { SuspiciousCharacterSettings } from './virtualizedTextViewHiddenCharacters'
import type { VirtualizedTextViewModelState } from './virtualizedTextViewModel'
import type {
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
  HighlightRegistry,
  MountedVirtualizedTextRow,
  TokenGroup,
  VirtualizedBlockLaneMount,
  VirtualizedBlockRowMount,
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
}

export type VirtualizedTextSelection = {
  readonly anchorOffset: number
  readonly headOffset: number
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
  readonly blockRowMount: VirtualizedBlockRowMount | null
  readonly blockLaneMount: VirtualizedBlockLaneMount | null
  readonly blockLaneLayerElement: HTMLDivElement
  readonly cursorLineHighlight: Required<EditorCursorLineHighlightOptions>
  readonly rowElements: Map<number, MountedVirtualizedTextRow>
  readonly rowPool: MountedVirtualizedTextRow[]
  readonly highlightRegistry: HighlightRegistry | null
  readonly selectionHighlightName: string
  readonly selectionHighlight: Highlight | null
  readonly rangeHighlightGroups: Map<string, VirtualizedTextHighlightGroup>
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
  rowHeightIndex: RowHeightIndex | null
  rowHeightIndexDisplayRows: readonly DisplayRow[] | null
  rowHeightIndexRowHeight: number
  rowHeightIndexRowGap: number
  rowHeightIndexVariable: boolean | null
  blockLanes: readonly BlockLane[]
  blockLaneElements: Map<string, MountedVirtualizedBlockLane>
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

export type MountedVirtualizedBlockLane = {
  readonly id: string
  readonly element: HTMLDivElement
  readonly mountDisposable: { dispose(): void } | null
  readonly layoutKey: string
}
