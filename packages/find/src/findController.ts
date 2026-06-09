import {
  wordRangeAtOffset,
  type DocumentSessionChange,
  type TextEdit,
} from '@singapor/core/document'
import type { EditorDisposable, EditorViewContributionUpdateKind } from '@singapor/core/extensions'
import type { VirtualizedTextHighlightStyle } from '@singapor/core/rendering'
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
  setRangeHighlight(
    name: string,
    ranges: readonly FindRange[],
    style: VirtualizedTextHighlightStyle,
  ): void
  clearRangeHighlight(name: string): void
}

export type EditorFindEditHost = {
  applyEdits(
    edits: readonly TextEdit[],
    timingName: string,
    selection?: EditorFindSelectionRange,
  ): void
}

export type EditorFindStartOptions = {
  readonly replace: boolean
  readonly focus: 'find' | 'replace' | 'none'
}

export type EditorFindState = FindQuery & {
  readonly replaceString: string
  readonly preserveCase: boolean
  readonly revealed: boolean
  readonly replaceRevealed: boolean
  readonly inSelection: boolean
}

export type EditorFindWidgetState = EditorFindState & {
  readonly matchesCount: number
  readonly matchesPosition: number
}

export type EditorFindUiEvent =
  | { readonly type: 'show'; readonly replaceVisible: boolean }
  | { readonly type: 'hide' }
  | { readonly type: 'focus'; readonly target: 'find' | 'replace' }
  | { readonly type: 'update'; readonly state: EditorFindWidgetState }

type ResolvedFindOptions = Required<EditorFindOptions>
type EditorFindUiListener = (event: EditorFindUiEvent) => void

export class EditorFindController {
  private readonly options: ResolvedFindOptions
  private readonly listeners = new Set<EditorFindUiListener>()
  private host: EditorFindHost | null = null
  private editHost: EditorFindEditHost | null = null
  private matchHighlightName = ''
  private currentHighlightName = ''
  private scopeHighlightName = ''
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

  public constructor(options: EditorFindOptions = {}) {
    this.options = resolveFindOptions(options)
  }

  public attachHost(host: EditorFindHost, highlightPrefix: string): EditorDisposable {
    if (this.host && this.host !== host) this.clearHighlights()

    this.host = host
    this.matchHighlightName = `${highlightPrefix}-find-match`
    this.currentHighlightName = `${highlightPrefix}-find-current`
    this.scopeHighlightName = `${highlightPrefix}-find-scope`
    return { dispose: () => this.detachHost(host) }
  }

  public attachEditHost(host: EditorFindEditHost): EditorDisposable {
    this.editHost = host
    return { dispose: () => this.detachEditHost(host) }
  }

