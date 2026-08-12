import type { EditorTheme } from '../theme'
import type { EditorToken, TextEdit } from '../tokens'
import type { EditorShikiThemeSettingLike } from './theme'

export type ShikiWorkerThemeRegistration = {
  readonly name: string
  readonly bg?: string
  readonly fg?: string
  readonly colors?: Readonly<Record<string, string | undefined>>
  readonly tokenColors?: readonly EditorShikiThemeSettingLike[]
  readonly settings?: readonly EditorShikiThemeSettingLike[]
}

export type ShikiWorkerDocumentOptions = {
  readonly documentId: string
  readonly lang: string
  readonly theme: string
  readonly themeRegistration?: ShikiWorkerThemeRegistration
  readonly text?: string
  readonly langs: readonly string[]
  readonly themes: readonly string[]
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
  readonly themeRegistration?: ShikiWorkerThemeRegistration
  readonly themes: readonly string[]
}

export type ShikiWorkerRequestPayload =
  | ShikiWorkerOpenRequest
  | ShikiWorkerEditRequest
  | ShikiWorkerDisposeDocumentRequest
  | ShikiWorkerDisposeRequest
  | ShikiWorkerThemeRequest

export type ShikiWorkerResult = {
  readonly documentId?: string
  readonly tokens?: readonly EditorToken[]
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
      readonly result?: ShikiWorkerResult
    }
  | {
      readonly id: number
      readonly ok: false
      readonly error: string
    }
