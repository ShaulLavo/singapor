import type { DocumentSession, DocumentSessionChange } from '../documentSession'
import { defineLazyFullTextProperty, type DocumentTextSnapshot } from '../documentTextSnapshot'
import type { PieceTableSnapshot } from '../pieceTable/pieceTableTypes'
import type {
  EditorHighlightResult,
  EditorHighlighterSession,
  EditorLogInput,
  EditorPluginHost,
} from '../plugins'
import { createEmptySyntaxResult } from '../syntax/session'
import type {
  BracketInfo,
  EditorSyntaxCapture,
  EditorSyntaxRange,
  EditorSyntaxResult,
  EditorSyntaxSession,
} from '../syntax/session'
import type { EditorSyntaxLanguageId, FoldRange } from '../syntax/session'
import type { EditorTheme } from '../theme'
import { editorThemesEqual } from '../theme'
import type { EditorToken, TextEdit } from '../tokens'
import { foldRangeKey } from './folds'
import type { EditorSyntaxStatus } from './types'
import {
  appendEditorTokenIndexEntry,
  createEditorTokenIndexBuilder,
  finishEditorTokenIndex,
} from './tokenIndex'
import { LatestAsyncRequest } from './latestAsyncRequest'
import { getEditorSyntaxSessionFactory } from './runtime'
import { syntaxRefreshDelay, SYNTAX_REFRESH_MAX_DELAY_MS } from './editorUtils'

export type EditorSyntaxDocumentStartOptions = {
  readonly documentId: string
  readonly languageId: EditorSyntaxLanguageId | null
  readonly snapshot: PieceTableSnapshot
  readonly textSnapshot: DocumentTextSnapshot
}

export type EditorSyntaxControllerOptions = {
  readonly pluginHost: EditorPluginHost
  getDocumentVersion(): number
  getCurrentSessionDocumentId(): string
  getLanguageId(): EditorSyntaxLanguageId | null
  getSession(): DocumentSession | null
  getVisibleSyntaxRange(): EditorSyntaxRange | null
  adoptTokens(tokens: readonly EditorToken[]): void
  clearSyntaxFolds(): void
  setSyntaxFolds(folds: readonly FoldRange[]): void
  notifyChange(change: DocumentSessionChange | null): void
  setSyntaxCaptures?(captures: readonly EditorSyntaxCapture[]): void
  /**
   * Whether anything downstream reads raw captures. Captures cost payload on every parse, so a
   * session asks for them only while an inline replacement provider is registered to consume them.
   */
  needsSyntaxCaptures?(): boolean
  notifyThemeChanged(): void
  log?(event: EditorLogInput): void
}

export type EditorSyntaxRefreshOptions = {
  readonly delayMs?: number
  readonly range?: EditorSyntaxRange | null
}

type EditorSyntaxLoadResult = {
  readonly contentVersion: number
  readonly range: EditorSyntaxRange | null
  readonly result: EditorSyntaxResult
  readonly source: EditorSyntaxLoadSource
  readonly skipApply?: boolean
  readonly updatesDocument?: boolean
}

type EditorSyntaxLoadSource = 'full' | 'visible' | 'prefetch' | 'warm'

type PendingSyntaxPrefetch = {
  readonly contentVersion: number
  readonly documentVersion: number
  readonly options: EditorSyntaxRefreshOptions
  readonly range: EditorSyntaxRange
}

type PendingSyntaxWarm = {
  readonly contentVersion: number
  readonly delayMs: number
  readonly documentVersion: number
  readonly generation: number
  readonly seedRange: EditorSyntaxRange
}

type CachedSyntaxFoldRange = {
  readonly range: EditorSyntaxRange
  readonly folds: readonly FoldRange[]
}

const BACKGROUND_SYNTAX_TILE_CHARS = 120_000

const syntaxWorkTags = (
  documentVersion: number,
  contentVersion: number,
  source: EditorSyntaxLoadSource,
  range?: EditorSyntaxRange,
) => ({
  version: documentVersion,
  snapshotVersion: contentVersion,
  configuration: source,
  viewport: range ? `${range.startIndex}:${range.endIndex}` : null,
})

export class EditorSyntaxController {
  private disposed = false
  private syntaxStatus: EditorSyntaxStatus = 'plain'
  private syntaxSession: EditorSyntaxSession | null = null
  private syntaxSessionIncludesCaptures = false
  private highlighterSession: EditorHighlighterSession | null = null
  private providerHighlighterTheme: EditorTheme | null = null
  private highlighterTheme: EditorTheme | null = null
  private cachedSyntaxRanges: readonly EditorSyntaxRange[] = []
  private cachedSyntaxFoldRanges: readonly CachedSyntaxFoldRange[] = []
  private readonly syntaxRequests = new LatestAsyncRequest<EditorSyntaxLoadResult>({
    key: 'editor.syntax.document',
    taskClass: 'background-derived',
  })
  private readonly rangeRequests = new LatestAsyncRequest<EditorSyntaxLoadResult>({
    key: 'editor.syntax.visibleRange',
    taskClass: 'viewport-derived',
  })
  private readonly prefetchRangeRequests = new LatestAsyncRequest<EditorSyntaxLoadResult>({
    key: 'editor.syntax.prefetchRange',
    taskClass: 'idle-cache',
  })
  private readonly warmRangeRequests = new LatestAsyncRequest<EditorSyntaxLoadResult>({
    key: 'editor.syntax.warmRange',
    taskClass: 'idle-cache',
  })
  private readonly highlightRequests = new LatestAsyncRequest<EditorHighlightResult>({
    key: 'editor.syntax.highlight',
    taskClass: 'background-derived',
  })
  private readonly highlighterThemeRequests = new LatestAsyncRequest<
    EditorTheme | null | undefined
  >({
    key: 'editor.syntax.highlighterTheme',
    taskClass: 'background-derived',
  })
  private currentTokens: readonly EditorToken[] = []
  private currentBrackets: readonly BracketInfo[] = []
  private syntaxContentVersion = 0
  private parsedSyntaxContentVersion: number | null = null
  private pendingSyntaxContentVersion: number | null = null
  private pendingPrefetch: PendingSyntaxPrefetch | null = null
  private pendingWarm: PendingSyntaxWarm | null = null
  private warmGeneration = 0

