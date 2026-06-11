export class LineStartOffsetIndex {
  private readonly suffixDeltas = new Map<number, number>()
  private sortedSuffixDeltas: readonly (readonly [number, number])[] | null = null
  private dirtyValue = false
  // Bumped on every mutation so snapshot views can tell whether their
  // captured deltas still describe this index.
  public revision = 0

  public constructor(public readonly length: number) {}

  public get dirty(): boolean {
    return this.dirtyValue
  }

  public addSuffix(startRow: number, delta: number): void {
    if (delta === 0) return
    const row = normalizeRow(startRow)
    if (row >= this.length) return

    this.revision += 1

    const nextDelta = (this.suffixDeltas.get(row) ?? 0) + delta
    if (nextDelta === 0) {
      this.suffixDeltas.delete(row)
    } else {
      this.suffixDeltas.set(row, nextDelta)
    }
    this.sortedSuffixDeltas = null
    this.dirtyValue = this.suffixDeltas.size > 0
  }

  public offsetAt(row: number): number {
    const index = normalizeRow(row)
    if (index >= this.length) return 0

    let sum = 0
    for (const [startRow, delta] of this.sortedDeltas()) {
      if (startRow > index) break
      sum += delta
    }
    return sum
  }

  public materialize(lineStarts: readonly number[]): number[] {
    const materialized = lineStarts.slice() as number[]
    if (!this.dirtyValue) return materialized

    // Segment-wise: memcpy the base array once, then add the accumulated
    // delta to each suffix segment. Avoids a per-row delta scan on documents
    // with millions of lines.
    const deltas = this.sortedDeltas()
    let offset = 0
    for (let deltaIndex = 0; deltaIndex < deltas.length; deltaIndex += 1) {
      offset += deltas[deltaIndex]![1]
      const from = deltas[deltaIndex]![0]
      const to = deltaIndex + 1 < deltas.length ? deltas[deltaIndex + 1]![0] : materialized.length
      for (let row = from; row < to; row += 1) {
        materialized[row] = materialized[row]! + offset
      }
    }

    return materialized
  }

  private sortedDeltas(): readonly (readonly [number, number])[] {
    this.sortedSuffixDeltas ??= Array.from(this.suffixDeltas.entries()).toSorted(
      ([left], [right]) => left - right,
    )
    return this.sortedSuffixDeltas
  }

  // Immutable copy of the pending deltas for snapshot views.
  public snapshotDeltas(): readonly (readonly [number, number])[] {
    return [...this.sortedDeltas()]
  }
}

// Read-only line-start access over a base array plus pending suffix deltas.
// Snapshots hand this out instead of materializing a fresh array per edit:
// on large documents that rebuild costs more than the consumers, which only
// touch lines near the edit.
export class LineStartsView {
  readonly #base: readonly number[]
  readonly #rows: number[]
  readonly #cums: number[]
  readonly #onMaterialize: ((lineStarts: readonly number[]) => void) | null
  #materialized: readonly number[] | null = null

  public constructor(
    base: readonly number[],
    deltas: readonly (readonly [number, number])[],
    onMaterialize: ((lineStarts: readonly number[]) => void) | null = null,
  ) {
    this.#base = base
    this.#onMaterialize = onMaterialize
    this.#rows = []
    this.#cums = []
    let cum = 0
    for (const [row, delta] of deltas) {
      cum += delta
      this.#rows.push(row)
      this.#cums.push(cum)
    }
  }

  public get length(): number {
    return this.#base.length
  }

  public at(index: number): number | undefined {
    const base = this.#base[index]
    if (base === undefined) return undefined

    return base + this.#cumFor(index)
  }

  // Line containing `offset` (clamped to the document).
  public indexForOffset(offset: number): number {
    const clamped = Math.max(0, offset)
    let low = 0
    let high = this.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const start = this.at(middle) ?? 0
      const next = this.at(middle + 1) ?? Number.POSITIVE_INFINITY
      if (clamped < start) {
        high = middle - 1
        continue
      }
      if (clamped >= next) {
        low = middle + 1
        continue
      }
      return middle
    }
    return Math.max(0, this.length - 1)
  }

  // First index whose line start is >= offset.
  public firstIndexAtOrAfter(offset: number): number {
    let low = 0
    let high = this.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((this.at(middle) ?? Number.POSITIVE_INFINITY) < offset) low = middle + 1
      else high = middle
    }
    return low
  }

  public toArray(): readonly number[] {
    if (this.#materialized) return this.#materialized
    if (this.#rows.length === 0) {
      this.#materialized = this.#base
      return this.#base
    }

    const materialized = this.#base.slice() as number[]
    for (let segment = 0; segment < this.#rows.length; segment += 1) {
      const from = this.#rows[segment]!
      const to = segment + 1 < this.#rows.length ? this.#rows[segment + 1]! : materialized.length
      const cum = this.#cums[segment]!
      for (let row = from; row < to; row += 1) {
        materialized[row] = materialized[row]! + cum
      }
    }
    this.#materialized = materialized
    this.#onMaterialize?.(materialized)
    return materialized
  }

  #cumFor(index: number): number {
    let low = 0
    let high = this.#rows.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (this.#rows[middle]! <= index) low = middle + 1
      else high = middle
    }
    if (low === 0) return 0

    return this.#cums[low - 1]!
  }
}

export function createLineStartOffsetIndex(lineCount: number): LineStartOffsetIndex {
  return new LineStartOffsetIndex(Math.max(0, Math.floor(lineCount)))
}

function normalizeRow(row: number): number {
  if (!Number.isFinite(row)) return 0
  return Math.max(0, Math.floor(row))
}
