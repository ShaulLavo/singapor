# E020: Navigate cursor jump history

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P2
- Effort: M
- Dependencies: None
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`

## Outcome

Return to a meaningful navigation origin after clicking elsewhere, using Find, or following a definition.
An edit between jumps must not erase the trail or send the caret to an outdated offset.
For example, jump from a call to its definition, insert lines above the call, and navigate back to the moved call.
Keep the shipped selection Undo/Redo behavior available independently of this longer-lived jump trail.

## Current code

- [cursorHistory.ts](../packages/editor/src/editor/cursorHistory.ts) already implements `CursorHistory`.
  It caps entries at 50 and stores selection offsets, affinity, primary selection, and scroll position.
- [Editor.ts](../packages/editor/src/editor/Editor.ts) captures selection-only operations and routes
  `cursorUndo`/`cursorRedo` through [commandRouter.ts](../packages/editor/src/editor/commandRouter.ts).
  The history clears on text changes and document/session replacement.
- [cursorHistory.test.ts](../packages/editor/test/cursorHistory.test.ts) verifies pure moves, scroll restoration,
  forward-tail truncation, multi-cursor affinity, default bindings, and clearing after edits.
  The wishlist's claim that pure navigation has no history is stale.
- [anchors.ts](../packages/editor/src/pieceTable/anchors.ts) supports biased anchors and returns `live` or `deleted`.
  Deleted anchors resolve to a boundary. That numeric result alone does not mean the old destination still exists.
- [navigationTargets.ts](../packages/editor/src/editor/navigationTargets.ts) distinguishes movement commands.
  It does not provide a persistent cause-based waypoint trail.

## Scope

Add a bounded per-view jump trail that survives edits in its attached document.
Record explicit jump causes, preserve origin and destination, and expose back/forward commands through the existing runtime.
Keep `cursorUndo` and `cursorRedo` for fine-grained selection correction. Their existing tests remain valid.
Editor owns same-document navigation and a host-facing explicit-jump API.
Platform owns cross-file trail policy, definition providers, tab opening, pane focus, and any app settings.
An Editor demo can exercise jumps locally. It does not implement global workspace navigation.

## Design

Proposed `JumpHistory` belongs to a view/session identity and contains entries plus a current position.
An entry stores a document generation, anchored selections, primary-selection identity, jump cause,
and a viewport anchor with an intra-row pixel offset and horizontal scroll.
Use existing anchor types. Do not retain a document snapshot merely to keep a waypoint resolvable.
Start with a finite capacity comparable to the existing cursor-history cap and measure retained anchor cost.

Add an explicit operation cause for pointer jumps, go-to-line, Find navigation, and provider navigation.
Record one completed jump after selection normalization, preserving the location before it and the new destination.
Arrow movement, drag updates, decoration changes, and history restoration do not create jump waypoints.
Use operation boundaries to coalesce a mouse gesture into one jump rather than recording every pointer event.
External callers can mark a navigation transaction explicitly without inferring intent from stack traces or distance.
The initial policy uses causes. Distance thresholds require separate usability evidence and host configuration.

Navigating back/forward captures the current location once, then walks existing entries without recording itself.
A fresh jump after going back discards the forward tail. Adjacent equivalent destinations spend no extra step.
Resolve anchors against the current buffer at navigation time, preserving selection affinity and primary selection.
If the primary destination is deleted, skip that waypoint. Remove deleted secondary selections from an otherwise live entry.
If edits collapse two destinations to the same place, deduplicate while walking so one keypress makes useful progress.
Clamp the viewport after layout and use the viewport anchor when earlier edits changed vertical position.

Text edits preserve waypoints; replacing the document generation clears them.
Two views on one buffer maintain separate trails even though both observe the same document changes.
Detaching or disposing a view releases its trail and subscriptions. A host may retain the view to retain its trail.
Integrate future anchor remapping/reclamation through [E006](e006-tombstone-reclamation.md)'s ownership contract.
A stale anchor must yield a deliberate skipped result rather than pinning abandoned text indefinitely.

Proposed `jumpBack` and `jumpForward` commands reuse command routing and the shared keymap registration path.
Register metadata and enablement with their handlers. Do not create an active-editor singleton or another matcher.
Choose default bindings after checking shipped bindings and browser history shortcuts on each supported platform.
An unavailable trail returns an unhandled/disabled result so host navigation policy remains explicit.

## Steps

1. Inventory the shipped selection-history call paths and the callers that perform real jumps.
   Define operation causes and document the distinction between selection history and jump history.
2. Implement the proposed bounded anchor-backed trail and pure navigation state transitions.
   Prove origins, destinations, deleted-waypoint skipping, and forward-tail truncation on real piece-table edits.
3. Wire explicit same-document jumps and the host navigation entry point into Editor operation boundaries.
   Verify pointer drag creates one waypoint and ordinary arrow movement creates none.
4. Register back/forward commands through the existing command and keymap layers.
   Add a demo with Find, go-to-line, edits, and two views on one buffer.
5. Verify browser focus, scroll restoration, deletion behavior, and disposal.
   Document the reusable cross-file integration hook while leaving host tab policy to Platform.

## Verification

- Add focused tests beside `cursorHistory.test.ts` for jump histories against real anchors and buffers.
  Catch offset drift after insertion, accidental waypoint creation from restoration, and infinite skipping loops.
- Test backward selections, multiple cursors with opposite affinity, deletion of the primary destination,
  undo of that deletion, bounded eviction, and edits that make consecutive waypoints coincide.
- Preserve the existing cursor-history tests. Their edit-clearing semantics belong to selection correction.
- Add browser coverage for pointer gestures, Find jumps, actual keyboard bindings, focus, and scroll positions.
  Include split views and a document switch to catch cross-view contamination.
- Run focused `bun run test` commands in `packages/editor`, using the `browser` project for geometry and trusted keys.
  Build changed exports before `public-api.test.ts` and typecheck the React/Solid consumers.
- Acceptance requires meaningful origins after intervening edits, no document mutation by navigation,
  no history pollution from arrows/restores, and release of waypoint references on disposal.

## Risks and decisions

Cause propagation can become callback plumbing. Attach it to the existing operation boundary and expose a narrow public action.
Anchors have explicit deletion behavior; silently using their fallback offset would make an unrelated location look valid.
Decide whether a deleted waypoint is removed permanently or remains eligible after undo. Test the chosen finite policy.
Cross-file back/forward needs a Platform plan when promoted. Its view ownership cannot be inferred from a global active editor.
