import type { DocumentSessionChange, TextEdit } from '@singapor/core/document'
import {
  lspPositionToOffset,
  lspPositionToOffsetInSnapshot,
  offsetToLspPosition,
  offsetToLspPositionInSnapshot,
  type LspTextDocumentSnapshot,
} from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

/**
 * Snapshot of a document transition used to project previously-computed
 * diagnostics onto the new text. Carries the pre- and post-edit text so
 * LSP ranges (which are computed against the previous text) can be
 * translated into offsets valid for the new text.
 */
export type DocumentSession = {
  readonly previousText: string
  readonly nextText: string
  readonly change: DocumentSessionChange | null
}

export type SnapshotDocumentSession = {
  readonly previousDocument: LspTextDocumentSnapshot
  readonly nextDocument: LspTextDocumentSnapshot
  readonly change: DocumentSessionChange | null
}

/**
 * A diagnostic whose range has been projected onto the post-edit text.
 * Structurally identical to {@link lsp.Diagnostic}; the alias exists to
 * document intent at call sites that consume already-projected results.
 */
export type ProjectedDiagnostic = lsp.Diagnostic

type OffsetRange = {
  readonly start: number
  readonly end: number
}

/**
 * Project a set of diagnostics through a document edit.
 *
 * When `diagnostics` is empty, returns the same array reference so callers
 * can cheaply detect no-op transitions by reference equality. When the
 * change carries no edits, returns a fresh empty array (any existing
 * diagnostic is implicitly dropped because no mapping is known).
 * Otherwise each diagnostic's range is mapped through the edit list; any
 * diagnostic that becomes a zero-width range when it was non-empty in the
 * previous text is dropped.
 */
export function projectDiagnostics(
  diagnostics: readonly lsp.Diagnostic[],
  documentSession: DocumentSession,
): readonly ProjectedDiagnostic[] {
  return projectDiagnosticsThroughChange(
    documentSession.previousText,
    documentSession.nextText,
    diagnostics,
    documentSession.change,
  )
}

export function projectDiagnosticsInSnapshot(
  diagnostics: readonly lsp.Diagnostic[],
  documentSession: SnapshotDocumentSession,
): readonly ProjectedDiagnostic[] {
  return projectDiagnosticsThroughSnapshotChange(
    documentSession.previousDocument,
    documentSession.nextDocument,
    diagnostics,
    documentSession.change,
  )
}

/**
 * Extract the text edits from a document session change, or an empty
 * array when no change was applied. Exported because `plugin.ts` also
 * hands these edits to `LspWorkspace.updateDocument` to keep the LSP
 * workspace in sync.
 */
export function editsForChange(change: DocumentSessionChange | null): readonly TextEdit[] {
  if (!change) return []
  return change.edits
}

/**
 * Filter `diagnostics` down to those whose range contains `offset` in
 * `text`. Zero-width diagnostics match only their exact start offset.
 */
export function diagnosticsAtOffset(
  text: string,
  offset: number,
  diagnostics: readonly lsp.Diagnostic[],
): readonly lsp.Diagnostic[] {
  return diagnostics.filter((diagnostic) => diagnosticContainsOffset(text, diagnostic, offset))
}

function projectDiagnosticsThroughChange(
  previousText: string,
  nextText: string,
  diagnostics: readonly lsp.Diagnostic[],
  change: DocumentSessionChange | null,
): readonly lsp.Diagnostic[] {
  if (diagnostics.length === 0) return diagnostics

  const edits = editsForChange(change)
  if (edits.length === 0) return []

  const projected: lsp.Diagnostic[] = []
  for (const diagnostic of diagnostics) {
    const next = projectDiagnosticThroughEdits(previousText, nextText, diagnostic, edits)
    if (next) projected.push(next)
  }

  return projected
}

