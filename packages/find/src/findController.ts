import {
  wordRangeAtOffset,
  type DocumentSessionChange,
  type TextEdit,
} from '@singapor/core/document'
import type { EditorDisposable, EditorViewContributionUpdateKind } from '@singapor/core/extensions'
import type { VirtualizedTextHighlightStyle } from '@singapor/core/rendering'
import { EditorSecondaryViewScheduler } from '@singapor/core/secondary-views'
import {
  escapeRegExpCharacters,
  FIND_MATCHES_LIMIT,
  FIND_REPLACE_ALL_LIMIT,
  findLineRange,
  findMatchIndex,
  findMatches,
  findNextMatchFrom,
  findPreviousMatchFrom,
  nextMatchAfter,
  previousMatchBefore,
  type FindMatch,
  type FindMatchFromOptions,
  type FindMatchFromSearcher,
  type FindQuery,
  type FindRange,
  type FindTextSource,
} from './search'
import { parseReplaceString, ReplacePattern } from './replacePattern'
import type { EditorFindOptions } from './types'

// These three overlap by construction — the current match is always also a
// match, and both sit inside the scope — so their stacking is declared rather
// than left to the order the groups happen to reach the highlight registry in.
const FIND_MATCH_STYLE = { backgroundColor: 'rgba(234, 179, 8, 0.34)', zIndex: 2 }
const FIND_CURRENT_STYLE = {
  backgroundColor: 'rgba(245, 158, 11, 0.72)',
  color: '#111827',
  zIndex: 3,
}
const FIND_SCOPE_STYLE = { backgroundColor: 'rgba(59, 130, 246, 0.22)', zIndex: 1 }

// Seeding stops here rather than pushing a multi-megabyte selection through the
// find input and searching for it.
const SEARCH_STRING_MAX_LENGTH = 524_288

// A re-search reads the whole document, which is not a bill a keystroke can be
// handed. The ceiling is the load-bearing half: a sustained typing run never
// leaves the quiet gap, so waiting only for quiet would mean never re-searching
// at all for as long as the user keeps going.
const FIND_RESEARCH_KEY = 'find.research'
const FIND_RESEARCH_DELAY_MS = 100
const FIND_RESEARCH_MAX_DELAY_MS = 400

