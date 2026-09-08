import type { Point } from '../../src/pieceTable/pieceTableTypes'
import { type MeasuredText, type TextMeasurements } from '../../src/textMeasurements'
declare const tabPointBrand: unique symbol
declare const wrapPointBrand: unique symbol
export type TransformBias = 'before' | 'after' | 'nearest'
export type InvalidatedRange<TPoint extends Point> = {
  readonly start: TPoint
  readonly end: TPoint
  readonly lineCountDelta: number
}
export type TabPoint = Point & {
  readonly [tabPointBrand]: true
}
export type WrapPoint = Point & {
  readonly [wrapPointBrand]: true
}
export type DisplayTextRowSource = 'document' | 'injected'
export type DisplayDocumentTextRow = MeasuredText & {
  readonly kind: 'text'
  readonly source: 'document'
  readonly index: number
  readonly bufferRow: number
  readonly startOffset: number
  readonly endOffset: number
  readonly text: string
  readonly sourceText: string
  readonly sourceStartColumn: number
  readonly sourceEndColumn: number
  readonly displayStartColumn: number
  readonly displayEndColumn: number
  readonly wrapSegment: number
  /**
   * The whole buffer line projected into display space, present only when the line carries inline
   * replacements. Shared by every wrap slice of the line; its segments are line-absolute, so
   * subtract `displayStartColumn` to rebase them onto this row.
   */
  readonly inlineRow?: InlineRow
}
export type DisplayInjectedTextRow = MeasuredText & {
  readonly kind: 'text'
  readonly source: 'injected'
  readonly id: string
  readonly index: number
  readonly bufferRow: number
  readonly anchorBufferRow: number
  readonly placement: InjectedTextRowPlacement
  readonly order: number
  readonly startOffset: number
  readonly endOffset: number
  readonly text: string
  readonly sourceText: string
  readonly sourceStartColumn: number
  readonly sourceEndColumn: number
  readonly displayStartColumn: number
  readonly displayEndColumn: number
  readonly wrapSegment: number
  readonly className?: string
  readonly gutterClassName?: string
  readonly metadata?: unknown
}
export type DisplayTextRow = DisplayDocumentTextRow | DisplayInjectedTextRow
export type DisplayRow = DisplayTextRow
type InjectedTextRowPlacement = 'before' | 'after'
export type InjectedTextRow = {
  readonly id: string
  readonly anchorBufferRow: number
  readonly placement: InjectedTextRowPlacement
  readonly text: string
  readonly order?: number
  readonly className?: string
  readonly gutterClassName?: string
  readonly metadata?: unknown
}
type WrapSegment = {
  readonly inputRow: number
  readonly outputRow: number
  readonly segmentIndex: number
  readonly startColumn: number
  readonly endColumn: number
  readonly startVisualColumn: number
  readonly endVisualColumn: number
}
export type WrapMap = {
  readonly wrapColumn: number
  readonly segments: readonly WrapSegment[]
}
/**
 * Which display edge of an injected run the caret may rest on. Only a position with no direction of
 * its own needs telling: every other one at that point is the edge of a range, and a range takes the
 * side that leaves the run outside it.
 */
export type InlineCursorStops = 'both' | 'left' | 'right' | 'none'
/**
 * Fills the node a replacement is painted as. Returning a disposable lets the run take down whatever
 * it attached — a listener, an observer — when the replacement leaves the map.
 */
export type InlineReplacementRender = (container: HTMLElement) => void | {
  dispose(): void
}
/**
 * A single-line source span painted as `text` instead of its own characters. An empty `text` hides
 * the span outright; a non-empty `text` stands in for it. Replacements are atomic: no display
 * column ever resolves to a source column strictly inside one.
 *
 * An `insertion` covers no source columns at all — phantom text hanging off a point, which is how an
 * inlay hint or a colour swatch reaches the screen without the document ever holding it.
 */
export type InlineReplacement = {
  readonly id: string
  readonly startColumn: number
  readonly endColumn: number
  readonly text: string
  readonly insertion?: boolean
  readonly kind?: string
  /** Styles the run alone, where `kind` restyles the whole row the run sits on. */
  readonly className?: string
  readonly cursorStops?: InlineCursorStops
  readonly render?: InlineReplacementRender
  readonly metadata?: unknown
}
export type InlineRowSegmentKind = 'source' | 'replacement'
export type InlineRowSegment = {
  readonly kind: InlineRowSegmentKind
  readonly sourceStartColumn: number
  readonly sourceEndColumn: number
  readonly displayStartColumn: number
  readonly displayEndColumn: number
  readonly id?: string
  readonly replacementKind?: string
  readonly className?: string
  readonly cursorStops?: InlineCursorStops
  readonly render?: InlineReplacementRender
  readonly metadata?: unknown
}
/**
 * One buffer line projected into display space. Segments are contiguous and cover the whole line,
 * so column conversion in either direction is total.
 */
