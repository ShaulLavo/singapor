import './style.css'

export { DiffView } from './DiffView'
export { createEditorDiffPlugin } from './editorDiffPlugin'
export { annotateInlineChanges } from './inline'
export { createLiveDiffProjection } from './liveProjection'
export { createTextDiff, parseGitPatch } from './model'
export { createSplitProjection, createStackedProjection } from './projection'
export type { EditorDiffPlugin } from './editorDiffPlugin'
export type { LiveDiffProjection } from './liveProjection'
export type {
  CreateTextDiffOptions,
  DiffFile,
  DiffFileChangeType,
  DiffHunk,
  DiffHunkLocation,
  DiffHunkLine,
  DiffInlineRange,
  DiffLineType,
  DiffRenderRow,
  DiffRenderRowType,
  DiffSplitHandleContext,
  DiffSplitPaneId,
  DiffSplitPaneLayout,
  DiffSplitPaneOptions,
  DiffSyntaxBackend,
  DiffSyntaxTokens,
  DiffTextFile,
  DiffViewMode,
  DiffViewOptions,
  ParseGitPatchOptions,
} from './types'
