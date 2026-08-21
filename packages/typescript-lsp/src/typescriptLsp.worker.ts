import { lspPositionToOffset, offsetToLspPosition } from '@singapor/lsp'
import type { PublishDiagnosticsNotificationParams } from '@singapor/lsp/types'
import {
  createDefaultMapFromCDN,
  createSystem,
  createVirtualTypeScriptEnvironment,
  type VirtualTypeScriptEnvironment,
} from '@typescript/vfs'
import ts from 'typescript'
import type * as lsp from 'vscode-languageserver-protocol'
import {
  documentUriToFileName,
  fileNameToDocumentUri,
  isTypeScriptLspSourceFileName,
  sourcePathToFileName,
} from './paths'
import { tsDiagnosticToLspDiagnostic } from './tsDiagnostics'
import type { TypeScriptLspSourceFile } from './types'

const JSON_RPC_VERSION = '2.0'
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2
const COMPLETION_TRIGGER_INVOKED = 1
const COMPLETION_TRIGGER_CHARACTER = 2
const DEFAULT_DIAGNOSTIC_DELAY_MS = 150
const MAX_COMPLETION_ITEMS = 100
const COMPLETION_TRIGGER_CHARACTERS = ['.', '"', "'", '`', '/', '@', '<', '#', ' '] as const
const REACT_JSX_RUNTIME_PACKAGE_JSON = '/node_modules/react/package.json'
const REACT_INDEX_TYPES = '/node_modules/react/index.d.ts'
const REACT_JSX_RUNTIME_TYPES = '/node_modules/react/jsx-runtime.d.ts'
const REACT_JSX_RUNTIME_FALLBACK_PACKAGE_JSON = `{"name":"react","version":"0.0.0","type":"module","exports":{"./jsx-runtime":"./jsx-runtime.d.ts",".":"./index.d.ts"}}`
const REACT_INDEX_FALLBACK_TYPES = `export type ReactNode = unknown;
export type Key = string | number;
export interface Attributes {
  key?: Key | null | undefined;
}
export const Fragment: unique symbol;
`
const REACT_JSX_RUNTIME_FALLBACK_TYPES = `export namespace JSX {
  export interface Element {}
  export interface ElementClass {}
  export interface ElementAttributesProperty {
    props: {};
  }
  export interface ElementChildrenAttribute {
    children: {};
  }
  export interface IntrinsicAttributes {
    key?: string | number | null | undefined;
  }
  export interface IntrinsicElements {
    [elementName: string]: any;
  }
}

export const Fragment: unique symbol;
export function jsx(type: unknown, props: unknown, key?: string): JSX.Element;
export function jsxs(type: unknown, props: unknown, key?: string): JSX.Element;
`

type WorkerDocument = {
  readonly uri: lsp.DocumentUri
  readonly fileName: string
  readonly languageId: string
  readonly version: number
  readonly text: string
}

type TypeScriptServiceState = {
  readonly env: VirtualTypeScriptEnvironment
}

type TypeScriptLspInitializationOptions = {
  readonly compilerOptions?: ts.CompilerOptions
  readonly diagnosticDelayMs?: number
}

type ProjectConfig = {
  readonly compilerOptions: ts.CompilerOptions
  readonly fileNames: readonly string[]
}

type WorkspacePackage = {
  readonly name: string
  readonly root: string
}

type TypeScriptNavigationItem = {
  readonly fileName: string
  readonly textSpan: ts.TextSpan
}

