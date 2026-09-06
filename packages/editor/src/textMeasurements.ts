import type { TransformBias } from './displayTransforms'
import { containsRTL, estimatedCodePointWidth, isSimpleRowText } from './textCharacters'
import { recordEditorPerformanceDiagnostic } from './editor/performanceDiagnostics'

export const INDEXED_TEXT_MIN_LENGTH = 1024
const BLOCK_LENGTH = 256
const MAX_TAB_SIZES = 4

export type ColumnMode = 'utf16' | 'estimated'
export type MeasuredText = { readonly text: string; readonly measurements?: TextMeasurements }
type Advance = { readonly prefix: number; readonly suffix: number | null }
type Summary = {
  readonly length: number
  readonly first: number
  readonly last: number
  readonly simple: boolean
  readonly rtl: boolean
  readonly utf16: Advance
  readonly estimated: Advance
}
type TextNode =
  | {
      readonly kind: 'leaf'
      readonly text: string
      readonly start: number
      readonly summary: Summary
    }
  | {
      readonly kind: 'branch'
      readonly left: TextNode
      readonly right: TextNode
      readonly summary: Summary
    }

const EMPTY: Summary = {
  length: 0,
  first: -1,
  last: -1,
  simple: true,
  rtl: false,
  utf16: { prefix: 0, suffix: null },
  estimated: { prefix: 0, suffix: null },
}

export class TextSourceIndex {
  private readonly roots = new Map<number, TextNode>()

  constructor(readonly text: string) {}

  get cachedTabSize(): number | undefined {
    return this.roots.keys().next().value
  }

  root(tabSize: number): TextNode {
    const cached = this.roots.get(tabSize)
    if (cached) return cached
    const first = this.roots.values().next().value
    if (first?.summary.utf16.suffix === null) return first
    const root = buildSource(this.text, 0, this.text.length, tabSize)
    makeCacheRoom(this.roots)
    this.roots.set(tabSize, root)
    recordEditorPerformanceDiagnostic('textMeasurements.index', {
      length: this.text.length,
      tabSize,
    })
    return root
  }
}

export type MeasuredTextRange = {
  readonly source: TextSourceIndex
  readonly start: number
  readonly end: number
}

export class TextMeasurements {
  private readonly roots = new Map<number, TextNode>()
  readonly length: number

  constructor(private readonly ranges: readonly MeasuredTextRange[]) {
    this.length = ranges.reduce((length, range) => length + range.end - range.start, 0)
  }

  get isSimple(): boolean {
    return this.classificationRoot().summary.simple
  }
  get containsRTL(): boolean {
    return this.classificationRoot().summary.rtl
  }

  get hasTabs(): boolean {
    return this.classificationRoot().summary.utf16.suffix !== null
  }

  private classificationRoot(): TextNode {
    return this.roots.values().next().value ?? this.root(this.ranges[0]?.source.cachedTabSize ?? 4)
  }

  columnAt(offset: number, tabSize: number, mode: ColumnMode): number {
    const root = this.root(tabSize)
    const end = Math.min(this.length, Math.max(0, Math.floor(offset)))
    if (hasUnitCells(root.summary, mode)) return end
    const summary = rangeSummary(root, 0, end, tabSize)
    const next =
      mode === 'estimated' && isHighSurrogate(summary.last) && end < this.length
        ? codeUnitAt(root, end)
        : -1
    return boundaryColumn(summary, next, tabSize, mode)
  }

  offsetAt(column: number, bias: TransformBias, tabSize: number, mode: ColumnMode): number {
    const target = Math.max(0, column)
    if (target === 0) return 0
    return findOffset(this.root(tabSize), target, bias, tabSize, mode)
  }

  slice(start: number, end: number): TextMeasurements {
    const ranges: MeasuredTextRange[] = []
    let offset = 0
    for (const range of this.ranges) {
      const length = range.end - range.start
      const from = Math.max(0, start - offset)
      const to = Math.min(length, end - offset)
      if (to > from)
        ranges.push({ source: range.source, start: range.start + from, end: range.start + to })
      offset += length
      if (offset >= end) break
    }
    return new TextMeasurements(ranges)
  }

  private root(tabSize: number): TextNode {
    const cached = this.roots.get(tabSize)
    if (cached) return cached
    const nodes = this.ranges.map(({ source, start, end }) =>
      sliceNode(source.root(tabSize), start, end, tabSize),
    )
    const root = joinNodes(nodes, 0, nodes.length, tabSize)
    makeCacheRoom(this.roots)
    this.roots.set(tabSize, root)
    return root
  }
}

export function measureString(text: string): TextMeasurements {
  return new TextMeasurements([{ source: new TextSourceIndex(text), start: 0, end: text.length }])
}

function makeCacheRoom(roots: Map<number, TextNode>): void {
  if (roots.size < MAX_TAB_SIZES) return
  for (const key of roots.keys()) {
    roots.delete(key)
    return
  }
}

