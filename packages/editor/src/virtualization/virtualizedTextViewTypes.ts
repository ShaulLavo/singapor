import type { EditorGutterContribution, EditorGutterWidthContext } from '../plugins'
import type { EditorTokenStyle } from '../tokens'
import type {
  BlockLane,
  BlockLanePlacement,
  BlockRow,
  BlockRowPlacement,
  DisplayTextRowSource,
  InjectedTextRow,
} from '../displayTransforms'
import type { BrowserTextMetrics } from './browserMetrics'
import type { FixedRowVisibleRange } from './fixedRowVirtualizer'

export type CaretPositionResult = {
  readonly offsetNode: Node
  readonly offset: number
}

export type DocumentWithCaretHitTesting = Document & {
  readonly caretPositionFromPoint?: (x: number, y: number) => CaretPositionResult | null
  readonly caretRangeFromPoint?: (x: number, y: number) => Range | null
}

export type VirtualizedTextViewOptions = {
  readonly lineHeight?: number
  readonly rowHeight?: number
  readonly rowGap?: number
  readonly overscan?: number
  readonly scrollMode?: VirtualizedTextViewScrollMode
  readonly className?: string
  readonly gutterWidth?: number | ((context: EditorGutterWidthContext) => number)
  readonly longLineChunkSize?: number
  readonly longLineChunkThreshold?: number
  readonly horizontalOverscanColumns?: number
  readonly selectionHighlightName?: string
  readonly highlightRegistry?: HighlightRegistry
  readonly onFoldToggle?: (marker: VirtualizedFoldMarker) => void
  readonly onViewportChange?: () => void
  readonly wrap?: boolean
  readonly blockRows?: readonly BlockRow[]
  readonly injectedTextRows?: readonly InjectedTextRow[]
  readonly blockRowMount?: VirtualizedBlockRowMount
  readonly blockLanes?: readonly BlockLane[]
  readonly blockLaneMount?: VirtualizedBlockLaneMount
  readonly gutterContributions?: readonly EditorGutterContribution[]
  readonly cursorLineHighlight?: EditorCursorLineHighlightOptions
  readonly hiddenCharacters?: HiddenCharactersMode
  readonly tabSize?: number
  readonly textMetrics?: BrowserTextMetrics
}

export type VirtualizedTextViewScrollMode = 'virtualized' | 'static'

export type VirtualizedBlockRowMount = (
  container: HTMLElement,
  context: VirtualizedBlockRowMountContext,
) => void | VirtualizedBlockRowDisposable

export type VirtualizedBlockRowDisposable = {
  dispose(): void
}

export type VirtualizedBlockRowMountContext = {
  readonly id: string
  readonly anchorBufferRow: number
  readonly placement: BlockRowPlacement
  readonly startOffset: number
  readonly endOffset: number
}

export type VirtualizedBlockLaneMount = (
  container: HTMLElement,
  context: VirtualizedBlockLaneMountContext,
) => void | VirtualizedBlockRowDisposable

export type VirtualizedBlockLaneMountContext = {
  readonly id: string
  readonly startBufferRow: number
  readonly endBufferRow: number
  readonly placement: BlockLanePlacement
}

export type HiddenCharactersMode = 'hidden' | 'show' | 'show-on-selection'

export type VirtualizedTextHighlightRange = {
  readonly start: number
  readonly end: number
}

export type VirtualizedTextHighlightStyle = {
  readonly backgroundColor?: string
  readonly color?: string
  readonly textDecoration?: string
}

export type VirtualizedTextRowDecoration = {
  readonly className?: string
  readonly gutterClassName?: string
}

export type EditorCursorLineHighlightOptions = {
  readonly gutterNumber?: boolean
  readonly gutterBackground?: boolean | readonly string[]
  readonly rowBackground?: boolean
}

export type VirtualizedTextChunk = {
  readonly startOffset: number
  readonly endOffset: number
  readonly localStart: number
  readonly localEnd: number
  readonly text: string
  readonly element: HTMLSpanElement | null
  readonly textNode: Text
  readonly parts: readonly VirtualizedTextChunkPart[]
}

export type VirtualizedTextChunkPart =
  | VirtualizedTextChunkTextPart
  | VirtualizedTextChunkControlPart

export type VirtualizedTextRenderMode = 'simple' | 'rendered' | 'chunked'

