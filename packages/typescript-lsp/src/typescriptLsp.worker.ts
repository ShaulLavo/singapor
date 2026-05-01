import { lspPositionToOffset, offsetToLspPosition } from "@editor/lsp";
import {
  createDefaultMapFromCDN,
  createSystem,
  createVirtualTypeScriptEnvironment,
  type VirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import ts from "typescript";
import type * as lsp from "vscode-languageserver-protocol";
import {
  documentUriToFileName,
  fileNameToDocumentUri,
  isTypeScriptFileName,
  sourcePathToFileName,
} from "./paths";
import { tsDiagnosticToLspDiagnostic } from "./tsDiagnostics";
import type { TypeScriptLspSourceFile } from "./types";

const JSON_RPC_VERSION = "2.0";
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2;
const DEFAULT_DIAGNOSTIC_DELAY_MS = 150;

type WorkerDocument = {
  readonly uri: lsp.DocumentUri;
  readonly fileName: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
};

type TypeScriptServiceState = {
  readonly env: VirtualTypeScriptEnvironment;
};

type TypeScriptLspInitializationOptions = {
  readonly compilerOptions?: ts.CompilerOptions;
  readonly diagnosticDelayMs?: number;
};

type ProjectConfig = {
  readonly compilerOptions: ts.CompilerOptions;
  readonly fileNames: readonly string[];
};

type WorkspacePackage = {
  readonly name: string;
  readonly root: string;
};

type JsonRpcResponseError = {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
};

let compilerOptionsOverride: ts.CompilerOptions = {};
let diagnosticDelayMs = DEFAULT_DIAGNOSTIC_DELAY_MS;
let workspaceFiles = new Map<string, string>();
let servicePromise: Promise<TypeScriptServiceState> | null = null;
const documents = new Map<lsp.DocumentUri, WorkerDocument>();
const diagnosticTimers = new Map<lsp.DocumentUri, ReturnType<typeof setTimeout>>();

const workerGlobal = globalThis as unknown as DedicatedWorkerGlobalScope;
workerGlobal.onmessage = (event: MessageEvent<unknown>): void => {
  handleIncomingMessage(event.data);
};

function handleIncomingMessage(data: unknown): void {
  const message = parseIncomingMessage(data);
  if (!message) return;
  if (isRequestMessage(message)) {
    void handleRequest(message);
    return;
  }

  if (isNotificationMessage(message)) handleNotification(message);
}

async function handleRequest(message: lsp.RequestMessage): Promise<void> {
  try {
    const result = await requestResult(message);
    postResponse(message.id ?? null, result);
  } catch (error) {
    postResponseError(message.id ?? null, error);
  }
}

function handleNotification(message: lsp.NotificationMessage): void {
  try {
    routeNotification(message);
  } catch (error) {
    postLogMessage(error);
  }
}

async function requestResult(message: lsp.RequestMessage): Promise<unknown> {
  if (message.method === "initialize") return initializeResult(message.params);
  if (message.method === "shutdown") return shutdownResult();
  if (message.method === "textDocument/hover") return hoverResult(message.params);
  if (message.method === "textDocument/definition") return definitionResult(message.params);
  throw rpcError(METHOD_NOT_FOUND, `Method not implemented: ${message.method}`);
}

function routeNotification(message: lsp.NotificationMessage): void {
  if (message.method === "initialized") return;
  if (message.method === "exit") return shutdownWorkerState();
  if (message.method === "textDocument/didOpen") return handleDidOpen(message.params);
  if (message.method === "textDocument/didChange") return handleDidChange(message.params);
  if (message.method === "textDocument/didClose") return handleDidClose(message.params);
  if (message.method === "editor/typescript/setWorkspaceFiles")
    return handleSetWorkspaceFiles(message.params);
}

function initializeResult(params: unknown): lsp.InitializeResult {
  const initializationOptions = readInitializationOptions(params);
  compilerOptionsOverride = initializationOptions.compilerOptions ?? {};
  diagnosticDelayMs = initializationOptions.diagnosticDelayMs ?? DEFAULT_DIAGNOSTIC_DELAY_MS;
  invalidateService();

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TEXT_DOCUMENT_SYNC_INCREMENTAL,
      },
      diagnosticProvider: {
        interFileDependencies: true,
        workspaceDiagnostics: false,
      },
      hoverProvider: true,
      definitionProvider: true,
    },
  } as lsp.InitializeResult;
}

