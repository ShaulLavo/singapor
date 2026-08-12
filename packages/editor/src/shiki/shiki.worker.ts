import { createHighlighter, type HighlighterGeneric, type ThemeRegistrationAny } from 'shiki'
import { createIncrementalTokenizer, type IncrementalTokenizer } from './tokenizer'
import { snapshotToEditorTokens } from './editor-tokens'
import type { EditorTheme } from '../theme'
import { editorThemeFromShikiTheme, type ShikiThemeLike } from './theme-extract'
import type {
  ShikiWorkerDocumentOptions,
  ShikiWorkerEditRequest,
  ShikiWorkerOpenRequest,
  ShikiWorkerRequest,
  ShikiWorkerResponse,
  ShikiWorkerResult,
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
const documentTasks = new Map<string, Promise<ShikiWorkerResult | undefined>>()
const highlighterPromises = new Map<string, Promise<HighlighterGeneric<string, string>>>()

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
): Promise<ShikiWorkerResult | undefined> => {
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
  task: () => Promise<ShikiWorkerResult>,
): Promise<ShikiWorkerResult> => {
  const previous = documentTasks.get(documentId) ?? Promise.resolve(undefined)
  const next = previous.catch(() => undefined).then(task)
  documentTasks.set(documentId, next)
  void next.finally(() => clearDocumentTask(documentId, next)).catch(() => undefined)
  return next
}

const clearDocumentTask = (
  documentId: string,
  task: Promise<ShikiWorkerResult | undefined>,
): void => {
  if (documentTasks.get(documentId) !== task) return
  documentTasks.delete(documentId)
}

const openDocument = async (payload: ShikiWorkerOpenRequest): Promise<ShikiWorkerResult> => {
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
  return resultFromState(state)
}

const editDocument = async (payload: ShikiWorkerEditRequest): Promise<ShikiWorkerResult> => {
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

const ensureHighlighter = (
  options: ShikiWorkerDocumentOptions,
): Promise<HighlighterGeneric<string, string>> => {
  const langs = unique([options.lang, ...options.langs])
  const themes = highlighterThemes([options.theme, ...options.themes], options.themeRegistration)
  return ensureHighlighterFor(langs, themes)
}

const ensureHighlighterFor = (
  langs: readonly string[],
  themes: readonly (string | ShikiWorkerThemeRegistration)[],
): Promise<HighlighterGeneric<string, string>> => {
  const key = highlighterKey(langs, themes)
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

const loadTheme = async (payload: ShikiWorkerThemeRequest): Promise<ShikiWorkerResult> => {
  const themes = highlighterThemes([payload.theme, ...payload.themes], payload.themeRegistration)
  const highlighter = await ensureHighlighterFor([], themes)
  return {
    theme: editorThemeFromHighlighter(highlighter, payload.theme, payload.themeRegistration),
  }
}

const resultFromState = (state: DocumentState): ShikiWorkerResult => ({
  documentId: state.documentId,
  tokens: snapshotToEditorTokens(state.tokenizer.getSnapshot()),
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
  self.postMessage(response)
}

const highlighterKey = (
  langs: readonly string[],
  themes: readonly (string | ShikiWorkerThemeRegistration)[],
): string => {
  const normalizedLangs = langs.toSorted()
  const normalizedThemes = themes.map(highlighterThemeKey).toSorted()
  return JSON.stringify({ langs: normalizedLangs, themes: normalizedThemes })
}

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
