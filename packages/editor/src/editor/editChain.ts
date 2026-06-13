import type { TextEdit } from '../tokens'

type EditChainEntry = {
  readonly fromVersion: number
  readonly toVersion: number
  // null marks a text change whose edits are unknown; chains crossing it
  // cannot compose and consumers fall back to a full resync.
  readonly edits: readonly TextEdit[] | null
}

type ComposedEdit = {
  from: number
  to: number
  text: string
}

const MAX_ENTRIES = 128

// Records every text-version transition with its edits so deferred consumers
// (LSP sync, anything that batches behind rapid input) can ask for the exact
// edits between the version they last saw and the current document, composed
// into base coordinates. Without this they only see the final change of a
// batch and must fall back to shipping the whole document.
export class DocumentEditChain {
  #entries: EditChainEntry[] = []

  public record(fromVersion: number, toVersion: number, edits: readonly TextEdit[] | null): void {
    if (fromVersion === toVersion) return

    this.#entries.push({ fromVersion, toVersion, edits })
    if (this.#entries.length > MAX_ENTRIES) {
      this.#entries.splice(0, this.#entries.length - MAX_ENTRIES)
    }
  }

  public clear(): void {
    this.#entries = []
  }

  // Edits in `fromVersion` base coordinates whose batch application produces
  // the newest recorded version. Empty array when already current, null when
  // the chain is broken, unknown, or not composable.
  public editsSince(fromVersion: number): readonly TextEdit[] | null {
    const last = this.#entries.at(-1)
    if (!last) return null
    if (fromVersion === last.toVersion) return []

    const start = this.#entries.findIndex((entry) => entry.fromVersion === fromVersion)
    if (start === -1) return null

    let composed: ComposedEdit[] = []
    let cursorVersion = fromVersion
    for (let index = start; index < this.#entries.length; index += 1) {
      const entry = this.#entries[index]!
      if (entry.fromVersion !== cursorVersion) return null
      if (!entry.edits) return null

      const next = composeBatch(composed, entry.edits)
      if (!next) return null

      composed = next
      cursorVersion = entry.toVersion
    }

    return composed.map((edit) => ({ from: edit.from, to: edit.to, text: edit.text }))
  }
}

// Transforms `batch` (edits in current-document coordinates, mutually
// disjoint) into base coordinates against `composed` and merges them in.
// Returns null for shapes that do not compose cleanly (edits straddling a
// previous edit's boundary); callers fall back to a full resync, so bailing
// is always safe.
function composeBatch(
  composed: readonly ComposedEdit[],
  batch: readonly TextEdit[],
): ComposedEdit[] | null {
  const next = composed.map((edit) => ({ ...edit }))
  const inserts: ComposedEdit[] = []
  const sortedBatch = [...batch].sort((left, right) => right.from - left.from)

  for (const edit of sortedBatch) {
    if (!placeBatchEdit(next, inserts, edit)) return null
  }

  for (const insert of inserts) {
    if (!insertComposedEdit(next, insert)) return null
  }

  return next
}

function placeBatchEdit(
  composed: ComposedEdit[],
  inserts: ComposedEdit[],
  edit: TextEdit,
): boolean {
  const from = Math.min(edit.from, edit.to)
  const to = Math.max(edit.from, edit.to)
  let delta = 0

  for (const target of composed) {
    const currentStart = target.from + delta
    const currentEnd = currentStart + target.text.length

    if (to <= currentStart) break
    if (from >= currentStart && to <= currentEnd) {
      const offset = from - currentStart
      target.text =
        target.text.slice(0, offset) + edit.text + target.text.slice(offset + (to - from))
      return true
    }
    if (from < currentEnd) return false

    delta += target.text.length - (target.to - target.from)
  }

  inserts.push({ from: from - delta, to: to - delta, text: edit.text })
  return true
}

function insertComposedEdit(composed: ComposedEdit[], edit: ComposedEdit): boolean {
  let index = 0
  while (index < composed.length && composed[index]!.from < edit.from) index += 1

  const previous = composed[index - 1]
  if (previous && previous.to > edit.from) return false
  const following = composed[index]
  if (following && edit.to > following.from) return false

  // Touching edits must merge: two entries sharing a boundary would apply in
  // an undefined order relative to each other.
  if (following && edit.to === following.from) {
    following.from = edit.from
    following.text = edit.text + following.text
    mergeWithPrevious(composed, index)
    return true
  }
  if (previous && previous.to === edit.from) {
    previous.to = edit.to
    previous.text = previous.text + edit.text
    return true
  }

  composed.splice(index, 0, edit)
  return true
}

function mergeWithPrevious(composed: ComposedEdit[], index: number): void {
  const previous = composed[index - 1]
  const current = composed[index]
  if (!previous || !current || previous.to !== current.from) return

  previous.to = current.to
  previous.text = previous.text + current.text
  composed.splice(index, 1)
}
