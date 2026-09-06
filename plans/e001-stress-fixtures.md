# E001: Repeatable stress fixtures and browser benchmarks

- Status: Implemented; local calibration provisional
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: M
- Dependencies: None
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`

## Outcome

Make large-file performance changes reproducible. An engineer can generate the same documents,
run the same editing scenarios, and compare latency, retained memory, and rendered output with
a baseline. Include a small ordinary file so a large-file win cannot hide a normal-file regression.

## Current code

- [Core benchmarks](../packages/editor/bench/virtualization.ts),
  [walker benchmarks](../packages/editor/bench/pieceTable-walker.ts), and
  [Tree-sitter benchmarks](../packages/tree-sitter/bench/treeSitter-syntax.ts) already exist.
- [Performance diagnostics](../packages/editor/src/editor/performanceDiagnostics.ts) already
  accept an opt-in sink. Extend that measurement path instead of instrumenting every subsystem twice.
- [Browser geometry tests](../packages/editor/test/virtualizedTextViewGeometry.browser.test.ts)
  and [the package test config](../packages/editor/vitest.config.ts) supply real-browser precedent.
- Platform already has [open](../../platform/apps/web/scripts/editor-open-benchmark.mjs) and
  [typing](../../platform/apps/web/scripts/editor-typing-benchmark.mjs) benchmarks. Reuse their
  observable definitions where applicable, while keeping the standalone Editor runner independent.

Inspect current benchmark commands and fixture generators again before adding any files. Older
TODO claims that all stress testing is ad hoc no longer describe the whole system.

## Scope

Generate seeded ordinary code, at least 500,000 short lines, a pathological long line, Unicode
with surrogate pairs and combining sequences, mixed line endings, and repeated edit/delete churn.
Include multiple views over one document and a hidden view. Do not check giant generated files
into Git or download an unpinned external corpus during a timing run.

Capture open-to-visible-text, first highlighted paint, jump-to-line, typing bursts, find-all,
scroll sweeps, and post-churn retention. Application startup and filesystem latency remain
Platform measurements. Editor measurements start at the public document/view boundary.

## Design

Use a versioned fixture manifest with seed, generator version, byte count, line count, and content
hash. Store small result JSON artifacts with commit, browser/version, hardware, feature options,
warm/cold state, repetitions, and raw samples. Keep latency percentiles separate from throughput.

Use the public built package and trusted browser input for interaction scenarios. Pair each timing
with a correctness observation: expected text and selection, rendered line, search count, or paint
generation. A fast operation that skipped work is a failed scenario. Separate instrumentation cost
from the disabled path and expose unsupported memory measurements instead of reporting zero.

## Steps

1. Inventory existing scripts and produce one scenario-to-runner mapping. Preserve useful runners;
   remove duplicated fixture generation only after callers use the common deterministic output.
2. Add the fixture generator and verify hashes, line counts, and adversarial boundary cases.
3. Add a standalone browser entry using the existing example/build conventions. Reuse an existing
   dev server for interactive work; a CI test process may own its documented fixture lifecycle.
4. Implement correctness-first scenarios, then record warmed and cold samples separately. Release
   documents, workers, event handlers, and generated temporary files after every scenario.
5. Record a baseline and choose per-scenario regression tolerances from repeated control runs.
   Publish the command and environment needed to reproduce it; do not invent a universal millisecond gate.

## Verification

Run the actual package benchmark scripts listed in [package.json](../packages/editor/package.json).
Use `bun run --cwd packages/editor test --project browser` for browser contracts when the configured
test files are relevant. Build public exports before tests that resolve `dist/`.

Prove same-seed reproducibility, expected document edits, a deliberate slowdown detected by the
comparison, and clean cancellation of a running scenario. The benchmark must reject missing samples,
different fixture hashes, or incomparable configurations. Compare a no-op rerun before interpreting
any improvement. Acceptance requires checked-in small manifests/results and a reproducible command,
not a screenshot of a timing panel.

## Risks and decisions

Decide reference hardware and supported browser engines before installing CI thresholds. Browser
memory APIs and GC scheduling differ; use retained object counts and process metrics where heap
bytes cannot be measured reliably. Never mistake a JavaScript callback or animation-frame callback
for proof that pixels reached the screen. Keep diagnostic and production measurements distinct.

## Implementation evidence

- Long-line follow-up: [four profiled bottlenecks fixed](../examples/stress/results/long-line-fix.md),
  with matched before/after runs, browser regression checks, and a fresh CPU profile.

- Runner and scenario inventory: [examples/stress](../examples/stress/README.md).
- Seeded corpus: [version 1 manifest](../examples/stress/results/manifest.json).
- Four control runs, independent rerun, derived limits, and diagnostic-cost observations:
  [local baseline](../examples/stress/results/README.md).
- Replayable verification: `bun run --cwd examples/stress proof`, with its checked
  [report](../examples/stress/results/verification.json).
- Reproduction: `bun run bench:stress --output /work/tmp/editor-stress/result.json --verify-cancellation`.

Verification passed eight fixture/comparison tests, twelve existing browser geometry contracts,
all six core benchmark scripts and the Tree-sitter syntax benchmark, typecheck, lint, targeted
Knip, and repository formatting. The recorded production runs contain 900 samples; a separate
36-sample diagnostic run verifies the opt-in sink while production controls keep it disabled.

The initial unchanged rerun exceeded nine latency and three resource limits. Its data became the
fourth control. A second independent rerun still exceeded three long-line timing limits and one
heap limit by 164 bytes. These outcomes remain in the checked evidence. No improvement is claimed
and no CI threshold is installed. Paint metrics end at screenshot completion and are labeled upper
bounds; memory reports main-renderer measurements and observed retained objects, with unsupported
measurements documented. A stable dedicated reference remains necessary before enabling CI gates.
