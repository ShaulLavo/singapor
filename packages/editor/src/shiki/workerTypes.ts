import type { EditorTheme } from '../theme'
import type { EditorToken, TextEdit } from '../tokens'
import type { PackedEditorTokens } from '../syntax/packedTokens'
import type { EditorShikiThemeSettingLike } from './theme'

export type ShikiWorkerThemeRegistration = {
  readonly name: string
  readonly bg?: string
  readonly fg?: string
  readonly colors?: Readonly<Record<string, string | undefined>>
  readonly tokenColors?: readonly EditorShikiThemeSettingLike[]
  readonly settings?: readonly EditorShikiThemeSettingLike[]
}

export type ShikiWorkerLanguageRegistration = {
  readonly name: string
  readonly scopeName: string
  readonly aliases?: readonly string[]
  readonly patterns?: readonly unknown[]
  readonly repository?: Readonly<Record<string, unknown>>
}

export type ShikiWorkerDocumentOptions = {
  readonly documentId: string
  readonly lang: string
  readonly theme: string
  readonly languageRegistrations: readonly ShikiWorkerLanguageRegistration[]
  readonly themeRegistration: ShikiWorkerThemeRegistration
  readonly themeRegistrations: readonly ShikiWorkerThemeRegistration[]
  readonly text?: string
}

export type ShikiWorkerOpenRequest = ShikiWorkerDocumentOptions & {
  readonly type: 'open'
  readonly text: string
}

export type ShikiWorkerEditRequest = ShikiWorkerDocumentOptions & {
  readonly type: 'edit'
  readonly edit?: TextEdit
}

type ShikiWorkerDisposeDocumentRequest = {
  readonly type: 'disposeDocument'
  readonly documentId: string
}

type ShikiWorkerDisposeRequest = {
  readonly type: 'dispose'
}

export type ShikiWorkerThemeRequest = {
  readonly type: 'theme'
  readonly theme: string
  readonly themeRegistration: ShikiWorkerThemeRegistration
  readonly themeRegistrations: readonly ShikiWorkerThemeRegistration[]
}

export type ShikiWorkerPreloadRequest = {
  readonly type: 'preload'
  readonly languageRegistrations: readonly ShikiWorkerLanguageRegistration[]
  readonly themeRegistrations: readonly ShikiWorkerThemeRegistration[]
}

export type ShikiWorkerRequestPayload =
  | ShikiWorkerOpenRequest
  | ShikiWorkerEditRequest
  | ShikiWorkerDisposeDocumentRequest
  | ShikiWorkerDisposeRequest
  | ShikiWorkerPreloadRequest
  | ShikiWorkerThemeRequest

export type ShikiWorkerResult = {
  readonly documentId?: string
  readonly tokens?: readonly EditorToken[]
  readonly theme?: EditorTheme
}

export type ShikiWorkerTransportResult = {
  readonly documentId?: string
  readonly tokensPacked?: PackedEditorTokens
  readonly theme?: EditorTheme
}

export type ShikiWorkerRequest = {
  readonly id: number
  readonly payload: ShikiWorkerRequestPayload
}

export type ShikiWorkerResponse =
  | {
      readonly id: number
      readonly ok: true
      readonly result?: ShikiWorkerTransportResult
    }
  | {
      readonly id: number
      readonly ok: false
      readonly error: string
    }
