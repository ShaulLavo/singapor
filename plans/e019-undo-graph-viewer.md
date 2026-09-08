# E019: Browse and compare undo branches

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P2
- Effort: L
- Dependencies: [E017](e017-branching-undo.md)
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`

## Outcome

Show retained history branches, inspect a previous state, and compare any two available states.
After undoing B and typing C, a user can see both children of A and compare B with C.
Browsing the graph previews history without editing the live buffer. An explicit restore action changes the document.
Ship reusable history presentation APIs and an Editor demo. Platform owns later app-panel integration.

## Current code

- [history.ts](../packages/editor/src/history.ts) has bounded linear history today.
  E017 must land before the viewer can enumerate retained branches or check out a node.
- [diffPieceTableSnapshots](../packages/editor/src/pieceTable/diff.ts) computes one replacement spanning the changed region.
  It walks snapshots without materializing both full documents, but is not a multi-hunk line diff.
- [packages/diff/src/model.ts](../packages/diff/src/model.ts) already implements `createTextDiff` using `structuredPatch`.
  It accepts full text strings, produces line hunks, and annotates inline changes.
  The wishlist claim that arbitrary-pair diff computation is missing is stale.
- [editorDiffPlugin.ts](../packages/diff/src/editorDiffPlugin.ts) and
  [diffRows.ts](../packages/diff/src/diffRows.ts) provide existing rendering and row projection.
- [documentSession.ts](../packages/editor/src/documentSession.ts) owns dirty-state tracking and shared-buffer revisions.
  Source and intent exist in transaction metadata. A timestamp must be supplied by E017 if it is displayed.
- The demo [editor pane](../examples/app/src/components/editorPane.ts) is the host for the initial integration.

## Scope

Render branch topology, a current-state marker, node labels, a preview, and comparison of two selected nodes.
Include keyboard navigation, accessible labels, loading/empty/error states, and explicit restore behavior.
Use the existing diff package for presentation. Keep graph layout and history selection independent of a UI framework.
Do not add branch merging, persistence, a new chord matcher, or an app-global active-editor registry.
Platform chrome, menu placement, and settings are separate host integration work.

## Design

Proposed viewer state holds a buffer identity, graph revision, focused node ID, and zero, one, or two selected node IDs.
Keep `preview` and `restore` as distinct actions. Restoring delegates to E017's checked buffer mutation operation.
A node disabled by an external barrier remains visible with the reason it cannot be restored.
Subscribe to the exact supplied buffer. Multi-view hosts share one history graph but each viewer owns its selection.
Closing or switching the viewer cancels comparisons and releases snapshot references and subscriptions.

Use a deterministic tree layout ordered by E017 sequence IDs, with a readable tree/list fallback.
Avoid graph layout recomputation for caret movement or syntax refresh. Recompute only on graph revisions.
Typing-run amendment keeps node identity and updates its summary revision, invalidating an open comparison.
Pruning can remove selected IDs. Show that the state is no longer retained and release the corresponding preview.
Keyboard focus must survive additions and pruning without jumping to the live editor unexpectedly.

Comparison requests capture two immutable node revisions and a viewer generation.
Cancellation or a newer request prevents stale results from replacing the selected comparison.
Keep at most the active comparison's temporary snapshot references and one bounded result cache.
Coordinates, source text, and node labels stay attached to the captured revisions throughout computation.
Do not keep full-document strings for every graph node or compute every edge diff during layout.

Use `createTextDiff` on bounded selected snapshots as the correctness control.
Measure its allocations and latency before replacing its string input with a walker-based adapter.
For a direct parent-child pair, recorded edits can locate changed regions, but disconnected edits still need multiple hunks.
The single replacement from `diffPieceTableSnapshots` is suitable for restoring text, not automatically a readable diff.
If large comparisons exceed the agreed budget, show an explicit size-limited result or run a cancellable worker task.
Prove any worker packaging and snapshot transfer costs before introducing a second diff algorithm.

Restoring asks the buffer to publish one consistent final document change.
Apply its standard selection and dirty-state rules, update every attached view, and preserve monotonic revision checks.
The read-only preview uses a separate view/session so moving around it cannot alter live selections or history.
Dispose preview syntax and worker resources when the selected pair changes.

## Steps

1. Define the viewer model against E017's public metadata and checkout API.
   Build fixtures for a line, siblings, deep branches, pruning, and external barriers.
2. Add a proposed history viewer module and demo integration under `examples/app`.
   Demonstrate tree keyboard traversal, current-state tracking, and preview without live-buffer mutation.
3. Connect comparison selection to `createTextDiff` and the existing diff renderer.
   Record single-edge and cross-branch output for the fixtures before optimizing large comparisons.
4. Add explicit restore, pruning feedback, request cancellation, and deterministic resource disposal.
   Show that a late diff result cannot replace the current selection.
5. Measure graph layout, comparison latency, and retained heap at E017's retention limit.
   Choose a documented large-comparison policy and verify its visible result in the browser.

## Verification

- Add model tests for selection across graph changes, unavailable nodes, and stale comparison results.
  These catch wrong-node restore and comparison of text from different node revisions.
- Extend [diff model tests](../packages/diff/test/model.test.ts) only if a new input adapter changes that contract.
  Include identical content with distinct nodes, disjoint changes, CRLF, empty files, and Unicode boundaries.
- Add browser coverage for keyboard-only navigation, accessible current-state labels, focus restoration,
  preview/live-buffer isolation, and two editor views observing a restore.
- Run focused `bun run test` commands in `packages/editor` and `packages/diff` as relevant.
  Build changed public exports before `public-api.test.ts`, then typecheck React and Solid consumers.
- Acceptance requires truthful retained topology, correct arbitrary-pair hunks, no edits from preview navigation,
  no stale result publication, and measured release of preview snapshots after closure.

## Risks and decisions

Selecting old nodes may temporarily pin data that E017 wants to prune. Pins must have a finite lifetime and count.
History checkout across Platform barriers remains unavailable until the host can preserve multi-file atomicity.
A pretty graph can be harder to use than a tree list. Compare both with the same branch fixture before choosing layout.
Do not let a large optional comparison block typing. Defer it or report its limit rather than hiding the cost.
