import { wordRangeAtOffset, type DocumentSessionChange, type TextEdit } from '@editor/core/document'
import type { VirtualizedTextHighlightStyle } from '@editor/core/rendering'
import {
  FIND_MATCHES_LIMIT,
  findMatchIndex,
  findMatches,
  nextMatchAfter,
  previousMatchBefore,
  type FindMatch,
  type FindQuery,
  type FindRange,
} from './search'
import { parseReplaceString, ReplacePattern } from './replacePattern'
import type { EditorFindOptions } from './types'

const FIND_MATCH_STYLE = { backgroundColor: 'rgba(234, 179, 8, 0.34)' }
const FIND_CURRENT_STYLE = { backgroundColor: 'rgba(245, 158, 11, 0.72)', color: '#111827' }
const FIND_SCOPE_STYLE = { backgroundColor: 'rgba(59, 130, 246, 0.22)' }
const EDITOR_THEME_VARIABLES = [
  '--editor-background',
  '--editor-foreground',
  '--editor-caret-color',
] as const

export type EditorFindSelectionRange = {
  readonly anchor: number
  readonly head: number
}

export type EditorFindResolvedSelection = {
  readonly anchorOffset: number
  readonly headOffset: number
  readonly startOffset: number
  readonly endOffset: number
  readonly collapsed: boolean
}

export type EditorFindHost = {
  readonly container: HTMLElement
  readonly scrollElement: HTMLDivElement
  hasDocument(): boolean
  materializeFullText(): string
  getSelections(): readonly EditorFindResolvedSelection[]
  focusEditor(): void
  setSelection(anchor: number, head: number, timingName: string, revealOffset?: number): void
  setSelections(
    selections: readonly EditorFindSelectionRange[],
    timingName: string,
    revealOffset?: number,
  ): void
  applyEdits(
    edits: readonly TextEdit[],
    timingName: string,
    selection?: EditorFindSelectionRange,
  ): void
  setRangeHighlight(
    name: string,
    ranges: readonly FindRange[],
    style: VirtualizedTextHighlightStyle,
  ): void
  clearRangeHighlight(name: string): void
}

export type EditorFindStartOptions = {
  readonly replace: boolean
  readonly focus: 'find' | 'replace' | 'none'
}

type EditorFindState = FindQuery & {
  readonly replaceString: string
  readonly preserveCase: boolean
  readonly revealed: boolean
  readonly replaceRevealed: boolean
  readonly inSelection: boolean
}

type ResolvedFindOptions = Required<EditorFindOptions>

export class EditorFindController {
  private readonly options: ResolvedFindOptions
  private readonly matchHighlightName: string
  private readonly currentHighlightName: string
  private readonly scopeHighlightName: string
  private widget: EditorFindWidget | null = null
  private state: EditorFindState = {
    searchString: '',
    replaceString: '',
    isRegex: false,
    matchCase: false,
    wholeWord: false,
    preserveCase: false,
    revealed: false,
    replaceRevealed: false,
    inSelection: false,
  }
  private matches: readonly FindMatch[] = []
  private scopes: readonly FindRange[] | null = null
  private currentIndex = -1

  public constructor(
    private readonly host: EditorFindHost,
    highlightPrefix: string,
    options: EditorFindOptions = {},
  ) {
    this.options = resolveFindOptions(options)
    this.matchHighlightName = `${highlightPrefix}-find-match`
    this.currentHighlightName = `${highlightPrefix}-find-current`
    this.scopeHighlightName = `${highlightPrefix}-find-scope`
  }

  public dispose(): void {
    this.clearHighlights()
    this.widget?.dispose()
    this.widget = null
  }

  public openFind(): boolean {
    return this.open({ replace: false, focus: 'find' })
  }

  public toggleFind(): boolean {
    if (this.state.revealed) return this.close()
    return this.openFind()
  }

  public openFindReplace(): boolean {
    return this.open({ replace: true, focus: 'replace' })
  }

  public close(): boolean {
    if (!this.state.revealed) return false

    this.state = { ...this.state, revealed: false, inSelection: false }
    this.scopes = null
    this.currentIndex = -1
    this.clearHighlights()
    this.widget?.hide()
    this.host.focusEditor()
    return true
  }

  public findNext(): boolean {
    if (!this.ensureFindReady('none')) return false

    const selection = this.primarySelection()
    const startOffset = selection?.endOffset ?? 0
    const match = nextMatchAfter(this.matches, startOffset, this.options.loop)
    return this.selectMatch(match)
  }

