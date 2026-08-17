import type { EditorSyntaxLanguageId, FoldRange } from '../syntax/session'
import { rejectCrossingFoldRanges } from './folds'

/** Lines a language marks an explicit region with, written as a comment in that language. */
type RegionMarkers = {
  readonly start: RegExp
  readonly end: RegExp
}

type FoldingRules = {
  /**
   * Whether a run of blank lines closes the block above it instead of trailing inside it. True where
   * a block *is* its indentation, because then the blank lines are all that separates it from what
   * follows; false where a closing token ends the block, because that token has not been reached yet.
   */
  readonly offSide: boolean
  readonly markers: RegionMarkers
}

type FoldLine = {
  /** Offset the line's text ends at, which is where a region starting or ending here is pinned. */
  readonly end: number
  /** Visible column the line's content starts at, or `BLANK_INDENT` when it has none. */
  readonly indent: number
  readonly marker: 'start' | 'end' | null
}

/**
 * A block still being extended as the walk moves up the document. `endAbove` is the row the block
 * above this one must stop before; `line` is where an explicit region began.
 */
type OpenRegion = {
  indent: number
  endAbove: number
  line: number
}

const BLANK_INDENT = -1
/** Sorts below every real indentation so an explicit region is never popped by one. */
const MARKER_INDENT = -2

/**
 * Region markers for a language whose comment syntax we do not know, which includes plain text.
 * Accepting any of the usual comment openers costs nothing — a line has to say `region` after one to
 * match — and it is the difference between markers working and not working in an unnamed file.
 */
