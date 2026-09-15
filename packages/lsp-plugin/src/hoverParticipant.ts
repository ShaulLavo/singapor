import {
  lspPositionToOffsetInSnapshot,
  offsetToLspPositionInSnapshot,
  type LspRequestOptions,
} from '@singapore-editor/lsp'
import type { EditorHoverParticipant, HoverPart, HoverRequest } from '@singapore-editor/plugin-ui'
import type * as lsp from 'vscode-languageserver-protocol'

import { diagnosticNotes } from './diagnosticNotes'
import {
  diagnosticsAtOffset,
  indexDiagnosticOffsets,
  type DiagnosticOffsetIndex,
} from './diagnosticProjection'
import type { ActiveDocument } from './pluginTypes'
import type { LanguageServerFeatureRouter, LanguageServerHoverUpdate } from './serverSet'

/** Diagnostics sit under the server's prose, the way a marker hover does in VS Code. */
const HOVER_TEXT_ORDINAL = 1
const DIAGNOSTIC_ORDINAL = 2

export type LanguageServerHoverParticipantOptions = {
  readonly router: LanguageServerFeatureRouter
  requestHover(
    params: lsp.TextDocumentPositionParams,
    options: LspRequestOptions,
    onUpdate: (update: LanguageServerHoverUpdate) => void,
  ): Promise<lsp.Hover | null>
  getActiveDocument(): ActiveDocument | null
  getDiagnostics(): readonly lsp.Diagnostic[]
  onRequestSuccess?(): void
  onRequestError(error: unknown): void
}

/**
 * What the language server has to say at a position: its hover answer, progressively as each lane
 * replies, and the diagnostics published for that offset.
 */
export function createLanguageServerHoverParticipant(
  options: LanguageServerHoverParticipantOptions,
): EditorHoverParticipant {
  let diagnosticIndex: { index: DiagnosticOffsetIndex; textVersion: number } | null = null

  // Keyed on the published array and the text it was projected onto, so a pointer move pays for
  // the index only when either changes.
  const diagnosticIndexFor = (active: ActiveDocument): DiagnosticOffsetIndex => {
    const diagnostics = options.getDiagnostics()
    const cached = diagnosticIndex
    if (
      cached &&
      cached.index.diagnostics === diagnostics &&
      cached.textVersion === active.textVersion
    ) {
      return cached.index
    }

    const index = indexDiagnosticOffsets(active, diagnostics)
    diagnosticIndex = { index, textVersion: active.textVersion }
    return index
  }

  return {
    computeSync: (request) => {
      const active = options.getActiveDocument()
      if (!active) return []

      const diagnostics = diagnosticsAtOffset(diagnosticIndexFor(active), request.anchor.offset)
      if (diagnostics.length === 0) return []

      return [
        {
          ordinal: DIAGNOSTIC_ORDINAL,
          range: request.anchor.range,
          notes: diagnosticNotes(diagnostics),
        },
      ]
    },
    computeAsync: async (request, emit) => {
      const active = options.getActiveDocument()
      if (!active || !options.router.hasReady('hover', 'textDocument/hover')) return

      const publish = (hovers: readonly lsp.Hover[]): void =>
        emit(hovers.flatMap((hover) => hoverParts(active, request, hover)))
      try {
        const hover = await options.requestHover(
          {
            textDocument: { uri: active.uri },
            position: offsetToLspPositionInSnapshot(active, request.anchor.offset),
          },
          { signal: request.signal },
          (update) => publish(update.hovers),
        )
        if (request.signal.aborted) return
        options.onRequestSuccess?.()
        if (hover) publish([hover])
      } catch (error) {
        if (!isAbortError(error)) options.onRequestError(error)
      }
    },
  }
}

function hoverParts(
  active: ActiveDocument,
  request: HoverRequest,
  hover: lsp.Hover,
): readonly HoverPart[] {
  const markdown = hoverContentsText(hover.contents).trim()
  if (!markdown) return []

  return [
    {
      ordinal: HOVER_TEXT_ORDINAL,
      range: hoverRangeOffsets(active, hover) ?? request.anchor.range,
      markdown,
    },
  ]
}

function hoverContentsText(contents: lsp.Hover['contents']): string {
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) return contents.map(markedStringText).join('\n\n')
  if ('kind' in contents) return contents.value
  return markedStringText(contents)
}

function markedStringText(value: lsp.MarkedString): string {
  if (typeof value === 'string') return value
  return ['```' + value.language, value.value, '```'].join('\n')
}

function hoverRangeOffsets(
  active: ActiveDocument,
  hover: lsp.Hover,
): { readonly start: number; readonly end: number } | null {
  if (!hover.range) return null

  const start = lspPositionToOffsetInSnapshot(active, hover.range.start)
  const end = lspPositionToOffsetInSnapshot(active, hover.range.end)
  if (end > start) return { start, end }
  return null
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (typeof error !== 'object' || error === null) return false
  return 'name' in error && error.name === 'LspRequestCancelledError'
}
