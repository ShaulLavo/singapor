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
import type { EditorTheme } from '../theme'
import type {
  ShikiWorkerDocumentOptions,
  ShikiWorkerRequest,
  ShikiWorkerRequestPayload,
  ShikiWorkerResponse,
  ShikiWorkerResult,
  ShikiWorkerThemeRegistration,
  ShikiWorkerTransportResult,
} from './workerTypes'

export type ShikiHighlighterSessionOptions = Omit<
  EditorHighlighterSessionOptions,
  'textSnapshot'
> & {
  readonly textSnapshot?: DocumentTextSnapshot
  readonly lang: string
  readonly theme: string
  readonly themeRegistration?: ShikiWorkerThemeRegistration
  readonly langs?: readonly string[]
  readonly themes?: readonly string[]
}

export type ShikiThemeOptions = {
  readonly theme: string
  readonly themeRegistration?: ShikiWorkerThemeRegistration
  readonly themes?: readonly string[]
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
  private nextRequestId = 1
  private workerGeneration = 0
  private lifecycle: ShikiWorkerLifecycleState = 'idle'
  private lastError: Error | null = null
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly themeRequests = new Map<string, Promise<EditorTheme | null | undefined>>()

  public constructor(private readonly options: ShikiWorkerOwnerOptions = {}) {}

  public canUseWorker(): boolean {
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
    return new ShikiHighlighterSession(options, this)
  }

  public async loadTheme(options: ShikiThemeOptions): Promise<EditorTheme | null | undefined> {
    if (!this.canUseWorker()) return undefined

    const key = shikiThemeRequestKey(options)
    const existing = this.themeRequests.get(key)
    if (existing) return existing

    const request = requestShikiTheme(this, options).catch((error) => {
      this.themeRequests.delete(key)
      throw error
    })
    this.themeRequests.set(key, request)
    return request
  }

  public request(payload: ShikiWorkerRequestPayload): Promise<ShikiWorkerResult | undefined> {
    return this.postRequest(payload, true)
  }

  public disposeDocument(documentId: string): void {
    if (!this.worker) return

    void this.postRequest({ type: 'disposeDocument', documentId }, false).catch(() => undefined)
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
      this.rejectPendingRequests(new Error('Shiki worker disposed'))
    }
  }

  private getWorker(createIfMissing: boolean): Worker | null {
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
  private readonly lang: string
  private readonly theme: string
  private readonly themeRegistration: ShikiWorkerThemeRegistration | undefined
  private readonly langs: readonly string[]
  private readonly themes: readonly string[]
  private snapshot: PieceTableSnapshot
  private textSnapshot: DocumentTextSnapshot
  private opened = false
  private disposed = false
  private task: Promise<void> = Promise.resolve()

  public constructor(
    options: ShikiHighlighterSessionOptions,
    private readonly owner: ShikiWorkerOwner,
  ) {
    this.documentId = options.documentId
    this.lang = options.lang
    this.theme = options.theme
    this.themeRegistration = options.themeRegistration
    this.langs = options.langs ?? []
    this.themes = options.themes ?? []
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
      const textSnapshot = createDocumentTextSnapshot(snapshot, fullText)
      const documentText = textSnapshot.materializeFullText()
      const result = await this.owner.request({
        type: 'open',
        ...this.documentOptions(documentText),
        text: documentText,
      })
      if (this.disposed) return emptyHighlightResult()

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
      const nextTextSnapshot = documentSessionChangeTextSnapshot(change)
      const payload = this.editPayloadForChange(change, nextTextSnapshot)
      const result = await this.owner.request(payload)
      if (this.disposed) return emptyHighlightResult()

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
    this.owner.disposeDocument(this.documentId)
  }

  private enqueueRequest(
    run: () => Promise<EditorHighlightResult>,
  ): Promise<EditorHighlightResult> {
    const result = this.task.then(run, run)
    this.task = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private editPayloadForChange(
    change: DocumentSessionChange,
    nextTextSnapshot: DocumentTextSnapshot,
  ): ShikiWorkerRequestPayload {
    const edit = incrementalEditForChange(this.snapshot, change)
    if (edit && this.opened && !this.disposed) {
      return {
        type: 'edit',
        ...this.documentOptions(),
        edit,
      }
    }

    const text = nextTextSnapshot.materializeFullText()
    const fallbackEdit =
      createTextDiffEdit(this.textSnapshot.materializeFullText(), text) ?? undefined
    return {
      type: 'edit',
      ...this.documentOptions(text),
      edit: fallbackEdit,
    }
  }

  private documentOptions(text?: string): ShikiWorkerDocumentOptions {
    return {
      documentId: this.documentId,
      lang: this.lang,
      theme: this.theme,
      themeRegistration: this.themeRegistration,
      text,
      langs: this.langs,
      themes: this.themes,
    }
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
  options: ShikiThemeOptions,
): Promise<EditorTheme | null | undefined> {
  const result = await owner.request({
    type: 'theme',
    theme: options.theme,
    themeRegistration: options.themeRegistration,
    themes: options.themes ?? [],
  })
  return result?.theme
}

function shikiThemeRequestKey(options: ShikiThemeOptions): string {
  return JSON.stringify({
    theme: options.theme,
    themeRegistration: themeRegistrationKey(options.themeRegistration),
    themes: (options.themes ?? []).toSorted(),
  })
}

function themeRegistrationKey(registration: ShikiWorkerThemeRegistration | undefined): string {
  if (!registration) return ''
  if (!registration.name) {
    throw new Error('Shiki theme registrations require a non-empty name')
  }
  return registration.name
}

function workerRequestError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}
