import { structuredPatch } from 'diff'

export type TextOffsetRange = {
  readonly start: number
  readonly end: number
}

export type MergeConflictSide = 'ours' | 'base' | 'theirs'

export type MergeConflictResolution = MergeConflictSide | 'both' | readonly MergeConflictSide[]

export type MergeConflictRegion = {
  readonly index: number
  readonly range: TextOffsetRange
  readonly startMarker: TextOffsetRange
  readonly baseMarker?: TextOffsetRange
  readonly separatorMarker: TextOffsetRange
  readonly endMarker: TextOffsetRange
  /** Zero-based buffer rows of the marker lines; whole-line decorations key on these. */
  readonly startMarkerLine: number
  readonly baseMarkerLine?: number
  readonly separatorMarkerLine: number
  readonly endMarkerLine: number
  readonly ours: TextOffsetRange
  readonly base?: TextOffsetRange
  readonly theirs: TextOffsetRange
  readonly oursLabel: string
  readonly baseLabel?: string
  readonly theirsLabel: string
}

export type MergeConflictResolutionResult = {
  readonly text: string
  readonly replacement: string
  readonly range: TextOffsetRange
  readonly selection: TextOffsetRange
}

export type CreateMergeConflictDocumentTextOptions = {
  readonly localPath: string
  readonly localText: string
  readonly remotePath?: string | null
  readonly remoteText: string | null
}

type LineRange = {
  readonly line: number
  readonly start: number
  readonly end: number
  readonly text: string
}

type PendingConflict = {
  readonly startMarker: LineRange
  readonly oursLabel: string
  oursEnd?: number
  baseMarker?: LineRange
  baseLabel?: string
  baseStart?: number
  baseEnd?: number
  separatorMarker?: LineRange
  theirsStart?: number
}

type ParsedPatchFile = {
  readonly hunks?: readonly ParsedPatchHunk[]
}

type ParsedPatchHunk = {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
}

type LineSlice = {
  readonly start: number
  readonly end: number
  readonly text: string
}

const DEFAULT_OURS_LABEL = 'HEAD'
const DEFAULT_THEIRS_LABEL = 'Incoming'
const LOCAL_CONFLICT_LABEL_PREFIX = 'Local: '
const REMOTE_CONFLICT_LABEL_PREFIX = 'Remote: '

export function parseMergeConflicts(text: string): readonly MergeConflictRegion[] {
  const conflicts: MergeConflictRegion[] = []
  let pending: PendingConflict | null = null

  for (const line of iterateLines(text)) {
    const startLabel = conflictMarkerLabel(line.text, '<<<<<<<')
    if (startLabel !== null) {
      pending = {
        startMarker: line,
        oursLabel: startLabel || DEFAULT_OURS_LABEL,
      }
      continue
    }

    if (!pending) continue
    if (readBaseMarker(pending, line)) continue
    if (readSeparatorMarker(pending, line)) continue

    const endLabel = conflictMarkerLabel(line.text, '>>>>>>>')
    if (endLabel === null) continue

    const conflict = completePendingConflict(conflicts.length, pending, line, endLabel)
    if (conflict) conflicts.push(conflict)
    pending = null
  }

  return conflicts
}

export function createMergeConflictDocumentText(
  options: CreateMergeConflictDocumentTextOptions,
): string {
  const remotePath = options.remotePath ?? options.localPath
  if (options.remoteText === null) return wholeFileConflictDocument(options, remotePath)
  if (options.localText === options.remoteText) return options.localText

  const hunks = changedPatchHunks(options, remotePath)
  if (hunks.length === 0) return options.localText

  return mergeConflictDocumentFromHunks(options, remotePath, hunks)
}

