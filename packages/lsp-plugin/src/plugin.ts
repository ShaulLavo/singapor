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
import type { LspClient, LspWorkspace } from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

import {
  LANGUAGE_SERVER_COMPLETION_EDIT_FEATURE,
  createCompletionEditFeature,
  type LanguageServerCompletionEditFeature,
} from './completion'
import { CompletionController } from './completionController'
import { DiagnosticsPresenter } from './diagnosticsPresenter'
import { DocumentSync, type DocumentSyncOptions } from './documentSync'
import { HoverDefinitionController } from './hoverDefinitionController'
import { SignatureHelpController } from './signatureHelpController'
import { DocumentHighlightController } from './documentHighlightController'
import { createRenameWidgetController, type RenameWidgetController } from './renameWidget'
import {
  workspaceEditForDocument,
  workspaceEditPlan,
  workspaceEditTouchesOtherDocuments,
} from './workspaceEdit'
import { wordRangeAtOffset } from '@singapor/core/internal'
import { offsetToLspPosition } from '@singapor/lsp'
import {
  createWebSocketLspTransportFactory,
  LspConnection,
  type LspConnectionTransportFactory,
} from './lspConnection'
import type {
  ActiveDocument,
  DiagnosticMarkerDirection,
  LanguageServerNavigationCommand,
} from './pluginTypes'
import { formattingChangesText, formattingEdits, formattingOptions } from './formatting'
import type { TextEdit } from '@singapor/core'
import type {
  LanguageServerDefinitionTarget,
  LanguageServerDiagnosticSummary,
  LanguageServerNavigationOptions,
  LanguageServerPlugin,
  LanguageServerPluginOptions,
  LanguageServerReferencesResult,
  LanguageServerStatus,
} from './types'

export type { LanguageServerResolvedOptions } from './pluginTypes'

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_PLUGIN_NAME = 'editor.lsp-plugin'
const DEFAULT_HIGHLIGHT_PREFIX = 'editor-lsp-plugin'
const DEFAULT_NAMESPACE = 'lsp-plugin'
const DEFAULT_TIMING_PREFIX = 'lspPlugin'
const DEFAULT_DIAGNOSTICS_SOURCE_ID = 'editor.lsp-plugin.diagnostics'
const DEFAULT_COMPLETION_ACCEPT_TIMING_NAME = 'lspPlugin.completion.accept'

export type LanguageServerConnectionContext = {
  readonly client: LspClient
  readonly workspace: LspWorkspace
}

export type LanguageServerCommandTarget = {
  goToDefinitionFromSelection(): boolean
  runNavigationCommand(command: LanguageServerNavigationCommand): boolean
  moveDiagnosticMarker(direction: DiagnosticMarkerDirection): boolean
  formatDocument(): boolean
  renameSymbol(): boolean
}

export type LanguageServerCommandSpec = {
  readonly id: EditorCommandId
  run(target: LanguageServerCommandTarget): boolean
}

export type LanguageServerRenamePrompt = {
  readonly currentName: string
  readonly anchor: DOMRect
}

