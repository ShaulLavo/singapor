import type { EditorDecorationRange, EditorDecorationStore } from './editor/decorationStore'
import type { DocumentSessionChange } from './documentSession'
import type { DocumentTextSnapshot, TextSnapshot } from './documentTextSnapshot'
import type { EditorCommandContext, EditorCommandId } from './editor/commands'
import { EditorDisposableStore, MutableEditorDisposable } from './editor/disposables'
import type { PieceTableSnapshot } from './pieceTable/pieceTableTypes'
import type { EditorTheme } from './theme'
import type { EditorToken, TextEdit } from './tokens'
import type { EditorBlockProvider } from './editorBlocks'
import type { DisplayTextRowSource, InjectedTextRow } from './displayTransforms'
import {
  type BracketInfo,
  type EditorSyntaxCapture,
  type EditorSyntaxLanguageId,
  type EditorSyntaxProvider,
  type EditorSyntaxSession,
  type EditorSyntaxSessionOptions,
  type FoldRange,
} from './syntax/session'
import type { InlineReplacementSpec } from './inlineMap'
import type { TextOffsetRange } from './textRanges'
import type { BrowserTextMetrics } from './virtualization/browserMetrics'
import type { FixedRowVisibleRange } from './virtualization/fixedRowVirtualizer'
import type {
  EditorCursorLineHighlightOptions,
  VirtualizedFoldMarker,
  VirtualizedTextHighlightStyle,
  VirtualizedTextRowDecoration,
} from './virtualization/virtualizedTextViewTypes'

export type EditorDisposable = {
  dispose(): void
}

export type EditorCapabilityToken<T> = {
  readonly id: string
  readonly __capability?: T
}

export function createEditorCapabilityToken<T>(id: string): EditorCapabilityToken<T> {
  const normalized = id.trim()
  if (!normalized) throw new Error('Editor capability token id cannot be empty')

  return Object.freeze({ id: normalized }) as EditorCapabilityToken<T>
}

/**
 * Names a language feature — completion, hover, definition — that as many sources may answer as a
 * document has for it: a language server, a grammar-backed word source and a snippet set all offer
 * completions at once. A capability is the opposite case, one owner for the whole editor, which is
 * why the two are separate token kinds rather than one channel that sometimes allows a second
 * registration.
 *
 * The id is the identity: two packages that cannot import each other's token still answer the same
 * feature by naming it the same.
 */
export type EditorLanguageFeatureToken<T> = {
  readonly id: string
  readonly __languageFeature?: T
}

export function createEditorLanguageFeatureToken<T>(id: string): EditorLanguageFeatureToken<T> {
  const normalized = id.trim()
  if (!normalized) throw new Error('Editor language feature token id cannot be empty')

  return Object.freeze({ id: normalized }) as EditorLanguageFeatureToken<T>
}

/** Which documents a provider answers for. */
export type EditorLanguageFeatureSelector = {
  /** `'*'` answers for every document, including one whose language is unknown. */
  readonly language: EditorSyntaxLanguageId | '*'
  /** Separates providers that fit the document equally well; higher is asked first, default 0. */
  readonly priority?: number
}

export type EditorLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type EditorLogError = {
  readonly message: string
  readonly name?: string
  readonly stack?: string
}

export type EditorLogEditorContext = {
  readonly documentId: string | null
  readonly documentMode?: string
  readonly documentVersion?: number
  readonly editability?: string
  readonly instanceId: string
  readonly languageId: EditorSyntaxLanguageId | null
  readonly textVersion?: number
}

export type EditorLogEvent = {
  readonly action: string
  readonly editor?: Partial<EditorLogEditorContext>
  readonly error?: EditorLogError
  readonly level: EditorLogLevel
  readonly message?: string
  readonly source: 'editor'
  readonly timestamp: string
  readonly [key: string]: unknown
}

export type EditorLogInput = {
  readonly action: string
  readonly editor?: Partial<EditorLogEditorContext>
  readonly error?: EditorLogError
  readonly level: EditorLogLevel
  readonly message?: string
  readonly source?: 'editor'
  readonly timestamp?: string
  readonly [key: string]: unknown
}

export type EditorLogger = (event: EditorLogEvent) => void

export const EDITOR_MINIMAP_FEATURE_ID = 'editor.minimap'

export type EditorMinimapDecorationPosition = 'inline' | 'gutter'
export type EditorMinimapSectionHeaderStyle = 'normal' | 'underlined'

export type EditorMinimapDecoration = {
  readonly startLineNumber: number
  readonly startColumn: number
  readonly endLineNumber: number
  readonly endColumn: number
  readonly color?: string
  readonly position: EditorMinimapDecorationPosition
  readonly sectionHeaderStyle?: EditorMinimapSectionHeaderStyle | null
  readonly sectionHeaderText?: string | null
  readonly zIndex?: number
}

export type EditorMinimapFeature = {
  setDecorations(sourceId: string, decorations: readonly EditorMinimapDecoration[]): void
  clearDecorations(sourceId: string): void
  getDecorations(): readonly EditorMinimapDecoration[]
  subscribe(listener: () => void): EditorDisposable
}

export const EDITOR_MINIMAP_FEATURE =
  createEditorCapabilityToken<EditorMinimapFeature>(EDITOR_MINIMAP_FEATURE_ID)

export type EditorHighlightResult = {
  readonly tokens: readonly EditorToken[]
  readonly theme?: EditorTheme | null
}

export type EditorHighlighterSessionOptions = {
  readonly documentId: string
  readonly languageId: EditorSyntaxLanguageId | null
  readonly fullText: string
  readonly textSnapshot?: DocumentTextSnapshot
  readonly snapshot: PieceTableSnapshot
}

export type EditorHighlighterSession = EditorDisposable & {
  refresh(snapshot: PieceTableSnapshot, fullText?: string): Promise<EditorHighlightResult>
  applyChange(change: DocumentSessionChange): Promise<EditorHighlightResult>
}

export type EditorHighlighterProvider = {
  loadTheme?(): Promise<EditorTheme | null | undefined>
  createSession(options: EditorHighlighterSessionOptions): EditorHighlighterSession | null
}

export type EditorResolvedSelection = {
  readonly anchorOffset: number
  readonly headOffset: number
  readonly startOffset: number
  readonly endOffset: number
}

export type EditorViewportSnapshot = {
  readonly scrollTop: number
  readonly scrollLeft: number
  readonly scrollHeight: number
  readonly scrollWidth: number
  readonly clientHeight: number
  readonly clientWidth: number
  readonly borderBoxHeight?: number
  readonly borderBoxWidth?: number
  readonly visibleRange: FixedRowVisibleRange
}

export type EditorVisibleRowSnapshot = {
  readonly index: number
  readonly bufferRow: number
  readonly source: DisplayTextRowSource | 'block'
  readonly injectedTextRowId?: string
  readonly metadata?: unknown
  readonly startOffset: number
  readonly endOffset: number
  readonly text: string
  readonly kind: 'text' | 'block'
  readonly primaryText: boolean
  readonly top: number
  readonly height: number
}

