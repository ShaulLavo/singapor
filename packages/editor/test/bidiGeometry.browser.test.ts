import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../src/style.css'

import { createInlineMap } from '../src/inlineMap'
import { createPieceTableSnapshot } from '../src/public/document'
import {
  normalizeSuspiciousCharactersOptions,
  suspiciousCharacterRanges,
} from '../src/unicodeHighlight'
import { VirtualizedTextView } from '../src/virtualization'
import { BIDI_LINE_MEASUREMENT_CEILING } from '../src/virtualization/virtualizedTextViewRows'
import {
  boundaryPositionXs,
  domBoundaryForOffset,
  getRowGeometrySweepCount,
  measureRowContentWidth,
  offsetToX,
  resetRowGeometrySweepCount,
  unitRectForOffset,
  xToOffset,
} from '../src/virtualization/virtualizedTextViewGeometry'
import {
  BIDI_CORPUS,
  BIDI_CORPUS_NAMES,
  collapsedRangeOracle,
  glyphRectOracle,
  mergedRangeOracle,
  mountBidiGeometryFixture,
  mountSupplementaryBidiFixture,
  subjectRangeSegments,
  unsplitGlyphRectOracle,
  type BidiGeometryFixture,
  type OracleRect,
} from './bidiGeometryBrowserFixture'

const DIRECTION_BOUNDARIES = {
  pureHebrew: [],
  pureArabic: [],
  mixed: [8, 12],
  nested: [4, 7],
  tabRtl: [1],
  override: [3],
  latin: [],
} as const

