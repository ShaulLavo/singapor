# E018: Persist and restore undo history safely

- Status: Proposed
- Kind: Implementation
- Owner: Cross-repo
- Priority: P2
- Effort: L
- Dependencies: [E017](e017-branching-undo.md)
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`

## Outcome

Reopen a document after restarting Platform and retain its bounded undo branches.
If the file changed outside the app, open the actual file without applying old history to unrelated text.
For example, save A, edit to B, undo to A, and close. Reopen A and redo to B.
Recovered unsaved text remains an in-memory dirty document until the host's ordinary save action runs.

## Current code

- [documentSession.ts](../packages/editor/src/documentSession.ts) exposes runtime transactions with edits,
  inverse edits, snapshot references, anchored selections, and metadata. These are not a portable JSON schema.
- [public/document.ts](../packages/editor/src/public/document.ts) exports buffer and prepared-transaction APIs.
  It does not expose a persisted history format or a disk-history lifecycle.
- [piece table types](../packages/editor/src/pieceTable/pieceTableTypes.ts) keep line endings and BOM metadata.
  Document text is normalized on ingestion, so raw file bytes and internal text need distinct integrity checks.
- Platform's [workspace document service](../../platform/apps/web/src/features/editor/state/workspace-document-service.ts)
  owns retained buffers and views. Its [runtime](../../platform/apps/web/src/features/editor/state/runtime.ts)
  owns the environment lifecycle and save service.
- Platform's [runtime tests](../../platform/apps/web/src/features/editor/tests/runtime.test.ts) prove in-memory
  history survives switching environments. This is different from restoring after process restart.
- The wishlist's transaction-replay idea needs a base checkpoint, identity rules, and validation before replay.
  E017 supplies bounded branches. It does not make raw runtime objects safe to persist.

## Scope

Editor owns versioned export, validation, bounded reconstruction, and import of reusable history data.
Platform owns workspace identity, filesystem access, storage location, lifecycle scheduling, and user settings.
Include a host integration that survives an actual restart. An Editor codec demo alone does not complete this plan.
Persist native per-document history within the current external barrier epoch.
Do not serialize workspace undo receipts, live leases, listeners, worker handles, or running transactions.
Do not implement format migrations for this greenfield project. Unsupported formats are rejected with a reason.

## Design

Proposed `SerializedDocumentHistory` contains a schema version, normalized checkpoint text, format metadata,
retained node IDs and parent links, current ID, preferred redo children, and ordered forward edits per edge.
Store each node's selections as validated offsets, affinity, and primary-selection identity for that node's text.
On reconstruction, create fresh anchors. Runtime buffer IDs and anchor object identity cannot survive a restart.
Derive inverse edits while replaying validated forward edits rather than trusting a second serialized edit stream.
Keep dirty/clean comparison data even when E017 has pruned the node corresponding to the saved file.

The host envelope adds environment identity, workspace identity, document identity, and the backing-file digest.
Use a content digest and byte length, with line-ending/BOM policy defined explicitly. Modification time alone is insufficient.
Keep a digest of normalized checkpoint/current text too, so internal reconstruction has its own integrity check.
Export captures one immutable graph revision. Typing after capture schedules a newer export without mutating the captured one.
Bound export size, retained nodes, edit lengths, and reconstruction work before accepting input.

Validate the envelope, schema, unique IDs, one root, acyclic parent graph, bounds, and preferred-child relationships.
Reconstruct into a detached buffer, checking each edge against its parent content before applying it.
Verify the final content and selections before publishing the buffer through the prepared-document path.
If the backing file no longer matches, return a mismatch result and let the host open current disk content.
A mismatched history file is not a request to overwrite or merge the document.

Platform owns one serialized writer per document identity, with a generation check against stale writes.
Use atomic replacement of the last complete record and a bounded queue that replaces pending older captures.
Flush during normal lifecycle checkpoints rather than relying on asynchronous work in an unload callback.
Rename moves ownership to the new identity under host policy. Delete and forget-history remove stored records.
An aborted restore, environment switch, or late write cannot publish into a newer document generation.
History persistence failures produce one structured operation result while normal editing remains available.

Persistence stores deleted text and previously unsaved edits. Platform must offer disable and clear actions.
Register any user-facing policy in Platform's settings registry and wire its consumer in the same change.
Use application-private storage outside the repository being edited. Never put history content in logs.
Apply E017 retention before export and a storage quota across documents. Dispose capture references after serialization.

## Steps

1. Define the Editor schema and Platform envelope with examples for branches, pruning, CRLF, BOM, and dirty state.
   Record the exact identity and digest rules before implementing replay.
2. Implement the proposed codec beside the document/history code and a detached reconstruction API.
   Round-trip an E017 branch graph and prove every retained node has the same text and selections.
3. Add the Platform storage adapter at the environment runtime's ownership boundary.
   Exercise concurrent captures, interrupted writes, rename, environment switching, and quota eviction.
4. Wire prepared document opening to validate and restore history before publishing the restored buffer.
   If restoration exceeds the measured open budget, define a cancellable attachment stage that rejects intervening edits.
5. Register settings, regenerate `docs/settings-reference.md`, and add visible restore-failure handling in Platform.
   Restart the real app and demonstrate undo/redo continuity and external-file mismatch behavior.

## Verification

- New codec tests catch cycles, dangling parents, out-of-bounds edits, malformed selections, and oversized payloads.
  Reconstruct branches with non-ASCII text, CRLF/BOM metadata, coalesced typing, and a pruned root checkpoint.
- Extend Editor's `documentSession.test.ts` to catch incorrect dirty state and native history escaping a restored barrier epoch.
  Build exports before `public-api.test.ts`, then typecheck the framework consumers.
- Extend Platform runtime/document retention tests through the real server fixture and actual temporary files.
  Restart the storage adapter between operations. A single in-memory map cannot prove persistence.
- Test stale writes, partial files, changed backing content, cancelled opening, and two environments with the same path.
  Run `bun run test` with the focused file arguments in `apps/web`; its script uses Bun-backed Vitest.
- Measure capture allocation, serialized bytes, replay time, and first visible paint using the same branch fixture.
  Acceptance requires correct restored history, no wrong-file replay, and a documented bounded restore budget.

## Risks and decisions

Transactions from external workspace groups are intentionally outside this persisted native history epoch.
Restoring them independently would violate workspace atomicity and requires a different cross-file recovery design.
Decide whether unsaved recovery participates in an existing host recovery feature or needs its own explicit affordance.
Do not delay plain file opening indefinitely to recover optional history. Report a skipped restore with its reason.
Any format change invalidates old development records. Delete them rather than adding permanent healing code.