type JsonRpcResponseError = {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

type JsonRpcRequestId = number | string

/**
 * The legend this worker publishes, and it is awkward on purpose.
 *
 * This worker is a conformance fixture for the semantic-token seam as much as it is the example
 * app's language server, and a fixture that only exercises the easy path proves nothing about the
 * servers the product actually runs. So the three shapes that break decoders are here by
 * construction rather than by accident:
 *
 * - **`function` is the name at two distinct indices.** Legends are not sets, and real ones ship the
 *   same name several times; a decoder that inverts the legend into a name-to-index map mis-decodes
 *   every duplicate. Here TypeScript's `function` and its `member` both answer to `function`, which
 *   is the legend a server that draws no method/function distinction really does publish.
 * - **`typeAlias` is not one of LSP's standard type names**, and the editor's theme has no rule for
 *   it at any prefix, so every span carrying it paints nothing until the host supplies a
 *   `scopeAliases` entry — Contract §C4. A legend whose non-standard names outnumber its standard
 *   ones is the ordinary case for a real server, not the exception.
 * - **`local` is a modifier the editor's precedence ranks below `readonly`**, and TypeScript sets
 *   both on the same token for every reference to a local `const`. Only the higher-ranked one
 *   reaches the scope, so a `const` reference paints as a constant while a `let` reference beside it
 *   paints as a variable.
 *
 * Both arrays are index-aligned with TypeScript's own `classifier.v2020` enums — `TokenType` is
 * class, enum, interface, namespace, typeParameter, type, parameter, variable, enumMember, property,
 * function, member, and `TokenModifier` is declaration, static, async, readonly, defaultLibrary,
 * local. Those are internal `const enum`s the public API does not expose, so the order is written
 * out here; keeping it aligned is what lets the encoder pass TypeScript's index through as the
 * legend index untouched.
 */
const SEMANTIC_TOKEN_LEGEND: lsp.SemanticTokensLegend = {
  tokenTypes: [
    'class',
    'enum',
    'interface',
    'namespace',
    'typeParameter',
    'typeAlias',
    'parameter',
    'variable',
    'enumMember',
    'property',
    'function',
    'function',
  ],
  tokenModifiers: ['declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local'],
}

/** `encoded = ((typeIndex + 1) << 8) | modifierSet`, TypeScript's own packing. */
const SEMANTIC_TOKEN_TYPE_OFFSET = 8
const SEMANTIC_TOKEN_MODIFIER_MASK = 255
/** `getEncodedSemanticClassifications` answers `(start, length, encoded)` triples. */
const SEMANTIC_CLASSIFICATION_STRIDE = 3

let compilerOptionsOverride: ts.CompilerOptions = {}
let diagnosticDelayMs = DEFAULT_DIAGNOSTIC_DELAY_MS
let workspaceFiles = new Map<string, string>()
let servicePromise: Promise<TypeScriptServiceState> | null = null
const documents = new Map<lsp.DocumentUri, WorkerDocument>()
const diagnosticTimers = new Map<lsp.DocumentUri, ReturnType<typeof setTimeout>>()
/**
 * Requests that have been dispatched and not yet answered, so `$/cancelRequest` can take one back
 * out again before its answer is posted.
 *
 * An id is removed when its response is posted and when it is cancelled, whichever happens first,
 * so the set holds only what is genuinely in flight.
 */
const inFlightRequests = new Set<JsonRpcRequestId>()

const workerGlobal = globalThis as unknown as DedicatedWorkerGlobalScope
workerGlobal.onmessage = (event: MessageEvent<unknown>): void => {
  handleIncomingMessage(event.data)
}

function handleIncomingMessage(data: unknown): void {
  const message = parseIncomingMessage(data)
  if (!message) return
  if (isRequestMessage(message)) {
    void handleRequest(message)
    return
  }

  if (isNotificationMessage(message)) handleNotification(message)
}

async function handleRequest(message: lsp.RequestMessage): Promise<void> {
  const id = requestId(message)
  if (id !== null) inFlightRequests.add(id)

  try {
    const result = await requestResult(message)
    if (!claimResponse(id)) return
    postResponse(message.id ?? null, result)
  } catch (error) {
    if (!claimResponse(id)) return
    postResponseError(message.id ?? null, error)
  }
}

/**
 * Whether a response for this id may still be posted.
 *
 * A cancelled request answers nothing at all. The protocol also allows a `RequestCancelled` error
 * response, but by the time `$/cancelRequest` reaches this worker the client has already rejected
 * that request locally and forgotten its id (`LspClient.abortRequest`), so a late error has nowhere
 * to land — and a cancellation that abandons real work is the point of §C8, not response
 * suppression.
 */
function claimResponse(id: JsonRpcRequestId | null): boolean {
  if (id === null) return true
  return inFlightRequests.delete(id)
}

function handleCancelRequest(params: unknown): void {
  if (!isRecord(params)) return

  const id = params.id
  if (typeof id !== 'number' && typeof id !== 'string') return
  inFlightRequests.delete(id)
}

function requestId(message: lsp.RequestMessage): JsonRpcRequestId | null {
  const id = message.id
  if (typeof id === 'number' || typeof id === 'string') return id
  return null
}

function handleNotification(message: lsp.NotificationMessage): void {
  try {
    routeNotification(message)
  } catch (error) {
    postLogMessage(error)
  }
}

async function requestResult(message: lsp.RequestMessage): Promise<unknown> {
  if (message.method === 'initialize') return initializeResult(message.params)
  if (message.method === 'shutdown') return shutdownResult()
  if (message.method === 'textDocument/hover') return hoverResult(message.params)
  if (message.method === 'textDocument/completion') return completionResult(message.params)
  if (message.method === 'textDocument/definition') return definitionResult(message.params)
  if (message.method === 'textDocument/references') return referencesResult(message.params)
  if (message.method === 'textDocument/implementation') return implementationResult(message.params)
  if (message.method === 'textDocument/typeDefinition') return typeDefinitionResult(message.params)
  if (message.method === 'textDocument/semanticTokens/full')
    return semanticTokensFullResult(message.params)
  if (message.method === 'textDocument/semanticTokens/range')
    return semanticTokensRangeResult(message.params)
  throw rpcError(METHOD_NOT_FOUND, `Method not implemented: ${message.method}`)
}

function routeNotification(message: lsp.NotificationMessage): void {
  if (message.method === 'initialized') return
  if (message.method === '$/cancelRequest') return handleCancelRequest(message.params)
  if (message.method === 'exit') return shutdownWorkerState()
  if (message.method === 'textDocument/didOpen') return handleDidOpen(message.params)
  if (message.method === 'textDocument/didChange') return handleDidChange(message.params)
  if (message.method === 'textDocument/didClose') return handleDidClose(message.params)
  if (message.method === 'editor/typescript/setWorkspaceFiles')
    return handleSetWorkspaceFiles(message.params)
}

function initializeResult(params: unknown): lsp.InitializeResult {
  const initializationOptions = readInitializationOptions(params)
  compilerOptionsOverride = initializationOptions.compilerOptions ?? {}
  diagnosticDelayMs = initializationOptions.diagnosticDelayMs ?? DEFAULT_DIAGNOSTIC_DELAY_MS
  invalidateService()

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
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: Array.from(COMPLETION_TRIGGER_CHARACTERS),
      },
      definitionProvider: true,
      referencesProvider: true,
      implementationProvider: true,
      typeDefinitionProvider: true,
      semanticTokensProvider: {
        legend: SEMANTIC_TOKEN_LEGEND,
        full: true,
        range: true,
      },
    },
  } as lsp.InitializeResult
}

function shutdownResult(): null {
  shutdownWorkerState()
  return null
}

function shutdownWorkerState(): void {
  for (const timer of diagnosticTimers.values()) clearTimeout(timer)
  diagnosticTimers.clear()
  documents.clear()
  workspaceFiles.clear()
  invalidateService()
}

function handleDidOpen(params: unknown): void {
  const textDocument = textDocumentItemFromParams(params)
  if (!textDocument) return

  const fileName = documentUriToFileName(textDocument.uri)
  if (!fileName) return
  if (!isTypeScriptLspSourceFileName(fileName)) return

  const document = {
    uri: textDocument.uri,
    fileName,
    languageId: textDocument.languageId,
    version: textDocument.version,
    text: textDocument.text,
  }
  documents.set(document.uri, document)
  void syncOpenDocumentToService(document)
  scheduleDiagnostics(document.uri)
}

function handleDidChange(params: unknown): void {
  const change = didChangeParams(params)
  if (!change) return

  const current = documents.get(change.uri)
  if (!current) return

  const text = applyContentChanges(current.text, change.contentChanges)
  const document = {
    ...current,
    version: change.version,
    text,
  }
  documents.set(document.uri, document)
  void syncOpenDocumentToService(document)
  scheduleDiagnostics(document.uri)
}