function projectDiagnosticsThroughSnapshotChange(
  previousDocument: LspTextDocumentSnapshot,
  nextDocument: LspTextDocumentSnapshot,
  diagnostics: readonly lsp.Diagnostic[],
  change: DocumentSessionChange | null,
): readonly lsp.Diagnostic[] {
  if (diagnostics.length === 0) return diagnostics

  const edits = editsForChange(change)
  if (edits.length === 0) return []

  const projected: lsp.Diagnostic[] = []
  for (const diagnostic of diagnostics) {
    const next = projectDiagnosticThroughSnapshotEdits(
      previousDocument,
      nextDocument,
      diagnostic,
      edits,
    )
    if (next) projected.push(next)
  }

  return projected
}

function projectDiagnosticThroughEdits(
  previousText: string,
  nextText: string,
  diagnostic: lsp.Diagnostic,
  edits: readonly TextEdit[],
): lsp.Diagnostic | null {
  const start = lspPositionToOffset(previousText, diagnostic.range.start)
  const end = lspPositionToOffset(previousText, diagnostic.range.end)
  const range = projectOffsetRangeThroughEdits({ start, end }, edits)
  if (!range) return null
  if (range.start === range.end && start !== end) return null

  return {
    ...diagnostic,
    range: {
      start: offsetToLspPosition(nextText, range.start),
      end: offsetToLspPosition(nextText, range.end),
    },
  }
}

function projectDiagnosticThroughSnapshotEdits(
  previousDocument: LspTextDocumentSnapshot,
  nextDocument: LspTextDocumentSnapshot,
  diagnostic: lsp.Diagnostic,
  edits: readonly TextEdit[],
): lsp.Diagnostic | null {
  const start = lspPositionToOffsetInSnapshot(previousDocument, diagnostic.range.start)
  const end = lspPositionToOffsetInSnapshot(previousDocument, diagnostic.range.end)
  const range = projectOffsetRangeThroughEdits({ start, end }, edits)
  if (!range) return null
  if (range.start === range.end && start !== end) return null

  return {
    ...diagnostic,
    range: {
      start: offsetToLspPositionInSnapshot(nextDocument, range.start),
      end: offsetToLspPositionInSnapshot(nextDocument, range.end),
    },
  }
}

function projectOffsetRangeThroughEdits(
  range: OffsetRange,
  edits: readonly TextEdit[],
): OffsetRange | null {
  let projected: OffsetRange | null = range
  let delta = 0
  const sorted = edits.toSorted((left, right) => left.from - right.from || left.to - right.to)

  for (const edit of sorted) {
    if (!projected) return null

    const adjusted = {
      from: edit.from + delta,
      to: edit.to + delta,
      text: edit.text,
    }
    projected = projectOffsetRangeThroughEdit(projected, adjusted)
    delta += edit.text.length - (edit.to - edit.from)
  }

  return projected
}

function projectOffsetRangeThroughEdit(range: OffsetRange, edit: TextEdit): OffsetRange | null {
  const start = projectOffsetThroughEdit(range.start, edit, 'after')
  const end = projectOffsetThroughEdit(range.end, edit, 'before')
  if (start === null || end === null) return null
  if (end < start) return null

  return { start, end }
}

function projectOffsetThroughEdit(
  offset: number,
  edit: TextEdit,
  insertionBias: 'before' | 'after',
): number | null {
  if (edit.from === edit.to) return projectOffsetThroughInsertion(offset, edit, insertionBias)
  if (offset < edit.from) return offset
  if (offset > edit.to) return offset + edit.text.length - (edit.to - edit.from)
  if (offset === edit.to) return edit.from + edit.text.length
  if (offset === edit.from) return edit.from
  return null
}

function projectOffsetThroughInsertion(
  offset: number,
  edit: TextEdit,
  insertionBias: 'before' | 'after',
): number {
  if (offset < edit.from) return offset
  if (offset > edit.from) return offset + edit.text.length
  if (insertionBias === 'after') return offset + edit.text.length
  return offset
}

function diagnosticContainsOffset(
  text: string,
  diagnostic: lsp.Diagnostic,
  offset: number,
): boolean {
  const start = lspPositionToOffset(text, diagnostic.range.start)
  const end = lspPositionToOffset(text, diagnostic.range.end)
  if (end > start) return offset >= start && offset <= end
  return offset === start
}
