import type { DisplayRow, InjectedTextRow, InlineRow } from '../displayTransforms'
import type { TextSnapshot } from '../documentTextSnapshot'
import type { FoldMap } from '../foldMap'
import type { InlineMap } from '../inlineMap'
import type { PieceTableEdit } from '../pieceTable/pieceTableTypes'

export type DisplayProjectionConfig = {
  readonly foldMap: FoldMap | null
  readonly inlineMap: InlineMap | null
  readonly injectedTextRows: readonly InjectedTextRow[]
  readonly wrapColumn: number | null
  readonly tabSize: number
}

export type DisplayProjectionInput = DisplayProjectionConfig & {
  readonly textSnapshot: TextSnapshot
}
export type DisplayProjectionTransition = {
  readonly before: TextSnapshot
  readonly after: TextSnapshot
  readonly edits: readonly PieceTableEdit[]
}

type WithoutText<T> = T extends unknown ? Omit<T, 'text' | 'sourceText' | 'measurements'> : never
export type DisplayRowMetrics = WithoutText<DisplayRow> & {
  readonly textLength: number
  readonly sourceLength: number
}

export type WrapSummary =
  | {
      readonly kind: 'uniform'
      readonly length: number
      readonly width: number
      readonly rows: number
    }
  | {
      readonly kind: 'indexed'
      readonly length: number
      readonly ends: Uint32Array
      readonly rows: number
    }

export type InlineTextPart = {
  readonly start: number
  readonly end: number
  readonly sourceStart: number
  readonly replacement: string | null
}

export type InlineSummary = {
  readonly mapping: InlineRow
  readonly parts: readonly InlineTextPart[]
}

export type InjectedSummary = { readonly input: InjectedTextRow; readonly wrap: WrapSummary }
export type WrappedEntry = {
  readonly kind: 'wrapped'
  readonly sourceLines: number
  readonly rows: number
  readonly prefixes: Uint32Array
  readonly width: number
  readonly tabs: { readonly offsets: Uint32Array; readonly ends: Uint32Array } | null
}

export type ProjectionEntry =
  | WrappedEntry
  | {
      readonly kind: 'run'
      readonly sourceLines: number
      readonly rows: number
      readonly hidden: boolean
    }
  | {
      readonly kind: 'line'
      readonly sourceLines: 1
      readonly rows: number
      readonly inline: InlineSummary | null
      readonly wrap: WrapSummary
      readonly before: readonly InjectedSummary[]
      readonly after: readonly InjectedSummary[]
    }

export type ProjectionCounters = {
  sourceBytesRead: number
  materializedRows: number
  materializedTextBytes: number
  indexEntriesTouched: number
  summaryLinesMeasured: number
}