// Read-only line-start access without materializing the full array; see
// LineStartsView in virtualization/lineStartIndex.ts.
export type EditorLineStartsView = {
  readonly length: number
  at(index: number): number | undefined
  indexForOffset(offset: number): number
  firstIndexAtOrAfter(offset: number): number
  toArray(): readonly number[]
}

export type EditorViewSnapshot = {
  readonly documentId: string | null
  readonly languageId: EditorSyntaxLanguageId | null
  readonly theme?: EditorTheme | null
  readonly textSnapshot?: TextSnapshot
  readonly fullText: string
  readonly textVersion: number
  // Composed edits transforming the given older text version into this
  // snapshot, or null when unknown; lets deferred consumers sync
  // incrementally instead of re-shipping the document. See DocumentEditChain.
  readonly editsSinceTextVersion?: (textVersion: number) => readonly TextEdit[] | null
  // Materializes the full array on first read; prefer lineStartsView on
  // per-keystroke paths.
  readonly lineStarts: readonly number[]
  readonly lineStartsView?: EditorLineStartsView
  readonly tokens: readonly EditorToken[]
  /** Bracket positions from the last structural parse, sorted by offset; empty when unavailable. */
  readonly brackets: readonly BracketInfo[]
  readonly selections: readonly EditorResolvedSelection[]
  readonly metrics: BrowserTextMetrics
  readonly lineCount: number
  readonly contentWidth: number
  readonly totalHeight: number
  readonly tabSize: number
  readonly foldMarkers: readonly VirtualizedFoldMarker[]
  readonly visibleRows: readonly EditorVisibleRowSnapshot[]
  readonly viewport: EditorViewportSnapshot
}

export type EditorOverlaySide = 'left' | 'right'

/**
 * Ranges the document keeps in step with its own text.
 *
 * A contribution that holds a span across edits it does not control — the region a find is scoped
 * to, matches painted while a re-search is still outstanding — would otherwise be reading offsets
 * the text has already moved out from under.
 */
export type EditorTrackedRanges = {
  /** Where the tracked ranges now sit, without any whose text is gone. */
  resolve(): readonly TextOffsetRange[]
}

export type EditorViewContributionContext = {
  readonly container: HTMLElement
  readonly scrollElement: HTMLDivElement
  readonly highlightPrefix?: string
  hasDocument(): boolean
  getSnapshot(): EditorViewSnapshot
  getFeature?<T>(token: EditorCapabilityToken<T>): T | null
  /**
   * The sources registered for a language feature, best first. The language is the caller's to name
   * because the region being answered for is not always the whole document's — an embedded fence
   * asks on behalf of the language inside it.
   */
  getProviders?<T>(
    token: EditorLanguageFeatureToken<T>,
    languageId: EditorSyntaxLanguageId | null,
  ): readonly T[]
  /**
   * Registers a source from the contribution that owns whatever answers for it — a connection, a
   * worker, an index built from the view. Such a source has to stop being asked the moment that
   * thing goes away, and the contribution's own disposal is what knows when; a source that owns
   * nothing view-scoped registers from a capability contribution instead.
   */
  registerProvider?<T>(
    token: EditorLanguageFeatureToken<T>,
    selector: EditorLanguageFeatureSelector,
    provider: T,
  ): EditorDisposable
  log?(event: EditorLogInput): void
  revealLine(row: number): void
  focusEditor(): void
  setSelection(anchor: number, head: number, timingName: string, revealOffset?: number): void
  setSelections(
    selections: readonly EditorSelectionRange[],
    timingName: string,
    revealOffset?: number,
  ): void
  setScrollTop(scrollTop: number): void
  reserveOverlayWidth(side: EditorOverlaySide, width: number): void
  // Width already claimed on that edge by other contributions, so an overlay
  // that anchors itself to the edge can step clear of them instead of covering
  // them. Changes are announced as a 'layout' update.
  getReservedOverlayWidth?(side: EditorOverlaySide): number
  textOffsetFromPoint(clientX: number, clientY: number): number | null
  getRangeClientRect(start: number, end: number): DOMRect | null
  // Spans the document follows on the contribution's behalf; see EditorTrackedRanges. Whether an
  // edge absorbs text arriving against it is the contribution's call, in the bias terms
  // EditorDecorationRange states it in: a region selected to work within absorbs it, something
  // found in the text does not.
  trackRanges?(
    ranges: readonly TextOffsetRange[],
    bias?: Pick<EditorDecorationRange, 'startBias' | 'endBias'>,
  ): EditorTrackedRanges
  setRangeHighlight?(
    name: string,
    ranges: readonly { readonly start: number; readonly end: number }[],
    style: VirtualizedTextHighlightStyle,
  ): void
  clearRangeHighlight?(name: string): void
}

export type EditorViewContributionUpdateKind =
  | 'document'
  | 'content'
  | 'tokens'
  | 'selection'
  | 'viewport'
  | 'layout'
  | 'clear'

/**
 * Contributions update from one snapshot inside a single render pass, so their reads and writes
 * interleave with each other's. A measurement taken after anything in the pass has written to the
 * DOM forces the browser to settle the layout that write dirtied, and the bill lands on whoever
 * happens to measure next rather than on whoever wrote — so an update takes every measurement it
 * needs first, into plain data, and writes only once the last of them is in hand.
 */
export type EditorViewContribution = EditorDisposable & {
  update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void
}

export type EditorViewContributionProvider = {
  createContribution(context: EditorViewContributionContext): EditorViewContribution | null
}

export type EditorCommandHandler = (context: EditorCommandContext) => boolean

export type EditorSelectionRange = {
  readonly anchor: number
  readonly head: number
}

export type EditorFeatureDomContributionContext = {
  readonly container: HTMLElement
  readonly scrollElement: HTMLDivElement
  readonly highlightPrefix: string
}

export type EditorDocumentContributionContext = {
  hasDocument(): boolean
  log?(event: EditorLogInput): void
  materializeFullText(): string
  getTextSnapshot?(): TextSnapshot | null
}

export type EditorSelectionContributionContext = {
  getSelections(): readonly EditorResolvedSelection[]
  focusEditor(): void
  setSelection(anchor: number, head: number, timingName: string, revealOffset?: number): void
  setSelections(
    selections: readonly EditorSelectionRange[],
    timingName: string,
    revealOffset?: number,
  ): void
}

export type EditorRangeHighlightContributionContext = {
  setRangeHighlight(
    name: string,
    ranges: readonly { readonly start: number; readonly end: number }[],
    style: VirtualizedTextHighlightStyle,
  ): void
  clearRangeHighlight(name: string): void
}

export type EditorRowDecorationContributionContext = {
  setRowDecorations(
    sourceId: string,
    decorations: ReadonlyMap<number, VirtualizedTextRowDecoration>,
  ): void
  clearRowDecorations(sourceId: string): void
}

export type EditorCommandContributionContext = {
  registerCommand(command: EditorCommandId, handler: EditorCommandHandler): EditorDisposable
}