describe.skipIf(typeof globalThis.Highlight === 'undefined')('BiDi geometry browser oracle', () => {
  let fixture: BidiGeometryFixture | null

  beforeEach(() => {
    fixture = mountBidiGeometryFixture()
  })

  afterEach(() => {
    fixture?.dispose()
    fixture = null
  })

  it('keeps a tab as U+0009 and advances it to the native tab stop', () => {
    const row = fixture!.rows.tabRtl
    const codePoints = Array.from(row.element.textContent ?? '', (char) => char.codePointAt(0))
    const tab = mergedRangeOracle(row, 0, 1)[0]
    const followingGlyph = mergedRangeOracle(row, 1, 2)[0]

    expect(codePoints).toContain(0x0009)
    expect(codePoints).not.toContain(0x2409)
    expect(tab).toBeDefined()
    expect(followingGlyph).toBeDefined()
    expect(tab!.width).toBeCloseTo(followingGlyph!.width * 4, 0)
  })

  it('keeps direction-boundary ambiguity visible in the collapsed-range oracle', () => {
    for (const name of BIDI_CORPUS_NAMES) {
      const row = fixture!.rows[name]
      const ambiguous = new Set<number>(DIRECTION_BOUNDARIES[name])
      for (let offset = 0; offset <= BIDI_CORPUS[name].length; offset += 1) {
        const rects = collapsedRangeOracle(row, offset)
        expect(rects.length, `${name} offset ${offset}`).toBe(ambiguous.has(offset) ? 2 : 1)
      }
    }
  })

  it('agrees with the editor geometry on the Latin control line', () => {
    const row = fixture!.rows.latin
    for (let offset = 0; offset <= row.text.length; offset += 1) {
      const oracle = collapsedRangeOracle(row, offset)[0]
      expect(oracle).toBeDefined()
      expect(offsetToX(fixture!.internal, row, row.startOffset + offset)).toBeCloseTo(
        oracle!.left,
        0,
      )
    }

    for (let start = 0; start < row.text.length; start += 1) {
      assertRectsClose(
        subjectRangeSegments(fixture!, row, start, row.text.length),
        mergedRangeOracle(row, start, row.text.length),
      )
    }
  })

  it('preserves each glyph position across the mounted row DOM structure', () => {
    for (const name of BIDI_CORPUS_NAMES) {
      const mounted = glyphRectOracle(fixture!.rows[name])
      const unsplit = unsplitGlyphRectOracle(fixture!.rows[name])
      expect(mounted).toHaveLength(unsplit.length)
      for (let index = 0; index < mounted.length; index += 1) {
        assertRectsClose(mounted[index]!.rects, unsplit[index]!.rects)
      }
    }
  })

  it('mounts the two supplementary element-boundary fixtures separately from the corpus', () => {
    const supplementary = mountSupplementaryBidiFixture()
    try {
      expect(
        supplementary.controlRow.chunks[0]!.parts.some((part) => part.kind === 'control'),
      ).toBe(true)
      expect(supplementary.widgetRow.chunks[0]!.parts.some((part) => part.kind === 'widget')).toBe(
        true,
      )
    } finally {
      supplementary.dispose()
    }
  })

  it('reads every BiDi boundary from the browser engine', () => {
    for (const name of BIDI_CORPUS_NAMES) {
      const row = fixture!.rows[name]
      for (let offset = 0; offset <= row.text.length; offset += 1) {
        const oracle = collapsedRangeOracle(row, offset)
        expect(oracle.length, `${name} offset ${offset}`).toBeGreaterThan(0)
        expect(offsetToX(fixture!.internal, row, row.startOffset + offset)).toBeCloseTo(
          Math.min(...oracle.map((rect) => rect.left)),
          0,
        )
      }
    }
  })

  it('removes every single-position boundary collision and pins the intrinsic twins', () => {
    const expected = {
      pureHebrew: [],
      pureArabic: [],
      mixed: ['8:12'],
      nested: ['4:7'],
      tabRtl: ['1:8'],
      override: ['3:10'],
      latin: [],
    } as const

    for (const name of BIDI_CORPUS_NAMES) {
      const row = fixture!.rows[name]
      const collisions = boundaryCollisions(row)
      expect(
        collisions.map(({ left, right }) => `${left}:${right}`),
        name,
      ).toEqual(expected[name])
      for (const collision of collisions) {
        expect(
          collision.leftRects > 1 || collision.rightRects > 1,
          `${name} ${collision.left}:${collision.right}`,
        ).toBe(true)
      }
    }
  })

  it('keeps both sub-pixel nested twins reachable at their own browser x', () => {
    const row = fixture!.rows.nested
    const fourX = offsetToX(fixture!.internal, row, row.startOffset + 4)
    const sevenX = offsetToX(fixture!.internal, row, row.startOffset + 7)

    expect(xToOffset(fixture!.internal, row, fourX)).toBe(row.startOffset + 4)
    expect(xToOffset(fixture!.internal, row, sevenX)).toBe(row.startOffset + 7)
  })

  it('draws carets at the browser boundary on mixed and nested lines', () => {
    for (const name of ['mixed', 'nested'] as const) {
      const row = fixture!.rows[name]
      for (let local = 0; local <= row.text.length; local += 1) {
        fixture!.view.setSelection(row.startOffset + local, row.startOffset + local)
        const oracle = collapsedRangeOracle(row, local)
        const caret = fixture!.container.querySelector<HTMLElement>('.editor-virtualized-caret')
        expect(caret).not.toBeNull()
        expect(
          caret!.getBoundingClientRect().left - row.element.getBoundingClientRect().left,
        ).toBeCloseTo(Math.min(...oracle.map((rect) => rect.left)), 0)
      }
    }
  })

  it('uses each whitespace unit box rather than spanning between BiDi boundaries', () => {
    fixture!.view.setHiddenCharacters('show')
    for (const name of BIDI_CORPUS_NAMES) {
      assertWhitespaceMarkersForRow(name, fixture!.rows[name])
    }
  })

  it('takes the row content extent from one whole-row browser read', () => {
    for (const name of BIDI_CORPUS_NAMES) {
      const row = fixture!.rows[name]
      const rects = mergedRangeOracle(row, 0, row.text.length)
      const browserRight = Math.max(...rects.map((rect) => rect.left + rect.width))
      expect(measureRowContentWidth(fixture!.internal, row), name).toBeCloseTo(browserRight, 0)
    }
  })

  it('does not add Range layout reads to the pure-ASCII geometry path', () => {
    const row = fixture!.rows.latin
    const reads = countRangeReads(() => {
      for (let offset = 0; offset <= row.text.length; offset += 1) {
        offsetToX(fixture!.internal, row, row.startOffset + offset)
      }
    })
    expect(reads).toBe(0)
  })

  it('resolves control and widget boundaries through adjacent text when element ranges are empty', () => {
    const supplementary = mountSupplementaryBidiFixture()
    try {
      assertElementBoundaries(supplementary.controlInternal, supplementary.controlRow, 'control')
      assertElementBoundaries(supplementary.widgetInternal, supplementary.widgetRow, 'widget')
    } finally {
      supplementary.dispose()
    }
  })

  it('returns the browser visual rectangle list for every corpus range', () => {
    for (const name of BIDI_CORPUS_NAMES) assertAllRangesMatch(fixture!, name)
  })

  it('closes the two single-glyph range defects pinned by Milestone 2', () => {
    assertSingleGlyphRange(fixture!, 'mixed', 12, 13)
    assertSingleGlyphRange(fixture!, 'nested', 3, 4)
  })

  it('keeps disjoint visual runs separate and merges rects that only abut', () => {
    const row = fixture!.rows.nested
    const disjoint = subjectRangeSegments(fixture!, row, 2, 6)
    const abutting = subjectRangeSegments(fixture!, row, 4, 8)
    assertRectsClose(disjoint, mergedRangeOracle(row, 2, 6))
    assertRectsClose(abutting, mergedRangeOracle(row, 4, 8))
    expect(disjoint).toHaveLength(2)
    expect(disjoint[1]!.left - (disjoint[0]!.left + disjoint[0]!.width)).toBeGreaterThan(1)
    expect(abutting).toHaveLength(1)
  })

  it('paints selection spans as the browser visual rectangle list', () => {
    assertPaintedSelection(fixture!, 'mixed', 8, 12)
    assertPaintedSelection(fixture!, 'nested', 2, 6)
  })

  it('uses the visual rectangle list for the U+202E warning range', () => {
    const row = fixture!.rows.override
    const options = normalizeSuspiciousCharactersOptions(undefined)
    fixture!.view.setHiddenCharacters('show')
    const range = suspiciousCharacterRanges(row.text, options).find(
      (candidate) => candidate.start === 3,
    )
    expect(range).toBeDefined()
    const markers = [...row.element.querySelectorAll<HTMLElement>('[data-editor-hidden-character]')]
      .filter(
        (marker) => marker.dataset.editorHiddenCharacterOffset === String(row.startOffset + 3),
      )
      .map((marker) => ({
        left: Number.parseFloat(marker.style.left),
        width: Number.parseFloat(marker.style.width),
      }))
      .toSorted((left, right) => left.left - right.left)
    assertRectsClose(markers, mergedRangeOracle(row, range!.start, range!.end))
  })

  it('clamps an offset inside an inline replacement to its following boundary', () => {
    const container = document.createElement('div')
    container.style.font = '14px monospace'
    container.style.height = '20px'
    container.style.width = '600px'
    document.body.append(container)
    const text = 'אבג xyz דהו'
    const view = new VirtualizedTextView(container, { rowHeight: 20, overscan: 0 })
    view.setText(text)
    view.setScrollMetrics(0, 20, 600)
    view.setInlineMap(
      createInlineMap(createPieceTableSnapshot(text), [
        { id: 'replacement', startIndex: 4, endIndex: 7, text: 'W' },
      ]),
    )

    const internal = Reflect.get(view, 'view') as BidiGeometryFixture['internal']
    const row = view.getState().mountedRows[0]!
    expect(offsetToX(internal, row, 5)).toBe(offsetToX(internal, row, 7))
    view.dispose()
    container.remove()
  })

  it('hit-tests both visual halves of interior RTL glyphs through the engine', () => {
    for (const name of BIDI_CORPUS_NAMES) {
      if (name === 'latin') continue
      assertInteriorGlyphClicks(fixture!, name)
    }
  })

  it('repairs the engine hit at both visual edges of pure RTL rows', () => {
    assertRtlEdgeClicks(fixture!, 'pureHebrew')
    assertRtlEdgeClicks(fixture!, 'pureArabic')
    assertRtlEdgeClicks(fixture!, 'nested')
    assertOracleEdgeClicks(fixture!, 'tabRtl')
  })

  it('clamps an edge band before accepting the opposite edge-glyph boundary', () => {
    const row = fixture!.rows.nested
    const extent = rowOracleExtent(row)
    const advance = fixture!.view.getState().metrics.characterWidth
    const opposite = domBoundaryForOffset(row, row.endOffset - 1)
    expect(opposite).not.toBeNull()

    withCaretPositionFromPointResult(opposite!, () => {
      expect(clickRow(fixture!, row, extent.left + advance * 0.25)).toBe(row.endOffset)
    })
  })

  it('compares transformed hit points in row-local geometry space', () => {
    const mounted = mountStandaloneView(BIDI_CORPUS.nested, 4_096, 2)
    try {
      const part = mounted.row.chunks[0]!.parts.find((candidate) => candidate.kind === 'text')
      if (!part || part.kind !== 'text') throw new Error('scaled fixture did not mount text')
      const range = document.createRange()
      range.setStart(part.node, 8)
      range.setEnd(part.node, 9)
      const rect = range.getBoundingClientRect()
      const clientX = rect.left + rect.width * 0.75
      const clientY = rect.top + rect.height / 2
      const engine = document.caretPositionFromPoint(clientX, clientY)
      expect(engine).not.toBeNull()
      const expected = mounted.view.textOffsetFromDomBoundary(engine!.offsetNode, engine!.offset)
      expect(mounted.view.textOffsetFromPoint(clientX, clientY)).toBe(expected)
    } finally {
      mounted.dispose()
    }
  })

  it('pins the engine trigger to the outer edge bands of the three measured rows', () => {
    for (const name of BIDI_CORPUS_NAMES) assertEngineTriggerBand(fixture!, name)
  })

  it('extends a simulated leftward drag over the RTL glyphs it crosses', () => {
    const row = fixture!.rows.nested
    const glyphs = glyphRectOracle(row)
    const startRect = glyphs[8]!.rects[0]!
    const endRect = glyphs[10]!.rects[0]!
    const start = clickRow(fixture!, row, startRect.left + startRect.width * 0.75)
    const end = clickRow(fixture!, row, endRect.left + endRect.width * 0.25)
    expect(start).toBe(row.startOffset + 8)
    expect(end).toBe(row.startOffset + 11)

    fixture!.view.setSelection(start!, end!)
    assertPaintedSelectionRects(row, mergedRangeOracle(row, 8, 11))
  })

  it('uses caretRangeFromPoint when caretPositionFromPoint is unavailable', () => {
    const row = fixture!.rows.nested
    const glyph = glyphRectOracle(row)[8]!.rects[0]!
    const samples = [glyph.left + glyph.width * 0.25, glyph.left + glyph.width * 0.75]
    const expected = samples.map((x) => clickRow(fixture!, row, x))

    withCaretPositionFromPointDisabled(() => {
      const fallback = samples.map((x) => clickRow(fixture!, row, x))
      expect(fallback).toEqual(expected)
    })
  })

  it('keeps selection, whitespace, and caret overlays transparent to caret hit testing', () => {
    const row = fixture!.rows.nested
    const glyph = glyphRectOracle(row)[8]!.rects[0]!
    const x = glyph.left + glyph.width * 0.25
    const before = clickRow(fixture!, row, x)

    fixture!.view.setHiddenCharacters('show')
    fixture!.view.setSelection(row.startOffset + 2, row.startOffset + 9)
    expect(clickRow(fixture!, row, x)).toBe(before)
  })

  it('does not reach the whole-row boundary sweep on an unchunked 6,000-character RTL row', () => {
    const mounted = mountLongRtlView()
    try {
      resetRowGeometrySweepCount()
      const rect = mounted.row.element.getBoundingClientRect()
      mounted.view.textOffsetFromPoint(rect.left + 1, rect.top + rect.height / 2)
      expect(getRowGeometrySweepCount()).toBe(0)
    } finally {
      mounted.view.dispose()
      mounted.container.remove()
    }
  })

  it('refuses to window a 6,000-character RTL line and bounds its text nodes', () => {
    const text = 'א'.repeat(6_000)
    const mounted = mountStandaloneView(text)
    try {
      expect(mounted.row.textRenderMode).not.toBe('chunked')
      expect(mounted.row.chunks).toHaveLength(1)
      expect(mounted.row.chunks[0]!.localStart).toBe(0)
      expect(mounted.row.chunks[0]!.localEnd).toBe(text.length)
      expect(mounted.row.leftSpacerElement.style.width).toBe('0px')
      assertBoundedTextParts(mounted.row, text)

      const firstVisualGlyph = mergedRangeOracle(mounted.row, text.length - 1, text.length)[0]!
      const extent = rowOracleExtent(mounted.row)
      expect(firstVisualGlyph.left).toBeCloseTo(extent.left, 0)
      const point = rowClientPoint(mounted.row, extent.left)
      expect(mounted.view.textOffsetFromPoint(point.x, point.y)).toBe(mounted.row.endOffset)
    } finally {
      mounted.dispose()
    }
  })

  it('splits complex rows only at grapheme boundaries and keeps the later-node seam address', () => {
    const text = `${'א'.repeat(49)}😀${'ב'.repeat(100)}`
    const mounted = mountStandaloneView(text, text.length + 1)
    try {
      assertBoundedTextParts(mounted.row, text)
      for (const part of mounted.row.chunks[0]!.parts) assertTextPartBoundary(part)

      const seam = mounted.row.chunks[0]!.parts.find(
        (part) => part.kind === 'text' && part.localStart > 0,
      )
      expect(seam?.kind).toBe('text')
      const local = seam!.localStart
      const oracle = collapsedRangeOracle(mounted.row, local)
      expect(offsetToX(mounted.internal, mounted.row, local)).toBeCloseTo(
        Math.min(...oracle.map((rect) => rect.left)),
        0,
      )
    } finally {
      mounted.dispose()
    }
  })

  it('keeps selection geometry correct across the former RTL chunk boundary', () => {
    const text = 'א'.repeat(6_000)
    const mounted = mountStandaloneView(text)
    try {
      const start = 2_040
      const end = 2_060
      mounted.view.setSelection(start, end)
      assertPaintedSelectionRects(mounted.row, mergedRangeOracle(mounted.row, start, end))
    } finally {
      mounted.dispose()
    }
  })

  it('still chunks long ASCII and CJK controls but not a Latin bidi override', () => {
    const ascii = mountStandaloneView('x'.repeat(6_000))
    const cjk = mountStandaloneView('日'.repeat(6_000))
    const override = mountStandaloneView(`${'x'.repeat(5_000)}\u202Eabcdef`)
    try {
      expect(ascii.row.textRenderMode).toBe('chunked')
      expect(cjk.row.textRenderMode).toBe('chunked')
      expect(override.row.textRenderMode).not.toBe('chunked')
      expect(override.row.chunks).toHaveLength(1)
    } finally {
      ascii.dispose()
      cjk.dispose()
      override.dispose()
    }
  })

  it('uses an endpoint-only placeholder above the measured BiDi geometry ceiling', () => {
    const text = 'א'.repeat(BIDI_LINE_MEASUREMENT_CEILING + 1)
    const mounted = mountStandaloneView(text)
    try {
      assertEndpointPlaceholder(mounted, text, 'line-length')
      expect(mounted.row.element.textContent).not.toContain(text.slice(0, 100))
    } finally {
      mounted.dispose()
    }
  })

  it('uses the endpoint fallback when one grapheme exceeds the text-node bound', () => {
    const text = `אa${'\u0301'.repeat(6_000)}`
    const mounted = mountStandaloneView(text)
    try {
      assertEndpointPlaceholder(mounted, text, 'grapheme-length')
      expect(mounted.row.element.textContent).not.toContain('\u0301'.repeat(100))
    } finally {
      mounted.dispose()
    }
  })
})

