import type {
  Piece,
  PieceBufferLineIndex,
  PieceTableSnapshot,
  PieceTableReverseIndexNode,
  PieceTreeNode,
} from './pieceTableTypes'
import { createInspectionLabels, walkInspectionTree } from './inspectionWalk'

export type PieceTreeIssueKind =
  | 'cycle'
  | 'structure'
  | 'ordering'
  | 'aggregate'
  | 'buffer-bounds'
  | 'line-breaks'
  | 'priority'
  | 'snapshot'
  | 'reverse-index'
  | 'line-index'
export type PieceTreeIssue = {
  readonly kind: PieceTreeIssueKind
  readonly node: string
  readonly field: string
  readonly expected: number | string | boolean
  readonly actual: number | string | boolean | undefined
}
export type PieceTreeValidation = {
  readonly issues: readonly PieceTreeIssue[]
  readonly counts: {
    readonly nodes: number
    readonly visible: number
    readonly invisible: number
    readonly reverseEntries: number
    readonly lineIndexes: number
  }
}

type Report = (
  kind: PieceTreeIssueKind,
  node: string,
  field: string,
  expected: PieceTreeIssue['expected'],
  actual: PieceTreeIssue['actual'],
) => void
type Totals = Pick<
  PieceTreeNode,
  | 'subtreeLength'
  | 'subtreeVisibleLength'
  | 'subtreePieces'
  | 'subtreeLineBreaks'
  | 'subtreeMinOrder'
  | 'subtreeMaxOrder'
>
const empty: Totals = {
  subtreeLength: 0,
  subtreeVisibleLength: 0,
  subtreePieces: 0,
  subtreeLineBreaks: 0,
  subtreeMinOrder: Infinity,
  subtreeMaxOrder: -Infinity,
}
export const inspectionPieceFields = [
  'buffer',
  'start',
  'length',
  'order',
  'lineBreaks',
  'visible',
] as const
export const inspectionPieceKey = (piece: Pick<Piece, 'buffer' | 'start'>): string =>
  JSON.stringify([piece.buffer, piece.start])

function rawLineBreaks(text: string, start: number, end: number): number {
  let count = 0
  for (let at = start; at < end; at++) if (text.charCodeAt(at) === 10) count++
  return count
}

function checkPiece(
  snapshot: PieceTableSnapshot,
  node: PieceTreeNode,
  id: string,
  report: Report,
): number {
  const piece = node.piece
  const text = snapshot.buffers.chunks.get(piece.buffer)
  if (text === undefined)
    report('buffer-bounds', id, 'piece.buffer', 'existing buffer', piece.buffer)
  const validStart =
    Number.isSafeInteger(piece.start) && piece.start >= 0 && piece.start <= (text?.length ?? 0)
  const validLength =
    Number.isSafeInteger(piece.length) &&
    piece.length > 0 &&
    piece.start + piece.length <= (text?.length ?? 0)
  if (!validStart)
    report('buffer-bounds', id, 'piece.start', `integer in [0, ${text?.length ?? 0}]`, piece.start)
  if (!validLength)
    report(
      'buffer-bounds',
      id,
      'piece.length',
      `positive integer with end <= ${text?.length ?? 0}`,
      piece.length,
    )
  if (!Number.isFinite(piece.order))
    report('ordering', id, 'piece.order', 'finite order', piece.order)
  if (text === undefined || !validStart || !validLength) return NaN
  const breaks = rawLineBreaks(text, piece.start, piece.start + piece.length)
  report('line-breaks', id, 'piece.lineBreaks', breaks, piece.lineBreaks)
  return breaks
}

function checkTotals(
  node: PieceTreeNode,
  left: Totals,
  right: Totals,
  breaks: number,
  id: string,
  report: Report,
): Totals {
  const p = node.piece
  const result: Totals = {
    subtreeLength: left.subtreeLength + p.length + right.subtreeLength,
    subtreeVisibleLength:
      left.subtreeVisibleLength + (p.visible ? p.length : 0) + right.subtreeVisibleLength,
    subtreePieces: left.subtreePieces + 1 + right.subtreePieces,
    subtreeLineBreaks: left.subtreeLineBreaks + (p.visible ? breaks : 0) + right.subtreeLineBreaks,
    subtreeMinOrder: Math.min(left.subtreeMinOrder, p.order, right.subtreeMinOrder),
    subtreeMaxOrder: Math.max(left.subtreeMaxOrder, p.order, right.subtreeMaxOrder),
  }
  for (const field of Object.keys(empty) as Array<keyof Totals>)
    report('aggregate', id, field, result[field], node[field])
  if (left.subtreeMaxOrder >= p.order)
    report('ordering', id, 'left.order', `< ${p.order}`, left.subtreeMaxOrder)
  if (right.subtreeMinOrder <= p.order)
    report('ordering', id, 'right.order', `> ${p.order}`, right.subtreeMinOrder)
  return result
}

function checkPriority(
  node: { priority: number; left: { priority: number } | null; right: { priority: number } | null },
  id: string,
  report: Report,
): void {
  if (!Number.isFinite(node.priority))
    report('priority', id, 'priority', 'finite priority', node.priority)
  // Merge chooses the right root on a tie; rotations can retain equal children on either side.
  for (const edge of ['left', 'right'] as const) {
    const child = node[edge]
    if (child && child.priority < node.priority)
      report('priority', id, `${edge}.priority`, `>= ${node.priority}`, child.priority)
  }
}

