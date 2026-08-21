import type { EditorDisposable } from '@singapor/core/extensions'
import { createEditorCapabilityToken } from '@singapor/core/extensions'
import type { LspClient, LspWebSocketTransportOptions, LspWorkerLike } from '@singapor/lsp'
import {
  createLanguageServerAdapterPlugin,
  createWebSocketLspTransportFactory,
  createWorkerLspTransportFactory,
  type LanguageServerConnectionContext,
  type LspConnectionTransportFactory,
} from '@singapor/lsp-plugin'
import type { LanguageServerCompletionEditFeature } from '@singapor/lsp-plugin/completion'

import { isTypeScriptLspSourceFileName } from './paths'
import type {
  TypeScriptLspPlugin,
  TypeScriptLspPluginOptions,
  TypeScriptLspSourceFile,
} from './types'

const DEFAULT_DIAGNOSTIC_DELAY_MS = 150
const DEFAULT_TIMEOUT_MS = 15000
const TYPESCRIPT_LSP_COMPLETION_EDIT_FEATURE_ID = 'editor.typescript-lsp.completion-edit'
const TYPESCRIPT_LSP_COMPLETION_EDIT_FEATURE =
  createEditorCapabilityToken<LanguageServerCompletionEditFeature>(
    TYPESCRIPT_LSP_COMPLETION_EDIT_FEATURE_ID,
  )

export type TypeScriptLspResolvedOptions = {
  readonly rootUri: string | null
  readonly compilerOptions: TypeScriptLspPluginOptions['compilerOptions']
  readonly diagnosticDelayMs: number
  readonly hoverMarkdownCodeBackground: boolean
  readonly timeoutMs: number
  readonly capabilities: TypeScriptLspPluginOptions['capabilities']
  readonly clientInfo: TypeScriptLspPluginOptions['clientInfo']
  readonly semanticTokens: TypeScriptLspPluginOptions['semanticTokens']
  readonly onConnectionCreated: TypeScriptLspPluginOptions['onConnectionCreated']
  readonly workerFactory?: () => LspWorkerLike
  readonly webSocketRoute?: string | URL
  readonly webSocketTransportOptions?: LspWebSocketTransportOptions
  readonly onStatusChange: TypeScriptLspPluginOptions['onStatusChange']
  readonly onDiagnostics: TypeScriptLspPluginOptions['onDiagnostics']
  readonly onOpenDefinition: TypeScriptLspPluginOptions['onOpenDefinition']
  readonly onOpenReferences: TypeScriptLspPluginOptions['onOpenReferences']
  readonly onError: TypeScriptLspPluginOptions['onError']
}

export function createTypeScriptLspPlugin(
  options: TypeScriptLspPluginOptions = {},
): TypeScriptLspPlugin {
  const resolved = resolveOptions(options)
  const workspaceFiles = new TypeScriptWorkspaceFiles()
  const plugin = createLanguageServerAdapterPlugin({
    name: 'editor.typescript-lsp',
    rootUri: resolved.rootUri,
    hoverMarkdownCodeBackground: resolved.hoverMarkdownCodeBackground,
    initializationOptions: typeScriptInitializationOptions(resolved),
    timeoutMs: resolved.timeoutMs,
    capabilities: resolved.capabilities,
    clientInfo: resolved.clientInfo,
    semanticTokens: resolved.semanticTokens,
    createTransport: typeScriptTransportFactory(resolved),
    defaultHighlightPrefix: 'editor-typescript-lsp',
    documentSync: {
      shouldSyncLanguageId: isTypeScriptLspLanguage,
      shouldSyncUri: isTypeScriptLspSourceFileName,
    },
    diagnostics: {
      minimapSourceId: 'editor.typescript-lsp.diagnostics',
      highlightNameNamespace: 'typescript-lsp',
      markerTimingNamePrefix: 'typescriptLsp.marker',
    },
    completion: {
      editFeature: TYPESCRIPT_LSP_COMPLETION_EDIT_FEATURE,
      acceptTimingName: 'typescriptLsp.completion.accept',
      widgetClassNamespace: 'typescript-lsp',
      // The worker sends TypeScript's own per-item sets, so the sets this turns on are the ones the
      // language service vouches for rather than a guess made in the editor.
      acceptOnCommitCharacter: true,
    },
    hoverDefinition: {
      linkHighlightNameNamespace: 'typescript-lsp',
      tooltipClassNamespace: 'typescript-lsp',
      navigationTimingNamePrefix: 'typescriptLsp',
    },
    onConnectionCreated: (context) =>
      registerTypeScriptConnection(context, workspaceFiles, resolved),
    onConnected: (context) => workspaceFiles.syncClient(context.client),
    onStatusChange: resolved.onStatusChange,
    onDiagnostics: resolved.onDiagnostics,
    onOpenDefinition: resolved.onOpenDefinition,
    onOpenReferences: resolved.onOpenReferences,
    onError: resolved.onError,
  })

  return {
    ...plugin,
    setWorkspaceFiles: (files) => workspaceFiles.setWorkspaceFiles(files),
    clearWorkspaceFiles: () => workspaceFiles.clearWorkspaceFiles(),
  }
}