  public findPrevious(): boolean {
    if (!this.ensureFindReady('none')) return false

    const selection = this.primarySelection()
    const startOffset = selection?.startOffset ?? 0
    const match = previousMatchBefore(this.matches, startOffset, this.options.loop)
    return this.selectMatch(match)
  }

  public replaceOne(): boolean {
    if (!this.ensureFindReady('replace')) return false

    const match = this.currentOrSelectionMatch(true)
    if (!match) return this.findNext()

    const replaceText = this.replacePattern().buildReplaceString(
      match.matches,
      this.state.preserveCase,
    )
    this.host.applyEdits(
      [{ from: match.start, to: match.end, text: replaceText }],
      'input.findReplaceOne',
      { anchor: match.start + replaceText.length, head: match.start + replaceText.length },
    )
    this.research(true)
    return true
  }

  public replaceAll(): boolean {
    if (!this.ensureFindReady('replace')) return false

    const pattern = this.replacePattern()
    const matches = this.findAll(pattern.hasReplacementPatterns || this.state.preserveCase)
    if (matches.length === 0) return false

    const edits = mergeAdjacentReplaceEdits(
      matches.map((match) => ({
        from: match.start,
        to: match.end,
        text: pattern.buildReplaceString(match.matches, this.state.preserveCase),
      })),
    )
    this.host.applyEdits(edits, 'input.findReplaceAll')
    this.research(false)
    return true
  }

  public selectAllMatches(): boolean {
    if (!this.ensureFindReady('none')) return false
    if (this.matches.length === 0) return false

    const selections = orderedMatchSelections(this.matches, this.currentIndex)
    this.host.setSelections(selections, 'input.findSelectAll', selections[0]?.head)
    return true
  }

  public toggleMatchCase(): boolean {
    this.state = { ...this.state, matchCase: !this.state.matchCase }
    this.research(this.options.cursorMoveOnType)
    return true
  }

  public toggleWholeWord(): boolean {
    this.state = { ...this.state, wholeWord: !this.state.wholeWord }
    this.research(this.options.cursorMoveOnType)
    return true
  }

  public toggleRegex(): boolean {
    this.state = { ...this.state, isRegex: !this.state.isRegex }
    this.research(this.options.cursorMoveOnType)
    return true
  }

  public togglePreserveCase(): boolean {
    this.state = { ...this.state, preserveCase: !this.state.preserveCase }
    this.updateWidget()
    return true
  }

  public toggleReplace(): boolean {
    this.state = { ...this.state, replaceRevealed: !this.state.replaceRevealed }
    this.updateWidget()
    return true
  }

  public toggleFindInSelection(): boolean {
    if (this.state.inSelection) {
      this.state = { ...this.state, inSelection: false }
      this.scopes = null
      this.research(this.options.cursorMoveOnType)
      return true
    }

    const scopes = nonEmptySelectionRanges(this.host.getSelections())
    if (scopes.length === 0) return false

    this.state = { ...this.state, inSelection: true }
    this.scopes = scopes
    this.research(this.options.cursorMoveOnType)
    return true
  }

  public handleEditorChange(change: DocumentSessionChange | null): void {
    if (!this.state.revealed) return
    if (change?.kind === 'selection' || change?.kind === 'none') return

    if (this.state.inSelection) this.scopes = nonEmptySelectionRanges(this.host.getSelections())
    this.research(false)
  }

  private open(options: EditorFindStartOptions): boolean {
    if (!this.host.hasDocument()) return false

    const searchString = this.seedSearchString()
    this.state = {
      ...this.state,
      searchString: searchString || this.state.searchString,
      revealed: true,
      replaceRevealed: options.replace || this.state.replaceRevealed,
    }
    this.applyAutoFindInSelection()
    this.ensureWidget().show(this.state.replaceRevealed)
    this.research(false)
    this.focusWidget(options.focus)
    return true
  }

  private ensureFindReady(focus: 'find' | 'replace' | 'none'): boolean {
    if (!this.state.revealed) return this.open({ replace: focus === 'replace', focus })
    if (this.matches.length === 0) this.research(false)
    return this.state.searchString.length > 0
  }

  private setSearchString(value: string): void {
    this.state = { ...this.state, searchString: value }
    if (this.options.findOnType) this.research(this.options.cursorMoveOnType)
  }

  private setReplaceString(value: string): void {
    this.state = { ...this.state, replaceString: value }
    this.updateWidget()
  }

