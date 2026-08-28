import type {
  EditorMountedChunkPaintJSON,
  EditorThemeJSON,
  EditorTokenStyleJSON,
  EditorViewSnapshot,
  EditorViewSnapshotJSON,
  EditorViewportSnapshot,
  EditorViewportSnapshotJSON,
  EditorVisibleChunkSnapshot,
  EditorVisiblePaintChunkJSON,
  EditorVisiblePaintRunJSON,
  EditorVisiblePaintRowJSON,
  EditorVisibleRowSnapshot,
  EditorVisibleRowSnapshotJSON,
  EditorVisibleSnapshot,
  EditorVisibleSnapshotJSON,
} from '../plugins'
import type { EditorTheme } from '../theme'
import type { EditorToken, EditorTokenStyle } from '../tokens'
import { getEditorTokenIndex, type EditorTokenIndex } from './tokenIndex'

type RuntimeViewSnapshot = Omit<EditorViewSnapshot, 'toJSON' | 'toVisibleSnapshot'>

type ClassifiedChunk = {
  readonly chunk: EditorVisibleChunkSnapshot
  readonly parts: Extract<EditorMountedChunkPaintJSON, { kind: 'replayable' }>['parts']
  replayFidelity: EditorVisiblePaintChunkJSON['replayFidelity']
  runs: readonly EditorVisiblePaintRunJSON[]
}

type ClassifiedRow = {
  readonly row: EditorVisibleRowSnapshot
  readonly chunks: ClassifiedChunk[]
}

type TokenEntry = {
  readonly token: EditorToken
  readonly sourceIndex: number
}

type PaintCandidate = {
  readonly start: number
  readonly end: number
  readonly sourceIndex: number
  readonly style: EditorVisiblePaintRunJSON['style']
  active: boolean
}

type PaintEvent = {
  readonly position: number
  readonly starts: boolean
  readonly candidate: PaintCandidate
}

export function createEditorViewSnapshot(snapshot: RuntimeViewSnapshot): EditorViewSnapshot {
  const runtime = snapshot as EditorViewSnapshot
  Object.defineProperties(runtime, {
    toJSON: {
      enumerable: false,
      value: () => editorViewSnapshotToJSON(runtime),
    },
    toVisibleSnapshot: {
      enumerable: false,
      value: () => editorViewSnapshotToVisible(runtime),
    },
  })
  return runtime
}

function editorViewSnapshotToJSON(snapshot: EditorViewSnapshot): EditorViewSnapshotJSON {
  return {
    kind: 'editor-view',
    schemaVersion: 1,
    documentId: snapshot.documentId,
    languageId: snapshot.languageId,
    theme: copyTheme(snapshot.theme),
    fullText: snapshot.fullText,
    textVersion: finite('textVersion', snapshot.textVersion),
    initialHighlightStatus: snapshot.initialHighlightStatus,
    lineStarts: snapshot.lineStarts.map((value) => finite('lineStarts', value)),
    tokens: snapshot.tokens.map((token) => ({
      start: finite('token.start', token.start),
      end: finite('token.end', token.end),
      style: copyTokenStyle(token.style),
    })),
    brackets: snapshot.brackets.map((bracket) => ({
      index: finite('bracket.index', bracket.index),
      char: bracket.char,
      depth: finite('bracket.depth', bracket.depth),
    })),
    selections: snapshot.selections.map((selection) => ({
      anchorOffset: finite('selection.anchorOffset', selection.anchorOffset),
      headOffset: finite('selection.headOffset', selection.headOffset),
      startOffset: finite('selection.startOffset', selection.startOffset),
      endOffset: finite('selection.endOffset', selection.endOffset),
      affinity: selection.affinity,
    })),
    metrics: copyMetrics(snapshot.metrics),
    lineCount: finite('lineCount', snapshot.lineCount),
    contentWidth: finite('contentWidth', snapshot.contentWidth),
    totalHeight: finite('totalHeight', snapshot.totalHeight),
    gutterWidth: finite('gutterWidth', snapshot.gutterWidth),
    gutterLayout: copyGutterLayout(snapshot.gutterLayout),
    tabSize: finite('tabSize', snapshot.tabSize),
    foldMarkers: snapshot.foldMarkers.map(copyFoldMarker),
    visibleRows: snapshot.visibleRows.map(copyVisibleRow),
    viewport: copyViewport(snapshot.viewport),
  }
}

