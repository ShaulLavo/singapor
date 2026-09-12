# Editor backlog

34 stable entries cover all 22 topics in the original [wishlist](../TODO.md).
Executable plans include source evidence, scope, delivery steps, and acceptance checks.
Completed entries link to permanent implementation references and measured results.
The original inspected Editor baseline is `9abb944f3a2b8d6516953fdec75e8df5e1a94811` (2026-09-05).
E031–E034 were inspected at `ff1dfeda9e52b308f57915da7372f7ac6e5f04f9` (2026-09-08).
Recheck source before execution; these dates record planning, not feature completion.

There are **27 Editor-owned entries, 6 requiring both repositories, and 1 Platform-owned entry**.
By deliverable, there are **22 implementation entries, 10 research entries, and 2 design entries**.
Editor ownership describes where the work lands; dependencies can still include shared work.
[Platform's roadmap](../../platform/PLAN.md) remains the execution scheduler.
[E002](../docs/performance/input-latency.md) is complete, with a verified local latency gate.
[E031](../docs/performance/e031-projection.md) is complete, with indexed display projection and measured before/after results.
[E032](../docs/performance/e032-edit-batches.md) is complete, with incremental batches, preserved projections, and shared-view ordering checks.
[E003](../docs/performance/first-paint.md),
[E004](../examples/stress/results/hidden-rendering.md), and
[E005](../docs/storage/piece-tree-inspection.md) are complete; their execution plans have been removed.
[E001](e001-stress-fixtures.md) is implemented, but its broader calibration remains provisional.
[E034](../docs/performance/e034-snapshot-indentation-folds.md) is complete, with snapshot fold maintenance and measured before/after results.
The other retained plans are incomplete.
The order below is a recommendation.

The existing [Platform Plan 071 — syntax highlight retry](../../platform/plans/071-syntax-highlight-retry.md)
is an additional Editor-only proposal. It remains in its existing file; E003 coordinates with it.

## How to read the plans

IDs are stable references, not a serial execution order. **Needs** lists hard prerequisites.
Optional integrations appear in each plan's text. Research dependencies require a positive
adoption decision where stated; completing a no-go study does not unlock a rewrite automatically.

P1 is the suggested performance/reliability foundation; P2 is a useful feature or enabling study;
P3 is a larger architecture bet. These are planning priorities, not incident severity.
Size is relative scope: S = one bounded change, M = one subsystem, L = several coupled parts,
XL = an architecture or cross-repository program. Sizes are not calendar commitments.

Implementation plans end in verified behavior or evidence that the requested optimization is
already satisfied. Research plans end in a runnable proof, measurements, and a go/no-go decision.
Design plans end in a checked contract and bounded follow-up work. None of these labels promises
that an unmeasured optimization will help.

## Suggested starting order

| Track                       | Start                                                                                                                                                                                                                                                     | Continue after its checks pass                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Performance foundation      | E003 startup, E007 copies, or E008 find using the [E001 harness](e001-stress-fixtures.md)                                                                                                                                                                 | E006 reclamation also uses the [E005 inspector](../docs/storage/piece-tree-inspection.md).                                  |
| Display and full-text reads | [E007 consumer inventory](e007-chunked-document-consumers.md), building on completed [E031](../docs/performance/e031-projection.md), [E032](../docs/performance/e032-edit-batches.md), and [E034](../docs/performance/e034-snapshot-indentation-folds.md) | E033 closes the explicit full-text boundary after E007/E031/E032/E034.                                                      |
| Everyday editing            | [E021 styled copy](e021-styled-clipboard.md) or [E020 jump history](e020-cursor-jump-history.md)                                                                                                                                                          | These are independently scoped Editor features; they need no shared-memory work.                                            |
| History                     | [E017 branching undo](e017-branching-undo.md)                                                                                                                                                                                                             | E019 viewer and E018 persisted history can follow independently once the graph contract is stable.                          |
| Developer tools             | [E024 syntax inspector](e024-syntax-tree-inspector.md)                                                                                                                                                                                                    | E023 timing panel follows E001; its deep piece-tree integration is optional.                                                |
| Extensions                  | [E026 command metadata](e026-command-metadata.md) and [E027 hook contract](e027-extension-hooks.md)                                                                                                                                                       | E028 modal proof exercises the API, then E025 reloadable-plugin research. E029 data vocabulary can run independently.       |
| Large-file architecture     | [E009 transport measurements](e009-worker-transport-costs.md) after E001                                                                                                                                                                                  | E010/E011 prototypes, then E012 lifetime proof, then conditional E013 adoption. E014 parallel search does not require E013. |
| Other independent work      | [E030 flat explorer](e030-flat-file-explorer.md)                                                                                                                                                                                                          | E015 loading, E016 parsing, and E022 compact rows can be studied separately after their measurement prerequisites.          |

E021 and E024 can proceed independently of the experimental storage program.

## Current-code corrections

The wishlist contains useful motivation and historical assumptions. The plans narrow work around
what already ships:

- Find already reads ranges and handles proven line-local queries without flattening the document.
  E007/E008 target remaining copies and exact bounded work, including self-overlapping matches.
- Tree-sitter shared text is already decoded once and cached. E009 measures remaining costs before
  E010–E013 consider different storage or transport. Minimap range reads and incremental LSP sync exist.
- E031 replaced the eager display model with an indexed projection and bounded row materialization.
  E032 keeps session batches incremental. E034 preserves reachable
  indentation fallback using snapshots, and E033 makes deliberate full-text extraction explicit.
- Undo already has a depth limit; branches need a retention policy. Cursor Undo/Redo also exists;
  E020 adds an edit-surviving trail for meaningful jumps.
- Single-selection styled HTML copy already ships. E021 adds multiple selections and portable colors.
- The virtualizer accepts variable row sizes, but text geometry still assumes a uniform stride.
  E022 must prove all caret, pointer, scroll, and selection mappings agree.
- Prepared opens, shared chords, extension hooks, and Platform command metadata already exist.
  The relevant plans extend those owners and contracts.

## Responsiveness and measurement

| Plan                                                                                            | Kind           | Owner  | Priority | Size | Needs                           |
| ----------------------------------------------------------------------------------------------- | -------------- | ------ | -------- | ---- | ------------------------------- |
| [E001 — Repeatable stress fixtures and browser benchmarks](e001-stress-fixtures.md)             | Implementation | Editor | P1       | M    | —                               |
| [E002 — Enforce the input-to-paint budget](../docs/performance/input-latency.md)                | Implementation | Editor | P1       | M    | [E001](e001-stress-fixtures.md) |
| [E003 — Keep optional startup work off first paint](../docs/performance/first-paint.md)         | Implementation | Editor | P1       | M    | [E001](e001-stress-fixtures.md) |
| [E004 — Suspend rendering in zero-height views](../examples/stress/results/hidden-rendering.md) | Implementation | Editor | P2       | S    | [E001](e001-stress-fixtures.md) |

## Display projection and explicit text reads

| Plan                                                                                                                | Kind           | Owner  | Priority | Size | Needs                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------- | -------------- | ------ | -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [E031 — Replace eager display rows with an indexed projection](../docs/performance/e031-projection.md)              | Implementation | Editor | P1       | L    | [E001](e001-stress-fixtures.md)                                                                                                                                                                              |
| [E032 — Render edit batches without flattening the document](../docs/performance/e032-edit-batches.md)              | Implementation | Editor | P1       | L    | —                                                                                                                                                                                                            |
| [E033 — Make full-document text reads an explicit boundary](e033-explicit-full-text-boundary.md)                    | Implementation | Editor | P1       | L    | [E007](e007-chunked-document-consumers.md), [E031](../docs/performance/e031-projection.md), [E032](../docs/performance/e032-edit-batches.md), [E034](../docs/performance/e034-snapshot-indentation-folds.md) |
| [E034 — Maintain indentation folds from document snapshots](../docs/performance/e034-snapshot-indentation-folds.md) | Implementation | Editor | P1       | L    | [E003](../docs/performance/first-paint.md), [E032](../docs/performance/e032-edit-batches.md)                                                                                                                 |

## Storage and worker transport

| Plan                                                                                                      | Kind           | Owner      | Priority | Size | Needs                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | -------------- | ---------- | -------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| [E005 — Inspect piece trees and verify their invariants](../docs/storage/piece-tree-inspection.md)        | Implementation | Editor     | P2       | M    | —                                                                                                               |
| [E006 — Reclaim deleted text without breaking retained document states](e006-tombstone-reclamation.md)    | Implementation | Editor     | P1       | L    | [E001](e001-stress-fixtures.md), [E005](../docs/storage/piece-tree-inspection.md)                               |
| [E007 — Remove remaining unnecessary full-document copies](e007-chunked-document-consumers.md)            | Implementation | Editor     | P1       | L    | [E001](e001-stress-fixtures.md)                                                                                 |
| [E008 — Search document ranges with bounded work and exact results](e008-in-buffer-search.md)             | Implementation | Editor     | P1       | L    | [E001](e001-stress-fixtures.md)                                                                                 |
| [E009 — Decide worker transport changes from measured costs](e009-worker-transport-costs.md)              | Research       | Editor     | P2       | M    | [E001](e001-stress-fixtures.md)                                                                                 |
| [E010 — Prove a shared allocator and concurrent hash map](e010-shared-memory-toolkit.md)                  | Research       | Editor     | P3       | L    | [E009](e009-worker-transport-costs.md)                                                                          |
| [E011 — Evaluate a packed representation of persistent piece trees](e011-packed-piece-tree.md)            | Research       | Editor     | P3       | L    | [E005](../docs/storage/piece-tree-inspection.md), [E009](e009-worker-transport-costs.md)                        |
| [E012 — Reuse shared storage only after every reader releases it](e012-epoch-reclamation.md)              | Research       | Editor     | P3       | L    | [E006](e006-tombstone-reclamation.md), [E010](e010-shared-memory-toolkit.md), [E011](e011-packed-piece-tree.md) |
| [E013 — Let eligible workers read shared immutable document snapshots](e013-shared-document-snapshots.md) | Research       | Cross-repo | P3       | XL   | [E010](e010-shared-memory-toolkit.md), [E011](e011-packed-piece-tree.md), [E012](e012-epoch-reclamation.md)     |

## Search and massive files

| Plan                                                                                           | Kind           | Owner      | Priority | Size | Needs                                                                       |
| ---------------------------------------------------------------------------------------------- | -------------- | ---------- | -------- | ---- | --------------------------------------------------------------------------- |
| [E014 — Search immutable snapshots across workers and stream results](e014-parallel-search.md) | Implementation | Cross-repo | P2       | L    | [E001](e001-stress-fixtures.md), [E008](e008-in-buffer-search.md)           |
| [E015 — Design bounded loading for massive files](e015-massive-file-loading.md)                | Research       | Cross-repo | P3       | XL   | [E001](e001-stress-fixtures.md), [E007](e007-chunked-document-consumers.md) |
| [E016 — Evaluate bounded structural parsing](e016-bounded-structural-parsing.md)               | Research       | Editor     | P2       | L    | [E001](e001-stress-fixtures.md)                                             |

## Editing and history

| Plan                                                                                                | Kind           | Owner      | Priority | Size | Needs                           |
| --------------------------------------------------------------------------------------------------- | -------------- | ---------- | -------- | ---- | ------------------------------- |
| [E017 — Preserve alternate undo branches](e017-branching-undo.md)                                   | Implementation | Editor     | P2       | L    | —                               |
| [E018 — Persist and restore undo history safely](e018-persisted-undo.md)                            | Implementation | Cross-repo | P2       | L    | [E017](e017-branching-undo.md)  |
| [E019 — Browse and compare undo branches](e019-undo-graph-viewer.md)                                | Implementation | Editor     | P2       | L    | [E017](e017-branching-undo.md)  |
| [E020 — Navigate cursor jump history](e020-cursor-jump-history.md)                                  | Implementation | Editor     | P2       | M    | —                               |
| [E021 — Complete styled copy for multiple selections and portable colors](e021-styled-clipboard.md) | Implementation | Editor     | P2       | M    | —                               |
| [E022 — Prove compact blank lines with correct geometry](e022-compact-blank-lines.md)               | Research       | Editor     | P2       | M    | [E001](e001-stress-fixtures.md) |

## Inspectors and diagnostics

| Plan                                                                              | Kind           | Owner  | Priority | Size | Needs                           |
| --------------------------------------------------------------------------------- | -------------- | ------ | -------- | ---- | ------------------------------- |
| [E023 — Inspect editor timing and retained memory](e023-instrumentation-panel.md) | Implementation | Editor | P2       | M    | [E001](e001-stress-fixtures.md) |
| [E024 — Inspect the live syntax tree](e024-syntax-tree-inspector.md)              | Implementation | Editor | P2       | M    | —                               |

## Commands and extensions

| Plan                                                                                          | Kind           | Owner      | Priority | Size | Needs                                                                                                    |
| --------------------------------------------------------------------------------------------- | -------------- | ---------- | -------- | ---- | -------------------------------------------------------------------------------------------------------- |
| [E025 — Design and prove reloadable user plugins](e025-runtime-plugins.md)                    | Research       | Cross-repo | P2       | L    | [E026](e026-command-metadata.md), [E027](e027-extension-hooks.md), [E028](e028-modal-input-prototype.md) |
| [E026 — Declare Editor command metadata once](e026-command-metadata.md)                       | Implementation | Cross-repo | P2       | M    | —                                                                                                        |
| [E027 — Define and verify the extension hook contract](e027-extension-hooks.md)               | Design         | Editor     | P2       | M    | —                                                                                                        |
| [E028 — Prove modal editing through public extensions](e028-modal-input-prototype.md)         | Research       | Editor     | P2       | M    | [E026](e026-command-metadata.md), [E027](e027-extension-hooks.md)                                        |
| [E029 — Document runtime and serialized data boundaries](e029-runtime-and-serialized-data.md) | Design         | Editor     | P2       | S    | —                                                                                                        |

## Host file navigation

| Plan                                                                            | Kind           | Owner    | Priority | Size | Needs |
| ------------------------------------------------------------------------------- | -------------- | -------- | -------- | ---- | ----- |
| [E030 — Offer a flat file view under a chosen root](e030-flat-file-explorer.md) | Implementation | Platform | P2       | M    | —     |

## Original wishlist coverage

Every original second-level heading appears below. A topic can map to several independently
verifiable plans. This table preserves the source wording; current behavior is recorded in each plan.

| Original topic                                                    | Plans                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Visual piece-tree debug tool                                      | [E005](../docs/storage/piece-tree-inspection.md)                                                                                                                                                                                                                                                 |
| Reduce editor memory footprint                                    | [E006](e006-tombstone-reclamation.md), [E007](e007-chunked-document-consumers.md), [E031](../docs/performance/e031-projection.md), [E032](../docs/performance/e032-edit-batches.md), [E033](e033-explicit-full-text-boundary.md), [E034](../docs/performance/e034-snapshot-indentation-folds.md) |
| Research: SAB-backed SoA piece tree (LMDB-style shared snapshots) | [E009](e009-worker-transport-costs.md), [E010](e010-shared-memory-toolkit.md), [E011](e011-packed-piece-tree.md), [E012](e012-epoch-reclamation.md), [E013](e013-shared-document-snapshots.md), [E014](e014-parallel-search.md)                                                                  |
| Undo history as a graph (never lose an edit state)                | [E017](e017-branching-undo.md), [E018](e018-persisted-undo.md)                                                                                                                                                                                                                                   |
| Undo graph widget (Fred-style time-travel UI)                     | [E019](e019-undo-graph-viewer.md)                                                                                                                                                                                                                                                                |
| Faster in-buffer find (single-threaded)                           | [E008](e008-in-buffer-search.md)                                                                                                                                                                                                                                                                 |
| Input latency as an enforced budget                               | [E002](../docs/performance/input-latency.md), [E031](../docs/performance/e031-projection.md), [E032](../docs/performance/e032-edit-batches.md), [E034](../docs/performance/e034-snapshot-indentation-folds.md)                                                                                   |
| Look into: windowed/streamed loading for massive files            | [E015](e015-massive-file-loading.md), [E016](e016-bounded-structural-parsing.md)                                                                                                                                                                                                                 |
| Look into: render nothing at zero-height viewports                | [E004](../examples/stress/results/hidden-rendering.md)                                                                                                                                                                                                                                           |
| Cursor position navigation history (alt+left / alt+right)         | [E020](e020-cursor-jump-history.md)                                                                                                                                                                                                                                                              |
| Copy selection as styled HTML                                     | [E021](e021-styled-clipboard.md)                                                                                                                                                                                                                                                                 |
| Dev instrumentation panel (ship the debug tooling)                | [E023](e023-instrumentation-panel.md)                                                                                                                                                                                                                                                            |
| Tree-sitter syntax tree inspector (with a Zed comparison step)    | [E024](e024-syntax-tree-inspector.md)                                                                                                                                                                                                                                                            |
| Standing stress fixtures + interactive benchmarks                 | [E001](e001-stress-fixtures.md)                                                                                                                                                                                                                                                                  |
| File explorer: flattened view                                     | [E030](e030-flat-file-explorer.md)                                                                                                                                                                                                                                                               |
| Plugin system: study Fred's runtime-compiled plugin model         | [E025](e025-runtime-plugins.md)                                                                                                                                                                                                                                                                  |
| Defer startup work off the first-paint path                       | [E003](../docs/performance/first-paint.md), [E031](../docs/performance/e031-projection.md), [E034](../docs/performance/e034-snapshot-indentation-folds.md)                                                                                                                                       |
| Command metadata: single source of truth                          | [E026](e026-command-metadata.md)                                                                                                                                                                                                                                                                 |
| Editor hook taxonomy: inventory and completeness check            | [E027](e027-extension-hooks.md), [E033](e033-explicit-full-text-boundary.md)                                                                                                                                                                                                                     |
| Stress-test the input/command substrate with a modal (vim) layer  | [E028](e028-modal-input-prototype.md)                                                                                                                                                                                                                                                            |
| Compact blank lines (display-time)                                | [E022](e022-compact-blank-lines.md)                                                                                                                                                                                                                                                              |
| Hot/cold data structure vocabulary                                | [E029](e029-runtime-and-serialized-data.md)                                                                                                                                                                                                                                                      |

## Maintaining the backlog

[backlog.json](backlog.json) is the machine-readable inventory of IDs, metadata, dependencies,
and source-topic coverage. Update it with the corresponding plan or completed reference and this index. Use the
[authoring contract](AUTHORING.md) when adding or revising plans.

From the Editor repository, run:

```sh
node scripts/check-editor-backlog.mjs
```

The [verifier](../scripts/check-editor-backlog.mjs) checks titles and metadata, local Markdown
file links, required sections, unique IDs/files, missing dependencies, dependency cycles, orphan
plans, and coverage of every original TODO heading. It does not prove a source claim, benchmark,
or proposed feature; those require the plan's execution checks. Cross-repository links assume
Editor and Platform are sibling checkouts with their current directory names.

When work is scheduled, record that in the canonical roadmap. When it completes, transfer lasting
contracts and evidence into permanent docs, then archive/remove the completed execution plan under
repository policy. Reconcile this inventory and its topic coverage at that time rather than leaving
a completed feature listed as Proposed.
