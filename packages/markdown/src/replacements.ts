import type { EditorSyntaxCapture } from '@singapor/core/syntax'
import type { InlineReplacementSpec } from '@singapor/core/rendering'

/**
 * Turns Tree-sitter markdown captures into the inline replacements a live-preview view renders.
 *
 * The `markdown` and `markdown_inline` highlight queries already mark every piece of syntax this
 * needs, but they name things generically — `punctuation.delimiter` covers both emphasis fences and
 * link brackets. So constructs are recovered structurally instead: by containment for emphasis and
 * code spans, and by adjacency for links and images. Anything that does not match its expected shape
 * is left alone, so malformed markdown renders as plain text rather than losing characters.
 */
export function markdownInlineReplacements(
  text: string,
  captures: readonly EditorSyntaxCapture[],
): readonly InlineReplacementSpec[] {
  const sorted = captures
    .filter((capture) => capture.endIndex > capture.startIndex)
    .toSorted((left, right) => left.startIndex - right.startIndex || right.endIndex - left.endIndex)

  const index = createCaptureIndex(sorted)
  const specs: InlineReplacementSpec[] = []
  appendDelimitedSpanReplacements(specs, text, sorted, index)
  appendBlockMarkerReplacements(specs, text, sorted)
  appendLinkReplacements(specs, sorted, index)
  return specs
}

type CaptureIndex = {
  readonly delimitersByStart: ReadonlyMap<number, EditorSyntaxCapture>
  readonly delimitersByEnd: ReadonlyMap<number, EditorSyntaxCapture>
  readonly urisByStart: ReadonlyMap<number, EditorSyntaxCapture>
  readonly delimiters: readonly EditorSyntaxCapture[]
}

const DELIMITED_SPAN_CAPTURES = new Set(['text.strong', 'text.emphasis', 'text.literal'])
const HEADING_MARKER = /^#{1,6}$/
const BULLET_MARKER = /^[-*+](\s*)$/

const createCaptureIndex = (captures: readonly EditorSyntaxCapture[]): CaptureIndex => {
  const delimitersByStart = new Map<number, EditorSyntaxCapture>()
  const delimitersByEnd = new Map<number, EditorSyntaxCapture>()
  const urisByStart = new Map<number, EditorSyntaxCapture>()
  const delimiters: EditorSyntaxCapture[] = []

  for (const capture of captures) {
    if (capture.captureName === 'text.uri') {
      if (!urisByStart.has(capture.startIndex)) urisByStart.set(capture.startIndex, capture)
      continue
    }

    if (capture.captureName !== 'punctuation.delimiter') continue
    delimiters.push(capture)
    if (!delimitersByStart.has(capture.startIndex))
      delimitersByStart.set(capture.startIndex, capture)
    if (!delimitersByEnd.has(capture.endIndex)) delimitersByEnd.set(capture.endIndex, capture)
  }

  return { delimitersByStart, delimitersByEnd, urisByStart, delimiters }
}

/**
 * `**bold**`, `*em*`, and `` `code` ``: the span capture wraps the whole construct and its fences are
 * the `punctuation.delimiter` captures inside it. Containment gives the grouping for free, so both
 * fences reveal together when the caret lands anywhere between them.
 *
 * Multi-line spans are skipped: `text.literal` also covers fenced and indented code blocks, whose
 * "delimiters" are whole fence lines that must not collapse to nothing.
 */
const appendDelimitedSpanReplacements = (
  specs: InlineReplacementSpec[],
  text: string,
  captures: readonly EditorSyntaxCapture[],
  index: CaptureIndex,
): void => {
  for (const span of captures) {
    if (!DELIMITED_SPAN_CAPTURES.has(span.captureName)) continue
    if (spansMultipleLines(text, span)) continue

    const groupId = `span:${span.startIndex}:${span.endIndex}`
    for (const delimiter of delimitersWithin(index.delimiters, span)) {
      specs.push(hidden(delimiter.startIndex, delimiter.endIndex, 'marker', groupId))
    }
  }
}

