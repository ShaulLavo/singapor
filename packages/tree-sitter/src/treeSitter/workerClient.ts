import type { TreeSitterLanguageDescriptor } from './registry'
import {
  TreeSitterSourceChunkRetention,
  type TreeSitterSourceChunkRequest,
  type TreeSitterSourceChunkRetentionSnapshot,
} from './sourceChunkRetention'
import type {
  TreeSitterEditRequest,
  TreeSitterLanguageId,
  TreeSitterParseAckResult,
  TreeSitterParseRequest,
  TreeSitterParseResult,
  TreeSitterRangeRequest,
  TreeSitterRangeResult,
  TreeSitterSelectionRequest,
  TreeSitterSelectionResult,
  TreeSitterSyntaxRange,
  TreeSitterWorkerRequest,
  TreeSitterWorkerRequestPayload,
  TreeSitterWorkerResponse,
  TreeSitterWorkerResult,
} from './types'
import type { PieceTableSnapshot } from '@singapor/core/document'

type PendingRequest = {
  readonly runtimeSessionId: string | null
  readonly cancellationFlag: Int32Array | null
  readonly payload: TreeSitterWorkerRequestPayload
  readonly sourceRequest: TreeSitterSourceChunkRequest | null
  readonly resolve: (result: TreeSitterWorkerResult) => void
  readonly reject: (error: Error) => void
}

type TreeSitterParseDocumentRequest = Omit<
  TreeSitterParseRequest,
  'generation' | 'cancellationBuffer'
>
type TreeSitterEditDocumentRequest = Omit<
  TreeSitterEditRequest,
  'generation' | 'cancellationBuffer'
>
type TreeSitterRangeDocumentRequest = Omit<
  TreeSitterRangeRequest,
  'generation' | 'cancellationBuffer'
>

export type TreeSitterParsePayload = {
  readonly documentId: string
  readonly runtimeSessionId: string
  readonly snapshotVersion: number
  readonly languageId: TreeSitterLanguageId
  readonly includeHighlights?: boolean
  readonly includeCaptures?: boolean
  readonly resultMode?: 'full'
  readonly snapshot: PieceTableSnapshot
}
export type TreeSitterParseOnlyPayload = Omit<TreeSitterParsePayload, 'resultMode'> & {
  readonly resultMode: 'parseOnly'
}
export type TreeSitterBackendParsePayload = TreeSitterParsePayload | TreeSitterParseOnlyPayload

export type TreeSitterEditPayload = {
  readonly documentId: string
  readonly runtimeSessionId: string
  readonly previousSnapshotVersion: number
  readonly snapshotVersion: number
  readonly languageId: TreeSitterLanguageId
  readonly includeHighlights: boolean
  readonly includeCaptures?: boolean
  readonly resultMode?: 'full'
  readonly snapshot: PieceTableSnapshot
  readonly edits: readonly TreeSitterEditRequest['edits'][number][]
  readonly inputEdits: readonly TreeSitterEditRequest['inputEdits'][number][]
}
export type TreeSitterEditOnlyPayload = Omit<TreeSitterEditPayload, 'resultMode'> & {
  readonly resultMode: 'parseOnly'
}
export type TreeSitterBackendEditPayload = TreeSitterEditPayload | TreeSitterEditOnlyPayload
export type TreeSitterRangePayload = {
  readonly documentId: string
  readonly runtimeSessionId: string
  readonly snapshotVersion: number
  readonly languageId: TreeSitterLanguageId
  readonly includeHighlights?: boolean
  readonly includeCaptures?: boolean
  readonly range: TreeSitterSyntaxRange
}
export type TreeSitterSelectionPayload = Omit<TreeSitterSelectionRequest, 'type'>

export type TreeSitterWorkerLifecycleState =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'disposing'
  | 'disposed'
  | 'crashed'

export type TreeSitterWorkerCacheSnapshot = {
  readonly registeredLanguages: number
  readonly sourceChunks: TreeSitterSourceChunkRetentionSnapshot
}

export type TreeSitterWorkerOwnerSnapshot = {
  readonly lifecycle: TreeSitterWorkerLifecycleState
  readonly pendingRequests: number
  readonly workerGeneration: number
  readonly cache: TreeSitterWorkerCacheSnapshot
  readonly lastError: string | null
}

