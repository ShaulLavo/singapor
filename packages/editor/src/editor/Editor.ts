import {
  documentSessionChangeTextSnapshot,
  type DocumentSession,
  type DocumentSessionChange,
} from '../documentSession'
import {
  foldRangesEqual,
  projectSyntaxFoldsThroughLineEdit,
  rejectNestedOrOverlappingFoldRanges,
  type FoldRangeRejection,
  type SyntaxFoldProjection,
} from './folds'
import { EditorFoldState } from './foldState'
import { EditorKeymapController } from './keymap'
import { EditorBlockSurfaceController } from './blockSurfaceController'
import { InputSelectionController } from './inputSelectionController'
import { EditorSyntaxController } from './syntaxController'
import { DocumentEditChain } from './editChain'
import type { LineStartsView } from '../virtualization/lineStartIndex'
import { EditorSecondaryWorkScheduler } from './secondaryWorkScheduler'
import { appendTiming, nowMs } from './timing'
import { copyTokenProjectionMetadata, projectTokensThroughEdit } from './tokenProjection'
import { measureEditorPerformance } from './performanceDiagnostics'
import type { EditorCommandContext, EditorCommandId } from './commands'
import { normalizeEditorEditInput } from './editInput'
import { EditorCommandRouter } from './commandRouter'
import {
  EditorDisplayProjectionRegistry,
  FULL_DISPLAY_PROJECTION_INVALIDATION,
  NO_DISPLAY_PROJECTION_DISPOSAL,
  type EditorDisplayProjection,
  type EditorDisplayProjectionSource,
} from './displayProjectionRegistry'
import { getHighlightRegistry, nextEditorHighlightPrefix, recordEditorMountTiming } from './runtime'
import {
  DOCUMENT_START_SCROLL_POSITION,
  normalizeScrollOffset,
  preservedScrollPosition,
} from './scroll'
import {
  normalizeEditorDocumentMode,
  normalizeEditorSelectionSyncMode,
  type ResetOwnedDocumentOptions,
} from './editorDocument'
import { EditorDocumentController } from './documentController'
import {
  removeArrayItem,
  viewContributionKindForChange,
  type SessionChangeOptions,
} from './editorUtils'
import { EDITOR_FIND_FEATURE, type EditorFindFeature } from './findFeature'
import { foldCandidateAtLocation, type FoldOperation } from './foldOperations'
import { groupedRangeDecorations, sameEditorRangeDecorations } from './rangeDecorations'
import { selectionRevealOffset, type EditorSelectionRevealTarget } from './selectionReveal'
import { syncTextEdit } from './textEdits'
import type {
  EditorDocumentMode,
  EditorEditInput,
  EditorEditOptions,
  EditorEditability,
  EditorOptions,
  EditorOpenDocumentOptions,
  EditorRangeDecoration,
  EditorScrollPosition,
  EditorSetTextOptions,
  EditorSessionOptions,
  EditorState,
  EditorSyntaxStatus,
} from './types'
import { EditorViewContributionController } from './viewContributions'
import type { FoldMap } from '../foldMap'
import { createInlineMap, type InlineMap } from '../inlineMap'
import type { EditorSyntaxCapture } from '../syntax/session'
import type { EditorInlineReplacementProvider } from '../plugins'
import { normalizeTabSize } from '../displayTransforms'
import type { BlockLane, BlockRow, InjectedTextRow } from '../displayTransforms'
import { offsetToPoint } from '../pieceTable/positions'
import {
  EditorPluginHost,
  type EditorCapabilityContribution,
  type EditorCapabilityContributionContext,
  type EditorCapabilityContributionProvider,
  type EditorCapabilityToken,
  type EditorCommandContribution,
  type EditorCommandContributionContext,
  type EditorCommandContributionProvider,
  type EditorCommandHandler,
  type EditorDecorationContribution,
  type EditorDecorationContributionContext,
  type EditorDecorationContributionProvider,
  type EditorDisposable,
  type EditorEditContribution,
  type EditorEditContributionContext,
  type EditorEditContributionProvider,
  type EditorFeatureContribution,
  type EditorFeatureContributionContext,
  type EditorFeatureContributionProvider,
  type EditorGutterContribution,
  type EditorInjectedTextRowProviderContext,
  type EditorLogError,
  type EditorLogInput,
  type EditorOverlaySide,
  type EditorPlugin,
  type EditorViewContribution,
  type EditorViewContributionContext,
  type EditorViewContributionProvider,
  type EditorViewContributionUpdateKind,
  type EditorViewSnapshot,
} from '../plugins'
import { resolveSelection } from '../selections'
import { type EditorSyntaxLanguageId } from '../syntax/session'
import type { EditorSyntaxRange } from '../syntax/session'
import {
  parseMergeConflicts,
  resolveMergeConflict as resolveMergeConflictText,
  type MergeConflictRegion,
  type MergeConflictResolution,
} from '../mergeConflicts'
import type { FoldRange } from '../syntax/session'
import type { EditorTheme } from '../theme'
import { editorThemesEqual, mergeEditorThemes } from '../theme'
import type { EditorDocument, EditorToken, TextEdit } from '../tokens'
import {
  createStringTextSnapshot,
  defineLazyFullTextProperty,
  type TextSnapshot,
} from '../documentTextSnapshot'
import { clamp } from '../style-utils'
import {
  VirtualizedTextView,
  type HiddenCharactersMode,
  type VirtualizedFoldMarker,
  type VirtualizedTextRowDecoration,
} from '../virtualization/virtualizedTextView'

const RAPID_INPUT_SECONDARY_WORK_DELAY_MS = 150
const RAPID_INPUT_TIMING_NAMES = new Set([
  'input.beforeinput',
  'input.composition',
  'input.keydownFallback',
  'input.backspace',
  'input.delete',
])
const VISIBLE_SYNTAX_OVERSCAN_CHARS = 20_000
const VISIBLE_SYNTAX_TRAILING_CHARS = 50_000
const VISIBLE_SYNTAX_LEAD_CHARS = 250_000
const VISIBLE_SYNTAX_MAX_LEAD_CHARS = 750_000
const VISIBLE_SYNTAX_SCROLL_DELAY_MS = 16
const BACKGROUND_SYNTAX_WARM_DELAY_MS = 80
const SYNTAX_FOLD_PROJECTION_OWNER = 'editor.folds.syntax'
const DIRECT_RANGE_DECORATION_OWNER = 'editor.rangeDecorations.direct'
const DIRECT_ROW_DECORATION_OWNER = 'editor.rowDecorations.direct'
const FEATURE_ROW_DECORATION_OWNER_PREFIX = 'editor.rowDecorations.feature:'
const PLUGIN_BLOCK_ROWS_PROJECTION_OWNER = 'editor.blockRows.plugins'
const PLUGIN_BLOCK_LANES_PROJECTION_OWNER = 'editor.blockLanes.plugins'
const PLUGIN_GUTTER_PROJECTION_OWNER = 'editor.gutters.plugins'
const PLUGIN_INJECTED_ROWS_PROJECTION_OWNER = 'editor.injectedRows.plugins'

type SyntaxScrollDirection = -1 | 0 | 1
type EditorContributionKind = 'capability' | 'command' | 'decoration' | 'edit' | 'feature' | 'view'
type EditorContributionFailurePhase = 'dispose' | 'factory' | 'initial-update' | 'update'

type EditorLifecycleSummary = {
  readonly pluginNames: Set<string>
  readonly plugin: {
    activatedCount: number
    deactivatedCount: number
    disposedCount: number
    failedCount: number
    installedCount: number
    slowestActivationMs: number | null
    updatedCount: number
  }
  readonly folds: {
    firstSyntaxRejection: Record<string, unknown> | null
    syntaxRejectedCount: number
  }
  readonly syntax: {
    refreshScheduledCount: number
  }
  readonly document: {
    attachedCount: number
    clearedCount: number
    detachedCount: number
    openedCount: number
    setTextCount: number
    startedCount: number
    syncedTextCount: number
  }
  readonly content: {
    setCount: number
  }
  mountDurationMs: number | null
  mountedAt: string | null
  disposingAt: string | null
}

export class Editor {
  private readonly container: HTMLElement
  private readonly view: VirtualizedTextView
  private readonly foldState: EditorFoldState
  private readonly el: HTMLDivElement
  private lastSyntaxScrollTop: number | null = null
  private syntaxScrollDeltaPx = 0
  private syntaxScrollDirection: SyntaxScrollDirection = 0
  private readonly options: EditorOptions
  private readonly pluginHost: EditorPluginHost
  private readonly commandRouter: EditorCommandRouter
  private readonly document: EditorDocumentController
  private readonly editorFeatures = new Map<EditorCapabilityToken<unknown>, unknown>()
  private readonly editorFeatureTokensById = new Map<string, EditorCapabilityToken<unknown>>()
  private readonly rowDecorationSourceOwners = new Map<string, symbol>()
  private readonly rowDecorationSourcesByOwner = new Map<symbol, Set<string>>()
  private readonly rowDecorationContributionOwners = new Map<
    EditorDecorationContribution | EditorFeatureContribution,
    symbol
  >()
  private readonly commandContributions: EditorCommandContribution[] = []
  private readonly capabilityContributions: EditorCapabilityContribution[] = []
  private readonly editContributions: EditorEditContribution[] = []
  private readonly decorationContributions: EditorDecorationContribution[] = []
  private readonly editorFeatureContributions: EditorFeatureContribution[] = []
  private readonly viewContributionsByProvider = new Map<
    EditorViewContributionProvider,
    EditorViewContribution
  >()
  private readonly editorFeatureContributionsByProvider = new Map<
    EditorFeatureContributionProvider,
    EditorFeatureContribution
  >()
  private readonly commandContributionsByProvider = new Map<
    EditorCommandContributionProvider,
    EditorCommandContribution
  >()
  private readonly capabilityContributionsByProvider = new Map<
    EditorCapabilityContributionProvider,
    EditorCapabilityContribution
  >()
  private readonly editContributionsByProvider = new Map<
    EditorEditContributionProvider,
    EditorEditContribution
  >()
  private readonly decorationContributionsByProvider = new Map<
    EditorDecorationContributionProvider,
    EditorDecorationContribution
  >()
  private readonly keymap: EditorKeymapController
  private readonly viewContributions: EditorViewContributionController
  private readonly secondaryWork = new EditorSecondaryWorkScheduler()
  private readonly editChain = new DocumentEditChain()
  private lineStartsViewCache: { textVersion: number; view: LineStartsView } | null = null
  private readonly displayProjections = new EditorDisplayProjectionRegistry()
  private readonly highlightPrefix: string
  private sessionChangeVersion = 0
  private inlineReplacementProvider: EditorInlineReplacementProvider | null = null
  private syntaxCaptures: readonly EditorSyntaxCapture[] = []
  private blockSurfaces!: EditorBlockSurfaceController
  private readonly syntax: EditorSyntaxController
  private readonly inputSelection: InputSelectionController
  private configuredTheme: EditorTheme | null = null
  private appliedRangeDecorationNames: readonly string[] = []
  private appliedInjectedTextRows: readonly InjectedTextRow[] = []
  private readonly lifecycleSummary = createEditorLifecycleSummary()
  private readonly tabSize: number
  private disposed = false

  private get text(): string {
    return this.document.text
  }

  private set text(text: string) {
    const textVersionBeforeReplace = this.textVersion
    this.document.setRenderedText(text)
    this.editChain.record(textVersionBeforeReplace, this.textVersion, null)
  }

  private get textSnapshot(): TextSnapshot {
    return this.document.textSnapshot
  }

  private get session(): DocumentSession | null {
    return this.document.session
  }

  private get sessionOptions(): EditorSessionOptions {
    return this.document.sessionOptions
  }

  private get documentId(): string | null {
    return this.document.documentId
  }

  private get documentMode(): EditorDocumentMode {
    return this.document.documentMode
  }

  private get editability(): EditorEditability {
    return this.document.editability
  }

  private get languageId(): EditorSyntaxLanguageId | null {
    return this.document.languageId
  }

  private get documentVersion(): number {
    return this.document.documentVersion
  }

  private get textVersion(): number {
    return this.document.textVersion
  }

  private get syntaxStatus(): EditorSyntaxStatus {
    return this.syntax.status
  }