function advance(value: Advance, start: number, tabSize: number): number {
  if (value.suffix === null) return start + value.prefix
  return nextTab(start + value.prefix, tabSize) + value.suffix
}

function nextTab(column: number, tabSize: number): number {
  return column + tabSize - (column % tabSize)
}

function joinAdvance(left: Advance, right: Advance, tabSize: number): Advance {
  if (left.suffix === null) return { prefix: left.prefix + right.prefix, suffix: right.suffix }
  return { prefix: left.prefix, suffix: advance(right, left.suffix, tabSize) }
}

function removeLastCell(value: Advance): Advance {
  if (value.suffix === null) return { prefix: value.prefix - 1, suffix: null }
  return { prefix: value.prefix, suffix: value.suffix - 1 }
}

function joinSummary(left: Summary, right: Summary, tabSize: number): Summary {
  if (left.length === 0) return right
  if (right.length === 0) return left
  const pair = isPair(left.last, right.first)
  let estimatedLeft = left.estimated
  let estimatedRight = right.estimated
  let rtl = left.rtl || right.rtl
  if (pair) {
    const text = String.fromCharCode(left.last, right.first)
    estimatedLeft = joinAdvance(
      removeLastCell(estimatedLeft),
      { prefix: estimatedCodePointWidth(text.codePointAt(0)!), suffix: null },
      tabSize,
    )
    estimatedRight = { prefix: estimatedRight.prefix - 1, suffix: estimatedRight.suffix }
    rtl ||= containsRTL(text)
  }
  return {
    length: left.length + right.length,
    first: left.first,
    last: right.last,
    simple: left.simple && right.simple,
    rtl,
    utf16: joinAdvance(left.utf16, right.utf16, tabSize),
    estimated: joinAdvance(estimatedLeft, estimatedRight, tabSize),
  }
}

function scanSummary(text: string, start: number, end: number, tabSize: number): Summary {
  if (start === end) return EMPTY
  const part = text.slice(start, end)
  const simple = isSimpleRowText(part)
  if (simple && !part.includes('\t'))
    return {
      length: part.length,
      first: part.charCodeAt(0),
      last: part.charCodeAt(part.length - 1),
      simple,
      rtl: false,
      utf16: { prefix: part.length, suffix: null },
      estimated: { prefix: part.length, suffix: null },
    }
  return {
    length: part.length,
    first: part.charCodeAt(0),
    last: part.charCodeAt(part.length - 1),
    simple,
    rtl: !simple && containsRTL(part),
    utf16: scanAdvance(part, tabSize, 'utf16'),
    estimated: scanAdvance(part, tabSize, 'estimated'),
  }
}

function scanAdvance(text: string, tabSize: number, mode: ColumnMode): Advance {
  let prefix = 0
  let suffix: number | null = null
  let column = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 9) {
      if (suffix === null) prefix = column
      column = nextTab(column, tabSize)
      suffix = column - nextTab(prefix, tabSize)
      continue
    }
    const point = mode === 'estimated' ? text.codePointAt(index)! : code
    column += mode === 'estimated' ? estimatedCodePointWidth(point) : 1
    if (point > 0xffff) index += 1
    if (suffix !== null) suffix = column - nextTab(prefix, tabSize)
  }
  return { prefix: suffix === null ? column : prefix, suffix }
}

function buildSource(text: string, start: number, end: number, tabSize: number): TextNode {
  if (end - start <= BLOCK_LENGTH)
    return { kind: 'leaf', text, start, summary: scanSummary(text, start, end, tabSize) }
  const middle = start + Math.max(1, Math.floor((end - start) / (BLOCK_LENGTH * 2))) * BLOCK_LENGTH
  return branch(
    buildSource(text, start, middle, tabSize),
    buildSource(text, middle, end, tabSize),
    tabSize,
  )
}

function branch(left: TextNode, right: TextNode, tabSize: number): TextNode {
  if (left.summary.length === 0) return right
  if (right.summary.length === 0) return left
  return { kind: 'branch', left, right, summary: joinSummary(left.summary, right.summary, tabSize) }
}

function joinNodes(
  nodes: readonly TextNode[],
  start: number,
  end: number,
  tabSize: number,
): TextNode {
  if (start === end) return { kind: 'leaf', text: '', start: 0, summary: EMPTY }
  if (end - start === 1) return nodes[start]!
  const middle = Math.floor((start + end) / 2)
  return branch(
    joinNodes(nodes, start, middle, tabSize),
    joinNodes(nodes, middle, end, tabSize),
    tabSize,
  )
}

function sliceNode(node: TextNode, start: number, end: number, tabSize: number): TextNode {
  if (start === 0 && end === node.summary.length) return node
  if (node.kind === 'leaf')
    return {
      ...node,
      start: node.start + start,
      summary: scanSummary(node.text, node.start + start, node.start + end, tabSize),
    }
  const middle = node.left.summary.length
  if (end <= middle) return sliceNode(node.left, start, end, tabSize)
  if (start >= middle) return sliceNode(node.right, start - middle, end - middle, tabSize)
  return branch(
    sliceNode(node.left, start, middle, tabSize),
    sliceNode(node.right, 0, end - middle, tabSize),
    tabSize,
  )
}