/**
 * `punctuation.special` is shared by heading markers, list bullets, thematic breaks, setext
 * underlines, and block-quote markers, so they are told apart by their own text. Heading markers hide
 * along with the space that follows them; bullets are substituted width-for-width so nothing shifts.
 */
const appendBlockMarkerReplacements = (
  specs: InlineReplacementSpec[],
  text: string,
  captures: readonly EditorSyntaxCapture[],
): void => {
  for (const capture of captures) {
    if (capture.captureName !== 'punctuation.special') continue

    const markerText = text.slice(capture.startIndex, capture.endIndex)
    if (HEADING_MARKER.test(markerText)) {
      const end = capture.endIndex + leadingSpaceCount(text, capture.endIndex)
      specs.push(hidden(capture.startIndex, end, 'heading-marker', `heading:${capture.startIndex}`))
      continue
    }

    const bullet = BULLET_MARKER.exec(markerText)
    if (!bullet) continue
    specs.push({
      id: `bullet:${capture.startIndex}`,
      startIndex: capture.startIndex,
      endIndex: capture.endIndex,
      text: `•${bullet[1] ?? ''}`,
      kind: 'list-marker',
      groupId: `bullet:${capture.startIndex}`,
    })
  }
}

/**
 * `[label](target)` and `![alt](target)`. The queries capture each bracket separately and never mark
 * the link node itself, so the construct is rebuilt outwards from its label by adjacency. A link only
 * collapses when every expected piece is touching its neighbour.
 */
const appendLinkReplacements = (
  specs: InlineReplacementSpec[],
  captures: readonly EditorSyntaxCapture[],
  index: CaptureIndex,
): void => {
  for (const label of captures) {
    if (label.captureName !== 'text.reference') continue

    const open = index.delimitersByEnd.get(label.startIndex)
    const close = index.delimitersByStart.get(label.endIndex)
    if (!open || !close) continue

    const groupId = `link:${label.startIndex}:${label.endIndex}`
    const bang = index.delimitersByEnd.get(open.startIndex)
    specs.push(hidden(bang?.startIndex ?? open.startIndex, open.endIndex, 'link-marker', groupId))
    specs.push(
      hidden(
        close.startIndex,
        linkTargetEnd(index, close.endIndex) ?? close.endIndex,
        'link-target',
        groupId,
      ),
    )
  }
}

/** End of the `(target)` run following a label's closing bracket, or null when it is not one. */
const linkTargetEnd = (index: CaptureIndex, closeEnd: number): number | null => {
  const open = index.delimitersByStart.get(closeEnd)
  if (!open) return null

  const destination = index.urisByStart.get(open.endIndex)
  if (!destination) return null

  return index.delimitersByStart.get(destination.endIndex)?.endIndex ?? null
}

const delimitersWithin = (
  delimiters: readonly EditorSyntaxCapture[],
  span: EditorSyntaxCapture,
): readonly EditorSyntaxCapture[] => {
  const within: EditorSyntaxCapture[] = []

  for (const delimiter of delimiters) {
    if (delimiter.startIndex >= span.endIndex) break
    if (delimiter.startIndex < span.startIndex) continue
    if (delimiter.endIndex > span.endIndex) continue
    within.push(delimiter)
  }

  return within
}

const hidden = (
  startIndex: number,
  endIndex: number,
  kind: string,
  groupId: string,
): InlineReplacementSpec => ({
  id: `${kind}:${startIndex}:${endIndex}`,
  startIndex,
  endIndex,
  text: '',
  kind,
  groupId,
})

const spansMultipleLines = (text: string, capture: EditorSyntaxCapture): boolean =>
  text.slice(capture.startIndex, capture.endIndex).includes('\n')

const leadingSpaceCount = (text: string, offset: number): number => {
  let count = 0
  while (text[offset + count] === ' ') count += 1
  return count
}
