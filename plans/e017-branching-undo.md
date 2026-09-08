# E017: Preserve alternate undo branches

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P2
- Effort: L
- Dependencies: None
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`

## Outcome

Keep both editing paths when a user undoes an edit and types something different.
For example, type A, then B, undo B, and type C. The user can still return to B.
Ordinary Undo and Redo remain predictable, and retention limits make clear which states remain available.
This plan supplies the history model and navigation API. [E019](e019-undo-graph-viewer.md) supplies its visual browser.

## Current code

- [history.ts](../packages/editor/src/history.ts) stores persistent undo and redo stacks.
  `commitEditorHistory` clears redo. `MAX_UNDO_DEPTH` already limits retained undo entries to 200.
- [documentSession.ts](../packages/editor/src/documentSession.ts) owns history in the shared text buffer.
  `commitRecordedHistory` and `shouldAmendTypingRun` coalesce typing into one transaction.
  Transactions retain before/after snapshots, selections, edits, and inverse edits.
- Undo and redo advance the document revision, update `DocumentEditChain`, and notify attached views.
  Prepared transactions, mutation leases, and external history barriers also touch the history state.
- [history tests](../packages/editor/test/history.test.ts) verify the depth cap.
  [document session tests](../packages/editor/test/documentSession.test.ts) cover typing and external barriers.
- The wishlist understates memory cost. A root can retain tree nodes, deleted text, buffers, and transaction payloads.
  Its suggested unconditional in-place amendment would also change a branch point's meaning.
  Transaction metadata records source and intent, but currently has no timestamp.

## Scope

Replace the internal stacks with bounded branching history and migrate every internal consumer.
Expose read-only node metadata, branch selection, and an explicit checkout operation through the document API.
Keep filesystem persistence in [E018](e018-persisted-undo.md) and graph UI in E019.
Platform continues to own multi-file workspace undo. Editor checkout must respect its external barriers.
Do not add merge-between-branches behavior or promise that every historical state survives forever.

## Design

Proposed `HistoryNodeId` values identify nodes within one buffer generation.
The buffer owns a node map, current node ID, retained root ID, and preferred redo child per parent.
Each retained non-root node has exactly one parent and one incoming transaction.
Expose immutable metadata snapshots rather than mutable parent/child objects or public treap internals.
Generate a monotonic sequence for ordering. Add timestamps explicitly only if the viewer needs wall-clock labels.

Undo moves to the parent and remembers the child it left. Redo follows that remembered child.
A new edit creates a child and makes it the preferred redo branch without discarding siblings.
An explicit branch selection changes the preferred child. Missing or pruned IDs produce a typed unavailable result.
Keep the graph a tree. Cross-branch merges require a separate conflict design.

Amend only the active unsealed leaf of the current typing run.
Navigating history, publishing an external checkpoint, or creating a child seals that node.
After undo, the next keystroke creates a sibling even when the characters would otherwise coalesce.
An amendment updates the leaf revision and incoming transaction together so readers invalidate stale summaries.

Start with a finite policy comparable to the existing 200 transitions, measured across the entire graph.
Prune least-recently-visited inactive leaves first, then advance the retained root along the active ancestry.
Advancing the root removes its incoming transaction and references to ancestors that have been dropped.
Current state, active mutation receipts, and external barrier state are protected ownership references.
Bound temporary inspector pins too. Do not let UI subscribers silently defeat the retention policy.
Report retained nodes and payload estimates separately from measured heap. Node count is not a byte bound.
Coordinate anchor and snapshot ownership with [E006](e006-tombstone-reclamation.md) without requiring its compactor to ship first.

Checkout runs through the existing buffer mutation boundary and honors mutation leases.
Find the common ancestor and compose inverse/forward edits into one consistent document change.
Preserve monotonic revisions, edit-chain correctness, saved-state dirtiness, selection affinity, and source-view identity.
Attached views receive the same final text revision while retaining their existing view-selection ownership rules.
Native checkout cannot cross an external workspace barrier. Its metadata marks the boundary as unavailable.
Disposing the buffer or releasing history references must release subscriptions, nodes, and transition payloads.

## Steps

1. Capture a bounded history trace for linear typing, branching, and external workspace barriers.
   Record retained roots, transaction bytes, and commit/undo timings as the baseline.
2. Implement the pure graph operations in `history.ts` and focused history tests.
   Demonstrate A/B/C branching, preferred redo selection, sealed coalescing, and deterministic pruning.
3. Migrate all history access in `documentSession.ts`, including receipt reversal and barrier release paths.
   Existing prepared-transaction tests must still reject stale revisions and block mutation while leased.
4. Add the proposed inspection and checkout API to the public document export.
   Use a demo command to select a sibling branch and prove every mounted view reaches the same text revision.
5. Re-run the baseline trace, record retention and timing changes, and document the chosen retention policy.
   If branch checkout requires a full text replacement, measure its downstream syntax/LSP cost before accepting it.

## Verification

- Extend `history.test.ts` to catch lost siblings, redo pointing at a pruned child, and mutation of a sealed node.
- Extend `documentSession.test.ts` to catch wrong inverse coordinates, selection-affinity loss, and stale prepared commits.
  Include branch checkout while leased, across a barrier, after barrier release, and with two views attached.
- Exercise long insert/delete sessions and repeated branch pruning. Inspect retained objects after references are released.
  A lower node count alone does not prove that old snapshots or deleted text became unreachable.
- Run `bun run test --project dom test/history.test.ts test/documentSession.test.ts` in `packages/editor`.
  Build the package before its `public-api.test.ts` check and typecheck the React and Solid consumers.
- Acceptance requires reachable retained branches, unchanged external undo boundaries, correct dirty state,
  and measured memory growth consistent with the declared retention policy.

## Risks and decisions

The main risk is changing external receipt/barrier semantics while replacing the stack representation.
Stop if native checkout can undo one leg of a Platform workspace operation independently.
Old transaction snapshots can defeat pruning even after parent links disappear, so audit every retained reference.
Protected receipts may exceed the ordinary history budget. Report that pressure and require explicit release ownership.
Choose any byte-based retention setting from measurements, then expose host policy through configuration rather than globals.
