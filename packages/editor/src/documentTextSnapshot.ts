import type { PieceTableSnapshot } from './pieceTable/pieceTableTypes'
import {
  forEachPieceTableTextChunk,
  materializePieceTableFullText,
  readPieceTableTextRange,
} from './pieceTable/reads'
import {
  measureEditorPerformance,
  recordEditorPerformanceDiagnostic,
} from './editor/performanceDiagnostics'

export type TextSnapshot = {
  readonly length: number
  readRange(start: number, end: number): string
  materializeFullText(): string
  forEachTextChunk(visit: (text: string, start: number, end: number) => void): void
}

export type DocumentTextSnapshot = TextSnapshot & {
  readonly snapshot: PieceTableSnapshot
}

export function defineLazyFullTextProperty<TTarget extends { readonly textSnapshot: TextSnapshot }>(
  target: TTarget,
): TTarget & { readonly fullText: string } {
  let fullTextCache: string | undefined
  Object.defineProperty(target, 'fullText', {
    configurable: true,
    enumerable: true,
    get: () => {
      fullTextCache ??= target.textSnapshot.materializeFullText()
      return fullTextCache
    },
  })
  return target as TTarget & { readonly fullText: string }
}

export function createDocumentTextSnapshot(
  snapshot: PieceTableSnapshot,
  materializedText?: string,
): DocumentTextSnapshot {
  return new PieceTableDocumentTextSnapshot(snapshot, materializedText)
}

export function createStringTextSnapshot(text: string): TextSnapshot {
  return new StringTextSnapshot(text)
}

class PieceTableDocumentTextSnapshot implements DocumentTextSnapshot {
  readonly length: number
  readonly #retainedText: string | undefined

  constructor(
    readonly snapshot: PieceTableSnapshot,
    materializedText?: string,
  ) {
    this.length = snapshot.length
    this.#retainedText = materializedText?.length === snapshot.length ? materializedText : undefined
  }

  materializeFullText(): string {
    const retainedText = this.#retainedText
    if (retainedText !== undefined) {
      recordFullTextSnapshotRead('textSnapshot.materializeFullText', this.length, true)
      return retainedText
    }

    return measureEditorPerformance(
      'textSnapshot.materializeFullText',
      () => materializePieceTableFullText(this.snapshot),
      () => fullTextSnapshotDetail(this.length, false),
    )
  }

  readRange(start: number, end: number): string {
    const retainedText = this.#retainedText
    const readsFullText = start === 0 && end === this.length
    if (retainedText !== undefined && readsFullText) {
      recordFullTextSnapshotRead('textSnapshot.readRange', this.length, true)
      return retainedText
    }

    if (!readsFullText) return readPieceTableTextRange(this.snapshot, start, end)
    return measureEditorPerformance(
      'textSnapshot.readRange',
      () => readPieceTableTextRange(this.snapshot, start, end),
      () => fullTextSnapshotDetail(this.length, false),
    )
  }

  forEachTextChunk(visit: (text: string, start: number, end: number) => void): void {
    const retainedText = this.#retainedText
    if (retainedText === undefined) {
      forEachPieceTableTextChunk(this.snapshot, visit)
      return
    }

    if (retainedText.length > 0) visit(retainedText, 0, retainedText.length)
  }
}

class StringTextSnapshot implements TextSnapshot {
  readonly #text: string

  constructor(text: string) {
    this.#text = text
  }

  get length(): number {
    return this.#text.length
  }

  materializeFullText(): string {
    return this.#text
  }

  readRange(start: number, end: number): string {
    return this.#text.slice(start, end)
  }

  forEachTextChunk(visit: (text: string, start: number, end: number) => void): void {
    if (this.#text.length > 0) visit(this.#text, 0, this.#text.length)
  }
}

function recordFullTextSnapshotRead(name: string, length: number, retained: boolean): void {
  recordEditorPerformanceDiagnostic(name, fullTextSnapshotDetail(length, retained))
}

function fullTextSnapshotDetail(
  length: number,
  retained: boolean,
): Readonly<Record<string, unknown>> {
  return {
    length,
    cached: retained,
    retained,
  }
}
