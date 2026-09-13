import { describe, expect, it } from 'vitest'
import { validatePieceTreeInvariants } from '../src/pieceTable/inspection'
import { createPieceTreeInspectionSession } from '../src/pieceTable/inspectionSession'
import { formatPieceTree } from '../src/pieceTable/inspectionFormat'
import { createPieceTableSnapshot, createSnapshot } from '../src/pieceTable/snapshot'
import { materializePieceTableFullText } from '../src/pieceTable/reads'
import { deleteFromPieceTable, insertIntoPieceTable } from '../src/pieceTable/edits'
import { createNode, merge, normalizePieceOrders } from '../src/pieceTable/tree'
import { buildReverseIndex } from '../src/pieceTable/reverseIndex'
import type { PieceTableSnapshot, PieceTreeNode } from '../src/pieceTable/pieceTableTypes'

function control(): PieceTableSnapshot {
  const base = createPieceTableSnapshot('a\nb\n')
  const buffer = base.buffers.original
  const left = createNode(
    { buffer, start: 0, length: 2, order: 1, lineBreaks: 1, visible: true },
    null,
    null,
    2,
  )
  const root = createNode(
    { buffer, start: 2, length: 2, order: 2, lineBreaks: 1, visible: false },
    left,
    null,
    1,
  )
  return { ...base, root, reverseIndexRoot: buildReverseIndex(root), length: 2, pieceCount: 2 }
}

function churn(count: number): PieceTableSnapshot {
  let snapshot = createPieceTableSnapshot('line\n'.repeat(200), { prioritySeed: 7 })
  let expected = 'line\n'.repeat(200)
  let seed = 123
  for (let i = 0; i < count; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const offset = seed % (snapshot.length + 1)
    const text = `${i}\n`
    snapshot = insertIntoPieceTable(snapshot, offset, text)
    expected = expected.slice(0, offset) + text + expected.slice(offset)
    if (i % 3 === 0) {
      snapshot = deleteFromPieceTable(snapshot, offset, 1)
      expected = expected.slice(0, offset) + expected.slice(offset + 1)
    }
    expect(materializePieceTableFullText(snapshot)).toBe(expected)
    expect(validatePieceTreeInvariants(snapshot).issues, `edit ${i}`).toEqual([])
  }
  return snapshot
}