export type EditorCapabilityContributionContext = {
  registerFeature<T>(token: EditorCapabilityToken<T>, feature: T): EditorDisposable
  /**
   * Adds one more source for a language feature, next to whichever others already answer it. The
   * selector decides which documents it is asked about and where in the order it sits; see
   * EditorLanguageFeatureSelector.
   *
   * Optional on the same terms as the newer plugin-context registrations. A host without it hands
   * the source on to no one, so a caller that consumes the feature itself is left asking what it
   * registered and nothing else, and one that only registers has nothing to fall back to and should
   * say so rather than going quiet.
   */
  registerProvider?<T>(
    token: EditorLanguageFeatureToken<T>,
    selector: EditorLanguageFeatureSelector,
    provider: T,
  ): EditorDisposable
}

export type EditorEditContributionContext = EditorDocumentContributionContext &
  EditorCapabilityContributionContext & {
    focusEditor(): void
    applyEdits(
      edits: readonly TextEdit[],
      timingName: string,
      selection?: EditorSelectionRange,
    ): void
    /**
     * Starts tab-stop navigation over ranges of the text just inserted. Optional so existing
     * hand-written contexts (test doubles, mostly) keep compiling; a host without it simply leaves
     * the caret at the first stop.
     */
    startSnippetSession?(ranges: readonly { readonly start: number; readonly end: number }[]): void
  }

export type EditorFeatureContributionContext = EditorFeatureDomContributionContext &
  EditorDocumentContributionContext &
  EditorSelectionContributionContext &
  EditorEditContributionContext &
  EditorRangeHighlightContributionContext &
  EditorRowDecorationContributionContext &
  EditorCommandContributionContext &
  EditorCapabilityContributionContext

export type EditorCommandContribution = EditorDisposable

export type EditorCommandContributionProvider = {
  createContribution(context: EditorCommandContributionContext): EditorCommandContribution | null
}

export type EditorCapabilityContribution = EditorDisposable

export type EditorCapabilityContributionProvider = {
  createContribution(
    context: EditorCapabilityContributionContext,
  ): EditorCapabilityContribution | null
}

export type EditorEditContribution = EditorDisposable

export type EditorEditContributionProvider = {
  createContribution(context: EditorEditContributionContext): EditorEditContribution | null
}

export type EditorDecorationContributionContext = EditorDocumentContributionContext &
  EditorRangeHighlightContributionContext &
  EditorRowDecorationContributionContext & {
    /**
     * Decorations registered here follow the text through edits, so a
     * contribution states where a decoration is once instead of recomputing its
     * offsets after every keystroke. Shared with every other contribution, which
     * is why each one owns its entries.
     */
    readonly decorations: EditorDecorationStore
  }

export type EditorDecorationContribution = EditorDisposable & {
  handleEditorChange?(change: DocumentSessionChange | null): void
}

export type EditorDecorationContributionProvider = {
  createContribution(
    context: EditorDecorationContributionContext,
  ): EditorDecorationContribution | null
}

export type EditorFeatureContribution = EditorDisposable & {
  handleEditorChange?(change: DocumentSessionChange | null): void
}

export type EditorFeatureContributionProvider = {
  createContribution(context: EditorFeatureContributionContext): EditorFeatureContribution | null
}

export type EditorGutterWidthContext = {
  readonly lineCount: number
  readonly metrics: BrowserTextMetrics
}

export type EditorGutterRowContext = {
  readonly index: number
  readonly bufferRow: number
  readonly source: DisplayTextRowSource | 'block'
  readonly startOffset: number
  readonly endOffset: number
  readonly text: string
  readonly kind: 'text' | 'block'
  readonly injectedTextRowId?: string
  readonly metadata?: unknown
  readonly primaryText: boolean
  readonly cursorLine: boolean
  readonly cursorLineHighlight: Required<EditorCursorLineHighlightOptions>
  readonly foldMarker: VirtualizedFoldMarker | null
  readonly lineCount: number
  toggleFold(marker: VirtualizedFoldMarker): void
}

export type EditorInjectedTextRow = InjectedTextRow

export type EditorInjectedTextRowProviderContext = {
  readonly documentId: string | null
  readonly text: string
  readonly lineCount: number
}

export type EditorInjectedTextRowProvider = {
  getInjectedTextRows(
    context: EditorInjectedTextRowProviderContext,
  ): readonly EditorInjectedTextRow[]
  onDidChangeInjectedTextRows?(listener: () => void): EditorDisposable
}

export type EditorGutterContribution = {
  readonly id: string
  readonly className?: string
  createCell(document: Document): HTMLElement
  width(context: EditorGutterWidthContext): number
  updateCell(element: HTMLElement, row: EditorGutterRowContext): void
  disposeCell?(element: HTMLElement): void
}

export type EditorInlineReplacementContext = {
  readonly text: string
  readonly languageId: EditorSyntaxLanguageId | null
  readonly captures: readonly EditorSyntaxCapture[]
}

/**
 * Derives the spans a document renders something else in place of — hidden markdown fences, a bullet
 * standing in for `-`, and so on. Called with fresh syntax captures whenever the parse settles.
 * Providers compose: every registered provider contributes, and overlapping spans are resolved by
 * the inline map, outermost first.
 */
export type EditorInlineReplacementProvider = (
  context: EditorInlineReplacementContext,
) => readonly InlineReplacementSpec[]

export type EditorSelectionRangeContext = {
  readonly text: string
  readonly languageId: EditorSyntaxLanguageId | null
  /** The caret the ladder is being built around; a provider that knows only a point uses this. */
  readonly offset: number
  readonly selection: TextOffsetRange
  /**
   * Enclosing constructs the last structural parse reported, so a grammar-backed provider answers
   * from the parse the document already paid for instead of asking for one of its own.
   */
  readonly folds: readonly FoldRange[]
}

/**
 * One source of candidate ranges around a caret, in no particular order.
 *
 * Ranking is deliberately not a provider's job: a source that knows about brackets cannot compare
 * its ranges against one that knows about words, so each hands back a bucket and the expand/shrink
 * ladder is the single place that turns the union into the sequence a reader walks up.
 */
export type EditorSelectionRangeProvider = (
  context: EditorSelectionRangeContext,
) => readonly TextOffsetRange[]

export type EditorPluginContext = {
  log?(event: EditorLogInput): void
  registerLogger?(logger: EditorLogger): EditorDisposable
  registerHighlighter(provider: EditorHighlighterProvider): EditorDisposable
  registerSyntaxProvider(provider: EditorSyntaxProvider): EditorDisposable
  registerViewContribution(provider: EditorViewContributionProvider): EditorDisposable
  registerCommandContribution(provider: EditorCommandContributionProvider): EditorDisposable
  registerCapabilityContribution(provider: EditorCapabilityContributionProvider): EditorDisposable
  registerEditContribution(provider: EditorEditContributionProvider): EditorDisposable
  registerDecorationContribution(provider: EditorDecorationContributionProvider): EditorDisposable
  registerGutterContribution(contribution: EditorGutterContribution): EditorDisposable
  registerBlockProvider(provider: EditorBlockProvider): EditorDisposable
  registerInjectedTextRowProvider(provider: EditorInjectedTextRowProvider): EditorDisposable
  /**
   * Optional so that adding these did not break every hand-written `EditorPluginContext` (test
   * mocks, mostly). The plugin host always provides them; callers should treat a missing one as a
   * host too old for the contribution and say so rather than silently skipping their own
   * registration.
   */
  registerInlineReplacementProvider?(provider: EditorInlineReplacementProvider): EditorDisposable
  registerSelectionRangeProvider?(provider: EditorSelectionRangeProvider): EditorDisposable
}