  constructor(private readonly options: EditorSyntaxControllerOptions) {}

  get status(): EditorSyntaxStatus {
    return this.syntaxStatus
  }

  get tokens(): readonly EditorToken[] {
    return this.currentTokens
  }

  /**
   * Bracket positions from the last structural parse, sorted by offset. Empty while a windowed
   * parse is in flight, because a partial list would pair brackets across a hole it cannot see.
   */
  get brackets(): readonly BracketInfo[] {
    return this.currentBrackets
  }

  get providerTheme(): EditorTheme | null {
    return this.providerHighlighterTheme
  }

  get theme(): EditorTheme | null {
    return this.highlighterTheme
  }

  setTokens(tokens: readonly EditorToken[]): void {
    this.currentTokens = tokens
    this.options.adoptTokens(tokens)
  }

  startDocument(document: EditorSyntaxDocumentStartOptions): void {
    if (this.disposed) return

    this.disposeSyntaxSession()
    this.disposeHighlighterSession()
    this.clearSyntaxRangeCache()
    this.resetSyntaxContentVersion()
    this.currentBrackets = []
    this.highlighterSession = this.createHighlighterSession(
      document.documentId,
      document.languageId,
      document.textSnapshot,
      document.snapshot,
    )
    this.syntaxSession = this.createSyntaxSession(document)
    this.syntaxStatus = this.syntaxSession ? 'loading' : 'plain'
    this.logSyntaxStatus('editor.syntax.document_started')
  }

  clearDocument(): void {
    this.syntaxStatus = 'plain'
    this.clearSyntaxRangeCache()
    this.resetSyntaxContentVersion()
    this.disposeSyntaxSession()
    this.disposeHighlighterSession()
    this.logSyntaxStatus('editor.syntax.document_cleared')
  }

  dispose(): void {
    this.disposed = true
    this.highlighterThemeRequests.dispose()
    this.disposeSyntaxSession()
    this.disposeHighlighterSession()
  }

  /**
   * Reparses when the capture requirement flips. A provider that registers after the document
   * started — plugin activation is async — would otherwise wait for the next edit to see captures,
   * and the first one it ever gets is the one it needs to paint the file it was opened on.
   */
  syncCaptureRequirement(): void {
    if (this.disposed) return
    if ((this.options.needsSyntaxCaptures?.() ?? false) === this.syntaxSessionIncludesCaptures)
      return

    this.reloadSyntaxSession()
  }

  reloadHighlighterAndSyntax(): void {
    this.reloadHighlighterSession()
    this.reloadSyntaxSession()
  }

  reloadSyntaxSession(): void {
    // Plugin activation resolves async; a provider-changed callback can land
    // after dispose (StrictMode tears the editor down before tree-sitter
    // registers). Recreating a session then leaks an undisposed worker parse.
    if (this.disposed) return

    this.disposeSyntaxSession()
    this.clearSyntaxRangeCache()
    this.options.clearSyntaxFolds()

    const session = this.options.getSession()
    if (!session) return

    this.syntaxSession = this.createSyntaxSession({
      documentId: this.options.getCurrentSessionDocumentId(),
      languageId: this.options.getLanguageId(),
      textSnapshot: session.getTextSnapshot(),
      snapshot: session.getSnapshot(),
    })
    this.syntaxStatus = this.syntaxSession ? 'loading' : 'plain'
    this.logSyntaxStatus('editor.syntax.reloaded')
    this.refresh(this.options.getDocumentVersion(), null)
    this.options.notifyChange(null)
  }

  refreshHighlighterTheme(): void {
    if (!this.options.pluginHost.hasHighlighterProviders()) {
      this.setProviderHighlighterTheme(null)
      return
    }

    this.highlighterThemeRequests.schedule({
      tags: { configuration: 'highlighterTheme' },
      run: () => this.options.pluginHost.loadHighlighterTheme(),
      apply: (theme) => this.setProviderHighlighterTheme(theme),
      fail: () => this.setProviderHighlighterTheme(null),
    })
  }

  refresh(
    documentVersion: number,
    change: DocumentSessionChange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): void {
    if (!this.options.getSession()) return
    if (change && (change.kind === 'none' || change.kind === 'selection')) return

    this.options.log?.({
      action: 'editor.syntax.refresh_scheduled',
      level: 'debug',
      syntax: {
        changeKind: change?.kind ?? null,
        documentVersion,
        range: options.range ?? null,
      },
    })
    this.refreshStructuralSyntax(documentVersion, change, options)
    this.refreshHighlightTokens(documentVersion, change, options)
  }

  projectCacheForChange(change: DocumentSessionChange): void {
    if (change.kind === 'none' || change.kind === 'selection') return
    this.syntaxContentVersion += 1
    this.parsedSyntaxContentVersion = null
    this.projectSyntaxRangeCache(change)
  }

  refreshVisibleRange(documentVersion: number, options: EditorSyntaxRefreshOptions = {}): void {
    if (!this.syntaxSession?.queryRange) return
    if (!this.options.getSession()) return

    const range = options.range ?? this.options.getVisibleSyntaxRange()
    if (!range) return
    if (this.repaintCachedVisibleSyntaxRange(range)) return
    if (!this.canQueryCurrentSyntaxRange()) return

    this.scheduleSyntaxRangeRequest(this.rangeRequests, documentVersion, range, options, 'visible')
  }

