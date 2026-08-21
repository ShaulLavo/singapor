import './style.css'

export { createDiffPlugin } from './editorDiffPlugin'
export { createDiffRegionStore } from './regions'
export { annotateInlineChanges } from './inline'
export { joinRenderLines } from './lines'
export { createLiveDiffProjection } from './liveProjection'
export { createTextDiff, parseGitPatch } from './model'
export { createSplitProjection, createStackedProjection } from './projection'
export { diffSyntaxBackend, projectDiffSyntaxTokens } from './diffSyntax'
export type { DiffPlugin, DiffPluginMode, DiffPluginOptions } from './editorDiffPlugin'
export type { DiffDocumentModeViolation } from './diffRows'
export type { DiffGutterSide } from './gutters'
export type { DiffRegionStore } from './regions'
export type { LiveDiffProjection } from './liveProjection'
export type {
  CreateTextDiffOptions,
  DiffFile,
  DiffFileChangeType,
  DiffHunk,
  DiffHunkLine,
  DiffInlineRange,
  DiffLineType,
  DiffRenderRow,
  DiffRenderRowType,
  DiffSyntaxBackend,
  DiffTextFile,
  ParseGitPatchOptions,
} from './types'