function shutdownResult(): null {
  shutdownWorkerState();
  return null;
}

function shutdownWorkerState(): void {
  for (const timer of diagnosticTimers.values()) clearTimeout(timer);
  diagnosticTimers.clear();
  documents.clear();
  workspaceFiles.clear();
  invalidateService();
}

function handleDidOpen(params: unknown): void {
  const textDocument = textDocumentItemFromParams(params);
  if (!textDocument) return;

  const fileName = documentUriToFileName(textDocument.uri);
  if (!fileName) return;
  if (!isTypeScriptFileName(fileName)) return;

  const document = {
    uri: textDocument.uri,
    fileName,
    languageId: textDocument.languageId,
    version: textDocument.version,
    text: textDocument.text,
  };
  documents.set(document.uri, document);
  void syncOpenDocumentToService(document);
  scheduleDiagnostics(document.uri);
}

function handleDidChange(params: unknown): void {
  const change = didChangeParams(params);
  if (!change) return;

  const current = documents.get(change.uri);
  if (!current) return;

  const text = applyContentChanges(current.text, change.contentChanges);
  const document = {
    ...current,
    version: change.version,
    text,
  };
  documents.set(document.uri, document);
  void syncOpenDocumentToService(document);
  scheduleDiagnostics(document.uri);
}

function handleDidClose(params: unknown): void {
  const uri = didCloseUri(params);
  if (!uri) return;

  const document = documents.get(uri);
  documents.delete(uri);
  clearScheduledDiagnostics(uri);
  postDiagnostics(uri, document?.version ?? null, []);
  if (document) void syncClosedDocumentToService(document);
}

function handleSetWorkspaceFiles(params: unknown): void {
  workspaceFiles = workspaceFileMap(params);
  invalidateService();
  scheduleAllDiagnostics();
}

async function syncOpenDocumentToService(document: WorkerDocument): Promise<void> {
  if (!servicePromise) return;

  try {
    const state = await ensureService();
    upsertEnvironmentFile(state.env, document.fileName, document.text);
  } catch (error) {
    postLogMessage(error);
  }
}

async function syncClosedDocumentToService(document: WorkerDocument): Promise<void> {
  if (!servicePromise) return;

  try {
    const state = await ensureService();
    restoreOrDeleteEnvironmentFile(state.env, document.fileName);
  } catch (error) {
    postLogMessage(error);
  }
}

function scheduleAllDiagnostics(): void {
  for (const uri of documents.keys()) scheduleDiagnostics(uri);
}

function scheduleDiagnostics(uri: lsp.DocumentUri): void {
  clearScheduledDiagnostics(uri);
  const timer = setTimeout(() => {
    diagnosticTimers.delete(uri);
    void publishDiagnosticsForUri(uri);
  }, diagnosticDelayMs);
  diagnosticTimers.set(uri, timer);
}

function clearScheduledDiagnostics(uri: lsp.DocumentUri): void {
  const timer = diagnosticTimers.get(uri);
  if (!timer) return;

  clearTimeout(timer);
  diagnosticTimers.delete(uri);
}

async function publishDiagnosticsForUri(uri: lsp.DocumentUri): Promise<void> {
  const scheduledDocument = documents.get(uri);
  if (!scheduledDocument) return;

  try {
    const state = await ensureService();
    const currentDocument = documents.get(uri);
    if (!isCurrentDocument(scheduledDocument, currentDocument)) return;

    const diagnostics = collectDiagnostics(state.env, currentDocument.fileName);
    postDiagnostics(currentDocument.uri, currentDocument.version, diagnostics);
  } catch (error) {
    postLogMessage(error);
  }
}

