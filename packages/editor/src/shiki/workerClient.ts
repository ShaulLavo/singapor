import { documentSessionChangeTextSnapshot, type DocumentSessionChange } from '../documentSession'
import { createDocumentTextSnapshot, type DocumentTextSnapshot } from '../documentTextSnapshot'
import { applyBatchToPieceTable } from '../pieceTable/edits'
import { pieceTableSnapshotsHaveSameText } from '../pieceTable/reads'
import type { PieceTableSnapshot } from '../pieceTable/pieceTableTypes'
import { unpackEditorTokens } from '../syntax/packedTokens'
import type {
  EditorHighlightResult,
  EditorHighlighterSession,
  EditorHighlighterSessionOptions,
} from '../plugins'
import { createEditorRuntimeSessionId } from '../syntax/session'
import type { EditorTheme } from '../theme'
import type {
  ShikiWorkerDocumentOptions,
  ShikiWorkerLanguageRegistration,
  ShikiWorkerRequest,
  ShikiWorkerRequestPayload,
  ShikiWorkerResponse,
  ShikiWorkerResult,
  ShikiWorkerThemeRegistration,
  ShikiWorkerTransportResult,
} from './workerTypes'

export type ShikiResolvedRegistrations = {
  readonly languageRegistrations: readonly ShikiWorkerLanguageRegistration[]
  readonly themeRegistration: ShikiWorkerThemeRegistration
  readonly themeRegistrations: readonly ShikiWorkerThemeRegistration[]
}

export type ShikiPreloadRegistrations = {
  readonly languageRegistrations: readonly ShikiWorkerLanguageRegistration[]
  readonly themeRegistrations: readonly ShikiWorkerThemeRegistration[]
}

export type ShikiPreloadRegistrationSource =
  | ShikiPreloadRegistrations
  | Promise<ShikiPreloadRegistrations>
  | (() => Promise<ShikiPreloadRegistrations> | ShikiPreloadRegistrations)

export type ShikiHighlighterSessionOptions = Omit<
  EditorHighlighterSessionOptions,
  'textSnapshot'
> & {
  readonly textSnapshot?: DocumentTextSnapshot
  readonly lang: string
  readonly theme: string
  readonly registrations: Promise<ShikiResolvedRegistrations> | ShikiResolvedRegistrations
  readonly preloadRegistrations?: ShikiPreloadRegistrationSource
}

export type ShikiThemeOptions = {
  readonly theme: string
  readonly registrations: Promise<ShikiResolvedRegistrations> | ShikiResolvedRegistrations
  readonly preloadRegistrations?: ShikiPreloadRegistrationSource
}

type PendingRequest = {
  readonly resolve: (result: ShikiWorkerResult | undefined) => void
  readonly reject: (error: Error) => void
}

const supportsWorkers = (): boolean => typeof Worker !== 'undefined'

export type ShikiWorkerLifecycleState = 'idle' | 'ready' | 'disposing' | 'disposed' | 'crashed'

export type ShikiWorkerCacheSnapshot = {
  readonly themeRequests: number
}

export type ShikiWorkerOwnerSnapshot = {
  readonly lifecycle: ShikiWorkerLifecycleState
  readonly pendingRequests: number
  readonly cache: ShikiWorkerCacheSnapshot
  readonly workerGeneration: number
  readonly lastError: string | null
}

export type ShikiWorkerOwnerOptions = {
  readonly workerFactory?: () => Worker
  readonly onError?: (error: Error) => void
}

export const canUseShikiWorker = (): boolean => supportsWorkers()

export function createShikiWorkerOwner(options: ShikiWorkerOwnerOptions = {}): ShikiWorkerOwner {
  return new ShikiWorkerOwner(options)
}

export class ShikiWorkerOwner {
  private worker: Worker | null = null
  private disposeTask: Promise<void> | null = null
  private nextRequestId = 1
  private workerGeneration = 0
  private lifecycle: ShikiWorkerLifecycleState = 'idle'
  private lastError: Error | null = null
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly clientTasks = new Set<Promise<unknown>>()
  private readonly runtimeTasks = new Map<string, Set<Promise<unknown>>>()
  private readonly themeRequests = new Map<string, Promise<EditorTheme | null | undefined>>()

