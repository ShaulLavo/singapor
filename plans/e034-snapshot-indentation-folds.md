# E034: Maintain indentation folds from document snapshots

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: L
- Dependencies: [E003](e003-first-paint-startup.md), [E032](e032-incremental-edit-batches.md)
- Inspected baseline: `ff1dfeda9e52b308f57915da7372f7ac6e5f04f9`, 2026-09-08.

## Outcome

Keep useful indentation and explicit-region folding when no structural provider can supply it,
without materializing the document or rebuilding every line on ordinary edits. Typing inside a
500,000-line plain-text document should reuse unchanged indentation facts and fold topology.
Changing an outer indent or region marker still updates every affected fold correctly.
Preserve E003's first-text-first behavior and ready prepared-fold adoption.

## Current code

- [SyntaxController.usesFallbackFolds](../packages/editor/src/editor/syntaxController.ts) returns
  true with no structural session, `foldingSupport: 'unsupported'`, or structural status `error`.
  A missing language, absent provider, or provider declining the language can produce no session.
  A Shiki-only highlighter does not establish structural folding support.
- A `pending` or `supported` structural session suppresses fallback, including an authoritative
  empty fold result and a parsed range that does not yet cover the viewport. Do not reintroduce
  provisional indentation while grammar folds load. An edit-request failure first reloads the
  structural session; terminal refresh failure sets `error` and enables fallback.
- [Tree-sitter session](../packages/tree-sitter/src/session.ts) starts resolver-backed support as
  `pending`; missing language descriptors or empty fold queries become `unsupported`. A supported
  parser can fail. These are distinct observed states, not a single “syntax unavailable” flag.
- [Editor.syncFallbackFoldProjection](../packages/editor/src/editor/Editor.ts) also checks
  `grammarDescribedFolds` and existing syntax projections before calling `materializeFullText()`.
  [foldRanges.ts](../packages/editor/src/editor/foldRanges.ts) scans for `region`, allocates one
  record per line, walks bottom-up, and rejects crossing ranges. Its “first parse has not landed”
  comment predates the current suppression rule; update it during implementation.
- E003 schedules this work after text: 150 ms debounce, 400 ms maximum burst delay. Explicit fold
  commands and direct fold methods flush it synchronously; some manual-fold operations also call
  synchronization. It runs without a gutter. Deferral changes timing, not repeated CPU work.
- [Prepared metadata](../packages/editor/src/editor/preparedDocument.ts) computes fallback ranges
  from a full string before structural stages run, even when later structural support replaces them.
- [E003 evidence](../docs/performance/first-paint.md) records a 34.8 ms baseline scan and a 30.5 ms
  deferred scan in separate 500k-line diagnostics. Those local observations establish reachability,
  not an E034 speed target. Recheck source and dirty state before executing this plan.

## Scope

Own the core fallback policy reason, snapshot-based line facts, incremental fold index, prepared
metadata integration, projection/command consumers, diagnostics, and focused tests/benchmarks.
Use shipped [TextSnapshot](../packages/editor/src/documentTextSnapshot.ts), the
[piece walker](../packages/editor/src/pieceTable/walker.ts), line views, and E032's actual edit batch.
E007 owns the broader consumer inventory; E033 owns eliminating implicit full-text API access.
E034 supplies their fallback consumer contract. No Platform settings, persistence, or UI edits.
Do not add a disable knob: removing a gutter is not disabling fold commands, and no existing
fallback-off contract was found. Useful unsupported-language behavior remains the default.

## Design

Create a proposed internal `IndentationFoldIndex` owned by the document analysis lifecycle,
keyed by immutable snapshot identity, language folding rules, and effective tab size. Do not key
solely by document ID or numeric revision: two sessions and undo branches may reuse those values.
Retain only current/in-progress generations plus explicitly owned prepared snapshots; release them
on replacement/disposal. Shared views may reuse immutable facts; collapse state remains view-local.

Store line facts in bounded immutable blocks: code-unit length, blank/indent columns, marker kind,
and stable line identity. Aggregate row/offset lengths so insertion does not rewrite every later
absolute offset. Read snapshot chunks without concatenation or `readRange(0, length)`; never replace
one full read with a full line-start array or a huge per-line string. Leading whitespace and marker
recognition must carry state across chunks. Preserve the shipped anchored marker rules through a
streaming classifier at their existing language-configuration owner; verify equivalence before
replacing regex consumers. No arbitrary prefix cutoff or new general-purpose regex parser.

Preserve the existing bottom-up folding semantics using persistent stack checkpoints at block
boundaries. Stack nodes carry stable line references; sharing must avoid copying depth-sized stacks
at every checkpoint. On an edit, rebuild changed/boundary line facts, then propagate upward until
the full semantic boundary state converges, not merely the visible indent or top stack entry.
Compare surviving line references after coordinate mapping. Reuse unaffected blocks and regions.
Changes that leave blankness, indentation, and marker classification unchanged reuse fold topology;
only lengths/positions change. Blank/off-side behavior and unmatched/nested markers are dependencies.

Deep dedentation or a region edit can affect arbitrarily distant ancestors. Never scan only the
viewport and declare enclosing folds complete. Initial discovery and genuine broad invalidation
can be O(document); background jobs process bounded chunks through the existing work scheduler,
check cancellation/version, and publish only coherent current results. Retain collapse intent
separately; project only proven-safe regions while rebuilding, never label unknown coverage ready.

