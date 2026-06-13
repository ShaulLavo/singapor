type EditorInputPhase =
  | 'idle'
  | 'composing'
  | 'beforeinput-pending'
  | 'native-input-observed'
  | 'fallback-pending'
  | 'transaction-committed'
  | 'selection-reconciled'

type EditorInputSelectionOwner = 'dom' | 'hidden-input' | 'session'
type EditorHiddenInputValueOwner = 'browser' | 'editor'
type EditorPendingTextSource = 'beforeinput' | 'composition' | 'paste' | 'drop' | 'fallback'
type NativeTextInputState = 'unknown' | 'observed' | 'missing'

export type EditorInputState = {
  readonly phase: EditorInputPhase
  readonly selectionOwner: EditorInputSelectionOwner
  readonly hiddenInputValueOwner: EditorHiddenInputValueOwner
  readonly pendingText: string
  readonly pendingTextSource: EditorPendingTextSource | null
  readonly fallbackGeneration: number | null
  readonly fallbackStartMs: number | null
  readonly nativeInputGeneration: number
  readonly nativeTextInputState: NativeTextInputState
  readonly compositionActive: boolean
  readonly compositionCommitted: boolean
  readonly compositionText: string
  readonly mouseSelectionActive: boolean
}

export type EditorInputStateOwnership = {
  readonly domSelection: 'browser' | 'editor'
  readonly sessionSelection: 'document-session'
  readonly hiddenInputValue: EditorHiddenInputValueOwner
  readonly pendingText: 'none' | 'state-machine'
  readonly fallbackGeneration: 'none' | 'state-machine'
}

export type EditorInputStateTransition =
  | { readonly type: 'composition-start' }
  | { readonly type: 'composition-update'; readonly text: string }
  | { readonly type: 'composition-pending'; readonly text: string }
  | { readonly type: 'composition-end' }
  | { readonly type: 'beforeinput-pending'; readonly text?: string }
  | { readonly type: 'paste-pending'; readonly text: string }
  | { readonly type: 'drop-pending'; readonly text: string }
  | { readonly type: 'native-input-observed' }
  | {
      readonly type: 'native-input-wait-started'
      readonly generation: number
      readonly startMs: number
      readonly text: string
    }
  | { readonly type: 'native-input-wait-appended'; readonly startMs: number; readonly text: string }
  | { readonly type: 'native-input-wait-cancelled' }
  | { readonly type: 'native-input-missing'; readonly generation: number }
  | { readonly type: 'transaction-committed' }
  | { readonly type: 'selection-reconciled'; readonly owner: EditorInputSelectionOwner }
  | { readonly type: 'selection-owned-by-dom' }
  | { readonly type: 'selection-owned-by-hidden-input' }
  | { readonly type: 'selection-owned-by-session' }
  | { readonly type: 'mouse-selection-start' }
  | { readonly type: 'mouse-selection-finish' }
  | { readonly type: 'mouse-selection-cancel' }
  | { readonly type: 'hidden-input-cleared' }

export type NativeTextInputWaitOptions = {
  readonly targetIsHiddenInput: boolean
  readonly text: string
}

export type EditorDomSelectionContext = {
  readonly hiddenInputFocused: boolean
}

export type EditorSelectionBeforeEditSource = 'dom' | 'hidden-input' | 'session'

export type PendingKeyboardTextFallback = {
  readonly generation: number
  readonly startMs: number
  readonly text: string
}

export function createEditorInputState(): EditorInputState {
  return {
    phase: 'idle',
    selectionOwner: 'dom',
    hiddenInputValueOwner: 'editor',
    pendingText: '',
    pendingTextSource: null,
    fallbackGeneration: null,
    fallbackStartMs: null,
    nativeInputGeneration: 0,
    nativeTextInputState: 'unknown',
    compositionActive: false,
    compositionCommitted: false,
    compositionText: '',
    mouseSelectionActive: false,
  }
}

