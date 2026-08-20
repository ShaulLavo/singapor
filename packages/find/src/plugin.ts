import {
  compareTextOffsetRanges,
  createStringTextSnapshot,
  type DocumentSessionChange,
} from '@singapor/core/document'
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
  EditorMinimapDecoration,
  EditorMinimapFeature,
  EditorPlugin,
  EditorResolvedSelection,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import {
  EDITOR_FIND_FEATURE,
  EDITOR_FIND_FEATURE_ID,
  EDITOR_MINIMAP_FEATURE,
} from '@singapor/core/extensions'
import type { VirtualizedTextHighlightStyle } from '@singapor/core/rendering'
import {
  EditorFindController,
  type EditorFindHost,
  type EditorFindResolvedSelection,
  type EditorFindUiEvent,
  type FindTrackedRanges,
} from './findController'
import { EditorFindWidget, type EditorFindWidgetOptions } from './findWidget'
import {
  arrayFindLineStartsView,
  type FindLineStartsView,
  type FindRange,
  type FindTextSource,
} from './search'
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
  const textSource = snapshotTextSource()
  return {
    hasDocument: () => context.hasDocument(),
    textSource: () => textSource(getSnapshot()),
    trackRanges: (ranges) => context.trackRanges?.(ranges) ?? fixedFindRanges(ranges),
    trackPaintedRanges: (ranges) => trackPaintedFindRanges(context, getSnapshot(), ranges),
    getSelections: () => findSelections(getSnapshot().selections),
    focusEditor: () => context.focusEditor(),
    announce: (message) => context.announce?.(message),
    setSelection: (anchor, head, timingName, revealOffset) =>
      context.setSelection(anchor, head, timingName, revealOffset),
    setSelections: (selections, timingName, revealOffset) =>
      context.setSelections(selections, timingName, revealOffset),
    setRangeHighlight: (name, ranges, style) => {
      context.setRangeHighlight?.(name, ranges, style)
      minimapFeature(context)?.setDecorations(
        name,
        minimapBands(textSource(getSnapshot()).lineStartsView, ranges, style),
      )
    },
    clearRangeHighlight: (name) => {
      context.clearRangeHighlight?.(name)
      minimapFeature(context)?.clearDecorations(name)
    },
  }
}

function minimapFeature(context: EditorViewContributionContext): EditorMinimapFeature | null {
  return context.getFeature?.(EDITOR_MINIMAP_FEATURE) ?? null
}

/**
 * A count says how many matches there are and nothing says where they are until
 * they reach the scroll furniture, so every group find paints in the text is
 * published under the name it is painted under.
 *
 * The band keeps its group's own colour: the minimap paints onto a canvas from a
 * worker, which has no element to resolve a registered colour against and
 * silently substitutes the selection colour for anything it cannot parse, so the
 * literal has to travel with the group rather than be looked up there.
 */
function minimapBands(
  lineStartsView: FindLineStartsView,
  ranges: readonly FindRange[],
  style: VirtualizedTextHighlightStyle,
): readonly EditorMinimapDecoration[] {
  return ranges.map((range): EditorMinimapDecoration => {
    const rows = bandRows(lineStartsView, range)
    return {
      startLineNumber: rows.start,
      startColumn: 1,
      endLineNumber: rows.end,
      endColumn: 1,
      color: style.backgroundColor,
      position: 'inline',
      zIndex: style.zIndex,
    }
  })
}

// A range ending exactly at a line start ends on the row before it: the break
// belongs to the line it terminates, and a selection taken to the end of one row
// should not shade the next.
function bandRows(
  lineStartsView: FindLineStartsView,
  range: FindRange,
): { readonly start: number; readonly end: number } {
  const startIndex = lineStartsView.indexForOffset(range.start)
  const endIndex = lineStartsView.indexForOffset(range.end)
  if (endIndex > startIndex && lineStartsView.at(endIndex) === range.end) {
    return { start: startIndex + 1, end: endIndex }
  }

  return { start: startIndex + 1, end: endIndex + 1 }
}