  prefetchVisibleRange(
    documentVersion: number,
    range: EditorSyntaxRange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): boolean {
    if (!this.syntaxSession?.queryRange) return false
    if (!this.options.getSession()) return false
    if (!this.canQueryCurrentSyntaxRange()) return false
    if (!range || syntaxRangeCoverage(range, this.cachedSyntaxRanges) === 'full') return false
    if (this.rangeRequests.isActive()) {
      this.pendingPrefetch = {
        contentVersion: this.syntaxContentVersion,
        documentVersion,
        options,
        range,
      }
      return true
    }

    this.scheduleSyntaxRangeRequest(
      this.prefetchRangeRequests,
      documentVersion,
      range,
      options,
      'prefetch',
    )
    return true
  }

  warmSyntaxAroundRange(
    documentVersion: number,
    seedRange: EditorSyntaxRange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): void {
    if (!this.syntaxSession?.queryRange) return
    if (!this.options.getSession()) return
    if (!this.canQueryCurrentSyntaxRange()) return
    if (!seedRange) return

    const pendingWarm = {
      contentVersion: this.syntaxContentVersion,
      delayMs: options.delayMs ?? 120,
      documentVersion,
      generation: this.nextWarmGeneration(),
      seedRange,
    }
    this.pendingWarm = pendingWarm
    this.warmRangeRequests.cancel()
    this.scheduleNextWarmRange(pendingWarm)
  }

  private reloadHighlighterSession(): void {
    if (this.disposed) return

    this.disposeHighlighterSession()

    const session = this.options.getSession()
    if (!session) return

    this.highlighterSession = this.createHighlighterSession(
      this.options.getCurrentSessionDocumentId(),
      this.options.getLanguageId(),
      session.getTextSnapshot(),
      session.getSnapshot(),
    )
    this.refreshHighlighterTheme()
    this.refreshHighlightTokens(this.options.getDocumentVersion(), null)
  }

  private createSyntaxSession(
    document: EditorSyntaxDocumentStartOptions,
  ): EditorSyntaxSession | null {
    if (!document.languageId) return null

    const includeCaptures = this.options.needsSyntaxCaptures?.() ?? false
    this.syntaxSessionIncludesCaptures = includeCaptures
    const options = {
      documentId: document.documentId,
      languageId: document.languageId,
      includeHighlights: !this.highlighterSession,
      includeCaptures,
      syntaxMode: 'range' as const,
      textSnapshot: document.textSnapshot,
      snapshot: document.snapshot,
    }
    const sessionOptions = defineLazyFullTextProperty(options)
    return (
      this.options.pluginHost.createSyntaxSession(sessionOptions) ??
      getEditorSyntaxSessionFactory()?.(sessionOptions) ??
      null
    )
  }

  private createHighlighterSession(
    documentId: string,
    languageId: EditorSyntaxLanguageId | null,
    textSnapshot: DocumentTextSnapshot,
    snapshot: PieceTableSnapshot,
  ): EditorHighlighterSession | null {
    return this.options.pluginHost.createHighlighterSession(
      defineLazyFullTextProperty({
        documentId,
        languageId,
        textSnapshot,
        snapshot,
      }),
    )
  }

  private disposeSyntaxSession(): void {
    this.syntaxRequests.cancel()
    this.rangeRequests.cancel()
    this.prefetchRangeRequests.cancel()
    this.warmRangeRequests.cancel()
    this.pendingPrefetch = null
    this.pendingWarm = null
    this.clearSyntaxRangeCache()
    this.parsedSyntaxContentVersion = null
    this.pendingSyntaxContentVersion = null
    this.syntaxSession?.dispose()
    this.syntaxSession = null
    this.syntaxSessionIncludesCaptures = false
  }

  private scheduleSyntaxRangeRequest(
    request: LatestAsyncRequest<EditorSyntaxLoadResult>,
    documentVersion: number,
    range: EditorSyntaxRange,
    options: EditorSyntaxRefreshOptions,
    kind: 'visible' | 'prefetch',
  ): void {
    const contentVersion = this.syntaxContentVersion
    request.schedule({
      delayMs: options.delayMs ?? 50,
      tags: syntaxWorkTags(documentVersion, contentVersion, kind, range),
      run: () => this.loadSyntaxRangeResult(range, kind, { contentVersion }),
      apply: (result, startedAt) => {
        const applied = this.applySyntaxResult(result, documentVersion, startedAt)
        if (applied && kind === 'visible' && !this.flushPendingPrefetch()) {
          this.flushPendingWarm()
        }
        if (applied && kind === 'prefetch') this.flushPendingWarm()
      },
      fail: (error, startedAt) => this.recoverSyntaxError(documentVersion, null, error, startedAt),
    })
  }

  private repaintCachedVisibleSyntaxRange(range: EditorSyntaxRange): boolean {
    const coverage = syntaxRangeCoverage(range, this.cachedSyntaxRanges)
    if (coverage === 'none') return false

    this.options.adoptTokens(this.currentTokens)
    if (coverage === 'partial') return false

    this.rangeRequests.cancel()
    this.applyCachedSyntaxFolds(range)
    return true
  }

  private disposeHighlighterSession(): void {
    this.highlightRequests.cancel()
    this.highlighterSession?.dispose()
    this.highlighterSession = null
    this.setHighlighterTheme(null)
  }

