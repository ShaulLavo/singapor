import type { DocumentSessionChange } from '@singapor/core/document'
import type {
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import { createStringTextSnapshot } from '@singapor/core/document'
import { defineLazyFullTextProperty } from '@singapor/core/internal'
import type { LspWorkspace } from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

import { editsForChange, projectDiagnosticsInSnapshot } from './diagnosticProjection'
import { pathOrUriToDocumentUri } from './paths'
import type { ActiveDocument, DocumentDescriptor } from './pluginTypes'

export type DocumentSyncDiagnosticsPresenter = {
  clear(): void
  render(text: string, diagnostics: readonly lsp.Diagnostic[]): void
  publishSummary(
    uri: lsp.DocumentUri,
    version: number | null,
    diagnostics: readonly lsp.Diagnostic[],
  ): void
}

export type DocumentSyncOptions = {
  onDocumentClosed(): void
  shouldSyncLanguageId?(languageId: string, snapshot: EditorViewSnapshot): boolean
  shouldSyncUri?(uri: lsp.DocumentUri, snapshot: EditorViewSnapshot): boolean
}

export class DocumentSync {
  private document: ActiveDocument | null = null
  private diagnosticItems: readonly lsp.Diagnostic[] = []

  public constructor(
    private readonly workspace: LspWorkspace,
    private readonly presenter: DocumentSyncDiagnosticsPresenter,
    private readonly options: DocumentSyncOptions,
  ) {}

  public get activeDocument(): ActiveDocument | null {
    return this.document
  }

  public get diagnostics(): readonly lsp.Diagnostic[] {
    return this.diagnosticItems
  }

  public shouldSync(kind: EditorViewContributionUpdateKind, snapshot: EditorViewSnapshot): boolean {
    if (kind === 'document' || kind === 'content' || kind === 'clear') return true
    if (!this.document) return false
    return this.document.textVersion !== snapshot.textVersion
  }

  public sync(snapshot: EditorViewSnapshot, change: DocumentSessionChange | null): void {
    const descriptor = documentDescriptor(snapshot, this.options)
    if (!descriptor) {
      this.close()
      return
    }

    this.openOrUpdateDocument(descriptor, change)
  }

  public close(): void {
    const active = this.document
    this.document = null
    this.diagnosticItems = []
    this.options.onDocumentClosed()
    if (!active) return

    this.presenter.clear()
    this.workspace.closeDocument(active.uri)
    this.presenter.publishSummary(active.uri, active.lspVersion, [])
  }

  public publishDiagnostics(params: unknown): void {
    const diagnostics = publishDiagnosticsParams(params)
    if (!diagnostics) return

    const active = this.document
    if (!active) return
    if (diagnostics.uri !== active.uri) return
    if (diagnostics.version !== null && diagnostics.version !== active.lspVersion) return

    this.diagnosticItems = diagnostics.diagnostics
    this.presenter.render(active.fullText, diagnostics.diagnostics)
    this.presenter.publishSummary(active.uri, diagnostics.version, diagnostics.diagnostics)
  }

  private openOrUpdateDocument(
    descriptor: DocumentDescriptor,
    change: DocumentSessionChange | null,
  ): void {
    const active = this.document
    if (!active || active.uri !== descriptor.uri || active.languageId !== descriptor.languageId) {
      this.openDocument(descriptor)
      return
    }

    if (active.textVersion === descriptor.textVersion) return
    this.updateDocument(descriptor, change)
  }

  private openDocument(descriptor: DocumentDescriptor): void {
    this.close()
    const document = this.workspace.openDocument({
      uri: descriptor.uri,
      languageId: descriptor.languageId,
      text: descriptor.fullText,
    })
    this.document = { ...descriptor, lspVersion: document.version }
  }

  private updateDocument(
    descriptor: DocumentDescriptor,
    change: DocumentSessionChange | null,
  ): void {
    const active = this.document
    const diagnostics = projectDiagnosticsInSnapshot(this.diagnosticItems, {
      previousDocument: active ?? descriptor,
      nextDocument: descriptor,
      change,
    })
    const document = this.workspace.updateDocumentSnapshot(descriptor.uri, {
      textSnapshot: descriptor.textSnapshot,
      lineStarts: descriptor.lineStarts,
      edits: editsForChange(change),
    })
    this.document = { ...descriptor, lspVersion: document.version }
    if (diagnostics === this.diagnosticItems) return

    this.diagnosticItems = diagnostics
    this.presenter.render(descriptor.fullText, diagnostics)
  }
}

function documentDescriptor(
  snapshot: EditorViewSnapshot,
  options: DocumentSyncOptions,
): DocumentDescriptor | null {
  if (!snapshot.documentId) return null
  if (!snapshot.languageId) return null
  if (options.shouldSyncLanguageId?.(snapshot.languageId, snapshot) === false) return null

  const uri = pathOrUriToDocumentUri(snapshot.documentId)
  if (options.shouldSyncUri?.(uri, snapshot) === false) return null

  return defineLazyFullTextProperty({
    uri,
    languageId: snapshot.languageId,
    textSnapshot: snapshot.textSnapshot ?? createStringTextSnapshot(snapshot.fullText),
    lineStarts: snapshot.lineStarts,
    textVersion: snapshot.textVersion,
  })
}

function publishDiagnosticsParams(params: unknown): {
  readonly uri: lsp.DocumentUri
  readonly version: number | null
  readonly diagnostics: readonly lsp.Diagnostic[]
} | null {
  if (!isRecord(params)) return null
  if (typeof params.uri !== 'string') return null
  if (!Array.isArray(params.diagnostics)) return null

  return {
    uri: params.uri,
    version: typeof params.version === 'number' ? params.version : null,
    diagnostics: params.diagnostics as lsp.Diagnostic[],
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
