import type {
  EditorHighlighterProvider,
  EditorHighlighterSessionOptions,
  EditorPlugin,
} from '../plugins'
import type { EditorSyntaxLanguageId } from '../syntax/session'
import {
  createShikiWorkerOwner,
  type ShikiHighlighterSessionOptions,
  type ShikiWorkerOwner,
} from './workerClient'
import type { ShikiWorkerThemeRegistration } from './workerTypes'

export type ShikiLanguageMap = Partial<Record<EditorSyntaxLanguageId, string>>

export type ShikiHighlighterPluginOptions = {
  readonly theme?: string | (() => string)
  readonly themeRegistration?:
    | ShikiWorkerThemeRegistration
    | (() => ShikiWorkerThemeRegistration | undefined)
  readonly languages?: ShikiLanguageMap
  readonly preloadLanguages?: readonly string[]
  /**
   * Themes to name alongside the active one when a session is created. The
   * worker cache-keys a highlighter on its theme set, so naming a stable set
   * keeps theme swaps on one highlighter instead of building a new one each
   * time. Resolved per session, so a host can widen the set once switching
   * themes becomes likely rather than paying for it at every document open.
   */
  readonly preloadThemes?: readonly string[] | (() => readonly string[])
  readonly onThemeChanged?: (listener: () => void) => (() => void) | void
  readonly workerOwner?: ShikiWorkerOwner
}

const DEFAULT_THEME = 'github-dark'
const DEFAULT_SHIKI_WORKER_OWNER_KEY = Symbol.for('@singapor/core/shiki/default-worker-owner')

const DEFAULT_LANGUAGE_MAP: ShikiLanguageMap = {
  css: 'css',
  html: 'html',
  javascriptreact: 'jsx',
  javascript: 'javascript',
  json: 'json',
  tsx: 'tsx',
  typescriptreact: 'tsx',
  typescript: 'typescript',
}

export function createShikiHighlighterPlugin(
  options: ShikiHighlighterPluginOptions = {},
): EditorPlugin {
  return {
    name: 'shiki-highlighter',
    activate(context) {
      let registration = context.registerHighlighter(createShikiHighlighterProvider(options))

      const reloadProvider = (): void => {
        registration.dispose()
        registration = context.registerHighlighter(createShikiHighlighterProvider(options))
      }
      const unsubscribeTheme = options.onThemeChanged?.(reloadProvider)

      return [
        {
          dispose: () => {
            registration.dispose()
          },
        },
        {
          dispose: () => {
            unsubscribeTheme?.()
          },
        },
      ]
    },
  }
}

/**
 * Builds the provider separately from its editor plugin so secondary views can share the exact
 * highlighter, worker owner, language map and theme resolver used by regular editor documents.
 */
export function createShikiHighlighterProvider(
  options: ShikiHighlighterPluginOptions = {},
): EditorHighlighterProvider {
  const owner = options.workerOwner ?? defaultShikiWorkerOwner()
  return {
    loadTheme: () => loadConfiguredTheme(options, owner),
    createSession: (sessionOptions) => createSession(sessionOptions, options, owner),
  }
}

const defaultShikiWorkerOwner = (): ShikiWorkerOwner => {
  const state = globalThis as Record<PropertyKey, unknown>
  const existing = state[DEFAULT_SHIKI_WORKER_OWNER_KEY] as ShikiWorkerOwner | undefined
  if (existing) return existing

  const owner = createShikiWorkerOwner()
  state[DEFAULT_SHIKI_WORKER_OWNER_KEY] = owner
  return owner
}

const createSession = (
  sessionOptions: EditorHighlighterSessionOptions,
  pluginOptions: ShikiHighlighterPluginOptions,
  owner: ShikiWorkerOwner,
) => {
  if (!owner.canUseWorker()) return null

  const lang = shikiLanguageForSession(sessionOptions, pluginOptions.languages)
  if (!lang) return null

  return owner.createSession({
    ...sessionOptions,
    lang,
    theme: shikiThemeName(pluginOptions),
    themeRegistration: shikiThemeRegistration(pluginOptions),
    langs: preloadLanguages(lang, pluginOptions),
    themes: preloadThemes(pluginOptions),
  } satisfies ShikiHighlighterSessionOptions)
}

const loadConfiguredTheme = (options: ShikiHighlighterPluginOptions, owner: ShikiWorkerOwner) =>
  owner.loadTheme({
    theme: shikiThemeName(options),
    themeRegistration: shikiThemeRegistration(options),
    themes: preloadThemes(options),
  })

const preloadThemes = (options: ShikiHighlighterPluginOptions): readonly string[] | undefined => {
  const themes = options.preloadThemes
  if (typeof themes === 'function') return themes()

  return themes
}

const shikiThemeName = (options: ShikiHighlighterPluginOptions): string => {
  const theme = options.theme
  if (typeof theme === 'function') return theme()

  return theme ?? DEFAULT_THEME
}

const shikiThemeRegistration = (
  options: ShikiHighlighterPluginOptions,
): ShikiWorkerThemeRegistration | undefined => {
  const themeRegistration = options.themeRegistration
  const registration =
    typeof themeRegistration === 'function' ? themeRegistration() : themeRegistration
  if (!registration) return undefined
  if (!registration.name) throw new Error('Shiki theme registrations require a non-empty name')

  return registration
}

const shikiLanguageForSession = (
  options: EditorHighlighterSessionOptions,
  languages: ShikiLanguageMap | undefined,
): string | null => {
  if (!options.languageId) return null

  const configured = languages?.[options.languageId]
  if (configured) return configured

  const extensionLang = shikiLanguageForDocumentExtension(options.documentId, options.languageId)
  return extensionLang ?? DEFAULT_LANGUAGE_MAP[options.languageId] ?? null
}

const preloadLanguages = (
  lang: string,
  options: ShikiHighlighterPluginOptions,
): readonly string[] => [lang, ...Array.from(options.preloadLanguages ?? [])]

const shikiLanguageForDocumentExtension = (
  documentId: string,
  languageId: EditorSyntaxLanguageId,
): string | null => {
  const extension = extensionForDocumentId(documentId)
  if (languageId === 'typescript' && extension === '.tsx') return 'tsx'
  if (languageId === 'javascript' && extension === '.jsx') return 'jsx'
  return null
}

const extensionForDocumentId = (documentId: string): string | null => {
  const path = documentId.split(/[?#]/, 1)[0] ?? documentId
  const slashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dotIndex = path.lastIndexOf('.')
  if (dotIndex <= slashIndex) return null
  return path.slice(dotIndex).toLowerCase()
}
