import type { EditorCommandId } from '@singapor/core/editor'
import type { DocumentSessionChange } from '@singapor/core/document'
import type {
  EditorCapabilityToken,
  EditorCommandContributionContext,
  EditorDisposable,
  EditorEditContribution,
  EditorEditContributionContext,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import type { LspClient, LspNotificationHandler } from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

import {
  LANGUAGE_SERVER_COMPLETION_EDIT_FEATURE,
  createCompletionEditFeature,
  type LanguageServerCompletionEditFeature,
} from './completion'
import { anchoredSurfaceFollowsUpdate } from './anchoredSurface'
import { CodeActionController } from './codeActions'
import type { OffsetRange } from './definitionNavigation'
import { CompletionController } from './completionController'
import {
  createLanguageServerCompletionSource,
  LanguageServerCompletionSources,
} from './completionProviders'
import { CompositeDiagnosticsPresenter, DiagnosticsPresenter } from './diagnosticsPresenter'
import { activeDocumentForSnapshot, DocumentSync } from './documentSync'
import { FormatOnTypeController } from './formatOnType'
import { HoverDefinitionController } from './hoverDefinitionController'
import { SignatureHelpController } from './signatureHelpController'
import { DocumentHighlightController } from './documentHighlightController'
import {
  SemanticTokenLayerOwner,
  type LanguageServerSemanticTokensFactory,
  type LanguageServerSemanticTokensOptions,
  type LanguageServerSemanticTokensOwnerOptions,
} from './semanticTokens'
import { createRenameWidgetController, type RenameWidgetController } from './renameWidget'
import { parseWorkspaceEdit } from './workspaceEdit'
import { wordRangeAtOffset } from '@singapor/core/internal'
import { lspPositionToOffset, offsetToLspPosition } from '@singapor/lsp'
import type { LspConnectionProvider, LspConnectionTransportFactory } from './lspConnection'
import {
  acquireResolvedLanguageServerLane,
  resolveLanguageServerLaneOptions,
  type LanguageServerResolvedLaneOptions,
} from './lane'
import {
  allLanguageServerFeatures,
  captureWorkspaceEditOriginGuard,
  LanguageServerSet,
  rankedLanguageServerLanes,
  type LanguageServerSetLane,
} from './serverSet'
import type {
  ActiveDocument,
  DiagnosticMarkerDirection,
  LanguageServerNavigationCommand,
} from './pluginTypes'
import { PullDiagnosticsController } from './pullDiagnostics'
import { formattingChangesText, formattingOptions, prepareFormattingEdits } from './formatting'
import type { TextEdit } from '@singapor/core'
import type {
  LanguageServerConnectionContext,
  LanguageServerDefinitionTarget,
  LanguageServerDiagnosticSummary,
  LanguageServerDocumentSyncOptions,
  LanguageServerNavigationOptions,
  LanguageServerPlugin,
  LanguageServerLaneOptions,
  LanguageServerLaneHostOptions,
  LanguageServerPluginOptions,
  LanguageServerRenamePrompt,
  LanguageServerSetPluginOptions,
  LanguageServerReferencesResult,
  LanguageServerStatus,
  WorkspaceEditOriginGuard,
  WorkspaceTextDocumentProvenance,
} from './types'
// Re-exported so `@singapor/lsp-plugin` keeps handing this out from where it always did; it is
// defined in `types.ts` because the narrow factory's options need it and a shared vocabulary module
// that imports the module consuming it is a cycle.
export type { LanguageServerConnectionContext } from './types'

export type { LanguageServerResolvedOptions } from './pluginTypes'

const DEFAULT_PLUGIN_NAME = 'editor.lsp-plugin'
const DEFAULT_HIGHLIGHT_PREFIX = 'editor-lsp-plugin'
const DEFAULT_NAMESPACE = 'lsp-plugin'
const DEFAULT_TIMING_PREFIX = 'lspPlugin'
const DEFAULT_DIAGNOSTICS_SOURCE_ID = 'editor.lsp-plugin.diagnostics'
const DEFAULT_COMPLETION_ACCEPT_TIMING_NAME = 'lspPlugin.completion.accept'

export type LanguageServerCommandTarget = {
  goToDefinitionFromSelection(): boolean
  runNavigationCommand(command: LanguageServerNavigationCommand): boolean
  showHover(): boolean
  moveDiagnosticMarker(direction: DiagnosticMarkerDirection): boolean
  formatDocument(): boolean
  renameSymbol(): boolean
  applyAutoFix(): boolean
}

export type LanguageServerCommandSpec = {
  readonly id: EditorCommandId
  run(target: LanguageServerCommandTarget): boolean
}

export type LanguageServerAdapterPluginOptions = LanguageServerLaneHostOptions & {
  readonly name: string
  /**
   * Asks the host for a new symbol name. Supply this to use the application's own dialog; without
   * it the editor shows its own small input at the symbol.
   */
  readonly onRequestRenameName?: (prompt: LanguageServerRenamePrompt) => Promise<string | null>
  readonly rootUri?: lsp.DocumentUri | null
  readonly hoverMarkdownCodeBackground?: boolean
  readonly initializationOptions?: unknown
  readonly timeoutMs?: number
  /** See LanguageServerPluginOptions.capabilities. */
  readonly capabilities?: lsp.ClientCapabilities
  /** See LanguageServerPluginOptions.clientInfo. */
  readonly clientInfo?: lsp.InitializeParams['clientInfo']
  /** See LanguageServerPluginOptions.notificationHandlers. Merged, never replacing. */
  readonly notificationHandlers?: Readonly<Record<string, LspNotificationHandler<LspClient>>>
  createTransport(): ReturnType<LspConnectionTransportFactory>
  /** Borrows the connection instead of constructing one per view. See LspConnectionProvider. */
  readonly connectionProvider?: LspConnectionProvider
  readonly defaultHighlightPrefix?: string
  readonly documentSync?: LanguageServerDocumentSyncOptions
  readonly diagnostics?: {
    readonly minimapSourceId?: string
    readonly highlightNameNamespace?: string
    readonly markerTimingNamePrefix?: string
  }
  readonly completion?: {
    readonly editFeature?: EditorCapabilityToken<LanguageServerCompletionEditFeature>
    readonly acceptTimingName?: string
    readonly widgetClassNamespace?: string
    /**
     * Accepts the focused suggestion when one of the characters the item declares as committing it is
     * typed, inserting that character too. Off by default: a server whose sets are wrong turns
     * ordinary typing into unwanted completions, which is worse than no shortcut at all.
     */
    readonly acceptOnCommitCharacter?: boolean
  }
  /**
   * Corrects the caret's row as a block-closing delimiter is typed. On by default: without it every
   * closed block is left a level too deep, and the correction is the language's own indentation
   * rules applied to one row, not a formatter deciding how the file should look.
   */
  readonly formatOnType?: boolean
  readonly hoverDefinition?: {
    readonly linkHighlightNameNamespace?: string
    readonly tooltipClassNamespace?: string
    readonly navigationTimingNamePrefix?: string
  }
  readonly commands?: readonly LanguageServerCommandSpec[]
  /**
   * Turns on the semantic token layer. Supplying nothing here creates no layer and fires no demand
   * signal, so a host that paints no semantic colour pays nothing for the feature existing.
   */
  readonly semanticTokens?: LanguageServerSemanticTokensOptions
  onConnectionCreated?(context: LanguageServerConnectionContext): EditorDisposable | void
  onConnected?(context: LanguageServerConnectionContext): void
  readonly onStatusChange?: (status: LanguageServerStatus) => void
  readonly onDiagnostics?: (summary: LanguageServerDiagnosticSummary) => void
  readonly onInteractiveReady?: () => void
  readonly onRequestError?: (serverId: string, method: string, error: unknown) => void
  readonly onOpenDefinition?: (
    target: LanguageServerDefinitionTarget,
    options?: LanguageServerNavigationOptions,
  ) => void | boolean
  readonly onOpenReferences?: (result: LanguageServerReferencesResult) => void | boolean
  readonly onError?: (error: unknown) => void
}

type LanguageServerResolvedAdapterOptions = {
  readonly name: string
  readonly onRequestRenameName?: (prompt: LanguageServerRenamePrompt) => Promise<string | null>
  readonly hoverMarkdownCodeBackground: boolean
  readonly lanes: readonly LanguageServerResolvedLaneOptions[]
  readonly defaultHighlightPrefix: string
  readonly documentSync: LanguageServerDocumentSyncOptions
  readonly diagnostics: {
    readonly minimapSourceId: string
    readonly highlightNameNamespace: string
    readonly markerTimingNamePrefix: string
  }
  readonly completion: {
    readonly editFeature: EditorCapabilityToken<LanguageServerCompletionEditFeature>
    readonly acceptTimingName: string
    readonly widgetClassNamespace?: string
    readonly acceptOnCommitCharacter: boolean
  }
  readonly formatOnType: boolean
  readonly hoverDefinition: {
    readonly linkHighlightNameNamespace: string
    readonly tooltipClassNamespace: string
    readonly navigationTimingNamePrefix: string
  }
  readonly commands: readonly LanguageServerCommandSpec[]
  readonly semanticTokens?: LanguageServerSemanticTokensFactory
  readonly onDiagnostics?: (summary: LanguageServerDiagnosticSummary) => void
  readonly onInteractiveReady?: () => void
  readonly onRequestError?: (serverId: string, method: string, error: unknown) => void
  readonly onApplyWorkspaceEdit?: LanguageServerLaneHostOptions['onApplyWorkspaceEdit']
  readonly onOpenDefinition?: (
    target: LanguageServerDefinitionTarget,
    options?: LanguageServerNavigationOptions,
  ) => void | boolean
  readonly onOpenReferences?: (result: LanguageServerReferencesResult) => void | boolean
  readonly onError?: (error: unknown) => void
}

export function createLanguageServerPlugin(
  options: LanguageServerPluginOptions,
): LanguageServerPlugin {
  return createLanguageServerSetPlugin({
    hoverMarkdownCodeBackground: options.hoverMarkdownCodeBackground,
    lanes: [languageServerLaneFromPluginOptions(options)],
    onApplyWorkspaceEdit: options.onApplyWorkspaceEdit,
    documentSync: options.documentSync,
    semanticTokens: options.semanticTokens ? () => options.semanticTokens! : undefined,
    onDiagnostics: options.onDiagnostics,
    onOpenDefinition: options.onOpenDefinition,
    onOpenReferences: options.onOpenReferences,
    onRequestError: options.onRequestError,
    onError: options.onError,
  })
}

export function createLanguageServerSetPlugin(
  options: LanguageServerSetPluginOptions,
): LanguageServerPlugin {
  return createResolvedLanguageServerPlugin(resolveLanguageServerSetOptions(options))
}

export function createLanguageServerAdapterPlugin(
  options: LanguageServerAdapterPluginOptions,
): LanguageServerPlugin {
  return createResolvedLanguageServerPlugin(resolveAdapterOptions(options))
}

function createResolvedLanguageServerPlugin(
  resolved: LanguageServerResolvedAdapterOptions,
): LanguageServerPlugin {
  const state = new LanguageServerPluginState()

  return {
    name: resolved.name,
    activate(context) {
      return [
        context.registerViewContribution({
          createContribution: (contributionContext) =>
            new LanguageServerContribution(contributionContext, state, resolved),
        }),
        context.registerCommandContribution({
          createContribution: (contributionContext) =>
            new LanguageServerCommandContribution(contributionContext, state, resolved.commands),
        }),
        context.registerEditContribution({
          createContribution: (contributionContext) =>
            new LanguageServerCompletionEditContribution(contributionContext, resolved.completion),
        }),
      ]
    },
  }
}

class LanguageServerPluginState implements LanguageServerCommandTarget {
  private readonly contributions = new Set<LanguageServerContribution>()

  public register(contribution: LanguageServerContribution): void {
    this.contributions.add(contribution)
  }

  public unregister(contribution: LanguageServerContribution): void {
    this.contributions.delete(contribution)
  }

  public goToDefinitionFromSelection(): boolean {
    return this.runNavigationCommand({
      kind: 'definition',
      openMode: 'default',
    })
  }

  public runNavigationCommand(command: LanguageServerNavigationCommand): boolean {
    for (const contribution of this.contributions) {
      if (contribution.runNavigationCommand(command)) return true
    }

    return false
  }

  public showHover(): boolean {
    for (const contribution of this.contributions) {
      if (contribution.showHover()) return true
    }

    return false
  }

  public moveDiagnosticMarker(direction: DiagnosticMarkerDirection): boolean {
    for (const contribution of this.contributions) {
      if (contribution.moveDiagnosticMarker(direction)) return true
    }

    return false
  }

  public formatDocument(): boolean {
    for (const contribution of this.contributions) {
      if (contribution.formatDocument()) return true
    }

    return false
  }

  public renameSymbol(): boolean {
    for (const contribution of this.contributions) {
      if (contribution.renameSymbol()) return true
    }

    return false
  }

  public applyAutoFix(): boolean {
    for (const contribution of this.contributions) {
      if (contribution.applyAutoFix()) return true
    }

    return false
  }
}

class LanguageServerCommandContribution implements EditorDisposable {
  private readonly commands: readonly EditorDisposable[]

  public constructor(
    context: EditorCommandContributionContext,
    private readonly state: LanguageServerPluginState,
    commands: readonly LanguageServerCommandSpec[],
  ) {
    this.commands = commands.map((command) =>
      context.registerCommand(command.id, () => command.run(this.state)),
    )
  }

  public dispose(): void {
    for (const command of this.commands) command.dispose()
  }
}

class LanguageServerCompletionEditContribution implements EditorEditContribution {
  private readonly completionFeature: EditorDisposable

  public constructor(
    context: EditorEditContributionContext,
    options: LanguageServerResolvedAdapterOptions['completion'],
  ) {
    this.completionFeature = context.registerFeature(
      options.editFeature,
      createCompletionEditFeature(context, options.acceptTimingName),
    )
  }

  public dispose(): void {
    this.completionFeature.dispose()
  }
}

type ViewLanguageServerLane = LanguageServerSetLane & {
  readonly documentSyncRegistration: EditorDisposable | null
  readonly pullDiagnostics: PullDiagnosticsController | null
  readonly sync: DocumentSync
}

type RenameWorkspaceEditDispatch = {
  readonly active: ActiveDocument
  readonly currentName: string
  readonly edit: unknown
  readonly guard: WorkspaceEditOriginGuard
  readonly nextName: string
  readonly owner: LanguageServerSetLane
  readonly signal: AbortSignal
}

class LanguageServerContribution implements EditorViewContribution {
  private readonly lanes: readonly ViewLanguageServerLane[]
  private readonly servers: LanguageServerSet
  private readonly diagnostics: CompositeDiagnosticsPresenter
  private readonly completionSources: LanguageServerCompletionSources
  private readonly completion: CompletionController
  private readonly hoverDefinition: HoverDefinitionController
  private readonly signatureHelp: SignatureHelpController
  private readonly documentHighlights: DocumentHighlightController
  private readonly codeActions: CodeActionController
  /** Absent rather than idle when switched off, so nothing watches the typing at all. */
  private readonly formatOnType: FormatOnTypeController | null
  /** Absent unless the host asked for semantic colour; see LanguageServerSemanticTokensOptions. */
  private semanticTokens: SemanticTokenLayerOwner | null = null
  private semanticTokensOptions: LanguageServerSemanticTokensOwnerOptions | null = null
  private semanticTokensOwner: ViewLanguageServerLane | null = null
  private rename: RenameWidgetController | null = null
  private renameOperation: AbortController | null = null
  private renameActiveDocument: ActiveDocument | null = null
  /** The symbol an open prompt is renaming, which is what the prompt has to stay beside. */
  private renamePromptRange: OffsetRange | null = null
  private viewDocument: ActiveDocument | null = null
  private disposed = false

  public constructor(
    private readonly context: EditorViewContributionContext,
    private readonly state: LanguageServerPluginState,
    private readonly options: LanguageServerResolvedAdapterOptions,
  ) {
    const prefix = context.highlightPrefix ?? options.defaultHighlightPrefix
    const presenter = new DiagnosticsPresenter(context, prefix, options.diagnostics)
    this.diagnostics = new CompositeDiagnosticsPresenter(
      presenter,
      rankedLanguageServerLanes(options.lanes, 'diagnostics').map((lane) => lane.id),
      options.onDiagnostics,
    )
    this.lanes = options.lanes.map((lane) => this.createLane(lane))
    this.servers = new LanguageServerSet(this.lanes)
    this.completionSources = new LanguageServerCompletionSources(
      context,
      this.servers
        .declared('completion')
        .map((lane) =>
          createLanguageServerCompletionSource(
            lane.connection.client,
            () => this.servers.ready('completion').includes(lane),
            lane.onInteractiveReady,
            lane.onRequestError,
          ),
        ),
    )
    this.completion = new CompletionController({
      context,
      completionSources: this.completionSources,
      completionEditFeature: options.completion.editFeature,
      completionWidgetClassNamespace: options.completion.widgetClassNamespace,
      completionAcceptOnCommitCharacter: options.completion.acceptOnCommitCharacter,
      getActiveDocument: () => this.activeDocument(),
      ignorePointerTarget: (target) => this.hoverDefinition.containsTarget(target),
      onBeforeShow: () => this.hoverDefinition.clearPointerUi(),
      onRequestSuccess: () => options.onInteractiveReady?.(),
      onRequestError: (error) => this.handleRequestError(error),
    })
    this.hoverDefinition = new HoverDefinitionController({
      context,
      router: this.servers,
      requestHover: (params, requestOptions, onUpdate) =>
        this.servers.requestHover(params, requestOptions, onUpdate),
      hoverMarkdownCodeBackground: options.hoverMarkdownCodeBackground,
      defaultHighlightPrefix: options.defaultHighlightPrefix,
      linkHighlightNameNamespace: options.hoverDefinition.linkHighlightNameNamespace,
      tooltipClassNamespace: options.hoverDefinition.tooltipClassNamespace,
      navigationTimingNamePrefix: options.hoverDefinition.navigationTimingNamePrefix,
      getActiveDocument: () => this.activeDocument(),
      getDiagnostics: () => this.diagnostics.diagnostics,
      completionContainsTarget: (target) => this.completion.containsTarget(target),
      onOpenDefinition: options.onOpenDefinition,
      onOpenReferences: options.onOpenReferences,
      onRequestSuccess: () => options.onInteractiveReady?.(),
      onRequestError: (error) => this.handleRequestError(error),
    })
    this.signatureHelp = new SignatureHelpController({
      router: this.servers,
      context,
      getActiveDocument: () => this.activeDocument(),
      onRequestError: (error) => this.handleRequestError(error),
      onRequestSuccess: () => options.onInteractiveReady?.(),
      tooltipClassNamespace: options.hoverDefinition.tooltipClassNamespace,
    })
    this.documentHighlights = new DocumentHighlightController({
      router: this.servers,
      context,
      getActiveDocument: () => this.activeDocument(),
      highlightName: `${context.highlightPrefix ?? options.defaultHighlightPrefix}-document-highlight`,
      onRequestError: (error) => this.handleRequestError(error),
    })
    this.codeActions = new CodeActionController({
      router: this.servers,
      context,
      getActiveDocument: () => this.activeDocument(),
      getDiagnostics: () => this.diagnostics.diagnostics,
      onRequestError: (error) => this.handleRequestError(error),
    })
    this.formatOnType = options.formatOnType
      ? new FormatOnTypeController({ context, editFeature: options.completion.editFeature })
      : null
    this.state.register(this)
    this.update(context.getSnapshot(), 'document', null)
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void {
    if (this.disposed) return

    this.updateViewDocument(snapshot, kind)
    this.abortRenameOnDocumentDrift()
    this.hoverDefinition.update(snapshot, kind)
    if (anchoredSurfaceFollowsUpdate(kind)) this.reanchorRenamePrompt()
    for (const lane of this.lanes) {
      if (!lane.connection.isReady()) continue
      if (!lane.sync.shouldSync(kind, snapshot)) continue

      lane.sync.sync(snapshot, change ?? null)
      lane.pullDiagnostics?.synchronize()
    }
    this.completion.update(snapshot, kind, change ?? null)
    this.signatureHelp.update(snapshot, kind, change ?? null)
    this.documentHighlights.update(snapshot, kind)
    this.codeActions.update(kind)
    this.formatOnType?.update(snapshot, kind, change ?? null)
    this.syncSemanticTokens(snapshot, kind)
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.state.unregister(this)
    this.hoverDefinition.dispose()
    this.completion.hide()
    for (const lane of this.lanes) {
      lane.documentSyncRegistration?.dispose()
      lane.pullDiagnostics?.dispose()
      lane.sync.close()
    }
    this.diagnostics.clear()
    this.completionSources.dispose()
    this.completion.dispose()
    this.signatureHelp.dispose()
    this.documentHighlights.dispose()
    this.codeActions.dispose()
    this.formatOnType?.dispose()
    this.semanticTokens?.dispose()
    this.semanticTokensOptions?.dispose?.()
    this.semanticTokensOptions = null
    this.semanticTokensOwner = null
    this.cancelRename()
    this.rename?.dispose()
    for (const lane of this.lanes) lane.connection.release()
  }

  public goToDefinitionFromSelection(): boolean {
    return this.runNavigationCommand({
      kind: 'definition',
      openMode: 'default',
    })
  }

  public runNavigationCommand(command: LanguageServerNavigationCommand): boolean {
    return this.hoverDefinition.runNavigationCommand(command)
  }

  public showHover(): boolean {
    return this.hoverDefinition.showHoverFromSelection()
  }

  public moveDiagnosticMarker(direction: DiagnosticMarkerDirection): boolean {
    return this.diagnostics.moveMarker(this.activeDocument(), direction)
  }

  /**
   * Formats the whole document through the language server.
   *
   * Reports handled as soon as the request is on its way: the answer arrives asynchronously, and
   * returning false would let the keystroke fall through to another binding.
   */
  public formatDocument(): boolean {
    const active = this.activeDocument()
    if (!active) return false
    if (!this.servers.hasReady('formatting', 'textDocument/formatting')) return false

    void this.requestFormatting(active)
    return true
  }

  /**
   * Renames the symbol under the caret.
   *
   * The new name comes from the host when it supplies `onRequestRenameName`, and otherwise from the
   * editor's own input widget, so the engine is usable standalone without dictating a dialog to an
   * application that has one.
   */
  public renameSymbol(): boolean {
    const active = this.activeDocument()
    if (!active) return false
    if (!this.servers.hasReady('rename', 'textDocument/rename')) return false

    this.cancelRename()
    const abort = new AbortController()
    this.renameOperation = abort
    this.renameActiveDocument = active
    void this.runRename(active, abort).finally(() => this.finishRename(abort))
    return true
  }

  /** Applies the preferred quick fix the oracle already found for the caret. */
  public applyAutoFix(): boolean {
    return this.codeActions.applyAutoFix()
  }

  private createLane(options: LanguageServerResolvedLaneOptions): ViewLanguageServerLane {
    let lane: ViewLanguageServerLane | null = null
    const diagnostics = this.diagnostics.forLane(options.id, options.onDiagnostics)
    const connection = acquireResolvedLanguageServerLane(options, {
      onDiagnosticRefresh: () => lane?.pullDiagnostics?.refresh(),
      onPublishDiagnostics: (params) => {
        if (options.features.diagnostics === undefined) return
        if (!lane) return

        lane.sync.publishDiagnostics(params)
        this.codeActions.diagnosticsChanged()
      },
      onReady: () => {
        if (lane) this.syncReadyLane(lane)
      },
      onUnavailable: () => {
        if (!lane) return

        lane.pullDiagnostics?.cancel()
        lane.sync.clearDiagnostics()
        this.syncSemanticTokens(this.context.getSnapshot(), 'document')
      },
    })
    const sync = new DocumentSync(connection.workspace, diagnostics, {
      ...this.options.documentSync,
      logicalRevisionScope: connection.logicalRevisionScope,
      onDocumentClosed: () => this.completion.hide(),
    })
    const pullDiagnostics =
      options.features.diagnostics === undefined
        ? null
        : new PullDiagnosticsController({
            client: connection.client,
            getDocument: () => {
              const active = sync.activeDocument
              return active ? { uri: active.uri, version: active.lspVersion } : null
            },
            publish: (document, items) => {
              sync.pullDiagnostics(document.uri, document.version, items)
              this.codeActions.diagnosticsChanged()
            },
            onRequestError: (error) => {
              if (options.onRequestError) options.onRequestError('textDocument/diagnostic', error)
              else this.options.onRequestError?.(options.id, 'textDocument/diagnostic', error)
            },
          })
    const documentSyncRegistration = this.options.documentSync.controller?.register({
      getSnapshot: () => this.context.getSnapshot(),
      sync,
      workspace: connection.workspace,
    })
    lane = {
      connection,
      documentSyncRegistration: documentSyncRegistration ?? null,
      features: options.features,
      id: options.id,
      onApplyWorkspaceEdit: options.onApplyWorkspaceEdit,
      pullDiagnostics,
      onRequestError: (method, error) => {
        if (options.onRequestError) options.onRequestError(method, error)
        else this.options.onRequestError?.(options.id, method, error)
      },
      onInteractiveReady: () => {
        if (options.onInteractiveReady) options.onInteractiveReady()
        else this.options.onInteractiveReady?.()
      },
      sync,
    }
    void connection.ready.catch(() => undefined)
    return lane
  }

  private syncReadyLane(lane: ViewLanguageServerLane): void {
    if (this.disposed) return

    const snapshot = this.context.getSnapshot()
    if (!lane.sync.shouldSync('document', snapshot)) return
    lane.sync.sync(snapshot, null)
    lane.pullDiagnostics?.synchronize()
    this.syncSemanticTokens(snapshot, 'document')
  }

  private syncSemanticTokens(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
  ): void {
    const selected = this.options.semanticTokens
      ? (this.servers.ready('semanticTokens')[0] ?? null)
      : null
    const owner = this.lanes.find((lane) => lane === selected) ?? null
    if (owner !== this.semanticTokensOwner) this.replaceSemanticTokensOwner(owner)

    this.semanticTokens?.update(snapshot, kind)
  }

  private replaceSemanticTokensOwner(owner: ViewLanguageServerLane | null): void {
    this.semanticTokens?.dispose()
    this.semanticTokens = null
    this.semanticTokensOptions?.dispose?.()
    this.semanticTokensOptions = null
    this.semanticTokensOwner = owner
    if (!owner || !this.options.semanticTokens) return

    const options = this.options.semanticTokens({
      id: owner.id,
      connection: {
        client: owner.connection.client,
        workspace: owner.connection.workspace,
      },
    })
    this.semanticTokensOptions = options
    this.semanticTokens = new SemanticTokenLayerOwner(this.context, options)
  }

  private activeDocument(): ActiveDocument | null {
    return this.viewDocument
  }

  private updateViewDocument(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
  ): void {
    if (kind === 'clear') {
      this.viewDocument = null
      return
    }
    if (this.viewDocument?.textVersion === snapshot.textVersion && kind !== 'document') return

    this.viewDocument = activeDocumentForSnapshot(snapshot, this.options.documentSync)
  }

  private async runRename(active: ActiveDocument, abort: AbortController): Promise<void> {
    const selection = this.context.getSnapshot().selections[0]
    if (!selection) return

    const offset = selection.headOffset
    const owner = this.servers.ready('rename', 'textDocument/rename')[0]
    if (!owner) return

    const prepared = await this.prepareRename(active, offset, owner, abort.signal)
    if (!prepared) return
    if (!this.renameIsCurrent(active, abort)) return

    const { range, currentName } = prepared

    const anchor = this.context.getRangeClientRect(range.start, range.end)
    if (!anchor) return

    try {
      this.renamePromptRange = range
      let nextName: string | null
      try {
        nextName = await this.promptRenameName({ anchor, currentName, signal: abort.signal })
      } finally {
        this.renamePromptRange = null
      }
      if (nextName === null || nextName === currentName) return
      if (!this.renameIsCurrent(active, abort)) return

      const edit = await this.servers.requestSingle(
        owner,
        'textDocument/rename',
        {
          newName: nextName,
          position: offsetToLspPosition(active.fullText, offset),
          textDocument: { uri: active.uri },
        },
        { signal: abort.signal },
        null as unknown,
      )
      const guard = captureWorkspaceEditOriginGuard(owner.connection.workspace)
      if (edit === null) return
      if (!this.renameIsCurrent(active, abort)) return

      await this.dispatchRenameEdit({
        active,
        currentName,
        edit,
        guard,
        nextName,
        owner,
        signal: abort.signal,
      })
    } catch (error) {
      this.handleRequestError(error)
    }
  }

  private async prepareRename(
    active: ActiveDocument,
    offset: number,
    owner: LanguageServerSetLane,
    signal: AbortSignal,
  ): Promise<{ readonly range: OffsetRange; readonly currentName: string } | null> {
    const fallback = wordRangeAtOffset(active.fullText, offset)
    const provider = owner.connection.client.serverCapabilities?.renameProvider
    const supportsPrepare = typeof provider === 'object' && provider.prepareProvider === true
    if (!supportsPrepare) return renameTarget(active.fullText, fallback)

    const result = await this.servers.requestSingle<
      lsp.TextDocumentPositionParams,
      lsp.PrepareRenameResult | null
    >(
      owner,
      'textDocument/prepareRename',
      {
        position: offsetToLspPosition(active.fullText, offset),
        textDocument: { uri: active.uri },
      },
      { signal },
      null,
    )
    if (!result) return null
    if ('defaultBehavior' in result) return renameTarget(active.fullText, fallback)

    const protocolRange = 'range' in result ? result.range : result
    const range = {
      start: lspPositionToOffset(active.fullText, protocolRange.start),
      end: lspPositionToOffset(active.fullText, protocolRange.end),
    }
    const target = renameTarget(active.fullText, range)
    if (!target || !('placeholder' in result)) return target

    return { ...target, currentName: result.placeholder }
  }

  /**
   * Keeps an open prompt beside the symbol while the view moves under it.
   *
   * A host that supplies its own dialog places it wherever it likes, so there is nothing here to
   * move; a symbol that has scrolled out of the rendered rows has no rect, and the prompt is left
   * where it was rather than thrown at the top of the page.
   */
  private reanchorRenamePrompt(): void {
    const range = this.renamePromptRange
    if (!range) return

    const anchor = this.context.getRangeClientRect(range.start, range.end)
    if (anchor) this.rename?.reanchor(anchor)
  }

  private promptRenameName(prompt: LanguageServerRenamePrompt): Promise<string | null> {
    if (prompt.signal.aborted) return Promise.resolve(null)

    const host = this.options.onRequestRenameName
    if (host) return host(prompt)

    return this.renameWidget().prompt(prompt)
  }

  /** Built on first use, so a host that supplies its own prompt never creates the element. */
  private renameWidget(): RenameWidgetController {
    if (this.rename) return this.rename

    this.rename = createRenameWidgetController({
      classNamespace: this.options.hoverDefinition.tooltipClassNamespace ?? 'lsp-plugin',
      document: this.context.container.ownerDocument,
      themeSource: this.context.scrollElement,
    })
    return this.rename
  }

  private async dispatchRenameEdit(request: RenameWorkspaceEditDispatch): Promise<void> {
    const parsed = parseWorkspaceEdit(request.edit)
    if (!parsed.ok) {
      this.reportLaneRequestError(
        request.owner,
        'textDocument/rename',
        new Error(parsed.error.reason),
      )
      return
    }
    const origin = currentRenameProducerProvenance(request.guard, request.active)
    if (!origin) return
    if (request.signal.aborted) return

    const apply = request.owner.onApplyWorkspaceEdit
    if (!apply) {
      this.reportLaneRequestError(
        request.owner,
        'textDocument/rename',
        new Error('Rename cannot be applied without a workspace edit host.'),
      )
      return
    }

    const result = await apply({
      guard: request.guard,
      label: `Rename ${request.currentName} to ${request.nextName}`,
      logicalRevisionScope: request.owner.connection.logicalRevisionScope,
      originUri: request.active.uri,
      originVersion: origin.version,
      plan: parsed.value,
      serverId: request.owner.id,
      signal: request.signal,
      source: 'rename',
    })
    if (result.status !== 'failed') return
    this.reportLaneRequestError(
      request.owner,
      'textDocument/rename',
      new Error(`${result.code}: ${result.message}`),
    )
  }

  private renameIsCurrent(active: ActiveDocument, abort: AbortController): boolean {
    if (this.disposed) return false
    if (abort.signal.aborted) return false
    if (this.renameOperation !== abort) return false
    return active === this.activeDocument()
  }

  private abortRenameOnDocumentDrift(): void {
    if (!this.renameOperation) return
    if (this.renameActiveDocument === this.activeDocument()) return
    this.cancelRename()
  }

  private cancelRename(): void {
    const abort = this.renameOperation
    this.renameOperation = null
    this.renameActiveDocument = null
    this.renamePromptRange = null
    abort?.abort()
  }

  private finishRename(abort: AbortController): void {
    if (this.renameOperation !== abort) return
    this.renameOperation = null
    this.renameActiveDocument = null
  }

  private reportLaneRequestError(
    owner: LanguageServerSetLane,
    method: string,
    error: unknown,
  ): void {
    if (owner.onRequestError) {
      owner.onRequestError(method, error)
      return
    }
    this.handleRequestError(error)
  }

  private async requestFormatting(active: ActiveDocument): Promise<void> {
    try {
      const edits = await this.servers.request<lsp.TextEdit[] | null>('textDocument/formatting', {
        // The view snapshot carries the editor's own tab size, so the formatter is told the same
        // width the document is displayed with.
        options: formattingOptions(this.context.getSnapshot().tabSize),
        textDocument: { uri: active.uri },
      })
      // The document can change while the formatter runs; its edits describe the text it was given.
      if (active !== this.activeDocument()) return

      const converted = prepareFormattingEdits(active.fullText, edits)
      if (converted.length === 0) return
      if (!formattingChangesText(active.fullText, converted)) return

      this.applyFormattingEdits(converted)
    } catch (error) {
      this.handleRequestError(error)
    }
  }

  /**
   * Applies formatting through the same edit feature completions use, so a format is one
   * transaction and one undo step.
   *
   * The caret is pinned to its offset rather than tracked through the edits: formatting moves text
   * wholesale, and an offset that survives is closer to where the user was looking than a position
   * mapped through a rewrite of the whole file.
   */
  private applyFormattingEdits(edits: readonly TextEdit[]): void {
    const feature = this.context.getFeature?.(this.options.completion.editFeature)
    if (!feature) return

    const head = this.context.getSnapshot().selections[0]?.headOffset ?? 0
    feature.applyCompletion({ edits, selection: { anchor: head, head } })
  }

  private handleRequestError(error: unknown): void {
    if (isAbortError(error)) return
    this.options.onError?.(error)
  }
}

function renameTarget(
  text: string,
  range: OffsetRange,
): { readonly range: OffsetRange; readonly currentName: string } | null {
  const currentName = text.slice(range.start, range.end)
  if (currentName.length === 0) return null
  return { currentName, range }
}

function currentRenameProducerProvenance(
  guard: WorkspaceEditOriginGuard,
  active: ActiveDocument,
): WorkspaceTextDocumentProvenance | null {
  const origin = guard.documents.find((document) => document.uri === active.uri)
  if (!origin) return null
  if (origin.textSnapshot !== active.textSnapshot) return null
  if (!guard.isCurrent(active.uri)) return null
  return origin
}

function resolveAdapterOptions(
  options: LanguageServerAdapterPluginOptions,
): LanguageServerResolvedAdapterOptions {
  return {
    name: options.name,
    hoverMarkdownCodeBackground: options.hoverMarkdownCodeBackground ?? false,
    lanes: [resolvedLaneFromAdapterOptions(options)],
    defaultHighlightPrefix: options.defaultHighlightPrefix ?? DEFAULT_HIGHLIGHT_PREFIX,
    documentSync: options.documentSync ?? {},
    diagnostics: resolveDiagnosticsOptions(options),
    completion: resolveCompletionOptions(options),
    formatOnType: options.formatOnType ?? true,
    hoverDefinition: resolveHoverDefinitionOptions(options),
    commands: options.commands ?? LANGUAGE_SERVER_COMMANDS,
    semanticTokens: options.semanticTokens ? () => options.semanticTokens! : undefined,
    onDiagnostics: options.onDiagnostics,
    onOpenDefinition: options.onOpenDefinition,
    onOpenReferences: options.onOpenReferences,
    onRequestRenameName: options.onRequestRenameName,
    onApplyWorkspaceEdit: options.onApplyWorkspaceEdit,
    onRequestError: options.onRequestError,
    onError: options.onError,
  }
}

function resolveLanguageServerSetOptions(
  options: LanguageServerSetPluginOptions,
): LanguageServerResolvedAdapterOptions {
  return {
    name: DEFAULT_PLUGIN_NAME,
    hoverMarkdownCodeBackground: options.hoverMarkdownCodeBackground ?? false,
    lanes: options.lanes.map((lane) =>
      resolveLanguageServerLaneOptions({
        ...lane,
        onApplyWorkspaceEdit: options.onApplyWorkspaceEdit,
      }),
    ),
    defaultHighlightPrefix: DEFAULT_HIGHLIGHT_PREFIX,
    documentSync: options.documentSync ?? {},
    diagnostics: resolveDiagnosticsOptions(),
    completion: resolveCompletionOptions(),
    formatOnType: true,
    hoverDefinition: resolveHoverDefinitionOptions(),
    commands: LANGUAGE_SERVER_COMMANDS,
    semanticTokens: options.semanticTokens,
    onDiagnostics: options.onDiagnostics,
    onInteractiveReady: options.onInteractiveReady,
    onOpenDefinition: options.onOpenDefinition,
    onOpenReferences: options.onOpenReferences,
    onApplyWorkspaceEdit: options.onApplyWorkspaceEdit,
    onRequestError: options.onRequestError,
    onError: options.onError,
  }
}

function languageServerLaneFromPluginOptions(
  options: LanguageServerPluginOptions,
): LanguageServerLaneOptions {
  return {
    id: DEFAULT_PLUGIN_NAME,
    features: allLanguageServerFeatures(),
    rootUri: options.rootUri,
    initializationOptions: options.initializationOptions,
    timeoutMs: options.timeoutMs,
    capabilities: options.capabilities,
    clientInfo: options.clientInfo,
    notificationHandlers: options.notificationHandlers,
    webSocketRoute: options.webSocketRoute,
    webSocketTransportOptions: options.webSocketTransportOptions,
    connectionProvider: options.connectionProvider,
    onApplyWorkspaceEdit: options.onApplyWorkspaceEdit,
    onConnectionCreated: options.onConnectionCreated,
    onConnected: options.onConnected,
    onStatusChange: options.onStatusChange,
    onInteractiveReady: options.onInteractiveReady,
    onError: options.onError,
  }
}

function resolvedLaneFromAdapterOptions(
  options: LanguageServerAdapterPluginOptions,
): LanguageServerResolvedLaneOptions {
  return {
    id: options.name,
    features: allLanguageServerFeatures(),
    rootUri: options.rootUri,
    initializationOptions: options.initializationOptions,
    timeoutMs: options.timeoutMs,
    capabilities: options.capabilities,
    clientInfo: options.clientInfo,
    notificationHandlers: options.notificationHandlers,
    createTransport: options.createTransport,
    connectionProvider: options.connectionProvider,
    onApplyWorkspaceEdit: options.onApplyWorkspaceEdit,
    onConnectionCreated: options.onConnectionCreated,
    onConnected: options.onConnected,
    onStatusChange: options.onStatusChange,
    onInteractiveReady: options.onInteractiveReady,
    onRequestError: (method, error) => options.onRequestError?.(options.name, method, error),
    onError: options.onError,
  }
}

function resolveDiagnosticsOptions(
  options?: LanguageServerAdapterPluginOptions,
): LanguageServerResolvedAdapterOptions['diagnostics'] {
  return {
    minimapSourceId: options?.diagnostics?.minimapSourceId ?? DEFAULT_DIAGNOSTICS_SOURCE_ID,
    highlightNameNamespace: options?.diagnostics?.highlightNameNamespace ?? DEFAULT_NAMESPACE,
    markerTimingNamePrefix:
      options?.diagnostics?.markerTimingNamePrefix ?? `${DEFAULT_TIMING_PREFIX}.marker`,
  }
}

function resolveCompletionOptions(
  options?: LanguageServerAdapterPluginOptions,
): LanguageServerResolvedAdapterOptions['completion'] {
  return {
    editFeature: options?.completion?.editFeature ?? LANGUAGE_SERVER_COMPLETION_EDIT_FEATURE,
    acceptTimingName:
      options?.completion?.acceptTimingName ?? DEFAULT_COMPLETION_ACCEPT_TIMING_NAME,
    widgetClassNamespace: options?.completion?.widgetClassNamespace,
    acceptOnCommitCharacter: options?.completion?.acceptOnCommitCharacter ?? false,
  }
}

function resolveHoverDefinitionOptions(
  options?: LanguageServerAdapterPluginOptions,
): LanguageServerResolvedAdapterOptions['hoverDefinition'] {
  return {
    linkHighlightNameNamespace:
      options?.hoverDefinition?.linkHighlightNameNamespace ?? DEFAULT_NAMESPACE,
    tooltipClassNamespace: options?.hoverDefinition?.tooltipClassNamespace ?? DEFAULT_NAMESPACE,
    navigationTimingNamePrefix:
      options?.hoverDefinition?.navigationTimingNamePrefix ?? DEFAULT_TIMING_PREFIX,
  }
}

const LANGUAGE_SERVER_COMMANDS: readonly LanguageServerCommandSpec[] = [
  {
    id: 'goToDefinition',
    run: (state) => state.goToDefinitionFromSelection(),
  },
  {
    id: 'editor.action.goToDefinition',
    run: (state) => state.goToDefinitionFromSelection(),
  },
  {
    id: 'editor.action.peekDefinition',
    run: (state) => state.runNavigationCommand({ kind: 'definition', openMode: 'peek' }),
  },
  {
    id: 'editor.action.revealDefinitionAside',
    run: (state) => state.runNavigationCommand({ kind: 'definition', openMode: 'aside' }),
  },
  {
    id: 'editor.action.goToImplementation',
    run: (state) =>
      state.runNavigationCommand({
        kind: 'implementation',
        openMode: 'default',
      }),
  },
  {
    id: 'editor.action.goToTypeDefinition',
    run: (state) =>
      state.runNavigationCommand({
        kind: 'typeDefinition',
        openMode: 'default',
      }),
  },
  {
    id: 'editor.action.showHover',
    run: (state) => state.showHover(),
  },
  {
    id: 'editor.action.goToReferences',
    run: (state) =>
      state.runNavigationCommand({
        kind: 'references',
        openMode: 'peek',
        includeDeclaration: true,
      }),
  },
  {
    id: 'editor.action.rename',
    run: (state) => state.renameSymbol(),
  },
  {
    id: 'editor.action.formatDocument',
    run: (state) => state.formatDocument(),
  },
  {
    id: 'editor.action.autoFix',
    run: (state) => state.applyAutoFix(),
  },
  {
    id: 'editor.action.marker.next',
    run: (state) => state.moveDiagnosticMarker('next'),
  },
  {
    id: 'editor.action.marker.prev',
    run: (state) => state.moveDiagnosticMarker('previous'),
  },
]

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (!isRecord(error)) return false
  return error.name === 'LspRequestCancelledError'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
