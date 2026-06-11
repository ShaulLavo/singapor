export class LineStartOffsetIndex {
  private readonly suffixDeltas = new Map<number, number>()
  private sortedSuffixDeltas: readonly (readonly [number, number])[] | null = null
  private dirtyValue = false

  public constructor(public readonly length: number) {}

  public get dirty(): boolean {
    return this.dirtyValue
  }

  public addSuffix(startRow: number, delta: number): void {
    if (delta === 0) return
    const row = normalizeRow(startRow)
    if (row >= this.length) return

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
}

export function createLineStartOffsetIndex(lineCount: number): LineStartOffsetIndex {
  return new LineStartOffsetIndex(Math.max(0, Math.floor(lineCount)))
}

function normalizeRow(row: number): number {
  if (!Number.isFinite(row)) return 0
  return Math.max(0, Math.floor(row))
}