export type EditorInternalPluginContext = EditorPluginContext & {
  registerEditorFeatureContribution(provider: EditorFeatureContributionProvider): EditorDisposable
}

export type EditorPlugin = {
  readonly name?: string
  install?(context: EditorPluginContext): void | EditorDisposable | readonly EditorDisposable[]
  activate(context: EditorPluginContext): void | EditorDisposable | readonly EditorDisposable[]
  update?(context: EditorPluginContext, state: EditorPluginLifecycleState): void
  deactivate?(context: EditorPluginContext): void
  dispose?(context: EditorPluginContext): void
}

export type EditorPluginLifecycleState = {
  readonly active: boolean
  readonly managed: boolean
  readonly manual: boolean
}

export type EditorPluginHostEvents = {
  onPluginInstalled?(name: string, durationMs: number): void
  onPluginInstallFailed?(name: string, error: unknown, durationMs: number): void
  onHighlighterProvidersChanged?(): void
  onSyntaxProvidersChanged?(): void
  onInlineReplacementProvidersChanged?(): void
  onPluginActivated?(name: string, durationMs: number): void
  onPluginActivationFailed?(name: string, error: unknown, durationMs: number): void
  onPluginUpdated?(name: string, durationMs: number): void
  onPluginUpdateFailed?(name: string, error: unknown, durationMs: number): void
  onPluginDeactivated?(name: string, durationMs: number): void
  onPluginDeactivateFailed?(name: string, error: unknown, durationMs: number): void
  onPluginDisposed?(name: string): void
  onViewContributionProviderAdded?(provider: EditorViewContributionProvider): void
  onViewContributionProviderRemoved?(provider: EditorViewContributionProvider): void
  onDecorationContributionProviderAdded?(provider: EditorDecorationContributionProvider): void
  onDecorationContributionProviderRemoved?(provider: EditorDecorationContributionProvider): void
  onCommandContributionProviderAdded?(provider: EditorCommandContributionProvider): void
  onCommandContributionProviderRemoved?(provider: EditorCommandContributionProvider): void
  onCapabilityContributionProviderAdded?(provider: EditorCapabilityContributionProvider): void
  onCapabilityContributionProviderRemoved?(provider: EditorCapabilityContributionProvider): void
  onEditContributionProviderAdded?(provider: EditorEditContributionProvider): void
  onEditContributionProviderRemoved?(provider: EditorEditContributionProvider): void
  onEditorFeatureContributionProviderAdded?(provider: EditorFeatureContributionProvider): void
  onEditorFeatureContributionProviderRemoved?(provider: EditorFeatureContributionProvider): void
  onGutterContributionsChanged?(): void
  onBlockProvidersChanged?(): void
  onInjectedTextRowProvidersChanged?(): void
}

const LANGUAGE_SELECTOR_SCORE = 10
const WILDCARD_SELECTOR_SCORE = 5

type LanguageFeatureEntry = {
  readonly provider: unknown
  readonly selector: EditorLanguageFeatureSelector
  readonly sequence: number
}

type LanguageFeatureChannel = {
  readonly entries: LanguageFeatureEntry[]
  readonly ordered: Map<EditorSyntaxLanguageId | null, readonly unknown[]>
}

/**
 * The sources answering each language feature, and the order a consumer asks them in.
 *
 * How closely a provider's selector fits the document decides the order before anything the
 * provider asked for itself does: one that named this language outranks one that took every
 * document, so a general source cannot push a language's own source aside by claiming a priority.
 * Priority separates only providers that fit equally well, and registration order separates the
 * rest — leaving the sequence a consumer walks the same on every query.
 */
export class EditorLanguageFeatureRegistry {
  private readonly channels = new Map<string, LanguageFeatureChannel>()
  private sequence = 0

  public register<T>(
    token: EditorLanguageFeatureToken<T>,
    selector: EditorLanguageFeatureSelector,
    provider: T,
  ): EditorDisposable {
    const channel = this.channelFor(token.id)
    const entry: LanguageFeatureEntry = { provider, selector, sequence: this.sequence++ }
    channel.entries.push(entry)
    channel.ordered.clear()

    return disposableOnce(() => this.unregister(token.id, entry))
  }

  public ordered<T>(
    token: EditorLanguageFeatureToken<T>,
    languageId: EditorSyntaxLanguageId | null,
  ): readonly T[] {
    const channel = this.channels.get(token.id)
    if (!channel) return []

    // Language features are queried per keystroke, so the answer for a language is held until a
    // registration moves and consumers can skip work on the array they already have.
    const cached = channel.ordered.get(languageId)
    if (cached) return cached as readonly T[]

    const providers = orderedLanguageFeatureProviders(channel.entries, languageId)
    channel.ordered.set(languageId, providers)

    return providers as readonly T[]
  }

  private channelFor(id: string): LanguageFeatureChannel {
    const existing = this.channels.get(id)
    if (existing) return existing

    const channel: LanguageFeatureChannel = { entries: [], ordered: new Map() }
    this.channels.set(id, channel)

    return channel
  }

  private unregister(id: string, entry: LanguageFeatureEntry): void {
    const channel = this.channels.get(id)
    if (!channel) return

    const index = channel.entries.indexOf(entry)
    if (index === -1) return

    channel.entries.splice(index, 1)
    channel.ordered.clear()
  }
}

function orderedLanguageFeatureProviders(
  entries: readonly LanguageFeatureEntry[],
  languageId: EditorSyntaxLanguageId | null,
): readonly unknown[] {
  const matched: { readonly entry: LanguageFeatureEntry; readonly score: number }[] = []
  for (const entry of entries) {
    const score = languageFeatureSelectorScore(entry.selector, languageId)
    if (score > 0) matched.push({ entry, score })
  }

  matched.sort(
    (a, b) =>
      b.score - a.score ||
      (b.entry.selector.priority ?? 0) - (a.entry.selector.priority ?? 0) ||
      a.entry.sequence - b.entry.sequence,
  )

  return matched.map((match) => match.entry.provider)
}

function languageFeatureSelectorScore(
  selector: EditorLanguageFeatureSelector,
  languageId: EditorSyntaxLanguageId | null,
): number {
  if (selector.language === '*') return WILDCARD_SELECTOR_SCORE

  return selector.language === languageId ? LANGUAGE_SELECTOR_SCORE : 0
}

type InstalledEditorPlugin = {
  activationDisposable: EditorDisposable | null
  active: boolean
  installationDisposable: EditorDisposable | null
}

type EditorPluginActivation = {
  readonly activated: boolean
  readonly disposable: EditorDisposable | null
}

type EditorPluginInstallation = {
  readonly installed: boolean
  readonly disposable: EditorDisposable | null
}