async function hoverResult(params: unknown): Promise<lsp.Hover | null> {
  const request = textDocumentPositionParams(params);
  if (!request) return null;

  const document = documentForUri(request.uri);
  if (!document) return null;

  const state = await ensureService();
  const offset = lspPositionToOffset(document.text, request.position);
  const quickInfo = state.env.languageService.getQuickInfoAtPosition(document.fileName, offset);
  if (!quickInfo) return null;

  return hoverFromQuickInfo(document.text, quickInfo);
}

async function definitionResult(params: unknown): Promise<lsp.Location[]> {
  const request = textDocumentPositionParams(params);
  if (!request) return [];

  const document = documentForUri(request.uri);
  if (!document) return [];

  const state = await ensureService();
  const offset = lspPositionToOffset(document.text, request.position);
  const definitions = definitionInfosAtPosition(state.env, document.fileName, offset);
  return definitions.flatMap((definition) => locationFromDefinition(state.env, definition));
}

function ensureService(): Promise<TypeScriptServiceState> {
  if (servicePromise) return servicePromise;

  servicePromise = createService().catch((error: unknown) => {
    servicePromise = null;
    throw error;
  });
  return servicePromise;
}

async function createService(): Promise<TypeScriptServiceState> {
  const projectConfig = readProjectConfig();
  const compilerOptions = resolvedCompilerOptions(projectConfig);
  const fsMap = await createDefaultMapFromCDN(
    vfsLibraryCompilerOptions(compilerOptions),
    ts.version,
    false,
    ts,
  );
  addWorkspaceFiles(fsMap);
  addOpenDocuments(fsMap);
  const system = createSystem(fsMap);
  const rootFiles = rootFileNames(fsMap, projectConfig);
  const env = createVirtualTypeScriptEnvironment(system, rootFiles, ts, compilerOptions);
  return { env };
}

function addWorkspaceFiles(fsMap: Map<string, string>): void {
  for (const [fileName, text] of workspaceFiles) fsMap.set(fileName, text);
  addWorkspacePackageMirrors(fsMap);
}

function addOpenDocuments(fsMap: Map<string, string>): void {
  for (const document of documents.values()) fsMap.set(document.fileName, document.text);
}

function addWorkspacePackageMirrors(fsMap: Map<string, string>): void {
  const packages = workspacePackages();
  for (const workspacePackage of packages) addWorkspacePackageMirror(fsMap, workspacePackage);
}

function addWorkspacePackageMirror(
  fsMap: Map<string, string>,
  workspacePackage: WorkspacePackage,
): void {
  const rootPrefix = `${workspacePackage.root}/`;
  const nodeModuleRoot = `/node_modules/${workspacePackage.name}`;

  for (const [fileName, text] of workspaceFiles) {
    if (!isPackageFile(fileName, workspacePackage.root, rootPrefix)) continue;

    const relativePath = fileName.slice(rootPrefix.length);
    fsMap.set(`${nodeModuleRoot}/${relativePath}`, text);
  }
}

function isPackageFile(fileName: string, root: string, rootPrefix: string): boolean {
  return fileName === `${root}/package.json` || fileName.startsWith(rootPrefix);
}

function workspacePackages(): readonly WorkspacePackage[] {
  return [...workspaceFiles.entries()].flatMap(([fileName, text]) =>
    workspacePackageFromFile(fileName, text),
  );
}

function workspacePackageFromFile(fileName: string, text: string): readonly WorkspacePackage[] {
  if (!fileName.endsWith("/package.json")) return [];

  const name = packageJsonName(text);
  if (!name) return [];

  return [{ name, root: directoryName(fileName) }];
}

