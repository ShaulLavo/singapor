import type { DocumentSessionChange } from '@singapor/core/document'
import type {
  EditorCapabilityContribution,
  EditorCapabilityContributionContext,
  EditorCapabilityContributionProvider,
  EditorCommandContribution,
  EditorCommandContributionContext,
  EditorCommandContributionProvider,
  EditorDisposable,
  EditorEditContribution,
  EditorEditContributionContext,
  EditorEditContributionProvider,
  EditorFindFeature,
  EditorPlugin,
  EditorResolvedSelection,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import { EDITOR_FIND_FEATURE, EDITOR_FIND_FEATURE_ID } from '@singapor/core/extensions'
import {
  EditorFindController,
  type EditorFindHost,
  type EditorFindResolvedSelection,
  type EditorFindUiEvent,
} from './findController'
import { EditorFindWidget, type EditorFindWidgetOptions } from './findWidget'
import type { EditorFindOptions } from './types'

export { EDITOR_FIND_FEATURE, EDITOR_FIND_FEATURE_ID }

export type EditorFindContributionProviders = {
  readonly view: EditorViewContributionProvider
  readonly command: EditorCommandContributionProvider
  readonly capability: EditorCapabilityContributionProvider
  readonly edit: EditorEditContributionProvider
}

export function createEditorFindPlugin(options: EditorFindOptions = {}): EditorPlugin {
  return {
    name: 'editor.find',
    activate(context) {
      const providers = createEditorFindContributionProviders(options)
      return [
        context.registerViewContribution(providers.view),
        context.registerCommandContribution(providers.command),
        context.registerCapabilityContribution(providers.capability),
        context.registerEditContribution(providers.edit),
      ]
    },
  }
}

export function createEditorFindContributionProviders(
  options: EditorFindOptions = {},
): EditorFindContributionProviders {
  const controller = new EditorFindController(options)
  return {
    view: {
      createContribution: (context) => new EditorFindViewContribution(context, controller),
    },
    command: {
      createContribution: (context) => new EditorFindCommandContribution(context, controller),
    },
    capability: {
      createContribution: (context) => new EditorFindCapabilityContribution(context, controller),
    },
    edit: {
      createContribution: (context) => new EditorFindEditContribution(context, controller),
    },
  }
}

class EditorFindViewContribution implements EditorViewContribution {
  private readonly hostRegistration: EditorDisposable
  private readonly subscription: EditorDisposable
  private latestSnapshot: EditorViewSnapshot
  private widget: EditorFindWidget | null = null
  private reservationObserver: MutationObserver | null = null

  public constructor(
    private readonly context: EditorViewContributionContext,
    private readonly controller: EditorFindController,
  ) {
    this.latestSnapshot = context.getSnapshot()
    this.hostRegistration = controller.attachHost(
      createFindHost(context, () => this.latestSnapshot),
      context.highlightPrefix ?? EDITOR_FIND_FEATURE_ID,
    )
    this.subscription = controller.subscribe(this.handleUiEvent)
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void {
    this.latestSnapshot = snapshot
    this.controller.handleViewUpdate(kind, change ?? null)
  }

  public dispose(): void {
    this.subscription.dispose()
    this.reservationObserver?.disconnect()
    this.reservationObserver = null
    this.widget?.dispose()
    this.widget = null
    this.hostRegistration.dispose()
  }

  private readonly handleUiEvent = (event: EditorFindUiEvent): void => {
    if (event.type === 'show') {
      this.ensureWidget().show(event.replaceVisible)
      return
    }

    if (event.type === 'hide') {
      this.widget?.hide()
      return
    }

    if (event.type === 'update') {
      this.widget?.update(event.state)
      return
    }

    this.focusWidget(event.target)
  }

  private focusWidget(target: 'find' | 'replace'): void {
    const widget = this.widget
    if (!widget) return

    if (target === 'find') widget.focusFindInput()
    if (target === 'replace') widget.focusReplaceInput()
  }

  private ensureWidget(): EditorFindWidget {
    if (this.widget) return this.widget

    this.widget = new EditorFindWidget(
      this.context.container,
      this.context.scrollElement,
      this.createWidgetOptions(),
    )
    this.observeReservedWidth()
    this.syncTrailingInset()
    return this.widget
  }

  // A claim staked while a layout pass is already running raises a reentrant
  // notification the host discards, so a widget that re-read the reservation on
  // notification alone would keep a stale inset until some unrelated layout
  // disturbed it. Watching the surface that carries the claim makes the inset
  // independent of the order contributions happen to run in.
  private observeReservedWidth(): void {
    if (this.reservationObserver || typeof MutationObserver === 'undefined') return

    this.reservationObserver = new MutationObserver(() => this.syncTrailingInset())
    this.reservationObserver.observe(this.context.scrollElement, { attributeFilter: ['style'] })
  }

  private syncTrailingInset(): void {
    this.widget?.setTrailingInset(this.context.getReservedOverlayWidth?.('right') ?? 0)
  }

  private createWidgetOptions(): EditorFindWidgetOptions {
    return {
      onSearchInput: (value) => this.controller.setSearchString(value),
      onReplaceInput: (value) => this.controller.setReplaceString(value),
      onToggleReplace: () => this.controller.toggleReplace(),
      onPrevious: () => this.controller.findPrevious(),
      onNext: () => this.controller.findNext(),
      onClose: () => this.controller.close(),
      onToggleCase: () => this.controller.toggleMatchCase(),
      onToggleWholeWord: () => this.controller.toggleWholeWord(),
      onToggleRegex: () => this.controller.toggleRegex(),
      onToggleScope: () => this.controller.toggleFindInSelection(),
      onTogglePreserveCase: () => this.controller.togglePreserveCase(),
      onReplaceOne: () => this.controller.replaceOne(),
      onReplaceAll: () => this.controller.replaceAll(),
    }
  }
}

class EditorFindCommandContribution implements EditorCommandContribution {
  private readonly commands: readonly EditorDisposable[]

  public constructor(context: EditorCommandContributionContext, controller: EditorFindController) {
    this.commands = [
      context.registerCommand('find', () => controller.toggleFind()),
      context.registerCommand('findReplace', () => controller.openFindReplace()),
      context.registerCommand('findNext', () => controller.findNext()),
      context.registerCommand('findPrevious', () => controller.findPrevious()),
      context.registerCommand('closeFind', () => controller.close()),
      context.registerCommand('toggleFindCaseSensitive', () => controller.toggleMatchCase()),
      context.registerCommand('toggleFindWholeWord', () => controller.toggleWholeWord()),
      context.registerCommand('toggleFindRegex', () => controller.toggleRegex()),
      context.registerCommand('toggleFindInSelection', () => controller.toggleFindInSelection()),
      context.registerCommand('togglePreserveCase', () => controller.togglePreserveCase()),
      context.registerCommand('replaceOne', () => controller.replaceOne()),
      context.registerCommand('replaceAll', () => controller.replaceAll()),
      context.registerCommand('selectAllMatches', () => controller.selectAllMatches()),
    ]
  }

  public dispose(): void {
    disposeAll(this.commands)
  }
}

class EditorFindCapabilityContribution implements EditorCapabilityContribution {
  private readonly registration: EditorDisposable

  public constructor(
    context: EditorCapabilityContributionContext,
    controller: EditorFindController,
  ) {
    this.registration = context.registerFeature(EDITOR_FIND_FEATURE, createFindFeature(controller))
  }

  public dispose(): void {
    this.registration.dispose()
  }
}

class EditorFindEditContribution implements EditorEditContribution {
  private readonly registration: EditorDisposable

  public constructor(context: EditorEditContributionContext, controller: EditorFindController) {
    this.registration = controller.attachEditHost({
      applyEdits: (edits, timingName, selection) =>
        context.applyEdits(edits, timingName, selection),
    })
  }

  public dispose(): void {
    this.registration.dispose()
  }
}

function createFindFeature(controller: EditorFindController): EditorFindFeature {
  return {
    openFind: () => controller.openFind(),
    toggleFind: () => controller.toggleFind(),
    openFindReplace: () => controller.openFindReplace(),
    closeFind: () => controller.close(),
    findNext: () => controller.findNext(),
    findPrevious: () => controller.findPrevious(),
    replaceOne: () => controller.replaceOne(),
    replaceAll: () => controller.replaceAll(),
    selectAllMatches: () => controller.selectAllMatches(),
  }
}

function createFindHost(
  context: EditorViewContributionContext,
  getSnapshot: () => EditorViewSnapshot,
): EditorFindHost {
  return {
    hasDocument: () => context.hasDocument(),
    materializeFullText: () => getSnapshot().fullText,
    getSelections: () => findSelections(getSnapshot().selections),
    focusEditor: () => context.focusEditor(),
    setSelection: (anchor, head, timingName, revealOffset) =>
      context.setSelection(anchor, head, timingName, revealOffset),
    setSelections: (selections, timingName, revealOffset) =>
      context.setSelections(selections, timingName, revealOffset),
    setRangeHighlight: (name, ranges, style) => context.setRangeHighlight?.(name, ranges, style),
    clearRangeHighlight: (name) => context.clearRangeHighlight?.(name),
  }
}

function findSelections(
  selections: readonly EditorResolvedSelection[],
): readonly EditorFindResolvedSelection[] {
  return selections.map((selection) => ({
    ...selection,
    collapsed: selection.startOffset === selection.endOffset,
  }))
}

function disposeAll(disposables: readonly EditorDisposable[]): void {
  for (const disposable of disposables.toReversed()) disposable.dispose()
}

export type { EditorFindFeature, EditorFindOptions }
