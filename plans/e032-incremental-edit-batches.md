# E032: Render edit batches without flattening the document

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: L
- Dependencies: None
- Inspected baseline: `ff1dfeda9e52b308f57915da7372f7ac6e5f04f9`, 2026-09-08.

## Outcome

Typing at several cursors, applying several replacements, and undoing or redoing those edits
updates from the committed snapshot without assembling a full-document string. Replacing words near
the top and bottom must not read the unchanged gap just to render. Preserve single-edit latency,
selection, scroll, syntax/fold projection and coherent publication to plugins and other views.

## Current code

- [Session rendering](../packages/editor/src/editor/Editor.ts), `renderSessionChange` around
  lines 3285–3325, skips selection/synchronize/none and handles exactly one edit incrementally.
  Its remaining branch clears folds and calls `materializeFullText()` then `renderDocument()`.
- [Selection edits](../packages/editor/src/documentSelectionEdits.ts), `applyTextToSelections`
  around line 93, produces one edit per normalized selection. This is a real multi-edit caller.
- [Piece-table batches](../packages/editor/src/pieceTable/edits.ts), `snapBatchEditRanges` at 122
  and `applyBatchToPieceTable` at 278, address the original snapshot, validate/snap ranges together,
  and apply them in descending `from`, then descending `to` order. They are not sequential coordinates.
- [Session transactions](../packages/editor/src/documentSession.ts), `applyEdits` at 605,
  publishes the ranges actually applied. `invertTextEdits` at 2544 computes inverse offsets in the
  resulting document using cumulative deltas; undo/redo at 692/724 forwards inverse/original edits.
  A one-edit undo stays incremental; an empty undo stack returns `none` and does not render.
- [View edits](../packages/editor/src/virtualization/virtualizedTextView.ts), `applyEdit` at 580,
  chooses same-line, multiline or snapshot layout. These helpers assume one before/after transition.
  [Layout](../packages/editor/src/virtualization/virtualizedTextViewLayout.ts) already patches
  one changed row and defers same-line suffix offsets; multiline edits rebuild the line-start array.
- [Operation publication](../packages/editor/src/editor/Editor.ts), `updateSessionView` at 3046
  and `flushViewOperation` at 3128, owns decoration updates, selection, contribution notifications
  and ordered syntax handoff. Keep this owner; do not add another transaction or notification loop.

## Scope

Change Editor document-change projection and view layout: native session edits, multi-cursor typing,
programmatic batches, undo/redo and shared views. Host persistence, Platform, worker transport,
history representation and new commands remain outside this plan.

This is a bounded implementation slice of [E007](e007-chunked-document-consumers.md).
[E031](../docs/performance/e031-projection.md) owns lazy rows/indexing;
[E033](e033-explicit-full-text-boundary.md) owns full-text APIs and provider contexts;
[E034](e034-snapshot-indentation-folds.md) owns indentation fallback computation. None is a hard prerequisite.
E032 works with current row/index representation; E031 consumes the same batch contract.
Other consumers’ explicit full reads are separate from the render fallback this plan owns.

## Design

The proposed internal view/projection contract carries one immutable transition; no public export.

```ts
type ViewTextUpdate =
  | {
      readonly kind: 'edits'
      readonly before: TextSnapshot
      readonly after: TextSnapshot
      readonly edits: readonly [TextEdit, ...TextEdit[]]
    }
  | { readonly kind: 'replace'; readonly after: TextSnapshot }

// Proposed VirtualizedTextView method; existing single-edit path remains the fast path.
applyTextUpdate(update: ViewTextUpdate): void
```

`edits` contains actual normalized edits in `before` coordinates. The committed session owns
selection/history. Establish this invariant at the producer; never reapply edits to the buffer in paint.

Choose a direct batch projection:

1. Build one ordered edit map from actual applied ranges. Derive offset deltas and removed/inserted
   line counts from the before line index and inserted text. Map boundary positions with the existing
   affinity rules. Preserve the piece-table ordering of equal-position insertions and adjacent edits;
   final inserted text comes from `after`, not a guessed concatenation of edit strings.
2. Derive affected old row intervals, including row joins/splits, then their final row intervals.
   Merge overlapping intervals; edits far apart must retain separate dirty regions. Compute final
   line starts in one pass over retained index spans plus inserted breaks. With today's arrays a
   single index/row-array rebuild is acceptable; repeated whole-index work per edit is not.
3. Adopt `after` once. Patch/read changed final rows and remap surviving rows/offsets using that map.
   For wraps/inline/injected projections use the existing rebuild policy with the snapshot directly,
   preserving correctness; record this path separately. E031 later bounds that display-model work.
4. Project tokens, syntax/manual folds and row decorations from before to after using the same map
   and their current boundary-invalidating policies. Retain unaffected ranges; invalidate ranges
   that cannot survive. Do not repeatedly pass already-shifted ranges with the original text into
   single-edit helpers that expect a matching intermediate snapshot. Preserve live token-range
   metadata only when the batch projection actually proves it remains valid.