function packageJsonName(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

function rootFileNames(
  fsMap: ReadonlyMap<string, string>,
  projectConfig: ProjectConfig | null,
): string[] {
  const roots = new Set(projectConfig?.fileNames ?? [...fsMap.keys()].filter(isTypeScriptFileName));
  for (const document of documents.values()) roots.add(document.fileName);
  return [...roots].filter(isTypeScriptFileName);
}

function invalidateService(): void {
  servicePromise = null;
}

function upsertEnvironmentFile(
  env: VirtualTypeScriptEnvironment,
  fileName: string,
  text: string,
): void {
  if (env.getSourceFile(fileName)) {
    env.updateFile(fileName, text);
    return;
  }

  env.createFile(fileName, text);
}

function restoreOrDeleteEnvironmentFile(env: VirtualTypeScriptEnvironment, fileName: string): void {
  const workspaceText = workspaceFiles.get(fileName);
  if (workspaceText !== undefined) {
    upsertEnvironmentFile(env, fileName, workspaceText);
    return;
  }

  env.deleteFile(fileName);
}

function collectDiagnostics(
  env: VirtualTypeScriptEnvironment,
  fileName: string,
): readonly lsp.Diagnostic[] {
  const service = env.languageService;
  return [
    ...service.getSyntacticDiagnostics(fileName),
    ...service.getSemanticDiagnostics(fileName),
    ...service.getSuggestionDiagnostics(fileName),
  ].map(tsDiagnosticToLspDiagnostic);
}

function hoverFromQuickInfo(text: string, quickInfo: ts.QuickInfo): lsp.Hover {
  const display = ts.displayPartsToString(quickInfo.displayParts ?? []);
  const documentation = ts.displayPartsToString(quickInfo.documentation ?? []);
  const tags = quickInfo.tags?.map(tagText).filter((tag) => tag.length > 0) ?? [];
  const value = hoverMarkdown(display, documentation, tags);

  return {
    contents: {
      kind: "markdown",
      value,
    },
    range: rangeFromTextSpan(text, quickInfo.textSpan),
  };
}

function hoverMarkdown(
  display: string,
  documentation: string,
  tags: readonly string[],
): string {
  const sections: string[] = [];
  if (display) sections.push(["```ts", display, "```"].join("\n"));
  if (documentation) sections.push(documentation);
  if (tags.length > 0) sections.push(tags.join("\n"));
  return sections.join("\n\n");
}

function tagText(tag: ts.JSDocTagInfo): string {
  const text = ts.displayPartsToString(tag.text ?? []);
  if (!text) return `@${tag.name}`;
  return `@${tag.name} ${text}`;
}

function definitionInfosAtPosition(
  env: VirtualTypeScriptEnvironment,
  fileName: string,
  offset: number,
): readonly ts.DefinitionInfo[] {
  const service = env.languageService;
  const withSpan = service.getDefinitionAndBoundSpan(fileName, offset);
  if (withSpan?.definitions) return withSpan.definitions;
  return service.getDefinitionAtPosition(fileName, offset) ?? [];
}

function locationFromDefinition(
  env: VirtualTypeScriptEnvironment,
  definition: ts.DefinitionInfo,
): readonly lsp.Location[] {
  const fileName = workspaceFileNameForDefinition(definition.fileName);
  const text = sourceTextForFile(env, fileName);
  if (text === null) return [];

  return [
    {
      uri: fileNameToDocumentUri(fileName),
      range: rangeFromTextSpan(text, definition.textSpan),
    },
  ];
}

function rangeFromTextSpan(text: string, span: ts.TextSpan): lsp.Range {
  const start = clampOffset(span.start, text);
  const end = clampOffset(span.start + span.length, text);
  return {
    start: offsetToLspPosition(text, start),
    end: offsetToLspPosition(text, end),
  };
}

function sourceTextForFile(env: VirtualTypeScriptEnvironment, fileName: string): string | null {
  const normalized = sourcePathToFileName(fileName);
  const openDocument = documentForFileName(normalized);
  if (openDocument) return openDocument.text;

  const workspaceText = workspaceFiles.get(normalized);
  if (workspaceText !== undefined) return workspaceText;

  const sourceFile = env.getSourceFile(normalized);
  return sourceFile?.text ?? null;
}

function workspaceFileNameForDefinition(fileName: string): string {
  const normalized = sourcePathToFileName(fileName);
  if (workspaceFiles.has(normalized)) return normalized;
  return workspaceFileNameFromNodeModulesMirror(normalized) ?? normalized;
}

function workspaceFileNameFromNodeModulesMirror(fileName: string): string | null {
  for (const workspacePackage of workspacePackages()) {
    const prefix = `/node_modules/${workspacePackage.name}/`;
    if (!fileName.startsWith(prefix)) continue;

    const candidate = `${workspacePackage.root}/${fileName.slice(prefix.length)}`;
    if (workspaceFiles.has(candidate)) return candidate;
  }

  return null;
}

function documentForUri(uri: lsp.DocumentUri): WorkerDocument | null {
  const openDocument = documents.get(uri);
  if (openDocument) return openDocument;

  const fileName = documentUriToFileName(uri);
  if (!fileName) return null;

  const text = workspaceFiles.get(fileName);
  if (text === undefined) return null;

  return {
    uri,
    fileName,
    languageId: "typescript",
    version: 0,
    text,
  };
}

function documentForFileName(fileName: string): WorkerDocument | null {
  for (const document of documents.values()) {
    if (document.fileName === fileName) return document;
  }

  return null;
}

function clampOffset(offset: number, text: string): number {
  return Math.min(text.length, Math.max(0, offset));
}

function postDiagnostics(
  uri: lsp.DocumentUri,
  version: number | null,
  diagnostics: readonly lsp.Diagnostic[],
): void {
  const params: lsp.PublishDiagnosticsParams = {
    uri,
    diagnostics: [...diagnostics],
  };
  if (version !== null) params.version = version;
  postNotification("textDocument/publishDiagnostics", params);
}

function applyContentChanges(
  text: string,
  changes: readonly lsp.TextDocumentContentChangeEvent[],
): string {
  let nextText = text;
  for (const change of changes) nextText = applyContentChange(nextText, change);
  return nextText;
}

function applyContentChange(text: string, change: lsp.TextDocumentContentChangeEvent): string {
  if (!("range" in change) || !change.range) return change.text;

  const start = lspPositionToOffset(text, change.range.start);
  const end = lspPositionToOffset(text, change.range.end);
  return `${text.slice(0, start)}${change.text}${text.slice(end)}`;
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    allowJs: true,
    checkJs: false,
    allowImportingTsExtensions: true,
    esModuleInterop: true,
    skipLibCheck: true,
    resolveJsonModule: true,
  };
}