function checkLineIndex(index: PieceBufferLineIndex, id: string, report: Report): void {
  report('line-index', id, 'scannedLength', index.text.length, index.scannedLength)
  const countValid =
    Number.isSafeInteger(index.count) && index.count >= 0 && index.count <= index.offsets.length
  if (!countValid)
    report('line-index', id, 'count', `integer in [0, ${index.offsets.length}]`, index.count)
  let count = 0
  for (let at = 0; at < index.text.length; at++) {
    if (index.text.charCodeAt(at) !== 10) continue
    report(
      'line-index',
      id,
      `offsets[${count}]`,
      at,
      count < index.count ? index.offsets[count] : undefined,
    )
    count++
  }
  report('line-index', id, 'count', count, index.count)
}

function reverseCompare(a: PieceTableReverseIndexNode, b: PieceTableReverseIndexNode): number {
  if (a.buffer < b.buffer) return -1
  if (a.buffer > b.buffer) return 1
  return a.start - b.start
}

function checkReverseEntry(
  node: PieceTableReverseIndexNode,
  pieces: Map<string, PieceTreeNode>,
  id: string,
  report: Report,
): void {
  const target = pieces.get(inspectionPieceKey(node))
  report('reverse-index', id, 'buffer', node.piece.buffer, node.buffer)
  report('reverse-index', id, 'start', node.piece.start, node.start)
  report('reverse-index', id, 'order', node.piece.order, node.order)
  if (!target) {
    report('reverse-index', id, 'piece', 'matching tree piece', 'no tree piece')
    return
  }
  for (const field of inspectionPieceFields)
    report('reverse-index', id, `piece.${field}`, target.piece[field], node.piece[field])
}

export function validatePieceTreeInvariants(
  snapshot: PieceTableSnapshot,
  label = createInspectionLabels(),
): PieceTreeValidation {
  const issues: PieceTreeIssue[] = []
  const report: Report = (kind, node, field, expected, actual) => {
    if (Object.is(expected, actual)) return
    issues.push(Object.freeze({ kind, node, field, expected, actual }))
  }
  const totals = new Map<PieceTreeNode, Totals>()
  const breaks = new Map<PieceTreeNode, number>()
  const pieces = new Map<string, PieceTreeNode>()
  const counts = { nodes: 0, visible: 0, invisible: 0, reverseEntries: 0, lineIndexes: 0 }
  walkInspectionTree(
    snapshot.root,
    ({ node }) => {
      counts.nodes++
      if (node.piece.visible) counts.visible++
      else counts.invisible++
      const id = label(node)
      breaks.set(node, checkPiece(snapshot, node, id, report))
      checkPriority(node, id, report)
      const key = inspectionPieceKey(node.piece)
      if (pieces.has(key)) report('structure', id, 'piece.key', 'unique buffer/start', key)
      pieces.set(key, node)
    },
    (node) => {
      const left = node.left ? totals.get(node.left) : empty
      const right = node.right ? totals.get(node.right) : empty
      if (!left || !right) return
      totals.set(node, checkTotals(node, left, right, breaks.get(node) ?? NaN, label(node), report))
    },
    ({ node, parent, edge }, cycle) =>
      report(
        cycle ? 'cycle' : 'structure',
        parent ? label(parent) : label(node),
        edge,
        'tree child',
        label(node),
      ),
  )
  const rootTotals = snapshot.root ? totals.get(snapshot.root) : empty
  if (rootTotals) {
    report('snapshot', 'snapshot', 'length', rootTotals.subtreeVisibleLength, snapshot.length)
    report('snapshot', 'snapshot', 'pieceCount', rootTotals.subtreePieces, snapshot.pieceCount)
  }
  const entries = new Set<string>()
  const ranges = new Map<
    PieceTableReverseIndexNode,
    { min: PieceTableReverseIndexNode; max: PieceTableReverseIndexNode }
  >()
  walkInspectionTree(
    snapshot.reverseIndexRoot,
    ({ node }) => {
      counts.reverseEntries++
      const id = label(node)
      checkPriority(node, id, report)
      checkReverseEntry(node, pieces, id, report)
      const key = inspectionPieceKey(node)
      if (entries.has(key)) report('reverse-index', id, 'key', 'unique buffer/start', key)
      entries.add(key)
    },
    (node) => {
      const left = node.left ? ranges.get(node.left) : undefined
      const right = node.right ? ranges.get(node.right) : undefined
      if (left && reverseCompare(left.max, node) >= 0)
        report(
          'ordering',
          label(node),
          'left.key',
          `< ${inspectionPieceKey(node)}`,
          inspectionPieceKey(left.max),
        )
      if (right && reverseCompare(right.min, node) <= 0)
        report(
          'ordering',
          label(node),
          'right.key',
          `> ${inspectionPieceKey(node)}`,
          inspectionPieceKey(right.min),
        )
      ranges.set(node, { min: left?.min ?? node, max: right?.max ?? node })
    },
    ({ node, parent, edge }, cycle) =>
      report(
        cycle ? 'cycle' : 'structure',
        parent ? label(parent) : label(node),
        edge,
        'tree child',
        label(node),
      ),
  )
  for (const [key, node] of pieces) {
    if (node.piece.length > 0 && !entries.has(key))
      report('reverse-index', label(node), 'reverseEntry', key, 'missing')
  }
  for (const [buffer, index] of snapshot.buffers.lineIndexes ?? []) {
    counts.lineIndexes++
    checkLineIndex(index, buffer, report)
  }
  return Object.freeze({ issues: Object.freeze(issues), counts: Object.freeze(counts) })
}