export type TreeSitterBackend = {
  registerLanguages(languages: readonly TreeSitterLanguageDescriptor[]): Promise<void>
  parse(
    payload: TreeSitterBackendParsePayload,
  ): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
  edit(
    payload: TreeSitterBackendEditPayload,
  ): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
  queryRange?(payload: TreeSitterRangePayload): Promise<TreeSitterRangeResult | undefined>
  select(payload: TreeSitterSelectionPayload): Promise<TreeSitterSelectionResult | undefined>
  disposeDocument(runtimeSessionId: string): void
  awaitRuntimeSessionIdle?(runtimeSessionId: string): Promise<void>
  awaitIdleFence?(): Promise<void>
  dispose?(): Promise<void>
}

const supportsWorkers = (): boolean => typeof Worker !== 'undefined'
const supportsSharedCancellation = (): boolean => typeof SharedArrayBuffer !== 'undefined'

export const canUseTreeSitterWorker = (): boolean => supportsWorkers()

export class TreeSitterWorkerClient implements TreeSitterBackend {
  private worker: Worker | null = null
  private nextRequestId = 1
  private nextGeneration = 1
  private workerGeneration = 0
  private lifecycle: TreeSitterWorkerLifecycleState = 'idle'
  private lastError: Error | null = null
  private initPromise: Promise<void> | null = null
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly sourceChunkRetention = new TreeSitterSourceChunkRetention()
  private readonly registeredLanguageSignatures = new Map<TreeSitterLanguageId, string>()

  public inspect(): TreeSitterWorkerOwnerSnapshot {
    return {
      lifecycle: this.lifecycle,
      pendingRequests: this.pendingRequests.size,
      workerGeneration: this.workerGeneration,
      cache: {
        registeredLanguages: this.registeredLanguageSignatures.size,
        sourceChunks: this.sourceChunkRetention.inspect(),
      },
      lastError: this.lastError?.message ?? null,
    }
  }

  public async registerLanguages(
    languages: readonly TreeSitterLanguageDescriptor[],
  ): Promise<void> {
    const nextLanguages = this.unregisteredLanguages(languages)
    if (nextLanguages.length === 0) return

    const handle = await this.ensureWorkerReady()
    if (!handle) return

    await this.postRequest({ type: 'registerLanguages', languages: nextLanguages })
    for (const language of nextLanguages) {
      this.registeredLanguageSignatures.set(language.id, languageDescriptorSignature(language))
    }
  }

  public parse(
    payload: TreeSitterParseOnlyPayload,
  ): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
  public parse(payload: TreeSitterParsePayload): Promise<TreeSitterParseResult | undefined>
  public parse(
    payload: TreeSitterBackendParsePayload,
  ): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
  public async parse(
    payload: TreeSitterBackendParsePayload,
  ): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined> {
    const handle = await this.ensureWorkerReady()
    if (!handle) return undefined
    const source = this.createSourceDescriptor(payload.runtimeSessionId, payload.snapshot)
    const request: TreeSitterParseDocumentRequest = {
      type: 'parse',
      documentId: payload.documentId,
      runtimeSessionId: payload.runtimeSessionId,
      snapshotVersion: payload.snapshotVersion,
      languageId: payload.languageId,
      includeHighlights: payload.includeHighlights ?? true,
      includeCaptures: payload.includeCaptures,
      resultMode: payload.resultMode,
      source,
    }
    const result = await this.postDocumentRequest(request)
    if (isTreeSitterParseResult(result)) return result
    if (isTreeSitterParseAckResult(result)) return result
    return undefined
  }