function resolvedCompilerOptions(projectConfig: ProjectConfig | null): ts.CompilerOptions {
  return {
    ...defaultCompilerOptions(),
    ...projectConfig?.compilerOptions,
    ...compilerOptionsOverride,
  };
}

function vfsLibraryCompilerOptions(compilerOptions: ts.CompilerOptions): ts.CompilerOptions {
  if (!compilerOptions.lib) return compilerOptions;
  return {
    ...compilerOptions,
    lib: compilerOptions.lib.map(normalizeLibNameForVfs),
  };
}

function normalizeLibNameForVfs(lib: string): string {
  return lib
    .replace(/^lib\./i, "")
    .replace(/\.d\.ts$/i, "")
    .toLowerCase();
}

function readProjectConfig(): ProjectConfig | null {
  const configFileName = projectConfigFileName();
  if (!configFileName) return null;

  const parsed = parseConfigJson(configFileName);
  if (!parsed) return null;

  const config = ts.parseJsonConfigFileContent(
    parsed,
    parseConfigHost(),
    directoryName(configFileName),
    undefined,
    configFileName,
  );
  reportConfigDiagnostics(config.errors);
  return {
    compilerOptions: config.options,
    fileNames: config.fileNames.map(sourcePathToFileName),
  };
}

function projectConfigFileName(): string | null {
  if (workspaceFiles.has("/tsconfig.json")) return "/tsconfig.json";
  return (
    [...workspaceFiles.keys()]
      .filter((fileName) => fileName.endsWith("/tsconfig.json"))
      .toSorted((left, right) => left.length - right.length || left.localeCompare(right))[0] ?? null
  );
}

