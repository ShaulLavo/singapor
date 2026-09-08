# E006: Reclaim deleted text without breaking retained document states

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: L
- Dependencies: [E001](e001-stress-fixtures.md), [E005](e005-piece-tree-inspector.md)
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`, 2026-09-05.

## Outcome

A long insert-and-delete session can return close to its live-document memory footprint.
Undo, retained snapshots, selections, and deleted-anchor bias keep their existing meaning.
For example, repeatedly replacing one paragraph does not leave the active tree proportional
to every paragraph ever inserted after obsolete history and external readers release their states.

## Current code

- [Deletion](../packages/editor/src/pieceTable/tree.ts) uses `markTreeInvisible`, retaining
  deleted pieces in new roots. `normalizePieceOrders` already rebuilds tree metadata.
- [History](../packages/editor/src/history.ts) now caps undo depth at 200 entries.
  The wishlist's unbounded-history claim is stale. A cap alone does not remove current-root tombstones.
- [Buffers](../packages/editor/src/pieceTable/buffers.ts) use a persistent paged chunk store.
  A surviving snapshot can retain chunk strings even after its visible pieces stop using them.
- [Anchors](../packages/editor/src/pieceTable/anchors.ts) resolve deleted positions using
  invisible pieces and reverse-index neighbors. Dropping those records can change positions.
- [DocumentSession](../packages/editor/src/documentSession.ts) also retains clean snapshots,
  history, transaction receipts, and staged transaction state beyond the active snapshot.

## Scope

Measure retention, define a safe ownership boundary, then implement bounded maintenance.
Count tree nodes, invisible pieces, buffer bytes, line indexes, and explicitly retained roots.
Include buffer reclamation when no protected root or anchor requires the buffer.
Do not compact by serializing the current text into a new document and discarding history.
Do not introduce shared-memory reclamation here. E012 owns that extension.

## Design

Start with an ownership inventory across session state, views, decorations, plugins,
prepared transactions, undo entries, save baselines, and asynchronous snapshot consumers.
Plain exported anchors and snapshots have no release protocol at this baseline.
Do not infer that an absent history entry means nobody holds the text.

Propose a maintenance input containing the active root, protected roots, and protected anchor records.
Choose between explicit scoped retention handles and preserving enough deleted-position metadata
to maintain every supported external anchor. Prove the chosen contract before removing any records.
Use opaque generation identifiers if compaction creates a new storage generation.
Migrate every affected caller in the same change. Do not preserve an untracked parallel API.

Build a new root and reverse index without mutating protected roots.
Preserve buffer identifiers and offsets where possible. If a rewrite needs remapping,
perform it atomically for every owned anchor and selection before publishing the new state.
A maintenance-only root replacement must not become a user edit, mark the file dirty,
increment the logical text revision, or invalidate a valid prepared transaction silently.

Schedule maintenance outside the keystroke path and bound work per scheduling turn.
Keep partially built state private. Cancel or restart if its input generation is no longer current.
Allow old generations to outlive the active one until their owners release them.
Record before-and-after retention and the reason reclamation was blocked.

## Steps

1. Extend E001 churn fixtures with pinned and released snapshots and deleted anchors.
   Publish baseline piece growth, retained bytes, and edit and walker latency distributions.
2. Map all retention owners and the mutation-lease and receipt rules in DocumentSession.
   Write the precise condition under which each tombstone and chunk becomes reclaimable.
3. Prototype compaction against a small snapshot graph using the E005 checker.
   Compare anchor resolution and historical text before and after every maintenance operation.
4. Implement one session-owned maintenance entry point and its bounded scheduler integration.
   Expose diagnostic counters, without adding a user setting unless host policy needs one.
5. Repeat the original churn measurement, including multiple views and pinned readers.
   Report memory reclaimed, peak rebuild memory, maintenance pauses, and unreclaimable owners.

## Verification

Use `bun run test test/pieceTable-anchors.test.ts test/pieceTable-snapshot.test.ts
test/documentSession.test.ts` from `packages/editor`, as one command.
Add a focused maintenance test file that checks retained snapshot text and deleted-anchor bias.
Test undo beyond a maintenance boundary, redo, a dropped redo branch, save-baseline equality,
receipt reversal, document replacement, and disposal during an unfinished rebuild.
Test a buffer reused by a different undo branch so identifiers alone cannot hide stale text.

Accept when repeated churn reaches a stable retained-memory range after releases,
all protected snapshots remain readable, and E005 reports no invariant violation.
Set the memory and pause budgets from E001's observed workload before choosing the algorithm.
The measured result must improve retained bytes without regressing p95 typing latency.

## Risks and decisions

This is an anchor-lifetime contract change before it is a garbage-collection algorithm.
If the ownership inventory cannot prove safe removal, stop after the measured design report.
Retaining a tiny deleted anchor may require a large original buffer under the present layout.
Measure whether a compact deleted-position record is worth that additional representation.
Coordinate E017 history branching with this retention contract before either changes history ownership.