  public edit(
    payload: TreeSitterEditOnlyPayload,
  ): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
  public edit(payload: TreeSitterEditPayload): Promise<TreeSitterParseResult | undefined>
  public edit(
    payload: TreeSitterBackendEditPayload,
  ): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
  public async edit(
    payload: TreeSitterBackendEditPayload,
  ): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined> {
    const handle = await this.ensureWorkerReady()
    if (!handle) return undefined
    const source = this.createSourceDescriptor(payload.runtimeSessionId, payload.snapshot)
    const result = await this.postDocumentRequest({
      type: 'edit',
      documentId: payload.documentId,
      runtimeSessionId: payload.runtimeSessionId,
      previousSnapshotVersion: payload.previousSnapshotVersion,
      snapshotVersion: payload.snapshotVersion,
      languageId: payload.languageId,
      includeHighlights: payload.includeHighlights,
      includeCaptures: payload.includeCaptures,
      resultMode: payload.resultMode,
      source,
      edits: payload.edits,
      inputEdits: payload.inputEdits,
    })
    if (isTreeSitterParseResult(result)) return result
    if (isTreeSitterParseAckResult(result)) return result
    return undefined
  }

  public async queryRange(
    payload: TreeSitterRangePayload,
  ): Promise<TreeSitterRangeResult | undefined> {
    const handle = await this.ensureWorkerReady()
    if (!handle) return undefined
    const result = await this.postRangeRequest({
      type: 'queryRange',
      documentId: payload.documentId,
      runtimeSessionId: payload.runtimeSessionId,
      snapshotVersion: payload.snapshotVersion,
      languageId: payload.languageId,
      includeHighlights: payload.includeHighlights ?? true,
      includeCaptures: payload.includeCaptures,
      range: payload.range,
    })
    return isTreeSitterRangeResult(result) ? result : undefined
  }

  public async select(
    payload: TreeSitterSelectionPayload,
  ): Promise<TreeSitterSelectionResult | undefined> {
    const handle = await this.ensureWorkerReady()
    if (!handle) return undefined
    const result = await this.postRequest({ type: 'selection', ...payload })
    return isTreeSitterSelectionResult(result) ? result : undefined
  }

  public disposeDocument(runtimeSessionId: string): void {
    this.cancelRuntimeRequests(runtimeSessionId)
    this.sourceChunkRetention.invalidateDocument(runtimeSessionId)
    void this.postRequest({ type: 'disposeDocument', runtimeSessionId }, false).catch(
      () => undefined,
    )
  }

  public awaitRuntimeSessionIdle(runtimeSessionId: string): Promise<void> {
    if (!this.worker) return Promise.resolve()
    return this.postRequest({ type: 'runtimeBarrier', runtimeSessionId }, false).then(
      () => undefined,
    )
  }

  public awaitIdleFence(): Promise<void> {
    if (!this.worker) return Promise.resolve()
    return this.postRequest({ type: 'idleFence' }, false).then(() => undefined)
  }

  public async dispose(): Promise<void> {
    const handle = this.worker
    if (!handle) {
      this.clearRetainedState('disposed')
      return
    }

    this.lifecycle = 'disposing'
    try {
      await this.postRequest({ type: 'dispose' }, false)
    } finally {
      handle.terminate()
      if (this.worker === handle) this.worker = null
      this.clearRetainedState('disposed')
      this.rejectPendingRequests(new Error('Tree-sitter worker disposed'))
    }
  }

  private getWorker(): Worker | null {
    if (!supportsWorkers()) return null
    if (this.worker) return this.worker

    const handle = new Worker(new URL('./treeSitter.worker.ts', import.meta.url), {
      type: 'module',
    })
    handle.onmessage = (event) => this.handleWorkerMessage(event)
    handle.onerror = (event) => this.handleWorkerError(handle, event)
    this.worker = handle
    this.workerGeneration += 1
    this.lifecycle = 'initializing'
    this.lastError = null
    return handle
  }

  private async ensureWorkerReady(): Promise<Worker | null> {
    const handle = this.getWorker()
    if (!handle) return null

    if (!this.initPromise) {
      this.initPromise = this.postRequest({ type: 'init' }).then(() => {
        if (this.worker === handle) this.lifecycle = 'ready'
      })
    }

    await this.initPromise
    return handle
  }

