import type { EditorPlugin } from '@singapor/core/extensions'
import type { LspWebSocketTransportOptions, LspWorkerLike } from '@singapor/lsp'
import type {
  LanguageServerDefinitionTarget,
  LanguageServerDiagnosticCounts,
  LanguageServerDiagnosticSummary,
  LanguageServerNavigationKind,
  LanguageServerNavigationOpenMode,
  LanguageServerNavigationOptions,
  LanguageServerReferencesResult,
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
  readonly onError?: (error: unknown) => void
}

export type TypeScriptLspPlugin = EditorPlugin & {
  setWorkspaceFiles(files: readonly TypeScriptLspSourceFile[]): void
  clearWorkspaceFiles(): void
}