function editorViewSnapshotToVisible(snapshot: EditorViewSnapshot): EditorVisibleSnapshot | null {
  const classifiedRows = classifyMountedRows(snapshot)
  if (!classifiedRows) return null

  const exactChunks = classifiedRows.flatMap(({ chunks }) =>
    chunks.filter(({ replayFidelity }) => replayFidelity === 'exact'),
  )
  if (exactChunks.length > 0) attachTokenRuns(snapshot.tokens, exactChunks)

  const json = visibleSnapshotJSON(snapshot, classifiedRows)
  const runtime = json as EditorVisibleSnapshot
  Object.defineProperty(runtime, 'toJSON', {
    enumerable: false,
    value: () => copyVisibleSnapshotJSON(runtime),
  })
  return runtime
}

function classifyMountedRows(snapshot: EditorViewSnapshot): ClassifiedRow[] | null {
  for (const row of snapshot.visibleRows) {
    if (row.mountedPaintSupport !== 'replayable') return null
    for (const chunk of row.chunks) {
      if (chunk.mountedPaint.kind === 'unreplayable-widget') return null
    }
  }

  return snapshot.visibleRows.map((row) => ({
    row,
    chunks: row.chunks.map((chunk) => classifyChunk(snapshot, row, chunk)),
  }))
}

function classifyChunk(
  snapshot: EditorViewSnapshot,
  row: EditorVisibleRowSnapshot,
  chunk: EditorVisibleChunkSnapshot,
): ClassifiedChunk {
  const parts = copyMountedParts(
    (chunk.mountedPaint as Extract<EditorMountedChunkPaintJSON, { kind: 'replayable' }>).parts,
  )
  if (parts.some((part) => part.kind !== 'text')) {
    return { chunk, parts, replayFidelity: 'plain-core-rendered', runs: [] }
  }
  if (row.source !== 'document') {
    return { chunk, parts, replayFidelity: 'plain-transformed', runs: [] }
  }

  const mountedText = mountedTextFromParts(parts)
  const sourceLength = chunk.sourceEndOffset - chunk.sourceStartOffset
  if (sourceLength !== mountedText.length) {
    return { chunk, parts, replayFidelity: 'plain-transformed', runs: [] }
  }
  if (!snapshot.textSnapshot) {
    return { chunk, parts, replayFidelity: 'plain-transformed', runs: [] }
  }

  const sourceText = snapshot.textSnapshot.readRange(chunk.sourceStartOffset, chunk.sourceEndOffset)
  const replayFidelity = sourceText === mountedText ? 'exact' : 'plain-transformed'
  return { chunk, parts, replayFidelity, runs: [] }
}

function attachTokenRuns(tokens: readonly EditorToken[], chunks: readonly ClassifiedChunk[]): void {
  const index = getEditorTokenIndex(tokens)
  if (index?.sortedByStart) {
    for (const chunk of chunks) {
      const entries = indexedTokenEntries(tokens, index, chunk)
      chunk.runs = index.nonOverlapping
        ? paintLinearRunsForEntries(chunk, entries)
        : paintPrecedenceRunsForEntries(chunk, entries)
    }
    return
  }

  const partitions = partitionExternalTokens(tokens, chunks)
  for (const chunk of chunks) {
    const intersecting = (partitions.get(chunk) ?? []).toSorted(compareTokenEntries)
    if (hasOverlappingTokens(intersecting)) {
      chunk.replayFidelity = 'plain-overlap'
      chunk.runs = []
      continue
    }

    chunk.runs = paintLinearRunsForEntries(chunk, intersecting)
  }
}

function partitionExternalTokens(
  tokens: readonly EditorToken[],
  chunks: readonly ClassifiedChunk[],
): ReadonlyMap<ClassifiedChunk, readonly TokenEntry[]> {
  const sortedChunks = [...chunks].sort(
    (left, right) => left.chunk.sourceStartOffset - right.chunk.sourceStartOffset,
  )
  const maxEnds: number[] = []
  let maxEnd = -Infinity
  for (const chunk of sortedChunks) {
    maxEnd = Math.max(maxEnd, chunk.chunk.sourceEndOffset)
    maxEnds.push(maxEnd)
  }
  const partitions = new Map<ClassifiedChunk, TokenEntry[]>()
  for (let sourceIndex = 0; sourceIndex < tokens.length; sourceIndex += 1) {
    const token = tokens[sourceIndex]!
    if (!validToken(token)) continue
    const entry = { token, sourceIndex }
    const firstCandidate = upperBound(
      sortedChunks.length,
      (index) => maxEnds[index] ?? -Infinity,
      token.start,
    )
    for (let index = firstCandidate; index < sortedChunks.length; index += 1) {
      const chunk = sortedChunks[index]!
      if (chunk.chunk.sourceStartOffset >= token.end) break
      if (!tokenIntersectsChunk(token, chunk.chunk)) continue
      const partition = partitions.get(chunk) ?? []
      partition.push(entry)
      partitions.set(chunk, partition)
    }
  }
  return partitions
}