function assertRectsClose(actual: readonly OracleRect[], expected: readonly OracleRect[]): void {
  expect(actual).toHaveLength(expected.length)
  for (let index = 0; index < actual.length; index += 1) {
    expect(actual[index]!.left).toBeCloseTo(expected[index]!.left, 0)
    expect(actual[index]!.width).toBeCloseTo(expected[index]!.width, 0)
  }
}

type BoundaryCollision = {
  readonly left: number
  readonly right: number
  readonly leftRects: number
  readonly rightRects: number
}

function boundaryCollisions(
  row: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']],
): readonly BoundaryCollision[] {
  const positions = Array.from({ length: row.text.length + 1 }, (_, offset) => ({
    offset,
    rects: collapsedRangeOracle(row, offset),
  }))
  const collisions: BoundaryCollision[] = []
  for (let left = 0; left < positions.length; left += 1) {
    appendBoundaryCollisions(collisions, positions, left)
  }
  return collisions
}

function appendBoundaryCollisions(
  collisions: BoundaryCollision[],
  positions: readonly { readonly offset: number; readonly rects: readonly OracleRect[] }[],
  left: number,
): void {
  const leftPosition = positions[left]!
  const leftX = Math.min(...leftPosition.rects.map((rect) => rect.left))
  for (let right = left + 1; right < positions.length; right += 1) {
    const rightPosition = positions[right]!
    const rightX = Math.min(...rightPosition.rects.map((rect) => rect.left))
    if (Math.abs(leftX - rightX) >= 1) continue
    collisions.push({
      left: leftPosition.offset,
      right: rightPosition.offset,
      leftRects: leftPosition.rects.length,
      rightRects: rightPosition.rects.length,
    })
  }
}