  private research(moveCursor: boolean): void {
    this.matches = this.findAll(false)
    this.currentIndex = currentMatchIndex(this.matches, this.primarySelection())
    this.updateHighlights()
    this.updateWidget()
    if (moveCursor) this.selectFirstMatchFromSelection()
  }

  private findAll(captureMatches: boolean): readonly FindMatch[] {
    return findMatches(
      this.host.materializeFullText(),
      this.state,
      this.scopes,
      captureMatches,
      FIND_MATCHES_LIMIT,
    )
  }

  private selectFirstMatchFromSelection(): void {
    const selection = this.primarySelection()
    const offset = selection?.endOffset ?? 0
    const match = nextMatchAfter(this.matches, offset, this.options.loop)
    this.selectMatch(match)
  }

  private selectMatch(match: FindMatch | null): boolean {
    if (!match) return false

    this.currentIndex = findMatchIndex(this.matches, match)
    this.host.setSelection(match.start, match.end, 'input.findNavigate', match.end)
    this.updateHighlights()
    this.updateWidget()
    return true
  }

  private updateHighlights(): void {
    this.host.setRangeHighlight(this.matchHighlightName, this.matches, FIND_MATCH_STYLE)
    this.host.setRangeHighlight(
      this.currentHighlightName,
      this.currentMatchRanges(),
      FIND_CURRENT_STYLE,
    )
    if (this.scopes) {
      this.host.setRangeHighlight(this.scopeHighlightName, this.scopes, FIND_SCOPE_STYLE)
      return
    }

    this.host.clearRangeHighlight(this.scopeHighlightName)
  }

  private currentMatchRanges(): readonly FindRange[] {
    const current = this.matches[this.currentIndex]
    return current ? [current] : []
  }

  private clearHighlights(): void {
    this.host.clearRangeHighlight(this.matchHighlightName)
    this.host.clearRangeHighlight(this.currentHighlightName)
    this.host.clearRangeHighlight(this.scopeHighlightName)
  }

  private updateWidget(): void {
    const widget = this.widget
    if (!widget) return

    widget.update({
      ...this.state,
      matchesCount: this.matches.length,
      matchesPosition: this.currentIndex >= 0 ? this.currentIndex + 1 : 0,
    })
  }

  private focusWidget(focus: 'find' | 'replace' | 'none'): void {
    const widget = this.widget
    if (!widget) return

    if (focus === 'find') widget.focusFindInput()
    if (focus === 'replace') widget.focusReplaceInput()
  }

  private ensureWidget(): EditorFindWidget {
    if (this.widget) return this.widget

    this.widget = new EditorFindWidget(
      this.host.container,
      this.host.scrollElement,
      this.createWidgetOptions(),
    )
    return this.widget
  }

  private createWidgetOptions(): EditorFindWidgetOptions {
    return {
      onSearchInput: (value) => this.setSearchString(value),
      onReplaceInput: (value) => this.setReplaceString(value),
      onToggleReplace: () => this.toggleReplace(),
      onPrevious: () => this.findPrevious(),
      onNext: () => this.findNext(),
      onClose: () => this.close(),
      onToggleCase: () => this.toggleMatchCase(),
      onToggleWholeWord: () => this.toggleWholeWord(),
      onToggleRegex: () => this.toggleRegex(),
      onToggleScope: () => this.toggleFindInSelection(),
      onTogglePreserveCase: () => this.togglePreserveCase(),
      onReplaceOne: () => this.replaceOne(),
      onReplaceAll: () => this.replaceAll(),
    }
  }

  private seedSearchString(): string {
    if (this.options.seedSearchStringFromSelection === 'never') return ''

    const text = this.host.materializeFullText()
    const selection = this.primarySelection()
    if (!selection) return ''
    if (!selection.collapsed) return selectedSingleLineText(text, selection)
    if (this.options.seedSearchStringFromSelection === 'selection') return ''

    const range = wordRangeAtOffset(text, selection.headOffset)
    return text.slice(range.start, range.end)
  }

  private applyAutoFindInSelection(): void {
    const scopes = nonEmptySelectionRanges(this.host.getSelections())
    if (scopes.length === 0) return
    if (this.options.autoFindInSelection === 'never') return
    if (this.options.autoFindInSelection === 'always') {
      this.state = { ...this.state, inSelection: true }
      this.scopes = scopes
      return
    }

    if (
      !scopes.some((scope) =>
        this.host.materializeFullText().slice(scope.start, scope.end).includes('\n'),
      )
    )
      return

    this.state = { ...this.state, inSelection: true }
    this.scopes = scopes
  }