Expose internal range/ancestor queries for view consumers and explicit complete traversal for
fold-all/level/recursive commands. Do not flatten the index into a fresh document-wide array on
every view update. Migrate the minimal internal projection/fold-state readers together; preserve
manual folds, crossing-range rejection, collapse identity, and public marker keys/coordinates.

The existing synchronous boolean fold APIs stay synchronous. Explicit commands finish the current
index work needed to answer exactly, including offscreen boundaries; they must not silently return
false because preparation is pending, or execute later against another document. Cold explicit
fold-all may synchronously discover/enumerate the document. Report that explicit demand and its
cost; bounded background tasks do not imply a constant-time synchronous command contract.

Prepared metadata uses the same snapshot index, never a second string scanner. Ready compatible
fallback metadata still installs atomically. Preserve preparation/revision/configuration matching
and report preparation cost separately from attachment. Defer optional incomplete work as in E003;
do not force it during adoption when structural folding owns the document.

## Steps

1. Instrument fallback selection and work before optimizing. Extend existing wide syntax/fold
   events and the opt-in performance sink with reason (`no-language`, `no-session`, `unsupported`,
   `structural-error`), provider/support/status, document/snapshot/configuration identity, trigger
   (attach/edit/prepared/explicit command), and grammar-projection suppression. Record one work
   summary: rows/code units read, fact blocks rebuilt/reused, propagation distance, fold count,
   materializations, retained bytes, duration, and completed/cancelled/reused outcome. No line text.
   Reproduce each reason plus pending/supported suppression; distinguish a skipped job from no folds.
2. Capture the current pure algorithm as a test-only correctness oracle. Implement snapshot line
   facts and initial checkpoint construction. Compare complete ranges and marker endpoints across
   chunk boundaries, tabs, blank lines, region syntaxes, and huge lines; forbid full reads in tests.
3. Add E032 batch invalidation, undo/redo/replacement/configuration paths and convergence reuse.
   Prove non-structural edits reuse topology. Yield broad background work; discard stale partial
   generations. Test deep scopes and persistent-stack memory before wiring all consumers.
4. Replace live and prepared string-scanner callers and integrate indexed projections/commands.
   Preserve E003 scheduling, prepared atomicity, provider transitions and collapse transfer.
   Remove obsolete production scanner/line arrays and their callers in this same milestone.
5. Compare frozen baseline, unchanged control and candidate under identical fixtures and settings.
   Report first text, preparation, edit bursts, explicit-command latency, scanned units and retained
   memory independently. Record remaining unavoidable cold/global demand in a stable performance doc.

## Verification

From `packages/editor`, run `bun run test test/foldRanges.test.ts test/foldOperations.test.ts`
and `bun run test test/preparedDocument.test.ts` after the corresponding integration changes.
Add focused snapshot-index tests through that same script; no `bun test`. Required failures:
- No provider, no language, unsupported descriptor/query, parser failure/recovery, supported empty
  result, pending grammar and incomplete viewport coverage select the correct owner without blink.
- Nested/unmatched regions, deep indent stacks, mixed tabs/spaces, trailing blanks, CRLF, EOF and
  markers split across pieces match the oracle. A non-indent edit does not rescan unchanged rows.
- Multi-cursor changes, newline joins/splits, dedent near EOF, undo branch changes, tab-size/language
  changes and an edit-chain gap invalidate exactly or report a deliberate cold rebuild.
- Fold-at-caret/recursive/level/all commands issued before scheduled work cover offscreen ancestors
  and endings; manual/collapsed folds survive valid remapping. No delayed command replay occurs.
- Disposal, replacement during a yielded build, two views, and prepared transfer release stale
  snapshots and prevent mixed-version publication. Deep checkpoints do not retain O(depth × blocks).

Build changed core output, run its `typecheck`, and use scoped lint/format checks. If a public type
changes, check built exports and React/Solid consumers in this repo; host adoption remains separate.
Reuse E003's built-package browser runner without starting a server. A narrow control command is:
`bun run --cwd examples/stress bench:first-paint --repetitions 1 --fixtures ordinary --plugins none --modes direct --output /work/tmp/editor-e034/smoke.json`.
Extend that runner with fallback edit/command cases; run its 500k-line case only for matched evidence.
Diagnostic runs remain separate from production timings; verify text/markers with actual pixels.
Accept zero fallback-attributed full-document strings, exact oracle parity, unchanged-region reuse,
bounded background slices, and measured reduced repeated work without p95 input/first-text regression.
Count reference-oracle allocations separately. A renamed/deferred whole scan is not completion.

## Risks and decisions

Checkpoint convergence is semantic, not a fixed number of surrounding lines. If the prototype cannot
prove it, retain correctness and report broad propagation; do not ship stale scope boundaries.
Index/projection enumeration can replace scanning as the bottleneck; measure both, including no-gutter
and explicit fold-all controls. A sync cold command remains potentially expensive by contract.
Preserve useful fallback on structural failure without adding a retry policy. E033's final full-text
gate depends on E034, not vice versa; keep the coordinated plans free of a dependency cycle.