  private refreshStructuralSyntax(
    documentVersion: number,
    change: DocumentSessionChange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): void {
    const session = this.options.getSession()
    if (!this.syntaxSession || !session || !this.options.getLanguageId()) return

    this.syntaxStatus = 'loading'
    const contentVersion = this.syntaxContentVersion
    this.pendingSyntaxContentVersion = contentVersion

    const delayMs = options.delayMs ?? syntaxRefreshDelay(change)
    this.syntaxRequests.schedule({
      delayMs,
      maxDelayMs: SYNTAX_REFRESH_MAX_DELAY_MS,
      tags: syntaxWorkTags(documentVersion, contentVersion, 'full'),
      run: () => this.loadSyntaxResult(change, contentVersion),
      apply: (result, startedAt) => this.applySyntaxResult(result, documentVersion, startedAt),
      fail: (error, startedAt) =>
        this.recoverSyntaxError(documentVersion, change, error, startedAt),
    })
  }

  private refreshHighlightTokens(
    documentVersion: number,
    change: DocumentSessionChange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): void {
    const session = this.options.getSession()
    if (!this.highlighterSession || !session) return

    const delayMs = options.delayMs ?? syntaxRefreshDelay(change)
    this.highlightRequests.schedule({
      delayMs,
      maxDelayMs: SYNTAX_REFRESH_MAX_DELAY_MS,
      tags: { version: documentVersion, configuration: 'highlight' },
      run: () => this.loadHighlightResult(change),
      apply: (result, startedAt) => this.applyHighlightResult(result, documentVersion, startedAt),
      fail: (_error, startedAt) =>
        this.recoverHighlightError(documentVersion, change, _error, startedAt),
    })
  }

  private loadSyntaxResult(
    change: DocumentSessionChange | null,
    contentVersion: number,
  ): Promise<EditorSyntaxLoadResult> {
    if (!this.syntaxSession) return Promise.reject(new Error('No syntax session'))
    return this.loadSyntaxBaseResult(change).then((result) => {
      if (this.syntaxSession?.queryRange && this.canProviderQuerySyntaxRange()) {
        return this.loadCurrentSyntaxRangeResult({ contentVersion, updatesDocument: true })
      }

      return { contentVersion, range: null, result, source: 'full', updatesDocument: true }
    })
  }

  private loadSyntaxBaseResult(change: DocumentSessionChange | null): Promise<EditorSyntaxResult> {
    if (!this.syntaxSession) return Promise.reject(new Error('No syntax session'))
    if (change) return this.syntaxSession.applyChange(change)

    const snapshot = this.options.getSession()?.getSnapshot()
    if (!snapshot) return Promise.reject(new Error('No document snapshot'))
    return this.syntaxSession.refresh(snapshot)
  }

  private loadCurrentSyntaxRangeResult(options: {
    readonly contentVersion: number
    readonly updatesDocument?: boolean
  }): Promise<EditorSyntaxLoadResult> {
    const range = this.options.getVisibleSyntaxRange()
    if (!range) {
      return Promise.resolve({
        contentVersion: options.contentVersion,
        range: null,
        result: this.syntaxSession?.getResult() ?? createEmptySyntaxResult(),
        source: 'full',
        updatesDocument: options.updatesDocument,
      })
    }
    return this.loadSyntaxRangeResult(range, 'visible', options)
  }

  private loadSyntaxRangeResult(
    range: EditorSyntaxRange,
    source: EditorSyntaxLoadSource,
    options: { readonly contentVersion?: number; readonly updatesDocument?: boolean } = {},
  ): Promise<EditorSyntaxLoadResult> {
    const contentVersion = options.contentVersion ?? this.syntaxContentVersion
    if (!this.syntaxSession?.queryRange) {
      return Promise.resolve({
        contentVersion,
        range: null,
        result: this.syntaxSession?.getResult() ?? createEmptySyntaxResult(),
        source: 'full',
        updatesDocument: options.updatesDocument,
      })
    }
    if (!this.canQuerySyntaxRangeForRequest(options.updatesDocument === true)) {
      return Promise.resolve({
        contentVersion,
        range: null,
        result: createEmptySyntaxResult(),
        source,
        skipApply: true,
        updatesDocument: options.updatesDocument,
      })
    }

    return this.syntaxSession.queryRange(range).then((result) => ({
      contentVersion,
      range,
      result,
      source,
      updatesDocument: options.updatesDocument,
    }))
  }

  private loadHighlightResult(
    change: DocumentSessionChange | null,
  ): Promise<EditorHighlightResult> {
    if (!this.highlighterSession) return Promise.reject(new Error('No highlighter session'))
    if (!change) {
      const snapshot = this.options.getSession()?.getSnapshot()
      if (!snapshot) return Promise.reject(new Error('No document snapshot'))
      return this.highlighterSession.refresh(snapshot)
    }

    return this.highlighterSession.applyChange(change)
  }

  private applySyntaxResult(
    loadResult: EditorSyntaxLoadResult,
    documentVersion: number,
    _startedAt: number,
  ): boolean {
    const session = this.options.getSession()
    if (loadResult.skipApply) return false
    if (!session || documentVersion !== this.options.getDocumentVersion()) return false
    if (loadResult.contentVersion !== this.syntaxContentVersion) return false

    const result = loadResult.result
    this.syntaxStatus = result.degraded ? 'degraded' : 'ready'
    if (loadResult.updatesDocument) this.markSyntaxDocumentCurrent(loadResult.contentVersion)
    const nextTokens = this.highlighterSession
      ? this.currentTokens
      : this.syntaxTokensForResult(result.tokens, loadResult.range)
    if (!this.highlighterSession) this.setTokens(nextTokens)
    if (loadResult.range) this.rememberSyntaxRange(loadResult.range, result)
    if (!this.highlighterSession && loadResult.range && !this.pendingWarm) {
      this.warmSyntaxAroundRange(documentVersion, loadResult.range)
    }
    if (this.shouldApplySyntaxFolds(loadResult)) {
      this.options.setSyntaxFolds(result.folds)
      this.options.setSyntaxCaptures?.(result.captures)
      // Brackets share the folds gate: both are whole-scope facts, and adopting them from a window
      // that does not cover the viewport would pair brackets across the part it never parsed.
      this.currentBrackets = result.brackets
    }
    this.options.notifyChange(null)
    return true
  }