function assertElementBoundaries(
  internal: BidiGeometryFixture['internal'],
  row: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']],
  kind: 'control' | 'widget',
): void {
  const partIndex = row.chunks[0]!.parts.findIndex((part) => part.kind === kind)
  const parts = row.chunks[0]!.parts
  const part = parts[partIndex]
  const preceding = parts[partIndex - 1]
  const following = parts[partIndex + 1]
  if (
    !part ||
    part.kind === 'text' ||
    part.kind !== kind ||
    preceding?.kind !== 'text' ||
    following?.kind !== 'text'
  ) {
    throw new Error(`${kind} fixture did not mount between text parts`)
  }

  expect(collapsedElementBoundaryRects(part.element, 'before')).toHaveLength(0)
  const rowLeft = row.element.getBoundingClientRect().left
  const before = collapsedTextBoundaryX(preceding.node, preceding.node.length) - rowLeft
  const after = collapsedTextBoundaryX(following.node, 0) - rowLeft
  expect(offsetToX(internal, row, row.startOffset + part.localStart)).toBeCloseTo(before, 0)
  expect(offsetToX(internal, row, row.startOffset + part.localEnd)).toBeCloseTo(after, 0)
}

function assertWhitespaceMarkersForRow(
  name: keyof typeof BIDI_CORPUS,
  row: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']],
): void {
  const glyphs = glyphRectOracle(row)
  for (let local = 0; local < row.text.length; local += 1) {
    if (row.text[local] !== ' ' && row.text[local] !== '\t') continue
    const marker = row.element.querySelector<HTMLElement>(
      `[data-editor-hidden-character-offset="${row.startOffset + local}"]`,
    )
    const glyph = glyphs[local]!.rects[0]
    expect(marker, `${name} whitespace ${local}`).not.toBeNull()
    expect(glyph).toBeDefined()
    expect(Number.parseFloat(marker!.style.left)).toBeCloseTo(glyph!.left, 0)
    expect(Number.parseFloat(marker!.style.width)).toBeCloseTo(glyph!.width, 0)
    expect(Number.parseFloat(marker!.style.width)).toBeLessThanOrEqual(glyph!.width + 1)
  }
}