export class EditorPluginHost implements EditorDisposable {
  private readonly loggers: EditorLogger[] = []
  private readonly highlighters: EditorHighlighterProvider[] = []
  private readonly syntaxProviders: EditorSyntaxProvider[] = []
  private readonly viewContributions: EditorViewContributionProvider[] = []
  private readonly commandContributions: EditorCommandContributionProvider[] = []
  private readonly capabilityContributions: EditorCapabilityContributionProvider[] = []
  private readonly editContributions: EditorEditContributionProvider[] = []
  private readonly decorationContributions: EditorDecorationContributionProvider[] = []
  private readonly editorFeatureContributions: EditorFeatureContributionProvider[] = []
  private readonly gutterContributions: EditorGutterContribution[] = []
  private readonly blockProviders: EditorBlockProvider[] = []
  private readonly injectedTextRowProviders: EditorInjectedTextRowProvider[] = []
  private readonly inlineReplacementProviders: EditorInlineReplacementProvider[] = []
  private readonly selectionRangeProviders: EditorSelectionRangeProvider[] = []
  private readonly blockProviderInvalidationDisposables = new Map<
    EditorBlockProvider,
    MutableEditorDisposable
  >()
  private readonly injectedTextRowProviderInvalidationDisposables = new Map<
    EditorInjectedTextRowProvider,
    MutableEditorDisposable
  >()
  private readonly installedPlugins = new Map<EditorPlugin, InstalledEditorPlugin>()
  private readonly managedPlugins = new Set<EditorPlugin>()
  private readonly manualPlugins = new Set<EditorPlugin>()
  private readonly lifecycleRegistrationStack: EditorDisposableStore[] = []
  private readonly hostRegistrations = new EditorDisposableStore()
  private readonly context = this.createContext()
  private events: EditorPluginHostEvents = {}
  private disposed = false

  public constructor(plugins: readonly EditorPlugin[] = []) {
    this.setPlugins(plugins)
  }

  public setEvents(events: EditorPluginHostEvents): void {
    this.events = events
  }

  public addPlugin(plugin: EditorPlugin): EditorDisposable {
    if (this.manualPlugins.has(plugin)) return disposableOnce(() => undefined)
    if (!this.ensurePluginActive(plugin)) return disposableOnce(() => undefined)

    this.manualPlugins.add(plugin)
    this.updatePlugin(plugin)

    return disposableOnce(() => this.removeManualPlugin(plugin))
  }

  public removePlugin(plugin: EditorPlugin): boolean {
    const removedManaged = this.removeManagedPlugin(plugin)
    const removedManual = this.removeManualPlugin(plugin)
    return removedManaged || removedManual
  }

  public setPlugins(plugins: readonly EditorPlugin[]): void {
    const nextPlugins = new Set(plugins)

    for (const plugin of this.managedPlugins) {
      if (nextPlugins.has(plugin)) continue

      this.managedPlugins.delete(plugin)
      this.updatePlugin(plugin)
      this.disposePluginIfUnowned(plugin)
    }

    for (const plugin of nextPlugins) {
      if (this.managedPlugins.has(plugin)) continue

      if (!this.ensurePluginActive(plugin)) continue

      this.managedPlugins.add(plugin)
      this.updatePlugin(plugin)
    }
  }

  public createHighlighterSession(
    options: EditorHighlighterSessionOptions,
  ): EditorHighlighterSession | null {
    for (const provider of this.highlighters) {
      const session = provider.createSession(options)
      if (session) return session
    }

    return null
  }

  public hasHighlighterProviders(): boolean {
    return this.highlighters.length > 0
  }

  public async loadHighlighterTheme(): Promise<EditorTheme | null | undefined> {
    for (const provider of this.highlighters) {
      if (!provider.loadTheme) continue

      const theme = await provider.loadTheme()
      if (theme !== undefined) return theme
    }

    return undefined
  }

  public createSyntaxSession(options: EditorSyntaxSessionOptions): EditorSyntaxSession | null {
    for (const provider of this.syntaxProviders) {
      const session = provider.createSession(options)
      if (session) return session
    }

    return null
  }

  public hasSyntaxProviders(): boolean {
    return this.syntaxProviders.length > 0
  }

  public createViewContributions(context: EditorViewContributionContext): EditorViewContribution[] {
    const contributions: EditorViewContribution[] = []
    for (const provider of this.viewContributions) {
      const contribution = provider.createContribution(context)
      if (contribution) contributions.push(contribution)
    }

    return contributions
  }

  public createCommandContributions(
    context: EditorCommandContributionContext,
  ): EditorCommandContribution[] {
    const contributions: EditorCommandContribution[] = []
    for (const provider of this.commandContributions) {
      const contribution = provider.createContribution(context)
      if (contribution) contributions.push(contribution)
    }

    return contributions
  }

  public createCapabilityContributions(
    context: EditorCapabilityContributionContext,
  ): EditorCapabilityContribution[] {
    const contributions: EditorCapabilityContribution[] = []
    for (const provider of this.capabilityContributions) {
      const contribution = provider.createContribution(context)
      if (contribution) contributions.push(contribution)
    }

    return contributions
  }

  public createEditContributions(context: EditorEditContributionContext): EditorEditContribution[] {
    const contributions: EditorEditContribution[] = []
    for (const provider of this.editContributions) {
      const contribution = provider.createContribution(context)
      if (contribution) contributions.push(contribution)
    }

    return contributions
  }

  public createDecorationContributions(
    context: EditorDecorationContributionContext,
  ): EditorDecorationContribution[] {
    const contributions: EditorDecorationContribution[] = []
    for (const provider of this.decorationContributions) {
      const contribution = provider.createContribution(context)
      if (contribution) contributions.push(contribution)
    }

    return contributions
  }

  public createEditorFeatureContributions(
    context: EditorFeatureContributionContext,
  ): EditorFeatureContribution[] {
    const contributions: EditorFeatureContribution[] = []
    for (const provider of this.editorFeatureContributions) {
      const contribution = provider.createContribution(context)
      if (contribution) contributions.push(contribution)
    }

    return contributions
  }

  public getGutterContributions(): readonly EditorGutterContribution[] {
    return [...this.gutterContributions]
  }

  public getBlockProviders(): readonly EditorBlockProvider[] {
    return this.blockProviders
  }

  public getInlineReplacementProviders(): readonly EditorInlineReplacementProvider[] {
    return this.inlineReplacementProviders
  }

  public getSelectionRangeProviders(): readonly EditorSelectionRangeProvider[] {
    return this.selectionRangeProviders
  }

  public getInjectedTextRowProviders(): readonly EditorInjectedTextRowProvider[] {
    return this.injectedTextRowProviders
  }

  public getViewContributionProviders(): readonly EditorViewContributionProvider[] {
    return this.viewContributions
  }

  public getCommandContributionProviders(): readonly EditorCommandContributionProvider[] {
    return this.commandContributions
  }

  public getCapabilityContributionProviders(): readonly EditorCapabilityContributionProvider[] {
    return this.capabilityContributions
  }