export type InlineRow = {
  readonly sourceText: string
  readonly text: string
  readonly segments: readonly InlineRowSegment[]
}
export type InlineColumnRange = {
  readonly startColumn: number
  readonly endColumn: number
}
export declare function normalizeTabSize(tabSize: number | undefined): number
export declare function bufferColumnToVisualColumn(
  content: string | MeasuredText,
  column: number,
  tabSize?: number,
): number
export declare function visualColumnToBufferColumn(
  content: string | MeasuredText,
  visualColumn: number,
  bias?: TransformBias,
  tabSize?: number,
): number
export declare function visualColumnLength(text: string | MeasuredText, tabSize?: number): number
export declare function bufferPointToTabPoint(
  text: string,
  point: Point,
  tabSize?: number,
): TabPoint
export declare function tabPointToBufferPoint(
  text: string,
  point: TabPoint,
  bias?: TransformBias,
  tabSize?: number,
): Point
export declare function createWrapMap(
  rows: readonly {
    readonly row: number
    readonly text: string
  }[],
  wrapColumn: number,
  tabSize?: number,
): WrapMap
export declare function tabPointToWrapPoint(map: WrapMap, point: TabPoint): WrapPoint
export declare function wrapPointToTabPoint(
  map: WrapMap,
  point: WrapPoint,
  bias?: TransformBias,
): TabPoint
export declare function createInlineRow(
  sourceText: string,
  replacements?: readonly InlineReplacement[],
): InlineRow
export declare function sourceColumnToInlineColumn(
  row: InlineRow,
  column: number,
  bias?: TransformBias,
): number
/**
 * Hidden replacements are zero-width in display space, so several source columns share one display
 * column and the inverse is genuinely ambiguous there. The rule is: `before` and `nearest` resolve to
 * the earliest source column for that display column, `after` to the latest. Horizontal motion
 * therefore passes the bias matching its direction. `display -> source -> display` is the identity
 * across a hidden run; `source -> display -> source` is not, at a hidden boundary.
 */
export declare function inlineColumnToSourceColumn(
  row: InlineRow,
  column: number,
  bias?: TransformBias,
): number
/**
 * Projects a source column range into display space. A range that overlaps a replacement covers the
 * whole replacement, so selections, find matches, and syntax tokens paint replacements atomically.
 * A range hidden in its entirety returns no display ranges.
 */
export declare function sourceRangeToInlineRanges(
  row: InlineRow,
  startColumn: number,
  endColumn: number,
): readonly InlineColumnRange[]
export declare function isDocumentTextDisplayRow(
  row: DisplayRow | undefined,
): row is DisplayDocumentTextRow
export declare function isInjectedTextDisplayRow(
  row: DisplayRow | undefined,
): row is DisplayInjectedTextRow
export type DisplayRowLineInput = {
  readonly visibleLineCount: number
  readonly bufferRowForVisibleRow: (row: number) => number
  readonly lineText: (bufferRow: number) => string
  readonly lineMeasurements?: (bufferRow: number) => TextMeasurements
  readonly lineStartOffset: (bufferRow: number) => number
  readonly lineEndOffset: (bufferRow: number) => number
  readonly wrapColumn?: number | null
  readonly injectedTextRows?: readonly InjectedTextRow[]
  readonly inlineReplacements?: (bufferRow: number) => readonly InlineReplacement[]
  readonly tabSize?: number
}
export declare function createDisplayRows(options: {
  readonly lineStarts: readonly number[]
  readonly text: string
  readonly bufferRowForVisibleRow: (row: number) => number
  readonly visibleLineCount: number
  readonly wrapColumn?: number | null
  readonly injectedTextRows?: readonly InjectedTextRow[]
  readonly inlineReplacements?: (bufferRow: number) => readonly InlineReplacement[]
  readonly tabSize?: number
}): DisplayRow[]
export declare function createDisplayRowsFromLines(options: DisplayRowLineInput): DisplayRow[]
export {}
//# sourceMappingURL=displayTransforms.d.ts.map