describe('piece tree inspection', () => {
  it('checks hand-calculated visible and tombstone aggregates', () => {
    const snapshot = control()
    expect(snapshot.root).toMatchObject({
      subtreeLength: 4,
      subtreeVisibleLength: 2,
      subtreePieces: 2,
      subtreeLineBreaks: 1,
      subtreeMinOrder: 1,
      subtreeMaxOrder: 2,
    })
    expect(validatePieceTreeInvariants(snapshot)).toEqual({
      issues: [],
      counts: { nodes: 2, visible: 1, invisible: 1, reverseEntries: 2, lineIndexes: 1 },
    })
  })

  it.each([
    'subtreeLength',
    'subtreeVisibleLength',
    'subtreePieces',
    'subtreeLineBreaks',
    'subtreeMinOrder',
    'subtreeMaxOrder',
  ] as const)('identifies a corrupt %s independently of child caches', (field) => {
    const snapshot = control()
    const expected = snapshot.root![field]
    snapshot.root![field] = 99
    const session = createPieceTreeInspectionSession()
    expect(validatePieceTreeInvariants(snapshot, session.label).issues).toContainEqual({
      kind: 'aggregate',
      node: session.label(snapshot.root!),
      field,
      expected,
      actual: 99,
    })
  })

  it('does not propagate a corrupted child cache into expected parent sums', () => {
    const snapshot = control()
    snapshot.root!.left!.subtreeVisibleLength = 100
    const issues = validatePieceTreeInvariants(snapshot).issues
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ field: 'subtreeVisibleLength', expected: 2, actual: 100 })
  })

  it('detects missing reverse entries and semantic disagreement without requiring pointer equality', () => {
    const snapshot = createPieceTableSnapshot('abc')
    const reverse = snapshot.reverseIndexRoot!
    reverse.piece = { ...reverse.piece }
    expect(validatePieceTreeInvariants(snapshot).issues).toEqual([])
    reverse.piece = { ...reverse.piece, visible: false }
    expect(validatePieceTreeInvariants(snapshot).issues).toContainEqual(
      expect.objectContaining({
        kind: 'reverse-index',
        field: 'piece.visible',
        expected: true,
        actual: false,
      }),
    )
    expect(
      validatePieceTreeInvariants({ ...snapshot, reverseIndexRoot: null }).issues,
    ).toContainEqual(expect.objectContaining({ field: 'reverseEntry', actual: 'missing' }))
  })

  it('reports reverse key ordering and missing buffers', () => {
    const snapshot = control()
    const reverse = snapshot.reverseIndexRoot!
    const child = reverse.left ?? reverse.right!
    child.start = reverse.start
    expect(validatePieceTreeInvariants(snapshot).issues).toContainEqual(
      expect.objectContaining({ kind: 'ordering' }),
    )
    const missing = { ...snapshot, buffers: { ...snapshot.buffers, chunks: new Map() } }
    expect(validatePieceTreeInvariants(missing).issues).toContainEqual(
      expect.objectContaining({ kind: 'buffer-bounds', field: 'piece.buffer' }),
    )
  })

  it('reports buffer bounds, line breaks and snapshot totals precisely', () => {
    const snapshot = control()
    snapshot.root!.piece = { ...snapshot.root!.piece, lineBreaks: 99 }
    expect(validatePieceTreeInvariants(snapshot).issues).toContainEqual(
      expect.objectContaining({ field: 'piece.lineBreaks', expected: 1, actual: 99 }),
    )
    snapshot.root!.piece = { ...snapshot.root!.piece, start: -1, length: 999 }
    const issues = validatePieceTreeInvariants({ ...snapshot, length: 123, pieceCount: 9 }).issues
    expect(issues).toEqual(
      expect.arrayContaining(
        ['piece.start', 'piece.length', 'length', 'pieceCount'].map((field) =>
          expect.objectContaining({ field }),
        ),
      ),
    )
  })

  it('catches order violations without consulting materialized text', () => {
    const snapshot = control()
    const text = materializePieceTableFullText(snapshot)
    snapshot.root!.left!.piece = { ...snapshot.root!.left!.piece, order: 3 }
    expect(materializePieceTableFullText(snapshot)).toBe(text)
    expect(validatePieceTreeInvariants(snapshot).issues).toContainEqual(
      expect.objectContaining({
        kind: 'ordering',
        field: 'left.order',
        expected: '< 2',
        actual: 3,
      }),
    )
  })

  it('accepts priority ties and checks both heap edges', () => {
    const snapshot = control()
    snapshot.root!.left!.priority = 1
    expect(validatePieceTreeInvariants(snapshot).issues).toEqual([])
    expect(
      merge(snapshot.root!.left, createNode(snapshot.root!.piece, null, null, 1))?.piece.order,
    ).toBe(2)
    snapshot.root!.left!.priority = 0
    expect(validatePieceTreeInvariants(snapshot).issues).toContainEqual(
      expect.objectContaining({ kind: 'priority', field: 'left.priority' }),
    )
    snapshot.reverseIndexRoot!.priority = Infinity
    expect(validatePieceTreeInvariants(snapshot).issues).toContainEqual(
      expect.objectContaining({ kind: 'priority', field: 'priority' }),
    )
  })

  it('reports cycles in either tree, repeated children and deep corruption iteratively', () => {
    const snapshot = control()
    snapshot.root!.right = snapshot.root
    snapshot.reverseIndexRoot!.right = snapshot.reverseIndexRoot
    expect(
      validatePieceTreeInvariants(snapshot).issues.filter((issue) => issue.kind === 'cycle'),
    ).toHaveLength(2)
    expect(() => formatPieceTree(snapshot)).not.toThrow()
    snapshot.root!.right = snapshot.root!.left
    expect(
      validatePieceTreeInvariants(snapshot).issues.some((issue) => issue.kind === 'structure'),
    ).toBe(true)
    let root: PieceTreeNode | null = null
    for (let i = 20000; i > 0; i--)
      root = createNode({ ...snapshot.root!.piece, order: i }, null, root, i)
    const deep = { ...snapshot, root, reverseIndexRoot: null }
    expect(() => validatePieceTreeInvariants(deep)).not.toThrow()
    expect(formatPieceTree(deep, { maxRows: 2 }).split('\n')).toHaveLength(4)
  })

  it('validates recorded line-index text, ignoring unused capacity and other branch text', () => {
    const snapshot = createPieceTableSnapshot('abc')
    const index = {
      offsets: new Uint32Array([1, 99, 99]),
      count: 1,
      scannedLength: 3,
      text: 'x\ny',
    }
    const cached = {
      ...snapshot,
      buffers: { ...snapshot.buffers, lineIndexes: new Map([[snapshot.buffers.original, index]]) },
    }
    expect(validatePieceTreeInvariants(cached).issues).toEqual([])
    index.offsets[0] = 2
    expect(validatePieceTreeInvariants(cached).issues).toContainEqual(
      expect.objectContaining({ kind: 'line-index', field: 'offsets[0]', expected: 1, actual: 2 }),
    )
    index.count = 0
    expect(validatePieceTreeInvariants(cached).issues).toContainEqual(
      expect.objectContaining({ field: 'count', expected: 1, actual: 0 }),
    )
  })

  it('prints stable empty, split, deleted and normalized snapshots with bounded opt-in text', () => {
    expect(formatPieceTree(createPieceTableSnapshot(''))).toBe(
      'piece tree length=0 pieces=0 nodes=0',
    )
    const initial = createPieceTableSnapshot('secret\ntext')
    const split = insertIntoPieceTable(initial, 3, 'x')
    const deleted = deleteFromPieceTable(split, 2, 5)
    const root = normalizePieceOrders(deleted.root, { value: 100 })
    const normalized = createSnapshot(deleted.buffers, root, buildReverseIndex(root))
    for (const [name, snapshot] of [
      ['initial', initial],
      ['split', split],
      ['deleted', deleted],
      ['normalized', normalized],
    ] as const) {
      expect(formatPieceTree(snapshot)).toMatchSnapshot(name)
      expect(formatPieceTree(snapshot)).not.toContain('text=')
      expect(validatePieceTreeInvariants(snapshot).issues).toEqual([])
    }
    expect(formatPieceTree(initial, { excerptLength: 3 })).toContain('text="sec"')
    expect(formatPieceTree(deleted)).toContain('tombstone')
    expect(formatPieceTree(control())).toMatchSnapshot()
  })

  it('distinguishes identity reuse from copies, preserves roots and caches during stress', () => {
    const before = churn(250)
    const dump = formatPieceTree(before, { maxRows: 10000 })
    const after = deleteFromPieceTable(before, 20, 5)
    const session = createPieceTreeInspectionSession()
    const result = session.compare(before, after)
    expect(result.changes.some((change) => change.kind === 'reused')).toBe(true)
    expect(result.changes.some((change) => change.kind === 'copied')).toBe(true)
    const whole = deleteFromPieceTable(before, 0, before.length)
    expect(
      session.compare(before, whole).changes.some((change) => change.fields.includes('visible')),
    ).toBe(true)
    expect(
      session.compare(before, before).changes.every((change) => change.kind === 'reused'),
    ).toBe(true)
    expect(validatePieceTreeInvariants(before).issues).toEqual([])
    expect(validatePieceTreeInvariants(after).issues).toEqual([])
    expect(formatPieceTree(before, { maxRows: 10000 })).toBe(dump)
    // Editing may extend caches; inspection must leave the post-edit cache values intact.
    const caches = [...(after.buffers.lineIndexes ?? [])].map(([key, value]) => [
      key,
      { ...value, offsets: value.offsets.slice() },
    ])
    session.inspect(after)
    validatePieceTreeInvariants(after)
    expect([...(after.buffers.lineIndexes ?? [])]).toEqual(caches)
    expect(Object.isFrozen(result.after.nodes[0]?.piece)).toBe(true)
    const copy = { ...before, root: { ...before.root! } }
    expect(session.compare(before, copy).changes).toContainEqual(
      expect.objectContaining({ kind: 'copied', fields: [] }),
    )
  })
})