  private shouldApplySyntaxFolds(loadResult: EditorSyntaxLoadResult): boolean {
    if (!loadResult.range) return true

    const visibleRange = this.options.getVisibleSyntaxRange()
    if (!visibleRange) return false
    return syntaxRangeCoverage(visibleRange, [loadResult.range]) === 'full'
  }

  private canProviderQuerySyntaxRange(): boolean {
    return this.syntaxSession?.canQueryRange?.() ?? true
  }

  private canQueryCurrentSyntaxRange(): boolean {
    return this.canProviderQuerySyntaxRange() && this.syntaxDocumentVersionIsCurrent()
  }

  private canQuerySyntaxRangeForRequest(updatesDocument: boolean): boolean {
    if (updatesDocument) return this.canProviderQuerySyntaxRange()
    return this.canQueryCurrentSyntaxRange()
  }

  private syntaxDocumentVersionIsCurrent(): boolean {
    return this.parsedSyntaxContentVersion === this.syntaxContentVersion
  }

  private markSyntaxDocumentCurrent(contentVersion: number): void {
    this.parsedSyntaxContentVersion = contentVersion
    if (this.pendingSyntaxContentVersion === contentVersion) {
      this.pendingSyntaxContentVersion = null
    }
  }

  private resetSyntaxContentVersion(): void {
    this.syntaxContentVersion += 1
    this.parsedSyntaxContentVersion = null
    this.pendingSyntaxContentVersion = null
  }

  private flushPendingPrefetch(): boolean {
    const pending = this.pendingPrefetch
    this.pendingPrefetch = null
    if (!pending) return false
    if (pending.documentVersion !== this.options.getDocumentVersion()) return false
    if (pending.contentVersion !== this.syntaxContentVersion) return false

    const scheduled = this.prefetchVisibleRange(
      pending.documentVersion,
      pending.range,
      pending.options,
    )
    if (!scheduled) this.flushPendingWarm()
    return scheduled
  }

  private flushPendingWarm(): void {
    const pending = this.pendingWarm
    if (!pending) return
    if (pending.documentVersion !== this.options.getDocumentVersion()) return
    if (pending.contentVersion !== this.syntaxContentVersion) return

    this.scheduleNextWarmRange(pending)
  }

  private scheduleNextWarmRange(pending: PendingSyntaxWarm): void {
    if (pending.generation !== this.warmGeneration) return
    if (!this.canRunWarmRangeRequest()) return

    const range = this.nextWarmRange(pending.seedRange)
    if (!range) {
      this.pendingWarm = null
      return
    }

    this.warmRangeRequests.schedule({
      delayMs: pending.delayMs,
      tags: syntaxWorkTags(pending.documentVersion, pending.contentVersion, 'warm', range),
      run: () =>
        this.loadSyntaxRangeResult(range, 'warm', { contentVersion: pending.contentVersion }),
      apply: (result, startedAt) => {
        if (pending.generation !== this.warmGeneration) return
        const applied = this.applySyntaxResult(result, pending.documentVersion, startedAt)
        if (applied) this.scheduleNextWarmRange(pending)
      },
      fail: (error, startedAt) =>
        this.recoverSyntaxError(pending.documentVersion, null, error, startedAt),
    })
  }

  private canRunWarmRangeRequest(): boolean {
    if (!this.syntaxSession?.queryRange) return false
    if (!this.options.getSession()) return false
    if (!this.canQueryCurrentSyntaxRange()) return false
    if (this.rangeRequests.isActive()) return false
    return !this.prefetchRangeRequests.isActive()
  }

  private nextWarmRange(seedRange: EditorSyntaxRange): EditorSyntaxRange | null {
    const session = this.options.getSession()
    const documentLength = session?.getSnapshot().length ?? 0
    return nextUncachedSyntaxWarmRange(documentLength, seedRange, this.cachedSyntaxRanges)
  }

  private nextWarmGeneration(): number {
    this.warmGeneration += 1
    return this.warmGeneration
  }

  private syntaxTokensForResult(
    tokens: readonly EditorToken[],
    range: EditorSyntaxRange | null,
  ): readonly EditorToken[] {
    if (!range) return tokens
    return mergeSyntaxRangeTokens(this.currentTokens, tokens, range)
  }

  private applyCachedSyntaxFolds(range: EditorSyntaxRange): void {
    const folds = cachedSyntaxFoldsForRange(range, this.cachedSyntaxFoldRanges)
    if (!folds) return

    this.options.setSyntaxFolds(folds)
  }

  private rememberSyntaxRange(range: EditorSyntaxRange, result: EditorSyntaxResult): void {
    this.cachedSyntaxRanges = appendCachedSyntaxRange(this.cachedSyntaxRanges, range)
    this.cachedSyntaxFoldRanges = appendCachedSyntaxFoldRange(this.cachedSyntaxFoldRanges, {
      folds: result.folds,
      range,
    })
  }

  private clearSyntaxRangeCache(): void {
    this.cachedSyntaxRanges = []
    this.cachedSyntaxFoldRanges = []
  }

  private projectSyntaxRangeCache(change: DocumentSessionChange): void {
    const edit = change.edits[0]
    if (change.edits.length !== 1 || !edit || !canProjectSyntaxRangeCacheThroughEdit(edit)) {
      this.clearSyntaxRangeCache()
      return
    }

    this.cachedSyntaxRanges = projectCachedSyntaxRanges(
      this.cachedSyntaxRanges,
      edit,
      change.snapshot.length,
    )
    this.cachedSyntaxFoldRanges = projectCachedSyntaxFoldRanges(
      this.cachedSyntaxFoldRanges,
      edit,
      change.snapshot.length,
    )
  }

