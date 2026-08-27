# Progress

Last reconciled: 2026-08-27

## Status

The original storage, anchors, selection, Tree-sitter, display-transform, and
browser-virtualization phases are implemented. The later Monaco/CodeMirror
parity programme completed M1-M16 and both review passes; its executable plan
was deleted under repository policy. BiDi geometry Tiers A and B are also
complete. The old instruction to start Phase 4 Tree-sitter work was stale and
has been removed.

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
- BiDi geometry Tiers A and B are complete: browser-derived run geometry,
  affinity-aware caret placement and hit testing, visual character-step motion,
  pixel-goal vertical movement, and RTL-safe selection paint are live. Permanent
  behavior is documented in
  [`docs/editing/selections-and-undo.md`](docs/editing/selections-and-undo.md) and
  [`docs/display/browser-virtualization.md`](docs/display/browser-virtualization.md).
- Broad block-surface APIs and temporary recovery bridges were deliberately
  removed. They are not compatibility targets.
- Typed transactional WorkspaceEdit parsing, planning, inversion, and document application are live
  and consumed by Platform's transaction coordinator.

## Active Executable Work

The remaining shared work is scheduled by the [Platform roadmap](../platform/PLAN.md): visible
snapshot persistence, prepared editor opens, the diagnostic-peek composition gate, and the final
editor-native keymap takeover. Each relevant milestone must verify both repositories in lockstep.
There is no active standalone Editor plan.

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