  private get tokens(): readonly EditorToken[] {
    return this.syntax.tokens
  }

  constructor(container: HTMLElement, options: EditorOptions = {}) {
    const mountStart = nowMs()
    this.container = container
    this.options = options
    this.tabSize = normalizeTabSize(options.tabSize)
    this.configuredTheme = options.theme ?? null
    this.pluginHost = new EditorPluginHost(options.plugins)
    this.highlightPrefix = nextEditorHighlightPrefix()
    this.document = new EditorDocumentController({
      defaultDocumentMode: options.documentMode,
      defaultEditability: options.editability,
      highlightPrefix: this.highlightPrefix,
    })
    this.setGutterProjection(this.pluginHost.getGutterContributions())
    this.view = new VirtualizedTextView(container, {
      className: 'editor',
      highlightRegistry: getHighlightRegistry(),
      gutterContributions: this.composedGutterContributions(),
      cursorLineHighlight: options.cursorLineHighlight,
      hiddenCharacters: options.hiddenCharacters,
      lineHeight: options.lineHeight,
      rowGap: options.rowGap,
      rowPositioning: options.rowPositioning,
      scrollMode: options.scrollMode,
      tabSize: this.tabSize,
      textMetrics: options.textMetrics,
      blockRowMount: (container, row) => this.blockSurfaces.mountRow(container, row),
      blockLaneMount: (container, lane) => this.blockSurfaces.mountLane(container, lane),
      onFoldToggle: this.handleFoldToggle,
      onViewportChange: this.handleViewportChange,
      selectionHighlightName: `${this.highlightPrefix}-selection`,
    })
    this.foldState = new EditorFoldState(this.view, () => this.session?.getSnapshot() ?? null)
    this.el = this.view.scrollElement
    this.blockSurfaces = new EditorBlockSurfaceController({
      getDocumentId: () => this.documentId,
      getLineCount: () => this.view.getLineCount(),
      materializeFullText: () => this.text,
      applyBlockRows: (rows) => this.applyBlockRowsProjection(rows),
      applyBlockLanes: (lanes) => this.applyBlockLanesProjection(lanes),
      focusEditor: () => this.focus(),
      setSelection: (anchor, head) =>
        this.inputSelection.applyFindSelection(anchor, head, 'editor.block.setSelection', head),
      notifyLayout: () => this.notifyViewContributions('layout', null),
    })
    this.syntax = new EditorSyntaxController({
      pluginHost: this.pluginHost,
      getDocumentVersion: () => this.documentVersion,
      getCurrentSessionDocumentId: () => this.currentSessionDocumentId(),
      getLanguageId: () => this.languageId,
      getSession: () => this.session,
      getVisibleSyntaxRange: () => this.visibleSyntaxRange(),
      adoptTokens: (tokens) => {
        this.view.adoptTokens(tokens)
        this.notifyViewContributions('tokens', null)
      },
      clearSyntaxFolds: () => this.clearSyntaxFolds(),
      setSyntaxFolds: (folds) => this.setSyntaxFolds(folds),
      setSyntaxCaptures: (captures) => this.setSyntaxCaptures(captures),
      notifyChange: (change) => this.notifyChange(change),
      notifyThemeChanged: () => this.applyResolvedTheme(),
      log: (event) => this.logSyntaxLifecycleEvent(event),
    })
    this.inputSelection = new InputSelectionController({
      el: this.el,
      selectionSyncMode: normalizeEditorSelectionSyncMode(options.selectionSyncMode),
      tabSize: this.tabSize,
      view: this.view,
      getLanguageId: () => this.languageId,
      getSession: () => this.session,
      getSessionOptions: () => this.sessionOptions,
      materializeFullText: () => this.materializeFullText(),
      canEditDocument: () => this.canEditDocument(),
      applySessionChange: (change, totalName, totalStart, options) =>
        this.applySessionChange(change, totalName, totalStart, options),
      notifyChangeWithTiming: (change) => this.notifyChangeWithTiming(change),
      notifyViewContributions: (kind, change) => this.notifyViewContributions(kind, change),
    })
    this.commandRouter = new EditorCommandRouter({
      history: (command, context) => this.inputSelection.applyHistoryCommand(command, context),
      delete: (direction, context) => this.inputSelection.applyDeleteCommand(direction, context),
      indent: (direction, context) => this.inputSelection.applyIndentCommand(direction, context),
      editAction: (command, context) =>
        this.inputSelection.applyEditActionCommand(command, context),
      selectAll: (context) => this.inputSelection.applySelectAllCommand(context),
      addNextOccurrence: (context) => this.inputSelection.applyAddNextOccurrenceCommand(context),
      clearSecondarySelections: (context) =>
        this.inputSelection.applyClearSecondarySelections(context),
      insertCursor: (direction, context) =>
        this.inputSelection.applyInsertCursorCommand(direction, context),
      selectExactOccurrences: (command, context) =>
        this.inputSelection.applySelectExactOccurrencesCommand(command, context),
      moveSelectionToNextOccurrence: (context) =>
        this.inputSelection.applyMoveSelectionToNextOccurrenceCommand(context),
      navigation: (command, context) =>
        this.inputSelection.applyNavigationCommand(command, context),
    })
    this.applyResolvedTheme()
    if (this.pluginHost.hasHighlighterProviders()) this.syntax.refreshHighlighterTheme()
    this.createInitialCommandContributions(this.pluginHost.getCommandContributionProviders())
    this.createInitialCapabilityContributions(this.pluginHost.getCapabilityContributionProviders())
    this.createInitialEditContributions(this.pluginHost.getEditContributionProviders())
    this.createInitialDecorationContributions(this.pluginHost.getDecorationContributionProviders())
    this.createInitialEditorFeatureContributions(
      this.pluginHost.getEditorFeatureContributionProviders(),
    )
    this.keymap = new EditorKeymapController({
      target: this.el,
      keymap: options.keymap,
      dispatch: (command, context) => this.dispatchCommand(command, context),
    })
    this.viewContributions = new EditorViewContributionController(
      this.createInitialViewContributions(this.pluginHost.getViewContributionProviders()),
      () => this.createViewSnapshot(),
      (_contribution, phase, error) => this.logContributionFailure('view', phase, error),
    )
    this.pluginHost.setEvents({
      onPluginInstalled: (name, durationMs) =>
        this.recordPluginLifecycle('installed', name, durationMs),
      onPluginInstallFailed: (name, error, durationMs) =>
        this.logPluginFailure('editor.plugin.install_failed', name, error, durationMs),
      onPluginActivated: (name, durationMs) =>
        this.recordPluginLifecycle('activated', name, durationMs),
      onPluginActivationFailed: (name, error, durationMs) =>
        this.logPluginFailure('editor.plugin.activation_failed', name, error, durationMs),
      onPluginUpdated: (name, durationMs) =>
        this.recordPluginLifecycle('updated', name, durationMs),
      onPluginUpdateFailed: (name, error, durationMs) =>
        this.logPluginFailure('editor.plugin.update_failed', name, error, durationMs),
      onPluginDeactivated: (name, durationMs) =>
        this.recordPluginLifecycle('deactivated', name, durationMs),
      onPluginDeactivateFailed: (name, error, durationMs) =>
        this.logPluginFailure('editor.plugin.deactivate_failed', name, error, durationMs),
      onPluginDisposed: (name) => this.recordPluginLifecycle('disposed', name),
      onHighlighterProvidersChanged: () => this.syntax.reloadHighlighterAndSyntax(),
      onSyntaxProvidersChanged: () => this.syntax.reloadSyntaxSession(),
      onViewContributionProviderAdded: (provider) => this.addViewContributionProvider(provider),
      onViewContributionProviderRemoved: (provider) =>
        this.removeViewContributionProvider(provider),
      onCommandContributionProviderAdded: (provider) =>
        this.addCommandContributionProvider(provider),
      onCommandContributionProviderRemoved: (provider) =>
        this.removeCommandContributionProvider(provider),
      onCapabilityContributionProviderAdded: (provider) =>
        this.addCapabilityContributionProvider(provider),
      onCapabilityContributionProviderRemoved: (provider) =>
        this.removeCapabilityContributionProvider(provider),
      onEditContributionProviderAdded: (provider) => this.addEditContributionProvider(provider),
      onEditContributionProviderRemoved: (provider) =>
        this.removeEditContributionProvider(provider),
      onDecorationContributionProviderAdded: (provider) =>
        this.addDecorationContributionProvider(provider),
      onDecorationContributionProviderRemoved: (provider) =>
        this.removeDecorationContributionProvider(provider),
      onEditorFeatureContributionProviderAdded: (provider) =>
        this.addEditorFeatureContributionProvider(provider),
      onEditorFeatureContributionProviderRemoved: (provider) =>
        this.removeEditorFeatureContributionProvider(provider),
      onGutterContributionsChanged: () => this.syncGutterContributions(),
      onBlockProvidersChanged: () => this.handleBlockProvidersChanged(),
      onInjectedTextRowProvidersChanged: () => this.handleInjectedTextRowProvidersChanged(),
      onInlineReplacementProvidersChanged: () => this.refreshInlineMap(),
    })
    this.inputSelection.install()
    this.initializeDefaultText()
    this.setRangeDecorations(options.rangeDecorations ?? [])
    const mountDurationMs = nowMs() - mountStart
    recordEditorMountTiming(mountDurationMs)
    this.logInitialPlugins()
    this.recordEditorMounted(mountDurationMs)
  }

  setContent(text: string): void {
    this.text = text
    this.view.setText(text)
    this.retagDisplayProjectionSources()
    this.syncEditorBlocks()
    this.syncInjectedTextRows()
    this.setTokens([])
    this.clearSyntaxFolds()
    this.applyRangeDecorations()
    this.notifyViewContributions('content', null)
    this.recordContentSet()
  }

  setTokens(tokens: readonly EditorToken[]): void {
    copyTokenProjectionMetadata(tokens, tokens)
    this.adoptTokens(tokens)
  }

  applyEdit(edit: TextEdit, tokens: readonly EditorToken[], textSnapshot?: TextSnapshot): void {
    const nextTextSnapshot = textSnapshot ?? this.legacyEditTextSnapshot(edit)
    const textVersionBeforeEdit = this.textVersion
    this.document.setRenderedTextSnapshot(nextTextSnapshot)
    this.editChain.record(textVersionBeforeEdit, this.textVersion, [edit])
    this.retagDisplayProjectionSources()
    measureEditorPerformance('editor.view.applyEdit', () =>
      this.view.applyEdit(edit, nextTextSnapshot),
    )
    this.syncEditorBlocks()
    this.syncInjectedTextRows()
    measureEditorPerformance(
      'editor.tokens.adoptProjected',
      () => this.adoptTokens(tokens),
      () => ({
        tokenCount: tokens.length,
      }),
    )
  }

  private adoptTokens(tokens: readonly EditorToken[]): void {
    this.syntax.setTokens(tokens)
  }

  setDocument(document: EditorDocument): void {
    this.setContent(document.text)
    this.setTokens(document.tokens ?? [])
  }

  setFoldMap(foldMap: FoldMap | null): void {
    this.view.setFoldMap(foldMap)
  }

  /**
   * Installs the inline replacements this document renders instead of parts of its own text — the
   * entry point a markdown live-preview view drives. Passing null restores raw buffer text.
   */
  setInlineMap(inlineMap: InlineMap | null): void {
    this.view.setInlineMap(inlineMap)
  }

  /**
   * Registers a provider that turns the document's syntax captures into inline replacements. The map
   * is rebuilt whenever fresh captures land, so a markdown view stays in step with the parse without
   * the host scheduling anything itself. Passing null removes the transform.
   */
  setInlineReplacementProvider(provider: EditorInlineReplacementProvider | null): void {
    this.inlineReplacementProvider = provider
    this.refreshInlineMap()
  }

  private setSyntaxCaptures(captures: readonly EditorSyntaxCapture[]): void {
    this.syntaxCaptures = captures
    this.refreshInlineMap()
  }

  private refreshInlineMap(): void {
    const providers = this.inlineReplacementProviders()
    const snapshot = this.session?.getSnapshot()
    if (providers.length === 0 || !snapshot) {
      this.view.setInlineMap(null)
      return
    }

    const context = {
      text: this.materializeFullText(),
      languageId: this.languageId,
      captures: this.syntaxCaptures,
    }
    const specs = providers.flatMap((provider) => provider(context))
    this.view.setInlineMap(specs.length === 0 ? null : createInlineMap(snapshot, specs))
  }