function handleDidClose(params: unknown): void {
  const uri = didCloseUri(params)
  if (!uri) return

  const document = documents.get(uri)
  documents.delete(uri)
  clearScheduledDiagnostics(uri)
  postDiagnostics(uri, document?.version ?? null, [])
  if (document) void syncClosedDocumentToService(document)
}

function handleSetWorkspaceFiles(params: unknown): void {
  workspaceFiles = workspaceFileMap(params)
  invalidateService()
  scheduleAllDiagnostics()
}

async function syncOpenDocumentToService(document: WorkerDocument): Promise<void> {
  if (!servicePromise) return

  try {
    const state = await ensureService()
    upsertEnvironmentFile(state.env, document.fileName, document.text)
  } catch (error) {
    postLogMessage(error)
  }
}

async function syncClosedDocumentToService(document: WorkerDocument): Promise<void> {
  if (!servicePromise) return

  try {
    const state = await ensureService()
    restoreOrDeleteEnvironmentFile(state.env, document.fileName)
  } catch (error) {
    postLogMessage(error)
  }
}

function scheduleAllDiagnostics(): void {
  for (const uri of documents.keys()) scheduleDiagnostics(uri)
}

function scheduleDiagnostics(uri: lsp.DocumentUri): void {
  clearScheduledDiagnostics(uri)
  const timer = setTimeout(() => {
    diagnosticTimers.delete(uri)
    void publishDiagnosticsForUri(uri)
  }, diagnosticDelayMs)
  diagnosticTimers.set(uri, timer)
}

function clearScheduledDiagnostics(uri: lsp.DocumentUri): void {
  const timer = diagnosticTimers.get(uri)
  if (!timer) return

  clearTimeout(timer)
  diagnosticTimers.delete(uri)
}

async function publishDiagnosticsForUri(uri: lsp.DocumentUri): Promise<void> {
  const scheduledDocument = documents.get(uri)
  if (!scheduledDocument) return

  try {
    const state = await ensureService()
    const currentDocument = documents.get(uri)
    if (!isCurrentDocument(scheduledDocument, currentDocument)) return

    const diagnostics = collectDiagnostics(state.env, currentDocument.fileName)
    postDiagnostics(currentDocument.uri, currentDocument.version, diagnostics)
  } catch (error) {
    postLogMessage(error)
  }
}

async function hoverResult(params: unknown): Promise<lsp.Hover | null> {
  const request = textDocumentPositionParams(params)
  if (!request) return null

  const document = documentForUri(request.uri)
  if (!document) return null

  const state = await ensureService()
  const offset = lspPositionToOffset(document.text, request.position)
  const quickInfo = state.env.languageService.getQuickInfoAtPosition(document.fileName, offset)
  if (!quickInfo) return null

  return hoverFromQuickInfo(document.text, quickInfo)
}

async function completionResult(params: unknown): Promise<lsp.CompletionList> {
  const request = textDocumentPositionParams(params)
  if (!request) return emptyCompletionList()

  const document = documentForUri(request.uri)
  if (!document) return emptyCompletionList()

  const state = await ensureService()
  const offset = lspPositionToOffset(document.text, request.position)
  const info = state.env.languageService.getCompletionsAtPosition(
    document.fileName,
    offset,
    completionOptions(params),
  )
  if (!info) return emptyCompletionList()

  return completionListFromInfo(document.text, info)
}

async function definitionResult(params: unknown): Promise<lsp.Location[]> {
  const request = textDocumentPositionParams(params)
  if (!request) return []

  const document = documentForUri(request.uri)
  if (!document) return []

  const state = await ensureService()
  const offset = lspPositionToOffset(document.text, request.position)
  const definitions = definitionInfosAtPosition(state.env, document.fileName, offset)
  return definitions.flatMap((definition) => locationFromNavigationItem(state.env, definition))
}

async function referencesResult(params: unknown): Promise<lsp.Location[]> {
  const request = textDocumentPositionParams(params)
  if (!request) return []

  const document = documentForUri(request.uri)
  if (!document) return []

  const state = await ensureService()
  const offset = lspPositionToOffset(document.text, request.position)
  const references =
    state.env.languageService.getReferencesAtPosition(document.fileName, offset) ?? []
  return references
    .filter(
      (reference) => referencesIncludeDeclaration(params) || !referenceIsDefinition(reference),
    )
    .flatMap((reference) => locationFromNavigationItem(state.env, reference))
}

async function implementationResult(params: unknown): Promise<lsp.Location[]> {
  const request = textDocumentPositionParams(params)
  if (!request) return []

  const document = documentForUri(request.uri)
  if (!document) return []

  const state = await ensureService()
  const offset = lspPositionToOffset(document.text, request.position)
  const implementations =
    state.env.languageService.getImplementationAtPosition(document.fileName, offset) ?? []
  return implementations.flatMap((implementation) =>
    locationFromNavigationItem(state.env, implementation),
  )
}

async function typeDefinitionResult(params: unknown): Promise<lsp.Location[]> {
  const request = textDocumentPositionParams(params)
  if (!request) return []

  const document = documentForUri(request.uri)
  if (!document) return []

  const state = await ensureService()
  const offset = lspPositionToOffset(document.text, request.position)
  const typeDefinitions =
    state.env.languageService.getTypeDefinitionAtPosition(document.fileName, offset) ?? []
  return typeDefinitions.flatMap((typeDefinition) =>
    locationFromNavigationItem(state.env, typeDefinition),
  )
}

/**
 * Whole-document tokens, and Milestone 2's measurements say when a host should ask for them.
 *
 * On a warm service a 100-line span classifies in 0.380 ms against 22.514 ms for the whole of a
 * 5,027-line file, and this worker has one message loop with no queue — so those 22 ms are time no
 * completion (0.212 ms) and no hover (0.114 ms) can use. Classification is linear in the span asked
 * for and carries no fixed cost worth naming, which is what makes the split worth making.
 *
 * Both requests are answered rather than one: `full` is what a host has to ask on open, when there
 * is no viewport yet and the answer is bounded by the document. **The demand signal of §C8 should be
 * answered with `range`**, and the fixture is built around that being the hot path.
 */