function indexedTokenEntries(
  tokens: readonly EditorToken[],
  index: EditorTokenIndex,
  chunk: ClassifiedChunk,
): TokenEntry[] {
  const endIndex = lowerBound(
    tokens.length,
    (position) => tokens[position]!.start,
    chunk.chunk.sourceEndOffset,
  )
  const startIndex = upperBound(
    endIndex,
    (position) => index.maxEnds[position] ?? 0,
    chunk.chunk.sourceStartOffset,
  )
  const entries: TokenEntry[] = []
  for (let sourceIndex = startIndex; sourceIndex < endIndex; sourceIndex += 1) {
    const token = tokens[sourceIndex]!
    if (!validToken(token) || !tokenIntersectsChunk(token, chunk.chunk)) continue
    entries.push({ token, sourceIndex })
  }
  return entries
}

function paintLinearRunsForEntries(
  chunk: ClassifiedChunk,
  entries: readonly TokenEntry[],
): readonly EditorVisiblePaintRunJSON[] {
  const runs: EditorVisiblePaintRunJSON[] = []
  for (const { token } of entries) {
    const style = compactTokenStyle(token.style)
    if (!style) continue

    const start =
      Math.max(token.start, chunk.chunk.sourceStartOffset) - chunk.chunk.sourceStartOffset
    const end = Math.min(token.end, chunk.chunk.sourceEndOffset) - chunk.chunk.sourceStartOffset
    if (end <= start) continue
    appendMergedRun(runs, { start, end, style })
  }
  return runs
}

function paintPrecedenceRunsForEntries(
  chunk: ClassifiedChunk,
  entries: readonly TokenEntry[],
): readonly EditorVisiblePaintRunJSON[] {
  const events: PaintEvent[] = []
  for (const { token, sourceIndex } of entries) {
    const style = compactTokenStyle(token.style)
    if (!style) continue

    const start =
      Math.max(token.start, chunk.chunk.sourceStartOffset) - chunk.chunk.sourceStartOffset
    const end = Math.min(token.end, chunk.chunk.sourceEndOffset) - chunk.chunk.sourceStartOffset
    if (end <= start) continue
    const candidate: PaintCandidate = { active: false, end, sourceIndex, start, style }
    events.push(
      { candidate, position: start, starts: true },
      { candidate, position: end, starts: false },
    )
  }
  events.sort((left, right) => left.position - right.position)
  if (events.length === 0) return []

  const heap: PaintCandidate[] = []
  const runs: EditorVisiblePaintRunJSON[] = []
  let eventIndex = 0
  let previousPosition = events[0]!.position
  while (eventIndex < events.length) {
    const position = events[eventIndex]!.position
    const winner = activePaintCandidate(heap)
    if (winner && position > previousPosition) {
      appendMergedRun(runs, { start: previousPosition, end: position, style: winner.style })
    }

    while (eventIndex < events.length && events[eventIndex]!.position === position) {
      const event = events[eventIndex]!
      event.candidate.active = event.starts
      if (event.starts) pushPaintCandidate(heap, event.candidate)
      eventIndex += 1
    }
    previousPosition = position
  }
  return runs
}

function activePaintCandidate(heap: PaintCandidate[]): PaintCandidate | null {
  while (heap.length > 0 && !heap[0]!.active) popPaintCandidate(heap)
  return heap[0] ?? null
}

function pushPaintCandidate(heap: PaintCandidate[], candidate: PaintCandidate): void {
  heap.push(candidate)
  let index = heap.length - 1
  while (index > 0) {
    const parent = (index - 1) >> 1
    if (heap[parent]!.sourceIndex >= candidate.sourceIndex) break
    heap[index] = heap[parent]!
    index = parent
  }
  heap[index] = candidate
}