export type VirtualizedTextChunkTextPart = {
  readonly kind: 'text'
  readonly localStart: number
  readonly localEnd: number
  readonly node: Text
}

export type VirtualizedTextChunkControlPart = {
  readonly kind: 'control'
  readonly localStart: number
  readonly localEnd: number
  readonly element: HTMLSpanElement
  readonly widthCells: number
}

export type VirtualizedFoldMarker = {
  readonly key: string
  readonly startOffset: number
  readonly endOffset: number
  readonly startRow: number
  readonly endRow: number
  readonly collapsed: boolean
}

export type VirtualizedTextRow = {
  readonly index: number
  readonly bufferRow: number
  readonly source: DisplayTextRowSource | 'block'
  readonly injectedTextRowId?: string
  readonly metadata?: unknown
  readonly startOffset: number
  readonly endOffset: number
  readonly text: string
  readonly kind: 'text' | 'block'
  readonly chunks: readonly VirtualizedTextChunk[]
  readonly element: HTMLDivElement
  readonly textNode: Text
}

export type VirtualizedTextViewState = {
  readonly lineCount: number
  readonly contentWidth: number
  readonly foldMapActive: boolean
  readonly metrics: BrowserTextMetrics
  readonly scrollHeight: number
  readonly scrollLeft: number
  readonly scrollTop: number
  readonly scrollWidth: number
  readonly borderBoxHeight: number
  readonly borderBoxWidth: number
  readonly totalHeight: number
  readonly viewportHeight: number
  readonly viewportWidth: number
  readonly visibleRange: FixedRowVisibleRange
  readonly mountedRows: readonly MountedVirtualizedTextRow[]
  readonly foldMarkers: readonly VirtualizedFoldMarker[]
  readonly wrapActive: boolean
  readonly blockRowCount: number
  readonly blockLaneCount: number
  readonly tabSize: number
}

export type NativeGeometryValidation = {
  readonly mountedRows: number
  readonly caretChecks: number
  readonly selectionChecks: number
  readonly hitTestChecks: number
  readonly failures: readonly string[]
  readonly ok: boolean
}

export interface HighlightRegistry {
  set(name: string, highlight: Highlight): void
  delete(name: string): boolean
}

export type TokenGroup = {
  readonly name: string
  readonly highlight: Highlight
  readonly style: EditorTokenStyle
  readonly styleKey: string
}

export type TokenRowSegment = {
  readonly chunk: VirtualizedTextChunk
  readonly start: number
  readonly end: number
  readonly style: EditorTokenStyle
  readonly styleKey: string
}

export type MountedVirtualizedTextRow = VirtualizedTextRow & {
  readonly gutterElement: HTMLDivElement
  readonly gutterCells: Map<string, HTMLElement>
  readonly gutterCellList: readonly HTMLElement[]
  readonly leftSpacerElement: HTMLSpanElement
  readonly selectionLayerElement: HTMLDivElement
  readonly foldPlaceholderElement: HTMLSpanElement
  readonly hiddenCharactersLayerElement: HTMLDivElement
  readonly blockContainerElement: HTMLDivElement
  readonly blockMountDisposable: VirtualizedBlockRowDisposable | null
  readonly blockMountKey: string
  readonly leftBlockLaneWidth: number
  readonly rightBlockLaneWidth: number
  readonly blockLaneKey: string
  readonly top: number
  readonly height: number
  readonly textRevision: number
  readonly tokenHighlightSlotId: number
  readonly chunkKey: string
  readonly selectionLayerKey: string
  readonly hiddenCharactersKey: string
  readonly foldMarkerKey: string
  readonly foldCollapsed: boolean
  readonly displayKind: 'text' | 'block'
  readonly textRenderMode: VirtualizedTextRenderMode
  readonly rowDecorationClassName: string
  readonly rowDecorationGutterClassName: string
  readonly rowDecorationKey: string
  readonly cursorLineContentActive: boolean
  readonly geometryCache: unknown | null
}

export type SameLineEditPatch = {
  readonly rowIndex: number
  readonly localFrom: number
  readonly deleteLength: number
  readonly text: string
}

export type MultiLineEditPatch = {
  readonly startRow: number
  readonly endRow: number
  readonly insertedLineBreaks: number
  readonly delta: number
}

export type HorizontalChunkWindow = {
  readonly start: number
  readonly end: number
}

export type OffsetRange = {
  readonly start: number
  readonly end: number
}
