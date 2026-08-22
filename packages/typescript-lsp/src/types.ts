import type { EditorDisposable, EditorPlugin } from '@singapor/core/extensions'
import type { LspWebSocketTransportOptions, LspWorkerLike } from '@singapor/lsp'
import type {
  LanguageServerConnectionContext,
  LanguageServerDefinitionTarget,
  LanguageServerDiagnosticCounts,
  LanguageServerDiagnosticSummary,
  LanguageServerNavigationKind,
  LanguageServerNavigationOpenMode,
  LanguageServerNavigationOptions,
  LanguageServerReferencesResult,
  LanguageServerSemanticTokensOptions,
  LanguageServerStatus,
} from '@singapor/lsp-plugin'
import type ts from 'typescript'
import type * as lsp from 'vscode-languageserver-protocol'

export type TypeScriptLspSourceFile = {
  readonly path: string
  readonly text: string
}

export type TypeScriptLspStatus = LanguageServerStatus

export type TypeScriptLspDiagnosticCounts = LanguageServerDiagnosticCounts

export type TypeScriptLspDiagnosticSummary = LanguageServerDiagnosticSummary

export type TypeScriptLspDefinitionTarget = LanguageServerDefinitionTarget

export type TypeScriptLspNavigationKind = LanguageServerNavigationKind

export type TypeScriptLspNavigationOpenMode = LanguageServerNavigationOpenMode

export type TypeScriptLspNavigationOptions = LanguageServerNavigationOptions

export type TypeScriptLspReferencesResult = LanguageServerReferencesResult

export type TypeScriptLspPluginOptions = {
  readonly rootUri?: lsp.DocumentUri | null
  readonly compilerOptions?: ts.CompilerOptions
  readonly diagnosticDelayMs?: number
  readonly hoverMarkdownCodeBackground?: boolean
  readonly timeoutMs?: number
  /**
   * Merged over `defaultClientCapabilities()`. Build a semantic-tokens block with
   * `semanticTokensClientCapability()` from `@singapor/lsp` rather than by hand — the worker
   * advertises `semanticTokensProvider`, but a server only answers a client that asked.
   */
  readonly capabilities?: lsp.ClientCapabilities
  readonly clientInfo?: lsp.InitializeParams['clientInfo']
  /**
   * Turns on the semantic token layer and is how a host gets hold of one. Supplying nothing creates
   * no layer and fires no demand signal, so an app that paints no semantic colour pays nothing.
   */
  readonly semanticTokens?: LanguageServerSemanticTokensOptions
  /**
   * Hands the host the connection the moment it exists, which is the only way to reach the
   * `LspClient` — and therefore to issue a token request, cancel one, or override its timeout. Runs
   * alongside this plugin's own registration rather than replacing it.
   */
  onConnectionCreated?(context: LanguageServerConnectionContext): EditorDisposable | void
  readonly workerFactory?: () => LspWorkerLike
  readonly webSocketRoute?: string | URL
  readonly webSocketTransportOptions?: LspWebSocketTransportOptions
  readonly onStatusChange?: (status: TypeScriptLspStatus) => void
  readonly onDiagnostics?: (summary: TypeScriptLspDiagnosticSummary) => void
  readonly onOpenDefinition?: (
    target: TypeScriptLspDefinitionTarget,
    options?: TypeScriptLspNavigationOptions,
  ) => void | boolean
  readonly onOpenReferences?: (result: TypeScriptLspReferencesResult) => void | boolean
  readonly onRequestError?: (method: string, error: unknown) => void
  readonly onError?: (error: unknown) => void
}

export type TypeScriptLspPlugin = EditorPlugin & {
  setWorkspaceFiles(files: readonly TypeScriptLspSourceFile[]): void
  clearWorkspaceFiles(): void
}
