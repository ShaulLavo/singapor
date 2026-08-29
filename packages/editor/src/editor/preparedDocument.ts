import type { EditorTextBuffer } from '../documentSession'
import type { PieceTableSnapshot } from '../pieceTable/pieceTableTypes'
import type {
  EditorHighlighterProvider,
  EditorHighlighterSession,
  EditorHighlightResult,
} from '../plugins'
import {
  createEmptySyntaxResult,
  createEditorRuntimeSessionId,
  type EditorSyntaxLanguageId,
  type EditorSyntaxProvider,
  type EditorSyntaxRange,
  type EditorSyntaxResult,
  type EditorSyntaxSession,
  type FoldRange,
} from '../syntax/session'
import { fallbackFoldRanges } from './foldRanges'
import { guessedTabSize } from './indentationGuess'

export type EditorPreparedTagValue = string | number | boolean | null

export type EditorPreparedStructuralConfiguration = {
  readonly includeCaptures: boolean
  readonly includeHighlights: boolean
  readonly syntaxMode: 'full' | 'range'
}

export type EditorPreparedDocumentMatch = {
  readonly documentId: string
  readonly languageId: EditorSyntaxLanguageId | null
  readonly snapshot: PieceTableSnapshot
  readonly documentConfigurationTag: readonly EditorPreparedTagValue[]
  readonly structuralProvider: EditorSyntaxProvider | null
  readonly highlighterProvider: EditorHighlighterProvider | null
  readonly structuralConfiguration: EditorPreparedStructuralConfiguration | null
  readonly structuralConfigurationTag: readonly EditorPreparedTagValue[]
  readonly highlighterConfigurationTag: readonly EditorPreparedTagValue[]
}

export type EditorPreparedStageRequest =
  | {
      readonly family: 'structural'
      readonly provider: EditorSyntaxProvider
      readonly configuration: EditorPreparedStructuralConfiguration
      readonly configurationTag: readonly EditorPreparedTagValue[]
      readonly range: EditorSyntaxRange
      readonly abortSignal: AbortSignal
    }
  | {
      readonly family: 'highlighter'
      readonly provider: EditorHighlighterProvider
      readonly configurationTag: readonly EditorPreparedTagValue[]
      readonly range: 'full'
      readonly abortSignal: AbortSignal
    }

export type EditorPreparedStageOutcome = 'ready' | 'aborted' | 'failed' | 'stale'

export type EditorPreparedStructuralTransfer = {
  readonly family: 'structural'
  readonly runtimeSessionId: string
  readonly provider: EditorSyntaxProvider
  readonly configuration: EditorPreparedStructuralConfiguration
  readonly configurationTag: readonly EditorPreparedTagValue[]
  readonly range: EditorSyntaxRange
  readonly session: EditorSyntaxSession
  readonly result: Promise<EditorSyntaxResult>
  readonly readyResult: EditorSyntaxResult | null
  dispose(): void
}

export type EditorPreparedHighlighterTransfer = {
  readonly family: 'highlighter'
  readonly runtimeSessionId: string
  readonly provider: EditorHighlighterProvider
  readonly configurationTag: readonly EditorPreparedTagValue[]
  readonly range: 'full'
  readonly session: EditorHighlighterSession
  readonly result: Promise<EditorHighlightResult>
  readonly readyResult: EditorHighlightResult | null
  dispose(): void
}

export type EditorPreparedDocumentPayload = {
  readonly lineStarts: readonly number[]
  readonly tabSize: number
  readonly fallbackFolds: readonly FoldRange[]
  readonly structural: EditorPreparedStructuralTransfer | null
  readonly highlighter: EditorPreparedHighlighterTransfer | null
}

export type EditorPreparedDocument = {
  startStage(request: EditorPreparedStageRequest): Promise<EditorPreparedStageOutcome> | null
  take(expected: EditorPreparedDocumentMatch): EditorPreparedDocumentPayload | null
  dispose(): void
  readonly estimatedBytes: number
}