  private postRequest(
    payload: TreeSitterWorkerRequestPayload,
    createIfMissing = true,
  ): Promise<TreeSitterWorkerResult> {
    const handle = createIfMissing ? this.getWorker() : this.worker
    if (!handle) return Promise.resolve(undefined)

    const id = this.nextRequestId
    this.nextRequestId += 1
    const request: TreeSitterWorkerRequest = { id, payload }
    markEditorWorkerRequest('tree-sitter', payload.type)

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        runtimeSessionId: runtimeSessionIdForPayload(payload),
        cancellationFlag: cancellationFlagForPayload(payload),
        payload,
        sourceRequest: this.sourceRequestForPayload(payload),
        resolve,
        reject,
      })
      try {
        handle.postMessage(request)
      } catch (error) {
        this.pendingRequests.delete(id)
        reject(workerRequestError(error))
      }
    })
  }

  private postDocumentRequest(
    payload: TreeSitterParseDocumentRequest | TreeSitterEditDocumentRequest,
  ): Promise<TreeSitterWorkerResult> {
    return this.postRequest(
      this.withCancellation(this.cancelPreviousDocumentRequests(payload.runtimeSessionId), payload),
    )
  }

  private postRangeRequest(
    payload: TreeSitterRangeDocumentRequest,
  ): Promise<TreeSitterWorkerResult> {
    return this.postRequest(
      this.withCancellation(this.cancelPreviousRangeRequests(payload.runtimeSessionId), payload),
    )
  }

  private cancelPreviousDocumentRequests(runtimeSessionId: string): Int32Array | null {
    const cancellationFlag = this.createCancellationFlag()
    for (const pending of this.pendingRequests.values()) {
      if (pending.runtimeSessionId !== runtimeSessionId) continue
      if (pending.cancellationFlag) Atomics.store(pending.cancellationFlag, 0, 1)
    }

    return cancellationFlag
  }

  private cancelPreviousRangeRequests(runtimeSessionId: string): Int32Array | null {
    const cancellationFlag = this.createCancellationFlag()
    for (const pending of this.pendingRequests.values()) {
      if (pending.runtimeSessionId !== runtimeSessionId) continue
      if (pending.payload.type !== 'queryRange') continue
      if (pending.cancellationFlag) Atomics.store(pending.cancellationFlag, 0, 1)
    }

    return cancellationFlag
  }

  private cancelRuntimeRequests(runtimeSessionId: string): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.runtimeSessionId !== runtimeSessionId) continue
      if (pending.cancellationFlag) Atomics.store(pending.cancellationFlag, 0, 1)
    }
  }

  private createCancellationFlag(): Int32Array | null {
    if (!supportsSharedCancellation()) return null
    return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  }

  private withCancellation<
    TPayload extends
      | TreeSitterParseDocumentRequest
      | TreeSitterEditDocumentRequest
      | TreeSitterRangeDocumentRequest,
  >(
    cancellationFlag: Int32Array | null,
    payload: TPayload,
  ): TPayload & { readonly generation: number; readonly cancellationBuffer?: SharedArrayBuffer } {
    const generation = this.nextGeneration
    this.nextGeneration += 1
    if (!cancellationFlag) return { ...payload, generation }
    return {
      ...payload,
      generation,
      cancellationBuffer: cancellationFlag.buffer as SharedArrayBuffer,
    }
  }

  private handleWorkerMessage(event: MessageEvent<TreeSitterWorkerResponse>): void {
    const response = event.data
    const pending = this.pendingRequests.get(response.id)
    if (!pending) return

    this.pendingRequests.delete(response.id)
    if (response.ok) {
      this.sourceChunkRetention.markRequestSent(pending.sourceRequest)
      pending.resolve(response.result)
      return
    }

    if (pending.runtimeSessionId && shouldInvalidateDocumentSourceState(response.error)) {
      this.sourceChunkRetention.invalidateDocument(pending.runtimeSessionId)
    }
    pending.reject(new Error(response.error))
  }

  private handleWorkerError(failedWorker: Worker, event: ErrorEvent): void {
    if (failedWorker !== this.worker) return

    const error = new Error(event.message || 'Tree-sitter worker failed')
    failedWorker.terminate()
    this.worker = null
    this.lifecycle = 'crashed'
    this.lastError = error
    this.rejectPendingRequests(error)
    this.clearRetainedState('crashed')
  }

  private rejectPendingRequests(error: Error): void {
    for (const request of this.pendingRequests.values()) request.reject(error)
    this.pendingRequests.clear()
  }

  private shouldRegisterLanguageWithWorker(language: TreeSitterLanguageDescriptor): boolean {
    return (
      this.registeredLanguageSignatures.get(language.id) !== languageDescriptorSignature(language)
    )
  }

  private unregisteredLanguages(
    languages: readonly TreeSitterLanguageDescriptor[],
  ): readonly TreeSitterLanguageDescriptor[] {
    const nextLanguages: TreeSitterLanguageDescriptor[] = []
    const nextSignatures = new Map<TreeSitterLanguageId, string>()

    for (const language of languages) {
      if (!this.shouldRegisterLanguageWithWorker(language)) continue

      const signature = languageDescriptorSignature(language)
      if (nextSignatures.get(language.id) === signature) continue

      nextSignatures.set(language.id, signature)
      nextLanguages.push(language)
    }

    return nextLanguages
  }

  private createSourceDescriptor(documentId: string, snapshot: PieceTableSnapshot) {
    return this.sourceChunkRetention.createDescriptor(documentId, snapshot)
  }

  private sourceRequestForPayload(
    payload: TreeSitterWorkerRequestPayload,
  ): TreeSitterSourceChunkRequest | null {
    if (!('source' in payload)) return null
    return this.sourceChunkRetention.createRequest(payload.runtimeSessionId, payload.source)
  }

  private clearRetainedState(lifecycle: TreeSitterWorkerLifecycleState): void {
    this.lifecycle = lifecycle
    this.initPromise = null
    this.registeredLanguageSignatures.clear()
    this.sourceChunkRetention.clear()
  }
}

