export {
  clientSupportsDidSave,
  defaultClientCapabilities,
  documentSyncModeFromCapabilities,
  documentSyncOptionsFromCapabilities,
  mergeClientCapabilities,
} from './capabilities'
export {
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES,
  semanticTokensClientCapability,
  type SemanticTokensClientCapabilityOptions,
  type SemanticTokenFormat,
  type SemanticTokensRequestOptions,
} from './semanticTokens'
export {
  LspClient,
  type LspClientConfig,
  type LspClientState,
  type RequestOptions as LspRequestOptions,
} from './client'
export {
  createLspContentChanges,
  createLspContentChangesInSnapshot,
  lspPositionToOffset,
  lspPositionToOffsetInSnapshot,
  offsetToLspPosition,
  offsetToLspPositionInSnapshot,
  textEditsToLspContentChanges,
  textEditsToLspContentChangesInSnapshot,
  textEditToLspContentChange,
  textEditToLspContentChangeInSnapshot,
  type LspContentChangeOptions,
} from './positions'
export {
  LspRequestCancelledError,
  LspResponseError,
  METHOD_NOT_FOUND,
  REQUEST_CANCELLED,
} from './protocol'
export {
  createWebSocketLspTransport,
  createWorkerLspTransport,
  type LspManagedTransport,
  type LspWebSocketConstructor,
  type LspWebSocketLike,
  type LspWebSocketTransportOptions,
  type LspWorkerLike,
  type LspWorkerMessageFormat,
  type LspWorkerTransportOptions,
} from './transports'
export type {
  LspLineStarts,
  LspDocument,
  LspDocumentChange,
  LspDocumentSaveSync,
  LspDocumentOpenOptions,
  LspDocumentSyncMode,
  LspDocumentSyncOptions,
  LspClientWorkspace,
  LspNotificationHandler,
  LspRequestHandle,
  LspServerRequestHandler,
  LspServerMessageHandler,
  LspServerMessageNotification,
  PublishDiagnosticsNotificationParams,
  LspTextDocumentSnapshot,
  LspTextEdit,
  LspTextSnapshot,
  LspTransport,
  LspTransportHandler,
  LspUnhandledNotificationHandler,
  LspWorkspaceSyncTarget,
  LspWorkspaceEditOptions,
  LspWorkspaceFactory,
  LspWorkspaceSnapshotEditOptions,
} from './types'
export { LspWorkspace, arrayLspLineStarts } from './workspace'
export type * as lsp from 'vscode-languageserver-protocol'
export { recordLspPerformanceDiagnostic } from './performanceDiagnostics'
