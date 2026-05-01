export { createTypeScriptLspPlugin, type TypeScriptLspResolvedOptions } from "./plugin";
export {
  diagnosticHighlightGroups,
  summarizeDiagnostics,
  type TypeScriptLspDiagnosticHighlightGroups,
  type TypeScriptLspDiagnosticSeverity,
} from "./diagnostics";
export {
  documentUriToFileName,
  fileNameToDocumentUri,
  isTypeScriptFileName,
  pathOrUriToDocumentUri,
  sourcePathToFileName,
} from "./paths";
export type {
  TypeScriptLspDiagnosticCounts,
  TypeScriptLspDefinitionTarget,
  TypeScriptLspDiagnosticSummary,
  TypeScriptLspPlugin,
  TypeScriptLspPluginOptions,
  TypeScriptLspSourceFile,
  TypeScriptLspStatus,
} from "./types";
