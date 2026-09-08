# E005: Inspect piece trees and verify their invariants

- Status: Implemented
- Kind: Implementation
- Owner: Editor
- Priority: P2
- Effort: M
- Dependencies: None
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`, 2026-09-05.

## Outcome

Explain a damaged snapshot with an exact node, field, expected value, and actual value.
An engineer can compare the tree before and after deleting a selection, see tombstones,
and distinguish shared nodes from nodes copied by the edit.
The same invariant checker supports deterministic edit stress tests without mounting an editor.

## Current code

- [Tree operations](../packages/editor/src/pieceTable/tree.ts) maintain visible length,
  total length, piece count, line breaks, and minimum and maximum order values.
- [Snapshot types](../packages/editor/src/pieceTable/pieceTableTypes.ts) expose the tree,
  buffers, and a separate reverse-index root.
- [Reverse index](../packages/editor/src/pieceTable/reverseIndex.ts) orders entries by
  buffer identifier and starting offset. It must agree with each tree piece.
- [Debug entry point](../packages/editor/src/debug.ts) exports `debugPieceTable`, a flat
  piece listing. Its containment comment is stale architecture context to review before adding exports.
- [Tree tests](../packages/editor/test/pieceTable-tree.test.ts) check selected operations.
  No reusable `validatePieceTreeInvariants` or tree-shaped printer exists at this baseline.

## Scope

Deliver a pure invariant checker, deterministic text dump, and an optional demo inspector.
Include a reverse-index view and before-and-after snapshot comparison.
Keep traversal and formatting outside the input and rendering paths.
Do not ship an always-on validator or retain every edited snapshot for debugging.
The initial comparison accepts two explicit snapshots. E017 can later supply history-node selection.

## Design

Propose `validatePieceTreeInvariants(snapshot)` returning a readonly issue list plus counts.
Use tagged issues for structural cycles, ordering, aggregate values, buffer bounds,
line-break counts, treap priorities, snapshot totals, and reverse-index disagreement.
These names describe proposed APIs. Select the export location during implementation.

Compute expected aggregates from raw child results and buffer slices, never cached fields.
Check the min-heap priority relation used by `merge`, including its tie behavior.
Check visible and invisible pieces separately. Invisible pieces contribute to some sums only.
Validate line indexes against their recorded text and count, not unused typed-array capacity.
Detect cycles with a path-local set while permitting structural sharing between distinct roots.

Assign node labels within one inspection session using object identity.
A two-root comparison reports reused identity, copied nodes, and changed piece metadata.
Do not mistake identical text or equal piece metadata for structural sharing.
Bound visual expansion and text excerpts so inspecting a million-line document stays usable.
Text content is hidden by default. Engineers explicitly request excerpts.

## Steps

1. Document the equations for every aggregate using existing tree and reverse-index code.
   Produce a tiny hand-checked snapshot with visible and invisible pieces as the control.
2. Add the pure checker in proposed `packages/editor/src/pieceTable/inspection.ts`.
   Corrupt individual fields in test-owned snapshots and confirm precise issue reporting.
3. Add the text formatter in a separate proposed inspection-format module.
   Produce stable output for empty, split, deleted, and order-normalized snapshots.
4. Add an opt-in example panel that reads immutable inspection records.
   Support selection, collapse, reverse-index lookup, and two-snapshot comparison.
5. Record inspection time and allocation cost on deterministic local churn fixtures.
   Validate that disabling inspection adds no traversal to an edit. Connect these checks to E001
   when its harness is available; that optional integration does not block this inspector.

## Verification

Run `bun run test test/pieceTable-tree.test.ts test/pieceTable-reverseIndex.test.ts`
from `packages/editor`, then add the focused inspection test file to that command.
These are Vitest package-script invocations. Add no repository-wide test requirement.

New tests must catch an incorrect cached sum, a missing reverse entry, a stale piece value,
a cycle, invalid buffer bounds, and an order violation that leaves materialized text unchanged.
Exercise malformed trees iteratively so reporting a deep tree does not overflow the call stack.
Compare old and new roots after edits to prove the checker and formatter never mutate snapshots.
Use a real browser for panel expansion and selection on a large fixture.
If exporting a debug API, build the package and verify its built export and demo consumer.

Accept when all corruption cases identify the affected field, valid stress snapshots pass,
and the inspector can show actual path copying without materializing a full document.
Record the maximum tested tree size and visual row limit.

## Risks and decisions

The checker must not share aggregate implementation with the code it checks.
Shared calculation helpers would hide the same defect in both implementations.
Reverse-index entries can carry equal values without sharing object identity.
Validate the semantic relation rather than requiring incidental pointer equality.
The visual inspector can ship after the checker and printer, but all three remain in this plan.
An inspection session owns its selected roots and releases them on close.

## Implementation evidence

Implemented on 2026-09-06 through `@singapor/core/debug`, with an opt-in dialog in the example app.
The [inspection reference](../docs/storage/piece-tree-inspection.md) records the aggregate equations,
API, ownership, limits, verification, and [local measurements](../docs/storage/inspection/2026-09-06.json).
The largest valid fixture has 23,305 piece nodes and an equal number of reverse entries after
13,334 edits to a million-LF buffer. Chromium verifies the panel with a 200-row limit.
The checker also found and drove a fix for split reattachment violating treap heap order.