  public getEditContributionProviders(): readonly EditorEditContributionProvider[] {
    return this.editContributions
  }

  public getDecorationContributionProviders(): readonly EditorDecorationContributionProvider[] {
    return this.decorationContributions
  }

  public getEditorFeatureContributionProviders(): readonly EditorFeatureContributionProvider[] {
    return this.editorFeatureContributions
  }

  public getActivePluginNames(): readonly string[] {
    const names: string[] = []
    for (const [plugin, state] of this.installedPlugins) {
      if (state.active) names.push(pluginName(plugin))
    }

    return names
  }

  public hasLoggers(): boolean {
    return this.loggers.length > 0
  }

  public log(event: EditorLogEvent): void {
    if (this.loggers.length === 0) return

    for (const logger of this.loggers) callEditorLogger(logger, event)
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    while (this.installedPlugins.size > 0) {
      const plugin = this.installedPlugins.keys().next().value
      if (!plugin) break

      this.disposeInstalledPlugin(plugin)
    }
    this.hostRegistrations.dispose()
    this.managedPlugins.clear()
    this.manualPlugins.clear()
    this.loggers.length = 0
    this.highlighters.length = 0
    this.syntaxProviders.length = 0
    this.viewContributions.length = 0
    this.commandContributions.length = 0
    this.capabilityContributions.length = 0
    this.editContributions.length = 0
    this.decorationContributions.length = 0
    this.editorFeatureContributions.length = 0
    this.gutterContributions.length = 0
    for (const disposable of this.blockProviderInvalidationDisposables.values()) {
      disposable.dispose()
    }
    this.blockProviderInvalidationDisposables.clear()
    this.blockProviders.length = 0
    for (const disposable of this.injectedTextRowProviderInvalidationDisposables.values()) {
      disposable.dispose()
    }
    this.injectedTextRowProviderInvalidationDisposables.clear()
    this.injectedTextRowProviders.length = 0
    this.inlineReplacementProviders.length = 0
    this.selectionRangeProviders.length = 0
  }

  private ensurePluginActive(plugin: EditorPlugin): boolean {
    const installedPlugin = this.ensurePluginInstalled(plugin)
    if (!installedPlugin) return false
    if (installedPlugin.active) return true

    const activation = this.activatePlugin(plugin)
    if (!activation.activated) {
      this.disposeInstalledPlugin(plugin)
      return false
    }

    installedPlugin.active = true
    installedPlugin.activationDisposable = activation.disposable
    return true
  }

  private ensurePluginInstalled(plugin: EditorPlugin): InstalledEditorPlugin | null {
    const installedPlugin = this.installedPlugins.get(plugin)
    if (installedPlugin) return installedPlugin

    const installation = this.installPlugin(plugin)
    if (!installation.installed) return null

    const nextInstalledPlugin: InstalledEditorPlugin = {
      active: false,
      activationDisposable: null,
      installationDisposable: installation.disposable,
    }
    this.installedPlugins.set(plugin, nextInstalledPlugin)
    return nextInstalledPlugin
  }

  private disposePluginIfUnowned(plugin: EditorPlugin): void {
    if (this.managedPlugins.has(plugin)) return
    if (this.manualPlugins.has(plugin)) return

    this.deactivatePlugin(plugin)
    this.disposeInstalledPlugin(plugin)
  }

  private installPlugin(plugin: EditorPlugin): EditorPluginInstallation {
    if (!plugin.install) return { installed: true, disposable: null }

    const start = nowMs()
    const registrations = new EditorDisposableStore()
    this.lifecycleRegistrationStack.push(registrations)

    try {
      const disposable = lifecycleDisposableFromResult(plugin.install(this.context), registrations)
      this.events.onPluginInstalled?.(pluginName(plugin), nowMs() - start)
      return { installed: true, disposable }
    } catch (error) {
      registrations.dispose()
      this.events.onPluginInstallFailed?.(pluginName(plugin), error, nowMs() - start)
      return { installed: false, disposable: null }
    } finally {
      this.lifecycleRegistrationStack.pop()
    }
  }

  private activatePlugin(plugin: EditorPlugin): EditorPluginActivation {
    const start = nowMs()
    const registrations = new EditorDisposableStore()
    this.lifecycleRegistrationStack.push(registrations)

    try {
      const disposable = lifecycleDisposableFromResult(plugin.activate(this.context), registrations)
      this.events.onPluginActivated?.(pluginName(plugin), nowMs() - start)
      return { activated: true, disposable }
    } catch (error) {
      registrations.dispose()
      this.events.onPluginActivationFailed?.(pluginName(plugin), error, nowMs() - start)
      return { activated: false, disposable: null }
    } finally {
      this.lifecycleRegistrationStack.pop()
    }
  }

  private updatePlugin(plugin: EditorPlugin): void {
    const installedPlugin = this.installedPlugins.get(plugin)
    if (!installedPlugin?.active) return
    if (!plugin.update) return

    const start = nowMs()
    try {
      plugin.update(this.context, this.lifecycleStateFor(plugin, installedPlugin))
      this.events.onPluginUpdated?.(pluginName(plugin), nowMs() - start)
    } catch (error) {
      this.events.onPluginUpdateFailed?.(pluginName(plugin), error, nowMs() - start)
    }
  }

  private deactivatePlugin(plugin: EditorPlugin): void {
    const installedPlugin = this.installedPlugins.get(plugin)
    if (!installedPlugin?.active) return

    const start = nowMs()
    try {
      plugin.deactivate?.(this.context)
      this.events.onPluginDeactivated?.(pluginName(plugin), nowMs() - start)
    } catch (error) {
      this.events.onPluginDeactivateFailed?.(pluginName(plugin), error, nowMs() - start)
    }

    installedPlugin.active = false
    installedPlugin.activationDisposable?.dispose()
    installedPlugin.activationDisposable = null
    this.events.onPluginDisposed?.(pluginName(plugin))
  }

  private disposeInstalledPlugin(plugin: EditorPlugin): void {
    const installedPlugin = this.installedPlugins.get(plugin)
    if (!installedPlugin) return

    this.deactivatePlugin(plugin)
    this.installedPlugins.delete(plugin)
    try {
      plugin.dispose?.(this.context)
    } finally {
      installedPlugin.installationDisposable?.dispose()
    }
  }

  private lifecycleStateFor(
    plugin: EditorPlugin,
    installedPlugin: InstalledEditorPlugin,
  ): EditorPluginLifecycleState {
    return {
      active: installedPlugin.active,
      managed: this.managedPlugins.has(plugin),
      manual: this.manualPlugins.has(plugin),
    }
  }

  private removeManagedPlugin(plugin: EditorPlugin): boolean {
    if (!this.managedPlugins.delete(plugin)) return false

    this.updatePlugin(plugin)
    this.disposePluginIfUnowned(plugin)
    return true
  }

  private removeManualPlugin(plugin: EditorPlugin): boolean {
    if (!this.manualPlugins.delete(plugin)) return false

    this.updatePlugin(plugin)
    this.disposePluginIfUnowned(plugin)
    return true
  }