function collapsedElementBoundaryRects(
  element: HTMLElement,
  side: 'before' | 'after',
): readonly DOMRect[] {
  const parent = element.parentNode
  if (!parent) throw new Error('element fixture is detached')
  const index = Array.prototype.indexOf.call(parent.childNodes, element) as number
  const range = element.ownerDocument.createRange()
  range.setStart(parent, index + (side === 'after' ? 1 : 0))
  range.collapse(true)
  return Array.from(range.getClientRects())
}

function collapsedTextBoundaryX(node: Text, offset: number): number {
  const range = node.ownerDocument.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const rects = Array.from(range.getClientRects())
  if (rects.length === 0) throw new Error('adjacent text boundary did not produce a rect')
  return Math.min(...rects.map((rect) => rect.left))
}

function assertAllRangesMatch(fixture: BidiGeometryFixture, name: keyof typeof BIDI_CORPUS): void {
  const row = fixture.rows[name]
  for (let start = 0; start < row.text.length; start += 1) {
    assertRangesStartingAt(fixture, row, start)
  }
}

function assertRangesStartingAt(
  fixture: BidiGeometryFixture,
  row: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']],
  start: number,
): void {
  for (let end = start + 1; end <= row.text.length; end += 1) {
    const actual = subjectRangeSegments(fixture, row, start, end)
    const expected = mergedRangeOracle(row, start, end)
    expect(actual, `${row.text} [${start}, ${end})`).toHaveLength(expected.length)
    assertRectsClose(actual, expected)
  }
}