export type LanguageServerAdapterPluginOptions = {
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
  createTransport(): ReturnType<LspConnectionTransportFactory>
  readonly defaultHighlightPrefix?: string
  readonly documentSync?: Omit<DocumentSyncOptions, 'onDocumentClosed'>
  readonly diagnostics?: {
    readonly minimapSourceId?: string
    readonly highlightNameNamespace?: string
    readonly markerTimingNamePrefix?: string
  }
  readonly completion?: {
    readonly editFeature?: EditorCapabilityToken<LanguageServerCompletionEditFeature>
    readonly acceptTimingName?: string
    readonly widgetClassNamespace?: string
  }
  readonly hoverDefinition?: {
    readonly linkHighlightNameNamespace?: string
    readonly tooltipClassNamespace?: string
    readonly navigationTimingNamePrefix?: string
  }
  readonly commands?: readonly LanguageServerCommandSpec[]
  onConnectionCreated?(context: LanguageServerConnectionContext): EditorDisposable | void
  onConnected?(context: LanguageServerConnectionContext): void
  readonly onStatusChange?: (status: LanguageServerStatus) => void
  readonly onDiagnostics?: (summary: LanguageServerDiagnosticSummary) => void
  readonly onInteractiveReady?: () => void
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
  readonly rootUri: lsp.DocumentUri | null
  readonly hoverMarkdownCodeBackground: boolean
  readonly initializationOptions: unknown
  readonly timeoutMs: number
  createTransport(): ReturnType<LspConnectionTransportFactory>
  readonly defaultHighlightPrefix: string
  readonly documentSync: Omit<DocumentSyncOptions, 'onDocumentClosed'>
  readonly diagnostics: {
    readonly minimapSourceId: string
    readonly highlightNameNamespace: string
    readonly markerTimingNamePrefix: string
  }
  readonly completion: {
    readonly editFeature: EditorCapabilityToken<LanguageServerCompletionEditFeature>
    readonly acceptTimingName: string
    readonly widgetClassNamespace?: string
  }
  readonly hoverDefinition: {
    readonly linkHighlightNameNamespace: string
    readonly tooltipClassNamespace: string
    readonly navigationTimingNamePrefix: string
  }
  readonly commands: readonly LanguageServerCommandSpec[]
  onConnectionCreated?(context: LanguageServerConnectionContext): EditorDisposable | void
  onConnected?(context: LanguageServerConnectionContext): void
  readonly onStatusChange?: (status: LanguageServerStatus) => void
  readonly onDiagnostics?: (summary: LanguageServerDiagnosticSummary) => void
  readonly onInteractiveReady?: () => void
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
  return createLanguageServerAdapterPlugin({
    name: DEFAULT_PLUGIN_NAME,
    rootUri: options.rootUri,
    hoverMarkdownCodeBackground: options.hoverMarkdownCodeBackground,
    initializationOptions: options.initializationOptions,
    timeoutMs: options.timeoutMs,
    createTransport: createWebSocketLspTransportFactory(
      options.webSocketRoute,
      options.webSocketTransportOptions,
    ),
    onStatusChange: options.onStatusChange,
    onDiagnostics: options.onDiagnostics,
    onInteractiveReady: options.onInteractiveReady,
    onOpenDefinition: options.onOpenDefinition,
    onOpenReferences: options.onOpenReferences,
    onError: options.onError,
  })
}

