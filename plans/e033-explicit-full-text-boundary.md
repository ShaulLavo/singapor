# E033: Make full-document text reads an explicit boundary

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: L
- Dependencies: [E007](e007-chunked-document-consumers.md), [E031](../docs/performance/e031-projection.md), [E032](e032-incremental-edit-batches.md), [E034](e034-snapshot-indentation-folds.md)
- Inspected baseline: `ff1dfeda9e52b308f57915da7372f7ac6e5f04f9`, 2026-09-08; E003 scheduling changes landed during inspection, full-text boundaries unchanged.

## Outcome

Reading editor state, delivering a plugin update, rendering, or applying an incremental edit
does not silently flatten the document. An external caller can still deliberately request
`editor.materializeFullText()` for save/export or another whole-document operation.
For example, updating Markdown replacements after a one-character edit reads capture ranges;
it does not allocate a document-sized string just to construct the provider's context.
Removing `legacyEditTextSnapshot` is part of this change, not its performance acceptance gate.

## Current code

- [TextSnapshot](../packages/editor/src/documentTextSnapshot.ts) already provides length, ranges,
  chunks, and explicit materialization. Piece-backed snapshots retain an initially supplied
  string but do not cache later materializations; `defineLazyFullTextProperty` separately does.
  That helper installs an enumerable, memoizing getter: object spread can pay the full cost.
- [Editor](../packages/editor/src/editor/Editor.ts), `applyEdit`/`renderEdit`, accepts an optional
  next snapshot and reconstructs a string through `legacyEditTextSnapshot` when it is absent.
  No production caller of public `Editor.applyEdit` was found; six cases in
  [editor.test.ts](../packages/editor/test/editor.test.ts) exercise it. View and Shiki tokenizer
  methods with the same name are separate APIs and must not be deleted by a name-only sweep.
- The same class's `providedInlineSpecs` and `createInjectedTextRowProviderContext` eagerly
  supply whole text; `getState`'s detached length fallback and `syncText` also read private `text`.
  [Document attachments](../packages/editor/src/editor/documentController.ts) expose a hidden
  full-text getter used by attach/render paths. E031 forwards snapshots into the display model;
  this plan removes remaining implicit attach/prepared reads and tab-size-inference reads.
- [Plugin contracts](../packages/editor/src/plugins.ts) make `textSnapshot` optional and
  `fullText` required on view snapshots/highlighter options. Inline replacement, injected row,
  and selection-range contexts carry full-document `text`; row/paste `text` is bounded payload.
- [View serialization](../packages/editor/src/editor/viewSnapshot.ts), `editorViewSnapshotToJSON`,
  reads full text; `JSON.stringify(runtimeSnapshot)` invokes it automatically. Visible-paint
  serialization already has a separate bounded representation and must retain that property.
- [React](../packages/react/src/index.ts), `createStoreSnapshot`, installs another fullText getter;
  [Solid](../packages/solid/src/index.ts), `createLazyFullTextAccessor`, explicitly returns a cached
  string accessor. [LSP descriptors](../packages/lsp-plugin/src/documentSync.ts) reuse the getter,
  and [LSP workspace](../packages/lsp/src/workspace.ts) adds an implicit document `text` getter.
  E007 already inventories their consumer copies; this plan owns removal of the implicit API.

## Scope

Change Editor repository packages, bundled plugins, framework adapters, examples, and tests.
Keep explicit whole-text access supported; delete old implicit properties and optional-source
fallbacks with their callers in the same implementation wave. No deprecated aliases or shims.
E007 owns find/minimap/LSP consumer algorithms, E031 lazy display inputs, E032 edit batches,
and E034 fallback folds. Coordinate their contracts before implementation; do not duplicate them.
This plan owns remaining context construction, implicit attach/prepared/render source access,
explicit capability design, and cross-package gates. Its prerequisites are final completion gates;
the API design and caller inventory can proceed alongside their implementation.
Platform persistence, settings, filesystem writes, and consumer migrations are outside scope;
publish an API change note identifying required host changes without editing Platform.

## Design

Proposed usage: plugins read `snapshot.textSnapshot.readRange(start, end)` and
`snapshot.lineStartsView`; a save caller uses `editor.getTextSnapshot().materializeFullText()`.
Capturing the immutable snapshot before an asynchronous save fixes which revision is serialized.
A full-sync protocol adapter explicitly materializes that same immutable source only when its
protocol requires text, never while projecting ordinary plugin state or converting positions.

Proposed types, defined beside the existing snapshot contracts:

```ts
type TextReadSnapshot = {
  readonly length: number
  readRange(start: number, end: number): string
  forEachTextChunk(visit: (text: string, start: number, end: number) => void): void
}
type TextSnapshot = TextReadSnapshot & { materializeFullText(): string }
// Ordinary provider contexts expose the read capability; owners keep TextSnapshot.
type EditorTextContext = { readonly textSnapshot: TextReadSnapshot }
```

Make ordinary provider source fields required, including empty/detached documents. Migrate their
reachable snapshot/change contracts together, so a nested optional source cannot reintroduce
`fullText` fallback. Share immutable source identity; do not copy text or create parallel stores.
Keep explicit materialization on public Editor/document snapshots. Narrow plugin types are an
accidental-cost guard, not a security sandbox: callers holding the public Editor can opt in.
An approved protocol adapter receives the full immutable source at its existing setup/sync boundary;
ordinary feature logic receives its read projection. Do not introduce a global permission registry.