  private currentOrSelectionMatch(captureMatches: boolean): FindMatch | null {
    const selection = this.primarySelection()
    if (!selection) return null

    const matches = captureMatches ? this.findAll(true) : this.matches
    return (
      matches.find(
        (match) => match.start === selection.startOffset && match.end === selection.endOffset,
      ) ?? null
    )
  }

  private replacePattern(): ReplacePattern {
    if (this.state.isRegex) return parseReplaceString(this.state.replaceString)
    return ReplacePattern.fromStaticValue(this.state.replaceString)
  }

  private primarySelection(): EditorFindResolvedSelection | null {
    return this.host.getSelections()[0] ?? null
  }
}

type EditorFindWidgetOptions = {
  readonly onSearchInput: (value: string) => void
  readonly onReplaceInput: (value: string) => void
  readonly onToggleReplace: () => void
  readonly onPrevious: () => void
  readonly onNext: () => void
  readonly onClose: () => void
  readonly onToggleCase: () => void
  readonly onToggleWholeWord: () => void
  readonly onToggleRegex: () => void
  readonly onToggleScope: () => void
  readonly onTogglePreserveCase: () => void
  readonly onReplaceOne: () => void
  readonly onReplaceAll: () => void
}

type EditorFindWidgetState = EditorFindState & {
  readonly matchesCount: number
  readonly matchesPosition: number
}

const FIND_ICONS = {
  caseSensitive: 'text-a-underline',
  close: 'x',
  next: 'caret-down',
  preserveCase: 'text-aa',
  previous: 'caret-up',
  regex: 'asterisk',
  replace: 'swap',
  replaceAll: 'arrows-clockwise',
  replaceToggle: 'caret-right',
  scope: 'selection',
  wholeWord: 'textbox',
} as const

type PhosphorIconName = (typeof FIND_ICONS)[keyof typeof FIND_ICONS]

class EditorFindWidget {
  private readonly root: HTMLDivElement
  private readonly findInput: HTMLInputElement
  private readonly replaceInput: HTMLInputElement
  private readonly replaceRow: HTMLDivElement
  private readonly count: HTMLSpanElement
  private readonly replaceToggleButton: HTMLButtonElement
  private readonly caseButton: HTMLButtonElement
  private readonly wordButton: HTMLButtonElement
  private readonly regexButton: HTMLButtonElement
  private readonly scopeButton: HTMLButtonElement
  private readonly preserveButton: HTMLButtonElement

  public constructor(
    container: HTMLElement,
    private readonly themeSource: HTMLElement,
    private readonly options: EditorFindWidgetOptions,
  ) {
    const document = container.ownerDocument
    const position = container.ownerDocument.defaultView?.getComputedStyle(container).position
    if (!position || position === 'static') container.style.position = 'relative'
    this.root = document.createElement('div')
    this.findInput = document.createElement('input')
    this.replaceInput = document.createElement('input')
    this.replaceRow = document.createElement('div')
    this.count = document.createElement('span')
    this.replaceToggleButton = createFindButton(
      document,
      FIND_ICONS.replaceToggle,
      'Toggle Replace',
    )
    this.replaceToggleButton.classList.add('editor-find-replace-toggle')
    this.caseButton = createFindButton(document, FIND_ICONS.caseSensitive, 'Match Case')
    this.wordButton = createFindButton(document, FIND_ICONS.wholeWord, 'Whole Word')
    this.regexButton = createFindButton(document, FIND_ICONS.regex, 'Use Regular Expression')
    this.scopeButton = createFindButton(document, FIND_ICONS.scope, 'Find in Selection')
    this.preserveButton = createFindButton(document, FIND_ICONS.preserveCase, 'Preserve Case')
    this.build(document)
    container.appendChild(this.root)
  }

  public show(replaceVisible: boolean): void {
    syncEditorThemeVariables(this.root, this.themeSource)
    this.root.hidden = false
    this.replaceRow.hidden = !replaceVisible
  }

  public hide(): void {
    this.root.hidden = true
  }

