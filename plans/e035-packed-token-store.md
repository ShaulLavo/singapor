# E035: Make packed tokens the canonical token store

- Status: Proposed
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: L
- Dependencies: [E002](../docs/performance/input-latency.md)
- Inspected baseline: `954e95c4ef88cf1fee36e26b16f534cbfc39186d`, 2026-09-13.

## Outcome

A keystroke in a large document no longer allocates one `EditorToken` object per token in the
document. The Shiki worker already answers an edit with only the re-tokenized lines, and the
client splices them into the packed `Uint32Array` tokens kept from the open. The last cost that
still scales with document size is `unpackEditorTokens`, which turns every answer back into a flat
object array because the highlighter contract and every consumer downstream are written against it.
On the 500,000-line fixture that is about 500k objects per edit under the measured numbers in the
[wishlist](../TODO.md#packed-tokens-end-to-end-drop-the-per-edit-unpack).

After this plan, the packed form is the document's token store. A keystroke costs one splice plus
work proportional to the edited rows. Consumers read tokens through a small slice API instead of
walking an object array, and the object form survives only at explicit boundaries that need it.

## Current code

- [packedTokens.ts](../packages/editor/src/syntax/packedTokens.ts) defines `PackedEditorTokens`
  (`starts`, `ends`, `styleIds`, a style palette, and the three ordering flags), the writer,
  `packEditorTokens`, `unpackEditorTokens`, `PackedEditorTokenPatch`, `splicePackedEditorTokens`
  and the `firstTokenAtOrAfter` bisection. The splice allocates three fresh typed arrays per edit.
- [workerClient.ts](../packages/editor/src/shiki/workerClient.ts) keeps `this.packed`, splices
  each `patchesPacked` answer into it, and unpacks in `currentTokens()`. That one line is the
  unpack boundary for Shiki.
- [session.ts](../packages/tree-sitter/src/session.ts) unpacks `result.tokensPacked` the same way,
  and the worker packs flattened captures for both full and range answers.
- [plugins.ts](../packages/editor/src/plugins.ts) declares `EditorHighlightResult.tokens` and
  `EditorViewSnapshot.tokens` as `readonly EditorToken[]`. Neither has a packed field.
- [syntaxController.ts](../packages/editor/src/editor/syntaxController.ts) holds `currentTokens`,
  the real canonical store today, and rebuilds object arrays in `mergeSyntaxRangeTokens` (concat,
  sort, full index rebuild) and `projectSyntaxRangeCache`.
- [tokenProjection.ts](../packages/editor/src/editor/tokenProjection.ts) shifts object tokens
  through an edit before the worker answers, and records provenance in a `WeakMap` keyed by array
  identity. [tokenIndex.ts](../packages/editor/src/editor/tokenIndex.ts) keeps `maxEnds` and the
  same three ordering flags in another identity-keyed `WeakMap`. The packed form already carries
  those flags, so the two representations differ only in object identity.
- [virtualizedTextViewHighlights.ts](../packages/editor/src/virtualization/virtualizedTextViewHighlights.ts)
  `adoptTokens` chooses its keystroke fast path from `tokenProjectionLiveRangeStatus`, which is that
  identity metadata. `rebuildTokenRenderIndex` walks the whole array into render entries, and only
  the per-row painter slices by bisection.
- The minimap [workerClient.ts](../packages/minimap/src/workerClient.ts) maps `snapshot.tokens` to
  `MinimapToken` objects and diffs two object arrays to build a patch. Sticky scroll and diff read
  the same snapshot field. The [semantic layer](../packages/editor/src/semanticTokenLayer.ts) stays
  out of the token array on purpose and documents why; that reason is the per-keystroke cost this
  plan removes.
- Host producers still hand in object arrays: `EditorDocument.tokens`, the diff plugin, and
  Platform's search-result syntax plugin build small `EditorToken[]` values for short documents.
- Existing proof: [packedTokens.test.ts](../packages/editor/test/packedTokens.test.ts),
  [shiki-worker.test.ts](../packages/editor/test/shiki/shiki-worker.test.ts), and
  [workerClient.browser.test.ts](../packages/editor/test/shiki/workerClient.browser.test.ts) assert a
  spliced answer equals a fresh full tokenization.

## Scope

Make `PackedEditorTokens` the store that the highlighter contract, the syntax controller, the view,
the view snapshot, the minimap, sticky scroll and diff read from. Give it a read API and route the
Shiki, tree-sitter and range-cache paths through it. Keep the row painter on slices.

Object arrays remain accepted at input boundaries: `EditorDocument.tokens`, plugin `getTokens`,
and any host that builds tokens by hand. Converting them costs work proportional to that input,
which is bounded by the producer, not by the document. `unpackEditorTokens` stays for callers that
need objects and gains a range form so nobody unpacks a whole document to read one row.

Not in scope: merging semantic tokens into the store, changing Shiki's line-based patching,
worker transport changes (E009), or asking Platform to publish packed tokens. Platform's
[Plan 099](../../platform/plans/099-document-contributions.md) aligns how contributions receive
source text; E035 is the token output side and must not add a second source-sync path. Platform keeps its
current plugin contract; if a host later wants to publish packed tokens, that is a cross-repo
follow-up.

## Design

The store is a proposed `EditorTokenStore`: the packed arrays, the palette, the ordering flags,
and a lazily built `maxEnds` typed array for overlapping input. Its read API is the smallest set
consumers already need: token count, token at index, first index at or after an offset, first
index ending after an offset, a row slice as `(index range, style palette)`, and a chunked
iterator for exports such as rich-text copy. A slice is a pair of indices into the store, not a
copied array.

Provenance replaces identity. Today `adoptTokens` learns whether live ranges survive from a
`WeakMap` keyed by the array. The store carries an explicit `revision` and a `derivedFrom`
description (`{ revision, keepsLiveRanges }`) set by the operation that produced it: a splice,
a projection through an edit, or a fresh answer. The view compares revisions, so the fast path
survives the loss of object identity and the rule stays readable in one place.

Projection moves to the store. `projectTokensThroughEdit` becomes a suffix shift on `starts` and
`ends` plus the same-line handling it has now, and the existing indexed-versus-scan choice becomes
bisection versus a linear pass over typed arrays. The splice already does this shift; the two
implementations merge. Whether the shift copies the arrays or the store keeps spare capacity and
shifts in place is a measured decision, recorded in step 2. Copying is the baseline because it is
already known to cost about one millisecond.

The highlighter contract changes in one pass, no alias: `EditorHighlightResult` returns the store
(or a patch and the store), `Editor.setTokens`, `syntaxController.setTokens` and the view's
`adoptTokens` accept it, and `EditorViewSnapshot.tokens` becomes the store with the JSON snapshot
serializer writing the packed arrays. `mergeSyntaxRangeTokens` becomes a splice of a range answer
into the store; `projectSyntaxRangeCache` shifts range bounds only, as it does today.

The minimap posts token patches derived from the same splice ranges the store already knows,
instead of diffing two object arrays. Its worker-side `MinimapToken` shape is unchanged; only
the client side stops materializing objects. Sticky scroll and diff read row slices.

The tree-sitter worker already packs captures; its session stops unpacking. Range answers become
patches over the store rather than object merges, which is the same operation Shiki uses.

Illegal states to rule out: a slice outliving the store revision it was taken from, a projection
applied to a store whose revision differs from the edit's base, and a palette id with no style.
Each is a thrown structured error in development and a full re-tokenize request in production.

## Steps

1. Baseline. Run the input-latency suite and a 500,000-line edit profile at the inspected
   baseline, and record allocation counts per keystroke from `editor.tokens.adoptProjected` and the
   highlighter apply path. Publish the numbers with the fixture and commit.
2. Land the store and its read API beside the packed helpers, with the revision and provenance
   fields. Move `splicePackedEditorTokens` and the projection shift onto it and delete the object
   projection path. Measure copy versus in-place shift on the 500,000-line fixture and choose.
3. Change the highlighter contract, `setTokens`, `adoptTokens`, the view's render index, the
   view snapshot and its JSON form in one pass. The Shiki client stops unpacking. Convert
   `EditorDocument.tokens` and plugin `getTokens` at the boundary.
4. Route tree-sitter answers, `mergeSyntaxRangeTokens` and `projectSyntaxRangeCache` through the
   store. Delete the object-array merge and its index rebuild.
5. Convert the minimap patch derivation, sticky scroll, diff and rich-text copy to slices. Add the
   range form of `unpackEditorTokens` and remove every whole-document unpack in `src/`.
6. Repeat step 1 under the same conditions and attach the before and after numbers, the remaining
   object-token boundaries, and any per-edit cost that still scales with document size.

## Verification

- `packedTokens.test.ts` grows to cover the store: slice bounds at both ends of the document,
  provenance after a splice and after a projection, and the shift-in-place path if chosen. Each
  new test names the failure it catches: an off-by-one at a row boundary, a stale slice, a lost
  fast path.
- The spliced-equals-fresh assertions in `shiki-worker.test.ts` and
  `workerClient.browser.test.ts` stay as they are and must still pass with no unpack in the path.
- `viewSnapshot.test.ts` covers the packed JSON form round trip and rejects a palette id with no
  style. `virtualizedTextView.test.ts` and the browser view test cover the keystroke fast path
  chosen by revision rather than identity; the failure is a whole-document re-render after a
  same-line edit.
- The minimap tests assert the patch derived from splice ranges equals the patch the object diff
  produced for the same edit. The diff and scope-lines tests pass on slices.
- A new allocation check on the 500,000-line fixture asserts an edit allocates no token objects
  outside the edited rows. It is the acceptance measurement, not a CI gate.
- Run the focused package tests through their Vitest scripts, then `bun run bench:input` and
  `bun run --cwd examples/stress input:proof`. The paste and undo groups must stay inside the
  local limits, and the typing groups must not regress against three fresh controls.
- Build changed exports and typecheck the React and Solid consumers. Platform's linked checkout
  must typecheck against the new `EditorViewSnapshot.tokens` type.

## Risks and decisions

The keystroke fast path is the risk. Today it rests on array identity; if the revision rule is
wrong in one branch, every keystroke re-renders the whole document and the latency gate catches
it late. Step 2 lands the rule with its tests before any consumer changes.

Snapshot consumers outside this repository read `snapshot.tokens`. Platform typechecks against
the linked package, so the change surfaces at once; anything that still needs objects gets the
range unpack, not a shim.

In-place shifting is optional. If the measured copy is within noise of the in-place variant,
keep the copy; the plan ends with a store, not with a gap buffer.

Stop condition: if step 3 cannot remove the unpack without a second full index rebuild somewhere
in the view, record where and why, and leave the object path in place rather than ship two stores.