  public constructor(private readonly options: ShikiWorkerOwnerOptions = {}) {}

  public canUseWorker(): boolean {
    if (this.lifecycle === 'disposing' || this.lifecycle === 'disposed') return false
    return Boolean(this.options.workerFactory) || supportsWorkers()
  }

  public inspect(): ShikiWorkerOwnerSnapshot {
    return {
      lifecycle: this.lifecycle,
      pendingRequests: this.pendingRequests.size,
      cache: { themeRequests: this.themeRequests.size },
      workerGeneration: this.workerGeneration,
      lastError: this.lastError?.message ?? null,
    }
  }

  public createSession(options: ShikiHighlighterSessionOptions): EditorHighlighterSession | null {
    if (!this.canUseWorker()) return null
    return new ShikiHighlighterSession(options, this, (runtimeSessionId, task) =>
      this.trackRuntimeTask(runtimeSessionId, task),
    )
  }

  public loadTheme(options: ShikiThemeOptions): Promise<EditorTheme | null | undefined> {
    if (!this.canUseWorker()) return Promise.resolve(undefined)

    return this.trackClientTask(this.finishLoadTheme(options))
  }

  private async finishLoadTheme(
    options: ShikiThemeOptions,
  ): Promise<EditorTheme | null | undefined> {
    const registrations = await options.registrations
    if (!this.canUseWorker()) return undefined

    const key = shikiThemeRequestKey(options.theme, registrations)
    const existing = this.themeRequests.get(key)
    if (existing) return existing

    const request = requestShikiTheme(this, options.theme, registrations).catch((error) => {
      this.themeRequests.delete(key)
      throw error
    })
    this.themeRequests.set(key, request)
    const theme = await request
    const preload = scheduleRegistrationPreload(this, options.preloadRegistrations)
    if (preload) this.trackClientTask(preload)
    return theme
  }

  public request(payload: ShikiWorkerRequestPayload): Promise<ShikiWorkerResult | undefined> {
    const request = this.postRequest(payload, true)
    if ('runtimeSessionId' in payload) {
      return this.trackRuntimeTask(payload.runtimeSessionId, request)
    }
    return this.trackClientTask(request)
  }

  public preload(registrations: ShikiPreloadRegistrations): Promise<void> {
    return this.trackClientTask(
      this.postRequest(
        {
          type: 'preload',
          languageRegistrations: registrations.languageRegistrations,
          themeRegistrations: registrations.themeRegistrations,
        },
        false,
      ).then(() => undefined),
    )
  }

  public disposeDocument(runtimeSessionId: string): Promise<void> {
    if (!this.worker) return Promise.resolve()

    return this.trackRuntimeTask(
      runtimeSessionId,
      this.postRequest({ type: 'disposeDocument', runtimeSessionId }, false).then(() => undefined),
    )
  }

  public async awaitRuntimeSessionIdle(runtimeSessionId: string): Promise<void> {
    await this.awaitRuntimeTasks(runtimeSessionId)
    if (!this.worker) return

    await this.postRequest({ type: 'runtimeBarrier', runtimeSessionId }, false)
  }

  public async awaitIdleFence(): Promise<void> {
    await this.awaitClientTasks()
    if (!this.worker) return

    await this.postRequest({ type: 'idleFence' }, false)
  }

  public dispose(): Promise<void> {
    if (this.disposeTask) return this.disposeTask

    this.lifecycle = 'disposing'
    this.disposeTask = this.finishDispose()
    return this.disposeTask
  }

  private async finishDispose(): Promise<void> {
    const handle = this.worker
    if (!handle) {
      this.clearRetainedState('disposed')
      return
    }

    try {
      await this.postRequest({ type: 'dispose' }, false)
    } finally {
      handle.terminate()
      if (this.worker === handle) this.worker = null
      this.clearRetainedState('disposed')
      this.rejectPendingRequests(new Error('Shiki worker disposed'))
    }
  }

