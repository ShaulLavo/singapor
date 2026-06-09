import { describe, expect, it } from 'vitest'

import * as core from '@singapor/core'
import {
  createPieceTableSnapshot,
  materializePieceTableFullText,
  readPieceTableTextRange,
  wordRangeAtOffset,
  type TextEdit,
} from '@singapor/core/document'
import { Editor } from '@singapor/core/editor'
import {
  createEditorCapabilityToken,
  EDITOR_FIND_FEATURE,
  EDITOR_FIND_FEATURE_ID,
  type EditorFindFeature,
  EDITOR_MINIMAP_FEATURE,
  EDITOR_MINIMAP_FEATURE_ID,
  type EditorPluginContext,
} from '@singapor/core/extensions'
import { applyEditorTheme, type EditorTheme } from '@singapor/core/rendering'
import {
  EditorSecondaryTextView,
  EditorSecondaryViewScheduler,
} from '@singapor/core/secondary-views'
import { createEmptySyntaxResult, treeSitterCapturesToEditorTokens } from '@singapor/core/syntax'
import { EditorPluginHost } from '@singapor/core/testing'
import { debugPieceTable } from '@singapor/core/debug'
import { VirtualizedTextView } from '@singapor/core/internal'
import {
  createMergeConflictDocumentText,
  EDITOR_MERGE_CONFLICT_FEATURE,
  parseMergeConflicts,
  type EditorState,
  type MergeConflictRegion,
} from '@singapor/core'

describe('public API facade', () => {
  it('exports reviewed root entrypoints without internal debug surfaces', () => {
    const snapshot = createPieceTableSnapshot('abc')
    const edit: TextEdit = { from: 1, to: 2, text: 'B' }
    const state = { documentId: null } as EditorState

    expect(Editor).toBeTypeOf('function')
    expect(
      createMergeConflictDocumentText({
        localPath: 'file.ts',
        localText: 'abc',
        remotePath: 'file.ts',
        remoteText: 'abc',
      }),
    ).toBe('abc')
    expect(parseMergeConflicts('')).toEqual([])
    expect(EDITOR_MERGE_CONFLICT_FEATURE.id).toBe('editor.mergeConflicts')
    expect(materializePieceTableFullText(snapshot)).toBe('abc')
    expect(readPieceTableTextRange(snapshot, 1, 3)).toBe('bc')
    expect(wordRangeAtOffset('abc', 1)).toEqual({ start: 0, end: 3 })
    expect(edit).toEqual({ from: 1, to: 2, text: 'B' })
    expect({ index: 0 } as MergeConflictRegion).toMatchObject({ index: 0 })
    expect(state.documentId).toBeNull()
    expect('debugPieceTable' in core).toBe(false)
    expect('VirtualizedTextView' in core).toBe(false)
    expect('EditorPluginHost' in core).toBe(false)
    expect('defineLazyTextProperty' in core).toBe(false)
    expect('getPieceTableText' in core).toBe(false)
    expect('createAnchorSelection' in core).toBe(false)
  })

  it('exposes named category entrypoints for public, test, internal, and debug consumers', () => {
    const host = new EditorPluginHost([])
    const syntax = createEmptySyntaxResult()
    const theme: EditorTheme = { foregroundColor: 'red' }
    const token = createEditorCapabilityToken('test.capability')
    const findFeature = {
      openFind: () => false,
      toggleFind: () => false,
      openFindReplace: () => false,
      closeFind: () => false,
      findNext: () => false,
      findPrevious: () => false,
      replaceOne: () => false,
      replaceAll: () => false,
      selectAllMatches: () => false,
    } satisfies EditorFindFeature

    expect(EDITOR_FIND_FEATURE_ID).toBe('editor.find')
    expect(EDITOR_FIND_FEATURE.id).toBe('editor.find')
    expect(EDITOR_MINIMAP_FEATURE_ID).toBe('editor.minimap')
    expect(EDITOR_MINIMAP_FEATURE.id).toBe('editor.minimap')
    expect(findFeature.openFind()).toBe(false)
    expect(token.id).toBe('test.capability')
    expect(applyEditorTheme).toBeTypeOf('function')
    expect(theme.foregroundColor).toBe('red')
    expect(treeSitterCapturesToEditorTokens([])).toEqual([])
    expect(syntax.tokens).toEqual([])
    expect(debugPieceTable(createPieceTableSnapshot('abc')).length).toBeGreaterThan(0)
    expect(VirtualizedTextView).toBeTypeOf('function')
    expect(EditorSecondaryTextView).toBeTypeOf('function')
    expect(EditorSecondaryViewScheduler).toBeTypeOf('function')
    expect({} as EditorPluginContext).toMatchObject({})
    host.dispose()
  })
})