export function resolveMergeConflict(
  text: string,
  conflict: MergeConflictRegion,
  resolution: MergeConflictResolution,
): MergeConflictResolutionResult | null {
  const ranges = resolutionRanges(conflict, resolution)
  if (!ranges) return null

  const replacement = ranges.map((range) => text.slice(range.start, range.end)).join('')
  const resolvedText = `${text.slice(0, conflict.range.start)}${replacement}${text.slice(
    conflict.range.end,
  )}`
  const selectionOffset = conflict.range.start + replacement.length

  return {
    text: resolvedText,
    replacement,
    range: conflict.range,
    selection: {
      start: selectionOffset,
      end: selectionOffset,
    },
  }
}

function wholeFileConflictDocument(
  options: CreateMergeConflictDocumentTextOptions,
  remotePath: string,
): string {
  return conflictBlock(
    localConflictLabel(options.localPath),
    options.localText,
    remoteConflictLabel(remotePath),
    '',
  )
}

function changedPatchHunks(
  options: CreateMergeConflictDocumentTextOptions,
  remotePath: string,
): readonly ParsedPatchHunk[] {
  const patch = structuredPatch(
    options.localPath,
    remotePath,
    options.localText,
    options.remoteText ?? '',
    undefined,
    undefined,
    { context: 0 },
  ) as ParsedPatchFile

  return patch.hunks ?? []
}

function mergeConflictDocumentFromHunks(
  options: CreateMergeConflictDocumentTextOptions,
  remotePath: string,
  hunks: readonly ParsedPatchHunk[],
): string {
  const localLines = splitTextLineSlices(options.localText)
  const remoteLines = splitTextLineSlices(options.remoteText ?? '')
  const chunks: string[] = []
  let localOffset = 0

  for (const hunk of hunks) {
    const local = textSliceForHunk(options.localText, localLines, hunk.oldStart, hunk.oldLines)
    const remote = textSliceForHunk(
      options.remoteText ?? '',
      remoteLines,
      hunk.newStart,
      hunk.newLines,
    )
    chunks.push(options.localText.slice(localOffset, local.start))
    chunks.push(
      conflictBlock(
        localConflictLabel(options.localPath),
        local.text,
        remoteConflictLabel(remotePath),
        remote.text,
      ),
    )
    localOffset = local.end
  }

  chunks.push(options.localText.slice(localOffset))
  return chunks.join('')
}

function conflictBlock(
  localLabel: string,
  localText: string,
  remoteLabel: string,
  remoteText: string,
): string {
  return [
    `<<<<<<< ${localLabel}\n`,
    markerSectionText(localText),
    '=======\n',
    markerSectionText(remoteText),
    `>>>>>>> ${remoteLabel}\n`,
  ].join('')
}

function markerSectionText(text: string): string {
  if (text.length === 0) return ''
  if (text.endsWith('\n')) return text
  return `${text}\n`
}

function textSliceForHunk(
  text: string,
  lines: readonly LineSlice[],
  startLine: number,
  lineCount: number,
): LineSlice {
  const startIndex = Math.max(0, startLine - 1)
  const start = lines[startIndex]?.start ?? text.length
  if (lineCount === 0) return { start, end: start, text: '' }

  const endIndex = startIndex + lineCount - 1
  const end = lines[endIndex]?.end ?? text.length
  return {
    start,
    end,
    text: text.slice(start, end),
  }
}

function splitTextLineSlices(text: string): readonly LineSlice[] {
  const lines: LineSlice[] = []
  let start = 0
  while (start < text.length) {
    const end = nextLineEnd(text, start)
    lines.push({ start, end, text: text.slice(start, end) })
    start = end
  }

  return lines
}

function nextLineEnd(text: string, start: number): number {
  const newline = text.indexOf('\n', start)
  if (newline === -1) return text.length
  return newline + 1
}

function localConflictLabel(path: string): string {
  return `${LOCAL_CONFLICT_LABEL_PREFIX}${markerLabelPath(path)}`
}

function remoteConflictLabel(path: string): string {
  return `${REMOTE_CONFLICT_LABEL_PREFIX}${markerLabelPath(path)}`
}

function markerLabelPath(path: string): string {
  return path.replace(/[\r\n]+/g, ' ')
}

