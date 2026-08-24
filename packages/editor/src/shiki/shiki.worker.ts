import { createHighlighter, type HighlighterGeneric, type ThemeRegistrationAny } from 'shiki'
import { createIncrementalTokenizer, type IncrementalTokenizer } from './tokenizer'
import { snapshotToPackedEditorTokens } from './editor-tokens'
import type { EditorTheme } from '../theme'
import { packedEditorTokenTransfers } from '../syntax/packedTokens'
import { editorThemeFromShikiTheme, type ShikiThemeLike } from './theme-extract'
import type {
  ShikiWorkerDocumentOptions,
  ShikiWorkerEditRequest,
  ShikiWorkerOpenRequest,
  ShikiWorkerRequest,
  ShikiWorkerResponse,
  ShikiWorkerTransportResult,
  ShikiWorkerThemeRegistration,
  ShikiWorkerThemeRequest,
} from './workerTypes'

type DocumentState = {
  readonly documentId: string
  readonly lang: string
  readonly theme: string
  readonly themeRegistration?: ShikiWorkerThemeRegistration
  readonly highlighter: HighlighterGeneric<string, string>
  readonly tokenizer: IncrementalTokenizer
}

const documents = new Map<string, DocumentState>()
const documentTasks = new Map<string, Promise<ShikiWorkerTransportResult | undefined>>()
const highlighterPromises = new Map<string, Promise<HighlighterGeneric<string, string>>>()
const backgroundLoaded = new WeakSet<HighlighterGeneric<string, string>>()

self.onmessage = (event: MessageEvent<ShikiWorkerRequest>): void => {
  void handleRequest(event.data)
}

const handleRequest = async (request: ShikiWorkerRequest): Promise<void> => {
  try {
    const result = await runRequest(request.payload)
    postResponse({ id: request.id, ok: true, result })
  } catch (error) {
    postResponse({ id: request.id, ok: false, error: createErrorMessage(error) })
  }
}

const runRequest = (
  payload: ShikiWorkerRequest['payload'],
): Promise<ShikiWorkerTransportResult | undefined> => {
  if (payload.type === 'open') {
    return runDocumentTask(payload.documentId, () => openDocument(payload))
  }
  if (payload.type === 'edit') {
    return runDocumentTask(payload.documentId, () => editDocument(payload))
  }
  if (payload.type === 'disposeDocument') {
    disposeDocument(payload.documentId)
    return Promise.resolve(undefined)
  }
  if (payload.type === 'theme') {
    return loadTheme(payload)
  }

  disposeAll()
  return Promise.resolve(undefined)
}

const runDocumentTask = (
  documentId: string,
  task: () => Promise<ShikiWorkerTransportResult>,
): Promise<ShikiWorkerTransportResult> => {
  const previous = documentTasks.get(documentId) ?? Promise.resolve(undefined)
  const next = previous.catch(() => undefined).then(task)
  documentTasks.set(documentId, next)
  void next.finally(() => clearDocumentTask(documentId, next)).catch(() => undefined)
  return next
}

const clearDocumentTask = (
  documentId: string,
  task: Promise<ShikiWorkerTransportResult | undefined>,
): void => {
  if (documentTasks.get(documentId) !== task) return
  documentTasks.delete(documentId)
}

const openDocument = async (
  payload: ShikiWorkerOpenRequest,
): Promise<ShikiWorkerTransportResult> => {
  const highlighter = await ensureHighlighter(payload)
  const { tokenizer } = await createIncrementalTokenizer({
    lang: payload.lang,
    theme: payload.theme,
    code: payload.text,
    highlighter,
  })

  const state = {
    documentId: payload.documentId,
    lang: payload.lang,
    theme: payload.theme,
    themeRegistration: payload.themeRegistration,
    highlighter,
    tokenizer,
  }
  documents.set(payload.documentId, state)
  const result = resultFromState(state)
  scheduleBackgroundLanguages(highlighter, payload.langs)

  return result
}

const editDocument = async (
  payload: ShikiWorkerEditRequest,
): Promise<ShikiWorkerTransportResult> => {
  const existing = documents.get(payload.documentId)
  if (!existing && payload.text !== undefined)
    return openDocument(openRequestFromEdit(payload, payload.text))
  if (!existing) throw new Error('Unable to edit unopened Shiki document without text')
  if (!documentMatches(existing, payload) && payload.text !== undefined) {
    return openDocument(openRequestFromEdit(payload, payload.text))
  }
  if (!documentMatches(existing, payload)) {
    throw new Error('Unable to reopen Shiki document without text')
  }

  if (payload.edit) {
    existing.tokenizer.applyEdit(payload.edit)
  } else {
    existing.tokenizer.update(payload.text ?? existing.tokenizer.getCode())
  }

  return resultFromState(existing)
}

const openRequestFromEdit = (payload: ShikiWorkerEditRequest, text: string) => ({
  documentId: payload.documentId,
  lang: payload.lang,
  theme: payload.theme,
  themeRegistration: payload.themeRegistration,
  text,
  langs: payload.langs,
  themes: payload.themes,
  type: 'open' as const,
})

/**
 * The highlighter for a document, with that document's grammar loaded and nothing else waited on.
 *
 * Loading the host's whole preload set up front measured 1 280–1 780 ms for 53 grammars, all of it
 * ahead of the first paint of a single TypeScript file. The set is still loaded — a language switch
 * should not stall either — but behind the answer rather than in front of it.
 */