function parseConfigJson(configFileName: string): object | null {
  const text = workspaceFiles.get(configFileName);
  if (text === undefined) return null;

  const parsed = ts.parseConfigFileTextToJson(configFileName, text);
  if (!parsed.error) return parsed.config as object;

  reportConfigDiagnostics([parsed.error]);
  return null;
}

function parseConfigHost(): ts.ParseConfigHost {
  return {
    useCaseSensitiveFileNames: true,
    fileExists: (fileName) => workspaceFiles.has(sourcePathToFileName(fileName)),
    readFile: (fileName) => workspaceFiles.get(sourcePathToFileName(fileName)),
    readDirectory: (rootDir, extensions) => readWorkspaceDirectory(rootDir, extensions ?? []),
  };
}

function readWorkspaceDirectory(rootDir: string, extensions: readonly string[]): string[] {
  const root = sourcePathToFileName(rootDir);
  return [...workspaceFiles.keys()].filter((fileName) =>
    isConfigDirectoryMatch(fileName, root, extensions),
  );
}

function isConfigDirectoryMatch(
  fileName: string,
  root: string,
  extensions: readonly string[],
): boolean {
  if (!isWithinConfigRoot(fileName, root)) return false;
  if (extensions.length === 0) return true;
  return extensions.some((extension) => fileName.endsWith(extension));
}

function isWithinConfigRoot(fileName: string, root: string): boolean {
  if (root === "/") return true;
  return fileName === root || fileName.startsWith(`${root}/`);
}

function reportConfigDiagnostics(diagnostics: readonly ts.Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    postLogMessage(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  }
}

function postLogMessageText(message: string): void {
  postNotification("window/logMessage", {
    type: 1,
    message,
  });
}

function directoryName(fileName: string): string {
  const index = fileName.lastIndexOf("/");
  if (index <= 0) return "/";
  return fileName.slice(0, index);
}

function workspaceFileMap(params: unknown): Map<string, string> {
  const result = new Map<string, string>();
  const files = filesFromParams(params);
  for (const file of files) result.set(sourcePathToFileName(file.path), file.text);
  return result;
}

function filesFromParams(params: unknown): readonly TypeScriptLspSourceFile[] {
  if (!isRecord(params)) return [];
  if (!Array.isArray(params.files)) return [];
  return params.files.flatMap(parseSourceFile);
}

function parseSourceFile(value: unknown): readonly TypeScriptLspSourceFile[] {
  if (!isRecord(value)) return [];
  if (typeof value.path !== "string") return [];
  if (typeof value.text !== "string") return [];
  return [{ path: value.path, text: value.text }];
}

function readInitializationOptions(params: unknown): TypeScriptLspInitializationOptions {
  if (!isRecord(params)) return {};
  const options = params.initializationOptions;
  if (!isRecord(options)) return {};

  return {
    compilerOptions: isRecord(options.compilerOptions)
      ? (options.compilerOptions as ts.CompilerOptions)
      : undefined,
    diagnosticDelayMs:
      typeof options.diagnosticDelayMs === "number" ? options.diagnosticDelayMs : undefined,
  };
}