async function semanticTokensFullResult(params: unknown): Promise<lsp.SemanticTokens | null> {
  const requested = documentFromTextDocumentParams(params)
  if (!requested) return null

  const settled = await settledService(requested)
  if (!settled) return null

  return {
    data: encodeSemanticTokens(settled.env, settled.document, {
      start: 0,
      length: settled.document.text.length,
    }),
  }
}

/** See `semanticTokensFullResult` for which of the two a host should be asking. */
async function semanticTokensRangeResult(params: unknown): Promise<lsp.SemanticTokens | null> {
  const requested = documentFromTextDocumentParams(params)
  if (!requested) return null

  const range = lspRangeFromParams(params)
  if (!range) return null

  const settled = await settledService(requested)
  if (!settled) return null

  // One scan of the document, not three. `lspPositionToOffset` walks the text a character at a time
  // from offset zero, so asking it for both ends of a range cost two full passes before
  // `encodeSemanticTokens` made a third building the very array that answers both — a fixed
  // O(document) charge on a per-viewport question, larger than the classification it wraps and
  // growing with the file rather than with the window.
  const text = settled.document.text
  const lineStarts = documentLineStarts(text)
  const start = offsetAtPosition(lineStarts, text.length, range.start)
  const end = offsetAtPosition(lineStarts, text.length, range.end)
  return {
    data: encodeSemanticTokens(
      settled.env,
      settled.document,
      { start, length: Math.max(end - start, 0) },
      lineStarts,
    ),
  }
}

/**
 * The service and the document together, once both have settled — or nothing if the document moved
 * out from under the request while we waited.
 *
 * `ensureService()` can suspend for a long time — the first call fetches the lib set over the
 * network, and `handleSetWorkspaceFiles` invalidates the service so that recurs — and notifications
 * are routed the moment they arrive, with nothing serialising them behind an in-flight request. So
 * a `didChange` lands freely inside that window, `createService` builds its environment from the
 * *new* text, and a handler still holding the object it captured before the await would encode
 * span offsets taken from the new document against line starts taken from the old one: an answer
 * consistent with neither version, which no host-side version check can reconcile. Re-reading the
 * map after the await is what `publishDiagnosticsForUri` already does, for the same reason.
 */
async function settledService(requested: WorkerDocument): Promise<{
  readonly env: VirtualTypeScriptEnvironment
  readonly document: WorkerDocument
} | null> {
  const state = await ensureService()

  const current = documents.get(requested.uri)
  if (!isCurrentDocument(requested, current)) return null

  return { document: current, env: state.env }
}

/** Where `position` lands, against line starts the caller has already built. */
function offsetAtPosition(
  lineStarts: readonly number[],
  textLength: number,
  position: lsp.Position,
): number {
  const lineStart = lineStarts[position.line]
  if (lineStart === undefined) return textLength

  const lineEnd = lineStarts[position.line + 1] ?? textLength
  const offset = lineStart + position.character
  return offset > lineEnd ? lineEnd : offset
}

/**
 * TypeScript's absolute triples, re-encoded as LSP's relative 5-tuples.
 *
 * `getEncodedSemanticClassifications` answers `(start, length, encoded)` in document offsets, where
 * `encoded = ((typeIndex + 1) << 8) | modifierSet`. The `+ 1` is how TypeScript spells "no
 * classification", so a triple that decodes to -1 is dropped rather than encoded as type zero.
 *
 * **The first tuple's `deltaLine` is measured from line zero even when the caller asked for a range
 * halfway down the file.** LSP's cursor starts at the top of the document, not at the top of the
 * request; encoding it relative to the range start is invisible until a host scrolls, at which point
 * every span in the answer paints a screenful too high.
 *
 * Nothing here crosses a newline: TypeScript classifies identifiers, and a client that has not
 * declared `multilineTokenSupport` must not be sent one (Contract §C1).
 */
function encodeSemanticTokens(
  env: VirtualTypeScriptEnvironment,
  document: WorkerDocument,
  span: ts.TextSpan,
  precomputedLineStarts?: readonly number[],
): number[] {
  const classifications = env.languageService.getEncodedSemanticClassifications(
    document.fileName,
    span,
    ts.SemanticClassificationFormat.TwentyTwenty,
  )
  const spans = classifications.spans
  const lineStarts = precomputedLineStarts ?? documentLineStarts(document.text)
  const data: number[] = []
  let previousLine = 0
  let previousCharacter = 0

  for (
    let index = 0;
    index + SEMANTIC_CLASSIFICATION_STRIDE <= spans.length;
    index += SEMANTIC_CLASSIFICATION_STRIDE
  ) {
    const start = spans[index] as number
    const length = spans[index + 1] as number
    const encoded = spans[index + 2] as number
    const tokenType = (encoded >> SEMANTIC_TOKEN_TYPE_OFFSET) - 1
    if (tokenType < 0 || tokenType >= SEMANTIC_TOKEN_LEGEND.tokenTypes.length) continue

    const line = lineForOffset(lineStarts, start)
    const character = start - (lineStarts[line] as number)
    data.push(
      line - previousLine,
      line === previousLine ? character - previousCharacter : character,
      length,
      tokenType,
      encoded & SEMANTIC_TOKEN_MODIFIER_MASK,
    )
    previousLine = line
    previousCharacter = character
  }

  return data
}

function documentLineStarts(text: string): readonly number[] {
  const starts = [0]
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1)
  }
  return starts
}

// Bisection rather than `offsetToLspPosition` per token: that one walks the text from the start on
// every call, which turns one classification of a large file into a quadratic scan of it.
function lineForOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if ((lineStarts[middle] as number) <= offset) low = middle
    else high = middle - 1
  }

  return low
}

function ensureService(): Promise<TypeScriptServiceState> {
  if (servicePromise) return servicePromise

  servicePromise = createService().catch((error: unknown) => {
    servicePromise = null
    throw error
  })
  return servicePromise
}

