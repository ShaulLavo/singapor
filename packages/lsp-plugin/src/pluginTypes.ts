import type { TextSnapshot } from '@singapor/core/document'
import type {
  LspLineStarts, LspWebSocketTransportOptions } from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

import type {
  LanguageServerDefinitionTarget,
  LanguageServerDiagnosticSummary,
  LanguageServerNavigationKind,
  LanguageServerNavigationOpenMode,
  LanguageServerNavigationOptions,
  LanguageServerReferencesResult,
  LanguageServerStatus,
} from './types'

export type LanguageServerResolvedOptions = {
  readonly rootUri: lsp.DocumentUri | null
  readonly hoverMarkdownCodeBackground: boolean
  readonly initializationOptions: unknown
  readonly timeoutMs: number
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

export type LanguageServerNavigationCommand = {
  readonly kind: LanguageServerNavigationKind
  readonly openMode: LanguageServerNavigationOpenMode
  readonly includeDeclaration?: boolean
}

export type DiagnosticMarkerDirection = 'next' | 'previous'

export type ActiveDocument = {
  readonly uri: lsp.DocumentUri
  readonly languageId: string
  readonly textSnapshot: TextSnapshot
  readonly lineStarts: LspLineStarts
  readonly fullText: string
  readonly textVersion: number
  readonly lspVersion: number
}

export type DocumentDescriptor = {
  readonly uri: lsp.DocumentUri
  readonly languageId: string
  readonly textSnapshot: TextSnapshot
  readonly lineStarts: LspLineStarts
  readonly fullText: string
  readonly textVersion: number
}