  public update(state: EditorFindWidgetState): void {
    syncEditorThemeVariables(this.root, this.themeSource)
    if (this.findInput.value !== state.searchString) this.findInput.value = state.searchString
    if (this.replaceInput.value !== state.replaceString)
      this.replaceInput.value = state.replaceString
    this.replaceRow.hidden = !state.replaceRevealed
    setToggleExpanded(this.replaceToggleButton, state.replaceRevealed, 'Replace')
    this.count.textContent = resultCountText(state.matchesPosition, state.matchesCount)
    this.count.title = this.count.textContent
    setTogglePressed(this.caseButton, state.matchCase, 'Match Case')
    setTogglePressed(this.wordButton, state.wholeWord, 'Match Whole Word')
    setTogglePressed(this.regexButton, state.isRegex, 'Use Regular Expression')
    setTogglePressed(this.scopeButton, state.inSelection, 'Find in Selection')
    setTogglePressed(this.preserveButton, state.preserveCase, 'Preserve Case')
  }

  public focusFindInput(): void {
    this.findInput.focus()
    this.findInput.select()
  }

  public focusReplaceInput(): void {
    this.replaceInput.focus()
    this.replaceInput.select()
  }

  public dispose(): void {
    this.root.remove()
  }

  private build(document: Document): void {
    this.root.className = 'editor-find-widget'
    this.root.hidden = true
    this.findInput.className = 'editor-find-input'
    this.findInput.type = 'text'
    this.findInput.placeholder = 'Find'
    this.findInput.title = 'Find'
    this.findInput.spellcheck = false
    this.findInput.autocomplete = 'off'
    this.findInput.setAttribute('aria-label', 'Find')
    this.replaceInput.className = 'editor-find-input editor-find-input-standalone'
    this.replaceInput.type = 'text'
    this.replaceInput.placeholder = 'Replace'
    this.replaceInput.title = 'Replace'
    this.replaceInput.spellcheck = false
    this.replaceInput.autocomplete = 'off'
    this.replaceInput.setAttribute('aria-label', 'Replace')
    this.replaceRow.className = 'editor-find-row editor-find-replace-row'
    this.count.className = 'editor-find-count'

    this.root.append(this.findRow(document), this.replaceRow)
    this.installHandlers()
  }

  private findRow(document: Document): HTMLDivElement {
    const row = document.createElement('div')
    row.className = 'editor-find-row'
    row.append(
      this.replaceToggleButton,
      this.findInputFrame(document),
      this.count,
      this.scopeButton,
      createFindButton(document, FIND_ICONS.previous, 'Previous Match', this.options.onPrevious),
      createFindButton(document, FIND_ICONS.next, 'Next Match', this.options.onNext),
      createFindButton(document, FIND_ICONS.close, 'Close', this.options.onClose),
    )
    this.replaceRow.append(
      this.replaceInput,
      this.preserveButton,
      createFindButton(document, FIND_ICONS.replace, 'Replace', this.options.onReplaceOne),
      createFindButton(document, FIND_ICONS.replaceAll, 'Replace All', this.options.onReplaceAll),
    )
    return row
  }

  private findInputFrame(document: Document): HTMLDivElement {
    const frame = document.createElement('div')
    const controls = document.createElement('div')
    frame.className = 'editor-find-input-frame'
    controls.className = 'editor-find-input-controls'
    controls.append(this.caseButton, this.wordButton, this.regexButton)
    frame.append(this.findInput, controls)
    return frame
  }

  private installHandlers(): void {
    this.root.addEventListener('keydown', (event) => this.handleKeyDown(event))
    this.findInput.addEventListener('input', () => this.options.onSearchInput(this.findInput.value))
    this.replaceInput.addEventListener('input', () =>
      this.options.onReplaceInput(this.replaceInput.value),
    )
    this.caseButton.addEventListener('click', this.options.onToggleCase)
    this.wordButton.addEventListener('click', this.options.onToggleWholeWord)
    this.regexButton.addEventListener('click', this.options.onToggleRegex)
    this.replaceToggleButton.addEventListener('click', this.options.onToggleReplace)
    this.scopeButton.addEventListener('click', this.options.onToggleScope)
    this.preserveButton.addEventListener('click', this.options.onTogglePreserveCase)
  }

  private handleKeyDown(event: KeyboardEvent): void {
    event.stopPropagation()
    if (isFindToggleKey(event)) {
      event.preventDefault()
      this.options.onClose()
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      this.options.onClose()
      return
    }

    if (event.key !== 'Enter') return
    event.preventDefault()
    if (event.target === this.replaceInput && !event.shiftKey) {
      this.options.onReplaceOne()
      return
    }
    if (event.shiftKey) this.options.onPrevious()
    else this.options.onNext()
  }
}

