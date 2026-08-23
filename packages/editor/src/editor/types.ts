import type { DocumentSessionChange } from '../documentSession'
import type {
  EditorSyntaxLanguageId,
  EditorSyntaxSession,
  EditorSyntaxSessionOptions,
} from '../syntax/session'
import type { EditorPlugin } from '../plugins'
import type { EditorTheme } from '../theme'
import type {
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
  VirtualizedTextViewRowPositioning,
  VirtualizedTextViewScrollMode,
} from '../virtualization/virtualizedTextViewTypes'
import type { BrowserTextMetrics } from '../virtualization/browserMetrics'
import type { EditorKeymapOptions } from './keymap'
import type { EditorSuspiciousCharactersOptions } from '../unicodeHighlight'
import type { TextEdit } from '../tokens'

/** Minimal interface for the CSS Custom Highlight API registry. */
export interface HighlightRegistry {
  set(name: string, highlight: Highlight): void
  delete(name: string): boolean
}

export type EditorSessionChangeHandler = (change: DocumentSessionChange) => void

export type EditorEditability = 'editable' | 'readonly'

export type EditorDocumentMode = 'session' | 'static'

export type EditorSelectionSyncMode = 'sync' | 'none'

export type EditorScrollMode = VirtualizedTextViewScrollMode

type EditorRowPositioning = VirtualizedTextViewRowPositioning

export type EditorRangeDecoration = {
  readonly className?: string
  readonly end: number
  readonly start: number
  readonly style?: Partial<CSSStyleDeclaration>
  /**
   * Stacking order against other range decorations, highest paints last. Without it the CSS
   * highlight registry falls back to registration order, which reshuffles as groups scroll in
   * and out of the mounted window.
   */
  readonly zIndex?: number
}

export type EditorScrollPosition = {
  readonly top?: number
  readonly left?: number
}

export type EditorSessionOptions = {
  readonly documentId?: string | null
  readonly languageId?: EditorSyntaxLanguageId | null
  readonly onChange?: EditorSessionChangeHandler
  readonly scrollPosition?: EditorScrollPosition
}

export type EditorSyntaxStatus = 'plain' | 'loading' | 'ready' | 'degraded' | 'error'

export type EditorState = {
  readonly documentId: string | null
  readonly documentMode: EditorDocumentMode
  readonly editability: EditorEditability
  readonly languageId: EditorSyntaxLanguageId | null
  readonly syntaxStatus: EditorSyntaxStatus
  readonly cursor: {
    readonly row: number
    readonly column: number
  }
  readonly length: number
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly isDirty: boolean
}

export type EditorChangeHandler = (state: EditorState, change: DocumentSessionChange | null) => void

export type EditorOptions = {
  readonly defaultText?: string
  readonly documentMode?: EditorDocumentMode
  readonly editability?: EditorEditability
  readonly theme?: EditorTheme
  readonly onChange?: EditorChangeHandler
  readonly plugins?: readonly EditorPlugin[]
  readonly keymap?: EditorKeymapOptions
  readonly cursorLineHighlight?: EditorCursorLineHighlightOptions
  readonly hiddenCharacters?: HiddenCharactersMode
  readonly lineHeight?: number
  readonly rangeDecorations?: readonly EditorRangeDecoration[]
  readonly rowGap?: number
  readonly rowPositioning?: EditorRowPositioning
  /**
   * Moves character-step carets by screen direction; word and subword motion stay logical.
   * Defaults off on Windows and on elsewhere.
   */
  readonly rtlMoveVisually?: boolean
  readonly scrollMode?: EditorScrollMode
  readonly selectionSyncMode?: EditorSelectionSyncMode
  /** Confusable and invisible characters to point out; both families report unless turned off. */
  readonly suspiciousCharacters?: EditorSuspiciousCharactersOptions
  readonly tabSize?: number
  /**
   * Hands Tab back to the page instead of indenting with it, for a reader who would otherwise have
   * no key left to leave the editor by. Ctrl+M turns it on and off from inside.
   */
  readonly tabMovesFocus?: boolean
  readonly textMetrics?: BrowserTextMetrics
  /** Soft-wraps long lines to the viewport width instead of scrolling horizontally. */
  readonly wordWrap?: boolean
}

export type EditorSetTextOptions = {
  readonly documentMode?: EditorDocumentMode
  readonly languageId?: EditorSyntaxLanguageId | null
  readonly scrollPosition?: EditorScrollPosition
}

export type EditorOpenDocumentOptions = EditorSetTextOptions & {
  readonly text: string
  readonly documentId?: string
}

export type EditorEditHistoryMode = 'record' | 'skip'

export type EditorEditSelection = {
  readonly anchor: number
  readonly head?: number
}

export type EditorEditOptions = {
  readonly history?: EditorEditHistoryMode
  readonly selection?: EditorEditSelection
}

export type EditorEditInput = TextEdit | readonly TextEdit[]

export type EditorSyntaxSessionFactory = (
  options: EditorSyntaxSessionOptions,
) => EditorSyntaxSession