function assertSingleGlyphRange(
  fixture: BidiGeometryFixture,
  name: 'mixed' | 'nested',
  start: number,
  end: number,
): void {
  const row = fixture.rows[name]
  const actual = subjectRangeSegments(fixture, row, start, end)[0]
  const oracle = mergedRangeOracle(row, start, end)[0]
  expect(actual).toBeDefined()
  expect(oracle).toBeDefined()
  expect(actual!.left).toBeCloseTo(oracle!.left, 0)
  expect(actual!.width).toBeCloseTo(oracle!.width, 0)
  expect(actual!.width).toBeCloseTo(glyphRectOracle(row)[start]!.rects[0]!.width, 0)
}

function assertPaintedSelection(
  fixture: BidiGeometryFixture,
  name: 'mixed' | 'nested',
  start: number,
  end: number,
): void {
  const row = fixture.rows[name]
  fixture.view.setSelection(row.startOffset + start, row.startOffset + end)
  assertPaintedSelectionRects(row, mergedRangeOracle(row, start, end))
}

function assertPaintedSelectionRects(
  row: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']],
  expected: readonly OracleRect[],
): void {
  const painted = [
    ...row.element.querySelectorAll<HTMLElement>('.editor-virtualized-selection-range'),
  ]
    .map((element) => ({
      left: Number.parseFloat(element.style.left),
      width: Number.parseFloat(element.style.width),
    }))
    .toSorted((left, right) => left.left - right.left)
  assertRectsClose(painted, expected)
}

function countRangeReads(run: () => void): number {
  const clientRects = Range.prototype.getClientRects
  const boundingRect = Range.prototype.getBoundingClientRect
  let reads = 0
  Range.prototype.getClientRects = function countedClientRects(this: Range) {
    reads += 1
    return clientRects.call(this)
  }
  Range.prototype.getBoundingClientRect = function countedBoundingRect(this: Range) {
    reads += 1
    return boundingRect.call(this)
  }
  try {
    run()
  } finally {
    Range.prototype.getClientRects = clientRects
    Range.prototype.getBoundingClientRect = boundingRect
  }
  return reads
}

const BOUNDARY_TWINS = new Map<string, ReadonlyMap<number, number>>([
  [
    'mixed',
    new Map([
      [8, 12],
      [12, 8],
    ]),
  ],
  [
    'nested',
    new Map([
      [4, 7],
      [7, 4],
    ]),
  ],
  [
    'tabRtl',
    new Map([
      [1, 8],
      [8, 1],
    ]),
  ],
  [
    'override',
    new Map([
      [3, 10],
      [10, 3],
    ]),
  ],
])

function assertInteriorGlyphClicks(
  fixture: BidiGeometryFixture,
  name: keyof typeof BIDI_CORPUS,
): void {
  const row = fixture.rows[name]
  const extent = rowOracleExtent(row)
  const advance = fixture.view.getState().metrics.characterWidth
  for (const glyph of glyphRectOracle(row)) {
    const rect = glyph.rects[0]
    if (!rect || rect.width <= 2) continue
    if (rect.left < extent.left + advance / 2 + 1) continue
    if (rect.left + rect.width > extent.right - advance / 2 - 1) continue
    assertGlyphQuarterClicks(fixture, name, glyph.index, rect)
  }
}

function assertGlyphQuarterClicks(
  fixture: BidiGeometryFixture,
  name: keyof typeof BIDI_CORPUS,
  index: number,
  rect: OracleRect,
): void {
  const row = fixture.rows[name]
  const startXs = collapsedRangeOracle(row, index).map((candidate) => candidate.left)
  const endXs = collapsedRangeOracle(row, index + 1).map((candidate) => candidate.left)
  const startOnLeft = distanceToSet(startXs, rect.left) <= distanceToSet(endXs, rect.left)
  const expectedLeft = row.startOffset + (startOnLeft ? index : index + 1)
  const expectedRight = row.startOffset + (startOnLeft ? index + 1 : index)
  const actualLeft = clickRow(fixture, row, rect.left + rect.width * 0.25)
  const actualRight = clickRow(fixture, row, rect.left + rect.width * 0.75)
  expectOffsetOrTwin(name, actualLeft, expectedLeft, row.startOffset)
  expectOffsetOrTwin(name, actualRight, expectedRight, row.startOffset)
}