export function transitionEditorInputState(
  state: EditorInputState,
  transition: EditorInputStateTransition,
): EditorInputState {
  if (transition.type === 'composition-start') {
    return startComposition(state)
  }
  if (transition.type === 'composition-update') return updateComposition(state, transition.text)
  if (transition.type === 'composition-pending') {
    return setPendingText(state, 'composition', transition.text)
  }
  if (transition.type === 'composition-end') return endComposition(state)
  if (transition.type === 'beforeinput-pending') {
    return setPendingText(state, 'beforeinput', transition.text ?? '')
  }
  if (transition.type === 'paste-pending') return setPendingText(state, 'paste', transition.text)
  if (transition.type === 'drop-pending') return setPendingText(state, 'drop', transition.text)
  if (transition.type === 'native-input-observed') return nativeInputObserved(state)
  if (transition.type === 'native-input-wait-started') {
    return startNativeInputWait(state, transition)
  }
  if (transition.type === 'native-input-wait-appended') {
    return appendNativeInputWaitText(state, transition)
  }
  if (transition.type === 'native-input-wait-cancelled') return cancelNativeInputWait(state)
  if (transition.type === 'native-input-missing') return nativeInputMissing(state, transition)
  if (transition.type === 'transaction-committed') {
    return commitTransaction(state)
  }
  if (transition.type === 'selection-reconciled') {
    return { ...state, phase: 'selection-reconciled', selectionOwner: transition.owner }
  }
  if (transition.type === 'selection-owned-by-dom') return selectionOwnedBy(state, 'dom')
  if (transition.type === 'selection-owned-by-hidden-input') {
    return selectionOwnedBy(state, 'hidden-input')
  }
  if (transition.type === 'selection-owned-by-session') return selectionOwnedBy(state, 'session')
  if (transition.type === 'mouse-selection-start') return startMouseSelection(state)
  if (transition.type === 'mouse-selection-finish') return finishMouseSelection(state)
  if (transition.type === 'mouse-selection-cancel') return cancelMouseSelection(state)

  return { ...state, hiddenInputValueOwner: 'editor' }
}

export function editorInputStateOwnership(state: EditorInputState): EditorInputStateOwnership {
  return {
    domSelection: state.selectionOwner === 'dom' ? 'browser' : 'editor',
    sessionSelection: 'document-session',
    hiddenInputValue: state.hiddenInputValueOwner,
    pendingText: state.pendingText.length === 0 ? 'none' : 'state-machine',
    fallbackGeneration: state.fallbackGeneration === null ? 'none' : 'state-machine',
  }
}

export function canWaitForNativeTextInput(
  state: EditorInputState,
  options: NativeTextInputWaitOptions,
): boolean {
  if (state.compositionActive) return false
  if (options.text === ' ') return false
  if (state.nativeTextInputState === 'missing') return false
  return options.targetIsHiddenInput
}

export function shouldCommitCompositionEnd(state: EditorInputState, text: string): boolean {
  if (!state.compositionActive) return false
  if (state.compositionCommitted) return false
  return text.length > 0
}

export function pendingKeyboardTextFallback(
  state: EditorInputState,
): PendingKeyboardTextFallback | null {
  if (state.phase !== 'fallback-pending') return null
  if (state.pendingTextSource !== 'fallback') return null
  if (state.fallbackGeneration === null) return null
  if (state.fallbackStartMs === null) return null

  return {
    generation: state.fallbackGeneration,
    startMs: state.fallbackStartMs,
    text: state.pendingText,
  }
}

export function hasPendingKeyboardTextFallbackForGeneration(
  state: EditorInputState,
  generation: number,
): boolean {
  return pendingKeyboardTextFallback(state)?.generation === generation
}

export function shouldSyncSessionSelectionFromDom(
  state: EditorInputState,
  context: EditorDomSelectionContext,
): boolean {
  if (state.mouseSelectionActive) return false
  if (state.selectionOwner === 'session') return false
  return !context.hiddenInputFocused
}

export function shouldSyncCustomSelectionFromDom(
  state: EditorInputState,
  context: EditorDomSelectionContext,
): boolean {
  return shouldSyncSessionSelectionFromDom(state, context)
}