class TypeScriptWorkspaceFiles {
  private readonly clients = new Map<LspClient, (error: unknown) => void>()
  private files: readonly TypeScriptLspSourceFile[] = []

  public setWorkspaceFiles(files: readonly TypeScriptLspSourceFile[]): void {
    this.files = files.map((file) => ({ path: file.path, text: file.text }))
    this.syncClients()
  }

  public clearWorkspaceFiles(): void {
    this.files = []
    this.syncClients()
  }

  public registerClient(
    client: LspClient,
    onError: ((error: unknown) => void) | undefined,
  ): EditorDisposable {
    this.clients.set(client, onError ?? ignoreConnectionError)
    return {
      dispose: () => {
        this.clients.delete(client)
      },
    }
  }

  public syncClient(client: LspClient): void {
    const onError = this.clients.get(client)
    if (!onError) return
    if (!client.initialized) return

    void client
      .notify('editor/typescript/setWorkspaceFiles', { files: this.files })
      .catch((error: unknown) => onError(error))
  }

  private syncClients(): void {
    for (const client of this.clients.keys()) this.syncClient(client)
  }
}

// The host's callback runs alongside the workspace-file registration rather than instead of it: the
// handle it is being given is the only way to reach the `LspClient`, and taking the workspace sync
// away as the price of holding it would be a trade nobody asked for.
function registerTypeScriptConnection(
  context: LanguageServerConnectionContext,
  workspaceFiles: TypeScriptWorkspaceFiles,
  options: TypeScriptLspResolvedOptions,
): EditorDisposable {
  const registration = workspaceFiles.registerClient(context.client, options.onError)
  const hostRegistration = options.onConnectionCreated?.(context) ?? null

  return {
    dispose: () => {
      hostRegistration?.dispose()
      registration.dispose()
    },
  }
}

function typeScriptTransportFactory(
  options: TypeScriptLspResolvedOptions,
): LspConnectionTransportFactory {
  if (options.webSocketRoute) {
    return createWebSocketLspTransportFactory(
      options.webSocketRoute,
      options.webSocketTransportOptions,
    )
  }
  if (options.workerFactory) return createWorkerLspTransportFactory(options.workerFactory)

  return missingWorkerTransportFactory
}

function missingWorkerTransportFactory(): never {
  throw new Error('TypeScript LSP worker factory was not configured')
}

function typeScriptInitializationOptions(options: TypeScriptLspResolvedOptions): unknown {
  return {
    compilerOptions: options.compilerOptions,
    diagnosticDelayMs: options.diagnosticDelayMs,
  }
}

function resolveOptions(options: TypeScriptLspPluginOptions): TypeScriptLspResolvedOptions {
  return {
    rootUri: options.rootUri ?? 'file:///',
    compilerOptions: options.compilerOptions,
    diagnosticDelayMs: options.diagnosticDelayMs ?? DEFAULT_DIAGNOSTIC_DELAY_MS,
    hoverMarkdownCodeBackground: options.hoverMarkdownCodeBackground ?? false,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    capabilities: options.capabilities,
    clientInfo: options.clientInfo,
    semanticTokens: options.semanticTokens,
    onConnectionCreated: options.onConnectionCreated,
    workerFactory: options.workerFactory,
    webSocketRoute: options.webSocketRoute,
    webSocketTransportOptions: options.webSocketTransportOptions,
    onStatusChange: options.onStatusChange,
    onDiagnostics: options.onDiagnostics,
    onOpenDefinition: options.onOpenDefinition,
    onOpenReferences: options.onOpenReferences,
    onError: options.onError,
  }
}

function isTypeScriptLspLanguage(languageId: string): boolean {
  return (
    languageId === 'javascript' ||
    languageId === 'javascriptreact' ||
    languageId === 'typescript' ||
    languageId === 'typescriptreact'
  )
}

function ignoreConnectionError(): void {
  return undefined
}