// The lib files come off the TypeScript playground CDN, which is the right source for a worker
// running in a browser and the wrong one for a test — no suite of ours may depend on the network
// being reachable, and a fetch of a hundred-odd `.d.ts` files is the slowest thing here by far.
// `libraryFiles` lets a caller hand in the same libs read from `node_modules/typescript/lib`
// instead. Omitted — which is every call the worker itself makes — the fetch is untouched.
async function createService(
  libraryFiles?: ReadonlyMap<string, string>,
): Promise<TypeScriptServiceState> {
  const projectConfig = readProjectConfig()
  const compilerOptions = resolvedCompilerOptions(projectConfig)
  const fsMap = libraryFiles
    ? new Map(libraryFiles)
    : await createDefaultMapFromCDN(
        vfsLibraryCompilerOptions(compilerOptions),
        ts.version,
        false,
        ts,
      )
  addWorkspaceFiles(fsMap)
  addReactJsxRuntimeFallbackFiles(fsMap)
  addOpenDocuments(fsMap)
  const system = createSystem(fsMap)
  const rootFiles = rootFileNames(fsMap, projectConfig)
  const env = createVirtualTypeScriptEnvironment(system, rootFiles, ts, compilerOptions)
  return { env }
}

function addWorkspaceFiles(fsMap: Map<string, string>): void {
  for (const [fileName, text] of workspaceFiles) fsMap.set(fileName, text)
  addWorkspacePackageMirrors(fsMap)
}

function addOpenDocuments(fsMap: Map<string, string>): void {
  for (const document of documents.values()) fsMap.set(document.fileName, document.text)
}

function addReactJsxRuntimeFallbackFiles(fsMap: Map<string, string>): void {
  setFallbackFile(fsMap, REACT_JSX_RUNTIME_PACKAGE_JSON, REACT_JSX_RUNTIME_FALLBACK_PACKAGE_JSON)
  setFallbackFile(fsMap, REACT_INDEX_TYPES, REACT_INDEX_FALLBACK_TYPES)
  setFallbackFile(fsMap, REACT_JSX_RUNTIME_TYPES, REACT_JSX_RUNTIME_FALLBACK_TYPES)
}

function setFallbackFile(fsMap: Map<string, string>, fileName: string, text: string): void {
  if (fsMap.has(fileName)) return
  fsMap.set(fileName, text)
}

function addWorkspacePackageMirrors(fsMap: Map<string, string>): void {
  const packages = workspacePackages()
  for (const workspacePackage of packages) addWorkspacePackageMirror(fsMap, workspacePackage)
}

function addWorkspacePackageMirror(
  fsMap: Map<string, string>,
  workspacePackage: WorkspacePackage,
): void {
  const rootPrefix = `${workspacePackage.root}/`
  const nodeModuleRoot = `/node_modules/${workspacePackage.name}`

  for (const [fileName, text] of workspaceFiles) {
    if (!isPackageFile(fileName, workspacePackage.root, rootPrefix)) continue

    const relativePath = fileName.slice(rootPrefix.length)
    fsMap.set(`${nodeModuleRoot}/${relativePath}`, text)
  }
}

function isPackageFile(fileName: string, root: string, rootPrefix: string): boolean {
  return fileName === `${root}/package.json` || fileName.startsWith(rootPrefix)
}

function workspacePackages(): readonly WorkspacePackage[] {
  return Array.from(workspaceFiles.entries()).flatMap(([fileName, text]) =>
    workspacePackageFromFile(fileName, text),
  )
}

function workspacePackageFromFile(fileName: string, text: string): readonly WorkspacePackage[] {
  if (!fileName.endsWith('/package.json')) return []

  const name = packageJsonName(text)
  if (!name) return []

  return [{ name, root: directoryName(fileName) }]
}

function packageJsonName(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed)) return null
    return typeof parsed.name === 'string' ? parsed.name : null
  } catch {
    return null
  }
}

function rootFileNames(
  fsMap: ReadonlyMap<string, string>,
  projectConfig: ProjectConfig | null,
): string[] {
  const roots = new Set(
    projectConfig?.fileNames ?? Array.from(fsMap.keys()).filter(isTypeScriptLspSourceFileName),
  )
  for (const document of documents.values()) roots.add(document.fileName)
  return Array.from(roots).filter(isTypeScriptLspSourceFileName)
}

function invalidateService(): void {
  servicePromise = null
}

function upsertEnvironmentFile(
  env: VirtualTypeScriptEnvironment,
  fileName: string,
  text: string,
): void {
  if (env.getSourceFile(fileName)) {
    env.updateFile(fileName, text)
    return
  }

  env.createFile(fileName, text)
}

function restoreOrDeleteEnvironmentFile(env: VirtualTypeScriptEnvironment, fileName: string): void {
  const workspaceText = workspaceFiles.get(fileName)
  if (workspaceText !== undefined) {
    upsertEnvironmentFile(env, fileName, workspaceText)
    return
  }

  env.deleteFile(fileName)
}

function collectDiagnostics(
  env: VirtualTypeScriptEnvironment,
  fileName: string,
): readonly lsp.Diagnostic[] {
  const service = env.languageService
  return [
    ...service.getSyntacticDiagnostics(fileName),
    ...service.getSemanticDiagnostics(fileName),
    ...service.getSuggestionDiagnostics(fileName),
  ].map((diagnostic) => tsDiagnosticToLspDiagnostic(diagnostic))
}

function hoverFromQuickInfo(text: string, quickInfo: ts.QuickInfo): lsp.Hover {
  const display = ts.displayPartsToString(quickInfo.displayParts ?? [])
  const documentation = ts.displayPartsToString(quickInfo.documentation ?? [])
  const tags = quickInfo.tags?.map(tagText).filter((tag) => tag.length > 0) ?? []
  const value = hoverMarkdown(display, documentation, tags)

  return {
    contents: {
      kind: 'markdown',
      value,
    },
    range: rangeFromTextSpan(text, quickInfo.textSpan),
  }
}