export type CreateEditorPreparedDocumentOptions = {
  readonly buffer: EditorTextBuffer
  readonly documentId: string
  readonly languageId: EditorSyntaxLanguageId | null
  readonly configuredTabSize: number
  readonly documentConfigurationTag: readonly EditorPreparedTagValue[]
}

type PreparedStructuralStage = ReturnType<typeof createStructuralStage>
type PreparedHighlighterStage = ReturnType<typeof createHighlighterStage>

export function createEditorPreparedDocument(
  options: CreateEditorPreparedDocumentOptions,
): EditorPreparedDocument {
  const snapshot = options.buffer.getSnapshot()
  const textSnapshot = options.buffer.getTextSnapshot()
  const fullText = textSnapshot.materializeFullText()
  const lineStarts = computeLineStarts(textSnapshot)
  const tabSize = guessedTabSize(fullText, options.configuredTabSize)
  const fallbackFolds = fallbackFoldRanges({
    text: fullText,
    languageId: options.languageId,
    tabSize,
  })
  const documentConfigurationTag = checkedTag(options.documentConfigurationTag)
  let structural: PreparedStructuralStage | null = null
  let highlighter: PreparedHighlighterStage | null = null
  let consumed = false
  let disposed = false

  const dispose = (): void => {
    if (disposed) return

    disposed = true
    structural?.disposeIfOwned()
    highlighter?.disposeIfOwned()
  }

  return {
    estimatedBytes: snapshot.length * 2 + lineStarts.length * 8 + fallbackFolds.length * 48,
    startStage(request) {
      if (consumed || disposed) return null
      if (request.family === 'structural') {
        if (structural) return null
        structural = createStructuralStage(options, snapshot, textSnapshot, request)
        return structural.outcome
      }
      if (highlighter) return null
      highlighter = createHighlighterStage(options, snapshot, textSnapshot, request)
      return highlighter.outcome
    },
    take(expected) {
      if (consumed || disposed) return null
      if (!matchesDocument(expected, options, snapshot, documentConfigurationTag)) {
        dispose()
        return null
      }

      consumed = true
      const structuralTransfer = takeStructural(structural, expected)
      const highlighterTransfer = takeHighlighter(highlighter, expected)
      return {
        lineStarts,
        tabSize,
        fallbackFolds,
        structural: structuralTransfer,
        highlighter: highlighterTransfer,
      }
    },
    dispose,
  }
}

function createStructuralStage(
  options: CreateEditorPreparedDocumentOptions,
  snapshot: PieceTableSnapshot,
  textSnapshot: ReturnType<EditorTextBuffer['getTextSnapshot']>,
  request: Extract<EditorPreparedStageRequest, { readonly family: 'structural' }>,
) {
  const runtimeSessionId = createEditorRuntimeSessionId()
  const configurationTag = checkedTag(request.configurationTag)
  const session = request.provider.createSession({
    documentId: options.documentId,
    runtimeSessionId,
    languageId: options.languageId,
    includeCaptures: request.configuration.includeCaptures,
    includeHighlights: request.configuration.includeHighlights,
    syntaxMode: request.configuration.syntaxMode,
    snapshot,
    textSnapshot,
    fullText: '',
  })
  if (!session) return createMissingStructuralStage(request.abortSignal)

  const stage = createStageOwner<EditorSyntaxResult>(session, request.abortSignal)
  const result = session.refresh(snapshot).then(() => {
    if (!session.queryRange) return session.getResult()
    return session.queryRange(request.range)
  })
  const tracked = stage.track(result)
  return {
    ...stage,
    configuration: request.configuration,
    configurationTag,
    outcome: outcomeFor(tracked, stage),
    provider: request.provider,
    range: request.range,
    result: tracked,
    runtimeSessionId,
    session,
  }
}