  private inlineReplacementProviders(): readonly EditorInlineReplacementProvider[] {
    const registered = this.pluginHost.getInlineReplacementProviders()
    const direct = this.inlineReplacementProvider
    if (!direct) return registered
    return [direct, ...registered]
  }

  setSyntaxFolds(folds: readonly FoldRange[]): void {
    this.setSyntaxFoldProjection(folds)
    this.syncFoldStateFromProjections()
  }

  toggleFold(offset?: number): boolean {
    return this.applyFoldOperation('toggle', offset)
  }

  fold(offset?: number): boolean {
    return this.applyFoldOperation('fold', offset)
  }

  unfold(offset?: number): boolean {
    return this.applyFoldOperation('unfold', offset)
  }

  foldAll(): boolean {
    if (!this.session) return false

    const changed = this.foldState.foldAll()
    if (changed) {
      this.notifyViewContributions('layout', null)
      this.log({
        action: 'editor.fold.all',
        level: 'info',
        fold: { collapsedCount: this.foldState.collapsedFoldCount },
      })
    }
    return changed
  }

  unfoldAll(): boolean {
    if (!this.session) return false

    const changed = this.foldState.unfoldAll()
    if (changed) {
      this.notifyViewContributions('layout', null)
      this.log({
        action: 'editor.unfold.all',
        level: 'info',
        fold: { collapsedCount: this.foldState.collapsedFoldCount },
      })
    }
    return changed
  }

  setText(text: string, options: EditorSetTextOptions = {}): void {
    const currentScrollPosition = this.getScrollPosition()
    const documentVersion = this.resetOwnedDocument(
      {
        text,
        documentMode: options.documentMode ?? this.documentMode,
        languageId: options.languageId,
      },
      {
        documentId: null,
        persistentIdentity: false,
        scrollPosition: preservedScrollPosition(currentScrollPosition, options.scrollPosition),
      },
    )
    this.notifyChange(null)
    this.refreshSyntax(documentVersion, null)
    this.lifecycleSummary.document.setTextCount += 1
  }

  syncText(text: string, options: EditorSetTextOptions = {}): void {
    const documentMode = normalizeEditorDocumentMode(options.documentMode ?? this.documentMode)
    const languageId = options.languageId ?? null
    if (!this.session || documentMode !== this.documentMode || languageId !== this.languageId) {
      this.setText(text, options)
      return
    }
    if (this.materializeFullText() === text) return

    const scrollPosition = preservedScrollPosition(this.getScrollPosition(), options.scrollPosition)
    const change = this.session.applyEdits([syncTextEdit(this.text, text)], {
      history: 'skip',
    })
    if (change.kind === 'none') return

    this.applySessionChange(change, 'editor.syncText', nowMs(), {
      syncDomSelection: false,
    })
    this.applyDocumentScrollPosition(scrollPosition)
    this.lifecycleSummary.document.syncedTextCount += 1
  }

  edit(editOrEdits: EditorEditInput, options: EditorEditOptions = {}): void {
    if (!this.canEditDocument()) return

    this.ensureAnonymousSession()
    if (!this.session) return

    const edits = normalizeEditorEditInput(editOrEdits)
    const change = this.session.applyEdits(edits, options)
    if (change.kind === 'none') return

    this.applySessionChange(change, 'editor.edit', nowMs())
  }

  openDocument(document: EditorOpenDocumentOptions): void {
    // Content loads can resolve after teardown (e.g. a StrictMode-unmounted
    // editor whose file fetch lands later). Opening then would start a syntax
    // session nothing ever disposes, leaking a parse tree in the worker.
    if (this.disposed) return

    this.editChain.clear()
    const documentVersion = this.resetOwnedDocument(document, {
      documentId: document.documentId ?? null,
      persistentIdentity: true,
      scrollPosition: document.scrollPosition,
    })
    this.notifyChange(null)
    this.refreshSyntax(documentVersion, null)
    this.lifecycleSummary.document.openedCount += 1
  }

  private ensureAnonymousSession(): void {
    if (this.session) return

    this.resetOwnedDocument(
      { text: '', languageId: null },
      {
        documentId: null,
        persistentIdentity: false,
        scrollPosition: DOCUMENT_START_SCROLL_POSITION,
      },
    )
  }

  clearDocument(): void {
    this.clear()
    this.notifyChange(null)
  }

  getState(): EditorState {
    const snapshot = this.session?.getSnapshot()
    const length = snapshot?.length ?? this.text.length
    const selection = this.session?.getSelections().selections[0]
    const resolved = snapshot && selection ? resolveSelection(snapshot, selection) : null
    const point = snapshot ? offsetToPoint(snapshot, resolved?.headOffset ?? length) : null

    return {
      documentId: this.documentId,
      documentMode: this.documentMode,
      editability: this.editability,
      languageId: this.languageId,
      syntaxStatus: this.syntaxStatus,
      cursor: {
        row: point?.row ?? 0,
        column: point?.column ?? 0,
      },
      length,
      canUndo: this.session?.canUndo() ?? false,
      canRedo: this.session?.canRedo() ?? false,
      isDirty: this.session?.isDirty() ?? false,
    }
  }

  materializeFullText(): string {
    return this.session?.materializeFullText() ?? this.text
  }

  getTextSnapshot(): TextSnapshot {
    return this.textSnapshot
  }

  getMergeConflicts(): readonly MergeConflictRegion[] {
    return parseMergeConflicts(this.materializeFullText())
  }

  resolveMergeConflict(index: number, resolution: MergeConflictResolution): boolean {
    if (!this.canEditDocument()) return false

    const text = this.materializeFullText()
    const conflict = parseMergeConflicts(text)[index]
    if (!conflict) return false

    const resolved = resolveMergeConflictText(text, conflict, resolution)
    if (!resolved) return false

    this.edit(
      { from: resolved.range.start, to: resolved.range.end, text: resolved.replacement },
      {
        selection: {
          anchor: resolved.selection.start,
          head: resolved.selection.end,
        },
      },
    )
    return true
  }

  revealMergeConflict(index: number): boolean {
    const conflict = parseMergeConflicts(this.materializeFullText())[index]
    if (!conflict) return false

    this.setSelection(conflict.range.start)
    return true
  }

  focus(): void {
    this.view.focusInput()
  }

  setSelection(anchor: number, head = anchor, reveal?: EditorSelectionRevealTarget): void {
    const revealOffset = selectionRevealOffset(reveal, head)
    this.inputSelection.applyFindSelection(anchor, head, 'editor.setSelection', revealOffset)
  }

  openFind(): boolean {
    return this.findFeature()?.openFind() ?? false
  }

  openFindReplace(): boolean {
    return this.findFeature()?.openFindReplace() ?? false
  }

  closeFind(): boolean {
    return this.findFeature()?.closeFind() ?? false
  }

  findNext(): boolean {
    return this.findFeature()?.findNext() ?? false
  }

  findPrevious(): boolean {
    return this.findFeature()?.findPrevious() ?? false
  }

  replaceOne(): boolean {
    return this.findFeature()?.replaceOne() ?? false
  }

  replaceAll(): boolean {
    return this.findFeature()?.replaceAll() ?? false
  }

  selectAllMatches(): boolean {
    return this.findFeature()?.selectAllMatches() ?? false
  }

  getScrollPosition(): Required<EditorScrollPosition> {
    const viewState = this.view.getState()
    return {
      top: viewState.scrollTop,
      left: viewState.scrollLeft,
    }
  }

  setScrollPosition(scrollPosition: EditorScrollPosition): void {
    this.applyScrollPosition(scrollPosition)
  }

  setTheme(theme: EditorTheme | null | undefined): void {
    const nextTheme = theme ?? null
    if (editorThemesEqual(this.configuredTheme, nextTheme)) return

    this.configuredTheme = nextTheme
    this.applyResolvedTheme()
    this.notifyViewContributions('tokens', null)
    this.log({
      action: 'editor.theme.changed',
      level: 'info',
      theme: { configured: nextTheme !== null },
    })
  }

  setHiddenCharacters(mode: HiddenCharactersMode): void {
    this.view.setHiddenCharacters(mode)
    this.log({
      action: 'editor.rendering.hidden_characters_changed',
      level: 'info',
      rendering: { hiddenCharacters: mode },
    })
  }

  setKeymap(keymap: EditorOptions['keymap']): void {
    if (!this.keymap.setKeymap(keymap)) return

    this.log({
      action: 'editor.keymap.changed',
      level: 'info',
      keymap: { configured: Boolean(keymap) },
    })
  }

  setEditability(editability: EditorEditability): void {
    if (!this.document.setEditability(editability)) return

    this.syncViewEditability()
    this.notifyChange(null)
    this.log({
      action: 'editor.editability.changed',
      level: 'info',
      editability,
    })
  }

  setRangeDecorations(decorations: readonly EditorRangeDecoration[]): void {
    if (sameEditorRangeDecorations(this.directRangeDecorations(), decorations)) return

    this.displayProjections.set({
      kind: 'rangeDecorations',
      owner: DIRECT_RANGE_DECORATION_OWNER,
      source: this.currentDisplayProjectionSource(),
      invalidationRange: FULL_DISPLAY_PROJECTION_INVALIDATION,
      layer: 0,
      priority: 0,
      disposal: NO_DISPLAY_PROJECTION_DISPOSAL,
      value: [...decorations],
    })
    this.applyRangeDecorations()
    this.log({
      action: 'editor.decorations.range.changed',
      level: 'info',
      decorations: { count: decorations.length },
    })
  }

  setRowDecorations(decorations: ReadonlyMap<number, VirtualizedTextRowDecoration>): void {
    this.displayProjections.set({
      kind: 'rowDecorations',
      owner: DIRECT_ROW_DECORATION_OWNER,
      source: this.currentDisplayProjectionSource(),
      invalidationRange: FULL_DISPLAY_PROJECTION_INVALIDATION,
      layer: 0,
      priority: 0,
      disposal: NO_DISPLAY_PROJECTION_DISPOSAL,
      value: new Map(decorations),
    })
    this.applyComposedRowDecorations()
    this.log({
      action: 'editor.decorations.row.changed',
      level: 'info',
      decorations: { count: decorations.size },
    })
  }

  setLineHeight(lineHeight: number): void {
    if (!this.view.setLineHeight(lineHeight)) return

    this.notifyViewContributions('layout', null)
    this.log({
      action: 'editor.layout.line_height_changed',
      level: 'info',
      layout: { lineHeight },
    })
  }

  setRowGap(rowGap: number): void {
    if (!this.view.setRowGap(rowGap)) return

    this.notifyViewContributions('layout', null)
    this.log({
      action: 'editor.layout.row_gap_changed',
      level: 'info',
      layout: { rowGap },
    })
  }

  setScrollMode(scrollMode: EditorOptions['scrollMode']): void {
    if (!this.view.setScrollMode(scrollMode)) return

    this.notifyViewContributions('layout', null)
    this.log({
      action: 'editor.layout.scroll_mode_changed',
      level: 'info',
      layout: { scrollMode },
    })
  }

  addPlugin(plugin: EditorPlugin): EditorDisposable {
    return this.pluginHost.addPlugin(plugin)
  }

  removePlugin(plugin: EditorPlugin): boolean {
    return this.pluginHost.removePlugin(plugin)
  }

  setPlugins(plugins: readonly EditorPlugin[]): void {
    this.pluginHost.setPlugins(plugins)
    this.log({
      action: 'editor.plugins.set',
      level: 'info',
      plugins: plugins.map((plugin) => plugin.name ?? 'anonymous'),
    })
  }

  dispatchCommand(command: EditorCommandId, context: EditorCommandContext = {}): boolean {
    const start = nowMs()
    const handled = this.commandRouter.dispatch(command, context)
    this.log({
      action: 'editor.command.dispatched',
      level: handled ? 'info' : 'debug',
      command: {
        id: command,
        handled,
        keyboardEvent: Boolean(context.event),
      },
      durationMs: nowMs() - start,
    })
    return handled
  }