function hoverMarkdown(display: string, documentation: string, tags: readonly string[]): string {
  const sections: string[] = []
  if (display) sections.push(['```ts', display, '```'].join('\n'))
  if (documentation) sections.push(documentation)
  if (tags.length > 0) sections.push(tags.join('\n'))
  return sections.join('\n\n')
}

function tagText(tag: ts.JSDocTagInfo): string {
  const text = ts.displayPartsToString(tag.text ?? [])
  if (!text) return `@${tag.name}`
  return `@${tag.name} ${text}`
}

function emptyCompletionList(): lsp.CompletionList {
  return { isIncomplete: false, items: [] }
}

function completionOptions(params: unknown): ts.GetCompletionsAtPositionOptions {
  const trigger = completionTrigger(params)
  const options: ts.GetCompletionsAtPositionOptions = {
    includeCompletionsForImportStatements: true,
    includeCompletionsForModuleExports: true,
    includeCompletionsWithInsertText: true,
    includeCompletionsWithSnippetText: false,
    triggerKind: trigger.kind as ts.CompletionTriggerKind,
  }
  if (trigger.character) options.triggerCharacter = trigger.character
  return options
}

function completionTrigger(params: unknown): {
  readonly kind: number
  readonly character?: ts.CompletionsTriggerCharacter
} {
  if (!isRecord(params)) return { kind: COMPLETION_TRIGGER_INVOKED }
  if (!isRecord(params.context)) return { kind: COMPLETION_TRIGGER_INVOKED }

  const context = params.context
  const character = completionTriggerCharacter(context.triggerCharacter)
  if (context.triggerKind === COMPLETION_TRIGGER_CHARACTER && character) {
    return { kind: COMPLETION_TRIGGER_CHARACTER, character }
  }

  return { kind: COMPLETION_TRIGGER_INVOKED }
}

function completionTriggerCharacter(value: unknown): ts.CompletionsTriggerCharacter | undefined {
  if (typeof value !== 'string') return undefined
  if (!completionTriggerCharacterSet.has(value)) return undefined
  return value as ts.CompletionsTriggerCharacter
}

const completionTriggerCharacterSet = new Set<string>(COMPLETION_TRIGGER_CHARACTERS)

function completionListFromInfo(text: string, info: ts.CompletionInfo): lsp.CompletionList {
  return {
    isIncomplete: info.isIncomplete === true,
    items: info.entries
      .slice(0, MAX_COMPLETION_ITEMS)
      .map((entry) => completionItemFromEntry(text, info, entry)),
  }
}

function completionItemFromEntry(
  text: string,
  info: ts.CompletionInfo,
  entry: ts.CompletionEntry,
): lsp.CompletionItem {
  const insertText = entry.insertText ?? entry.name
  const item: lsp.CompletionItem = {
    label: entry.name,
    kind: completionItemKind(entry.kind),
    sortText: entry.sortText,
    filterText: entry.filterText,
    commitCharacters: entry.commitCharacters ?? info.defaultCommitCharacters,
  }
  const detail = completionEntryDetail(entry)
  if (detail) item.detail = detail
  if (entry.labelDetails) item.labelDetails = entry.labelDetails
  if (entry.source) item.data = { source: entry.source, data: entry.data }

  const span = entry.replacementSpan ?? info.optionalReplacementSpan
  if (span) item.textEdit = { range: rangeFromTextSpan(text, span), newText: insertText }
  else item.insertText = insertText
  return item
}

function completionEntryDetail(entry: ts.CompletionEntry): string | undefined {
  const source = ts.displayPartsToString(entry.sourceDisplay ?? [])
  if (source) return source
  if (entry.kindModifiers) return entry.kindModifiers
  return undefined
}

function completionItemKind(kind: string): lsp.CompletionItemKind {
  if (kind === 'method') return 2
  if (kind === 'function') return 3
  if (kind === 'constructor') return 4
  if (kind === 'member variable') return 5
  if (kind === 'member get accessor') return 5
  if (kind === 'member set accessor') return 5
  if (kind === 'var') return 6
  if (kind === 'let') return 6
  if (kind === 'const') return 6
  if (kind === 'local var') return 6
  if (kind === 'parameter') return 6
  if (kind === 'class') return 7
  if (kind === 'interface') return 8
  if (kind === 'module') return 9
  if (kind === 'property') return 10
  if (kind === 'enum') return 13
  if (kind === 'keyword') return 14
  if (kind === 'enum member') return 20
  if (kind === 'alias') return 18
  if (kind === 'type') return 25
  return 1
}

function definitionInfosAtPosition(
  env: VirtualTypeScriptEnvironment,
  fileName: string,
  offset: number,
): readonly ts.DefinitionInfo[] {
  const service = env.languageService
  const withSpan = service.getDefinitionAndBoundSpan(fileName, offset)
  if (withSpan?.definitions) return withSpan.definitions
  return service.getDefinitionAtPosition(fileName, offset) ?? []
}

function locationFromNavigationItem(
  env: VirtualTypeScriptEnvironment,
  item: TypeScriptNavigationItem,
): readonly lsp.Location[] {
  const fileName = workspaceFileNameForDefinition(item.fileName)
  const text = sourceTextForFile(env, fileName)
  if (text === null) return []

  return [
    {
      uri: fileNameToDocumentUri(fileName),
      range: rangeFromTextSpan(text, item.textSpan),
    },
  ]
}

function rangeFromTextSpan(text: string, span: ts.TextSpan): lsp.Range {
  const start = clampOffset(span.start, text)
  const end = clampOffset(span.start + span.length, text)
  return {
    start: offsetToLspPosition(text, start),
    end: offsetToLspPosition(text, end),
  }
}

function sourceTextForFile(env: VirtualTypeScriptEnvironment, fileName: string): string | null {
  const normalized = sourcePathToFileName(fileName)
  const openDocument = documentForFileName(normalized)
  if (openDocument) return openDocument.text

  const workspaceText = workspaceFiles.get(normalized)
  if (workspaceText !== undefined) return workspaceText

  const sourceFile = env.getSourceFile(normalized)
  return sourceFile?.text ?? null
}

