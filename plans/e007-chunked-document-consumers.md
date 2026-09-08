# E007: Remove remaining unnecessary full-document copies

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: L
- Dependencies: [E001](e001-stress-fixtures.md)
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`, 2026-09-05.

## Outcome

Opening find, updating syntax, or refreshing the minimap does not create an avoidable
full-document string on each edit. Required serialization remains visible in diagnostics.
A 48 MB file can remain open with several consumers without each retaining a private flat copy.
The actual target is measured live memory and input latency, not a count of method names.

## Current code

- [Text snapshots](../packages/editor/src/documentTextSnapshot.ts) already support `readRange`
  and `forEachTextChunk`. They retain explicitly supplied text, but do not cache new materializations.
- [The piece walker](../packages/editor/src/pieceTable/walker.ts) is implemented and tested.
  It is not work in progress as the wishlist claims.
- [Find](../packages/find/src/search.ts) already reads line ranges through `FindTextSource`.
  Multiline literals and regex patterns not proven line-safe still request larger ranges.
- [Tree-sitter input](../packages/tree-sitter/src/treeSitter/source.ts) already uses piece
  descriptors and retained worker chunks. It is not a full-string sync on every edit.
- [Minimap summaries](../packages/minimap/src/workerClient.ts) normally read snapshot ranges.
  Materialized-text fallbacks remain, and full summaries still construct line-start arrays.
- [LSP changes](../packages/lsp/src/positions.ts) already choose `snapshot-incremental`.
  [Document sync](../packages/lsp-plugin/src/documentSync.ts) consumes composed edit-chain changes.
- [The edit chain](../packages/editor/src/editor/editChain.ts) has bounded retention and
  explicit segment identity. Falling behind that retention window can require a full sync.

## Scope

Create a call-site and retention inventory, measure real paths, and fix justified residual copies.
Cover find, syntax, minimap, LSP, snapshot getters, and framework-controlled text bindings.
E008 owns matcher changes. E009 owns worker transport representation decisions.
Keep required host save, export, and external protocol serialization explicit and supported.
Platform filesystem writes and remote LSP proxy changes need their own host implementation scope.

## Design

Classify each full read by operation, document version, length, caller, and retention owner.
Distinguish an initial host-supplied string, a transient serialization, a repeated computation,
and a long-lived cache. A substring may retain backing storage, so use heap evidence too.
Enrich existing diagnostics instead of emitting one event per chunk or token.

Use `TextSnapshot`, `LineStartsView`, and the walker where consumers need bounded ranges.
Introduce a new API only if those shipped contracts cannot express the measured need.
Do not copy a readonly container just to satisfy a mutable signature.
Document lifetime and invalidation for any consumer-local decoded-string cache.
Avoid retaining both an old full string and the current chunk state after replacement or disposal.

For LSP, inspect `lsp.contentChanges.path` and `lsp.documentSync.editChain` first.
Normal typing bursts should use composed incremental changes when the server supports them.
Exercise and retain legitimate `full-sync`, `missing-edits`, `invalid-edits`, and
`length-mismatch` recovery paths. A protocol fallback is not automatically a defect.
If fallback frequency is unexplained, add the missing reason context before changing synchronization.

## Steps

1. Replay E001 open, edit-burst, undo, find, and close scenarios with diagnostics enabled.
   Publish full-read counts and bytes by consumer, plus heap retention after disposal.
2. Identify the highest measured avoidable copy and verify it on a known-good small control.
   Record the existing contract that can replace the copy.
3. Convert one consumer at a time and compare output at the exact same document version.
   Remove the obsolete eager state and its callers in that same change.
4. Add LSP fallback monitoring coverage using real incremental and full-sync server capabilities.
   Report whether the old wishlist's LSP concern still occurs in the baseline workload.
5. Repeat combined-consumer memory and typing measurements with the same fixtures.
   Attach call-site inventory and measured residual costs to the implementation result.

## Verification

From `packages/editor`, use `bun run test test/documentTextSnapshot.test.ts test/editChain.test.ts`.
From `packages/lsp`, use `bun run test test/positions.test.ts` when changing change construction.
From `packages/lsp-plugin`, use `bun run test test/documentSync.test.ts` for deferred synchronization.
Use focused minimap, find, or syntax package tests only for the consumer actually changed.
These tests catch stale versions, lost composed edits, and accidental eager full reads.

Measure initial open separately from warm edits and measure retained bytes after releasing views.
Test a slow worker, an edit-chain gap, undo onto another branch, and a closed document.
Accept when targeted avoidable copies disappear, required fallbacks retain correct text,
and the same workload improves peak or retained memory without a p95 typing regression.
If no residual copy is material, finish with the inventory and a documented no-change decision.

## Risks and decisions

The wishlist overstates several costs already removed. Do not rebuild the shipped walker or sync path.
Removing a cache can trade retained memory for repeated CPU work. Compare both in the real consumer.
Diagnostic collection itself can retain snapshots or text. Store identifiers and numeric totals only.
Any changed public contract requires built-export and React and Solid consumer checks.
