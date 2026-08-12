import { describe, expect, it } from 'vitest'

import {
  workspaceEditForDocument,
  workspaceEditPlan,
  workspaceEditTouchesOtherDocuments,
} from '../src/workspaceEdit'

const edit = (newText: string) => ({
  newText,
  range: { end: { character: 1, line: 0 }, start: { character: 0, line: 0 } },
})

describe('workspaceEditPlan', () => {
  it('reads the legacy changes map', () => {
    const plan = workspaceEditPlan({ changes: { 'file:///a.ts': [edit('x')] } })

    expect(plan.documents).toEqual([{ edits: [edit('x')], uri: 'file:///a.ts' }])
    expect(plan.resourceOperations).toEqual([])
  })

  it('reads documentChanges', () => {
    const plan = workspaceEditPlan({
      documentChanges: [{ edits: [edit('x')], textDocument: { uri: 'file:///a.ts', version: 3 } }],
    })

    expect(plan.documents).toEqual([{ edits: [edit('x')], uri: 'file:///a.ts' }])
  })

  // A client that cannot create or delete files must refuse the whole edit, not apply half of it.
  it('separates resource operations from text edits', () => {
    const plan = workspaceEditPlan({
      documentChanges: [
        { kind: 'create', uri: 'file:///new.ts' },
        { edits: [edit('x')], textDocument: { uri: 'file:///a.ts', version: 1 } },
      ],
    })

    expect(plan.resourceOperations).toEqual(['create'])
    expect(plan.documents).toHaveLength(1)
  })

  it('has nothing to do for an absent edit', () => {
    expect(workspaceEditPlan(null)).toEqual({ documents: [], resourceOperations: [] })
    expect(workspaceEditPlan({})).toEqual({ documents: [], resourceOperations: [] })
  })
})

describe('workspaceEditTouchesOtherDocuments', () => {
  it('is false for an edit confined to one document', () => {
    const plan = workspaceEditPlan({ changes: { 'file:///a.ts': [edit('x')] } })

    expect(workspaceEditTouchesOtherDocuments(plan, 'file:///a.ts')).toBe(false)
  })

  it('is true when another document is edited', () => {
    const plan = workspaceEditPlan({
      changes: { 'file:///a.ts': [edit('x')], 'file:///b.ts': [edit('y')] },
    })

    expect(workspaceEditTouchesOtherDocuments(plan, 'file:///a.ts')).toBe(true)
  })

  it('ignores another document listed with no edits', () => {
    const plan = workspaceEditPlan({ changes: { 'file:///a.ts': [edit('x')], 'file:///b.ts': [] } })

    expect(workspaceEditTouchesOtherDocuments(plan, 'file:///a.ts')).toBe(false)
  })

  it('is true for any resource operation', () => {
    const plan = workspaceEditPlan({ documentChanges: [{ kind: 'delete', uri: 'file:///a.ts' }] })

    expect(workspaceEditTouchesOtherDocuments(plan, 'file:///a.ts')).toBe(true)
  })
})

describe('workspaceEditForDocument', () => {
  it('picks out one document edit set', () => {
    const plan = workspaceEditPlan({
      changes: { 'file:///a.ts': [edit('x')], 'file:///b.ts': [edit('y')] },
    })

    expect(workspaceEditForDocument(plan, 'file:///b.ts')).toEqual([edit('y')])
  })

  it('is empty for a document the edit does not mention', () => {
    expect(workspaceEditForDocument(workspaceEditPlan({}), 'file:///a.ts')).toEqual([])
  })
})