function expectOffsetOrTwin(
  name: keyof typeof BIDI_CORPUS,
  actual: number | null,
  expected: number,
  rowStart: number,
): void {
  const localExpected = expected - rowStart
  const twin = BOUNDARY_TWINS.get(name)?.get(localExpected)
  const allowed = twin === undefined ? [expected] : [expected, rowStart + twin]
  expect(allowed, `${name} expected local ${localExpected}, got ${actual}`).toContain(actual)
}

function assertRtlEdgeClicks(
  fixture: BidiGeometryFixture,
  name: 'pureHebrew' | 'pureArabic' | 'nested',
): void {
  const row = fixture.rows[name]
  const extent = rowOracleExtent(row)
  const advance = fixture.view.getState().metrics.characterWidth
  const left = clickRow(fixture, row, extent.left + advance * 0.25)
  const right = clickRow(fixture, row, extent.right - advance * 0.25)
  expect(left).toBe(row.endOffset)
  expect(right).toBe(row.startOffset)
  expect(offsetToX(fixture.internal, row, left!)).toBeCloseTo(extent.left, 0)
  expect(offsetToX(fixture.internal, row, right!)).toBeCloseTo(extent.right, 0)
}

function assertEngineTriggerBand(
  fixture: BidiGeometryFixture,
  name: keyof typeof BIDI_CORPUS,
): void {
  const row = fixture.rows[name]
  const extent = rowOracleExtent(row)
  const advance = fixture.view.getState().metrics.characterWidth
  let farHits = 0
  for (let x = extent.left; x <= extent.right; x += 0.25) {
    const engine = engineClickRow(fixture, row, x)
    if (engine === null) continue
    const positions = boundaryPositionXs(fixture.internal, row, engine)
    const followingWidth = unitRectForOffset(fixture.internal, row, engine)?.width ?? 0
    const precedingWidth = unitRectForOffset(fixture.internal, row, engine - 1)?.width ?? 0
    if (distanceToSet(positions, x) <= Math.max(advance, followingWidth, precedingWidth)) continue
    farHits += 1
    expect(triggerExpectedFor(name), `${name} fired at ${x}`).toBe(true)
    expect(Math.min(x - extent.left, extent.right - x)).toBeLessThanOrEqual(advance / 2 + 1)
  }

  expect(farHits > 0).toBe(triggerExpectedFor(name))
}

function triggerExpectedFor(name: keyof typeof BIDI_CORPUS): boolean {
  return name === 'pureHebrew' || name === 'pureArabic' || name === 'nested' || name === 'tabRtl'
}

function assertOracleEdgeClicks(
  fixture: BidiGeometryFixture,
  name: keyof typeof BIDI_CORPUS,
): void {
  const row = fixture.rows[name]
  const extent = rowOracleExtent(row)
  const advance = fixture.view.getState().metrics.characterWidth
  const expectedLeft = oracleExtremalOffset(row, extent.left)
  const expectedRight = oracleExtremalOffset(row, extent.right)
  expect(clickRow(fixture, row, extent.left + advance * 0.25)).toBe(expectedLeft)
  expect(clickRow(fixture, row, extent.right - advance * 0.25)).toBe(expectedRight)
}

function oracleExtremalOffset(
  row: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']],
  edge: number,
): number {
  for (let local = 0; local <= row.text.length; local += 1) {
    const positions = collapsedRangeOracle(row, local)
    if (positions.some((rect) => Math.abs(rect.left - edge) <= 1)) return row.startOffset + local
  }
  throw new Error(`no boundary at visual edge ${edge}`)
}

function clickRow(
  fixture: BidiGeometryFixture,
  row: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']],
  localX: number,
): number | null {
  const point = rowClientPoint(row, localX)
  return fixture.view.textOffsetFromPoint(point.x, point.y)
}

function engineClickRow(
  fixture: BidiGeometryFixture,
  row: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']],
  localX: number,
): number | null {
  const point = rowClientPoint(row, localX)
  const position = document.caretPositionFromPoint(point.x, point.y)
  if (!position) return null
  return fixture.view.textOffsetFromDomBoundary(position.offsetNode, position.offset)
}

function rowClientPoint(
  row: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']],
  localX: number,
): { readonly x: number; readonly y: number } {
  const rect = row.element.getBoundingClientRect()
  const scale = row.element.offsetWidth > 0 ? rect.width / row.element.offsetWidth : 1
  return { x: rect.left + localX * scale, y: rect.top + rect.height / 2 }
}