Retire `defineLazyFullTextProperty`, private full-document `text` getters, and runtime snapshot
`fullText`. Replace full-view `toJSON()` with a deliberately named explicit serializer; retain
bounded `toVisibleSnapshot()`/visible JSON. JSON payload fields may still be named `fullText`:
already materialized data is not an implicit read. Object spread must never invoke serialization.
React's ordinary store exposes snapshots; an explicit full-text hook/controller method can remain
documented as an O(document length) subscription. Rename Solid's text accessor to make the same
cost explicit. Keep host-supplied `text`, inserted text, row strings, and paste payloads unchanged.

Delete the optional-next-snapshot branch of public `applyEdit`; require its immutable result
snapshot for detached projections. Attached document mutation continues through `edit`/buffer
transactions. Migrate direct tests to actual edits/snapshots; retain their token/offset assertions.
E032 owns batch semantics; this change must not add an independent editor text store.

Permitted flattening boundaries are public explicit extraction, explicit full-view serialization,
and protocol encoders requiring a complete string: LSP didOpen/full-sync/recovery, or initial/reset
Shiki transport while its existing worker protocol requires it. Incremental protocol changes,
hover/rename position conversion, viewport updates, and plugin context creation are not exceptions.
Keep E007's fallback reasons and E009's transport scope. Do not label every plugin a serializer.
Whole-document commands can scan chunks without becoming blanket materialization exceptions.

Document cost: materialization may allocate O(document length), runs synchronously, and does not
promise memoization. An existing supplied string can be reused, but callers cannot assume it.
Only the caller owns retention. Async encoders capture document/revision identity, cancel or discard
obsolete work, and release old sources on disposal; views must not acquire private full-text caches.

## Steps

1. Recheck the inspected working tree and record production call sites by operation and owner.
   Capture baseline diagnostics for edit, plugin update, explicit save, and full-sync recovery;
   distinguish supplied strings, copies, and retained copies. Agree E007/E031/E032/E034 boundaries.
2. Introduce the required read contracts, migrate context producers and consumers, and delete
   implicit getter APIs in one buildable wave. Inspect generated declarations, not just source types.
3. Remove detached edit reconstruction. Convert remaining local reads in context construction,
   selection/inline suggestions, state summaries, and attach-time tab-size inference to ranges/chunks.
   Pass snapshots through attach/prepared/render entry points; integrate prerequisite work.
   End with matching document versions, selections, undo behavior, and plugin output.
4. Move legitimate extraction to explicit serialization calls; update framework/examples and
   API documentation. Record each permitted operation, reason, source identity, and retention owner.
5. Add the enforcement below, compare the same baseline workload, and remove obsolete getter tests.
   Do not close this plan while an ordinary bundled consumer still relies on implicit full text.

## Verification

- Add proposed `test/fullTextBoundary.test.ts`: real fragmented documents, two views, edit/undo,
  selection, viewport, and bundled Markdown/scope/decode contributions. Observe existing
  `textSnapshot.materializeFullText` and full-range diagnostics below wrapper call sites.
  Assert bounded reads for local operations and no flattening during plugin update delivery.
- Add compiler fixtures against built exports rejecting `.fullText`, full-document context `.text`,
  missing sources, and two-argument detached `applyEdit`; prove public materialization still compiles.
  A typed plugin must not gain materialization through its ordinary nested read contexts.
- Add a symbol-aware production-source check for full-text getters, low-level materializers, and
  calls to explicit materialization outside named extraction/encoder functions. Follow imported
  aliases; do not use a method-name count or allow whole packages. Test the checker on a renamed
  wrapper and alias, and fail stale allowlist entries. Wire it into an existing verification script.
- Calibrate runtime instrumentation: explicit extraction must report the expected text length;
  `readRange(0, length)` must be observable too. Exercise real plugin entry points with a source
  that rejects flattening. Do not merely test that a new helper was called. Check read volume and
  allocation/retention evidence to catch reconstructing the string through chunk concatenation.
- From `packages/editor`, run `bun run test test/documentTextSnapshot.test.ts test/viewSnapshot.test.ts`
  and the new boundary test; run focused changed plugin tests and package `build`/`typecheck` scripts.
  Check React/Solid built consumers and explicit serialization tests, including protocol recovery.
  Use existing stress edit workloads for before/after bytes, retained heap, and p95 input latency;
  separate intentional export costs from editing. Reuse browser servers; do not run broad suites.

## Risks and decisions

This is a public API break; removing hidden getters without migrating real callers is incomplete.
Required string protocols remain costly, and an entire-document selected range can legitimately
produce a document-sized payload. Distinguish such explicit operations from routine updates.
Static types cannot stop deliberate casts or arbitrary chunk concatenation; compiler checks,
runtime read evidence, and allocation measurements establish different parts of the boundary.
If a dependency still needs whole text, finish its consumer design rather than add a renamed slow
fallback. Acceptance requires correct output, zero hidden flattening on the agreed ordinary paths,
working explicit export/full-sync recovery, and no p95 typing or retained-memory regression.