function workspaceFileNameForDefinition(fileName: string): string {
  const normalized = sourcePathToFileName(fileName)
  if (workspaceFiles.has(normalized)) return normalized
  return workspaceFileNameFromNodeModulesMirror(normalized) ?? normalized
}

function workspaceFileNameFromNodeModulesMirror(fileName: string): string | null {
  for (const workspacePackage of workspacePackages()) {
    const prefix = `/node_modules/${workspacePackage.name}/`
    if (!fileName.startsWith(prefix)) continue

    const candidate = `${workspacePackage.root}/${fileName.slice(prefix.length)}`
    if (workspaceFiles.has(candidate)) return candidate
  }

  return null
}

function documentForUri(uri: lsp.DocumentUri): WorkerDocument | null {
  const openDocument = documents.get(uri)
  if (openDocument) return openDocument

  const fileName = documentUriToFileName(uri)
  if (!fileName) return null

  const text = workspaceFiles.get(fileName)
  if (text === undefined) return null

  return {
    uri,
    fileName,
    languageId: 'typescript',
    version: 0,
    text,
  }
}

function documentForFileName(fileName: string): WorkerDocument | null {
  for (const document of documents.values()) {
    if (document.fileName === fileName) return document
  }

  return null
}

function clampOffset(offset: number, text: string): number {
  return Math.min(text.length, Math.max(0, offset))
}

function postDiagnostics(
  uri: lsp.DocumentUri,
  version: number | null,
  diagnostics: readonly lsp.Diagnostic[],
): void {
  const params: PublishDiagnosticsNotificationParams =
    version === null ? { uri, diagnostics } : { uri, version, diagnostics }
  postNotification('textDocument/publishDiagnostics', params)
}

function applyContentChanges(
  text: string,
  changes: readonly lsp.TextDocumentContentChangeEvent[],
): string {
  let nextText = text
  for (const change of changes) nextText = applyContentChange(nextText, change)
  return nextText
}

function applyContentChange(text: string, change: lsp.TextDocumentContentChangeEvent): string {
  if (!('range' in change) || !change.range) return change.text

  const start = lspPositionToOffset(text, change.range.start)
  const end = lspPositionToOffset(text, change.range.end)
  return `${text.slice(0, start)}${change.text}${text.slice(end)}`
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
  }
}

function resolvedCompilerOptions(projectConfig: ProjectConfig | null): ts.CompilerOptions {
  return {
    ...defaultCompilerOptions(),
    ...projectConfig?.compilerOptions,
    ...compilerOptionsOverride,
  }
}

function vfsLibraryCompilerOptions(compilerOptions: ts.CompilerOptions): ts.CompilerOptions {
  if (!compilerOptions.lib) return compilerOptions
  return {
    ...compilerOptions,
    lib: compilerOptions.lib.map(normalizeLibNameForVfs),
  }
}

function normalizeLibNameForVfs(lib: string): string {
  return lib
    .replace(/^lib\./i, '')
    .replace(/\.d\.ts$/i, '')
    .toLowerCase()
}

function readProjectConfig(): ProjectConfig | null {
  const configFileName = projectConfigFileName()
  if (!configFileName) return null

  const parsed = parseConfigJson(configFileName)
  if (!parsed) return null

  const config = ts.parseJsonConfigFileContent(
    parsed,
    parseConfigHost(),
    directoryName(configFileName),
    undefined,
    configFileName,
  )
  reportConfigDiagnostics(config.errors)
  return {
    compilerOptions: config.options,
    fileNames: config.fileNames.map(sourcePathToFileName),
  }
}

function projectConfigFileName(): string | null {
  if (workspaceFiles.has('/tsconfig.json')) return '/tsconfig.json'
  return (
    Array.from(workspaceFiles.keys())
      .filter((fileName) => fileName.endsWith('/tsconfig.json'))
      .toSorted((left, right) => left.length - right.length || left.localeCompare(right))[0] ?? null
  )
}

function parseConfigJson(configFileName: string): object | null {
  const text = workspaceFiles.get(configFileName)
  if (text === undefined) return null

  const parsed = ts.parseConfigFileTextToJson(configFileName, text)
  if (!parsed.error) return parsed.config as object

  reportConfigDiagnostics([parsed.error])
  return null
}

function parseConfigHost(): ts.ParseConfigHost {
  return {
    useCaseSensitiveFileNames: true,
    fileExists: (fileName) => workspaceFiles.has(sourcePathToFileName(fileName)),
    readFile: (fileName) => workspaceFiles.get(sourcePathToFileName(fileName)),
    readDirectory: (rootDir, extensions) => readWorkspaceDirectory(rootDir, extensions ?? []),
  }
}

function readWorkspaceDirectory(rootDir: string, extensions: readonly string[]): string[] {
  const root = sourcePathToFileName(rootDir)
  return Array.from(workspaceFiles.keys()).filter((fileName) =>
    isConfigDirectoryMatch(fileName, root, extensions),
  )
}

function isConfigDirectoryMatch(
  fileName: string,
  root: string,
  extensions: readonly string[],
): boolean {
  if (!isWithinConfigRoot(fileName, root)) return false
  if (extensions.length === 0) return true
  return extensions.some((extension) => fileName.endsWith(extension))
}

function isWithinConfigRoot(fileName: string, root: string): boolean {
  if (root === '/') return true
  return fileName === root || fileName.startsWith(`${root}/`)
}

function reportConfigDiagnostics(diagnostics: readonly ts.Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    postLogMessage(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  }
}

function postLogMessageText(message: string): void {
  postNotification('window/logMessage', {
    type: 1,
    message,
  })
}

function directoryName(fileName: string): string {
  const index = fileName.lastIndexOf('/')
  if (index <= 0) return '/'
  return fileName.slice(0, index)
}

function workspaceFileMap(params: unknown): Map<string, string> {
  const result = new Map<string, string>()
  const files = filesFromParams(params)
  for (const file of files) result.set(sourcePathToFileName(file.path), file.text)
  return result
}

function filesFromParams(params: unknown): readonly TypeScriptLspSourceFile[] {
  if (!isRecord(params)) return []
  if (!Array.isArray(params.files)) return []
  return params.files.flatMap(parseSourceFile)
}