  public subscribe(listener: EditorFindUiListener): EditorDisposable {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  public dispose(): void {
    this.clearHighlights()
    this.listeners.clear()
    this.host = null
    this.editHost = null
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
    const host = this.host
    if (!this.state.revealed || !host) return false

    this.state = { ...this.state, revealed: false, inSelection: false }
    this.scopes = null
    this.currentIndex = -1
    this.clearHighlights()
    this.emit({ type: 'hide' })
    host.focusEditor()
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
    if (!this.editHost) return false

    const match = this.currentOrSelectionMatch(true)
    if (!match) return this.findNext()

    const replaceText = this.replacePattern().buildReplaceString(
      match.matches,
      this.state.preserveCase,
    )
    this.editHost.applyEdits(
      [{ from: match.start, to: match.end, text: replaceText }],
      'input.findReplaceOne',
      { anchor: match.start + replaceText.length, head: match.start + replaceText.length },
    )
    this.research(true)
    return true
  }

  public replaceAll(): boolean {
    if (!this.ensureFindReady('replace')) return false
    if (!this.editHost) return false

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
    this.editHost.applyEdits(edits, 'input.findReplaceAll')
    this.research(false)
    return true
  }

  public selectAllMatches(): boolean {
    const host = this.host
    if (!host) return false
    if (!this.ensureFindReady('none')) return false
    if (this.matches.length === 0) return false

    const selections = orderedMatchSelections(this.matches, this.currentIndex)
    host.setSelections(selections, 'input.findSelectAll', selections[0]?.head)
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

    const scopes = nonEmptySelectionRanges(this.host?.getSelections() ?? [])
    if (scopes.length === 0) return false

    this.state = { ...this.state, inSelection: true }
    this.scopes = scopes
    this.research(this.options.cursorMoveOnType)
    return true
  }

  public setSearchString(value: string): void {
    this.state = { ...this.state, searchString: value }
    if (this.options.findOnType) this.research(this.options.cursorMoveOnType)
  }

  public setReplaceString(value: string): void {
    this.state = { ...this.state, replaceString: value }
    this.updateWidget()
  }

  public handleViewUpdate(
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null,
  ): void {
    if (!this.state.revealed) return
    if (!isFindDocumentUpdate(kind)) return
    if (change?.kind === 'selection' || change?.kind === 'none') return

    if (kind === 'clear') {
      this.close()
      return
    }

    if (this.state.inSelection)
      this.scopes = nonEmptySelectionRanges(this.host?.getSelections() ?? [])
    this.research(false)
  }

  private detachHost(host: EditorFindHost): void {
    if (this.host !== host) return

    this.clearHighlights()
    this.host = null
    this.matchHighlightName = ''
    this.currentHighlightName = ''
    this.scopeHighlightName = ''
    this.state = { ...this.state, revealed: false, inSelection: false }
    this.matches = []
    this.scopes = null
    this.currentIndex = -1
  }

  private detachEditHost(host: EditorFindEditHost): void {
    if (this.editHost !== host) return

    this.editHost = null
  }

  private open(options: EditorFindStartOptions): boolean {
    const host = this.host
    if (!host || !host.hasDocument()) return false

    const searchString = this.seedSearchString(host)
    this.state = {
      ...this.state,
      searchString: searchString || this.state.searchString,
      revealed: true,
      replaceRevealed: options.replace || this.state.replaceRevealed,
    }
    this.applyAutoFindInSelection(host)
    this.emit({ type: 'show', replaceVisible: this.state.replaceRevealed })
    this.research(false)
    this.focusWidget(options.focus)
    return true
  }

  private ensureFindReady(focus: 'find' | 'replace' | 'none'): boolean {
    if (!this.state.revealed) return this.open({ replace: focus === 'replace', focus })
    if (this.matches.length === 0) this.research(false)
    return this.state.searchString.length > 0
  }

  private research(moveCursor: boolean): void {
    if (!this.host) return

    this.matches = this.findAll(false)
    this.currentIndex = currentMatchIndex(this.matches, this.primarySelection())
    this.updateHighlights()
    this.updateWidget()
    if (moveCursor) this.selectFirstMatchFromSelection()
  }

  private findAll(captureMatches: boolean): readonly FindMatch[] {
    const host = this.host
    if (!host) return []

    return findMatches(
      host.materializeFullText(),
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
    const host = this.host
    if (!match || !host) return false

    this.currentIndex = findMatchIndex(this.matches, match)
    host.setSelection(match.start, match.end, 'input.findNavigate', match.end)
    this.updateHighlights()
    this.updateWidget()
    return true
  }

  private updateHighlights(): void {
    const host = this.host
    if (!host) return

    host.setRangeHighlight(this.matchHighlightName, this.matches, FIND_MATCH_STYLE)
    host.setRangeHighlight(this.currentHighlightName, this.currentMatchRanges(), FIND_CURRENT_STYLE)
    if (this.scopes) {
      host.setRangeHighlight(this.scopeHighlightName, this.scopes, FIND_SCOPE_STYLE)
      return
    }

    host.clearRangeHighlight(this.scopeHighlightName)
  }

  private currentMatchRanges(): readonly FindRange[] {
    const current = this.matches[this.currentIndex]
    return current ? [current] : []
  }

  private clearHighlights(): void {
    const host = this.host
    if (!host || !this.matchHighlightName) return

    host.clearRangeHighlight(this.matchHighlightName)
    host.clearRangeHighlight(this.currentHighlightName)
    host.clearRangeHighlight(this.scopeHighlightName)
  }

  private updateWidget(): void {
    this.emit({ type: 'update', state: this.widgetState() })
  }

  private widgetState(): EditorFindWidgetState {
    return {
      ...this.state,
      matchesCount: this.matches.length,
      matchesPosition: this.currentIndex >= 0 ? this.currentIndex + 1 : 0,
    }
  }

  private focusWidget(focus: 'find' | 'replace' | 'none'): void {
    if (focus === 'find') this.emit({ type: 'focus', target: 'find' })
    if (focus === 'replace') this.emit({ type: 'focus', target: 'replace' })
  }

  private seedSearchString(host: EditorFindHost): string {
    if (this.options.seedSearchStringFromSelection === 'never') return ''

    const text = host.materializeFullText()
    const selection = this.primarySelection()
    if (!selection) return ''
    if (!selection.collapsed) return selectedSingleLineText(text, selection)
    if (this.options.seedSearchStringFromSelection === 'selection') return ''

    const range = wordRangeAtOffset(text, selection.headOffset)
    return text.slice(range.start, range.end)
  }

  private applyAutoFindInSelection(host: EditorFindHost): void {
    const scopes = nonEmptySelectionRanges(host.getSelections())
    if (scopes.length === 0) return
    if (this.options.autoFindInSelection === 'never') return
    if (this.options.autoFindInSelection === 'always') {
      this.state = { ...this.state, inSelection: true }
      this.scopes = scopes
      return
    }

    if (!hasMultilineScope(host.materializeFullText(), scopes)) return

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
    return this.host?.getSelections()[0] ?? null
  }

  private emit(event: EditorFindUiEvent): void {
    for (const listener of this.listeners) listener(event)
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

function isFindDocumentUpdate(kind: EditorViewContributionUpdateKind): boolean {
  return kind === 'document' || kind === 'content' || kind === 'clear'
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

function hasMultilineScope(text: string, scopes: readonly FindRange[]): boolean {
  return scopes.some((scope) => text.slice(scope.start, scope.end).includes('\n'))
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