export function selectionBeforeEditSource(
  state: EditorInputState,
  context: EditorDomSelectionContext,
): EditorSelectionBeforeEditSource {
  if (context.hiddenInputFocused) return 'hidden-input'
  if (state.selectionOwner === 'session') return 'session'
  return 'dom'
}

function startComposition(state: EditorInputState): EditorInputState {
  return clearPendingText({
    ...state,
    phase: 'composing',
    compositionActive: true,
    compositionCommitted: false,
    compositionText: '',
  })
}

function updateComposition(state: EditorInputState, text: string): EditorInputState {
  if (!state.compositionActive) return state

  return {
    ...state,
    phase: 'composing',
    compositionText: text,
  }
}

function endComposition(state: EditorInputState): EditorInputState {
  return clearPendingText({
    ...state,
    phase: 'idle',
    compositionActive: false,
    compositionCommitted: false,
    compositionText: '',
  })
}

function commitTransaction(state: EditorInputState): EditorInputState {
  return clearPendingText({
    ...state,
    phase: 'transaction-committed',
    compositionCommitted: state.compositionActive || state.compositionCommitted,
  })
}

function nativeInputObserved(state: EditorInputState): EditorInputState {
  return clearPendingText({
    ...state,
    phase: 'native-input-observed',
    hiddenInputValueOwner: 'browser',
    nativeInputGeneration: state.nativeInputGeneration + 1,
    nativeTextInputState: 'observed',
  })
}

function nativeInputMissing(
  state: EditorInputState,
  transition: Extract<EditorInputStateTransition, { readonly type: 'native-input-missing' }>,
): EditorInputState {
  if (transition.generation !== state.nativeInputGeneration) return state
  return { ...state, nativeTextInputState: 'missing' }
}

function startNativeInputWait(
  state: EditorInputState,
  transition: Extract<EditorInputStateTransition, { readonly type: 'native-input-wait-started' }>,
): EditorInputState {
  return {
    ...state,
    phase: 'fallback-pending',
    pendingText: transition.text,
    pendingTextSource: 'fallback',
    fallbackGeneration: transition.generation,
    fallbackStartMs: transition.startMs,
  }
}

function appendNativeInputWaitText(
  state: EditorInputState,
  transition: Extract<EditorInputStateTransition, { readonly type: 'native-input-wait-appended' }>,
): EditorInputState {
  if (state.phase !== 'fallback-pending') return state
  if (state.fallbackGeneration === null) return state

  return {
    ...state,
    pendingText: `${state.pendingText}${transition.text}`,
    pendingTextSource: 'fallback',
    fallbackStartMs: Math.min(state.fallbackStartMs ?? transition.startMs, transition.startMs),
  }
}

function cancelNativeInputWait(state: EditorInputState): EditorInputState {
  const phase = state.phase === 'fallback-pending' ? 'idle' : state.phase
  return clearPendingText({ ...state, phase })
}

function clearPendingText(state: EditorInputState): EditorInputState {
  return {
    ...state,
    pendingText: '',
    pendingTextSource: null,
    fallbackGeneration: null,
    fallbackStartMs: null,
  }
}

function setPendingText(
  state: EditorInputState,
  source: EditorPendingTextSource,
  text: string,
): EditorInputState {
  return {
    ...clearPendingText(state),
    phase: 'beforeinput-pending',
    pendingText: text,
    pendingTextSource: source,
  }
}

function selectionOwnedBy(
  state: EditorInputState,
  owner: EditorInputSelectionOwner,
): EditorInputState {
  return { ...state, phase: 'selection-reconciled', selectionOwner: owner }
}

function startMouseSelection(state: EditorInputState): EditorInputState {
  return {
    ...state,
    mouseSelectionActive: true,
  }
}

function finishMouseSelection(state: EditorInputState): EditorInputState {
  return {
    ...state,
    mouseSelectionActive: false,
  }
}

function cancelMouseSelection(state: EditorInputState): EditorInputState {
  return finishMouseSelection(state)
}
