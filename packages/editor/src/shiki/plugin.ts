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
  readonly preloadThemes?: readonly string[]
  readonly onThemeChanged?: (listener: () => void) => (() => void) | void
  readonly workerOwner?: ShikiWorkerOwner
}

const DEFAULT_THEME = 'github-dark'

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
      const sharedOwner = options.workerOwner
      const owner = sharedOwner ?? createShikiWorkerOwner()
      let registration = context.registerHighlighter(createHighlighterProvider(options, owner))

      const reloadProvider = (): void => {
        registration.dispose()
        registration = context.registerHighlighter(createHighlighterProvider(options, owner))
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
        {
          dispose: () => {
            if (sharedOwner) return
            void owner.dispose().catch(() => undefined)
          },
        },
      ]
    },
  }
}

const createHighlighterProvider = (
  options: ShikiHighlighterPluginOptions,
  owner: ShikiWorkerOwner,
): EditorHighlighterProvider => {
  return {
    loadTheme: () => loadConfiguredTheme(options, owner),
    createSession: (sessionOptions) => createSession(sessionOptions, options, owner),
  }
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
    themes: pluginOptions.preloadThemes,
  } satisfies ShikiHighlighterSessionOptions)
}

const loadConfiguredTheme = (options: ShikiHighlighterPluginOptions, owner: ShikiWorkerOwner) =>
  owner.loadTheme({
    theme: shikiThemeName(options),
    themeRegistration: shikiThemeRegistration(options),
    themes: options.preloadThemes,
  })

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
