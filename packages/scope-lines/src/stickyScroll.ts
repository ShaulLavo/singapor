import type { DocumentSessionChange, TextSnapshot } from '@singapor/core/document'
import { createStringTextSnapshot } from '@singapor/core/document'
import type { EditorTheme, VirtualizedFoldMarker } from '@singapor/core/rendering'
import type { EditorToken } from '@singapor/core/syntax'
import type {
  EditorPlugin,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapor/core/extensions'
import { EditorSecondaryTextView } from '@singapor/core/secondary-views'
import './style.css'

export type StickyScrollPluginOptions = {
  readonly enabled?: boolean
  readonly maxLineCount?: number
}

type ResolvedStickyScrollOptions = {
  readonly enabled: boolean
  readonly maxLineCount: number
}

/** A scope reaching into the viewport, with the slot in the stack its header row would occupy. */
type StickyScrollCandidate = {
  readonly marker: VirtualizedFoldMarker
  readonly slotTop: number
}

type StickyScrollHeader = {
  /** Header rows of the enclosing scopes, outermost first. */
  readonly rows: readonly number[]
  readonly key: string
  /** The headed scope in content coordinates: the top of its header row, and where it ends. */
  readonly top: number
  readonly bottom: number
  readonly stackHeight: number
}

/**
 * Where rows sit, in content coordinates, for as far as the mounted band reaches. Rows past it are
 * extrapolated from the row height, which is wrong wherever something out there is collapsed or
 * taller than a row — but every row that decides the stack is within a stack's height of the
 * viewport top, and those are mounted.
 */
type StickyScrollRowGeometry = {
  readonly rowHeight: number
  readonly scrollTop: number
  readonly firstRow: number
  readonly firstTop: number
  readonly lastRow: number
  readonly lastBottom: number
  readonly tops: ReadonlyMap<number, number>
  readonly bottoms: ReadonlyMap<number, number>
}

type StickyScrollContent = {
  readonly text: string
  readonly tokens: readonly EditorToken[]
}

type StickyScrollRowRange = {
  readonly start: number
  readonly end: number
}

const DEFAULT_MAX_LINE_COUNT = 5

const EMPTY_HEADER: StickyScrollHeader = {
  rows: [],
  key: '',
  top: 0,
  bottom: 0,
  stackHeight: 0,
}

export function createStickyScrollPlugin(options: StickyScrollPluginOptions = {}): EditorPlugin {
  const resolved = resolveStickyScrollOptions(options)

  return {
    name: 'sticky-scroll',
    activate(context) {
      return context.registerViewContribution({
        createContribution: (contributionContext) =>
          createStickyScrollContribution(contributionContext, resolved),
      })
    },
  }
}

function createStickyScrollContribution(
  context: EditorViewContributionContext,
  options: ResolvedStickyScrollOptions,
): EditorViewContribution | null {
  if (!options.enabled) return null
  return new StickyScrollContribution(context, options)
}

class StickyScrollContribution implements EditorViewContribution {
  private readonly context: EditorViewContributionContext
  private readonly options: ResolvedStickyScrollOptions
  private readonly root: HTMLDivElement
  private lineView: EditorSecondaryTextView | null = null
  private appliedText = ''
  private appliedTokens: readonly EditorToken[] = []
  private appliedTheme: EditorTheme | null = null
  private appliedRowHeight = 0
  private contentKey = ''
  private layoutKey = ''

  public constructor(context: EditorViewContributionContext, options: ResolvedStickyScrollOptions) {
    this.context = context
    this.options = options
    this.root = createRoot(context)
    this.update(context.getSnapshot(), 'document')
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    _change?: DocumentSessionChange | null,
  ): void {
    // Which scopes the viewport hides is the whole input, and moving the caret changes none of it.
    if (kind === 'selection') return

    this.renderSnapshot(snapshot)
  }

  public dispose(): void {
    this.lineView?.dispose()
    this.lineView = null
    this.root.remove()
  }

  private renderSnapshot(snapshot: EditorViewSnapshot): void {
    const header = stickyScrollHeader(snapshot, this.options)
    if (header.rows.length === 0) {
      this.root.hidden = true
      this.layoutKey = ''
      return
    }

    const lineView = this.ensureLineView(snapshot)
    this.syncRowHeight(lineView, snapshot)
    this.syncTheme(lineView, snapshot)
    this.syncContent(lineView, snapshot, header)
    this.syncLayout(lineView, snapshot, header)
  }

  private ensureLineView(snapshot: EditorViewSnapshot): EditorSecondaryTextView {
    const existing = this.lineView
    if (existing) return existing

    const created = createLineView(this.root, this.context, snapshot)
    this.lineView = created
    this.appliedRowHeight = snapshot.metrics.rowHeight
    return created
  }

  private syncRowHeight(lineView: EditorSecondaryTextView, snapshot: EditorViewSnapshot): void {
    const rowHeight = snapshot.metrics.rowHeight
    if (rowHeight === this.appliedRowHeight) return

    this.appliedRowHeight = rowHeight
    lineView.setLineHeight(rowHeight)
  }

  private syncTheme(lineView: EditorSecondaryTextView, snapshot: EditorViewSnapshot): void {
    const theme = snapshot.theme ?? null
    if (theme === this.appliedTheme) return

    this.appliedTheme = theme
    lineView.setTheme(theme)
  }

  private syncContent(
    lineView: EditorSecondaryTextView,
    snapshot: EditorViewSnapshot,
    header: StickyScrollHeader,
  ): void {
    // Keyed by document as well as by version, because opening another document starts its versions
    // over and the same rows there hold different text.
    const key = `${snapshot.documentId}:${header.key}:${snapshot.textVersion}`
    if (key === this.contentKey && snapshot.tokens === this.appliedTokens) return

    this.contentKey = key
    this.appliedTokens = snapshot.tokens
    const content = stickyScrollContent(snapshot, header.rows)
    if (content.text !== this.appliedText) {
      this.appliedText = content.text
      lineView.setText(content.text)
    }
    lineView.setTokens(content.tokens)
  }

  private syncLayout(
    lineView: EditorSecondaryTextView,
    snapshot: EditorViewSnapshot,
    header: StickyScrollHeader,
  ): void {
    // Re-read per pass rather than once: a reservation staked while this pass is already running is
    // announced in a notification the host drops, so the next pass is what picks it up.
    const leading = this.context.getReservedOverlayWidth?.('left') ?? 0
    const trailing = this.context.getReservedOverlayWidth?.('right') ?? 0
    const key = [
      header.top,
      header.bottom,
      header.stackHeight,
      leading,
      trailing,
      snapshot.contentWidth,
      snapshot.viewport.clientWidth,
    ].join(':')
    this.root.hidden = false
    if (key === this.layoutKey) return

    this.layoutKey = key
    this.root.style.top = `${header.top}px`
    this.root.style.height = `${header.bottom - header.top}px`
    this.root.style.setProperty(
      '--editor-sticky-scroll-content-width',
      `${snapshot.contentWidth}px`,
    )
    this.root.style.setProperty('--editor-sticky-scroll-leading', `${leading}px`)
    this.root.style.setProperty('--editor-sticky-scroll-trailing', `${trailing}px`)
    this.root.style.setProperty(
      '--editor-sticky-scroll-viewport-width',
      `${snapshot.viewport.clientWidth}px`,
    )
    lineView.scrollElement.style.height = `${header.stackHeight}px`
  }
}

function resolveStickyScrollOptions(
  options: StickyScrollPluginOptions,
): ResolvedStickyScrollOptions {
  return {
    enabled: options.enabled ?? true,
    maxLineCount: normalizeMaxLineCount(options.maxLineCount),
  }
}

function normalizeMaxLineCount(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_LINE_COUNT
  if (!Number.isFinite(value)) return DEFAULT_MAX_LINE_COUNT
  return Math.max(1, Math.floor(value))
}

function createRoot(context: EditorViewContributionContext): HTMLDivElement {
  const root = context.scrollElement.ownerDocument.createElement('div')
  root.className = 'editor-sticky-scroll'
  root.setAttribute('aria-hidden', 'true')
  root.hidden = true
  context.scrollElement.appendChild(root)
  return root
}

/**
 * The stack is a text view of its own rather than a second renderer, so its lines carry the tokens,
 * chunking and inline replacements of the rows they mirror instead of an approximation of them.
 */
function createLineView(
  root: HTMLDivElement,
  context: EditorViewContributionContext,
  snapshot: EditorViewSnapshot,
): EditorSecondaryTextView {
  const lineView = new EditorSecondaryTextView(root, {
    className: 'editor-sticky-scroll-lines',
    // Static: every line of the stack is on screen at once, so there is nothing to virtualize away.
    scrollMode: 'static',
    overscan: 0,
    lineHeight: snapshot.metrics.rowHeight,
    tabSize: snapshot.tabSize,
    // Measuring the font again could land a fraction of a pixel away from the rows being mirrored.
    textMetrics: snapshot.metrics,
    selectionHighlightName: `${context.highlightPrefix ?? 'editor'}-sticky-scroll-selection`,
  })
  lineView.setEditable(false)
  // The stack repeats rows that are already in the focus and reading order.
  lineView.scrollElement.tabIndex = -1
  lineView.inputElement.tabIndex = -1
  return lineView
}

function stickyScrollHeader(
  snapshot: EditorViewSnapshot,
  options: ResolvedStickyScrollOptions,
): StickyScrollHeader {
  const geometry = stickyScrollRowGeometry(snapshot)
  if (!geometry) return EMPTY_HEADER

  const rows: number[] = []
  let top = 0
  let bottom = 0
  for (const candidate of stickyScrollCandidates(snapshot, geometry)) {
    const headerRowTop = contentRowTop(geometry, candidate.marker.startRow)
    const scopeBottom = contentRowBottom(geometry, candidate.marker.endRow)
    // A slot above the row it would stand in for is a slot for a row still on screen, which needs no
    // stand-in; a slot below the end of its scope belongs to a scope already behind us.
    if (candidate.slotTop <= headerRowTop - geometry.scrollTop) continue
    if (candidate.slotTop > scopeBottom - geometry.scrollTop) continue

    if (rows.length === 0) top = headerRowTop
    // Each scope accepted after the first is nested in the one before it, so the last one accepted is
    // the first to end — and the stack travels with whichever ends first.
    bottom = scopeBottom
    rows.push(candidate.marker.startRow)
    if (rows.length === options.maxLineCount) break
  }

  if (rows.length === 0) return EMPTY_HEADER

  return { rows, key: rows.join(','), top, bottom, stackHeight: rows.length * geometry.rowHeight }
}

/**
 * Scopes reaching into the viewport, outermost first, each one slotted a row below the scope that
 * contains it.
 *
 * Fold ranges never cross, so the ones still open at a given range are exactly its ancestors and
 * their count is its nesting depth. A scope inside a collapsed one is dropped: the rows it heads are
 * not on screen to be headed, even in the window where the marker set and the hidden rows disagree.
 */
function stickyScrollCandidates(
  snapshot: EditorViewSnapshot,
  geometry: StickyScrollRowGeometry,
): readonly StickyScrollCandidate[] {
  const candidates: StickyScrollCandidate[] = []
  const open: VirtualizedFoldMarker[] = []

  for (const marker of visibleFoldMarkers(snapshot, geometry)) {
    while (open.length > 0 && open.at(-1)!.endOffset <= marker.startOffset) open.pop()

    const insideCollapsed = open.some((ancestor) => ancestor.collapsed)
    const slotTop = open.length * geometry.rowHeight
    open.push(marker)
    if (marker.collapsed || insideCollapsed) continue

    candidates.push({ marker, slotTop })
  }

  return candidates
}

/**
 * Inclusive at both ends, unlike a scope guide's: a scope whose last row is the first mounted one is
 * exactly the scope whose header the stack is there to hold.
 */
function visibleFoldMarkers(
  snapshot: EditorViewSnapshot,
  geometry: StickyScrollRowGeometry,
): readonly VirtualizedFoldMarker[] {
  const markers: VirtualizedFoldMarker[] = []
  for (const marker of snapshot.foldMarkers) {
    if (marker.startRow > geometry.lastRow) continue
    if (marker.endRow < geometry.firstRow) continue

    markers.push(marker)
  }

  return markers.toSorted(compareMarkersByContainment)
}

/** Outermost first, which is the order a containment stack can be built in one pass. */
function compareMarkersByContainment(
  left: VirtualizedFoldMarker,
  right: VirtualizedFoldMarker,
): number {
  return left.startOffset - right.startOffset || right.endOffset - left.endOffset
}

function stickyScrollRowGeometry(snapshot: EditorViewSnapshot): StickyScrollRowGeometry | null {
  const tops = new Map<number, number>()
  const bottoms = new Map<number, number>()
  let firstRow = Number.POSITIVE_INFINITY
  let lastRow = Number.NEGATIVE_INFINITY

  // A buffer row can hold several display rows — wrapped, or with rows injected beneath it — so its
  // box is the union of them, which is what a scope starting or ending on it is measured against.
  for (const row of snapshot.visibleRows) {
    if (row.kind !== 'text') continue

    const top = tops.get(row.bufferRow)
    const bottom = bottoms.get(row.bufferRow)
    tops.set(row.bufferRow, top === undefined ? row.top : Math.min(top, row.top))
    bottoms.set(
      row.bufferRow,
      bottom === undefined ? row.top + row.height : Math.max(bottom, row.top + row.height),
    )
    firstRow = Math.min(firstRow, row.bufferRow)
    lastRow = Math.max(lastRow, row.bufferRow)
  }

  if (!Number.isFinite(firstRow) || !Number.isFinite(lastRow)) return null

  return {
    rowHeight: snapshot.metrics.rowHeight,
    scrollTop: snapshot.viewport.scrollTop,
    firstRow,
    firstTop: tops.get(firstRow)!,
    lastRow,
    lastBottom: bottoms.get(lastRow)!,
    tops,
    bottoms,
  }
}

function contentRowTop(geometry: StickyScrollRowGeometry, row: number): number {
  const top = geometry.tops.get(row)
  if (top !== undefined) return top
  if (row < geometry.firstRow) {
    return geometry.firstTop - (geometry.firstRow - row) * geometry.rowHeight
  }

  return geometry.lastBottom + (row - geometry.lastRow - 1) * geometry.rowHeight
}

function contentRowBottom(geometry: StickyScrollRowGeometry, row: number): number {
  const bottom = geometry.bottoms.get(row)
  if (bottom !== undefined) return bottom
  if (row > geometry.lastRow) {
    return geometry.lastBottom + (row - geometry.lastRow) * geometry.rowHeight
  }

  return geometry.firstTop - (geometry.firstRow - row - 1) * geometry.rowHeight
}

/**
 * The stack's own text, and the document's tokens rewritten into it. Both come out of one pass over
 * the same row ranges, because a token offset that disagrees with the text by even one character
 * paints the wrong word.
 */
function stickyScrollContent(
  snapshot: EditorViewSnapshot,
  rows: readonly number[],
): StickyScrollContent {
  const textSnapshot = snapshot.textSnapshot ?? createStringTextSnapshot(snapshot.fullText)
  const lines: string[] = []
  const tokens: EditorToken[] = []
  let base = 0

  for (const row of rows) {
    const range = rowTextRange(snapshot, textSnapshot, row)
    lines.push(range ? textSnapshot.readRange(range.start, range.end) : '')
    if (range) appendRowTokens(tokens, snapshot.tokens, range, base)
    base += (range ? range.end - range.start : 0) + 1
  }

  return { text: lines.join('\n'), tokens }
}

function appendRowTokens(
  tokens: EditorToken[],
  documentTokens: readonly EditorToken[],
  range: StickyScrollRowRange,
  base: number,
): void {
  for (
    let index = firstTokenEndingAfter(documentTokens, range.start);
    index < documentTokens.length;
    index += 1
  ) {
    const token = documentTokens[index]!
    if (token.start >= range.end) return

    tokens.push({
      start: base + Math.max(token.start, range.start) - range.start,
      end: base + Math.min(token.end, range.end) - range.start,
      style: token.style,
    })
  }
}

function firstTokenEndingAfter(tokens: readonly EditorToken[], offset: number): number {
  let low = 0
  let high = tokens.length

  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (tokens[middle]!.end > offset) high = middle
    else low = middle + 1
  }

  return low
}

function rowTextRange(
  snapshot: EditorViewSnapshot,
  textSnapshot: TextSnapshot,
  row: number,
): StickyScrollRowRange | null {
  const start = lineStartOffset(snapshot, row)
  if (start === undefined) return null

  const nextStart = lineStartOffset(snapshot, row + 1) ?? textSnapshot.length + 1
  return { start, end: Math.max(start, Math.min(textSnapshot.length, nextStart - 1)) }
}

function lineStartOffset(snapshot: EditorViewSnapshot, row: number): number | undefined {
  const lineStarts = snapshot.lineStartsView
  if (lineStarts) return lineStarts.at(row)

  return snapshot.lineStarts[row]
}