  private applyHighlightResult(
    result: EditorHighlightResult,
    documentVersion: number,
    _startedAt: number,
  ): void {
    const session = this.options.getSession()
    if (!session || documentVersion !== this.options.getDocumentVersion()) return

    if (result.theme !== undefined) this.setHighlighterTheme(result.theme)
    this.setTokens(result.tokens)
    this.options.log?.({
      action: 'editor.syntax.highlight_applied',
      level: 'debug',
      syntax: {
        documentVersion,
        tokenCount: result.tokens.length,
      },
    })
    this.options.notifyChange(null)
  }

  private applySyntaxError(documentVersion: number): void {
    if (documentVersion !== this.options.getDocumentVersion()) return

    this.syntaxStatus = 'error'
    this.logSyntaxStatus('editor.syntax.structural_error', 'error')
    warnEditorSyntax('mark structural syntax error', this.debugContext(documentVersion))
    this.options.notifyChange(null)
  }

  private recoverSyntaxError(
    documentVersion: number,
    change: DocumentSessionChange | null,
    error: unknown,
    startedAt: number,
  ): void {
    if (documentVersion !== this.options.getDocumentVersion()) return
    this.options.log?.({
      action: 'editor.syntax.structural_request_failed',
      level: 'error',
      error: syntaxLogError(error),
      syntax: {
        ...this.debugContext(documentVersion),
        changeKind: change?.kind ?? 'refresh',
        startedAt,
      },
    })
    warnEditorSyntax(`structural syntax request failed: ${syntaxErrorMessage(error)}`, {
      ...this.debugContext(documentVersion),
      changeKind: change?.kind ?? 'refresh',
      error: syntaxDebugError(error),
      startedAt,
    })

    if (!change) {
      this.applySyntaxError(documentVersion)
      return
    }

    warnEditorSyntax('reload structural syntax after edit failure', {
      ...this.debugContext(documentVersion),
      changeKind: change.kind,
    })
    this.reloadSyntaxSession()
  }

  private applyHighlightError(documentVersion: number, _startedAt: number): void {
    const session = this.options.getSession()
    if (!session || documentVersion !== this.options.getDocumentVersion()) return

    this.options.log?.({
      action: 'editor.syntax.highlight_cleared_after_error',
      level: 'warn',
      syntax: this.debugContext(documentVersion),
    })
    warnEditorSyntax('clear plugin highlighting after error', this.debugContext(documentVersion))
    this.setHighlighterTheme(null)
    this.setTokens([])
    this.options.notifyChange(null)
  }

  private recoverHighlightError(
    documentVersion: number,
    change: DocumentSessionChange | null,
    error: unknown,
    startedAt: number,
  ): void {
    if (documentVersion !== this.options.getDocumentVersion()) return
    this.options.log?.({
      action: 'editor.syntax.highlight_request_failed',
      level: 'warn',
      error: syntaxLogError(error),
      syntax: {
        ...this.debugContext(documentVersion),
        changeKind: change?.kind ?? 'refresh',
        startedAt,
      },
    })
    warnEditorSyntax(`plugin highlighting request failed: ${syntaxErrorMessage(error)}`, {
      ...this.debugContext(documentVersion),
      changeKind: change?.kind ?? 'refresh',
      error: syntaxDebugError(error),
      startedAt,
    })

    if (!change) {
      this.applyHighlightError(documentVersion, startedAt)
      return
    }

    warnEditorSyntax('reload plugin highlighter after edit failure', {
      ...this.debugContext(documentVersion),
      changeKind: change.kind,
    })
    this.reloadHighlighterSession()
  }

  private debugContext(documentVersion: number): EditorSyntaxDebugPayload {
    const session = this.options.getSession()
    return {
      currentDocumentVersion: this.options.getDocumentVersion(),
      documentId: this.options.getCurrentSessionDocumentId(),
      documentLength: session?.getSnapshot().length ?? null,
      documentVersion,
      hasHighlighterSession: Boolean(this.highlighterSession),
      hasSyntaxSession: Boolean(this.syntaxSession),
      languageId: this.options.getLanguageId(),
      syntaxStatus: this.syntaxStatus,
    }
  }

  private setHighlighterTheme(theme: EditorTheme | null | undefined): void {
    const nextTheme = theme ?? null
    if (editorThemesEqual(this.highlighterTheme, nextTheme)) return

    this.highlighterTheme = nextTheme
    this.options.log?.({
      action: 'editor.syntax.highlighter_theme_changed',
      level: 'debug',
      syntax: { hasTheme: nextTheme !== null },
    })
    this.options.notifyThemeChanged()
  }

  private setProviderHighlighterTheme(theme: EditorTheme | null | undefined): void {
    const nextTheme = theme ?? null
    if (editorThemesEqual(this.providerHighlighterTheme, nextTheme)) return

    this.providerHighlighterTheme = nextTheme
    this.options.log?.({
      action: 'editor.syntax.provider_theme_changed',
      level: 'debug',
      syntax: { hasTheme: nextTheme !== null },
    })
    this.options.notifyThemeChanged()
  }

  private logSyntaxStatus(
    action: string,
    level: 'debug' | 'info' | 'warn' | 'error' = 'info',
  ): void {
    this.options.log?.({
      action,
      level,
      syntax: this.debugContext(this.options.getDocumentVersion()),
    })
  }
}

type EditorSyntaxDebugPayload = Record<string, unknown>

const warnEditorSyntax = (message: string, payload: EditorSyntaxDebugPayload): void => {
  console.warn(`[editor-syntax] ${message}\n${JSON.stringify(payload, null, 2)}`)
}

const syntaxDebugError = (error: unknown): EditorSyntaxDebugPayload => {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    }
  }

  return { value: String(error) }
}

