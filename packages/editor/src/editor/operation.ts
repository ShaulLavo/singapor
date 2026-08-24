import type { DocumentSessionChange } from '../documentSession'
import type { EditorViewContributionUpdateKind } from '../plugins'
import { viewContributionKindForChange, type SessionChangeOptions } from './editorUtils'

type EditorOperationChange = {
  readonly change: DocumentSessionChange
  readonly totalName: string
  readonly totalStart: number
}

export type EditorOperationFlush = {
  readonly changes: readonly EditorOperationChange[]
  readonly latest: EditorOperationChange
  readonly contributionKind: EditorViewContributionUpdateKind
  readonly revealOffset: number | null
  readonly revealAffinity: SessionChangeOptions['revealAffinity']
  readonly revealBlock: SessionChangeOptions['revealBlock']
  readonly syncDomSelection: boolean
}

/**
 * What one mutating pass over the editor still owes the view when it finishes.
 *
 * Only the net result of a pass is ever on screen. The states a multi-change
 * pass walks through on the way — a command that edits and then moves the
 * caret, a plugin applying a refactor — would each force their own reflow and
 * show nobody anything, so the view work waits here until the pass is done.
 */
export class EditorOperation {
  private readonly changes: EditorOperationChange[] = []
  private contributionKind: EditorViewContributionUpdateKind = 'selection'
  private revealOffset: number | null = null
  private revealAffinity: SessionChangeOptions['revealAffinity']
  private revealBlock: SessionChangeOptions['revealBlock']
  private syncDomSelection = false

  record(
    change: DocumentSessionChange,
    totalName: string,
    totalStart: number,
    options: SessionChangeOptions,
  ): void {
    this.changes.push({ change, totalName, totalStart })
    if (options.revealOffset !== undefined) {
      this.revealOffset = options.revealOffset
      this.revealAffinity = options.revealAffinity
      this.revealBlock = options.revealBlock
    }
    // Opting out is how a change protects selection state the browser is still
    // in the middle of owning — a composition, a drag — from being written
    // over. It waives only that change's own claim: another change in the same
    // pass that needs the DOM caret moved still gets it.
    if (options.syncDomSelection !== false) this.syncDomSelection = true
    // A caret move asks contributions for less than an edit does, so the one
    // coalesced update has to claim the widest kind in the pass — otherwise an
    // edit followed by a selection change tells contributions the text stood
    // still.
    if (viewContributionKindForChange(change) === 'content') this.contributionKind = 'content'
  }

  flush(): EditorOperationFlush | null {
    const latest = this.changes.at(-1)
    if (!latest) return null

    return {
      changes: this.changes,
      contributionKind: this.contributionKind,
      latest,
      revealAffinity: this.revealAffinity,
      revealBlock: this.revealBlock,
      revealOffset: this.revealOffset,
      syncDomSelection: this.syncDomSelection,
    }
  }
}