  private createContext(): EditorInternalPluginContext {
    return {
      log: (event) => this.logInput(event),
      registerLogger: (logger) => this.ownRegistration(() => this.registerLogger(logger)),
      registerHighlighter: (provider) =>
        this.ownRegistration(() => this.registerHighlighter(provider)),
      registerSyntaxProvider: (provider) =>
        this.ownRegistration(() => this.registerSyntaxProvider(provider)),
      registerViewContribution: (provider) =>
        this.ownRegistration(() => this.registerViewContribution(provider)),
      registerCommandContribution: (provider) =>
        this.ownRegistration(() => this.registerCommandContribution(provider)),
      registerCapabilityContribution: (provider) =>
        this.ownRegistration(() => this.registerCapabilityContribution(provider)),
      registerEditContribution: (provider) =>
        this.ownRegistration(() => this.registerEditContribution(provider)),
      registerDecorationContribution: (provider) =>
        this.ownRegistration(() => this.registerDecorationContribution(provider)),
      registerEditorFeatureContribution: (provider) =>
        this.ownRegistration(() => this.registerEditorFeatureContribution(provider)),
      registerGutterContribution: (contribution) =>
        this.ownRegistration(() => this.registerGutterContribution(contribution)),
      registerBlockProvider: (provider) =>
        this.ownRegistration(() => this.registerBlockProvider(provider)),
      registerInjectedTextRowProvider: (provider) =>
        this.ownRegistration(() => this.registerInjectedTextRowProvider(provider)),
      registerInlineReplacementProvider: (provider) =>
        this.ownRegistration(() => this.registerInlineReplacementProvider(provider)),
      registerSelectionRangeProvider: (provider) =>
        this.ownRegistration(() => this.registerSelectionRangeProvider(provider)),
    }
  }

  private logInput(event: EditorLogInput): void {
    this.log(normalizeEditorLogInput(event))
  }

  private registerLogger(logger: EditorLogger): EditorDisposable {
    this.loggers.push(logger)

    return disposableOnce(() => this.unregisterLogger(logger))
  }

  private unregisterLogger(logger: EditorLogger): void {
    const index = this.loggers.indexOf(logger)
    if (index === -1) return

    this.loggers.splice(index, 1)
  }

  private registerHighlighter(provider: EditorHighlighterProvider): EditorDisposable {
    this.highlighters.push(provider)
    const disposable = disposableOnce(() => this.unregisterHighlighter(provider))
    notifyRegistrationAdded(disposable, () => this.events.onHighlighterProvidersChanged?.())

    return disposable
  }

  private unregisterHighlighter(provider: EditorHighlighterProvider): void {
    const index = this.highlighters.indexOf(provider)
    if (index === -1) return

    this.highlighters.splice(index, 1)
    this.events.onHighlighterProvidersChanged?.()
  }

  private registerSyntaxProvider(provider: EditorSyntaxProvider): EditorDisposable {
    this.syntaxProviders.push(provider)
    const disposable = disposableOnce(() => this.unregisterSyntaxProvider(provider))
    notifyRegistrationAdded(disposable, () => this.events.onSyntaxProvidersChanged?.())

    return disposable
  }

  private unregisterSyntaxProvider(provider: EditorSyntaxProvider): void {
    const index = this.syntaxProviders.indexOf(provider)
    if (index === -1) return

    this.syntaxProviders.splice(index, 1)
    this.events.onSyntaxProvidersChanged?.()
  }

  private registerViewContribution(provider: EditorViewContributionProvider): EditorDisposable {
    this.viewContributions.push(provider)
    const disposable = disposableOnce(() => this.unregisterViewContribution(provider))

    try {
      this.events.onViewContributionProviderAdded?.(provider)
    } catch (error) {
      disposable.dispose()
      throw error
    }

    return disposable
  }

  private unregisterViewContribution(provider: EditorViewContributionProvider): void {
    const index = this.viewContributions.indexOf(provider)
    if (index === -1) return

    this.viewContributions.splice(index, 1)
    this.events.onViewContributionProviderRemoved?.(provider)
  }

  private registerCommandContribution(
    provider: EditorCommandContributionProvider,
  ): EditorDisposable {
    this.commandContributions.push(provider)
    const disposable = disposableOnce(() => this.unregisterCommandContribution(provider))

    try {
      this.events.onCommandContributionProviderAdded?.(provider)
    } catch (error) {
      disposable.dispose()
      throw error
    }

    return disposable
  }

  private unregisterCommandContribution(provider: EditorCommandContributionProvider): void {
    const index = this.commandContributions.indexOf(provider)
    if (index === -1) return

    this.commandContributions.splice(index, 1)
    this.events.onCommandContributionProviderRemoved?.(provider)
  }

  private registerCapabilityContribution(
    provider: EditorCapabilityContributionProvider,
  ): EditorDisposable {
    this.capabilityContributions.push(provider)
    const disposable = disposableOnce(() => this.unregisterCapabilityContribution(provider))

    try {
      this.events.onCapabilityContributionProviderAdded?.(provider)
    } catch (error) {
      disposable.dispose()
      throw error
    }

    return disposable
  }

  private unregisterCapabilityContribution(provider: EditorCapabilityContributionProvider): void {
    const index = this.capabilityContributions.indexOf(provider)
    if (index === -1) return

    this.capabilityContributions.splice(index, 1)
    this.events.onCapabilityContributionProviderRemoved?.(provider)
  }

  private registerEditContribution(provider: EditorEditContributionProvider): EditorDisposable {
    this.editContributions.push(provider)
    const disposable = disposableOnce(() => this.unregisterEditContribution(provider))

    try {
      this.events.onEditContributionProviderAdded?.(provider)
    } catch (error) {
      disposable.dispose()
      throw error
    }

    return disposable
  }

  private unregisterEditContribution(provider: EditorEditContributionProvider): void {
    const index = this.editContributions.indexOf(provider)
    if (index === -1) return

    this.editContributions.splice(index, 1)
    this.events.onEditContributionProviderRemoved?.(provider)
  }

  private registerDecorationContribution(
    provider: EditorDecorationContributionProvider,
  ): EditorDisposable {
    this.decorationContributions.push(provider)
    const disposable = disposableOnce(() => this.unregisterDecorationContribution(provider))

    try {
      this.events.onDecorationContributionProviderAdded?.(provider)
    } catch (error) {
      disposable.dispose()
      throw error
    }

    return disposable
  }

  private unregisterDecorationContribution(provider: EditorDecorationContributionProvider): void {
    const index = this.decorationContributions.indexOf(provider)
    if (index === -1) return

    this.decorationContributions.splice(index, 1)
    this.events.onDecorationContributionProviderRemoved?.(provider)
  }

  private registerEditorFeatureContribution(
    provider: EditorFeatureContributionProvider,
  ): EditorDisposable {
    this.editorFeatureContributions.push(provider)
    const disposable = disposableOnce(() => this.unregisterEditorFeatureContribution(provider))

    try {
      this.events.onEditorFeatureContributionProviderAdded?.(provider)
    } catch (error) {
      disposable.dispose()
      throw error
    }

    return disposable
  }