function popPaintCandidate(heap: PaintCandidate[]): void {
  const tail = heap.pop()
  if (!tail || heap.length === 0) return

  let index = 0
  while (true) {
    const left = index * 2 + 1
    if (left >= heap.length) break
    const right = left + 1
    const child =
      right < heap.length && heap[right]!.sourceIndex > heap[left]!.sourceIndex ? right : left
    if (heap[child]!.sourceIndex <= tail.sourceIndex) break
    heap[index] = heap[child]!
    index = child
  }
  heap[index] = tail
}

function appendMergedRun(runs: EditorVisiblePaintRunJSON[], run: EditorVisiblePaintRunJSON): void {
  const last = runs.at(-1)
  if (!last || last.end !== run.start || !compactStylesEqual(last.style, run.style)) {
    runs.push(run)
    return
  }
  runs[runs.length - 1] = { ...last, end: run.end }
}

function visibleSnapshotJSON(
  snapshot: EditorViewSnapshot,
  classifiedRows: readonly ClassifiedRow[],
): EditorVisibleSnapshotJSON {
  return {
    kind: 'editor-visible',
    schemaVersion: 1,
    documentId: snapshot.documentId,
    languageId: snapshot.languageId,
    theme: copyTheme(snapshot.theme),
    textVersion: finite('textVersion', snapshot.textVersion),
    initialHighlightStatus: snapshot.initialHighlightStatus,
    metrics: copyMetrics(snapshot.metrics),
    lineCount: finite('lineCount', snapshot.lineCount),
    contentWidth: finite('contentWidth', snapshot.contentWidth),
    totalHeight: finite('totalHeight', snapshot.totalHeight),
    gutterWidth: finite('gutterWidth', snapshot.gutterWidth),
    gutterLayout: copyGutterLayout(snapshot.gutterLayout),
    tabSize: finite('tabSize', snapshot.tabSize),
    viewport: copyViewport(snapshot.viewport),
    rows: classifiedRows.map(({ row, chunks }) => copyVisiblePaintRow(row, chunks)),
  }
}

function copyVisiblePaintRow(
  row: EditorVisibleRowSnapshot,
  chunks: readonly ClassifiedChunk[],
): EditorVisiblePaintRowJSON {
  return {
    index: finite('row.index', row.index),
    bufferRow: finite('row.bufferRow', row.bufferRow),
    source: row.source,
    injectedTextRowId: row.injectedTextRowId ?? null,
    firstWrapSegment: row.firstWrapSegment,
    top: finite('row.top', row.top),
    height: finite('row.height', row.height),
    leftSpacerWidth: finite('row.leftSpacerWidth', row.leftSpacerWidth),
    contentCursorLine: row.contentCursorLine,
    gutterNumberCursorLine: row.gutterNumberCursorLine,
    gutterCursorLineBackgroundLaneIds: [...row.gutterCursorLineBackgroundLaneIds],
    foldMarker: row.foldMarker ? copyFoldMarker(row.foldMarker) : null,
    chunks: chunks.map(({ chunk, parts, replayFidelity, runs }) => ({
      sourceStartOffset: finite('chunk.sourceStartOffset', chunk.sourceStartOffset),
      sourceEndOffset: finite('chunk.sourceEndOffset', chunk.sourceEndOffset),
      rowLocalStart: finite('chunk.rowLocalStart', chunk.rowLocalStart),
      rowLocalEnd: finite('chunk.rowLocalEnd', chunk.rowLocalEnd),
      parts: copyMountedParts(parts),
      replayFidelity,
      runs: runs.map(copyPaintRun),
    })),
  }
}

function copyVisibleRow(row: EditorVisibleRowSnapshot): EditorVisibleRowSnapshotJSON {
  return {
    index: finite('row.index', row.index),
    bufferRow: finite('row.bufferRow', row.bufferRow),
    source: row.source,
    injectedTextRowId: row.injectedTextRowId ?? null,
    startOffset: finite('row.startOffset', row.startOffset),
    endOffset: finite('row.endOffset', row.endOffset),
    text: row.text,
    kind: 'text',
    primaryText: row.primaryText,
    firstWrapSegment: row.firstWrapSegment,
    top: finite('row.top', row.top),
    height: finite('row.height', row.height),
    leftSpacerWidth: finite('row.leftSpacerWidth', row.leftSpacerWidth),
    contentCursorLine: row.contentCursorLine,
    gutterNumberCursorLine: row.gutterNumberCursorLine,
    gutterCursorLineBackgroundLaneIds: [...row.gutterCursorLineBackgroundLaneIds],
    mountedPaintSupport: row.mountedPaintSupport,
    chunks: row.chunks.map((chunk) => ({
      sourceStartOffset: finite('chunk.sourceStartOffset', chunk.sourceStartOffset),
      sourceEndOffset: finite('chunk.sourceEndOffset', chunk.sourceEndOffset),
      rowLocalStart: finite('chunk.rowLocalStart', chunk.rowLocalStart),
      rowLocalEnd: finite('chunk.rowLocalEnd', chunk.rowLocalEnd),
      text: chunk.text,
      mountedPaint: copyMountedPaint(chunk.mountedPaint),
    })),
    foldMarker: row.foldMarker ? copyFoldMarker(row.foldMarker) : null,
  }
}