function createHighlighterStage(
  options: CreateEditorPreparedDocumentOptions,
  snapshot: PieceTableSnapshot,
  textSnapshot: ReturnType<EditorTextBuffer['getTextSnapshot']>,
  request: Extract<EditorPreparedStageRequest, { readonly family: 'highlighter' }>,
) {
  const runtimeSessionId = createEditorRuntimeSessionId()
  const configurationTag = checkedTag(request.configurationTag)
  const session = request.provider.createSession({
    documentId: options.documentId,
    runtimeSessionId,
    languageId: options.languageId,
    snapshot,
    textSnapshot,
    fullText: '',
  })
  if (!session) return createMissingHighlighterStage(request.abortSignal)

  const stage = createStageOwner<EditorHighlightResult>(session, request.abortSignal)
  const tracked = stage.track(session.refresh(snapshot))
  return {
    ...stage,
    configurationTag,
    outcome: outcomeFor(tracked, stage),
    provider: request.provider,
    range: 'full' as const,
    result: tracked,
    runtimeSessionId,
    session,
  }
}

function createStageOwner<TResult>(session: { dispose(): void }, abortSignal: AbortSignal) {
  let disposed = false
  let transferred = false
  let readyResult: TResult | null = null
  const abort = () => {
    if (transferred) return
    dispose()
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    abortSignal.removeEventListener('abort', abort)
    session.dispose()
  }
  abortSignal.addEventListener('abort', abort, { once: true })
  if (abortSignal.aborted) abort()

  return {
    abortSignal,
    dispose,
    disposeIfOwned: () => {
      if (transferred) return
      dispose()
    },
    disposed: () => disposed,
    readyResult: () => readyResult,
    takeOwnership: () => {
      if (disposed) return false
      transferred = true
      abortSignal.removeEventListener('abort', abort)
      return true
    },
    track: (result: Promise<TResult>): Promise<TResult> =>
      result.then((value) => {
        if (disposed) throw new DOMException('Prepared stage disposed', 'AbortError')
        readyResult = value
        return value
      }),
  }
}

function outcomeFor<T>(
  result: Promise<T>,
  stage: { readonly abortSignal: AbortSignal; disposed(): boolean },
): Promise<EditorPreparedStageOutcome> {
  return result.then(
    () => (stage.disposed() ? 'stale' : 'ready'),
    () => (stage.abortSignal.aborted ? 'aborted' : 'failed'),
  )
}

function createMissingStructuralStage(abortSignal: AbortSignal) {
  return {
    abortSignal,
    configuration: null,
    configurationTag: [] as readonly EditorPreparedTagValue[],
    dispose: () => undefined,
    disposeIfOwned: () => undefined,
    disposed: () => true,
    outcome: Promise.resolve<EditorPreparedStageOutcome>('failed'),
    provider: null,
    range: null,
    readyResult: () => null,
    result: Promise.resolve(createEmptySyntaxResult()),
    runtimeSessionId: '',
    session: null,
    takeOwnership: () => false,
    track: <T>(result: Promise<T>) => result,
  }
}

function createMissingHighlighterStage(abortSignal: AbortSignal) {
  return {
    abortSignal,
    configurationTag: [] as readonly EditorPreparedTagValue[],
    dispose: () => undefined,
    disposeIfOwned: () => undefined,
    disposed: () => true,
    outcome: Promise.resolve<EditorPreparedStageOutcome>('failed'),
    provider: null,
    range: null,
    readyResult: () => null,
    result: Promise.resolve({ tokens: [] }),
    runtimeSessionId: '',
    session: null,
    takeOwnership: () => false,
    track: <T>(result: Promise<T>) => result,
  }
}