function textDocumentItemFromParams(params: unknown): lsp.TextDocumentItem | null {
  if (!isRecord(params)) return null;
  if (!isRecord(params.textDocument)) return null;

  const textDocument = params.textDocument;
  if (typeof textDocument.uri !== "string") return null;
  if (typeof textDocument.languageId !== "string") return null;
  if (typeof textDocument.version !== "number") return null;
  if (typeof textDocument.text !== "string") return null;
  return textDocument as unknown as lsp.TextDocumentItem;
}

function didChangeParams(params: unknown): {
  readonly uri: lsp.DocumentUri;
  readonly version: number;
  readonly contentChanges: readonly lsp.TextDocumentContentChangeEvent[];
} | null {
  if (!isRecord(params)) return null;
  if (!isRecord(params.textDocument)) return null;
  if (!Array.isArray(params.contentChanges)) return null;

  const textDocument = params.textDocument;
  if (typeof textDocument.uri !== "string") return null;
  if (typeof textDocument.version !== "number") return null;
  return {
    uri: textDocument.uri,
    version: textDocument.version,
    contentChanges: params.contentChanges as lsp.TextDocumentContentChangeEvent[],
  };
}

function didCloseUri(params: unknown): lsp.DocumentUri | null {
  if (!isRecord(params)) return null;
  if (!isRecord(params.textDocument)) return null;
  return typeof params.textDocument.uri === "string" ? params.textDocument.uri : null;
}

function textDocumentPositionParams(params: unknown): {
  readonly uri: lsp.DocumentUri;
  readonly position: lsp.Position;
} | null {
  if (!isRecord(params)) return null;
  if (!isRecord(params.textDocument)) return null;
  if (!isRecord(params.position)) return null;
  if (typeof params.textDocument.uri !== "string") return null;
  if (typeof params.position.line !== "number") return null;
  if (typeof params.position.character !== "number") return null;

  return {
    uri: params.textDocument.uri,
    position: {
      line: params.position.line,
      character: params.position.character,
    },
  };
}

function isCurrentDocument(
  scheduled: WorkerDocument,
  current: WorkerDocument | undefined,
): current is WorkerDocument {
  if (!current) return false;
  return current.uri === scheduled.uri && current.version === scheduled.version;
}

function parseIncomingMessage(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function isRequestMessage(message: unknown): message is lsp.RequestMessage {
  if (!isRecord(message)) return false;
  return "id" in message && typeof message.method === "string";
}

function isNotificationMessage(message: unknown): message is lsp.NotificationMessage {
  if (!isRecord(message)) return false;
  return !("id" in message) && typeof message.method === "string";
}

function postResponse(id: lsp.RequestMessage["id"] | null, result: unknown): void {
  workerGlobal.postMessage({
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  } as lsp.ResponseMessage);
}

function postResponseError(id: lsp.RequestMessage["id"] | null, error: unknown): void {
  const responseError = responseErrorFromThrown(error);
  workerGlobal.postMessage({
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: responseError,
  } as lsp.ResponseMessage);
}

function postNotification(method: string, params: unknown): void {
  workerGlobal.postMessage({
    jsonrpc: JSON_RPC_VERSION,
    method,
    params,
  } as lsp.NotificationMessage);
}

function postLogMessage(error: unknown): void {
  postLogMessageText(errorMessage(error));
}

function responseErrorFromThrown(error: unknown): JsonRpcResponseError {
  if (isRpcError(error)) return error;
  return rpcError(INTERNAL_ERROR, errorMessage(error));
}

function rpcError(code: number, message: string): JsonRpcResponseError {
  return { code, message };
}

function isRpcError(error: unknown): error is JsonRpcResponseError {
  if (!isRecord(error)) return false;
  return typeof error.code === "number" && typeof error.message === "string";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export const __typeScriptLspWorkerInternalsForTests = {
  applyContentChange,
  applyContentChanges,
  collectDiagnostics,
  defaultCompilerOptions,
  fileNameToDocumentUri,
};