  private getWorker(createIfMissing: boolean): Worker | null {
    if (createIfMissing && (this.lifecycle === 'disposing' || this.lifecycle === 'disposed')) {
      return null
    }
    if (this.worker) return this.worker
    if (!createIfMissing) return null
    if (!this.canUseWorker()) return null

    const handle = this.createWorker()
    this.worker = handle
    this.workerGeneration += 1
    this.lifecycle = 'ready'
    this.lastError = null
    return handle
  }

  private createWorker(): Worker {
    const handle =
      this.options.workerFactory?.() ??
      new Worker(new URL('./shiki.worker.ts', import.meta.url), { type: 'module' })
    handle.onmessage = this.handleWorkerMessage
    handle.onerror = (event) => this.handleWorkerError(handle, event)
    return handle
  }

  private postRequest(
    payload: ShikiWorkerRequestPayload,
    createIfMissing: boolean,
  ): Promise<ShikiWorkerResult | undefined> {
    const handle = this.getWorker(createIfMissing)
    if (!handle) return Promise.resolve(undefined)

    const id = this.nextRequestId
    this.nextRequestId += 1
    const request: ShikiWorkerRequest = { id, payload }
    markEditorWorkerRequest('shiki', payload.type)

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
      try {
        handle.postMessage(request)
      } catch (error) {
        this.pendingRequests.delete(id)
        reject(workerRequestError(error))
      }
    })
  }

  private readonly handleWorkerMessage = (event: MessageEvent<ShikiWorkerResponse>): void => {
    const response = event.data
    const pending = this.pendingRequests.get(response.id)
    if (!pending) return

    this.pendingRequests.delete(response.id)
    if (response.ok) {
      pending.resolve(unpackShikiWorkerResult(response.result))
      return
    }

    pending.reject(new Error(response.error))
  }

  private handleWorkerError(failedWorker: Worker, event: ErrorEvent): void {
    if (failedWorker !== this.worker) return

    const error = new Error(event.message || 'Shiki worker failed')
    this.lastError = error
    this.lifecycle = 'crashed'
    this.themeRequests.clear()
    this.rejectPendingRequests(error)
    failedWorker.terminate()
    this.worker = null
    this.options.onError?.(error)
  }

  private rejectPendingRequests(error: Error): void {
    for (const request of this.pendingRequests.values()) request.reject(error)
    this.pendingRequests.clear()
  }

  private clearRetainedState(lifecycle: ShikiWorkerLifecycleState): void {
    this.lifecycle = lifecycle
    this.themeRequests.clear()
  }

  private trackClientTask<T>(task: Promise<T>): Promise<T> {
    this.clientTasks.add(task)
    void task.finally(() => this.clientTasks.delete(task)).catch(() => undefined)
    return task
  }

  private trackRuntimeTask<T>(runtimeSessionId: string, task: Promise<T>): Promise<T> {
    const tasks = this.runtimeTasks.get(runtimeSessionId) ?? new Set<Promise<unknown>>()
    tasks.add(task)
    this.runtimeTasks.set(runtimeSessionId, tasks)
    this.trackClientTask(task)
    void task
      .finally(() => {
        tasks.delete(task)
        if (tasks.size === 0) this.runtimeTasks.delete(runtimeSessionId)
      })
      .catch(() => undefined)
    return task
  }

  private async awaitClientTasks(): Promise<void> {
    while (this.clientTasks.size > 0) {
      await Promise.allSettled(this.clientTasks)
    }
  }

  private async awaitRuntimeTasks(runtimeSessionId: string): Promise<void> {
    while (this.runtimeTasks.has(runtimeSessionId)) {
      const tasks = this.runtimeTasks.get(runtimeSessionId)
      if (!tasks) return

      await Promise.allSettled(tasks)
    }
  }
}

function unpackShikiWorkerResult(
  result: ShikiWorkerTransportResult | undefined,
): ShikiWorkerResult | undefined {
  if (!result?.tokensPacked) return result

  return {
    documentId: result.documentId,
    tokens: unpackEditorTokens(result.tokensPacked),
    theme: result.theme,
  }
}