5. Commit final layout, tokens, fold state and mounted-row reconciliation together. Preserve existing
   `EditorOperation` ordering and `runAtomicRender` semantics: no intermediate contribution snapshot,
   caret reveal, public change notification or syntax request per member of the batch. Syntax still
   receives each real committed change in order, exactly once, through the existing operation owner.

A single edit delegates to the fast path. A content change without edit detail uses snapshot replacement,
preserving scroll and clearing stale projections without a giant string. Malformed native batches
require a producer fix and regression evidence, not a new fallback.

Reject two shortcuts: looping original edits through `applyEdit(edit, finalSnapshot)` mixes model
versions; replacing the span from first cursor to last materializes arbitrarily large unchanged gaps.
Do not recreate intermediate piece tables merely to reuse those helpers: the committed final snapshot
already exists, and direct batch mapping avoids duplicate document editing and retention.

## Steps

1. **Prove coordinates and establish baseline.** Read producer, inverse and equal-offset behavior.
   Capture the current two-cursor full-read count/bytes and rendered result using E001 fixtures.
   Verify selection-generated edits match surrogate snapping; fix a proven producer mismatch first.
2. **Implement the pure batch map.** Check resulting lengths, old/final dirty row intervals and mapped
   boundaries against a small full-string oracle in tests. Exercise insert/delete/replace mixtures,
   equal positions, adjacent ranges and line joins. Keep the production map independent of DOM.
3. **Add snapshot batch layout.** Teach the current view owner the new transition, preserving the
   one-edit path. Publish one final model/paint; retain snapshot replacement for missing edit detail.
   Demonstrate no full-text call or unchanged-gap read from the batch coordinator/layout fast path.
4. **Integrate dependent projections.** Route multi-edit `renderSessionChange` through the batch map;
   preserve selection, fold/token/decorations and plugin ordering. Delete its full-string branch.
   Add shared-view, nested-operation, undo/redo and slow-syntax cases before measuring throughput.
5. **Compare the real artifact.** Repeat small-control and large sparse-batch runs; separate model,
   range reads, mounted DOM, syntax and deferred fallback consumers. Report residual array copying
   explicitly rather than describing it as bounded viewport work. Coordinate the shared transition
   with E031; remove temporary compatibility adapters.

## Verification

Focused existing entry points: [documentSession tests](../packages/editor/test/documentSession.test.ts)
(two-selection case around 202 and one-edit typing undo around 319),
[piece-table edit tests](../packages/editor/test/pieceTable-edits.test.ts),
[view layout tests](../packages/editor/test/virtualizedTextViewLayout.test.ts),
[editor tests](../packages/editor/test/editor.test.ts),
[operation diagnostics tests](../packages/editor/test/performanceDiagnostics.test.ts), and
[multi-selection wrap/undo tests](../packages/editor/test/autoClose.test.ts).

From `packages/editor`: `bun run test test/documentSession.test.ts` and
`bun run test test/virtualizedTextViewLayout.test.ts`; narrow affected cases with `-t`.
Run focused typecheck/lint; built-export checks if exports change. Reuse the running app for browser checks.

- A large two-cursor edit with insertions at both ends catches accidental whole-string/gap reads.
  Instrument full reads and range spans; transformed-view eager rebuilds remain until E031 lands.
- Mixed same-line/multiline batches, adjacent edits, surrogate boundaries, combining marks and
  normalized CRLF text catch incorrect original/final coordinate mapping and line-index drift.
- Multi-cursor undo/redo must recover exact text, selections, scroll and mounted content. One-edit
  typing undo must retain its single-edit path.
- Preserve highlights, collapsed/manual folds, row decorations and inline projections across both
  disjoint and intersecting edits; delayed syntax must never publish tokens for a superseded version.
- Two views of one buffer and a reentrant change listener must observe only committed matching
  text/index/selection generations. Disposal/replacement must cancel older scheduled view work.
- Compare E001 small code, many short lines, long lines and sparse edit batches. Record full-read
  calls/bytes, row/index work, p50/p95 input-to-paint and retained heap under matching configurations.

Accept when session batch rendering no longer invokes full-document materialization, sparse plain
batches do not read the unchanged gap, output/atomicity checks pass, and the single-edit control has
no regression beyond repeated-control variability. Do not claim O(viewport) work or a universal time
budget while whole-array/model work remains. Preserve any residual consumer costs in the report.

## Risks and decisions

The main semantic risk is trusting an edit list that differs from the ranges the piece table applied.
Selection helpers currently return generated edits while piece-table application may snap/merge them;
programmatic edits explicitly publish snapped ranges. Determine whether selection normalization already
prevents that discrepancy, with a boundary case, before finalizing the batch contract.

A compound view operation can contain several sequential committed changes; those batches have
different before snapshots. Do not concatenate their arrays into one original-coordinate batch.
Repeated whole-token scans may replace the string copy with another scaling problem; measure and
retain the single-edit path. If the proposed batch map cannot preserve a consumer's boundary policy,
resolve that policy in its existing owner rather than materializing text or introducing fake sessions.