type EditorFindSelectionRange = {
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

/**
 * Ranges the host follows through edits on find's behalf.
 *
 * A scope outlives the selection it was taken from: the first replace inside it moves the caret off
 * that selection, so a scope re-derived from what is selected now would be re-derived from
 * something else — or from nothing, and a scope of nothing is indistinguishable from no scope at
 * all. Handed over once, it answers from wherever its text went, however many edits later.
 */
export type FindTrackedRanges = {
  resolve(): readonly FindRange[]
}

export type EditorFindHost = {
  hasDocument(): boolean
  // Ranges rather than a string, so nothing find does can cost a copy of the
  // document — the reason there is no full-text accessor here to reach for.
  textSource(): FindTextSource
  // Followed wherever they end up, however far off screen: a scope decides where
  // Replace All rewrites, and one that stopped being followed would rewrite text
  // the user never marked.
  trackRanges(ranges: readonly FindRange[]): FindTrackedRanges
  // Followed only as far as the host paints them, the rest answered with the
  // offsets they were handed; see adoptMatches.
  trackPaintedRanges(ranges: readonly FindRange[]): FindTrackedRanges
  getSelections(): readonly EditorFindResolvedSelection[]
  focusEditor(): void
  announce?(message: string): void
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
  // The count stopped at FIND_MATCHES_LIMIT, so it is a floor and not a total.
  readonly matchesTruncated: boolean
}

export type EditorFindUiEvent =
  | { readonly type: 'show'; readonly replaceVisible: boolean }
  | { readonly type: 'hide' }
  | { readonly type: 'focus'; readonly target: 'find' | 'replace' }
  | { readonly type: 'update'; readonly state: EditorFindWidgetState }

type ResolvedFindOptions = Required<EditorFindOptions>
type EditorFindUiListener = (event: EditorFindUiEvent) => void

// What every search resolves to before it runs: the text, and the ranges of it
// the query is allowed to answer from. Null scopes are the whole document; an
// empty scope refuses the search outright, so it is never one of these.
type FindSearchTarget = {
  readonly source: FindTextSource
  readonly scopes: readonly FindRange[] | null
}

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
  private readonly scheduler = new EditorSecondaryViewScheduler()
  private matches: readonly FindMatch[] = []
  private matchesTruncated = false
  private scope: FindTrackedRanges | null = null
  // What the host follows the painted matches by, so a deferred re-search cannot
  // leave a highlight standing on text that moved out from under it.
  private trackedMatches: FindTrackedRanges | null = null
  private currentMatch: FindMatch | null = null
  private replacing = false

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
    this.scheduler.dispose()
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
    this.scope = null
    this.trackedMatches = null
    this.currentMatch = null
    this.scheduler.cancel(FIND_RESEARCH_KEY)
    this.clearHighlights()
    this.emit({ type: 'hide' })
    host.focusEditor()
    return true
  }

  public findNext(): boolean {
    if (!this.ensureFindReady('none')) return false

    const startOffset = this.primarySelection()?.endOffset ?? 0
    const match = this.nextMatchAt(startOffset, true)
    // Landing behind where the search started is the search having run out and begun again. Nothing
    // on screen says so to a reader who cannot see the caret jump back up the file.
    if (match && match.start < startOffset) this.host?.announce?.('Wrapped to the first match')

    return this.selectMatch(match)
  }

  public findPrevious(): boolean {
    if (!this.ensureFindReady('none')) return false

    const startOffset = this.primarySelection()?.startOffset ?? 0
    if (this.matchesTruncated)
      return this.selectMatch(
        this.searchFrom(findPreviousMatchFrom, startOffset, { escapeEmptyMatchAtOffset: true }),
      )

    const match = previousMatchBefore(this.matches, startOffset, this.options.loop, true)
    if (match && match.start > startOffset) this.host?.announce?.('Wrapped to the last match')

    return this.selectMatch(match)
  }

  public replaceOne(): boolean {
    if (!this.ensureFindReady('replace')) return false
    if (!this.editHost) return false

    const selection = this.primarySelection()
    if (!selection) return false

    // One scan, from the cursor, with the capture groups of the one match that
    // may be about to be rewritten: enumerating the document for them allocates
    // a capture array per match in it to use exactly one.
    const match = this.searchFrom(findNextMatchFrom, selection.startOffset, {
      captureMatches: true,
    })
    if (!match) return false
    // Not on it yet, so this press is the one that selects it and the next one
    // replaces it.
    if (match.start !== selection.startOffset || match.end !== selection.endOffset)
      return this.selectMatch(match)

    const replaceText = this.replacePattern().buildReplaceString(
      match.matches,
      this.state.preserveCase,
    )
    this.applyReplacement(
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
    // Deliberately not FIND_MATCHES_LIMIT: that cap exists to bound painting,
    // and applying it here would rewrite the first 19,999 matches and leave the
    // rest, silently.
    const matches = this.findAll(
      pattern.hasReplacementPatterns || this.state.preserveCase,
      FIND_REPLACE_ALL_LIMIT,
    )
    if (matches.length === 0) return false

    const edits = mergeAdjacentReplaceEdits(
      matches.map((match) => ({
        from: match.start,
        to: match.end,
        text: pattern.buildReplaceString(match.matches, this.state.preserveCase),
      })),
    )
    this.applyReplacement(edits, 'input.findReplaceAll')
    this.research(false)
    return true
  }

  public selectAllMatches(): boolean {
    const host = this.host
    if (!host) return false
    if (!this.ensureFindReady('none')) return false

    // Re-queried uncapped for the same reason Replace All is: FIND_MATCHES_LIMIT
    // bounds painting, and a cursor set that silently stopped at the paint cap
    // would let the next keystroke edit only part of what the user selected.
    const matches = this.findAll(false, FIND_REPLACE_ALL_LIMIT)
    if (matches.length === 0) return false

    const selections = orderedMatchSelections(
      matches,
      matchAtSelection(matches, this.primarySelection()),
    )
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
      this.scope = null
      this.research(this.options.cursorMoveOnType)
      return true
    }

    const host = this.host
    if (!host) return false

    const scopes = nonEmptySelectionRanges(host.getSelections())
    if (scopes.length === 0) return false

    this.state = { ...this.state, inSelection: true }
    this.scope = host.trackRanges(scopes)
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

    // Find's own replace re-searches once the edit it is applying has landed,
    // rather than from inside it, so the matches it is about to discard are not
    // followed through the edit first.
    if (this.replacing) return
    // Nothing to follow across a document swap: the ranges being tracked belong
    // to the buffer that was just replaced. A scope among them is the one that
    // cannot simply be dropped on the floor — resolved against the new buffer it
    // answers with offsets of text the user never marked, and a search confined
    // to those is a Replace All rewriting inside a region nobody drew.
    if (kind === 'document') {
      this.scope = null
      this.state = { ...this.state, inSelection: false }
      this.research(false)
      return
    }

    this.scheduleResearch()
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
    this.matchesTruncated = false
    this.scope = null
    this.trackedMatches = null
    this.currentMatch = null
    this.scheduler.cancel(FIND_RESEARCH_KEY)
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

    // Whatever a deferred run was going to answer, this run answers now.
    this.scheduler.cancel(FIND_RESEARCH_KEY)
    // One past the cap, so a document holding exactly FIND_MATCHES_LIMIT
    // matches is reported as a complete count rather than an overflow.
    const found = this.findAll(false, FIND_MATCHES_LIMIT + 1)
    this.matchesTruncated = found.length > FIND_MATCHES_LIMIT
    this.adoptMatches(this.matchesTruncated ? found.slice(0, FIND_MATCHES_LIMIT) : found)
    this.currentMatch = matchAtSelection(this.matches, this.primarySelection())
    this.updateHighlights()
    this.updateWidget()
    if (moveCursor) this.selectFirstMatchFromSelection()
  }

  private scheduleResearch(): void {
    this.followPendingMatches()
    this.scheduler.schedule({
      key: FIND_RESEARCH_KEY,
      taskClass: 'background-derived',
      delayMs: FIND_RESEARCH_DELAY_MS,
      maxDelayMs: FIND_RESEARCH_MAX_DELAY_MS,
      run: () => this.research(false),
    })
  }

  /**
   * Adopts a match set and hands it to the host to follow as far as it is painted.
   *
   * Handed over now rather than when an edit arrives: find is told about an edit
   * once the text has already moved, and a range recorded against the document
   * as it is by then is a range that will never shift.
   *
   * What the reader can see is the bound. A set stopping at the paint cap holds
   * twenty thousand matches, and asking the host to carry all of them costs more
   * per keystroke than the search this deferral exists to keep off it.
   */
  private adoptMatches(matches: readonly FindMatch[]): void {
    this.matches = matches
    this.trackedMatches = this.host?.trackPaintedRanges(matches) ?? null
  }

  /**
   * Carries the painted matches through the edit that deferred their re-search.
   *
   * Until it lands they are what the reader sees, and the offsets they were found
   * at address text that has since moved — so they are read back from where that
   * text went. A match whose text is gone resolves to nothing and stops being
   * painted.
   */
  /** Takes the offsets again from what the host is following, after the line it follows to moved. */
  public refreshTrackedMatches(): void {
    this.followPendingMatches()
  }

  private followPendingMatches(): void {
    const tracked = this.trackedMatches
    if (!tracked || this.matches.length === 0) return

    // The capture groups belonged to the text that was there; only the ranges
    // survive the edit, and the re-search is what recovers the rest.
    this.matches = tracked.resolve().map((range) => ({ ...range, matches: null }))
    this.currentMatch = matchAtSelection(this.matches, this.primarySelection())
    this.updateHighlights()
    this.updateWidget()
  }

  private applyReplacement(
    edits: readonly TextEdit[],
    timingName: string,
    selection?: EditorFindSelectionRange,
  ): void {
    const editHost = this.editHost
    if (!editHost) return

    this.replacing = true
    try {
      editHost.applyEdits(edits, timingName, selection)
    } finally {
      this.replacing = false
    }
  }

  private findAll(captureMatches: boolean, limit = FIND_MATCHES_LIMIT): readonly FindMatch[] {
    const search = this.searchTarget()
    if (!search) return []

    return findMatches(search.source, this.state, search.scopes, captureMatches, limit)
  }

  private searchFrom(
    find: FindMatchFromSearcher,
    offset: number,
    options: FindMatchFromOptions,
  ): FindMatch | null {
    const search = this.searchTarget()
    if (!search) return null

    return find(search.source, this.state, offset, search.scopes, {
      loop: this.options.loop,
      ...options,
    })
  }

  private searchTarget(): FindSearchTarget | null {
    const host = this.host
    if (!host) return null

    const scopes = this.scopeRanges()
    // A scope that has run out of ranges is not the absence of a scope: every
    // range the user marked was edited away, and widening the search to the
    // document would let the next Replace All rewrite text they never marked.
    if (scopes && scopes.length === 0) return null

    return { source: host.textSource(), scopes }
  }

  private scopeRanges(): readonly FindRange[] | null {
    return this.scope?.resolve() ?? null
  }

  private selectFirstMatchFromSelection(): void {
    const offset = this.primarySelection()?.endOffset ?? 0
    // Deliberately not escaping an empty match here: re-searching should land
    // on the match at the cursor, empty or not. Only an explicit Find
    // Next/Previous is asking to move off it.
    this.selectMatch(this.nextMatchAt(offset, false))
  }

  // Past the cap the painted list holds nothing at or after the cursor, so
  // consulting it answers every press with the first match in the document.
  private nextMatchAt(offset: number, escapeEmptyMatchAtOffset: boolean): FindMatch | null {
    if (this.matchesTruncated)
      return this.searchFrom(findNextMatchFrom, offset, { escapeEmptyMatchAtOffset })

    return nextMatchAfter(this.matches, offset, this.options.loop, escapeEmptyMatchAtOffset)
  }

  private selectMatch(match: FindMatch | null): boolean {
    const host = this.host
    if (!match || !host) return false

    this.currentMatch = match
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
    const scopes = this.scopeRanges()
    if (scopes) {
      host.setRangeHighlight(this.scopeHighlightName, scopes, FIND_SCOPE_STYLE)
      return
    }

    host.clearRangeHighlight(this.scopeHighlightName)
  }

  private currentMatchRanges(): readonly FindRange[] {
    return this.currentMatch ? [this.currentMatch] : []
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
      matchesPosition: this.currentMatchPosition(),
      matchesTruncated: this.matchesTruncated,
    }
  }

  // Unnumbered when the current match is not among the painted ones, which is
  // where navigation past the cap goes: the count is over what was painted, and
  // that set has no place to name for a match beyond it.
  private currentMatchPosition(): number {
    if (!this.currentMatch) return 0
    return findMatchIndex(this.matches, this.currentMatch) + 1
  }

  private focusWidget(focus: 'find' | 'replace' | 'none'): void {
    if (focus === 'find') this.emit({ type: 'focus', target: 'find' })
    if (focus === 'replace') this.emit({ type: 'focus', target: 'replace' })
  }

  private seedSearchString(host: EditorFindHost): string {
    if (this.options.seedSearchStringFromSelection === 'never') return ''

    const selection = this.primarySelection()
    if (!selection) return ''

    const source = host.textSource()
    if (!selection.collapsed)
      return this.seedFromLiteralText(selectedSingleLineText(source, selection))
    if (this.options.seedSearchStringFromSelection === 'selection') return ''

    return this.seedFromLiteralText(wordTextAtOffset(source, selection.headOffset))
  }

  // The seed is document text, never a pattern: unescaped, `foo(bar)` seeded
  // into a regex search becomes a capture group and finds nothing, with no hint
  // to the user why.
  private seedFromLiteralText(value: string): string {
    return this.state.isRegex ? escapeRegExpCharacters(value) : value
  }

  private applyAutoFindInSelection(host: EditorFindHost): void {
    const scopes = nonEmptySelectionRanges(host.getSelections())
    if (scopes.length === 0) return
    if (this.options.autoFindInSelection === 'never') return
    if (this.options.autoFindInSelection === 'always') {
      this.state = { ...this.state, inSelection: true }
      this.scope = host.trackRanges(scopes)
      return
    }

    if (!hasMultilineScope(host.textSource(), scopes)) return

    this.state = { ...this.state, inSelection: true }
    this.scope = host.trackRanges(scopes)
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

function selectedSingleLineText(
  source: FindTextSource,
  selection: EditorFindResolvedSelection,
): string {
  // Both bounds are checked before the read, so an oversized or multi-line
  // selection is never copied at all.
  if (selection.endOffset - selection.startOffset >= SEARCH_STRING_MAX_LENGTH) return ''
  if (spansLines(source, selection.startOffset, selection.endOffset)) return ''

  return source.readRange(selection.startOffset, selection.endOffset)
}

// A word ends at a line break, so the line holding the caret is the whole
// haystack the scan can need.
function wordTextAtOffset(source: FindTextSource, offset: number): string {
  const line = findLineRange(source, offset)
  const text = source.readRange(line.start, line.end)
  const word = wordRangeAtOffset(text, offset - line.start)
  return text.slice(word.start, word.end)
}

function nonEmptySelectionRanges(
  selections: readonly EditorFindResolvedSelection[],
): readonly FindRange[] {
  return selections
    .filter((selection) => !selection.collapsed)
    .map((selection) => ({ start: selection.startOffset, end: selection.endOffset }))
}

function hasMultilineScope(source: FindTextSource, scopes: readonly FindRange[]): boolean {
  return scopes.some((scope) => spansLines(source, scope.start, scope.end))
}

// Asked of the line index instead of the text: whether two offsets sit on one
// line is already known there, and reading the span out to look for a break
// would copy a selection that can be the whole document.
function spansLines(source: FindTextSource, start: number, end: number): boolean {
  const lineStartsView = source.lineStartsView
  return lineStartsView.indexForOffset(start) !== lineStartsView.indexForOffset(end)
}

function matchAtSelection(
  matches: readonly FindMatch[],
  selection: EditorFindResolvedSelection | null,
): FindMatch | null {
  if (!selection) return null
  return (
    matches.find(
      (match) => match.start === selection.startOffset && match.end === selection.endOffset,
    ) ?? null
  )
}

function orderedMatchSelections(
  matches: readonly FindMatch[],
  currentMatch: FindMatch | null,
): readonly EditorFindSelectionRange[] {
  const selections = matches.map((match) => ({ anchor: match.start, head: match.end }))
  const currentIndex = currentMatch ? findMatchIndex(matches, currentMatch) : -1
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
