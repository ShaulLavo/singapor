export {
  applyEditorTheme,
  darkenEditorColor,
  editorColorReference,
  editorColorValue,
  editorThemesEqual,
  firstEditorColor,
  lightenEditorColor,
  mergeEditorThemes,
  registerEditorColor,
  transparentEditorColor,
} from '../theme'
export type {
  EditorColorDefaults,
  EditorColorId,
  EditorColorTransform,
  EditorColorValue,
  EditorThemeType,
} from '../theme'
export {
  createInlineMap,
  inlineReplacementsForBufferRow,
  inlineRowForBufferRow,
  revealInlineMap,
  updateInlineMapForEdit,
} from '../inlineMap'
export type {
  InlineMap,
  InlineMapUpdate,
  InlineReplacementRange,
  InlineReplacementSpec,
} from '../inlineMap'
export type {
  InlineColumnRange,
  InlineReplacement,
  InlineRow,
  InlineRowSegment,
} from '../displayTransforms'
export type {
  BoundedSize,
  EditorBlock,
  EditorBlockAnchor,
  EditorBlockHorizontalSurface,
  EditorBlockMount,
  EditorBlockMountContext,
  EditorBlockProvider,
  EditorBlockProviderContext,
  EditorBlockSize,
  EditorBlockSurfaceSlot,
  EditorBlockVerticalSurface,
  FixedSize,
  MaxSize,
  MinSize,
} from '../editorBlocks'
export type { EditorSyntaxTheme, EditorSyntaxThemeColor, EditorTheme } from '../theme'
export type {
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
  VirtualizedFoldMarker,
  VirtualizedTextHighlightRange,
  VirtualizedTextHighlightStyle,
  VirtualizedTextRowDecoration,
} from '../virtualization'