function copyVisibleSnapshotJSON(snapshot: EditorVisibleSnapshot): EditorVisibleSnapshotJSON {
  return {
    kind: 'editor-visible',
    schemaVersion: 1,
    documentId: snapshot.documentId,
    languageId: snapshot.languageId,
    theme: copyTheme(snapshot.theme),
    textVersion: finite('textVersion', snapshot.textVersion),
    initialHighlightStatus: snapshot.initialHighlightStatus,
    metrics: copyMetrics(snapshot.metrics),
    lineCount: finite('lineCount', snapshot.lineCount),
    contentWidth: finite('contentWidth', snapshot.contentWidth),
    totalHeight: finite('totalHeight', snapshot.totalHeight),
    gutterWidth: finite('gutterWidth', snapshot.gutterWidth),
    gutterLayout: copyGutterLayout(snapshot.gutterLayout),
    tabSize: finite('tabSize', snapshot.tabSize),
    viewport: copyViewport(snapshot.viewport),
    rows: snapshot.rows.map((row) => ({
      ...row,
      gutterCursorLineBackgroundLaneIds: [...row.gutterCursorLineBackgroundLaneIds],
      foldMarker: row.foldMarker ? copyFoldMarker(row.foldMarker) : null,
      chunks: row.chunks.map((chunk) => ({
        ...chunk,
        parts: copyMountedParts(chunk.parts),
        runs: chunk.runs.map(copyPaintRun),
      })),
    })),
  }
}

function copyViewport(
  viewport: EditorViewportSnapshot | EditorViewportSnapshotJSON,
): EditorViewportSnapshotJSON {
  return {
    scrollTop: finite('viewport.scrollTop', viewport.scrollTop),
    scrollLeft: finite('viewport.scrollLeft', viewport.scrollLeft),
    scrollHeight: finite('viewport.scrollHeight', viewport.scrollHeight),
    scrollWidth: finite('viewport.scrollWidth', viewport.scrollWidth),
    clientHeight: finite('viewport.clientHeight', viewport.clientHeight),
    clientWidth: finite('viewport.clientWidth', viewport.clientWidth),
    borderBoxHeight: nullableFinite('viewport.borderBoxHeight', viewport.borderBoxHeight),
    borderBoxWidth: nullableFinite('viewport.borderBoxWidth', viewport.borderBoxWidth),
    visibleRange: {
      start: finite('viewport.visibleRange.start', viewport.visibleRange.start),
      end: finite('viewport.visibleRange.end', viewport.visibleRange.end),
    },
  }
}

function copyTheme(
  theme: EditorTheme | EditorThemeJSON | null | undefined,
): EditorThemeJSON | null {
  if (!theme) return null
  return compactRecord({
    type: theme.type,
    backgroundColor: theme.backgroundColor,
    foregroundColor: theme.foregroundColor,
    gutterBackgroundColor: theme.gutterBackgroundColor,
    gutterForegroundColor: theme.gutterForegroundColor,
    caretColor: theme.caretColor,
    minimapBackgroundColor: theme.minimapBackgroundColor,
    syntax: theme.syntax ? compactRecord({ ...theme.syntax }) : undefined,
    colors: theme.colors ? compactRecord({ ...theme.colors }) : undefined,
  }) as EditorThemeJSON
}

function copyTokenStyle(style: EditorTokenStyle): EditorTokenStyleJSON {
  return compactRecord({
    color: style.color,
    backgroundColor: style.backgroundColor,
    fontStyle: style.fontStyle,
    fontWeight:
      typeof style.fontWeight === 'number'
        ? finite('token.style.fontWeight', style.fontWeight)
        : style.fontWeight,
    textDecoration: style.textDecoration,
  })
}