// A host that cannot follow its own edits — a static projection of a document,
// a test double — keeps the ranges it was given, which is the best answer
// available and one find does not have to ask about.
function fixedFindRanges(ranges: readonly FindRange[]): FindTrackedRanges {
  return { resolve: () => ranges }
}

/**
 * Follows the ranges as far as they are painted, answering for the rest with the
 * offsets it was handed.
 *
 * A span the reader cannot see cannot be seen standing on text that moved out
 * from under it, and the re-search already on its way replaces the whole set
 * either way. Handing the document every match instead costs it an anchor pair
 * each, on every keystroke — the bill deferring that re-search was supposed to
 * take off the keystroke in the first place.
 */
function trackPaintedFindRanges(
  context: EditorViewContributionContext,
  snapshot: EditorViewSnapshot,
  ranges: readonly FindRange[],
): FindTrackedRanges {
  const span = paintedSpan(snapshot)
  if (!span) return fixedFindRanges(ranges)

  const painted = ranges.filter((range) => overlapsSpan(range, span))
  // A match is the text the query answered for, so typing against either edge of
  // one is not part of it — unlike a scope, which is a region the user drew and
  // which should take in what they add at its edges.
  const tracked =
    painted.length === 0
      ? null
      : context.trackRanges?.(painted, { startBias: 'right', endBias: 'left' })
  if (!tracked) return fixedFindRanges(ranges)

  const elsewhere = ranges.filter((range) => !overlapsSpan(range, span))
  return { resolve: () => mergeRanges(tracked.resolve(), elsewhere) }
}

// The view adds a range highlight to the rows it has mounted and to no others.
function paintedSpan(snapshot: EditorViewSnapshot): FindRange | null {
  const first = snapshot.visibleRows[0]
  const last = snapshot.visibleRows.at(-1)
  if (!first || !last) return null

  return { start: first.startOffset, end: last.endOffset }
}

function overlapsSpan(range: FindRange, span: FindRange): boolean {
  return range.end > span.start && range.start < span.end
}

// Navigation steps the set rather than searching it, so an entry out of order
// answers the next press with the wrong match.
function mergeRanges(
  left: readonly FindRange[],
  right: readonly FindRange[],
): readonly FindRange[] {
  if (right.length === 0) return left

  const merged: FindRange[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    if (compareTextOffsetRanges(left[leftIndex]!, right[rightIndex]!) <= 0) {
      merged.push(left[leftIndex]!)
      leftIndex += 1
      continue
    }

    merged.push(right[rightIndex]!)
    rightIndex += 1
  }

  for (; leftIndex < left.length; leftIndex += 1) merged.push(left[leftIndex]!)
  for (; rightIndex < right.length; rightIndex += 1) merged.push(right[rightIndex]!)
  return merged
}

/**
 * The text a search reads, kept for as long as the snapshot it was taken from.
 *
 * Either view can be absent, and standing in for a missing one materializes what
 * it exists to avoid: a copy of the document, or the whole line-start array.
 * Every press in the find box searches again, so a stand-in built per search
 * would hand a keystroke exactly the bill that ranged reads are here to spare it.
 * Held against the snapshot itself rather than its text version, because a
 * document swap can carry that version across unchanged.
 */
function snapshotTextSource(): (snapshot: EditorViewSnapshot) => FindTextSource {
  let cached: { readonly snapshot: EditorViewSnapshot; readonly source: FindTextSource } | null =
    null
  return (snapshot) => {
    if (cached?.snapshot !== snapshot) cached = { snapshot, source: findTextSource(snapshot) }
    return cached.source
  }
}

function findTextSource(snapshot: EditorViewSnapshot): FindTextSource {
  const text = snapshot.textSnapshot ?? createStringTextSnapshot(snapshot.fullText)
  return {
    length: text.length,
    readRange: (start, end) => text.readRange(start, end),
    lineStartsView: snapshot.lineStartsView ?? arrayFindLineStartsView(snapshot.lineStarts),
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