  attachSession(session: DocumentSession, options: EditorSessionOptions = {}): void {
    const attachment = this.document.attachSession(session, options)
    this.syntax.startDocument({
      documentId: attachment.internalDocumentId,
      languageId: attachment.languageId,
      textSnapshot: attachment.textSnapshot,
      snapshot: attachment.session.getSnapshot(),
    })
    this.lifecycleSummary.document.startedCount += 1
    this.syncViewEditability()
    this.setDocument({ text: attachment.fullText, tokens: [] })
    this.applyDocumentScrollPosition(options.scrollPosition)
    this.inputSelection.syncDomSelection()
    this.notifyViewContributions('document', null)
    this.notifyChange(null)
    this.refreshSyntax(attachment.documentVersion, null)
    this.lifecycleSummary.document.attachedCount += 1
  }

  detachSession(): void {
    this.document.detachSession()
    this.inputSelection.clearSelectionHighlight()
    this.view.setEditable(false)
    this.lifecycleSummary.document.detachedCount += 1
  }

  clear(): void {
    this.document.clear()
    this.syntax.clearDocument()
    this.inputSelection.clearSelectionHighlight()
    this.view.setEditable(false)
    this.setContent('')
    this.applyDocumentScrollPosition()
    this.notifyViewContributions('clear', null)
    this.lifecycleSummary.document.clearedCount += 1
  }

  dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.lifecycleSummary.disposingAt = new Date().toISOString()
    this.secondaryWork.dispose()
    this.displayProjections.clear()
    this.blockSurfaces.dispose()
    this.inputSelection.dispose()
    this.viewContributions.dispose()
    this.disposeEditorFeatureContributions()
    this.disposeDecorationContributions()
    this.disposeEditContributions()
    this.disposeCapabilityContributions()
    this.disposeCommandContributions()
    this.keymap.dispose()
    this.syntax.dispose()
    this.detachSession()
    this.logLifecycleSummary()
    this.pluginHost.dispose()
    this.view.dispose()
  }

  private resetOwnedDocument(
    document: EditorOpenDocumentOptions,
    options: ResetOwnedDocumentOptions,
  ): number {
    const attachment = this.document.resetOwnedDocument(document, options)
    this.syntax.startDocument({
      documentId: attachment.internalDocumentId,
      languageId: attachment.languageId,
      textSnapshot: attachment.textSnapshot,
      snapshot: attachment.session.getSnapshot(),
    })
    this.lifecycleSummary.document.startedCount += 1
    this.syncViewEditability()
    this.setDocument({ text: attachment.fullText, tokens: [] })
    this.applyRangeDecorations()
    this.applyDocumentScrollPosition(options.scrollPosition)
    this.inputSelection.syncDomSelection()
    this.notifyViewContributions('document', null)
    return attachment.documentVersion
  }

  private initializeDefaultText(): void {
    if (this.options.defaultText === undefined) return

    this.resetOwnedDocument(
      {
        text: this.options.defaultText,
        documentMode: normalizeEditorDocumentMode(this.options.documentMode),
        languageId: null,
      },
      {
        documentId: null,
        persistentIdentity: false,
        scrollPosition: DOCUMENT_START_SCROLL_POSITION,
      },
    )
  }

  private applyDocumentScrollPosition(scrollPosition?: EditorScrollPosition): void {
    this.applyScrollPosition({
      top: scrollPosition?.top ?? DOCUMENT_START_SCROLL_POSITION.top,
      left: scrollPosition?.left ?? DOCUMENT_START_SCROLL_POSITION.left,
    })
  }

  private applyScrollPosition(scrollPosition: EditorScrollPosition): void {
    const viewState = this.view.getState()
    const scrollTop = normalizeScrollOffset(
      scrollPosition.top,
      viewState.scrollTop,
      viewState.scrollHeight - viewState.viewportHeight,
    )
    const scrollLeft = normalizeScrollOffset(
      scrollPosition.left,
      viewState.scrollLeft,
      viewState.scrollWidth - viewState.viewportWidth,
    )
    if (scrollTop === viewState.scrollTop && scrollLeft === viewState.scrollLeft) return

    this.el.scrollTop = scrollTop
    this.el.scrollLeft = scrollLeft
    this.view.setScrollMetrics(
      scrollTop,
      viewState.viewportHeight,
      viewState.viewportWidth,
      scrollLeft,
    )
  }

  private currentSessionDocumentId(): string {
    return this.document.currentSessionDocumentId()
  }

  private createInitialViewContributions(
    providers: readonly EditorViewContributionProvider[],
  ): EditorViewContribution[] {
    const contributions: EditorViewContribution[] = []
    for (const provider of providers) {
      const contribution = this.createViewContribution(provider)
      if (!contribution) continue

      contributions.push(contribution)
      this.viewContributionsByProvider.set(provider, contribution)
    }

    return contributions
  }

  private addViewContributionProvider(provider: EditorViewContributionProvider): void {
    const contribution = this.createViewContribution(provider)
    if (!contribution) return

    this.viewContributionsByProvider.set(provider, contribution)
    this.viewContributions.add(contribution)
  }

  private removeViewContributionProvider(provider: EditorViewContributionProvider): void {
    const contribution = this.viewContributionsByProvider.get(provider)
    if (!contribution) return

    this.viewContributionsByProvider.delete(provider)
    this.viewContributions.remove(contribution)
  }

  private createViewContribution(
    provider: EditorViewContributionProvider,
  ): EditorViewContribution | null {
    try {
      return provider.createContribution(this.createViewContributionContext(this.container))
    } catch (error) {
      this.logContributionFailure('view', 'factory', error)
      return null
    }
  }

  private createInitialCommandContributions(
    providers: readonly EditorCommandContributionProvider[],
  ): void {
    for (const provider of providers) this.addCommandContributionProvider(provider)
  }

  private addCommandContributionProvider(provider: EditorCommandContributionProvider): void {
    const contribution = this.createCommandContribution(provider)
    if (!contribution) return

    this.commandContributionsByProvider.set(provider, contribution)
    this.commandContributions.push(contribution)
  }

  private createCommandContribution(
    provider: EditorCommandContributionProvider,
  ): EditorCommandContribution | null {
    try {
      return provider.createContribution(this.createCommandContributionContext())
    } catch (error) {
      this.logContributionFailure('command', 'factory', error)
      return null
    }
  }

  private removeCommandContributionProvider(provider: EditorCommandContributionProvider): void {
    const contribution = this.commandContributionsByProvider.get(provider)
    if (!contribution) return

    this.commandContributionsByProvider.delete(provider)
    removeArrayItem(this.commandContributions, contribution)
    this.disposeContributionSafely(contribution, 'command')
  }

  private disposeCommandContributions(): void {
    while (this.commandContributions.length > 0) {
      const contribution = this.commandContributions.pop()
      if (contribution) this.disposeContributionSafely(contribution, 'command')
    }
    this.commandContributionsByProvider.clear()
  }

  private createInitialCapabilityContributions(
    providers: readonly EditorCapabilityContributionProvider[],
  ): void {
    for (const provider of providers) this.addCapabilityContributionProvider(provider)
  }

  private addCapabilityContributionProvider(provider: EditorCapabilityContributionProvider): void {
    const contribution = this.createCapabilityContribution(provider)
    if (!contribution) return

    this.capabilityContributionsByProvider.set(provider, contribution)
    this.capabilityContributions.push(contribution)
  }

  private createCapabilityContribution(
    provider: EditorCapabilityContributionProvider,
  ): EditorCapabilityContribution | null {
    try {
      return provider.createContribution(this.createCapabilityContributionContext())
    } catch (error) {
      this.logContributionFailure('capability', 'factory', error)
      return null
    }
  }

  private removeCapabilityContributionProvider(
    provider: EditorCapabilityContributionProvider,
  ): void {
    const contribution = this.capabilityContributionsByProvider.get(provider)
    if (!contribution) return

    this.capabilityContributionsByProvider.delete(provider)
    removeArrayItem(this.capabilityContributions, contribution)
    this.disposeContributionSafely(contribution, 'capability')
  }

  private disposeCapabilityContributions(): void {
    while (this.capabilityContributions.length > 0) {
      const contribution = this.capabilityContributions.pop()
      if (contribution) this.disposeContributionSafely(contribution, 'capability')
    }
    this.capabilityContributionsByProvider.clear()
  }

  private createInitialEditContributions(
    providers: readonly EditorEditContributionProvider[],
  ): void {
    for (const provider of providers) this.addEditContributionProvider(provider)
  }

  private addEditContributionProvider(provider: EditorEditContributionProvider): void {
    const contribution = this.createEditContribution(provider)
    if (!contribution) return

    this.editContributionsByProvider.set(provider, contribution)
    this.editContributions.push(contribution)
  }

  private createEditContribution(
    provider: EditorEditContributionProvider,
  ): EditorEditContribution | null {
    try {
      return provider.createContribution(this.createEditContributionContext())
    } catch (error) {
      this.logContributionFailure('edit', 'factory', error)
      return null
    }
  }

  private removeEditContributionProvider(provider: EditorEditContributionProvider): void {
    const contribution = this.editContributionsByProvider.get(provider)
    if (!contribution) return

    this.editContributionsByProvider.delete(provider)
    removeArrayItem(this.editContributions, contribution)
    this.disposeContributionSafely(contribution, 'edit')
  }

  private disposeEditContributions(): void {
    while (this.editContributions.length > 0) {
      const contribution = this.editContributions.pop()
      if (contribution) this.disposeContributionSafely(contribution, 'edit')
    }
    this.editContributionsByProvider.clear()
  }

  private createInitialDecorationContributions(
    providers: readonly EditorDecorationContributionProvider[],
  ): void {
    for (const provider of providers) this.addDecorationContributionProvider(provider, false)
  }

  private addDecorationContributionProvider(
    provider: EditorDecorationContributionProvider,
    notify = true,
  ): void {
    const owner = Symbol('editor.decorationContribution')
    const contribution = this.createDecorationContribution(provider, owner)
    if (!contribution) return

    this.decorationContributionsByProvider.set(provider, contribution)
    this.rowDecorationContributionOwners.set(contribution, owner)
    this.decorationContributions.push(contribution)
    if (notify) contribution.handleEditorChange?.(null)
  }

  private createDecorationContribution(
    provider: EditorDecorationContributionProvider,
    owner: symbol,
  ): EditorDecorationContribution | null {
    try {
      const contribution = provider.createContribution(
        this.createDecorationContributionContext(owner),
      )
      if (!contribution) this.clearRowDecorationSourcesForOwner(owner)
      return contribution
    } catch (error) {
      this.clearRowDecorationSourcesForOwner(owner)
      this.logContributionFailure('decoration', 'factory', error)
      return null
    }
  }

  private removeDecorationContributionProvider(
    provider: EditorDecorationContributionProvider,
  ): void {
    const contribution = this.decorationContributionsByProvider.get(provider)
    if (!contribution) return

    this.decorationContributionsByProvider.delete(provider)
    removeArrayItem(this.decorationContributions, contribution)
    this.disposeContributionSafely(contribution, 'decoration')
    this.clearContributionRowDecorationSources(contribution)
  }

  private disposeDecorationContributions(): void {
    while (this.decorationContributions.length > 0) {
      const contribution = this.decorationContributions.pop()
      if (!contribution) continue

      this.disposeContributionSafely(contribution, 'decoration')
      this.clearContributionRowDecorationSources(contribution)
    }
    this.decorationContributionsByProvider.clear()
  }

  private createInitialEditorFeatureContributions(
    providers: readonly EditorFeatureContributionProvider[],
  ): void {
    for (const provider of providers) this.addEditorFeatureContributionProvider(provider, false)
  }

  private addEditorFeatureContributionProvider(
    provider: EditorFeatureContributionProvider,
    notify = true,
  ): void {
    const owner = Symbol('editor.featureContribution')
    const contribution = this.createEditorFeatureContribution(provider, owner)
    if (!contribution) return

    this.editorFeatureContributionsByProvider.set(provider, contribution)
    this.rowDecorationContributionOwners.set(contribution, owner)
    this.editorFeatureContributions.push(contribution)
    if (notify) contribution.handleEditorChange?.(null)
  }

  private createEditorFeatureContribution(
    provider: EditorFeatureContributionProvider,
    owner: symbol,
  ): EditorFeatureContribution | null {
    try {
      const contribution = provider.createContribution(
        this.createEditorFeatureContributionContext(this.container, owner),
      )
      if (!contribution) this.clearRowDecorationSourcesForOwner(owner)
      return contribution
    } catch (error) {
      this.clearRowDecorationSourcesForOwner(owner)
      this.logContributionFailure('feature', 'factory', error)
      return null
    }
  }

  private removeEditorFeatureContributionProvider(
    provider: EditorFeatureContributionProvider,
  ): void {
    const contribution = this.editorFeatureContributionsByProvider.get(provider)
    if (!contribution) return

    this.editorFeatureContributionsByProvider.delete(provider)
    removeArrayItem(this.editorFeatureContributions, contribution)
    this.disposeContributionSafely(contribution, 'feature')
    this.clearContributionRowDecorationSources(contribution)
  }

  private disposeEditorFeatureContributions(): void {
    while (this.editorFeatureContributions.length > 0) {
      const contribution = this.editorFeatureContributions.pop()
      if (!contribution) continue

      this.disposeContributionSafely(contribution, 'feature')
      this.clearContributionRowDecorationSources(contribution)
    }
    this.editorFeatureContributionsByProvider.clear()
  }

  private logInitialPlugins(): void {
    for (const name of this.pluginHost.getActivePluginNames()) {
      this.recordPluginLifecycle('activated', name)
    }
  }

  private recordEditorMounted(durationMs: number): void {
    this.lifecycleSummary.mountDurationMs = durationMs
    this.lifecycleSummary.mountedAt = new Date().toISOString()

    for (const name of this.pluginHost.getActivePluginNames()) {
      this.lifecycleSummary.pluginNames.add(name)
    }
  }

  private recordContentSet(): void {
    this.lifecycleSummary.content.setCount += 1
  }

  private recordPluginLifecycle(
    phase: 'activated' | 'deactivated' | 'disposed' | 'installed' | 'updated',
    name: string,
    durationMs?: number,
  ): void {
    this.lifecycleSummary.pluginNames.add(name)
    if (phase === 'activated') this.recordPluginActivation(durationMs)
    if (phase === 'deactivated') this.lifecycleSummary.plugin.deactivatedCount += 1
    if (phase === 'disposed') this.lifecycleSummary.plugin.disposedCount += 1
    if (phase === 'installed') this.lifecycleSummary.plugin.installedCount += 1
    if (phase === 'updated') this.lifecycleSummary.plugin.updatedCount += 1
  }

  private recordPluginActivation(durationMs?: number): void {
    this.lifecycleSummary.plugin.activatedCount += 1
    if (durationMs === undefined) return

    const slowest = this.lifecycleSummary.plugin.slowestActivationMs
    if (slowest !== null && slowest >= durationMs) return

    this.lifecycleSummary.plugin.slowestActivationMs = durationMs
  }

  private logPluginFailure(
    action:
      | 'editor.plugin.activation_failed'
      | 'editor.plugin.deactivate_failed'
      | 'editor.plugin.install_failed'
      | 'editor.plugin.update_failed',
    name: string,
    error: unknown,
    durationMs: number,
  ): void {
    this.lifecycleSummary.pluginNames.add(name)
    this.lifecycleSummary.plugin.failedCount += 1
    this.log({
      action,
      level: 'error',
      durationMs,
      error: editorLogError(error),
      plugin: { name },
    })
  }

  private logSyntaxLifecycleEvent(event: EditorLogInput): void {
    if (event.action === 'editor.syntax.refresh_scheduled') {
      this.lifecycleSummary.syntax.refreshScheduledCount += 1
      return
    }

    this.log(event)
  }

  private logLifecycleSummary(): void {
    const disposingPluginNames = this.pluginHost.getActivePluginNames()
    this.log({
      action: 'editor.lifecycle.summary',
      level: 'info',
      content: this.lifecycleSummary.content,
      document: this.lifecycleSummary.document,
      folds: this.lifecycleSummary.folds,
      lifecycle: {
        disposingAt: this.lifecycleSummary.disposingAt,
        mountDurationMs: this.lifecycleSummary.mountDurationMs,
        mountedAt: this.lifecycleSummary.mountedAt,
      },
      plugin: {
        ...this.lifecycleSummary.plugin,
        deactivatedCount:
          this.lifecycleSummary.plugin.deactivatedCount + disposingPluginNames.length,
        disposedCount: this.lifecycleSummary.plugin.disposedCount + disposingPluginNames.length,
        names: [...this.lifecycleSummary.pluginNames].toSorted(),
      },
      syntax: this.lifecycleSummary.syntax,
    })
  }

  private log(event: EditorLogInput): void {
    if (!this.pluginHost.hasLoggers()) return

    this.pluginHost.log({
      ...event,
      editor: {
        ...event.editor,
        documentId: this.documentId,
        documentMode: this.documentMode,
        documentVersion: this.documentVersion,
        editability: this.editability,
        instanceId: this.highlightPrefix,
        languageId: this.languageId,
        textVersion: this.textVersion,
      },
      source: 'editor',
      timestamp: event.timestamp ?? new Date().toISOString(),
    })
  }

  private logContributionFailure(
    kind: EditorContributionKind,
    phase: EditorContributionFailurePhase,
    error: unknown,
  ): void {
    this.log({
      action: editorContributionFailureAction(phase),
      level: 'error',
      error: editorLogError(error),
      contribution: { kind, phase },
    })
  }

  private disposeContributionSafely(
    contribution: EditorDisposable,
    kind: EditorContributionKind,
  ): void {
    try {
      contribution.dispose()
    } catch (error) {
      this.logContributionFailure(kind, 'dispose', error)
    }
  }

  private syncGutterContributions(): void {
    const contributions = this.pluginHost.getGutterContributions()
    if (!this.setGutterProjection(contributions)) return
    if (!this.view.setGutterContributions(this.composedGutterContributions())) return

    this.notifyViewContributions('layout', null)
    this.log({
      action: 'editor.plugins.gutters.changed',
      level: 'info',
      plugins: {
        gutterContributionCount: this.composedGutterContributions().length,
      },
    })
  }

  private setGutterProjection(contributions: readonly EditorGutterContribution[]): boolean {
    if (sameGutterContributions(this.pluginGutterContributions(), contributions)) return false
    if (contributions.length === 0) {
      return this.displayProjections.delete('gutters', PLUGIN_GUTTER_PROJECTION_OWNER)
    }

    this.displayProjections.set({
      kind: 'gutters',
      owner: PLUGIN_GUTTER_PROJECTION_OWNER,
      source: this.currentDisplayProjectionSource(),
      invalidationRange: FULL_DISPLAY_PROJECTION_INVALIDATION,
      layer: 0,
      priority: 0,
      disposal: NO_DISPLAY_PROJECTION_DISPOSAL,
      value: [...contributions],
    })
    return true
  }

  private pluginGutterContributions(): readonly EditorGutterContribution[] {
    return this.displayProjections.get('gutters', PLUGIN_GUTTER_PROJECTION_OWNER)?.value ?? []
  }

  private composedGutterContributions(): readonly EditorGutterContribution[] {
    const contributions: EditorGutterContribution[] = []
    for (const projection of this.displayProjections.values('gutters')) {
      contributions.push(...projection.value)
    }

    return contributions
  }

  private handleBlockProvidersChanged(): void {
    this.syncEditorBlocks()
    this.notifyViewContributions('layout', null)
    this.log({
      action: 'editor.plugins.blocks.changed',
      level: 'info',
      plugins: {
        blockProviderCount: this.pluginHost.getBlockProviders().length,
      },
    })
  }

  private syncEditorBlocks(): void {
    this.blockSurfaces.sync(this.pluginHost.getBlockProviders())
  }

  private applyBlockRowsProjection(rows: readonly BlockRow[]): void {
    this.setBlockRowsProjection(rows)
    this.view.setBlockRows(this.composedBlockRows())
  }

  private setBlockRowsProjection(rows: readonly BlockRow[]): void {
    if (rows.length === 0) {
      this.displayProjections.delete('blockRows', PLUGIN_BLOCK_ROWS_PROJECTION_OWNER)
      return
    }

    this.displayProjections.set({
      kind: 'blockRows',
      owner: PLUGIN_BLOCK_ROWS_PROJECTION_OWNER,
      source: this.currentDisplayProjectionSource(),
      invalidationRange: FULL_DISPLAY_PROJECTION_INVALIDATION,
      layer: 0,
      priority: 0,
      disposal: NO_DISPLAY_PROJECTION_DISPOSAL,
      value: [...rows],
    })
  }

  private composedBlockRows(): readonly BlockRow[] {
    const rows: BlockRow[] = []
    for (const projection of this.displayProjections.values('blockRows')) {
      rows.push(...projection.value)
    }

    return rows
  }

  private applyBlockLanesProjection(lanes: readonly BlockLane[]): void {
    this.setBlockLanesProjection(lanes)
    this.view.setBlockLanes(this.composedBlockLanes())
  }

  private setBlockLanesProjection(lanes: readonly BlockLane[]): void {
    if (lanes.length === 0) {
      this.displayProjections.delete('blockLanes', PLUGIN_BLOCK_LANES_PROJECTION_OWNER)
      return
    }

    this.displayProjections.set({
      kind: 'blockLanes',
      owner: PLUGIN_BLOCK_LANES_PROJECTION_OWNER,
      source: this.currentDisplayProjectionSource(),
      invalidationRange: FULL_DISPLAY_PROJECTION_INVALIDATION,
      layer: 0,
      priority: 0,
      disposal: NO_DISPLAY_PROJECTION_DISPOSAL,
      value: [...lanes],
    })
  }

  private composedBlockLanes(): readonly BlockLane[] {
    const lanes: BlockLane[] = []
    for (const projection of this.displayProjections.values('blockLanes')) {
      lanes.push(...projection.value)
    }

    return lanes
  }

  private setSyntaxFoldProjection(folds: readonly FoldRange[]): boolean {
    const result = rejectNestedOrOverlappingFoldRanges(folds)
    if (result.rejected.length > 0) this.logRejectedSyntaxFoldProjection(result.rejected)

    const acceptedFolds = result.folds
    if (foldRangesEqual(this.syntaxFoldProjection(), acceptedFolds)) return false
    if (acceptedFolds.length === 0) {
      return this.displayProjections.delete('folds', SYNTAX_FOLD_PROJECTION_OWNER)
    }

    this.displayProjections.set({
      kind: 'folds',
      owner: SYNTAX_FOLD_PROJECTION_OWNER,
      source: this.currentDisplayProjectionSource(),
      invalidationRange: FULL_DISPLAY_PROJECTION_INVALIDATION,
      layer: 0,
      priority: 0,
      disposal: NO_DISPLAY_PROJECTION_DISPOSAL,
      value: [...acceptedFolds],
    })
    return true
  }

  private logRejectedSyntaxFoldProjection(rejected: readonly FoldRangeRejection[]): void {
    const first = rejected[0]
    if (!first) return

    this.lifecycleSummary.folds.syntaxRejectedCount += rejected.length
    if (this.lifecycleSummary.folds.firstSyntaxRejection) return

    this.lifecycleSummary.folds.firstSyntaxRejection = {
      message: 'Rejected invalid syntax fold projection ranges',
      syntax: {
        firstRejectedFold: foldLogContext(first.fold),
        previousFold: first.previous ? foldLogContext(first.previous) : null,
        reason: first.kind,
        rejectedFoldCount: rejected.length,
      },
    }
  }

  private syntaxFoldProjection(): readonly FoldRange[] {
    return this.displayProjections.get('folds', SYNTAX_FOLD_PROJECTION_OWNER)?.value ?? []
  }

  private foldProjections(): readonly EditorDisplayProjection<'folds'>[] {
    return this.displayProjections.values('folds')
  }

  private syncFoldStateFromProjections(): void {
    this.foldState.setFoldProjections(this.foldProjections())
  }

  private handleInjectedTextRowProvidersChanged(): void {
    if (!this.syncInjectedTextRows()) return

    this.notifyViewContributions('layout', null)
    this.inputSelection.syncDomSelection()
    this.log({
      action: 'editor.plugins.injected_rows.changed',
      level: 'info',
      plugins: {
        injectedTextRowProviderCount: this.pluginHost.getInjectedTextRowProviders().length,
        rowCount: this.appliedInjectedTextRows.length,
      },
    })
  }

  private syncInjectedTextRows(): boolean {
    const rows = this.injectedTextRowsForProviders()
    if (!this.setInjectedRowsProjection(rows)) return false

    this.appliedInjectedTextRows = this.composedInjectedTextRows()
    this.view.setInjectedTextRows(this.appliedInjectedTextRows)
    return true
  }

  private setInjectedRowsProjection(rows: readonly InjectedTextRow[]): boolean {
    if (sameInjectedTextRows(this.pluginInjectedTextRows(), rows)) return false
    if (rows.length === 0) {
      return this.displayProjections.delete('injectedRows', PLUGIN_INJECTED_ROWS_PROJECTION_OWNER)
    }

    this.displayProjections.set({
      kind: 'injectedRows',
      owner: PLUGIN_INJECTED_ROWS_PROJECTION_OWNER,
      source: this.currentDisplayProjectionSource(),
      invalidationRange: FULL_DISPLAY_PROJECTION_INVALIDATION,
      layer: 0,
      priority: 0,
      disposal: NO_DISPLAY_PROJECTION_DISPOSAL,
      value: [...rows],
    })
    return true
  }

  private pluginInjectedTextRows(): readonly InjectedTextRow[] {
    return (
      this.displayProjections.get('injectedRows', PLUGIN_INJECTED_ROWS_PROJECTION_OWNER)?.value ??
      []
    )
  }

  private composedInjectedTextRows(): readonly InjectedTextRow[] {
    const rows: InjectedTextRow[] = []
    for (const projection of this.displayProjections.values('injectedRows')) {
      rows.push(...projection.value)
    }

    return rows
  }

  private injectedTextRowsForProviders(): readonly InjectedTextRow[] {
    const providers = this.pluginHost.getInjectedTextRowProviders()
    if (providers.length === 0) return []

    const context = this.createInjectedTextRowProviderContext()
    const rows: InjectedTextRow[] = []
    for (const provider of providers) rows.push(...provider.getInjectedTextRows(context))
    return rows
  }

  private createInjectedTextRowProviderContext(): EditorInjectedTextRowProviderContext {
    return {
      documentId: this.documentId,
      text: this.materializeFullText(),
      lineCount: this.view.getLineCount(),
    }
  }

  private setSourceRowDecorations(
    sourceId: string,
    decorations: ReadonlyMap<number, VirtualizedTextRowDecoration>,
    owner: symbol,
  ): void {
    if (sourceId.length === 0) return
    this.claimRowDecorationSource(sourceId, owner)

    this.displayProjections.set({
      kind: 'rowDecorations',
      owner: sourceRowDecorationOwner(sourceId),
      source: this.currentDisplayProjectionSource(),
      invalidationRange: FULL_DISPLAY_PROJECTION_INVALIDATION,
      layer: 10,
      priority: 0,
      disposal: NO_DISPLAY_PROJECTION_DISPOSAL,
      value: new Map(decorations),
    })
    this.applyComposedRowDecorations()
  }

  private clearSourceRowDecorations(sourceId: string, owner: symbol): void {
    if (this.rowDecorationSourceOwners.get(sourceId) !== owner) return

    this.releaseRowDecorationSource(sourceId, owner)
    if (!this.displayProjections.delete('rowDecorations', sourceRowDecorationOwner(sourceId)))
      return

    this.applyComposedRowDecorations()
  }

  private claimRowDecorationSource(sourceId: string, owner: symbol): void {
    const currentOwner = this.rowDecorationSourceOwners.get(sourceId)
    if (currentOwner === owner) return
    if (currentOwner)
      throw new Error(`Editor row decoration source already registered: ${sourceId}`)

    this.rowDecorationSourceOwners.set(sourceId, owner)
    let sources = this.rowDecorationSourcesByOwner.get(owner)
    if (!sources) {
      sources = new Set()
      this.rowDecorationSourcesByOwner.set(owner, sources)
    }
    sources.add(sourceId)
  }

  private releaseRowDecorationSource(sourceId: string, owner: symbol): void {
    this.rowDecorationSourceOwners.delete(sourceId)
    const sources = this.rowDecorationSourcesByOwner.get(owner)
    if (!sources) return

    sources.delete(sourceId)
    if (sources.size === 0) this.rowDecorationSourcesByOwner.delete(owner)
  }

  private clearContributionRowDecorationSources(
    contribution: EditorDecorationContribution | EditorFeatureContribution,
  ): void {
    const owner = this.rowDecorationContributionOwners.get(contribution)
    if (!owner) return

    this.rowDecorationContributionOwners.delete(contribution)
    this.clearRowDecorationSourcesForOwner(owner)
  }

  private clearRowDecorationSourcesForOwner(owner: symbol): void {
    const sources = this.rowDecorationSourcesByOwner.get(owner)
    if (!sources) return

    for (const sourceId of Array.from(sources)) this.clearSourceRowDecorations(sourceId, owner)
  }

  private applyComposedRowDecorations(): void {
    this.view.setRowDecorations(this.composedRowDecorations())
    this.view.refreshGutterWidth()
    this.notifyViewContributions('layout', null)
  }

  private composedRowDecorations(): ReadonlyMap<number, VirtualizedTextRowDecoration> {
    const composed = new Map<number, VirtualizedTextRowDecoration>()
    for (const projection of this.displayProjections.values('rowDecorations')) {
      mergeRowDecorationMap(composed, projection.value)
    }

    return composed
  }

  private projectRowDecorationsThroughLineEdit(
    edit: TextEdit,
    previousText: TextSnapshot,
    lineStarts: LineStartsView,
  ): boolean {
    const rowDelta = editLineDelta(edit, previousText)
    if (rowDelta === 0) return false

    const projections = this.displayProjections.values('rowDecorations')
    if (projections.length === 0) return false

    const startRow = lineStarts.indexForOffset(edit.from)
    const endRow = lineStarts.indexForOffset(edit.to)
    const source = this.currentDisplayProjectionSource()
    const invalidationRange = { kind: 'rows' as const, startRow, endRow }
    for (const projection of projections) {
      this.displayProjections.replaceValue(
        'rowDecorations',
        projection.owner,
        projectRowDecorationMapThroughLineEdit(projection.value, startRow, endRow, rowDelta),
        { source, invalidationRange },
      )
    }

    return true
  }

  private createViewContributionContext(container: HTMLElement): EditorViewContributionContext {
    return {
      container,
      scrollElement: this.el,
      highlightPrefix: this.highlightPrefix,
      hasDocument: () => this.session !== null,
      getSnapshot: () => this.createViewSnapshot(),
      getFeature: (key) => this.getFeature(key),
      log: (event) => this.log(event),
      revealLine: (row) => this.view.scrollToRow(row),
      focusEditor: () => this.focus(),
      setSelection: (anchor, head, timingName, revealOffset) =>
        this.inputSelection.applyFindSelection(anchor, head, timingName, revealOffset),
      setSelections: (selections, timingName, revealOffset) =>
        this.inputSelection.applyFindSelections(selections, timingName, revealOffset),
      reserveOverlayWidth: (side, width) => this.reserveOverlayWidth(side, width),
      setScrollTop: (scrollTop) => this.setScrollTop(scrollTop),
      textOffsetFromPoint: (clientX, clientY) =>
        this.inputSelection.textOffsetFromPoint(clientX, clientY),
      getRangeClientRect: (start, end) => this.inputSelection.rangeClientRect(start, end),
      setRangeHighlight: (name, ranges, style) => this.view.setRangeHighlight(name, ranges, style),
      clearRangeHighlight: (name) => this.view.clearRangeHighlight(name),
    }
  }

  private createCommandContributionContext(): EditorCommandContributionContext {
    return {
      registerCommand: (command, handler) => this.registerCommandHandler(command, handler),
    }
  }

  private createCapabilityContributionContext(): EditorCapabilityContributionContext {
    return {
      registerFeature: (key, feature) => this.registerFeature(key, feature),
    }
  }

  private createEditContributionContext(): EditorEditContributionContext {
    return {
      hasDocument: () => this.session !== null,
      log: (event) => this.log(event),
      materializeFullText: () => this.materializeFullText(),
      getTextSnapshot: () => this.session?.getTextSnapshot() ?? null,
      registerFeature: (key, feature) => this.registerFeature(key, feature),
      focusEditor: () => this.focus(),
      applyEdits: (edits, timingName, selection) =>
        this.inputSelection.applyFindEdits(edits, timingName, selection),
    }
  }

  private createDecorationContributionContext(owner: symbol): EditorDecorationContributionContext {
    return {
      hasDocument: () => this.session !== null,
      log: (event) => this.log(event),
      materializeFullText: () => this.materializeFullText(),
      getTextSnapshot: () => this.session?.getTextSnapshot() ?? null,
      setRangeHighlight: (name, ranges, style) => this.view.setRangeHighlight(name, ranges, style),
      clearRangeHighlight: (name) => this.view.clearRangeHighlight(name),
      setRowDecorations: (sourceId, decorations) =>
        this.setSourceRowDecorations(sourceId, decorations, owner),
      clearRowDecorations: (sourceId) => this.clearSourceRowDecorations(sourceId, owner),
    }
  }

  private createEditorFeatureContributionContext(
    container: HTMLElement,
    owner: symbol,
  ): EditorFeatureContributionContext {
    return {
      container,
      scrollElement: this.el,
      highlightPrefix: this.highlightPrefix,
      hasDocument: () => this.session !== null,
      log: (event) => this.log(event),
      materializeFullText: () => this.materializeFullText(),
      getTextSnapshot: () => this.session?.getTextSnapshot() ?? null,
      getSelections: () => this.inputSelection.resolveViewSelections(),
      focusEditor: () => this.focus(),
      setSelection: (anchor, head, timingName, revealOffset) =>
        this.inputSelection.applyFindSelection(anchor, head, timingName, revealOffset),
      setSelections: (selections, timingName, revealOffset) =>
        this.inputSelection.applyFindSelections(selections, timingName, revealOffset),
      applyEdits: (edits, timingName, selection) =>
        this.inputSelection.applyFindEdits(edits, timingName, selection),
      setRangeHighlight: (name, ranges, style) => this.view.setRangeHighlight(name, ranges, style),
      clearRangeHighlight: (name) => this.view.clearRangeHighlight(name),
      setRowDecorations: (sourceId, decorations) =>
        this.setSourceRowDecorations(sourceId, decorations, owner),
      clearRowDecorations: (sourceId) => this.clearSourceRowDecorations(sourceId, owner),
      registerCommand: (command, handler) => this.registerCommandHandler(command, handler),
      registerFeature: (key, feature) => this.registerFeature(key, feature),
    }
  }

  private canEditDocument(): boolean {
    return this.document.canEditDocument()
  }

  private syncViewEditability(): void {
    const editable = this.canEditDocument()
    this.view.setEditable(editable)
    this.inputSelection.syncNativeInputHandlers(editable)
  }

  private applyRangeDecorations(): void {
    const decorations = this.composedRangeDecorations()
    if (this.textSnapshot.length === 0 || decorations.length === 0) {
      this.clearAppliedRangeDecorations()
      return
    }

    const groups = groupedRangeDecorations(decorations, this.highlightPrefix)
    const names: string[] = []

    for (const group of groups) {
      names.push(group.name)
      this.view.setRangeHighlight(group.name, group.ranges, group.style)
    }

    this.clearStaleAppliedRangeDecorations(new Set(names))
    this.appliedRangeDecorationNames = names
  }

  private clearAppliedRangeDecorations(): void {
    for (const name of this.appliedRangeDecorationNames) this.view.clearRangeHighlight(name)
    this.appliedRangeDecorationNames = []
  }

  private clearStaleAppliedRangeDecorations(nextNames: ReadonlySet<string>): void {
    for (const name of this.appliedRangeDecorationNames) {
      if (!nextNames.has(name)) this.view.clearRangeHighlight(name)
    }
  }

  private directRangeDecorations(): readonly EditorRangeDecoration[] {
    return (
      this.displayProjections.get('rangeDecorations', DIRECT_RANGE_DECORATION_OWNER)?.value ?? []
    )
  }

  private composedRangeDecorations(): readonly EditorRangeDecoration[] {
    const decorations: EditorRangeDecoration[] = []
    for (const projection of this.displayProjections.values('rangeDecorations')) {
      decorations.push(...projection.value)
    }

    return decorations
  }

  private retagDisplayProjectionSources(): void {
    const source = this.currentDisplayProjectionSource()
    this.displayProjections.retagKind('folds', source)
    this.displayProjections.retagKind('rangeDecorations', source)
    this.displayProjections.retagKind('rowDecorations', source)
    this.displayProjections.retagKind('blockRows', source)
    this.displayProjections.retagKind('blockLanes', source)
    this.displayProjections.retagKind('injectedRows', source)
    this.displayProjections.retagKind('gutters', source)
  }

  private currentDisplayProjectionSource(): EditorDisplayProjectionSource {
    return {
      documentId: this.documentId,
      documentVersion: this.documentVersion,
      textVersion: this.textVersion,
    }
  }

  private createViewSnapshot(): EditorViewSnapshot {
    const viewState = this.view.getState()
    const textSnapshot = this.textSnapshot
    const viewport = {
      scrollTop: viewState.scrollTop,
      scrollLeft: viewState.scrollLeft,
      scrollHeight: viewState.scrollHeight,
      scrollWidth: viewState.scrollWidth,
      clientHeight: viewState.viewportHeight,
      clientWidth: viewState.viewportWidth,
      borderBoxHeight: viewState.borderBoxHeight,
      borderBoxWidth: viewState.borderBoxWidth,
      visibleRange: viewState.visibleRange,
    }

    // One view per text version: repeat snapshots share the same lazily
    // materialized array instead of rebuilding it.
    const cachedView = this.lineStartsViewCache
    const lineStartsView =
      cachedView && cachedView.textVersion === this.textVersion
        ? cachedView.view
        : this.view.getLineStartsView()
    this.lineStartsViewCache = { textVersion: this.textVersion, view: lineStartsView }
    return defineLazyFullTextProperty({
      documentId: this.documentId,
      languageId: this.languageId,
      theme: this.resolvedTheme(),
      textSnapshot,
      textVersion: this.textVersion,
      editsSinceTextVersion: (textVersion: number) => this.editChain.editsSince(textVersion),
      // Materializing per snapshot costs O(lines) on every keystroke for
      // large documents; consumers that need the array pay lazily instead.
      get lineStarts() {
        return lineStartsView.toArray()
      },
      lineStartsView,
      tokens: this.tokens,
      selections: this.inputSelection.resolveViewSelections(),
      metrics: viewState.metrics,
      lineCount: viewState.lineCount,
      contentWidth: viewState.contentWidth,
      totalHeight: viewState.totalHeight,
      tabSize: viewState.tabSize,
      foldMarkers: viewState.foldMarkers,
      visibleRows: viewState.mountedRows.map((row) => ({
        index: row.index,
        bufferRow: row.bufferRow,
        source: row.source,
        injectedTextRowId: row.injectedTextRowId,
        metadata: row.metadata,
        startOffset: row.startOffset,
        endOffset: row.endOffset,
        text: row.text,
        kind: row.kind,
        primaryText: row.source === 'document' && row.displayKind === 'text',
        top: row.top,
        height: row.height,
      })),
      viewport,
    })
  }

  private notifyViewContributions(
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void {
    if (!this.viewContributions) return

    this.viewContributions.notify(kind, change ?? null)
  }

  private notifyEditorFeatureContributions(change: DocumentSessionChange | null): void {
    for (const contribution of Array.from(this.decorationContributions))
      this.notifyContributionChange(contribution, change, 'decoration')

    for (const contribution of Array.from(this.editorFeatureContributions))
      this.notifyContributionChange(contribution, change, 'feature')
  }

  private notifyContributionChange(
    contribution: EditorDecorationContribution | EditorFeatureContribution,
    change: DocumentSessionChange | null,
    kind: 'decoration' | 'feature',
  ): void {
    try {
      contribution.handleEditorChange?.(change)
    } catch (error) {
      this.removeFailedEditorContribution(contribution, kind, error)
    }
  }

  private removeFailedEditorContribution(
    contribution: EditorDecorationContribution | EditorFeatureContribution,
    kind: 'decoration' | 'feature',
    error: unknown,
  ): void {
    this.logContributionFailure(kind, 'update', error)
    if (kind === 'decoration') {
      this.removeFailedDecorationContribution(contribution as EditorDecorationContribution)
      return
    }

    this.removeFailedFeatureContribution(contribution as EditorFeatureContribution)
  }

  private removeFailedDecorationContribution(contribution: EditorDecorationContribution): void {
    removeArrayItem(this.decorationContributions, contribution)
    deleteMapValue(this.decorationContributionsByProvider, contribution)
    this.disposeContributionSafely(contribution, 'decoration')
    this.clearContributionRowDecorationSources(contribution)
  }

  private removeFailedFeatureContribution(contribution: EditorFeatureContribution): void {
    removeArrayItem(this.editorFeatureContributions, contribution)
    deleteMapValue(this.editorFeatureContributionsByProvider, contribution)
    this.disposeContributionSafely(contribution, 'feature')
    this.clearContributionRowDecorationSources(contribution)
  }

  private registerCommandHandler(
    command: EditorCommandId,
    handler: EditorCommandHandler,
  ): EditorDisposable {
    return this.commandRouter.registerCommandHandler(command, handler)
  }

  private registerFeature<T>(token: EditorCapabilityToken<T>, feature: T): EditorDisposable {
    if (this.editorFeatureTokensById.has(token.id)) {
      throw new Error(`Editor feature already registered: ${token.id}`)
    }

    this.editorFeatures.set(token, feature)
    this.editorFeatureTokensById.set(token.id, token)

    return disposableOnce(() => this.unregisterFeature(token, feature))
  }

  private unregisterFeature<T>(token: EditorCapabilityToken<T>, feature: T): void {
    if (this.editorFeatures.get(token) !== feature) return

    this.editorFeatures.delete(token)
    this.editorFeatureTokensById.delete(token.id)
  }

  private getFeature<T>(token: EditorCapabilityToken<T>): T | null {
    if (this.editorFeatures.has(token)) {
      return (this.editorFeatures.get(token) as T | undefined) ?? null
    }

    const registeredToken = this.editorFeatureTokensById.get(token.id)
    if (!registeredToken) return null

    return (this.editorFeatures.get(registeredToken) as T | undefined) ?? null
  }

  private findFeature(): EditorFindFeature | null {
    return this.getFeature(EDITOR_FIND_FEATURE)
  }

  private reserveOverlayWidth(side: EditorOverlaySide, width: number): void {
    if (!this.view.reserveOverlayWidth(side, width)) return

    this.notifyViewContributions('layout', null)
  }

  private setScrollTop(scrollTop: number): void {
    this.applyScrollPosition({
      top: scrollTop,
      left: this.view.getState().scrollLeft,
    })
  }

  private readonly handleViewportChange = (): void => {
    this.updateSyntaxScrollTracking()
    const visibleRange = this.visibleSyntaxRange()
    this.syntax.refreshVisibleRange(this.documentVersion, {
      delayMs: 0,
      range: visibleRange,
    })
    this.syntax.prefetchVisibleRange(this.documentVersion, this.visibleSyntaxPrefetchRange(), {
      delayMs: VISIBLE_SYNTAX_SCROLL_DELAY_MS,
    })
    this.syntax.warmSyntaxAroundRange(this.documentVersion, visibleRange, {
      delayMs: BACKGROUND_SYNTAX_WARM_DELAY_MS,
    })
    this.notifyViewContributions('viewport', null)
    this.log({
      action: 'editor.viewport.changed',
      level: 'debug',
      syntax: {
        visibleRange,
      },
      viewport: this.viewportLogContext(),
    })
  }

  private visibleSyntaxRange(): EditorSyntaxRange | null {
    return this.syntaxRangeAroundMountedRows(
      VISIBLE_SYNTAX_OVERSCAN_CHARS,
      VISIBLE_SYNTAX_OVERSCAN_CHARS,
    )
  }

  private visibleSyntaxPrefetchRange(): EditorSyntaxRange | null {
    const viewState = this.view.getState()
    const rows = viewState.mountedRows
    const first = rows[0]
    const last = rows.at(-1)
    if (!first || !last) return null

    const lead = this.visibleSyntaxLeadChars(first, last)
    const before = this.syntaxScrollDirection <= 0 ? lead : VISIBLE_SYNTAX_TRAILING_CHARS
    const after = this.syntaxScrollDirection >= 0 ? lead : VISIBLE_SYNTAX_TRAILING_CHARS

    return this.syntaxRangeAroundMountedRows(before, after)
  }

  private syntaxRangeAroundMountedRows(before: number, after: number): EditorSyntaxRange | null {
    const rows = this.view.getState().mountedRows
    const first = rows[0]
    const last = rows.at(-1)
    if (!first || !last) return null

    return {
      startIndex: Math.max(0, first.startOffset - before),
      endIndex: Math.min(this.textSnapshot.length, last.endOffset + after),
    }
  }

  private updateSyntaxScrollTracking(): void {
    const scrollTop = this.view.getState().scrollTop
    const previousScrollTop = this.lastSyntaxScrollTop
    this.lastSyntaxScrollTop = scrollTop
    if (previousScrollTop === null) {
      this.syntaxScrollDeltaPx = 0
      this.syntaxScrollDirection = 0
      return
    }

    const delta = scrollTop - previousScrollTop
    this.syntaxScrollDeltaPx = Math.abs(delta)
    this.syntaxScrollDirection = syntaxScrollDirection(delta)
  }

  private visibleSyntaxLeadChars(
    first: { readonly startOffset: number; readonly top: number },
    last: { readonly endOffset: number; readonly top: number; readonly height: number },
  ): number {
    const textSpan = Math.max(1, last.endOffset - first.startOffset)
    const pixelSpan = Math.max(1, last.top + last.height - first.top)
    const velocityLead = Math.ceil(this.syntaxScrollDeltaPx * (textSpan / pixelSpan) * 2)
    return clamp(
      Math.max(VISIBLE_SYNTAX_LEAD_CHARS, velocityLead),
      VISIBLE_SYNTAX_LEAD_CHARS,
      Math.min(VISIBLE_SYNTAX_MAX_LEAD_CHARS, this.textSnapshot.length),
    )
  }

  private applySessionChange(
    change: DocumentSessionChange,
    totalName = 'editor.change',
    totalStart = nowMs(),
    options: SessionChangeOptions = {},
  ): void {
    this.syntax.projectCacheForChange(change)
    let timedChange = change
    const renderStart = nowMs()
    measureEditorPerformance('editor.renderSessionChange', () => this.renderSessionChange(change))
    timedChange = appendTiming(timedChange, 'editor.render', renderStart)

    if (options.revealOffset !== undefined) {
      const revealStart = nowMs()
      this.view.revealOffset(options.revealOffset, options.revealBlock)
      timedChange = appendTiming(timedChange, 'editor.reveal', revealStart)
    }

    if (options.syncDomSelection !== false) {
      const selectionStart = nowMs()
      this.inputSelection.syncDomSelection()
      timedChange = appendTiming(timedChange, 'editor.syncDomSelection', selectionStart)
    }
    const finalChange = appendTiming(timedChange, totalName, totalStart)
    this.sessionOptions.onChange?.(finalChange)
    measureEditorPerformance('editor.notifyViewContributions', () =>
      this.notifyViewContributions(viewContributionKindForChange(finalChange), finalChange),
    )
    measureEditorPerformance('editor.notifyChangeWithTiming', () =>
      this.notifyChangeWithTiming(finalChange),
    )
    this.logSessionChange(finalChange, totalName)
    this.sessionChangeVersion += 1
    this.scheduleSecondarySessionChangeWork(finalChange, totalName, this.sessionChangeVersion)
  }

  private renderSessionChange(change: DocumentSessionChange): void {
    const edit = change.edits[0]
    if (change.kind === 'selection' || change.kind === 'none') return

    if (edit && change.edits.length === 1) {
      const previousTextSnapshot = this.textSnapshot
      const syntaxFolds = this.syntaxFoldProjection()
      const foldProjection = measureEditorPerformance(
        'editor.projectSyntaxFolds',
        () => projectSyntaxFoldsThroughLineEdit(syntaxFolds, edit, previousTextSnapshot),
        () => ({ foldCount: syntaxFolds.length }),
      )
      const projectedTokens = measureEditorPerformance(
        'editor.projectTokens',
        () => projectTokensThroughEdit(this.tokens, edit, previousTextSnapshot),
        () => ({ tokenCount: this.tokens.length }),
      )
      const rowDecorationsProjected = this.projectRowDecorationsThroughLineEdit(
        edit,
        previousTextSnapshot,
        this.view.getLineStartsView(),
      )
      this.applyEdit(edit, projectedTokens, documentSessionChangeTextSnapshot(change))
      this.applySyntaxFoldProjection(foldProjection)
      if (rowDecorationsProjected) this.view.setRowDecorations(this.composedRowDecorations())
      return
    }

    this.clearSyntaxFolds()
    this.setDocument({ text: change.textSnapshot.materializeFullText(), tokens: [] })
  }

  private applySyntaxFoldProjection(projection: SyntaxFoldProjection | null): void {
    if (!projection) return

    this.setSyntaxFoldProjection(projection.folds)
    this.foldState.applyProjectedEdit(projection, this.foldProjections())
  }

  private logSessionChange(change: DocumentSessionChange, timingName: string): void {
    this.log({
      action: 'editor.session.changed',
      level: sessionChangeLogLevel(change),
      change: {
        canRedo: change.canRedo,
        canUndo: change.canUndo,
        editCount: change.edits.length,
        edits: summarizeTextEdits(change.edits),
        isDirty: change.isDirty,
        kind: change.kind,
        selectionCount: change.selections.selections.length,
        textLength: change.snapshot.length,
        timingName,
        timings: change.timings,
        transaction: change.transaction
          ? {
              intent: change.transaction.metadata.intent,
              source: change.transaction.metadata.source,
              undoGroup: change.transaction.metadata.undoGroup ?? null,
            }
          : null,
      },
    })
  }

  private viewportLogContext(): Record<string, unknown> {
    const viewState = this.view.getState()
    return {
      clientHeight: viewState.viewportHeight,
      clientWidth: viewState.viewportWidth,
      contentWidth: viewState.contentWidth,
      lineCount: viewState.lineCount,
      mountedRowCount: viewState.mountedRows.length,
      scrollHeight: viewState.scrollHeight,
      scrollLeft: viewState.scrollLeft,
      scrollTop: viewState.scrollTop,
      scrollWidth: viewState.scrollWidth,
      totalHeight: viewState.totalHeight,
      visibleRange: viewState.visibleRange,
    }
  }

  private legacyEditTextSnapshot(edit: TextEdit): TextSnapshot {
    const currentText = this.text
    return createStringTextSnapshot(
      `${currentText.slice(0, edit.from)}${edit.text}${currentText.slice(edit.to)}`,
    )
  }

  private notifyChange(change: DocumentSessionChange | null): void {
    this.notifyEditorFeatureContributions(change)
    this.options.onChange?.(this.getState(), change)
  }

  private notifyChangeWithTiming(change: DocumentSessionChange): void {
    const notifyStart = nowMs()
    const state = this.getState()
    const timedChange = appendTiming(change, 'editor.notify', notifyStart)
    this.options.onChange?.(state, timedChange)
  }

  private refreshSyntax(
    documentVersion: number,
    change: DocumentSessionChange | null,
    options: { readonly delayMs?: number } = {},
  ): void {
    this.syntax.refresh(documentVersion, change, options)
  }

  private scheduleSecondarySessionChangeWork(
    change: DocumentSessionChange,
    timingName: string,
    sessionChangeVersion: number,
  ): void {
    const documentVersion = this.documentVersion
    if (!this.shouldDeferSecondarySessionWork(change, timingName)) {
      this.runSecondarySessionChangeWork(documentVersion, change)
      return
    }

    this.secondaryWork.schedule({
      key: 'editor.syntaxRefresh',
      delayMs: RAPID_INPUT_SECONDARY_WORK_DELAY_MS,
      version: sessionChangeVersion,
      isCurrent: (version) => version === this.sessionChangeVersion,
      run: () =>
        measureEditorPerformance('editor.refreshSyntax', () =>
          this.refreshSyntax(documentVersion, change, { delayMs: 0 }),
        ),
    })
    this.secondaryWork.schedule({
      key: 'editor.featureContributions',
      delayMs: RAPID_INPUT_SECONDARY_WORK_DELAY_MS,
      version: sessionChangeVersion,
      isCurrent: (version) => version === this.sessionChangeVersion,
      run: () =>
        measureEditorPerformance('editor.notifyEditorFeatureContributions', () =>
          this.notifyEditorFeatureContributions(change),
        ),
    })
  }

  private runSecondarySessionChangeWork(
    documentVersion: number,
    change: DocumentSessionChange,
  ): void {
    measureEditorPerformance('editor.refreshSyntax', () =>
      this.refreshSyntax(documentVersion, change),
    )
    measureEditorPerformance('editor.notifyEditorFeatureContributions', () =>
      this.notifyEditorFeatureContributions(change),
    )
  }

  private shouldDeferSecondarySessionWork(
    change: DocumentSessionChange,
    timingName: string,
  ): boolean {
    if (change.kind === 'selection' || change.kind === 'none') return false
    return RAPID_INPUT_TIMING_NAMES.has(timingName)
  }

  private handleFoldToggle = (marker: VirtualizedFoldMarker): void => {
    if (!this.foldState.toggle(marker)) return

    this.notifyViewContributions('layout', null)
    this.log({
      action: 'editor.fold.toggled',
      level: 'info',
      fold: foldLogContext(marker),
    })
  }

  private applyFoldOperation(operation: FoldOperation, offset?: number): boolean {
    const location = this.foldLocation(offset)
    if (!location) return false

    const fold = foldCandidateAtLocation(
      this.foldState.folds,
      location.row,
      location.offset,
      (candidate) => this.foldState.isCollapsed(candidate),
      operation,
    )
    if (!fold) return false

    const changed = this.applyFoldStateChange(operation, fold)
    if (changed) {
      this.notifyViewContributions('layout', null)
      this.log({
        action: `editor.fold.${operation}`,
        level: 'info',
        fold: foldLogContext(fold),
      })
    }
    return changed
  }

  private foldLocation(offset?: number): { readonly offset: number; readonly row: number } | null {
    const snapshot = this.session?.getSnapshot()
    if (!snapshot) return null

    const locationOffset = clamp(
      offset ?? this.primarySelectionHeadOffsetFromSession(),
      0,
      snapshot.length,
    )
    return {
      offset: locationOffset,
      row: offsetToPoint(snapshot, locationOffset).row,
    }
  }

  private primarySelectionHeadOffsetFromSession(): number {
    const snapshot = this.session?.getSnapshot()
    const selection = this.session?.getSelections().selections[0]
    if (!snapshot || !selection) return this.materializeFullText().length

    return resolveSelection(snapshot, selection).headOffset
  }

  private applyFoldStateChange(operation: FoldOperation, fold: FoldRange): boolean {
    if (operation === 'fold') return this.foldState.fold(fold)
    if (operation === 'unfold') return this.foldState.unfold(fold)
    return this.foldState.toggleFold(fold)
  }

  private clearSyntaxFolds(): void {
    this.displayProjections.delete('folds', SYNTAX_FOLD_PROJECTION_OWNER)
    this.foldState.clear()
  }

  private applyResolvedTheme(): void {
    this.view.setTheme(this.resolvedTheme())
  }

  private resolvedTheme(): EditorTheme | null {
    return mergeEditorThemes(this.syntax.providerTheme, this.syntax.theme, this.configuredTheme)
  }
}