function resolveFindOptions(options: EditorFindOptions): ResolvedFindOptions {
  return {
    loop: options.loop ?? true,
    seedSearchStringFromSelection: options.seedSearchStringFromSelection ?? 'always',
    findOnType: options.findOnType ?? true,
    cursorMoveOnType: options.cursorMoveOnType ?? true,
    autoFindInSelection: options.autoFindInSelection ?? 'never',
  }
}

function selectedSingleLineText(text: string, selection: EditorFindResolvedSelection): string {
  const value = text.slice(selection.startOffset, selection.endOffset)
  if (value.includes('\n')) return ''
  return value
}

function nonEmptySelectionRanges(
  selections: readonly EditorFindResolvedSelection[],
): readonly FindRange[] {
  return selections
    .filter((selection) => !selection.collapsed)
    .map((selection) => ({ start: selection.startOffset, end: selection.endOffset }))
}

function currentMatchIndex(
  matches: readonly FindMatch[],
  selection: EditorFindResolvedSelection | null,
): number {
  if (!selection) return -1
  return matches.findIndex(
    (match) => match.start === selection.startOffset && match.end === selection.endOffset,
  )
}

function orderedMatchSelections(
  matches: readonly FindMatch[],
  currentIndex: number,
): readonly EditorFindSelectionRange[] {
  const selections = matches.map((match) => ({ anchor: match.start, head: match.end }))
  if (currentIndex <= 0) return selections

  const current = selections[currentIndex]
  if (!current) return selections
  return [current, ...selections.slice(0, currentIndex), ...selections.slice(currentIndex + 1)]
}

function mergeAdjacentReplaceEdits(edits: readonly TextEdit[]): readonly TextEdit[] {
  const sorted = edits.toSorted((left, right) => left.from - right.from || left.to - right.to)
  const merged: TextEdit[] = []
  for (const edit of sorted) mergeReplaceEdit(merged, edit)
  return merged
}

function mergeReplaceEdit(merged: TextEdit[], edit: TextEdit): void {
  const previous = merged.at(-1)
  if (!previous || previous.to !== edit.from) {
    merged.push({ ...edit })
    return
  }

  merged[merged.length - 1] = {
    from: previous.from,
    to: edit.to,
    text: previous.text + edit.text,
  }
}

function createFindButton(
  document: Document,
  icon: PhosphorIconName,
  title: string,
  onClick?: () => void,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'editor-find-button'
  button.appendChild(createPhosphorIcon(document, icon))
  setNativeTooltip(button, title)
  if (onClick) button.addEventListener('click', onClick)
  return button
}

function syncEditorThemeVariables(target: HTMLElement, source: HTMLElement): void {
  const style = source.ownerDocument.defaultView?.getComputedStyle(source)
  if (!style) return

  for (const variable of EDITOR_THEME_VARIABLES) {
    const value =
      source.style.getPropertyValue(variable).trim() || style.getPropertyValue(variable).trim()
    if (value) target.style.setProperty(variable, value)
  }
}

function createPhosphorIcon(document: Document, icon: PhosphorIconName): HTMLElement {
  const element = document.createElement('i')
  element.className = `ph ph-${icon}`
  element.setAttribute('aria-hidden', 'true')
  return element
}

function setTogglePressed(button: HTMLButtonElement, pressed: boolean, label: string): void {
  button.classList.toggle('active', pressed)
  button.setAttribute('aria-pressed', pressed ? 'true' : 'false')
  setNativeTooltip(button, toggleTooltip(label, pressed))
}

function setToggleExpanded(button: HTMLButtonElement, expanded: boolean, label: string): void {
  button.classList.toggle('active', expanded)
  button.setAttribute('aria-expanded', expanded ? 'true' : 'false')
  setNativeTooltip(button, expanded ? `Hide ${label}` : `Show ${label}`)
}

function setNativeTooltip(element: HTMLElement, value: string): void {
  element.title = value
  element.setAttribute('aria-label', value)
}

function isFindToggleKey(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== 'f') return false
  if (event.altKey || event.shiftKey) return false
  return event.metaKey || event.ctrlKey
}

function toggleTooltip(label: string, active: boolean): string {
  return active ? `${label} (On)` : `${label} (Off)`
}

function resultCountText(position: number, count: number): string {
  if (count === 0) return 'No results'
  return `${position || '?'} of ${count}`
}