class ShikiHighlighterSession implements EditorHighlighterSession {
  private readonly documentId: string
  private readonly runtimeSessionId: string
  private readonly lang: string
  private readonly theme: string
  private readonly registrations: Promise<ShikiResolvedRegistrations>
  private readonly preloadRegistrations: ShikiPreloadRegistrationSource | null
  private snapshot: PieceTableSnapshot
  private textSnapshot: DocumentTextSnapshot
  private preloadScheduled = false
  private opened = false
  private disposed = false
  private task: Promise<void> = Promise.resolve()

  public constructor(
    options: ShikiHighlighterSessionOptions,
    private readonly owner: ShikiWorkerOwner,
    private readonly trackTask: <T>(runtimeSessionId: string, task: Promise<T>) => Promise<T>,
  ) {
    this.documentId = options.documentId
    this.runtimeSessionId = options.runtimeSessionId ?? createEditorRuntimeSessionId()
    this.lang = options.lang
    this.theme = options.theme
    this.registrations = Promise.resolve(options.registrations)
    this.preloadRegistrations = options.preloadRegistrations ?? null
    this.snapshot = options.snapshot
    this.textSnapshot =
      options.textSnapshot ?? createDocumentTextSnapshot(options.snapshot, options.fullText)
  }

  public async refresh(
    snapshot: ShikiHighlighterSessionOptions['snapshot'],
    fullText?: string,
  ): Promise<EditorHighlightResult> {
    if (this.disposed) return emptyHighlightResult()

    return this.enqueueRequest(async () => {
      if (this.disposed) return emptyHighlightResult()

      const textSnapshot = createDocumentTextSnapshot(snapshot, fullText)
      const documentText = textSnapshot.materializeFullText()
      const documentOptions = await this.documentOptions(documentText)
      if (this.disposed) return emptyHighlightResult()

      const result = await this.owner.request({
        type: 'open',
        ...documentOptions,
        text: documentText,
      })
      if (this.disposed) return emptyHighlightResult()

      this.schedulePreload()
      this.snapshot = snapshot
      this.textSnapshot = textSnapshot
      this.opened = true
      this.disposed = false
      return { tokens: result?.tokens ?? [], theme: result?.theme }
    })
  }

  public async applyChange(change: DocumentSessionChange): Promise<EditorHighlightResult> {
    if (this.disposed) return emptyHighlightResult()

    return this.enqueueRequest(async () => {
      if (this.disposed) return emptyHighlightResult()

      const nextTextSnapshot = documentSessionChangeTextSnapshot(change)
      const payload = await this.editPayloadForChange(change, nextTextSnapshot)
      if (this.disposed) return emptyHighlightResult()

      const result = await this.owner.request(payload)
      if (this.disposed) return emptyHighlightResult()

      this.schedulePreload()
      this.snapshot = change.snapshot
      this.textSnapshot = nextTextSnapshot
      this.opened = true
      this.disposed = false
      return { tokens: result?.tokens ?? [], theme: result?.theme }
    })
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.opened = false
    const dispose = this.task.then(
      () => this.owner.disposeDocument(this.runtimeSessionId),
      () => this.owner.disposeDocument(this.runtimeSessionId),
    )
    this.task = dispose.then(
      () => undefined,
      () => undefined,
    )
    this.trackTask(this.runtimeSessionId, this.task)
  }

  private enqueueRequest(
    run: () => Promise<EditorHighlightResult>,
  ): Promise<EditorHighlightResult> {
    const result = this.task.then(run, run)
    this.task = result.then(
      () => undefined,
      () => undefined,
    )
    this.trackTask(this.runtimeSessionId, this.task)
    return result
  }