function rangeSummary(node: TextNode, start: number, end: number, tabSize: number): Summary {
  if (start === end) return EMPTY
  if (start === 0 && end === node.summary.length) return node.summary
  if (node.kind === 'leaf') {
    if (node.summary.simple && node.summary.utf16.suffix === null)
      return {
        ...node.summary,
        length: end - start,
        utf16: { prefix: end - start, suffix: null },
        estimated: { prefix: end - start, suffix: null },
      }
    return scanSummary(node.text, node.start + start, node.start + end, tabSize)
  }
  const middle = node.left.summary.length
  if (end <= middle) return rangeSummary(node.left, start, end, tabSize)
  if (start >= middle) return rangeSummary(node.right, start - middle, end - middle, tabSize)
  return joinSummary(
    rangeSummary(node.left, start, middle, tabSize),
    rangeSummary(node.right, 0, end - middle, tabSize),
    tabSize,
  )
}

function codeUnitAt(node: TextNode, offset: number): number {
  if (node.kind === 'leaf') return node.text.charCodeAt(node.start + offset)
  const middle = node.left.summary.length
  return offset < middle ? codeUnitAt(node.left, offset) : codeUnitAt(node.right, offset - middle)
}

function hasUnitCells(summary: Summary, mode: ColumnMode): boolean {
  return summary.utf16.suffix === null && (mode === 'utf16' || summary.simple)
}

function boundaryColumn(summary: Summary, next: number, tabSize: number, mode: ColumnMode): number {
  const column = advance(summary[mode], 0, tabSize)
  if (mode === 'utf16' || !isPair(summary.last, next)) return column
  return column - 1 + estimatedCodePointWidth(pairCodePoint(summary.last, next))
}

function findOffset(
  root: TextNode,
  target: number,
  bias: TransformBias,
  tabSize: number,
  mode: ColumnMode,
): number {
  let node = root
  let prefix = EMPTY
  let offset = 0
  let next = -1
  while (node.kind === 'branch') {
    if (hasUnitCells(node.summary, mode))
      return (
        offset +
        unitCellOffset(target - advance(prefix[mode], 0, tabSize), node.summary.length, bias)
      )
    const throughLeft = joinSummary(prefix, node.left.summary, tabSize)
    if (boundaryColumn(throughLeft, node.right.summary.first, tabSize, mode) >= target) {
      next = node.right.summary.first
      node = node.left
      continue
    }
    prefix = throughLeft
    offset += node.left.summary.length
    node = node.right
  }
  const column = advance(prefix[mode], 0, tabSize)
  if (hasUnitCells(node.summary, mode))
    return offset + unitCellOffset(target - column, node.summary.length, bias)
  return offset + scanOffset(node, prefix, next, target, bias, tabSize, mode)
}

function unitCellOffset(target: number, length: number, bias: TransformBias): number {
  if (bias === 'before') return Math.min(length, Math.floor(target))
  if (bias === 'after') return Math.min(length, Math.ceil(target))
  return Math.min(length, Math.ceil(target - 0.5))
}

function scanOffset(
  node: Extract<TextNode, { kind: 'leaf' }>,
  prefix: Summary,
  next: number,
  target: number,
  bias: TransformBias,
  tabSize: number,
  mode: ColumnMode,
): number {
  let column = boundaryColumn(prefix, node.summary.first, tabSize, mode)
  let index = mode === 'estimated' && isPair(prefix.last, node.summary.first) ? 1 : 0
  while (index < node.summary.length) {
    const first = node.text.charCodeAt(node.start + index)
    const second =
      index + 1 < node.summary.length ? node.text.charCodeAt(node.start + index + 1) : next
    const pair = mode === 'estimated' && isPair(first, second)
    const end = index + (pair ? 2 : 1)
    const point = pair ? pairCodePoint(first, second) : first
    const cells = mode === 'utf16' ? 1 : estimatedCodePointWidth(point)
    const after = first === 9 ? nextTab(column, tabSize) : column + cells
    if (after >= target) return offsetWithinCell(index, end, column, after, target, bias)
    index = end
    column = after
  }
  return node.summary.length
}

function offsetWithinCell(
  start: number,
  end: number,
  before: number,
  after: number,
  target: number,
  bias: TransformBias,
): number {
  if (target === after) return end
  if (bias === 'before') return start
  if (bias === 'after') return end
  return target - before <= after - target ? start : end
}

function pairCodePoint(first: number, last: number): number {
  return 0x10000 + ((first - 0xd800) << 10) + last - 0xdc00
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isPair(first: number, last: number): boolean {
  return isHighSurrogate(first) && last >= 0xdc00 && last <= 0xdfff
}