function takeStructural(
  stage: PreparedStructuralStage | null,
  expected: EditorPreparedDocumentMatch,
): EditorPreparedStructuralTransfer | null {
  if (!stage?.session || !stage.provider || !stage.configuration || !stage.range) return null
  if (stage.provider !== expected.structuralProvider) return disposeStage(stage)
  if (!sameStructuralConfiguration(stage.configuration, expected.structuralConfiguration)) {
    return disposeStage(stage)
  }
  if (!sameTag(stage.configurationTag, expected.structuralConfigurationTag)) {
    return disposeStage(stage)
  }
  if (!stage.takeOwnership()) return null

  return transferWithReadyResult(
    {
      family: 'structural' as const,
      runtimeSessionId: stage.runtimeSessionId,
      provider: stage.provider,
      configuration: stage.configuration,
      configurationTag: stage.configurationTag,
      range: stage.range,
      session: stage.session,
      result: stage.result,
      dispose: stage.dispose,
    },
    stage.readyResult,
  )
}

function takeHighlighter(
  stage: PreparedHighlighterStage | null,
  expected: EditorPreparedDocumentMatch,
): EditorPreparedHighlighterTransfer | null {
  if (!stage?.session || !stage.provider) return null
  if (stage.provider !== expected.highlighterProvider) return disposeStage(stage)
  if (!sameTag(stage.configurationTag, expected.highlighterConfigurationTag)) {
    return disposeStage(stage)
  }
  if (!stage.takeOwnership()) return null

  return transferWithReadyResult(
    {
      family: 'highlighter' as const,
      runtimeSessionId: stage.runtimeSessionId,
      provider: stage.provider,
      configurationTag: stage.configurationTag,
      range: 'full' as const,
      session: stage.session,
      result: stage.result,
      dispose: stage.dispose,
    },
    stage.readyResult,
  )
}

function transferWithReadyResult<TResult, T extends object>(
  transfer: T,
  readyResult: () => TResult | null,
): T & { readonly readyResult: TResult | null } {
  return Object.defineProperty({ ...transfer, readyResult: null }, 'readyResult', {
    enumerable: true,
    get: readyResult,
  })
}

function disposeStage<T>(stage: { dispose(): void }): T | null {
  stage.dispose()
  return null
}

function matchesDocument(
  expected: EditorPreparedDocumentMatch,
  options: CreateEditorPreparedDocumentOptions,
  snapshot: PieceTableSnapshot,
  tag: readonly EditorPreparedTagValue[],
): boolean {
  if (expected.documentId !== options.documentId) return false
  if (expected.languageId !== options.languageId) return false
  if (expected.snapshot !== snapshot) return false
  return sameTag(expected.documentConfigurationTag, tag)
}

function sameStructuralConfiguration(
  left: EditorPreparedStructuralConfiguration,
  right: EditorPreparedStructuralConfiguration | null,
): boolean {
  if (!right) return false
  return (
    left.includeCaptures === right.includeCaptures &&
    left.includeHighlights === right.includeHighlights &&
    left.syntaxMode === right.syntaxMode
  )
}

function checkedTag(tag: readonly EditorPreparedTagValue[]): readonly EditorPreparedTagValue[] {
  for (const value of tag) {
    if (value === null) continue
    if (typeof value === 'string') continue
    if (typeof value === 'number') continue
    if (typeof value === 'boolean') continue
    throw new TypeError('Prepared document tags accept only primitive values')
  }
  return Object.freeze([...tag])
}

function sameTag(
  left: readonly EditorPreparedTagValue[],
  right: readonly EditorPreparedTagValue[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

function computeLineStarts(
  textSnapshot: ReturnType<EditorTextBuffer['getTextSnapshot']>,
): readonly number[] {
  const lineStarts = [0]
  textSnapshot.forEachTextChunk((text, chunkStart) => {
    let index = text.indexOf('\n')
    while (index !== -1) {
      lineStarts.push(chunkStart + index + 1)
      index = text.indexOf('\n', index + 1)
    }
  })
  return Object.freeze(lineStarts)
}
