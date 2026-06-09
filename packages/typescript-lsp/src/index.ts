export { type TypeScriptLspResolvedOptions } from './plugin'
export { createTypeScriptLspPlugin } from './pluginWithWorker'
export {
  TypeScriptLspWorkerOwner,
  createTypeScriptLspWorkerOwner,
  type TypeScriptLspWorkerLifecycleState,
  type TypeScriptLspWorkerOwnerOptions,
  type TypeScriptLspWorkerOwnerSnapshot,
} from './workerOwner'
export {
  diagnosticHighlightGroups,
  summarizeDiagnostics,
  type LanguageServerDiagnosticHighlightGroups as TypeScriptLspDiagnosticHighlightGroups,
  type LanguageServerDiagnosticSeverity as TypeScriptLspDiagnosticSeverity,
} from '@singapor/lsp-plugin/diagnostics'
export {
  documentUriToFileName,
  fileNameToDocumentUri,
  isTypeScriptFileName,
  isTypeScriptLspSourceFileName,
  pathOrUriToDocumentUri,
  sourcePathToFileName,
} from './paths'
export type {
  TypeScriptLspDiagnosticCounts,
  TypeScriptLspDefinitionTarget,
  TypeScriptLspDiagnosticSummary,
  TypeScriptLspNavigationKind,
  TypeScriptLspNavigationOpenMode,
  TypeScriptLspNavigationOptions,
  TypeScriptLspPlugin,
  TypeScriptLspPluginOptions,
  TypeScriptLspReferencesResult,
  TypeScriptLspSourceFile,
  TypeScriptLspStatus,
} from './types'
