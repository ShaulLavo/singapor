# E008: Search document ranges with bounded work and exact results

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: L
- Dependencies: [E001](../examples/stress/README.md)
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`, 2026-09-05.

## Outcome

Find remains responsive on large and heavily edited documents while preserving regex,
whole-word, selection-scope, replacement, and Unicode behavior.
After an edit inside one line, a line-local query can rescan that line without rescanning
every unchanged line. A smaller rescan requires proof that matching has resynchronized.
Matches crossing piece boundaries remain discoverable.
The user sees a current match count and visible highlights as results become available.

## Current code

- [Search](../packages/find/src/search.ts) already accepts `FindTextSource` with `readRange`
  and a line-start view. Proven line-safe queries search per line.
- The same module uses native `indexOf` when equivalent to its regex semantics.
  Unknown or multiline regex constructs take a conservative whole-range path.
- [FindController](../packages/find/src/findController.ts) already has tracked scopes,
  deferred re-search, and a maximum deferral during sustained typing.
- Listing and painting currently cap matches at 19,999. Navigation scans beyond the cap,
  and Replace All deliberately requests a separate, much larger limit.
- [The walker](../packages/editor/src/pieceTable/walker.ts) and
  [edit chain](../packages/editor/src/editor/editChain.ts) are shipped prerequisites.
  The wishlist's flat-string-only search description is stale.

## Scope

Benchmark the current matcher, improve literal chunk traversal where justified, and add
incremental match maintenance for query classes whose dependency range can be proved.
Retain full correctness for general JavaScript regex through a documented conservative path.
Separate total match counting, retained match records, and visible highlight painting.
This plan is single-threaded and single-buffer. E014 owns worker and cross-file execution.
E007 provides useful copy measurements but is not a prerequisite.

## Design

Keep `FindQuery` semantics authoritative. Propose a compiled-query classification distinguishing
bounded literal work, proven line-local work, and whole-range work.
Do not claim that arbitrary regex can use a fixed overlap window.
Unbounded repetition, backreferences, lookaround, and multiline anchors need their full context
unless a specific incremental algorithm proves otherwise.

Compare native `indexOf` on bounded walker windows with Boyer–Moore–Horspool.
Carry one next-search cursor across windows within each original line or scoped scan range.
For a literal of length N, N minus one overlap units expose boundary candidates only.
Resume at the carried cursor. Never restart greedy matching at the overlap's first character.
After each raw match, advance the cursor by N, even if whole-word filtering rejects that match.
This preserves the current scanner's globally consistent non-overlap phase and UTF-16 coordinates.
For `aa` in `aaaaaaaaaa`, starts are `[0, 2, 4, 6, 8]` regardless of window boundaries.
Handle surrogate pairs split by edits and case-insensitive Unicode matches using the existing
search semantics as the oracle. Do not lowercase the whole document or change case-folding rules.
Benchmark line-wise scanning as a third control, especially for small files and long lines.

Propose a match index tied to a query identity and immutable document sync point.
Compose dirty ranges through the existing edit chain and restart scanning from a valid prior checkpoint.
Reuse transformed suffix matches only after the new and mapped old scan states agree and the remaining
text and required query context are unchanged. Equal text beyond the edit alone does not prove this.
Self-overlapping literals can propagate a changed non-overlap phase through an arbitrarily long run.
Use a full affected-line rescan for line-local queries until a smaller resynchronization is proved.
For multiline literals, rescan through the scoped range if no earlier safe checkpoint is established.
Whole-word boundaries also require neighboring character context. Preserve raw-match cursor state,
including matches rejected by whole-word filtering, when testing whether scans have resynchronized.
Fall back to a full search after an edit-chain gap, query change, or unsupported query classification.
Discard captures from prior versions before replacement. Revalidate replacement matches against
the current version and existing tracked scope before submitting one normal edit transaction.

Count all matches without allocating every highlight record. Distinguish pending, exact, and
truncated counts in the widget. Any retained cap must remain visible and never truncate Replace All.
Schedule bounded search slices through the existing scheduler so query typing can interrupt work.

## Steps

1. Run E001 literal and regex cases around 600,000 lines, with cold and warm searches.
   Include short documents, long lines, dense matches, and fragmented piece trees.
2. Compare matcher candidates and record time, allocation, characters inspected, and full-range reads.
   Keep native search if a JavaScript algorithm does not improve the actual workload.
3. Implement the winning literal traversal with its carried cursor and prove chunk-boundary equivalence.
   Preserve a general-regex fallback with an explicit diagnostic reason.
4. Implement incremental maintenance with proven resynchronization or a full-line or full-range fallback.
   Keep cancellation versioned and report which scans require the larger fallback.
   Compare every updated result with a fresh authoritative search over the same snapshot.
5. Connect progressive counts and visible highlights to the widget without weakening navigation.
   Repeat search-plus-typing browser measurements and record the chosen scheduling budget.

## Verification

From `packages/find`, use `bun run test test/search.test.ts test/findController.test.ts`.
Extend the tests with every chunk split of short representative strings, Unicode casing,
empty regex matches, lookaround, multiline patterns, whole-word boundaries, and scoped replacement.
These cases catch missed boundary matches and stale offsets after incremental updates.
Require `aa` over `aaaaaaaaaa` to return `[0, 2, 4, 6, 8]` with a window starting at offset 4
and overlap starting at offset 3. A restarted local scan yielding `[5, 7]` must fail.
Insert one `a` at the start of a long `a` run, then delete it. Compare every match with a fresh scan.
This catches blindly shifting distant old matches while their non-overlap phase has changed.
Repeat with self-overlapping `aba`, scoped ranges, and whole-word filtering that rejects raw matches.
Use seeded edit sequences to compare incremental results with the existing full-search oracle.
Test Find Next beyond the paint cap and Replace All beyond the listing cap.
Use the existing browser test setup for visible highlight movement and responsive query input.

Accept when exact supported results match the oracle and general regex retains its semantics.
Incremental work must stay within its proven dependency range, with full-line or full-range fallback
when the match phase cannot be shown to resynchronize sooner.
Require measured improvement over the current line-range implementation without a small-file regression.

## Risks and decisions

Match counting can dominate even when painting is virtualized. Include both in the measurements.
A pathological regex cannot be preempted inside one native `RegExp.exec` call.
If it needs isolation, record that as E014 work rather than promising cancellation here.
Coordinate the result protocol with E014, but avoid adding worker-only fields to the synchronous API.