export const createTreeSitterWorkerBackend = (): TreeSitterBackend => new TreeSitterWorkerClient()

function languageDescriptorSignature(language: TreeSitterLanguageDescriptor): string {
  return JSON.stringify({
    aliases: sortedItems(language.aliases),
    extensions: sortedItems(language.extensions),
    foldQuerySource: language.foldQuerySource,
    highlightQuerySource: language.highlightQuerySource,
    id: language.id,
    injectionQuerySource: language.injectionQuerySource,
    wasmUrl: language.wasmUrl,
  })
}

function sortedItems(items: readonly string[]): readonly string[] {
  return items.toSorted()
}

const runtimeSessionIdForPayload = (payload: TreeSitterWorkerRequestPayload): string | null => {
  if ('runtimeSessionId' in payload) return payload.runtimeSessionId
  return null
}

const cancellationFlagForPayload = (payload: TreeSitterWorkerRequestPayload): Int32Array | null => {
  if (!('cancellationBuffer' in payload)) return null
  if (!payload.cancellationBuffer) return null
  return new Int32Array(payload.cancellationBuffer)
}

const shouldInvalidateDocumentSourceState = (error: string): boolean => {
  if (error.includes('Tree-sitter source chunk')) return true
  if (error.includes('Tree-sitter resolve source failed')) return true
  return error.includes('Tree-sitter cache miss')
}

const workerRequestError = (error: unknown): Error => {
  if (error instanceof Error) return error
  return new Error(String(error))
}

function markEditorWorkerRequest(family: string, type: string): void {
  const traceGlobal = globalThis as typeof globalThis & { readonly __editorPerfTrace?: unknown }
  if (!traceGlobal.__editorPerfTrace) return

  globalThis.performance?.mark('editor.worker.request', { detail: { family, type } })
}

const isTreeSitterParseResult = (result: TreeSitterWorkerResult): result is TreeSitterParseResult =>
  Boolean(result && 'captures' in result && 'folds' in result)

const isTreeSitterParseAckResult = (
  result: TreeSitterWorkerResult,
): result is TreeSitterParseAckResult =>
  Boolean(result && 'status' in result && result.status === 'parsed')

const isTreeSitterRangeResult = (result: TreeSitterWorkerResult): result is TreeSitterRangeResult =>
  Boolean(result && 'range' in result && 'tokens' in result)

const isTreeSitterSelectionResult = (
  result: TreeSitterWorkerResult,
): result is TreeSitterSelectionResult =>
  Boolean(result && 'status' in result && 'ranges' in result)