function createEditorLifecycleSummary(): EditorLifecycleSummary {
  return {
    pluginNames: new Set<string>(),
    plugin: {
      activatedCount: 0,
      deactivatedCount: 0,
      disposedCount: 0,
      failedCount: 0,
      installedCount: 0,
      slowestActivationMs: null,
      updatedCount: 0,
    },
    folds: {
      firstSyntaxRejection: null,
      syntaxRejectedCount: 0,
    },
    syntax: {
      refreshScheduledCount: 0,
    },
    document: {
      attachedCount: 0,
      clearedCount: 0,
      detachedCount: 0,
      openedCount: 0,
      setTextCount: 0,
      startedCount: 0,
      syncedTextCount: 0,
    },
    content: {
      setCount: 0,
    },
    mountDurationMs: null,
    mountedAt: null,
    disposingAt: null,
  }
}

function mergeRowDecorationMap(
  target: Map<number, VirtualizedTextRowDecoration>,
  source: ReadonlyMap<number, VirtualizedTextRowDecoration>,
): void {
  for (const [row, decoration] of source) {
    target.set(row, mergeRowDecoration(target.get(row), decoration))
  }
}

function sourceRowDecorationOwner(sourceId: string): string {
  return `${FEATURE_ROW_DECORATION_OWNER_PREFIX}${sourceId}`
}

