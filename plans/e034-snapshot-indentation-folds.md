# E034: Maintain indentation folds from document snapshots

- Status: Implemented; performance validation pending
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: L
- Dependencies: [E003](../docs/performance/first-paint.md), [E032](../docs/performance/e032-edit-batches.md)
- Inspected baseline: `33e632a6ff8ee35a670c4f4636c0f6f84d36295a`, 2026-09-12.

## Outcome

Keep indentation and explicit-region folding when structural folding is unavailable, without
materializing the document or rebuilding unchanged line facts on ordinary edits. Preserve exact
fold boundaries, view-local collapse intent, prepared adoption, and E003's first-text behavior.

The snapshot implementation is present. Completion remains pending because the recorded browser
samples do not establish the required absence of p95 input and first-text regressions. Keep the
[implementation contract and measurements](../docs/performance/e034-snapshot-indentation-folds.md)
as evidence while this executable plan tracks the remaining acceptance work.

## Current code

- [IndentationFoldIndex](../packages/editor/src/editor/indentationFoldIndex.ts) reads immutable
  snapshots into bounded fact blocks and reuses persistent topology checkpoints through actual
  [TextEditBatch](../packages/editor/src/textEditBatch.ts) changes.
- [EditorFallbackFoldController](../packages/editor/src/editor/fallbackFoldController.ts) owns live
  generations. [Prepared documents](../packages/editor/src/editor/preparedDocument.ts) transfer
  compatible ready or unfinished indexes. Explicit fold commands may finish discovery synchronously.
- [SyntaxController](../packages/editor/src/editor/syntaxController.ts) selects fallback for missing
  sessions, unsupported folding, or terminal structural errors. Pending and supported sessions
  suppress fallback, including empty authoritative results.
- [EditorFoldState](../packages/editor/src/editor/foldState.ts) keeps collapse anchors per view and
  queries indexed folds without enumerating the whole document for each view update.
- The frozen pre-index baseline and unchanged control use `88cd55d`. The original candidate is
  `33e632a`. Its saved measurements show reduced repeated work and zero fallback materializations.
  Warm direct input p95 is 1.1 ms against 1.0 ms for both controls. Warm prepared first-text p95 is
  8.8 ms against 8.1 ms. Five attachment samples per group cannot establish a small latency shift.

## Scope

Own fallback correctness, bounded background work, prepared integration, diagnostics, and measured
acceptance. E007 owns the broader consumer inventory, and E033 owns the explicit full-text boundary.
No Platform settings, persistence, fallback-disable option, or host integration is part of E034.

## Design

Retain snapshot identity, effective tab width, and language rules as the index's compatibility
contract. Keep immutable line facts and topology separate from each view's collapse state.
Background work must yield during deep stack traversal as well as text and metadata discovery.
Only explicit synchronous fold commands may demand a complete cold index.

Publish manual, syntax, and fallback folds against the same document snapshot. An ordinary empty
result from an unsupported structural provider must schedule fallback discovery rather than force
a synchronous complete scan. Preserve exact offscreen results for explicit commands.

Retain the frozen correctness oracle and matched browser controls. Measure the final corrected
artifact independently from the original candidate. Do not reinterpret existing samples as proof
for source changes made after their recorded build hashes.

## Steps

1. Verify the review corrections with focused regressions: preserve collapsed syntax ranges beside
   remapped manual folds, keep unsupported-result discovery scheduled, and bound deep stack work.
2. Run index parity, prepared-transfer, shared-view, and edit-rendering checks after their relevant
   changes. Record cold, ordinary-edit, and explicit-demand costs separately.
3. Build the corrected core. Repeat the frozen baseline, unchanged control, and candidate browser
   runs under matching fixtures, browser, affinity, settings, and diagnostic mode.
4. Collect enough independent samples to assess p95 input and first-text behavior. Retain every
   sample and report uncertainty. If a regression remains unresolved, keep this plan open.
5. Once every acceptance check passes, update the permanent reference, mark the inventory Completed,
   update backlinks, and remove this executable plan under the backlog contract.

## Verification

From `packages/editor`, use `bun run test test/foldCollapseDurability.test.ts test/foldRanges.test.ts`
for the edit-ordering and unsupported-provider regressions. Use `bun run test test/indentationFoldIndex.test.ts`
for deep stacks and oracle parity. Include the prepared-document, shared-view, and virtualization
test files after relevant integration changes. Never use `bun test`. The required failures include stale fold
coordinates, lost collapse intent, unscheduled whole-index completion, unbounded deep stacks,
incorrect cancellation, and oracle divergence across multi-edit histories.

Build the changed core, run its typecheck, and run scoped lint and formatting checks. Check built
exports and React and Solid consumers if a public type changes. Run
`node scripts/check-editor-backlog.mjs` from the repository root after inventory changes.

Use the [recorded browser reproduction commands](../docs/performance/e034-snapshot-indentation-folds.md#reproduction)
without starting a server. The 500,000-line fallback fixture must use the same seed and hash for
all variants. Keep diagnostic runs separate from production timings. Verify text, fold boundaries,
and visible markers through the built browser artifact.

Accept zero fallback-attributed full-document strings, exact oracle parity, unchanged-region reuse,
bounded background slices, and reduced repeated work without p95 input or first-text regression.
Report preparation, retained memory, and synchronous cold commands separately. Keep reference-oracle
allocations outside fallback accounting. Do not close the plan on inconclusive timing evidence.

## Risks and decisions

Deep dedentation and region edits can affect distant ancestors. Their total work may be linear,
but background discovery must yield throughout that work. Explicit commands remain synchronous
and can be expensive on a cold document.

The original candidate has higher cold discovery and preparation costs. Timing quantization and
host variation can conceal small input differences. More measurements may still be inconclusive;
that leaves acceptance pending rather than establishing equivalence or changing the requirement.