const ensureHighlighter = async (
  options: ShikiWorkerDocumentOptions,
): Promise<HighlighterGeneric<string, string>> => {
  const themes = highlighterThemes([options.theme, ...options.themes], options.themeRegistration)
  const highlighter = await ensureHighlighterFor([options.lang], themes)
  await ensureLanguages(highlighter, [options.lang])

  return highlighter
}

const ensureLanguages = async (
  highlighter: HighlighterGeneric<string, string>,
  langs: readonly string[],
): Promise<void> => {
  const loaded = new Set(highlighter.getLoadedLanguages())
  const missing = unique(langs).filter((lang) => lang.length > 0 && !loaded.has(lang))
  if (missing.length === 0) return

  await highlighter.loadLanguage(...(missing as Parameters<typeof highlighter.loadLanguage>))
}

/**
 * Once per highlighter, on a timer rather than a microtask.
 *
 * A microtask here runs *between* the tokenizer's awaits and competes with it for the one worker
 * thread — measured at 526 ms of tokenization becoming 1 187 ms. The delay puts the whole preload
 * set behind the paint that matters instead of inside it. A failure costs a stall on some later
 * language switch, never a paint.
 */
const scheduleBackgroundLanguages = (
  highlighter: HighlighterGeneric<string, string>,
  langs: readonly string[],
): void => {
  if (langs.length === 0) return
  if (backgroundLoaded.has(highlighter)) return

  backgroundLoaded.add(highlighter)
  setTimeout(() => void ensureLanguages(highlighter, langs).catch(() => undefined), 1_000)
}

const ensureHighlighterFor = (
  langs: readonly string[],
  themes: readonly (string | ShikiWorkerThemeRegistration)[],
): Promise<HighlighterGeneric<string, string>> => {
  const key = highlighterKey(themes)
  const existing = highlighterPromises.get(key)
  if (existing) return existing

  const promise = createHighlighter({
    langs: [...langs],
    themes: themes.map(highlighterThemeInput),
  }) as Promise<HighlighterGeneric<string, string>>
  highlighterPromises.set(key, promise)
  return promise
}

const highlighterThemes = (
  themeNames: readonly string[],
  registration: ShikiWorkerThemeRegistration | undefined,
): (string | ShikiWorkerThemeRegistration)[] => {
  const names = unique(themeNames.filter((name) => name !== registration?.name))
  if (!registration) return names
  return [registration, ...names]
}

const loadTheme = async (payload: ShikiWorkerThemeRequest): Promise<ShikiWorkerTransportResult> => {
  const themes = highlighterThemes([payload.theme, ...payload.themes], payload.themeRegistration)
  const highlighter = await ensureHighlighterFor([], themes)
  return {
    theme: editorThemeFromHighlighter(highlighter, payload.theme, payload.themeRegistration),
  }
}

const resultFromState = (state: DocumentState): ShikiWorkerTransportResult => ({
  documentId: state.documentId,
  tokensPacked: snapshotToPackedEditorTokens(state.tokenizer.getSnapshot()),
  theme: editorThemeFromHighlighter(state.highlighter, state.theme, state.themeRegistration),
})

const documentMatches = (state: DocumentState, payload: ShikiWorkerDocumentOptions): boolean =>
  state.lang === payload.lang && state.theme === payload.theme

const disposeDocument = (documentId: string): void => {
  documents.delete(documentId)
  documentTasks.delete(documentId)
}

const disposeAll = (): void => {
  documents.clear()
  documentTasks.clear()
  for (const promise of highlighterPromises.values()) {
    void promise.then((highlighter) => highlighter.dispose()).catch(() => undefined)
  }
  highlighterPromises.clear()
}

const postResponse = (response: ShikiWorkerResponse): void => {
  const transfers = responseTransfers(response)
  const workerScope = self as unknown as {
    postMessage(response: ShikiWorkerResponse, transfer?: Transferable[]): void
  }
  if (transfers.length === 0) {
    workerScope.postMessage(response)
    return
  }
  workerScope.postMessage(response, transfers)
}

function responseTransfers(response: ShikiWorkerResponse): Transferable[] {
  if (!response.ok) return []
  if (!response.result?.tokensPacked) return []
  return packedEditorTokenTransfers(response.result.tokensPacked)
}

/**
 * Themes only. Languages are loaded into whichever highlighter a theme set already has, so keying on
 * them too would build a second highlighter — and reload every grammar — for each new language.
 */
const highlighterKey = (themes: readonly (string | ShikiWorkerThemeRegistration)[]): string =>
  JSON.stringify(themes.map(highlighterThemeKey).toSorted())

const highlighterThemeKey = (theme: string | ShikiWorkerThemeRegistration): string =>
  typeof theme === 'string' ? theme : theme.name

// Registrations arrive as plain JSON over postMessage; shiki accepts the same shape at runtime.
const highlighterThemeInput = (
  theme: string | ShikiWorkerThemeRegistration,
): string | ThemeRegistrationAny =>
  typeof theme === 'string' ? theme : (theme as ThemeRegistrationAny)

const unique = (items: readonly string[]): string[] => Array.from(new Set(items))

const createErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}

function editorThemeFromHighlighter(
  highlighter: HighlighterGeneric<string, string>,
  themeName: string,
  registration: ShikiWorkerThemeRegistration | undefined,
): EditorTheme | undefined {
  const getTheme = (highlighter as Partial<Pick<HighlighterGeneric<string, string>, 'getTheme'>>)
    .getTheme
  if (getTheme) {
    const theme = getTheme.call(highlighter, themeName) as ShikiThemeLike | undefined
    if (theme) return editorThemeFromShikiTheme(theme)
  }

  if (registration && registration.name === themeName) {
    return editorThemeFromShikiTheme(registration)
  }
  return undefined
}
