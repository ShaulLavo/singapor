# E027: Define and verify the extension hook contract

- Status: Proposed
- Kind: Design
- Owner: Editor
- Priority: P2
- Effort: M
- Dependencies: None
- Inspected baseline: Editor `9abb944f3a2b8d6516953fdec75e8df5e1a94811`.

## Outcome

Publish an accurate extension inventory that tells a plugin author which behavior they can
change, which context they receive, and when their resources disappear. Propose only the
missing hooks needed to exercise modal input in [E028](e028-modal-input-prototype.md).

A developer implementing a custom paste handler or view decoration should find its existing
public hook. A developer intercepting input should find an explicit ownership contract,
including how to delegate ordinary typing and composition to the default implementation.

## Current code

[EditorPluginContext](../packages/editor/src/plugins.ts) already registers syntax, highlighter,
view, command, capability, edit, decoration, gutter, injected-row, inline-replacement, and
selection-range contributions. Its public types are exported through
[extensions.ts](../packages/editor/src/public/extensions.ts).

The same plugin file defines single-owner capabilities, multi-provider language features,
paste handlers, contribution disposal, and per-view update callbacks. The wishlist's request
for a hook taxonomy must inventory this existing model before adding another registration API.

[InputSelectionController](../packages/editor/src/editor/inputSelectionController.ts) owns
browser keydown, beforeinput, composition, paste, and selection handling.
[inputState.ts](../packages/editor/src/editor/inputState.ts) tracks browser and session ownership.
[EditorKeymapController](../packages/editor/src/editor/keymap.ts) already uses the
[public shared chord runtime](../packages/editor/src/public/keymap.ts).

[DisplayProjectionRegistry](../packages/editor/src/editor/displayProjectionRegistry.ts) is an
internal composition point. Public [rendering exports](../packages/editor/src/public/rendering.ts)
and registered view contributions expose selected display operations, not the entire registry.
Open, save, and workspace policy also cross host boundaries and are not all plugin callbacks.

## Scope

Deliver a proposed `docs/architecture/extension-hooks.md`, an explicit input interception
proposal, and public-export checks tied to that inventory. Keep the initial design finite.
The implementation proof for a missing input hook belongs to E028.

Inventory hooks in these categories: document edits, selections, commands, input, syntax,
display projection, decorations, frame work, scrolling, document lifecycle, and view lifecycle.
Mark each row public, internal, host-owned, proposed, or intentionally unsupported.

Do not expose an internal timer or controller merely to fill a row borrowed from another
editor. Notifications, filesystem permissions, open destinations, and save policy stay host-owned.

## Design

Each inventory row names its current symbol and export, owner, registration scope, callback
phase, mutation rights, ordering, cancellation, and disposal. Identify the production consumer
that proves a public hook works. Use "no current public hook" where the implementation lacks one.

Distinguish per-document data from per-view input and paint. A plugin installed in two views
must not share cursor mode accidentally. Document whether providers survive document swaps
and whether an asynchronous result is rejected after a version or generation change.

For input, sketch a typed consume-or-delegate contract. The default handler remains the owner
of composition and native text reconciliation unless a replacement explicitly implements
that contract. A wrapper cannot let the same beforeinput event commit through two paths.

Compare an ordered key-intent interceptor with a whole input-loop replacement. Evaluate which
can implement normal-mode suppression, insert-mode delegation, and operator-pending state
without DOM listener races. Prefer the narrower design if E028 proves it sufficient.

Reuse the shared keymap runtime for chord recognition, timeout, and cancellation. Interceptor
ordering must explain its relation to local widget inputs, app shortcuts, and readonly checks.
Frame callbacks need invalidation ownership and cleanup, not an unrestricted permanent timer.

Publish the inventory as the contract map while marking any new input contract experimental.
Do not make E027 depend on a finished runtime loader or modal plugin. E028 evaluates this
proposal and returns evidence before E025 makes a broader stability promise.

## Steps

1. Enumerate exports and registration methods from the current package entry points. Follow
   each callback to its caller and one production contribution to establish actual semantics.
2. Trace two documents in separate views through install, focus, edit, document swap, deactivate,
   and dispose. Record lifetimes in the inventory and identify ownership ambiguities.
3. Walk the input event order, including hidden input and composition. Write the proposed
   interceptor contract with explicit consume, delegate, cancellation, and error behavior.
4. Compare the two input designs against the bounded E028 command set. Record which requirements
   they express and which require an internal import. End with a selected experimental contract.
5. Publish the inventory and link it from the architecture documentation. Keep unsupported hooks
   explicit, with a reason based on current ownership rather than an open-ended promise.
6. Add only useful export or lifecycle contract checks for claims that existing checks miss.
   Hand E028 a precise implementation scope and its acceptance scenarios.

## Verification

Read [public API tests](../packages/editor/test/public-api.test.ts),
[plugin tests](../packages/editor/test/plugins.test.ts), and
[lifecycle tests](../packages/editor/src/editor/pluginLifecycle.test.ts) before adding coverage.
An export check must catch a documented hook that cannot be imported from the built package.
A lifecycle check must catch a surviving registration after its owning contribution disappears.

If those checks change, first run `bun run build` from `packages/editor`. Then run only the
affected files with `bun run test --project dom test/public-api.test.ts test/plugins.test.ts`
or `bun run test --project node src/editor/pluginLifecycle.test.ts`.
Documentation alone needs link and symbol verification, not a new behavior test suite.

Acceptance requires a source-backed row for every inventoried hook category, a disposition
for each gap, and an input design E028 can implement without inventing lifecycle semantics.
Do not claim native keyboard or composition behavior is proven until E028 tests a real browser.

## Risks and decisions

Overexposing the whole Editor instance would make every private detail a plugin dependency.
Keep contribution contexts narrow and identify the precise additional operation before exposing it.
Optional methods already exist in plugin contexts. Record current behavior accurately, then
remove unnecessary compatibility patterns only as part of a separately scheduled API change.
The design is incomplete if host save callbacks are mislabeled as editor document events.
