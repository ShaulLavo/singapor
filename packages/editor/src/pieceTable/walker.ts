import type { PieceTreeNode, PieceTableTreeSnapshot } from './pieceTableTypes'
import { bufferForPiece } from './buffers'
import { collectTextInRange, getPieceVisibleLength, getSubtreeVisibleLength } from './tree'

// Stateful forward cursor over the visible text of an immutable snapshot.
// Sequential reads are amortized O(1) per char; seek() is one O(log n) descent.
// A next() crossing a piece boundary is worst-case O(k + depth) where k is the
// number of interleaved tombstones at that boundary (fully invisible subtrees
// are pruned via subtreeVisibleLength) — see the tombstone-compaction TODO.

export type PieceTableWalkerChunk = {
  readonly text: string
  readonly start: number
  readonly end: number
}

export type PieceTableWalker = {
  offset(): number
  exhausted(): boolean
  remaining(): number
  charCode(): number
  next(): number
  codePoint(): number
  skip(count: number): void
  seek(offset: number): void
  chunk(): PieceTableWalkerChunk | null
  nextChunk(): boolean
}

const EXHAUSTED_CHAR = -1
const HIGH_SURROGATE_FIRST = 0xd800
const HIGH_SURROGATE_LAST = 0xdbff
const LOW_SURROGATE_FIRST = 0xdc00
const LOW_SURROGATE_LAST = 0xdfff

export const createPieceTableWalker = (
  snapshot: PieceTableTreeSnapshot,
  startOffset = 0,
): PieceTableWalker => {
  const root = snapshot.root
  const buffers = snapshot.buffers
  const totalLength = snapshot.length

  // The stack holds the current node plus exactly those ancestors entered via
  // a left turn (they are emitted after their left subtree). Not exhausted iff
  // the stack is non-empty; the top node's piece is visible with length > 0.
  // textIndex/textEnd are absolute indexes into pieceText so the hot path
  // reads chars with a single index instead of recomputing start + local.
  const stack: PieceTreeNode[] = []
  let pieceText = ''
  let textIndex = 0
  let textEnd = 0
  let offsetValue = 0

  const bindCurrentPiece = (node: PieceTreeNode): void => {
    pieceText = bufferForPiece(buffers, node.piece)
    textIndex = node.piece.start
    textEnd = node.piece.start + node.piece.length
  }

  const clearCurrentPiece = (): void => {
    pieceText = ''
    textIndex = 0
    textEnd = 0
  }

  const pushLeftSpine = (start: PieceTreeNode): void => {
    let node: PieceTreeNode | null = start
    while (node) {
      stack.push(node)
      node = node.left && getSubtreeVisibleLength(node.left) > 0 ? node.left : null
    }
  }

  const settleOnVisibleTop = (): boolean => {
    while (stack.length > 0) {
      const node = stack[stack.length - 1]
      if (!node) break
      if (node.piece.visible && node.piece.length > 0) {
        bindCurrentPiece(node)
        return true
      }
      stack.pop()
      if (node.right && getSubtreeVisibleLength(node.right) > 0) pushLeftSpine(node.right)
    }
    clearCurrentPiece()
    return false
  }

  const advancePiece = (): boolean => {
    const node = stack.pop()
    if (node?.right && getSubtreeVisibleLength(node.right) > 0) pushLeftSpine(node.right)
    return settleOnVisibleTop()
  }

  const seek = (target: number): void => {
    if (target < 0 || target > totalLength) throw new RangeError('invalid offset')

    if (stack.length > 0 && target >= offsetValue && target - offsetValue < textEnd - textIndex) {
      textIndex += target - offsetValue
      offsetValue = target
      return
    }

    stack.length = 0
    offsetValue = target
    if (target === totalLength) {
      clearCurrentPiece()
      return
    }

    let node = root
    let remaining = target
    while (node) {
      const leftLength = getSubtreeVisibleLength(node.left)
      if (remaining < leftLength) {
        stack.push(node)
        node = node.left
        continue
      }
      remaining -= leftLength
      const nodeLength = getPieceVisibleLength(node.piece)
      if (remaining < nodeLength) {
        stack.push(node)
        bindCurrentPiece(node)
        textIndex += remaining
        return
      }
      remaining -= nodeLength
      node = node.right
    }

    throw new RangeError('invalid offset')
  }

  const charCode = (): number =>
    stack.length === 0 ? EXHAUSTED_CHAR : pieceText.charCodeAt(textIndex)

  const next = (): number => {
    if (textIndex < textEnd) {
      const code = pieceText.charCodeAt(textIndex)
      textIndex += 1
      offsetValue += 1
      if (textIndex === textEnd) advancePiece()
      return code
    }
    return EXHAUSTED_CHAR
  }

  const lookAheadCharCode = (): number => {
    const acc: string[] = []
    collectTextInRange(root, buffers, offsetValue + 1, offsetValue + 2, acc)
    const text = acc[0]
    return text && text.length > 0 ? text.charCodeAt(0) : EXHAUSTED_CHAR
  }

  const codePoint = (): number => {
    const first = charCode()
    if (first < HIGH_SURROGATE_FIRST || first > HIGH_SURROGATE_LAST) return first
    if (offsetValue + 1 >= totalLength) return first
    const second =
      textIndex + 1 < textEnd ? pieceText.charCodeAt(textIndex + 1) : lookAheadCharCode()
    if (second < LOW_SURROGATE_FIRST || second > LOW_SURROGATE_LAST) return first
    return (first - HIGH_SURROGATE_FIRST) * 0x400 + (second - LOW_SURROGATE_FIRST) + 0x10000
  }

  const skip = (count: number): void => {
    if (count < 0 || offsetValue + count > totalLength) throw new RangeError('invalid count')

    let remaining = count
    while (remaining > 0) {
      const available = textEnd - textIndex
      if (remaining < available) {
        textIndex += remaining
        offsetValue += remaining
        return
      }
      remaining -= available
      offsetValue += available
      advancePiece()
    }
  }

  const chunk = (): PieceTableWalkerChunk | null => {
    if (stack.length === 0) return null
    return {
      text: pieceText.slice(textIndex, textEnd),
      start: offsetValue,
      end: offsetValue + (textEnd - textIndex),
    }
  }

  const nextChunk = (): boolean => {
    if (stack.length === 0) return false
    offsetValue += textEnd - textIndex
    return advancePiece()
  }

  seek(startOffset)

  return {
    offset: () => offsetValue,
    exhausted: () => stack.length === 0,
    remaining: () => totalLength - offsetValue,
    charCode,
    next,
    codePoint,
    skip,
    seek,
    chunk,
    nextChunk,
  }
}