function projectRowDecorationMapThroughLineEdit(
  source: ReadonlyMap<number, VirtualizedTextRowDecoration>,
  startRow: number,
  endRow: number,
  rowDelta: number,
): Map<number, VirtualizedTextRowDecoration> {
  const projected = new Map<number, VirtualizedTextRowDecoration>()
  for (const [row, decoration] of source) {
    if (row < startRow) {
      projected.set(row, decoration)
      continue
    }

    if (row === startRow) {
      projected.set(row, decoration)
      continue
    }

    if (row > endRow) projected.set(Math.max(0, row + rowDelta), decoration)
  }

  return projected
}

function editLineDelta(edit: TextEdit, previousText: TextSnapshot): number {
  return countLineBreaks(edit.text) - countLineBreaks(previousText.readRange(edit.from, edit.to))
}

function countLineBreaks(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') count += 1
  }
  return count
}

function syntaxScrollDirection(delta: number): SyntaxScrollDirection {
  if (delta > 0) return 1
  if (delta < 0) return -1
  return 0
}

function sessionChangeLogLevel(change: DocumentSessionChange): 'debug' | 'info' {
  if (change.kind === 'selection' || change.kind === 'none') return 'debug'
  return 'info'
}

function summarizeTextEdits(edits: readonly TextEdit[]): readonly Record<string, number>[] {
  return edits.map((edit) => ({
    from: edit.from,
    insertedLength: edit.text.length,
    removedLength: edit.to - edit.from,
    to: edit.to,
  }))
}

