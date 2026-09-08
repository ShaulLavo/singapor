import { join, wrappedNode, type ProjectionNode } from './displayProjectionIndex'
import { read } from './displayProjectionText'
import type { BuildContext } from './displayProjectionBuild'

const BLOCK_LINES = 256
const READ_WINDOW = 16384

type WrapScan = {
  prefixes: number[]
  readonly tabOffsets: number[]
  readonly tabEnds: number[]
  length: number
  visual: number
  segmentVisual: number
  rows: number
  hasTabs: boolean
  ends: number[]
  completed: number
  readonly width: number
  readonly tabSize: number
}

export function buildWrappedSpan(
  context: BuildContext,
  startRow: number,
  endRow: number,
): ProjectionNode | null {
  let root: ProjectionNode | null = null
  for (let row = startRow; row < endRow; row += BLOCK_LINES) {
    root = join(root, buildWrappedBlock(context, row, Math.min(endRow, row + BLOCK_LINES)))
  }
  return root
}

function buildWrappedBlock(
  context: BuildContext,
  startRow: number,
  endRow: number,
): ProjectionNode | null {
  const { snapshot, config, counters } = context
  const state: WrapScan = {
    prefixes: [0],
    tabOffsets: [0],
    tabEnds: [],
    length: 0,
    visual: 0,
    segmentVisual: 0,
    rows: 1,
    hasTabs: false,
    ends: [],
    completed: 0,
    width: Math.max(1, Math.floor(config.wrapColumn!)),
    tabSize: config.tabSize,
  }
  const start = snapshot.lineStart(startRow)
  const end = endRow >= snapshot.lineCount ? snapshot.length : snapshot.lineStart(endRow)
  for (let offset = start; offset < end; offset += READ_WINDOW) {
    scanWrapChunk(read(snapshot, offset, Math.min(end, offset + READ_WINDOW), counters), state)
  }
  if (state.completed < endRow - startRow) finishLine(state)
  counters.summaryLinesMeasured += endRow - startRow
  counters.indexEntriesTouched += 1
  const tabs =
    state.tabEnds.length > 0
      ? { offsets: Uint32Array.from(state.tabOffsets), ends: Uint32Array.from(state.tabEnds) }
      : null
  return wrappedNode(Uint32Array.from(state.prefixes), state.width, tabs)
}

function scanWrapChunk(text: string, state: WrapScan): void {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 10) {
      finishLine(state)
      continue
    }
    appendCodeUnit(code, state)
  }
}

function appendCodeUnit(code: number, state: WrapScan): void {
  if (code === 9 && !state.hasTabs) discoverTabs(state)
  const cells = code === 9 ? state.tabSize - (state.visual % state.tabSize) : 1
  if (state.segmentVisual > 0 && state.segmentVisual + cells > state.width) {
    if (state.hasTabs) state.ends.push(state.length)
    state.rows += 1
    state.segmentVisual = 0
  }
  state.visual += cells
  state.segmentVisual += cells
  state.length += 1
}

function discoverTabs(state: WrapScan): void {
  state.hasTabs = true
  for (let row = 1; row < state.rows; row += 1) state.ends.push(row * state.width)
}

function finishLine(state: WrapScan): void {
  if (state.hasTabs) appendTabbedLine(state)
  state.prefixes.push(state.prefixes[state.prefixes.length - 1]! + state.rows)
  state.tabOffsets.push(state.tabEnds.length)
  state.completed += 1
  state.length = 0
  state.visual = 0
  state.segmentVisual = 0
  state.rows = 1
  state.hasTabs = false
  state.ends = []
}

function appendTabbedLine(state: WrapScan): void {
  for (const end of state.ends) state.tabEnds.push(end)
  state.tabEnds.push(state.length)
}