export function createLanguageServerAdapterPlugin(
  options: LanguageServerAdapterPluginOptions,
): LanguageServerPlugin {
  const resolved = resolveAdapterOptions(options)
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

class LanguageServerContribution implements EditorViewContribution {
  private readonly connection: LspConnection
  private readonly diagnostics: DiagnosticsPresenter
  private readonly documentSync: DocumentSync
  private readonly completion: CompletionController
  private readonly hoverDefinition: HoverDefinitionController
  private readonly signatureHelp: SignatureHelpController
  private readonly documentHighlights: DocumentHighlightController
  private rename: RenameWidgetController | null = null
  private readonly connectionRegistration: EditorDisposable | null
  private disposed = false

  public constructor(
    private readonly context: EditorViewContributionContext,
    private readonly state: LanguageServerPluginState,
    private readonly options: LanguageServerResolvedAdapterOptions,
  ) {
    const prefix = context.highlightPrefix ?? options.defaultHighlightPrefix
    this.diagnostics = new DiagnosticsPresenter(context, prefix, {
      ...options.diagnostics,
      onDiagnostics: options.onDiagnostics,
    })
    this.connection = new LspConnection(
      {
        rootUri: options.rootUri,
        initializationOptions: options.initializationOptions,
        timeoutMs: options.timeoutMs,
        createTransport: options.createTransport,
      },
      {
        onConnected: () => this.handleConnected(),
        onUnavailable: () => this.clearRequestUi(),
        onPublishDiagnostics: (params) => this.documentSync.publishDiagnostics(params),
        onStatusChange: options.onStatusChange,
        onError: options.onError,
      },
    )
    this.connectionRegistration = options.onConnectionCreated?.(this.connectionContext()) ?? null
    this.documentSync = new DocumentSync(this.connection.workspace, this.diagnostics, {
      ...options.documentSync,
      onDocumentClosed: () => this.completion.hide(),
    })
    this.completion = new CompletionController({
      context,
      client: this.connection.client,
      completionEditFeature: options.completion.editFeature,
      completionWidgetClassNamespace: options.completion.widgetClassNamespace,
      getActiveDocument: () => this.documentSync.activeDocument,
      ignorePointerTarget: (target) => this.hoverDefinition.containsTarget(target),
      onBeforeShow: () => this.hoverDefinition.clearPointerUi(),
      onRequestSuccess: () => options.onInteractiveReady?.(),
      onRequestError: (error) => this.handleRequestError(error),
    })
    this.hoverDefinition = new HoverDefinitionController({
      context,
      client: this.connection.client,
      hoverMarkdownCodeBackground: options.hoverMarkdownCodeBackground,
      defaultHighlightPrefix: options.defaultHighlightPrefix,
      linkHighlightNameNamespace: options.hoverDefinition.linkHighlightNameNamespace,
      tooltipClassNamespace: options.hoverDefinition.tooltipClassNamespace,
      navigationTimingNamePrefix: options.hoverDefinition.navigationTimingNamePrefix,
      getActiveDocument: () => this.documentSync.activeDocument,
      getDiagnostics: () => this.documentSync.diagnostics,
      completionContainsTarget: (target) => this.completion.containsTarget(target),
      onOpenDefinition: options.onOpenDefinition,
      onOpenReferences: options.onOpenReferences,
      onRequestSuccess: () => options.onInteractiveReady?.(),
      onRequestError: (error) => this.handleRequestError(error),
    })
    this.signatureHelp = new SignatureHelpController({
      client: this.connection.client,
      context,
      getActiveDocument: () => this.documentSync.activeDocument,
      onRequestError: (error) => this.handleRequestError(error),
      onRequestSuccess: () => options.onInteractiveReady?.(),
      tooltipClassNamespace: options.hoverDefinition.tooltipClassNamespace,
    })
    this.documentHighlights = new DocumentHighlightController({
      client: this.connection.client,
      context,
      getActiveDocument: () => this.documentSync.activeDocument,
      highlightName: `${context.highlightPrefix ?? options.defaultHighlightPrefix}-document-highlight`,
      onRequestError: (error) => this.handleRequestError(error),
    })
    this.state.register(this)
    this.connection.connect()
    this.update(context.getSnapshot(), 'document', null)
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void {
    if (this.disposed) return

    this.hoverDefinition.update(snapshot, kind)
    if (this.documentSync.shouldSync(kind, snapshot))
      this.documentSync.sync(snapshot, change ?? null)
    this.completion.update(snapshot, kind, change ?? null)
    this.signatureHelp.update(snapshot, kind, change ?? null)
    this.documentHighlights.update(snapshot, kind)
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.state.unregister(this)
    this.connectionRegistration?.dispose()
    this.hoverDefinition.dispose()
    this.completion.hide()
    this.documentSync.close()
    this.completion.dispose()
    this.signatureHelp.dispose()
    this.documentHighlights.dispose()
    this.rename?.dispose()
    this.connection.dispose()
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

  public moveDiagnosticMarker(direction: DiagnosticMarkerDirection): boolean {
    return this.diagnostics.moveMarker(
      this.documentSync.activeDocument,
      this.documentSync.diagnostics,
      direction,
    )
  }

  /**
   * Formats the whole document through the language server.
   *
   * Reports handled as soon as the request is on its way: the answer arrives asynchronously, and
   * returning false would let the keystroke fall through to another binding.
   */
  public formatDocument(): boolean {
    const active = this.documentSync.activeDocument
    if (!active) return false
    if (!this.connection.client.serverCapabilities?.documentFormattingProvider) return false

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
    const active = this.documentSync.activeDocument
    if (!active) return false
    if (!this.connection.client.serverCapabilities?.renameProvider) return false

    void this.runRename(active)
    return true
  }

  private async runRename(active: ActiveDocument): Promise<void> {
    const selection = this.context.getSnapshot().selections[0]
    if (!selection) return

    const offset = selection.headOffset
    const range = wordRangeAtOffset(active.fullText, offset)
    const currentName = active.fullText.slice(range.start, range.end)
    if (currentName.length === 0) return

    const anchor = this.context.getRangeClientRect(range.start, range.end)
    if (!anchor) return

    try {
      const nextName = await this.promptRenameName({ anchor, currentName })
      if (nextName === null || nextName === currentName) return
      if (active !== this.documentSync.activeDocument) return

      const edit = await this.connection.client.request<lsp.WorkspaceEdit | null>(
        'textDocument/rename',
        {
          newName: nextName,
          position: offsetToLspPosition(active.fullText, offset),
          textDocument: { uri: active.uri },
        },
      )
      if (active !== this.documentSync.activeDocument) return

      this.applyRenameEdit(active, edit)
    } catch (error) {
      this.handleRequestError(error)
    }
  }

  private promptRenameName(prompt: LanguageServerRenamePrompt): Promise<string | null> {
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

  /**
   * Applies a rename that stays inside the active document.
   *
   * A rename reaching other files is reported rather than partially applied: writing only this
   * document would leave every other file referring to a name that no longer exists, which is worse
   * than not renaming at all. Multi-file application needs a workspace-wide edit applicator.
   */
  private applyRenameEdit(active: ActiveDocument, edit: lsp.WorkspaceEdit | null): void {
    const plan = workspaceEditPlan(edit)
    if (workspaceEditTouchesOtherDocuments(plan, active.uri)) {
      this.handleRequestError(
        new Error('Rename spans several files, which this editor cannot apply yet.'),
      )
      return
    }

    const edits = formattingEdits(active.fullText, workspaceEditForDocument(plan, active.uri))
    if (edits.length === 0) return

    const feature = this.context.getFeature?.(this.options.completion.editFeature)
    if (!feature) return

    const head = this.context.getSnapshot().selections[0]?.headOffset ?? 0
    feature.applyCompletion({ edits, selection: { anchor: head, head } })
  }

  private async requestFormatting(active: ActiveDocument): Promise<void> {
    try {
      const edits = await this.connection.client.request<lsp.TextEdit[] | null>(
        'textDocument/formatting',
        {
          // The view snapshot carries the editor's own tab size, so the formatter is told the same
          // width the document is displayed with.
          options: formattingOptions(this.context.getSnapshot().tabSize),
          textDocument: { uri: active.uri },
        },
      )
      // The document can change while the formatter runs; its edits describe the text it was given.
      if (active !== this.documentSync.activeDocument) return

      const converted = formattingEdits(active.fullText, edits)
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

  private handleConnected(): void {
    this.options.onConnected?.(this.connectionContext())
  }

  private connectionContext(): LanguageServerConnectionContext {
    return {
      client: this.connection.client,
      workspace: this.connection.workspace,
    }
  }

  private clearRequestUi(): void {
    this.hoverDefinition.clearPointerUi()
    this.completion.hide()
  }

  private handleRequestError(error: unknown): void {
    if (isAbortError(error)) return
    this.options.onError?.(error)
  }
}

function resolveAdapterOptions(
  options: LanguageServerAdapterPluginOptions,
): LanguageServerResolvedAdapterOptions {
  return {
    name: options.name,
    rootUri: options.rootUri ?? 'file:///',
    hoverMarkdownCodeBackground: options.hoverMarkdownCodeBackground ?? false,
    initializationOptions: options.initializationOptions,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    createTransport: options.createTransport,
    defaultHighlightPrefix: options.defaultHighlightPrefix ?? DEFAULT_HIGHLIGHT_PREFIX,
    documentSync: options.documentSync ?? {},
    diagnostics: resolveDiagnosticsOptions(options),
    completion: resolveCompletionOptions(options),
    hoverDefinition: resolveHoverDefinitionOptions(options),
    commands: options.commands ?? LANGUAGE_SERVER_COMMANDS,
    onConnectionCreated: options.onConnectionCreated,
    onConnected: options.onConnected,
    onStatusChange: options.onStatusChange,
    onDiagnostics: options.onDiagnostics,
    onInteractiveReady: options.onInteractiveReady,
    onOpenDefinition: options.onOpenDefinition,
    onOpenReferences: options.onOpenReferences,
    onError: options.onError,
  }
}

function resolveDiagnosticsOptions(
  options: LanguageServerAdapterPluginOptions,
): LanguageServerResolvedAdapterOptions['diagnostics'] {
  return {
    minimapSourceId: options.diagnostics?.minimapSourceId ?? DEFAULT_DIAGNOSTICS_SOURCE_ID,
    highlightNameNamespace: options.diagnostics?.highlightNameNamespace ?? DEFAULT_NAMESPACE,
    markerTimingNamePrefix:
      options.diagnostics?.markerTimingNamePrefix ?? `${DEFAULT_TIMING_PREFIX}.marker`,
  }
}

function resolveCompletionOptions(
  options: LanguageServerAdapterPluginOptions,
): LanguageServerResolvedAdapterOptions['completion'] {
  return {
    editFeature: options.completion?.editFeature ?? LANGUAGE_SERVER_COMPLETION_EDIT_FEATURE,
    acceptTimingName: options.completion?.acceptTimingName ?? DEFAULT_COMPLETION_ACCEPT_TIMING_NAME,
    widgetClassNamespace: options.completion?.widgetClassNamespace,
  }
}

function resolveHoverDefinitionOptions(
  options: LanguageServerAdapterPluginOptions,
): LanguageServerResolvedAdapterOptions['hoverDefinition'] {
  return {
    linkHighlightNameNamespace:
      options.hoverDefinition?.linkHighlightNameNamespace ?? DEFAULT_NAMESPACE,
    tooltipClassNamespace: options.hoverDefinition?.tooltipClassNamespace ?? DEFAULT_NAMESPACE,
    navigationTimingNamePrefix:
      options.hoverDefinition?.navigationTimingNamePrefix ?? DEFAULT_TIMING_PREFIX,
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