function readBaseMarker(pending: PendingConflict, line: LineRange): boolean {
  const baseLabel = conflictMarkerLabel(line.text, '|||||||')
  if (baseLabel === null) return false
  if (pending.separatorMarker) return false

  pending.oursEnd = line.start
  pending.baseMarker = line
  pending.baseLabel = baseLabel
  pending.baseStart = line.end
  return true
}

function readSeparatorMarker(pending: PendingConflict, line: LineRange): boolean {
  if (!line.text.startsWith('=======')) return false

  pending.oursEnd ??= line.start
  if (pending.baseStart !== undefined) pending.baseEnd = line.start
  pending.separatorMarker = line
  pending.theirsStart = line.end
  return true
}

function completePendingConflict(
  index: number,
  pending: PendingConflict,
  endMarker: LineRange,
  theirsLabel: string,
): MergeConflictRegion | null {
  if (pending.oursEnd === undefined) return null
  if (!pending.separatorMarker) return null
  if (pending.theirsStart === undefined) return null

  return {
    index,
    range: rangeFrom(pending.startMarker.start, endMarker.end),
    startMarker: lineToRange(pending.startMarker),
    baseMarker: pending.baseMarker ? lineToRange(pending.baseMarker) : undefined,
    separatorMarker: lineToRange(pending.separatorMarker),
    endMarker: lineToRange(endMarker),
    startMarkerLine: pending.startMarker.line,
    baseMarkerLine: pending.baseMarker?.line,
    separatorMarkerLine: pending.separatorMarker.line,
    endMarkerLine: endMarker.line,
    ours: rangeFrom(pending.startMarker.end, pending.oursEnd),
    base: baseRange(pending),
    theirs: rangeFrom(pending.theirsStart, endMarker.start),
    oursLabel: pending.oursLabel,
    baseLabel: pending.baseLabel,
    theirsLabel: theirsLabel || DEFAULT_THEIRS_LABEL,
  }
}

function baseRange(pending: PendingConflict): TextOffsetRange | undefined {
  if (pending.baseStart === undefined) return undefined
  if (pending.baseEnd === undefined) return undefined
  return rangeFrom(pending.baseStart, pending.baseEnd)
}

function resolutionRanges(
  conflict: MergeConflictRegion,
  resolution: MergeConflictResolution,
): readonly TextOffsetRange[] | null {
  if (resolution === 'both') return [conflict.ours, conflict.theirs]
  if (typeof resolution === 'string') return resolutionRange(conflict, resolution)
  return orderedResolutionRanges(conflict, resolution)
}

function orderedResolutionRanges(
  conflict: MergeConflictRegion,
  resolution: readonly MergeConflictSide[],
): readonly TextOffsetRange[] | null {
  const ranges: TextOffsetRange[] = []
  for (const side of resolution) {
    const range = rangeForSide(conflict, side)
    if (!range) return null
    ranges.push(range)
  }

  return ranges
}

function resolutionRange(
  conflict: MergeConflictRegion,
  side: MergeConflictSide,
): readonly TextOffsetRange[] | null {
  const range = rangeForSide(conflict, side)
  if (!range) return null
  return [range]
}

function rangeForSide(
  conflict: MergeConflictRegion,
  side: MergeConflictSide,
): TextOffsetRange | null {
  if (side === 'ours') return conflict.ours
  if (side === 'theirs') return conflict.theirs
  return conflict.base ?? null
}

function conflictMarkerLabel(line: string, marker: string): string | null {
  if (!line.startsWith(marker)) return null
  return line.slice(marker.length).trim()
}

function* iterateLines(text: string): Generator<LineRange> {
  let start = 0
  let line = 0
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const contentEnd = newline === -1 ? text.length : newline
    const end = newline === -1 ? text.length : newline + 1
    yield {
      line,
      start,
      end,
      text: text.slice(start, contentEnd),
    }
    start = end
    line += 1
  }
}

function lineToRange(line: LineRange): TextOffsetRange {
  return rangeFrom(line.start, line.end)
}

function rangeFrom(start: number, end: number): TextOffsetRange {
  return { start, end }
}
