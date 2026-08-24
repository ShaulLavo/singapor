import { afterEach, describe, expect, it } from 'vitest'
import {
  createDocumentTextSnapshot,
  createPieceTableSnapshot,
  createStringTextSnapshot,
  insertIntoPieceTable,
} from '../src/public/document'

type Diagnostic = {
  readonly name: string
  readonly detail?: Readonly<Record<string, unknown>>
}

type DiagnosticGlobal = typeof globalThis & {
  __EDITOR_PERFORMANCE_DIAGNOSTICS__?: ((diagnostic: Diagnostic) => void) | null
}

const diagnosticGlobal = (): DiagnosticGlobal => globalThis as DiagnosticGlobal

describe('DocumentTextSnapshot', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__EDITOR_PERFORMANCE_DIAGNOSTICS__')
  })

  it('does not retain computed full text materializations', () => {
    const diagnostics = collectDiagnostics()
    const snapshot = createDocumentTextSnapshot(createPieceTableSnapshot('alpha'))

    expect(snapshot.materializeFullText()).toBe('alpha')
    expect(snapshot.materializeFullText()).toBe('alpha')

    const reads = diagnostics.filter(
      (diagnostic) => diagnostic.name === 'textSnapshot.materializeFullText',
    )
    expect(reads).toHaveLength(2)
    expect(reads.map((diagnostic) => diagnostic.detail)).toEqual([
      { length: 5, cached: false, retained: false },
      { length: 5, cached: false, retained: false },
    ])
  })

  it('keeps constructor-provided full text as the retained cache', () => {
    const diagnostics = collectDiagnostics()
    const snapshot = createDocumentTextSnapshot(createPieceTableSnapshot('alpha'), 'alpha')

    expect(snapshot.materializeFullText()).toBe('alpha')
    expect(snapshot.materializeFullText()).toBe('alpha')

    const reads = diagnostics.filter(
      (diagnostic) => diagnostic.name === 'textSnapshot.materializeFullText',
    )
    expect(reads).toHaveLength(2)
    expect(reads.map((diagnostic) => diagnostic.detail)).toEqual([
      { length: 5, cached: true, retained: true },
      { length: 5, cached: true, retained: true },
    ])
  })

  it('reads ranges and visits each piece-table text chunk', () => {
    const pieceTable = insertIntoPieceTable(createPieceTableSnapshot('abcdef'), 3, 'XX')
    const snapshot = createDocumentTextSnapshot(pieceTable)
    const chunks: string[] = []

    snapshot.forEachTextChunk((text, start, end) => {
      chunks.push(`${start}:${end}:${text}`)
    })

    expect(snapshot.snapshot).toBe(pieceTable)
    expect(snapshot.length).toBe(8)
    expect(snapshot.readRange(2, 6)).toBe('cXXd')
    expect(chunks).toEqual(['0:3:abc', '3:5:XX', '5:8:def'])
  })

  it('shares methods across document snapshot instances', () => {
    const first = createDocumentTextSnapshot(createPieceTableSnapshot('alpha'))
    const second = createDocumentTextSnapshot(createPieceTableSnapshot('beta'))

    expect(Object.getPrototypeOf(first)).toBe(Object.getPrototypeOf(second))
    expect(Object.hasOwn(first, 'materializeFullText')).toBe(false)
    expect(Object.hasOwn(first, 'readRange')).toBe(false)
    expect(Object.hasOwn(first, 'forEachTextChunk')).toBe(false)
    expect(first.materializeFullText).toBe(second.materializeFullText)
    expect(first.readRange).toBe(second.readRange)
    expect(first.forEachTextChunk).toBe(second.forEachTextChunk)
  })
})

describe('StringTextSnapshot', () => {
  it('reads text and visits one non-empty chunk', () => {
    const snapshot = createStringTextSnapshot('alpha')
    const chunks: string[] = []

    snapshot.forEachTextChunk((text, start, end) => {
      chunks.push(`${start}:${end}:${text}`)
    })

    expect(snapshot.length).toBe(5)
    expect(snapshot.materializeFullText()).toBe('alpha')
    expect(snapshot.readRange(1, 4)).toBe('lph')
    expect(chunks).toEqual(['0:5:alpha'])
  })

  it('does not visit a chunk for empty text', () => {
    const snapshot = createStringTextSnapshot('')
    let visits = 0

    snapshot.forEachTextChunk(() => {
      visits += 1
    })

    expect(snapshot.length).toBe(0)
    expect(visits).toBe(0)
  })

  it('shares methods and the length accessor across string snapshot instances', () => {
    const first = createStringTextSnapshot('alpha')
    const second = createStringTextSnapshot('beta')
    const firstPrototype = Object.getPrototypeOf(first)
    const secondPrototype = Object.getPrototypeOf(second)
    const lengthGetter = Object.getOwnPropertyDescriptor(firstPrototype, 'length')?.get

    expect(firstPrototype).toBe(secondPrototype)
    expect(Object.hasOwn(first, 'length')).toBe(false)
    expect(Object.hasOwn(first, 'materializeFullText')).toBe(false)
    expect(Object.hasOwn(first, 'readRange')).toBe(false)
    expect(Object.hasOwn(first, 'forEachTextChunk')).toBe(false)
    expect(lengthGetter).toBeTypeOf('function')
    expect(first.materializeFullText).toBe(second.materializeFullText)
    expect(first.readRange).toBe(second.readRange)
    expect(first.forEachTextChunk).toBe(second.forEachTextChunk)
    expect(lengthGetter).toBe(Object.getOwnPropertyDescriptor(secondPrototype, 'length')?.get)
  })
})

function collectDiagnostics(): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  diagnosticGlobal().__EDITOR_PERFORMANCE_DIAGNOSTICS__ = (diagnostic) => {
    diagnostics.push(diagnostic)
  }
  return diagnostics
}