function rowOracleExtent(row: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']]): {
  readonly left: number
  readonly right: number
} {
  const rects = mergedRangeOracle(row, 0, row.text.length)
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    right: Math.max(...rects.map((rect) => rect.left + rect.width)),
  }
}

function distanceToSet(xs: readonly number[], target: number): number {
  return Math.min(...xs.map((x) => Math.abs(x - target)))
}

function withCaretPositionFromPointDisabled(run: () => void): void {
  const own = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
  Object.defineProperty(document, 'caretPositionFromPoint', {
    configurable: true,
    value: undefined,
  })
  try {
    run()
  } finally {
    if (own) Object.defineProperty(document, 'caretPositionFromPoint', own)
    else delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint
  }
}

function withCaretPositionFromPointResult(
  result: { readonly node: Node; readonly offset: number },
  run: () => void,
): void {
  const own = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
  Object.defineProperty(document, 'caretPositionFromPoint', {
    configurable: true,
    value: () => ({ offsetNode: result.node, offset: result.offset }),
  })
  try {
    run()
  } finally {
    if (own) Object.defineProperty(document, 'caretPositionFromPoint', own)
    else delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint
  }
}

function mountLongRtlView(): {
  readonly container: HTMLElement
  readonly view: VirtualizedTextView
  readonly row: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']]
} {
  const container = document.createElement('div')
  container.style.font = '14px monospace'
  container.style.height = '20px'
  container.style.width = '600px'
  document.body.append(container)
  const view = new VirtualizedTextView(container, {
    rowHeight: 20,
    overscan: 0,
    longLineChunkThreshold: 7_000,
  })
  view.setText('א'.repeat(6_000))
  view.setScrollMetrics(0, 20, 600)
  return { container, view, row: view.getState().mountedRows[0]! }
}

type StandaloneView = {
  readonly container: HTMLElement
  readonly view: VirtualizedTextView
  readonly internal: BidiGeometryFixture['internal']
  readonly row: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']]
  dispose(): void
}

function mountStandaloneView(text: string, threshold = 4_096, scale = 1): StandaloneView {
  const container = document.createElement('div')
  container.style.font = '14px monospace'
  container.style.height = '20px'
  container.style.width = '600px'
  if (scale !== 1) {
    container.style.transformOrigin = '0 0'
    container.style.transform = `scale(${scale})`
  }
  document.body.append(container)
  const view = new VirtualizedTextView(container, {
    rowHeight: 20,
    overscan: 0,
    longLineChunkThreshold: threshold,
  })
  view.setText(text)
  view.setScrollMetrics(0, 20, 600)
  return {
    container,
    view,
    internal: Reflect.get(view, 'view') as BidiGeometryFixture['internal'],
    row: view.getState().mountedRows[0]!,
    dispose: () => {
      view.dispose()
      container.remove()
    },
  }
}

function assertEndpointPlaceholder(
  mounted: StandaloneView,
  text: string,
  refusal: 'line-length' | 'grapheme-length',
): void {
  const placeholder = mounted.row.element.querySelector<HTMLElement>(
    '[data-editor-bidi-line-length]',
  )
  expect(mounted.row.textRenderMode).toBe('widget')
  expect(mounted.row.chunks).toHaveLength(1)
  expect(mounted.row.chunks[0]!.parts).toHaveLength(2)
  expect(mounted.row.chunks[0]!.parts.every((part) => part.kind === 'widget')).toBe(true)
  expect(placeholder?.dataset.editorBidiLineLength).toBe(String(text.length))
  expect(placeholder?.dataset.editorBidiMeasurementRefusal).toBe(refusal)
  expect(placeholder?.querySelectorAll('[data-editor-bidi-endpoint]')).toHaveLength(2)

  const rect = placeholder!.getBoundingClientRect()
  const y = rect.top + rect.height / 2
  expect(mounted.view.textOffsetFromPoint(rect.left + 1, y)).toBe(0)
  expect(mounted.view.textOffsetFromPoint(rect.right - 1, y)).toBe(text.length)
}

function assertBoundedTextParts(
  row: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']],
  text: string,
): void {
  const parts = row.chunks[0]!.parts.filter((part) => part.kind === 'text')
  expect(parts.length).toBeGreaterThan(1)
  expect(parts.map((part) => part.node.data).join('')).toBe(text)
  for (const part of parts) expect(part.node.length).toBeLessThanOrEqual(50)
}

function assertTextPartBoundary(
  part: BidiGeometryFixture['rows'][keyof BidiGeometryFixture['rows']]['chunks'][number]['parts'][number],
): void {
  if (part.kind !== 'text' || part.node.length === 0) return
  const first = part.node.data.charCodeAt(0)
  const last = part.node.data.charCodeAt(part.node.length - 1)
  expect(first < 0xdc00 || first > 0xdfff).toBe(true)
  expect(last < 0xd800 || last > 0xdbff).toBe(true)
  expect(/^\p{Mark}/u.test(part.node.data)).toBe(false)
}