const syntaxLogError = (
  error: unknown,
): { readonly message: string; readonly name?: string; readonly stack?: string } => {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    }
  }

  return { message: String(error) }
}

const syntaxErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}

const mergeSyntaxRangeTokens = (
  currentTokens: readonly EditorToken[],
  rangeTokens: readonly EditorToken[],
  range: EditorSyntaxRange,
): readonly EditorToken[] => {
  const merged: EditorToken[] = []
  appendTokensOutsideRange(merged, currentTokens, range)
  appendTokens(merged, rangeTokens)
  merged.sort(compareEditorTokens)

  const indexBuilder = createEditorTokenIndexBuilder()
  for (const token of merged) appendEditorTokenIndexEntry(indexBuilder, token)
  finishEditorTokenIndex(merged, indexBuilder)
  return merged
}

const appendTokensOutsideRange = (
  target: EditorToken[],
  tokens: readonly EditorToken[],
  range: EditorSyntaxRange,
): void => {
  for (const token of tokens) {
    if (token.end <= range.startIndex || token.start >= range.endIndex) target.push(token)
  }
}

const appendTokens = (target: EditorToken[], tokens: readonly EditorToken[]): void => {
  for (const token of tokens) target.push(token)
}

const compareEditorTokens = (left: EditorToken, right: EditorToken): number =>
  left.start - right.start || left.end - right.end

const appendCachedSyntaxRange = (
  ranges: readonly EditorSyntaxRange[],
  range: EditorSyntaxRange,
): readonly EditorSyntaxRange[] => {
  if (range.endIndex <= range.startIndex) return ranges

  const merged: EditorSyntaxRange[] = []
  const sorted = ranges.concat(range).sort(compareSyntaxRanges)
  for (const current of sorted) mergeCachedSyntaxRange(merged, current)
  return merged
}

const mergeCachedSyntaxRange = (ranges: EditorSyntaxRange[], range: EditorSyntaxRange): void => {
  const previous = ranges.at(-1)
  if (!previous || range.startIndex > previous.endIndex) {
    ranges.push(range)
    return
  }

  ranges[ranges.length - 1] = {
    startIndex: previous.startIndex,
    endIndex: Math.max(previous.endIndex, range.endIndex),
  }
}

const appendCachedSyntaxFoldRange = (
  ranges: readonly CachedSyntaxFoldRange[],
  range: CachedSyntaxFoldRange,
): readonly CachedSyntaxFoldRange[] => {
  if (range.range.endIndex <= range.range.startIndex) return ranges

  const next = ranges.filter((current) => !sameSyntaxRange(current.range, range.range))
  next.push(range)
  return next
}

const projectCachedSyntaxRanges = (
  ranges: readonly EditorSyntaxRange[],
  edit: TextEdit,
  documentLength: number,
): readonly EditorSyntaxRange[] => {
  const projected: EditorSyntaxRange[] = []
  for (const range of ranges) {
    const next = projectSyntaxRangeThroughInsertion(range, edit, documentLength)
    if (next.endIndex > next.startIndex) projected.push(next)
  }
  return projected
}

const projectCachedSyntaxFoldRanges = (
  ranges: readonly CachedSyntaxFoldRange[],
  edit: TextEdit,
  documentLength: number,
): readonly CachedSyntaxFoldRange[] => {
  const projected: CachedSyntaxFoldRange[] = []
  for (const range of ranges) {
    const nextRange = projectSyntaxRangeThroughInsertion(range.range, edit, documentLength)
    if (nextRange.endIndex <= nextRange.startIndex) continue
    projected.push({
      range: nextRange,
      folds: projectFoldRangesThroughInsertion(range.folds, edit, documentLength),
    })
  }
  return projected
}

const canProjectSyntaxRangeCacheThroughEdit = (edit: TextEdit): boolean => {
  if (edit.to !== edit.from) return false
  return lineBreakCount(edit.text) === 0
}

const projectSyntaxRangeThroughInsertion = (
  range: EditorSyntaxRange,
  edit: TextEdit,
  documentLength: number,
): EditorSyntaxRange => {
  const delta = edit.text.length
  if (range.endIndex <= edit.from) return clampSyntaxRange(range, documentLength)
  if (range.startIndex >= edit.from) {
    return clampSyntaxRange(
      {
        startIndex: range.startIndex + delta,
        endIndex: range.endIndex + delta,
      },
      documentLength,
    )
  }

  return clampSyntaxRange(
    {
      startIndex: range.startIndex,
      endIndex: range.endIndex + delta,
    },
    documentLength,
  )
}

const projectFoldRangesThroughInsertion = (
  folds: readonly FoldRange[],
  edit: TextEdit,
  documentLength: number,
): readonly FoldRange[] => {
  const lineDelta = lineBreakCount(edit.text)
  const delta = edit.text.length
  return folds
    .map((fold) => projectFoldRangeThroughInsertion(fold, edit, delta, lineDelta, documentLength))
    .filter((fold): fold is FoldRange => fold !== null)
}

const projectFoldRangeThroughInsertion = (
  fold: FoldRange,
  edit: TextEdit,
  delta: number,
  lineDelta: number,
  documentLength: number,
): FoldRange | null => {
  if (edit.from <= fold.startIndex) {
    return normalizeProjectedFoldRange(
      {
        ...fold,
        startIndex: fold.startIndex + delta,
        endIndex: fold.endIndex + delta,
        startLine: fold.startLine + lineDelta,
        endLine: fold.endLine + lineDelta,
      },
      documentLength,
    )
  }

  if (edit.from < fold.endIndex) {
    return normalizeProjectedFoldRange(
      {
        ...fold,
        endIndex: fold.endIndex + delta,
        endLine: fold.endLine + lineDelta,
      },
      documentLength,
    )
  }

  return normalizeProjectedFoldRange(fold, documentLength)
}

