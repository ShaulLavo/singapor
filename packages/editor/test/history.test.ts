import { describe, expect, it } from 'vitest'

import {
  commitEditorHistory,
  createEditorHistory,
  redoEditorHistory,
  undoEditorHistory,
  type EditorHistory,
  type EditorHistoryStack,
} from '../src/history'

type Snapshot = { readonly id: number }
type Selections = { readonly caret: number }
type History = EditorHistory<Snapshot, Selections>

// Everything below counts in literals rather than in MAX_UNDO_DEPTH: a test that
// derives its expectations from the constant it is guarding passes for any value
// of it, which is exactly the typo the cap has to be protected from.
const CAP = 200
const OVERSHOOT = 50
const COMMITS = CAP + OVERSHOOT

const commitRange = (
  count: number,
): { history: History; snapshots: Snapshot[]; selections: Selections[] } => {
  const snapshots: Snapshot[] = [{ id: 0 }]
  const selections: Selections[] = [{ caret: 0 }]
  let history = createEditorHistory<Snapshot, Selections>(snapshots[0]!, selections[0]!)

  for (let id = 1; id <= count; id += 1) {
    const snapshot = { id }
    const selection = { caret: id }
    snapshots.push(snapshot)
    selections.push(selection)
    history = commitEditorHistory(history, snapshot, selection)
  }

  return { history, snapshots, selections }
}

const stackNodes = (stack: EditorHistoryStack<Snapshot, Selections>) => {
  const nodes: NonNullable<EditorHistoryStack<Snapshot, Selections>>[] = []
  for (let node = stack; node; node = node.previous) nodes.push(node)
  return nodes
}

// The point of the cap is releasing what it drops, which entry counts alone cannot
// show — a stale link anywhere in the record would keep the tail alive.
const isReachableFrom = (root: unknown, target: object): boolean => {
  const seen = new Set<object>()
  const pending: unknown[] = [root]

  while (pending.length > 0) {
    const value = pending.pop()
    if (value === target) return true
    if (typeof value !== 'object' || value === null || seen.has(value)) continue
    seen.add(value)
    pending.push(...Object.values(value))
  }

  return false
}

describe('editor history depth cap', () => {
  it('keeps the two hundred newest entries and drops everything older', () => {
    const { history, snapshots } = commitRange(COMMITS)
    const nodes = stackNodes(history.undo)

    // Committing snapshot N records the snapshot it replaced, so the entries run
    // from snapshots[COMMITS - 1] down to snapshots[0] before the cap applies.
    expect(nodes.map((node) => node.entry.snapshot)).toEqual(
      snapshots.slice(OVERSHOOT, COMMITS).reverse(),
    )
    expect(nodes[0]?.size).toBe(CAP)
    expect(nodes.at(-1)?.size).toBe(1)
  })

  it('releases the dropped snapshot and its selection from the history', () => {
    const { history, snapshots, selections } = commitRange(COMMITS)

    expect(isReachableFrom(history, snapshots[OVERSHOOT - 1]!)).toBe(false)
    expect(isReachableFrom(history, selections[OVERSHOOT - 1]!)).toBe(false)
    expect(isReachableFrom(history, snapshots[OVERSHOOT]!)).toBe(true)
    expect(isReachableFrom(history, selections[OVERSHOOT]!)).toBe(true)
  })

  it('stops offering undo once the retained entries are spent', () => {
    const { history, snapshots } = commitRange(COMMITS)

    let undone = history
    let steps = 0
    while (undone.undo) {
      undone = undoEditorHistory(undone)
      steps += 1
    }

    expect(steps).toBe(CAP)
    expect(undone.current).toBe(snapshots[OVERSHOOT])
    expect(undoEditorHistory(undone)).toBe(undone)
  })

  it('redoes everything the cap kept', () => {
    const { history, snapshots } = commitRange(COMMITS)

    let undone = history
    for (let step = 0; step < CAP; step += 1) undone = undoEditorHistory(undone)
    expect(undone.redo?.size).toBe(CAP)

    let redone = undone
    for (let step = 0; step < CAP; step += 1) redone = redoEditorHistory(redone)

    expect(redone.current).toBe(snapshots[COMMITS])
    expect(redone.undo?.size).toBe(CAP)
    expect(redoEditorHistory(redone)).toBe(redone)
  })
})