  private unregisterEditorFeatureContribution(provider: EditorFeatureContributionProvider): void {
    const index = this.editorFeatureContributions.indexOf(provider)
    if (index === -1) return

    this.editorFeatureContributions.splice(index, 1)
    this.events.onEditorFeatureContributionProviderRemoved?.(provider)
  }

  private registerGutterContribution(contribution: EditorGutterContribution): EditorDisposable {
    if (this.gutterContributions.some((registered) => registered.id === contribution.id)) {
      throw new Error(`Editor gutter contribution already registered: ${contribution.id}`)
    }

    this.gutterContributions.push(contribution)
    const disposable = disposableOnce(() => this.unregisterGutterContribution(contribution))
    notifyRegistrationAdded(disposable, () => this.events.onGutterContributionsChanged?.())

    return disposable
  }

  private unregisterGutterContribution(contribution: EditorGutterContribution): void {
    const index = this.gutterContributions.indexOf(contribution)
    if (index === -1) return

    this.gutterContributions.splice(index, 1)
    this.events.onGutterContributionsChanged?.()
  }

  private registerBlockProvider(provider: EditorBlockProvider): EditorDisposable {
    if (this.blockProviders.includes(provider)) {
      throw new Error('Editor block provider already registered')
    }

    this.blockProviders.push(provider)
    const invalidation = new MutableEditorDisposable()
    this.blockProviderInvalidationDisposables.set(provider, invalidation)
    invalidation.value =
      provider.onDidChangeBlocks?.(() => {
        this.events.onBlockProvidersChanged?.()
      }) ?? null
    const disposable = disposableOnce(() => this.unregisterBlockProvider(provider))
    notifyRegistrationAdded(disposable, () => this.events.onBlockProvidersChanged?.())

    return disposable
  }

  private unregisterBlockProvider(provider: EditorBlockProvider): void {
    const index = this.blockProviders.indexOf(provider)
    if (index === -1) return

    this.blockProviders.splice(index, 1)
    this.blockProviderInvalidationDisposables.get(provider)?.dispose()
    this.blockProviderInvalidationDisposables.delete(provider)
    this.events.onBlockProvidersChanged?.()
  }

  private registerInlineReplacementProvider(
    provider: EditorInlineReplacementProvider,
  ): EditorDisposable {
    this.inlineReplacementProviders.push(provider)
    const disposable = disposableOnce(() => this.unregisterInlineReplacementProvider(provider))
    notifyRegistrationAdded(disposable, () => this.events.onInlineReplacementProvidersChanged?.())

    return disposable
  }

  private unregisterInlineReplacementProvider(provider: EditorInlineReplacementProvider): void {
    const index = this.inlineReplacementProviders.indexOf(provider)
    if (index === -1) return

    this.inlineReplacementProviders.splice(index, 1)
    this.events.onInlineReplacementProvidersChanged?.()
  }

  // Read fresh on every expand, so a registration needs no invalidation event to take effect.
  private registerSelectionRangeProvider(provider: EditorSelectionRangeProvider): EditorDisposable {
    this.selectionRangeProviders.push(provider)

    return disposableOnce(() => this.unregisterSelectionRangeProvider(provider))
  }

  private unregisterSelectionRangeProvider(provider: EditorSelectionRangeProvider): void {
    const index = this.selectionRangeProviders.indexOf(provider)
    if (index === -1) return

    this.selectionRangeProviders.splice(index, 1)
  }

  private registerInjectedTextRowProvider(
    provider: EditorInjectedTextRowProvider,
  ): EditorDisposable {
    this.injectedTextRowProviders.push(provider)
    const invalidation =
      this.injectedTextRowProviderInvalidationDisposables.get(provider) ??
      new MutableEditorDisposable()
    this.injectedTextRowProviderInvalidationDisposables.set(provider, invalidation)
    invalidation.value =
      provider.onDidChangeInjectedTextRows?.(() => {
        this.events.onInjectedTextRowProvidersChanged?.()
      }) ?? null
    const disposable = disposableOnce(() => this.unregisterInjectedTextRowProvider(provider))
    notifyRegistrationAdded(disposable, () => this.events.onInjectedTextRowProvidersChanged?.())

    return disposable
  }

  private unregisterInjectedTextRowProvider(provider: EditorInjectedTextRowProvider): void {
    const index = this.injectedTextRowProviders.indexOf(provider)
    if (index === -1) return

    this.injectedTextRowProviders.splice(index, 1)
    this.injectedTextRowProviderInvalidationDisposables.get(provider)?.dispose()
    this.injectedTextRowProviderInvalidationDisposables.delete(provider)
    this.events.onInjectedTextRowProvidersChanged?.()
  }

  /**
   * Registrations reach the host only through the context, so this is the one place that can name an
   * owner for them. A plugin registering from a timer, a resolved promise or an event handler is
   * past its install/activate body and has no scope left to unwind with, so the host owns those
   * until teardown.
   */
  private ownRegistration(register: () => EditorDisposable): EditorDisposable {
    if (this.disposed) return disposableOnce(() => undefined)

    const owner = this.lifecycleRegistrationStack.at(-1) ?? this.hostRegistrations
    const registration = register()
    const owned: EditorDisposable = disposableOnce(() => {
      owner.delete(owned)
      registration.dispose()
    })

    return owner.add(owned)
  }
}

function lifecycleDisposableFromResult(
  result: void | EditorDisposable | readonly EditorDisposable[],
  registrations: EditorDisposableStore,
): EditorDisposable | null {
  const disposable = disposableFromActivationResult(result)
  if (!disposable && registrations.size === 0) return null

  return disposableOnce(() => {
    disposable?.dispose()
    registrations.dispose()
  })
}

function disposableFromActivationResult(
  result: void | EditorDisposable | readonly EditorDisposable[],
): EditorDisposable | null {
  if (!result) return null
  if (!isDisposableList(result)) return result

  return {
    dispose: () => disposeAll(result),
  }
}

function disposeAll(disposables: readonly EditorDisposable[]): void {
  for (const disposable of disposables.toReversed()) disposable.dispose()
}

function disposableOnce(dispose: () => void): EditorDisposable {
  let disposed = false

  return {
    dispose() {
      if (disposed) return

      disposed = true
      dispose()
    },
  }
}

function notifyRegistrationAdded(disposable: EditorDisposable, notify: () => void): void {
  try {
    notify()
  } catch (error) {
    disposable.dispose()
    throw error
  }
}

const isDisposableList = (
  value: EditorDisposable | readonly EditorDisposable[],
): value is readonly EditorDisposable[] => Array.isArray(value)

function normalizeEditorLogInput(event: EditorLogInput): EditorLogEvent {
  return {
    ...event,
    source: 'editor',
    timestamp: event.timestamp ?? new Date().toISOString(),
  }
}

function callEditorLogger(logger: EditorLogger, event: EditorLogEvent): void {
  try {
    logger(event)
  } catch {
    // Logging must never affect editor behavior.
  }
}

function pluginName(plugin: EditorPlugin): string {
  return plugin.name ?? 'anonymous'
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now()
}