function parseSourceFile(value: unknown): readonly TypeScriptLspSourceFile[] {
  if (!isRecord(value)) return []
  if (typeof value.path !== 'string') return []
  if (typeof value.text !== 'string') return []
  return [{ path: value.path, text: value.text }]
}

function readInitializationOptions(params: unknown): TypeScriptLspInitializationOptions {
  if (!isRecord(params)) return {}
  const options = params.initializationOptions
  if (!isRecord(options)) return {}

  return {
    compilerOptions: isRecord(options.compilerOptions)
      ? (options.compilerOptions as ts.CompilerOptions)
      : undefined,
    diagnosticDelayMs:
      typeof options.diagnosticDelayMs === 'number' ? options.diagnosticDelayMs : undefined,
  }
}

function textDocumentItemFromParams(params: unknown): lsp.TextDocumentItem | null {
  if (!isRecord(params)) return null
  if (!isRecord(params.textDocument)) return null

  const textDocument = params.textDocument
  if (typeof textDocument.uri !== 'string') return null
  if (typeof textDocument.languageId !== 'string') return null
  if (typeof textDocument.version !== 'number') return null
  if (typeof textDocument.text !== 'string') return null
  return textDocument as unknown as lsp.TextDocumentItem
}

function didChangeParams(params: unknown): {
  readonly uri: lsp.DocumentUri
  readonly version: number
  readonly contentChanges: readonly lsp.TextDocumentContentChangeEvent[]
} | null {
  if (!isRecord(params)) return null
  if (!isRecord(params.textDocument)) return null
  if (!Array.isArray(params.contentChanges)) return null

  const textDocument = params.textDocument
  if (typeof textDocument.uri !== 'string') return null
  if (typeof textDocument.version !== 'number') return null
  return {
    uri: textDocument.uri,
    version: textDocument.version,
    contentChanges: params.contentChanges as lsp.TextDocumentContentChangeEvent[],
  }
}

function didCloseUri(params: unknown): lsp.DocumentUri | null {
  if (!isRecord(params)) return null
  if (!isRecord(params.textDocument)) return null
  return typeof params.textDocument.uri === 'string' ? params.textDocument.uri : null
}

function textDocumentPositionParams(params: unknown): {
  readonly uri: lsp.DocumentUri
  readonly position: lsp.Position
} | null {
  if (!isRecord(params)) return null
  if (!isRecord(params.textDocument)) return null
  if (!isRecord(params.position)) return null
  if (typeof params.textDocument.uri !== 'string') return null
  if (typeof params.position.line !== 'number') return null
  if (typeof params.position.character !== 'number') return null

  return {
    uri: params.textDocument.uri,
    position: {
      line: params.position.line,
      character: params.position.character,
    },
  }
}

function documentFromTextDocumentParams(params: unknown): WorkerDocument | null {
  if (!isRecord(params)) return null
  if (!isRecord(params.textDocument)) return null
  if (typeof params.textDocument.uri !== 'string') return null

  return documentForUri(params.textDocument.uri)
}

function lspRangeFromParams(params: unknown): lsp.Range | null {
  if (!isRecord(params)) return null
  if (!isRecord(params.range)) return null

  const start = lspPositionFromValue(params.range.start)
  const end = lspPositionFromValue(params.range.end)
  if (!start || !end) return null

  return { start, end }
}

function lspPositionFromValue(value: unknown): lsp.Position | null {
  if (!isRecord(value)) return null
  if (typeof value.line !== 'number') return null
  if (typeof value.character !== 'number') return null

  return { line: value.line, character: value.character }
}

function referencesIncludeDeclaration(params: unknown): boolean {
  if (!isRecord(params)) return true
  if (!isRecord(params.context)) return true
  return params.context.includeDeclaration !== false
}

function referenceIsDefinition(reference: ts.ReferenceEntry): boolean {
  return (reference as { readonly isDefinition?: boolean }).isDefinition === true
}

function isCurrentDocument(
  scheduled: WorkerDocument,
  current: WorkerDocument | undefined,
): current is WorkerDocument {
  if (!current) return false
  return current.uri === scheduled.uri && current.version === scheduled.version
}

function parseIncomingMessage(data: unknown): unknown {
  if (typeof data !== 'string') return data
  try {
    return JSON.parse(data) as unknown
  } catch {
    return null
  }
}

function isRequestMessage(message: unknown): message is lsp.RequestMessage {
  if (!isRecord(message)) return false
  return 'id' in message && typeof message.method === 'string'
}

function isNotificationMessage(message: unknown): message is lsp.NotificationMessage {
  if (!isRecord(message)) return false
  return !('id' in message) && typeof message.method === 'string'
}

function postResponse(id: lsp.RequestMessage['id'] | null, result: unknown): void {
  workerGlobal.postMessage({
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  } as lsp.ResponseMessage)
}

function postResponseError(id: lsp.RequestMessage['id'] | null, error: unknown): void {
  const responseError = responseErrorFromThrown(error)
  workerGlobal.postMessage({
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: responseError,
  } as lsp.ResponseMessage)
}

function postNotification(method: string, params: unknown): void {
  workerGlobal.postMessage({
    jsonrpc: JSON_RPC_VERSION,
    method,
    params,
  } as lsp.NotificationMessage)
}

function postLogMessage(error: unknown): void {
  postLogMessageText(errorMessage(error))
}

function responseErrorFromThrown(error: unknown): JsonRpcResponseError {
  if (isRpcError(error)) return error
  return rpcError(INTERNAL_ERROR, errorMessage(error))
}

function rpcError(code: number, message: string): JsonRpcResponseError {
  return { code, message }
}

function isRpcError(error: unknown): error is JsonRpcResponseError {
  if (!isRecord(error)) return false
  return typeof error.code === 'number' && typeof error.message === 'string'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export const __typeScriptLspWorkerInternalsForTests = {
  applyContentChange,
  applyContentChanges,
  collectDiagnostics,
  createService,
  defaultCompilerOptions,
  fileNameToDocumentUri,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