const DEFAULT_REGION_MARKERS: RegionMarkers = {
  start: /^\s*(?:\/\/|\/\*|#|--|;|%|<!--)\s*#?region\b/,
  end: /^\s*(?:\/\/|\/\*|#|--|;|%|<!--)\s*#?endregion\b/,
}

const SLASH_REGION_MARKERS: RegionMarkers = {
  start: /^\s*\/\/\s*#?region\b/,
  end: /^\s*\/\/\s*#?endregion\b/,
}

const BLOCK_REGION_MARKERS: RegionMarkers = {
  start: /^\s*\/\*\s*#?region\b/,
  end: /^\s*\/\*\s*#?endregion\b/,
}

const HTML_REGION_MARKERS: RegionMarkers = {
  start: /^\s*<!--\s*#?region\b/,
  end: /^\s*<!--\s*#?endregion\b/,
}

const HASH_REGION_MARKERS: RegionMarkers = {
  start: /^\s*#\s*region\b/,
  end: /^\s*#\s*endregion\b/,
}

const BRACE_FOLDING_RULES: FoldingRules = { offSide: false, markers: SLASH_REGION_MARKERS }
const BLOCK_COMMENT_FOLDING_RULES: FoldingRules = { offSide: false, markers: BLOCK_REGION_MARKERS }
const TAG_FOLDING_RULES: FoldingRules = { offSide: false, markers: HTML_REGION_MARKERS }
const INDENTED_FOLDING_RULES: FoldingRules = { offSide: true, markers: HASH_REGION_MARKERS }
const PROSE_FOLDING_RULES: FoldingRules = { offSide: true, markers: HTML_REGION_MARKERS }

/**
 * Off-side is the default because a document we cannot name is indistinguishable from prose, where a
 * blank line reads as a separator. Languages that close their blocks with a token say so here.
 */
const DEFAULT_FOLDING_RULES: FoldingRules = { offSide: true, markers: DEFAULT_REGION_MARKERS }

const FOLDING_RULES_BY_LANGUAGE: Record<string, FoldingRules> = {
  css: BLOCK_COMMENT_FOLDING_RULES,
  html: TAG_FOLDING_RULES,
  javascript: BRACE_FOLDING_RULES,
  javascriptreact: BRACE_FOLDING_RULES,
  json: BRACE_FOLDING_RULES,
  jsonc: BRACE_FOLDING_RULES,
  jsx: BRACE_FOLDING_RULES,
  markdown: PROSE_FOLDING_RULES,
  md: PROSE_FOLDING_RULES,
  python: INDENTED_FOLDING_RULES,
  scss: BRACE_FOLDING_RULES,
  ts: BRACE_FOLDING_RULES,
  tsx: BRACE_FOLDING_RULES,
  typescript: BRACE_FOLDING_RULES,
  typescriptreact: BRACE_FOLDING_RULES,
  yaml: INDENTED_FOLDING_RULES,
  yml: INDENTED_FOLDING_RULES,
}

/**
 * Regions to fold by when nothing that reads a grammar has an answer — the document has no grammar,
 * or its first parse has not landed yet.
 */
export function fallbackFoldRanges(context: EditorFoldRangeContext): readonly FoldRange[] {
  // The fan-in downstream refuses a set that crosses itself.
  return rejectCrossingFoldRanges(indentationFoldRanges(context)).folds
}

/** What the indentation walk needs to describe a document it has no grammar for. */
export type EditorFoldRangeContext = {
  readonly text: string
  readonly languageId: string | null
  readonly tabSize: number
}

/**
 * Every line whose followers are indented past it heads a region, which runs to the last of them.
 *
 * The document is walked bottom-up against a stack of blocks still looking for their header, because
 * that is the order in which a block's end is already known by the time its header appears: the row
 * above the shallowest thing seen since. Explicit region markers ride the same stack under an
 * indentation no real line can have, so a marked region outranks indentation instead of competing
 * with it.
 */
function indentationFoldRanges(context: EditorFoldRangeContext): readonly FoldRange[] {
  const rules = foldingRulesForLanguage(context.languageId)
  // One scan of the buffer for the word every marker has to contain keeps documents that hold none —
  // nearly all of them — off the per-line matching path, which this runs on every keystroke.
  const markers = context.text.includes('region') ? rules.markers : null
  const lines = foldLines(context.text, context.tabSize, markers)
  const folds: FoldRange[] = []
  const open: OpenRegion[] = [{ indent: BLANK_INDENT, endAbove: lines.length, line: lines.length }]

  for (let row = lines.length - 1; row >= 0; row -= 1) {
    const line = lines[row]!
    let below = open.at(-1)!

    if (line.indent === BLANK_INDENT) {
      if (rules.offSide) below.endAbove = row
      continue
    }

    if (line.marker === 'end') {
      open.push({ indent: MARKER_INDENT, endAbove: row, line: row })
      continue
    }

    if (line.marker === 'start') {
      const markerIndex = innermostMarkerIndex(open)
      if (markerIndex > 0) {
        // Blocks opened between the two markers never got a header and are dropped with the stack.
        open.length = markerIndex + 1
        below = open[markerIndex]!
        folds.push(foldRange(lines, row, below.line, 'region', context.languageId))
        below.indent = line.indent
        below.endAbove = row
        below.line = row
        continue
      }
      // No closing marker below, so the line has nothing to mark and folds by its indentation.
    }

    if (below.indent > line.indent) {
      do {
        open.pop()
        below = open.at(-1)!
      } while (below.indent > line.indent)

      const endRow = below.endAbove - 1
      if (endRow > row) folds.push(foldRange(lines, row, endRow, 'indent', context.languageId))
    }

    if (below.indent === line.indent) {
      below.endAbove = row
      continue
    }

    open.push({ indent: line.indent, endAbove: row, line: row })
  }

  return folds
}

function foldingRulesForLanguage(languageId: EditorSyntaxLanguageId | null): FoldingRules {
  if (!languageId) return DEFAULT_FOLDING_RULES

  return FOLDING_RULES_BY_LANGUAGE[languageId.trim().toLowerCase()] ?? DEFAULT_FOLDING_RULES
}

function innermostMarkerIndex(open: readonly OpenRegion[]): number {
  let index = open.length - 1
  while (index > 0 && open[index]!.indent !== MARKER_INDENT) index -= 1

  return index
}

/**
 * Both ends sit at the end of a row's text rather than at its start, so the header row stays visible
 * when the region collapses and the last row of the body is the last one hidden.
 */
function foldRange(
  lines: readonly FoldLine[],
  startRow: number,
  endRow: number,
  type: 'indent' | 'region',
  languageId: EditorSyntaxLanguageId | null,
): FoldRange {
  return {
    startIndex: lines[startRow]!.end,
    endIndex: lines[endRow]!.end,
    startLine: startRow,
    endLine: endRow,
    type,
    ...(languageId ? { languageId } : {}),
  }
}

function foldLines(
  text: string,
  tabSize: number,
  markers: RegionMarkers | null,
): readonly FoldLine[] {
  const lines: FoldLine[] = []
  let start = 0

  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && text[index] !== '\n') continue

    const indent = visibleIndent(text, start, index, tabSize)
    lines.push({
      end: index,
      indent,
      marker:
        markers && indent !== BLANK_INDENT ? lineMarker(text.slice(start, index), markers) : null,
    })
    start = index + 1
  }

  return lines
}

function lineMarker(lineText: string, markers: RegionMarkers): FoldLine['marker'] {
  if (markers.start.test(lineText)) return 'start'
  if (markers.end.test(lineText)) return 'end'

  return null
}

/**
 * Measured in columns rather than characters so a tab-indented line and a space-indented one nest the
 * way they look on screen.
 */
function visibleIndent(text: string, start: number, end: number, tabSize: number): number {
  let column = 0

  for (let index = start; index < end; index += 1) {
    const character = text[index]
    if (character === ' ') {
      column += 1
      continue
    }
    if (character !== '\t') return column

    column += tabSize - (column % tabSize)
  }

  return BLANK_INDENT
}
