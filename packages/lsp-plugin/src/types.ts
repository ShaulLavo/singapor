import type { EditorPlugin } from '@singapor/core/extensions'
import type { LspWebSocketTransportOptions } from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

export type LanguageServerStatus = 'idle' | 'loading' | 'ready' | 'error'

export type LanguageServerDiagnosticCounts = {
  readonly error: number
  readonly warning: number
  readonly information: number
  readonly hint: number
  readonly total: number
}

export type LanguageServerDiagnosticSummary = {
  readonly uri: lsp.DocumentUri | null
  readonly version: number | null
  readonly diagnostics: readonly lsp.Diagnostic[]
  readonly counts: LanguageServerDiagnosticCounts
}

export type LanguageServerDefinitionTarget = {
  readonly uri: lsp.DocumentUri
  readonly path: string
  readonly range: lsp.Range
}

export type LanguageServerNavigationKind =
  | 'definition'
  | 'references'
  | 'implementation'
  | 'typeDefinition'

export type LanguageServerNavigationOpenMode = 'default' | 'peek' | 'aside'

export type LanguageServerNavigationOptions = {
  readonly kind: LanguageServerNavigationKind
  readonly openMode: LanguageServerNavigationOpenMode
}

export type LanguageServerReferencesResult = {
  readonly uri: lsp.DocumentUri
  readonly targets: readonly LanguageServerDefinitionTarget[]
}

export type LanguageServerPluginOptions = {
  readonly rootUri?: lsp.DocumentUri | null
  readonly hoverMarkdownCodeBackground?: boolean
  readonly initializationOptions?: unknown
  readonly timeoutMs?: number
  readonly webSocketRoute: string | URL
  readonly webSocketTransportOptions?: LspWebSocketTransportOptions
  readonly onStatusChange?: (status: LanguageServerStatus) => void
  readonly onDiagnostics?: (summary: LanguageServerDiagnosticSummary) => void
  readonly onInteractiveReady?: () => void
  readonly onOpenDefinition?: (
    target: LanguageServerDefinitionTarget,
    options?: LanguageServerNavigationOptions,
  ) => void | boolean
  readonly onOpenReferences?: (result: LanguageServerReferencesResult) => void | boolean
  readonly onError?: (error: unknown) => void
}

export type LanguageServerPlugin = EditorPlugin
