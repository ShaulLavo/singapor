// Documents are stored LF-only, always. The line ending a document arrived
// with is recorded on the buffers so a host can round-trip it on save, but
// nothing downstream of ingestion ever sees a '\r' that terminates a line.
//
// This invariant is load-bearing: buffer line indexes scan for '\n' alone
// (buffers.ts), and the view derives a line end as `nextLineStart - 1`
// (virtualizedTextViewModel.ts). Without normalization a CRLF checkout puts a
// stray CR *inside* every rendered line, so End lands a column too far,
// selections and gutter widths are off by one, and the CR reaches the DOM.
// Normalizing once here is what keeps every one of those consumers correct
// without each re-solving it.

export type DocumentLineEnding = '\n' | '\r\n'

export const UTF8_BYTE_ORDER_MARK = '﻿'

export const DEFAULT_DOCUMENT_LINE_ENDING: DocumentLineEnding = '\n'

export type NormalizedDocumentText = {
  readonly text: string
  readonly lineEnding: DocumentLineEnding
  readonly byteOrderMark: string
}

const CARRIAGE_RETURN = 0x0d
const LINE_FEED = 0x0a
const BYTE_ORDER_MARK = 0xfeff

// Majority vote over the terminators actually present, matching Monaco's
// pieceTreeTextBufferBuilder `_getEOL`: a document is CRLF only when more than
// half its line endings carry a CR. Mixed-ending files therefore normalize to
// whichever form dominates rather than to whichever appeared first.
export const detectDocumentLineEnding = (
  text: string,
  fallback: DocumentLineEnding = DEFAULT_DOCUMENT_LINE_ENDING,
): DocumentLineEnding => {
  let carriageReturns = 0
  let lineFeeds = 0
  let pairs = 0

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === CARRIAGE_RETURN) {
      if (text.charCodeAt(index + 1) === LINE_FEED) {
        pairs++
        index++
      } else {
        carriageReturns++
      }
    } else if (code === LINE_FEED) {
      lineFeeds++
    }
  }

  const total = carriageReturns + lineFeeds + pairs
  if (total === 0) return fallback
  return carriageReturns + pairs > total / 2 ? '\r\n' : '\n'
}

// Collapses CRLF and lone CR to LF. Lone CR counts as a terminator because
// classic-Mac and mis-transcoded files use it, and leaving it in would make it
// an invisible in-line character rather than a line break.
export const normalizeLineEndings = (text: string): string =>
  text.includes('\r') ? text.replace(/\r\n|\r/g, '\n') : text

export const applyDocumentLineEnding = (text: string, lineEnding: DocumentLineEnding): string =>
  lineEnding === '\n' ? text : text.replace(/\n/g, '\r\n')

export const hasByteOrderMark = (text: string): boolean => text.charCodeAt(0) === BYTE_ORDER_MARK

// Ingestion boundary: strip a leading BOM into its own field and flatten line
// endings, reporting what was found so the host can restore both on save.
export const normalizeDocumentText = (
  text: string,
  fallback: DocumentLineEnding = DEFAULT_DOCUMENT_LINE_ENDING,
): NormalizedDocumentText => {
  const byteOrderMark = hasByteOrderMark(text) ? UTF8_BYTE_ORDER_MARK : ''
  const body = byteOrderMark === '' ? text : text.slice(1)
  return {
    text: normalizeLineEndings(body),
    lineEnding: detectDocumentLineEnding(body, fallback),
    byteOrderMark,
  }
}