function foldLogContext(fold: FoldRange | VirtualizedFoldMarker): Record<string, unknown> {
  if ('startOffset' in fold) {
    return {
      collapsed: fold.collapsed,
      endIndex: fold.endOffset,
      endLine: fold.endRow,
      startIndex: fold.startOffset,
      startLine: fold.startRow,
    }
  }

  return {
    endIndex: fold.endIndex,
    endLine: fold.endLine,
    startIndex: fold.startIndex,
    startLine: fold.startLine,
  }
}

function editorLogError(error: unknown): EditorLogError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    }
  }

  return { message: String(error) }
}

function editorContributionFailureAction(phase: EditorContributionFailurePhase): string {
  if (phase === 'factory') return 'editor.contribution.factory_failed'
  if (phase === 'dispose') return 'editor.contribution.dispose_failed'
  return 'editor.contribution.update_failed'
}

function deleteMapValue<Key, Value>(map: Map<Key, Value>, value: Value): void {
  for (const [key, entry] of map) {
    if (entry !== value) continue

    map.delete(key)
    return
  }
}

function sameInjectedTextRows(
  left: readonly InjectedTextRow[],
  right: readonly InjectedTextRow[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((row, index) => row === right[index])
}

function sameGutterContributions(
  left: readonly EditorGutterContribution[],
  right: readonly EditorGutterContribution[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((contribution, index) => contribution === right[index])
}

function mergeRowDecoration(
  base: VirtualizedTextRowDecoration | undefined,
  next: VirtualizedTextRowDecoration,
): VirtualizedTextRowDecoration {
  if (!base) return next

  return {
    className: joinClassNames(base.className, next.className),
    gutterClassName: joinClassNames(base.gutterClassName, next.gutterClassName),
  }
}

function joinClassNames(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right
  if (!right) return left
  return `${left} ${right}`
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