  private async editPayloadForChange(
    change: DocumentSessionChange,
    nextTextSnapshot: DocumentTextSnapshot,
  ): Promise<ShikiWorkerRequestPayload> {
    const edit = incrementalEditForChange(this.snapshot, change)
    if (edit && this.opened && !this.disposed) {
      return {
        type: 'edit',
        ...(await this.documentOptions()),
        edit,
      }
    }

    const text = nextTextSnapshot.materializeFullText()
    const fallbackEdit =
      createTextDiffEdit(this.textSnapshot.materializeFullText(), text) ?? undefined
    return {
      type: 'edit',
      ...(await this.documentOptions(text)),
      edit: fallbackEdit,
    }
  }

  private async documentOptions(text?: string): Promise<ShikiWorkerDocumentOptions> {
    const registrations = await this.registrations
    return {
      documentId: this.documentId,
      runtimeSessionId: this.runtimeSessionId,
      lang: this.lang,
      theme: this.theme,
      languageRegistrations: registrations.languageRegistrations,
      themeRegistration: registrations.themeRegistration,
      themeRegistrations: registrations.themeRegistrations,
      text,
    }
  }

  private schedulePreload(): void {
    if (this.disposed) return
    if (this.preloadScheduled) return

    this.preloadScheduled = true
    const preload = scheduleRegistrationPreload(this.owner, this.preloadRegistrations)
    if (preload) this.trackTask(this.runtimeSessionId, preload)
  }
}

function emptyHighlightResult(): EditorHighlightResult {
  return { tokens: [] }
}

export const createTextDiffEdit = (previousText: string, nextText: string) => {
  if (previousText === nextText) return null

  let start = 0
  const maxPrefixLength = Math.min(previousText.length, nextText.length)
  while (start < maxPrefixLength && previousText[start] === nextText[start]) start += 1

  let previousEnd = previousText.length
  let nextEnd = nextText.length
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousText[previousEnd - 1] === nextText[nextEnd - 1]
  ) {
    previousEnd -= 1
    nextEnd -= 1
  }

  return {
    from: start,
    to: previousEnd,
    text: nextText.slice(start, nextEnd),
  }
}

const incrementalEditForChange = (snapshot: PieceTableSnapshot, change: DocumentSessionChange) => {
  if (change.edits.length !== 1) return null

  try {
    if (
      !pieceTableSnapshotsHaveSameText(
        applyBatchToPieceTable(snapshot, change.edits),
        change.snapshot,
      )
    ) {
      return null
    }
  } catch {
    return null
  }

  return change.edits[0] ?? null
}

async function requestShikiTheme(
  owner: ShikiWorkerOwner,
  theme: string,
  registrations: ShikiResolvedRegistrations,
): Promise<EditorTheme | null | undefined> {
  const result = await owner.request({
    type: 'theme',
    theme,
    themeRegistration: registrations.themeRegistration,
    themeRegistrations: registrations.themeRegistrations,
  })
  return result?.theme
}

function shikiThemeRequestKey(theme: string, registrations: ShikiResolvedRegistrations): string {
  return JSON.stringify({
    theme,
    themeRegistration: themeRegistrationKey(registrations.themeRegistration),
    themeRegistrations: registrations.themeRegistrations.map(themeRegistrationKey).toSorted(),
  })
}

function themeRegistrationKey(registration: ShikiWorkerThemeRegistration): string {
  if (!registration.name) {
    throw new Error('Shiki theme registrations require a non-empty name')
  }
  return JSON.stringify(registration)
}

function scheduleRegistrationPreload(
  owner: ShikiWorkerOwner,
  registrations: ShikiPreloadRegistrationSource | null | undefined,
): Promise<void> | null {
  if (!registrations) return null

  const resolved = typeof registrations === 'function' ? registrations() : registrations
  return Promise.resolve(resolved)
    .then((resolved) => owner.preload(resolved))
    .catch(() => undefined)
}

function workerRequestError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

function markEditorWorkerRequest(family: string, type: string): void {
  const traceGlobal = globalThis as typeof globalThis & { readonly __editorPerfTrace?: unknown }
  if (!traceGlobal.__editorPerfTrace) return

  globalThis.performance?.mark('editor.worker.request', { detail: { family, type } })
}