function compactTokenStyle(style: EditorTokenStyle): EditorVisiblePaintRunJSON['style'] | null {
  const compact = compactRecord({
    color: style.color,
    backgroundColor: style.backgroundColor,
    textDecoration: style.textDecoration,
  })
  return Object.keys(compact).length === 0 ? null : compact
}

function copyMountedPaint(paint: EditorMountedChunkPaintJSON): EditorMountedChunkPaintJSON {
  if (paint.kind === 'unreplayable-widget') return { kind: 'unreplayable-widget' }
  return { kind: 'replayable', parts: copyMountedParts(paint.parts) }
}

function copyMountedParts(
  parts: Extract<EditorMountedChunkPaintJSON, { kind: 'replayable' }>['parts'],
): Extract<EditorMountedChunkPaintJSON, { kind: 'replayable' }>['parts'] {
  return parts.map((part) => {
    if (part.kind === 'control') {
      return {
        kind: 'control',
        text: part.text,
        widthCells: finite('part.widthCells', part.widthCells),
      }
    }
    return { kind: part.kind, text: part.text }
  })
}

function mountedTextFromParts(
  parts: Extract<EditorMountedChunkPaintJSON, { kind: 'replayable' }>['parts'],
): string {
  let text = ''
  for (const part of parts) text += part.text
  return text
}

function copyPaintRun(run: EditorVisiblePaintRunJSON): EditorVisiblePaintRunJSON {
  return {
    start: finite('run.start', run.start),
    end: finite('run.end', run.end),
    style: compactRecord({ ...run.style }),
  }
}

function copyMetrics(metrics: EditorViewSnapshot['metrics']): EditorViewSnapshotJSON['metrics'] {
  return {
    rowHeight: finite('metrics.rowHeight', metrics.rowHeight),
    characterWidth: finite('metrics.characterWidth', metrics.characterWidth),
  }
}

function copyGutterLayout(layout: EditorViewSnapshot['gutterLayout']) {
  return {
    fixedWidth: finite('gutterLayout.fixedWidth', layout.fixedWidth),
    lanes: layout.lanes.map((lane) => ({
      id: lane.id,
      width: finite('gutterLayout.lane.width', lane.width),
    })),
  }
}

function copyFoldMarker(marker: EditorViewSnapshot['foldMarkers'][number]) {
  return {
    key: marker.key,
    startOffset: finite('fold.startOffset', marker.startOffset),
    endOffset: finite('fold.endOffset', marker.endOffset),
    startRow: finite('fold.startRow', marker.startRow),
    endRow: finite('fold.endRow', marker.endRow),
    collapsed: marker.collapsed,
  }
}

function hasOverlappingTokens(entries: readonly TokenEntry[]): boolean {
  let previousEnd = -Infinity
  for (const { token } of entries) {
    if (token.start < previousEnd) return true
    previousEnd = Math.max(previousEnd, token.end)
  }
  return false
}

function validToken(token: EditorToken): boolean {
  return Number.isFinite(token.start) && Number.isFinite(token.end) && token.end > token.start
}

function tokenIntersectsChunk(token: EditorToken, chunk: EditorVisibleChunkSnapshot): boolean {
  return token.end > chunk.sourceStartOffset && token.start < chunk.sourceEndOffset
}

function compareTokenEntries(left: TokenEntry, right: TokenEntry): number {
  return left.token.start - right.token.start || left.sourceIndex - right.sourceIndex
}

function compactStylesEqual(
  left: EditorVisiblePaintRunJSON['style'],
  right: EditorVisiblePaintRunJSON['style'],
): boolean {
  return (
    left.color === right.color &&
    left.backgroundColor === right.backgroundColor &&
    left.textDecoration === right.textDecoration
  )
}

function finite(name: string, value: number): number {
  if (Number.isFinite(value)) return value
  throw new RangeError(`Editor snapshot ${name} must be finite`)
}

function nullableFinite(name: string, value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  return finite(name, value)
}

function compactRecord<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] !== undefined) continue
    delete record[key]
  }
  return record
}

function lowerBound(length: number, valueAt: (index: number) => number, target: number): number {
  let low = 0
  let high = length
  while (low < high) {
    const middle = (low + high) >> 1
    if (valueAt(middle) < target) low = middle + 1
    else high = middle
  }
  return low
}

function upperBound(length: number, valueAt: (index: number) => number, target: number): number {
  let low = 0
  let high = length
  while (low < high) {
    const middle = (low + high) >> 1
    if (valueAt(middle) <= target) low = middle + 1
    else high = middle
  }
  return low
}