const normalizeProjectedFoldRange = (fold: FoldRange, documentLength: number): FoldRange | null => {
  const startIndex = boundedSyntaxIndex(fold.startIndex, documentLength)
  const endIndex = boundedSyntaxIndex(fold.endIndex, documentLength)
  if (endIndex <= startIndex) return null
  const startLine = Math.max(0, fold.startLine)
  return {
    ...fold,
    startIndex,
    endIndex,
    startLine,
    endLine: Math.max(startLine, fold.endLine),
  }
}

const clampSyntaxRange = (range: EditorSyntaxRange, documentLength: number): EditorSyntaxRange => ({
  startIndex: boundedSyntaxIndex(range.startIndex, documentLength),
  endIndex: boundedSyntaxIndex(range.endIndex, documentLength),
})

const boundedSyntaxIndex = (index: number, documentLength: number): number =>
  Math.max(0, Math.min(index, documentLength))

const lineBreakCount = (text: string): number => {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') count += 1
  }
  return count
}

const cachedSyntaxFoldsForRange = (
  range: EditorSyntaxRange,
  cachedRanges: readonly CachedSyntaxFoldRange[],
): readonly FoldRange[] | null => {
  const coverageRanges = cachedRanges.map((cachedRange) => cachedRange.range)
  if (syntaxRangeCoverage(range, coverageRanges) !== 'full') return null

  const foldsByKey = new Map<string, FoldRange>()
  for (const cachedRange of cachedRanges) {
    if (!syntaxRangesIntersect(cachedRange.range, range)) continue
    for (const fold of cachedRange.folds) {
      if (!foldIntersectsSyntaxRange(fold, range)) continue
      foldsByKey.set(foldRangeKey(fold), fold)
    }
  }
  return Array.from(foldsByKey.values()).toSorted(compareFoldRanges)
}

const sameSyntaxRange = (left: EditorSyntaxRange, right: EditorSyntaxRange): boolean =>
  left.startIndex === right.startIndex && left.endIndex === right.endIndex

const syntaxRangesIntersect = (left: EditorSyntaxRange, right: EditorSyntaxRange): boolean =>
  left.startIndex < right.endIndex && left.endIndex > right.startIndex

const foldIntersectsSyntaxRange = (fold: FoldRange, range: EditorSyntaxRange): boolean =>
  fold.startIndex < range.endIndex && fold.endIndex > range.startIndex

const compareFoldRanges = (left: FoldRange, right: FoldRange): number =>
  left.startLine - right.startLine ||
  left.endLine - right.endLine ||
  left.startIndex - right.startIndex ||
  left.endIndex - right.endIndex

type SyntaxRangeCoverage = 'none' | 'partial' | 'full'

const syntaxRangeCoverage = (
  range: EditorSyntaxRange,
  cachedRanges: readonly EditorSyntaxRange[],
): SyntaxRangeCoverage => {
  let cursor = range.startIndex
  let overlaps = false
  for (const cachedRange of cachedRanges) {
    if (cachedRange.endIndex <= range.startIndex) continue
    if (cachedRange.startIndex >= range.endIndex) break

    overlaps = true
    if (cachedRange.endIndex <= cursor) continue
    if (cachedRange.startIndex > cursor) return 'partial'

    cursor = Math.max(cursor, cachedRange.endIndex)
    if (cursor >= range.endIndex) return 'full'
  }

  return overlaps ? 'partial' : 'none'
}

const compareSyntaxRanges = (left: EditorSyntaxRange, right: EditorSyntaxRange): number =>
  left.startIndex - right.startIndex || left.endIndex - right.endIndex

const nextUncachedSyntaxWarmRange = (
  documentLength: number,
  seedRange: EditorSyntaxRange,
  cachedRanges: readonly EditorSyntaxRange[],
): EditorSyntaxRange | null => {
  if (documentLength <= 0) return null

  const tileCount = Math.ceil(documentLength / BACKGROUND_SYNTAX_TILE_CHARS)
  const seedCenter = boundedIndex(
    Math.floor((seedRange.startIndex + seedRange.endIndex) / 2),
    documentLength,
  )
  const seedTile = Math.min(tileCount - 1, Math.floor(seedCenter / BACKGROUND_SYNTAX_TILE_CHARS))
  for (let distance = 0; distance < tileCount; distance += 1) {
    const forward = syntaxWarmTileRange(seedTile + distance, documentLength)
    if (isUncachedSyntaxWarmRange(forward, cachedRanges, seedRange)) return forward
    if (distance === 0) continue

    const backward = syntaxWarmTileRange(seedTile - distance, documentLength)
    if (isUncachedSyntaxWarmRange(backward, cachedRanges, seedRange)) return backward
  }

  return null
}

const syntaxWarmTileRange = (
  tileIndex: number,
  documentLength: number,
): EditorSyntaxRange | null => {
  if (tileIndex < 0) return null

  const startIndex = tileIndex * BACKGROUND_SYNTAX_TILE_CHARS
  if (startIndex >= documentLength) return null

  return {
    startIndex,
    endIndex: Math.min(documentLength, startIndex + BACKGROUND_SYNTAX_TILE_CHARS),
  }
}

const isUncachedSyntaxWarmRange = (
  range: EditorSyntaxRange | null,
  cachedRanges: readonly EditorSyntaxRange[],
  seedRange: EditorSyntaxRange,
): range is EditorSyntaxRange => {
  if (!range) return false
  if (syntaxRangesIntersect(range, seedRange)) return false
  return syntaxRangeCoverage(range, cachedRanges) !== 'full'
}

const boundedIndex = (index: number, documentLength: number): number =>
  Math.max(0, Math.min(index, Math.max(0, documentLength - 1)))
