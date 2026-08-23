import type { SelectionAffinity } from '../selections'
import type { VirtualizedBidiRun } from './virtualizedTextViewTypes'

export const BIDI_CONTROL_CODE_POINTS = [
  0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
] as const

const RTL_CHARACTER =
  /(?:[\u05BE\u05C0\u05C3\u05C6\u05D0-\u05F4\u0608\u060B\u060D\u061B-\u064A\u066D-\u066F\u0671-\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u0710\u0712-\u072F\u074D-\u07A5\u07B1-\u07EA\u07F4\u07F5\u07FA\u07FE-\u0815\u081A\u0824\u0828\u0830-\u0858\u085E-\u088E\u08A0-\u08C9\u200F\uFB1D\uFB1F-\uFB28\uFB2A-\uFD3D\uFD50-\uFDC7\uFDF0-\uFDFC\uFE70-\uFEFC]|\uD802[\uDC00-\uDD1B\uDD20-\uDE00\uDE10-\uDE35\uDE40-\uDEE4\uDEEB-\uDF35\uDF40-\uDFFF]|\uD803[\uDC00-\uDD23\uDE80-\uDEA9\uDEAD-\uDF45\uDF51-\uDF81\uDF86-\uDFF6]|\uD83A[\uDC00-\uDCCF\uDD00-\uDD43\uDD4B-\uDFFF]|\uD83B[\uDC00-\uDEBB])/

type BidiClassifierMemo = {
  readonly revision: number
  readonly results: Map<string, boolean>
  scans: number
}

type BidiClassifierHost = {
  readonly textRevision: number
}

const classifierMemos = new WeakMap<BidiClassifierHost, BidiClassifierMemo>()
const logicalBidiRunIndexes = new WeakMap<readonly VirtualizedBidiRun[], readonly number[]>()

export function containsRTL(text: string): boolean {
  if (RTL_CHARACTER.test(text)) return true
  for (const codePoint of BIDI_CONTROL_CODE_POINTS) {
    if (text.includes(String.fromCodePoint(codePoint))) return true
  }
  return false
}

export function isSimpleRowText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code !== 9 && (code < 32 || code > 126)) return false
  }
  return true
}

export function memoizedContainsRTL(view: BidiClassifierHost, text: string): boolean {
  const memo = classifierMemo(view)
  const cached = memo.results.get(text)
  if (cached !== undefined) return cached

  const result = !isSimpleRowText(text) && containsRTL(text)
  memo.results.set(text, result)
  memo.scans += 1
  return result
}

export function rtlClassifierScanCount(view: BidiClassifierHost): number {
  return classifierMemos.get(view)?.scans ?? 0
}

export function bidiVisualRunIndexAt(
  runs: readonly VirtualizedBidiRun[],
  offset: number,
  affinity: SelectionAffinity,
): number | null {
  const logicalIndexes = logicalBidiRunIndexesFor(runs)
  const insertion = logicalRunInsertionIndex(runs, logicalIndexes, offset)
  const nextVisualIndex = logicalIndexes[insertion]
  if (nextVisualIndex !== undefined && runs[nextVisualIndex]!.startOffset === offset) {
    if (affinity === 'after') return nextVisualIndex
    return logicalIndexes[insertion - 1] ?? null
  }

  const previousVisualIndex = logicalIndexes[insertion - 1]
  if (previousVisualIndex === undefined) return null

  const previous = runs[previousVisualIndex]!
  if (offset < previous.endOffset) return previousVisualIndex
  if (affinity === 'before' && offset === previous.endOffset) return previousVisualIndex
  return null
}

function logicalBidiRunIndexesFor(runs: readonly VirtualizedBidiRun[]): readonly number[] {
  const cached = logicalBidiRunIndexes.get(runs)
  if (cached) return cached

  const indexByStart = new Map<number, number>()
  let firstVisualIndex = 0
  for (let visualIndex = 0; visualIndex < runs.length; visualIndex += 1) {
    const run = runs[visualIndex]!
    indexByStart.set(run.startOffset, visualIndex)
    if (run.startOffset < runs[firstVisualIndex]!.startOffset) firstVisualIndex = visualIndex
  }

  const indexes = linkedLogicalRunIndexes(runs, indexByStart, firstVisualIndex)
  logicalBidiRunIndexes.set(runs, indexes)
  return indexes
}

function linkedLogicalRunIndexes(
  runs: readonly VirtualizedBidiRun[],
  indexByStart: ReadonlyMap<number, number>,
  firstVisualIndex: number,
): readonly number[] {
  if (runs.length === 0) return []

  const indexes: number[] = []
  let visualIndex: number | undefined = firstVisualIndex
  while (visualIndex !== undefined && indexes.length < runs.length) {
    indexes.push(visualIndex)
    visualIndex = indexByStart.get(runs[visualIndex]!.endOffset)
  }
  return indexes
}

function logicalRunInsertionIndex(
  runs: readonly VirtualizedBidiRun[],
  logicalIndexes: readonly number[],
  offset: number,
): number {
  let low = 0
  let high = logicalIndexes.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const start = runs[logicalIndexes[middle]!]!.startOffset
    if (start < offset) low = middle + 1
    else high = middle
  }
  return low
}

function classifierMemo(view: BidiClassifierHost): BidiClassifierMemo {
  const current = classifierMemos.get(view)
  if (current?.revision === view.textRevision) return current

  const memo = { revision: view.textRevision, results: new Map<string, boolean>(), scans: 0 }
  classifierMemos.set(view, memo)
  return memo
}
