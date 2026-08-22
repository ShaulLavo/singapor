# Progress

Last reconciled: 2026-08-22 at Editor `42f07a7`

## Status

The original storage, anchors, selection, Tree-sitter, display-transform, and
browser-virtualization phases are implemented. The later Monaco/CodeMirror
parity programme completed M1-M16 and both review passes; its executable plan
was deleted under repository policy. The old instruction to start Phase 4
Tree-sitter work was stale and has been removed.

Cross-project execution order is authoritative in
[Platform's `PLAN.md`](../platform/PLAN.md). This file records Editor state; it
does not define another sequence.

## Completed Baseline

- Persistent piece-table documents, durable anchors, multi-selection editing,
  undo/redo, folds, wrapped and virtualized rendering, minimap, diff, and merge
  editing are live.
- Tree-sitter syntax, highlighting, structural selection, indentation,
  injections, bracket/tag matching, worker scheduling, and stale-result guards
  are live.
- Language configuration, auto-close/type-over/surround, snippets with linked
  mirrors, completion filtering and resolution, signature help, document links,
  semantic tokens, word-part and line operations, column selection, cursor
  history, and clipboard behavior are live.
- Editor documents support multiple views and explicit read-only editability.
- BiDi geometry Tier A M1-M5 is complete and verified in
  [`docs/plan-bidi-geometry.md`](docs/plan-bidi-geometry.md).
- Broad block-surface APIs and temporary recovery bridges were deliberately
  removed. They are not compatibility targets.

## Active Executable Work

1. Shared Platform/Editor LSP routing work in
   [Platform plan 050](../platform/plans/050-multi-server-lsp.md). This changes
   cross-project contracts and must be verified in both repositories in one
   milestone.
2. BiDi Tier B M6-M7: caret affinity and visual cursor motion. This can execute
   independently of Platform and environment work.

No other item in [`TODO.md`](TODO.md) is executable merely because it appears in
the backlog.

## Superseded Sources

- `docs/parity-plan.md`: deleted after completion; Git history is the archive.
- [`docs/architecture-recovery-plan.md`](docs/architecture-recovery-plan.md):
  retained for architectural rationale, superseded as an execution source.
- Older phase-by-phase validation logs in this file: superseded by the live
  packages, focused tests, and commit history.

## Verification Boundary

- Pure Editor behavior: run the narrow package test and typecheck that could
  catch the change.
- Geometry, paint, hit testing, clipboard, or browser-worker lifecycle: use the
  real-browser Vitest project.
- Architecture-sensitive changes: run `bun run health` in addition to the
  focused checks.
- Cross-project contracts: verify the Editor producer first, then the Platform
  contracts/server/web consumer and the already-running app. Do not leave a
  compatibility alias between repositories.
