import type { DocumentLogicalRevisionScope } from '@singapor/core/document'
import type {
  EditorDisposable,
  EditorPlugin,
  EditorTextAnchor,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import type { LspClient, LspNotificationHandler, LspWebSocketTransportOptions } from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

import type { LanguageServerConnectionContext } from './connectionContext'
import type { LanguageServerDocumentSyncController } from './documentSyncController'
import type { LspConnectionProvider } from './lspConnection'
import type { ParsedWorkspaceEdit } from './workspaceEdit'
import type { WorkspaceTextDocumentProvenance } from './workspaceTextEdits'
export type { LanguageServerConnectionContext } from './connectionContext'
import type {
  LanguageServerSemanticTokensFactory,
  LanguageServerSemanticTokensOptions,
} from './semanticTokens'

export type LanguageServerStatus = 'idle' | 'loading' | 'ready' | 'error'

export const LANGUAGE_SERVER_FEATURE_IDS = [
  'completion',
  'hover',
  'navigation',
  'signatureHelp',
  'diagnostics',
  'codeActions',
  'formatting',
  'rename',
  'documentHighlights',
  'semanticTokens',
] as const

export type LanguageServerFeatureId = (typeof LANGUAGE_SERVER_FEATURE_IDS)[number]

export type LanguageServerFeatureRanks = Partial<Readonly<Record<LanguageServerFeatureId, number>>>

export type LanguageServerReadyNotification = {
  readonly method: string
  readonly params: unknown
}

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

export type LanguageServerDiagnosticMarkerEvent = {
  readonly direction: 'next' | 'previous'
  readonly diagnostic: lsp.Diagnostic
  readonly documentUri: lsp.DocumentUri
  readonly textVersion: number
  readonly anchor: EditorTextAnchor
}

export type LanguageServerDiagnosticMarkerClaim =
  | { readonly kind: 'claimed'; dispose(): void }
  | { readonly kind: 'ignored' }

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

export type LanguageServerDocumentSyncOptions = {
  /** Projects a live path transition before deferred view publication catches up. */
  readonly controller?: LanguageServerDocumentSyncController
  /**
   * The language id sent to the server when the editor and protocol use different names.
   * Returning undefined keeps the editor's id.
   */
  languageIdForDocument?(languageId: string, uri: lsp.DocumentUri): string | undefined
  shouldSyncLanguageId?(languageId: string, snapshot: EditorViewSnapshot): boolean
  shouldSyncUri?(uri: lsp.DocumentUri, snapshot: EditorViewSnapshot): boolean
}

export type { WorkspaceTextDocumentProvenance } from './workspaceTextEdits'

export type WorkspaceEditOriginGuard = {
  readonly documents: readonly WorkspaceTextDocumentProvenance[]
  isCurrent(uri: string): boolean
}

export type ApplyWorkspaceEditRequest = {
  readonly guard: WorkspaceEditOriginGuard
  readonly label: string
  readonly logicalRevisionScope: DocumentLogicalRevisionScope
  readonly originUri: string
  readonly originVersion: number
  readonly plan: ParsedWorkspaceEdit
  readonly serverId: string
  readonly signal: AbortSignal
  readonly source: 'code-action' | 'rename'
}

export type ApplyWorkspaceEditResult =
  | { readonly status: 'applied' }
  | { readonly status: 'cancelled' }
  | { readonly code: string; readonly message: string; readonly status: 'failed' }
  | { readonly code: string; readonly message: string; readonly status: 'rolled-back' }
  | {
      readonly affectedPaths: readonly string[]
      readonly code: string
      readonly message: string
      readonly status: 'recovery-required'
    }

export type OnApplyWorkspaceEdit = (
  request: ApplyWorkspaceEditRequest,
) => Promise<ApplyWorkspaceEditResult>

export type LanguageServerLaneHostOptions = {
  readonly onApplyWorkspaceEdit?: OnApplyWorkspaceEdit
}

export type LanguageServerRenamePrompt = {
  readonly anchor: DOMRect
  readonly currentName: string
  readonly signal: AbortSignal
}

export type LanguageServerPluginOptions = LanguageServerLaneHostOptions & {
  readonly rootUri?: lsp.DocumentUri | null
  readonly hoverMarkdownCodeBackground?: boolean
  readonly initializationOptions?: unknown
  readonly timeoutMs?: number
  /**
   * Merged over `defaultClientCapabilities()`, so a host declares only what it adds. Build a
   * semantic-tokens block with `semanticTokensClientCapability()` from `@singapor/lsp` rather than
   * by hand: it refuses the flags this editor cannot honour, each of which a real server acts on.
   */
  readonly capabilities?: lsp.ClientCapabilities
  /** At least one real server branches on this. The value is the host's to pick. */
  readonly clientInfo?: lsp.InitializeParams['clientInfo']
  /**
   * Merged around the plugin's own handlers. An entry for `textDocument/publishDiagnostics` runs
   * after the plugin's and cannot displace it, because the diagnostics feature hangs off it.
   */
  readonly notificationHandlers?: Readonly<Record<string, LspNotificationHandler<LspClient>>>
  /** Which documents reach the server, and under what language id. */
  readonly documentSync?: LanguageServerDocumentSyncOptions
  readonly webSocketRoute: string | URL
  readonly webSocketTransportOptions?: LspWebSocketTransportOptions
  /**
   * Borrows the connection rather than owning one per view, so a file switch that rebuilds the view
   * does not also rebuild the websocket and re-run `initialize`. The route and options above still
   * describe the connection — the provider is handed them and builds from them the first time it
   * sees a key. See `LspConnectionProvider`.
   */
  readonly connectionProvider?: LspConnectionProvider
  /**
   * Turns on the semantic token layer, and is how the host gets hold of one: a layer needs a
   * viewport, a snapshot and a lifecycle, so the contribution creates it and hands it over through
   * `onLayer`. Supplying nothing creates no layer and fires no demand signal.
   */
  readonly semanticTokens?: LanguageServerSemanticTokensOptions
  /**
   * Hands the host the connection the moment it exists, which is the only way to reach the
   * `LspClient` — and therefore the only way to issue a request, override the timeout for one, or
   * cancel one. Returning a disposable ties the host's own controller to the connection's life.
   */
  onConnectionCreated?(context: LanguageServerConnectionContext): EditorDisposable | void
  /** The same context again, once `initialize` has come back and server capabilities are known. */
  onConnected?(context: LanguageServerConnectionContext): void
  readonly onStatusChange?: (status: LanguageServerStatus) => void
  readonly onDiagnostics?: (summary: LanguageServerDiagnosticSummary) => void
  readonly onDidNavigateDiagnostic?: (
    event: LanguageServerDiagnosticMarkerEvent,
  ) => LanguageServerDiagnosticMarkerClaim
  readonly onInteractiveReady?: () => void
  readonly onRequestError?: (serverId: string, method: string, error: unknown) => void
  readonly onOpenDefinition?: (
    target: LanguageServerDefinitionTarget,
    options?: LanguageServerNavigationOptions,
  ) => void | boolean
  readonly onOpenReferences?: (result: LanguageServerReferencesResult) => void | boolean
  readonly onError?: (error: unknown) => void
}

export type LanguageServerLaneOptions = LanguageServerLaneHostOptions & {
  readonly id: string
  readonly features: LanguageServerFeatureRanks
  readonly rootUri?: lsp.DocumentUri | null
  readonly initializationOptions?: unknown
  readonly timeoutMs?: number
  readonly capabilities?: lsp.ClientCapabilities
  readonly clientInfo?: lsp.InitializeParams['clientInfo']
  readonly notificationHandlers?: Readonly<Record<string, LspNotificationHandler<LspClient>>>
  readonly webSocketRoute: string | URL
  readonly webSocketTransportOptions?: LspWebSocketTransportOptions
  readonly connectionProvider?: LspConnectionProvider
  readonly readyNotifications?: readonly LanguageServerReadyNotification[]
  onConnectionCreated?(context: LanguageServerConnectionContext): EditorDisposable | void
  onConnected?(context: LanguageServerConnectionContext): void
  readonly onStatusChange?: (status: LanguageServerStatus) => void
  readonly onDiagnostics?: (summary: LanguageServerDiagnosticSummary) => void
  readonly onInteractiveReady?: () => void
  readonly onRequestError?: (method: string, error: unknown) => void
  readonly onError?: (error: unknown) => void
}

export type LanguageServerSetPluginOptions = Pick<
  LanguageServerPluginOptions,
  | 'hoverMarkdownCodeBackground'
  | 'documentSync'
  | 'onDiagnostics'
  | 'onDidNavigateDiagnostic'
  | 'onInteractiveReady'
  | 'onRequestError'
  | 'onOpenDefinition'
  | 'onOpenReferences'
  | 'onError'
  | 'onApplyWorkspaceEdit'
> & {
  readonly lanes: readonly LanguageServerLaneOptions[]
  readonly semanticTokens?: LanguageServerSemanticTokensFactory
}

export type LanguageServerPlugin = EditorPlugin
