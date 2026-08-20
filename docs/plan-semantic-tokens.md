# Semantic tokens — execution plan

Companion to `docs/parity-plan.md`, for the one finding that programme left unbuilt:
**Semantic tokens: delta protocol with in-place Uint32Array splicing**, recorded `[~]` in Milestone 14
(`docs/parity-plan.md:827-833`), ranked last of all 99 findings, prose at
`docs/parity-monaco-codemirror.md:1633-1647`.

Same working protocol, rules and status key as `docs/parity-plan.md` — re-read that file's
**Working protocol** and **Rules** sections before starting. This file replaces the finding's
"How to implement" paragraph, which is wrong about this codebase in two specific ways named below.

Audience: an agent who will follow this literally. Where this plan says a thing does not exist, it
does not exist; where it says something is conditional, do not build past the condition without
telling the human.

**This plan has been through an adversarial critique, a revision, and then an independent
verification pass that re-read every citation and ran its own measurements.** Nine of the critique's
fifteen findings were accepted and changed the design — including the merge point, which moved. The
verification pass then returned NOT-EXECUTABLE on one thing: Milestone 4's cost gate benchmarked a
loop a keystroke cannot reach. That gate has been re-pointed, and the design it gates has changed
with it. Read the **Review** section near the end before executing: it names what each pass found,
what changed, what was rejected and why, and which edges are still sharp.

---

## Verdict, up front

**Milestones 0, 1 and 2 are worth building on their own merits and should be built.** M0 and M1 close
two live, reproducible defects that have nothing to do with LSP — four capture rules that paint
nothing at all, and overlapping tree-sitter tokens that paint in an order nobody chose. M2 builds the
test harness that every milestone after it needs and that the package has never had.

**Milestones 3 through 5 — semantic tokens proper — are conditional and should not start until a
human says the gain is wanted.** Together they are `effort L`, `risk high`, and they buy correct
identifier colour for TypeScript only, over a viewport-sized window, at the cost of a second full
type-check walk on the worker that already serves completion, hover and diagnostics. Nothing in this
repo serves semantic tokens today, so the work includes writing the server, which the original
finding never costed.

**The delta protocol — the thing the finding is named after — should not be built at all.** See
De-scopings; the reason is not "later", it is "the shape we should build has no delta by design".

The original finding rated the whole thing `effort L`. That estimate was made under the belief that
a token-merge point already existed. It does not. Honest re-rating: M0 `S`, M1 `S`, M2 `M`, M3 `M`,
M4 `L`, M5 `S` — call the total `L+` with the server and the harness included, and `risk high`
because the largest milestone's cost can only be validated against a real viewport and a real
type-checking bill.

---

## What a reader actually gains

Concrete, because "type-aware colour" is not a specification. The TypeScript classification available
to us is exactly twelve types and six modifiers — `node_modules/typescript/lib/typescript.js`,
`services/classifier2020.ts`, `TokenType` (class, enum, interface, namespace, typeParameter, type,
parameter, variable, enumMember, property, function, member) and `TokenModifier` (declaration,
static, async, readonly, defaultLibrary, local). What we paint today for the same code is
`packages/tree-sitter-languages/src/queries/typescript-highlights.scm` concatenated with
`packages/tree-sitter-languages/src/queries/javascript-highlights.scm`
(`packages/tree-sitter-languages/src/index.ts:180-183`).

Gained:

- **Capitalisation stops deciding what a type is.** `typescript-highlights.scm:7-8` is
  `((identifier) @type (#match? @type "^[A-Z]"))` and `javascript-highlights.scm:51-52` is the same
  test for `@constructor`. So `Math`, `JSON`, `Promise`, `React` and every capitalised *value* are
  painted as types, and every enum, class or namespace reached through a lowercase alias is not.
  Semantic tokens classify by symbol, not by spelling.
- **enum, class, interface, type-alias and namespace stop being one colour.** `(type_identifier)
  @type` (`typescript-highlights.scm:4`, `:15-16`) cannot tell them apart at a use site. The
  classifier returns `enum` / `class` / `interface` / `type` / `namespace` distinctly
  (`classifySymbol2` in `typescript.js`).
- **`Color.Red` becomes `enum` + `enumMember`.** Today `Color` is `@variable` *and* `@type` *and*
  `@constructor` (three overlapping captures — see Milestone 1) and `Red` is `@property`
  (`javascript-highlights.scm:9`).
- **`const` and `readonly` become visible.** `javascript-highlights.scm:54-59` only recognises
  `SCREAMING_CASE`; `const answer = 42` and `let answer = 42` are the same colour today. The
  classifier sets the `readonly` modifier from `ModifierFlags.Readonly | NodeFlags.Const | EnumMember`.
- **Standard-library symbols become identifiable.** `@variable.builtin` is a hard-coded regex —
  `arguments|module|console|window|document` (`javascript-highlights.scm:61-63`). The classifier sets
  `defaultLibrary` on every symbol declared in a default-library file.
- **A property holding a function reads as a method even when it is not being called.**
  `javascript-highlights.scm:44-46` needs call position; `reclassifyByType` in `typescript.js`
  promotes `property` → `member` when the type has call signatures and no properties.
- **Aliased imports inherit what they actually are.** The classifier resolves through
  `SymbolFlags.Alias` with `getAliasedSymbol`; tree-sitter sees an `identifier`.
- **`local` distinguishes a shadowing binding from the module-level one it shadows.** No query rule
  can express this.

Not gained, and the plan must not promise it:

- **JSX tag names, and most of a React component.** The classifier tracks `inJSXElement` and skips
  identifiers inside JSX elements entirely — not just the tag name, the whole subtree outside `{…}`
  expressions. The example app registers `typeScript({ tsx: true })` (`examples/app/src/app.ts:60`),
  so for a `.tsx` file the uncoloured region is the component's entire return.
- **Import-clause bindings.** Skipped via `inImportClause`.
- **`Infinity` / `NaN`.** Skipped via `isInfinityOrNaNString`.
- **Anything that is not an identifier.** The classifier's whole body is guarded by `isIdentifier(node)`.
  Keywords, punctuation, strings, numbers, comments, operators, brackets stay exactly as tree-sitter
  paints them.
- **Any language other than TypeScript/JavaScript.** `html`, `css`, `json`, `markdown`
  (`examples/app/src/app.ts:59-64`) have no semantic-token server here and are not getting one.
- **Any view other than the main editor's.** Sticky-scroll rows (`packages/scope-lines/src/stickyScroll.ts:194`)
  and both diff panes (`packages/diff/src/DiffView.ts:558,831`) call `setTokens` on their own
  `VirtualizedTextView` instances, which no editor-scoped contribution reaches. A pinned function
  signature will show tree-sitter colour while the same line below it shows semantic colour.

---

## The recorded reason, re-examined

The skip was recorded with three reasons (`docs/parity-plan.md:829-833`). Two of them still hold and
one is too generous to what we ship.

**"tree-sitter plus shiki already deliver most of the visible colour, so the feature is incremental."**
True for keywords, strings, numbers, comments, brackets — most of a screen's coloured pixels. False
for identifiers in TypeScript, where the two queries above resolve `variable` / `type` / `constructor`
/ `constant` by regex on the first character. That is not "most of the colour is already right"; it
is a heuristic wrong in both directions, and it is precisely what a semantic layer fixes. **This
reason has already stopped holding, for TypeScript identifiers specifically; it still holds for every
other token kind and every other language we ship.** The correct conclusion is not
"build it" but "scope it to identifiers in one language and price it accordingly".

**"the delta protocol only pays when a server re-sends tokens for a large file per keystroke, which no
host here has."** Still true, and now provably so. There is no server: `typescriptLsp.worker.ts:169-187`
advertises `textDocumentSync`, `diagnosticProvider`, `hoverProvider`, `completionProvider`,
`definitionProvider`, `referencesProvider`, `implementationProvider`, `typeDefinitionProvider` and
nothing else. When we write one, it runs in-process in a worker, and
`ts.LanguageService.getEncodedSemanticClassifications` (`typescript.d.ts:10188`) re-walks the requested
span from scratch every call — there is no server-side previous array to diff against. Producing a
delta would mean diffing our own two arrays and paying more than shipping the full one over a
`postMessage` in the same address space. **What would have to change: an out-of-process server, over a
transport where bytes cost something, that maintains its own token cache. That is `tsserver` proper or
a remote LSP, neither of which this repo hosts.**

**"the transferable half already exists in `packedTokens.ts`."** True and, under the design this plan
now takes, not used at all. `packages/editor/src/syntax/packedTokens.ts` is a structure-of-arrays
transport for `EditorToken[]`; LSP semantic tokens are one flat `Uint32Array` of relative 5-tuples,
and converting is a full decode, not a reinterpret. Since Milestone 4 no longer produces
`EditorToken[]`, this reuse is worth zero lines rather than the thirty an earlier draft of this plan
claimed. The two traps it hides are still worth recording for anyone who reaches for it later:
`packEditorTokens` interns styles **by object identity** (`packedTokens.ts:25`), so a producer must
reuse one style object per scope the way `sharedStyleForTreeSitterCapture`
(`packages/editor/src/syntax/captures.ts:77-78`) does; and it copies the three index flags from
`getEditorTokenIndex` and silently defaults them to `false` (`packedTokens.ts:40,46-48`), which turns
off the renderer's indexed fast path (`packages/editor/src/virtualization/virtualizedTextViewHighlights.ts:711`).

**What the recorded reason misses entirely.** The finding's implementation paragraph
(`docs/parity-monaco-codemirror.md:1647`) says to "register the result as a second token layer in
`tokenProjection.ts`", because that file "merges token sources for rendering". It does not, and never
has. `packages/editor/src/editor/tokenProjection.ts` has four exports — `projectTokensThroughEdit`
(`:35`), `tokenProjectionLiveRangeStatus` (`:55`), `copyTokenProjectionMetadata` (`:67`) and
`sourceTokensForProjectedTokens` (`:77`) — and all four are single-source. Its job is to slide one
stale token array through one edit so the view keeps its DOM Ranges between a keystroke and the
worker's next parse; `Editor.ts:2995` calls it as
`projectTokensThroughEdit(this.tokens, edit, previousTextSnapshot)`.

The fourth export is the one that looks most like a merge and is furthest from being one:
`copyTokenProjectionMetadata(source, copied)` carries one array's token index and projection metadata
onto **a copy of that same array**, so the copy keeps the live-range fast path instead of falling into
a full re-render. Its two call sites are `Editor.setTokens` (`Editor.ts:655`, called as
`copyTokenProjectionMetadata(tokens, tokens)` — self to self, to seed the index for a host-supplied
array) and the view's own `setTokens` (`virtualizedTextViewHighlights.ts:114-117`, which spreads into
`copiedTokens` and carries the metadata across). Neither combines two sources, and neither offers a
place to put a second one.

There is no second layer in the *token* path. `view.tokens` is one array; `setTokens`/`adoptTokens`
(`virtualizedTextViewHighlights.ts:114,120`) take one array; `EditorSyntaxController.setTokens`
(`syntaxController.ts:192-195`) is a two-line full replacement. The two token producers that exist
are **mutually exclusive by construction**: a registered highlighter makes the controller ask
tree-sitter to stop producing tokens at all (`syntaxController.ts:409`,
`includeHighlights: !this.highlighterSession`) and then skip the token assignment entirely
(`:641-644`). Provider selection is first-non-null single-winner in both channels
(`plugins.ts:919`, `:945`), and syntax/highlighter are deliberately *not* on the multi-provider
`EditorLanguageFeatureRegistry` (`plugins.ts:648-649` versus `:740`).

But there **is** a second layer in the *highlight* path, and it is the one this plan now uses. See
Milestone 4.

---

## Every path that adopts tokens

Load-bearing for Milestone 4's design decision, and enumerated here because an earlier draft of this
plan picked a merge point that two of these seven paths bypass. Verified by reading each call site.

Through `EditorSyntaxController.setTokens` (`syntaxController.ts:192-195`), which assigns
`currentTokens` and then calls the `adoptTokens` option:

1. `Editor.setTokens` — the public host API (`Editor.ts:654-656`) → `Editor.adoptTokens` (`:679-681`).
2. `Editor.setDocument` (`Editor.ts:685`) → the same public `setTokens`.
3. `Editor.setContent` (`Editor.ts:640-651`), which calls `this.setTokens([])` at `:646`.
   `Editor.clearDocument` (`:945`) reaches the same line through `clear()` (`:1284-1291`) →
   `setContent('')` (`:1288`) — it is not a path of its own.
4. **`Editor.applyEdit` — the per-keystroke path.** `Editor.renderSessionChange` (`:2985-2996`)
   projects the token array through the edit and calls `applyEdit`, which at `:670-673` calls
   `adoptTokens(tokens)` → `syntax.setTokens(tokens)`. This runs on **every character typed**.
5. `EditorSyntaxController.applySyntaxResult` (`:644`) — every tree-sitter full parse and every
   window parse.
6. `EditorSyntaxController.applyHighlightResult` (`:825`) — every result from a registered
   highlighter plugin (shiki).

Bypassing `setTokens` entirely:

7. `EditorSyntaxController.repaintCachedVisibleSyntaxRange` (`:481`) — `this.options.adoptTokens(this.currentTokens)`
   direct. Fires whenever the visible range scrolls into an already-parsed window, which is most of
   scrolling.

All seven converge on the `adoptTokens` option the editor supplies at `Editor.ts:476-479`:

```
adoptTokens: (tokens) => {
  this.view.adoptTokens(tokens)
  this.notifyViewContributions('tokens', null)
}
```

**So there is exactly one chokepoint, and it is not `setTokens`.** A merge placed in `setTokens` is
skipped on path 7 and the semantic layer vanishes on scroll-back. A merge placed at `Editor.ts:476-479`
covers all seven — and still runs per keystroke on path 4, which is why Milestone 4 does not merge
into the token array at all. Two further views are outside this diagram entirely: sticky scroll and
the diff panes hold their own `VirtualizedTextView` and call `view.setTokens` directly
(`stickyScroll.ts:194`, `DiffView.ts:558,831`).

---

## The highlight priority space, as it stands

Load-bearing for Milestone 4, and stated here because it is one global namespace that four
subsystems write into with no shared table anywhere. `Highlight.priority` is written in exactly one
place in the whole virtualization directory — `group.highlight.priority = style.zIndex ?? 0`
(`virtualizedTextViewHighlights.ts:274`), on the range path. Token highlights never set it:
`SharedTokenHighlights.acquire` does `registry.set(name, highlight)` and nothing else
(`sharedTokenHighlights.ts:56-60`), so every token highlight sits at the default 0.

| Producer | priority | properties declared |
| --- | --- | --- |
| syntax token highlights | 0 (default) | `color`, and `text-decoration` on `text.uri` |
| range decorations, default | 0 (`rangeDecorations.ts:75`, `zIndex ?? 0`) | varies |
| `DIAGNOSTIC_STYLES.error` (`plugin.styles.ts:114-118`) | 0 (no `zIndex`) | `color`, `background-color`, `text-decoration` |
| `DIAGNOSTIC_STYLES.warning` / `information` / `hint` | 0 | `background-color` |
| `FIND_SCOPE_STYLE` (`findController.ts:39`) | 1 | `background-color` |
| `FIND_MATCH_STYLE` (`:33`) | 2 | `background-color` |
| `FIND_CURRENT_STYLE` (`:34-38`) | 3 | `background-color`, `color` |

Two consequences an executing agent must hold on to. First, **priority only decides between
highlights that declare the same property** — the CSS Custom Highlight API resolves per property, so
a background-only highlight and a colour-only highlight never contend no matter what their
priorities are. The only real contest for `color` today is token(0) vs `DIAGNOSTIC_STYLES.error`(0)
vs `FIND_CURRENT_STYLE`(3). Second, **that first contest is currently a coin flip**: equal priority
falls back to registry insertion order, which is "whichever group this view registered first", so
whether an error squiggle's red text survives over a syntax-coloured identifier depends on session
history. Milestone 4 has to write into this space and therefore has to settle it.

---

## Prerequisites

Must exist before Milestone 3 starts. All of these exist today unless marked.

- **A controller shape to copy.** `packages/lsp-plugin/src/documentHighlightController.ts` is the
  house pattern in 137 lines: constructor options bag (`:16-22`), `update(snapshot, kind)` filtering
  on update kind (`:40-55`), stored-timer debounce with `cancel()` on every input (`:64-82`),
  capability gate before requesting (`:87`), per-request `AbortController` (`:89-102`), and the
  three-part staleness check — monotonic `requestId`, `disposed`, and document identity (`:103-105`).
  Copy all five. It is also the closest existing analogue of what Milestone 4 builds: it resolves
  server ranges and paints them with `context.setRangeHighlight?.(...)` (`:125`).
- **A plugin channel that carries painted spans, already exposed and already priority-aware.**
  `EditorViewContributionContext.setRangeHighlight` / `clearRangeHighlight` (`plugins.ts:314-319`),
  wired at `Editor.ts:2333-2334` to `view.setRangeHighlight` / `view.clearRangeHighlight`. Groups are
  named per view through `context.highlightPrefix` (`Editor.ts:424`), stack by declared `zIndex`
  (`virtualizedTextViewHighlights.ts:274`), and are painted only over mounted rows via bisection
  (`addMountedRangeHighlightRangesForRow:1265-1276`, `firstStartingAtOrAfter` / `firstEndingAfter`).
  Three subsystems already use it: diagnostics (`diagnosticsPresenter.ts:106-110`), document
  highlights (`documentHighlightController.ts:125`), find (`findController.ts:633-637`).
  **This is the channel Milestone 4 uses. There is no new public API to add.**
  All three members — `trackRanges?`, `setRangeHighlight?`, `clearRangeHighlight?` — are **optional**
  on the interface (`plugins.ts:310,314,319`), because a contribution may be handed a context that
  does not implement them. The house call style is `context.setRangeHighlight?.(...)`
  (`documentHighlightController.ts:125`); Milestones 4 and 5 must use it, and must not assert the
  members into existence with `!`.
- **Document identity that makes the staleness check valid.** `ActiveDocument`
  (`packages/lsp-plugin/src/pluginTypes.ts:41-49`) is minted fresh per change and carries both
  `textVersion` and `lspVersion`, plus `lineStarts` and `fullText`.
- **Offset decoding for LSP positions.** `lspPositionToOffsetInSnapshot`
  (`packages/lsp/src/positions.ts:33`) — the client already advertises
  `general.positionEncodings: ['utf-16']` (`packages/lsp/src/capabilities.ts:28-30`) and UTF-16 code
  units are JS string indices, so a 5-tuple decodes to an absolute offset directly.
  **Do not reach for `lineStartForSnapshotLine` (`:268-270`) or `rowForOffset` (`:243-262`)** — an
  earlier draft of this plan cited both as available primitives and neither is exported;
  `grep -n "^export " packages/lsp/src/positions.ts` lists eleven exports and those two are not
  among them. If the per-token cost of `lspPositionToOffsetInSnapshot` turns out to matter, export
  one of them deliberately rather than reimplementing it.
- **A tracked-range primitive with declared stickiness.** `EditorViewContributionContext.trackRanges`
  (`plugins.ts:310-313`) → `Editor.trackDocumentRanges` (`:2342-2357`), which mints piece-table
  anchors with a named bias pair and resolves them on demand, dropping any span whose text is gone
  (`resolveTrackedRanges:2360-2374`). The find plugin's use is the model
  (`packages/find/src/plugin.ts:430-444`, `findController.ts:390`). Milestone 5 uses it.
  It does **not** go through `EditorDecorationStore`, so it does not pay that store's
  visit-every-decoration-per-edit cost (`decorationStore.ts:163-190`).
- **The happy-dom paint-order harness.** `packages/editor/test/rangeDecorationPaintOrder.test.ts`
  substitutes a `Map`-backed `VirtualizedTextHighlightRegistry` and a
  `class MockHighlight extends Set<Range> { priority = 0 }` through
  `setHighlightRegistry` (`packages/editor/src/public/testing.ts`), with a comment recording why a
  Map reproduces the registry's paint order faithfully. This is the house answer for every
  "which highlight wins" assertion in this plan. Do not write those as browser tests.
- **NEW, must be added in Milestone 2:** a TypeScript language-service test harness. No test in
  `packages/typescript-lsp` has ever constructed a real `ts.LanguageService`.
  `test/worker.test.ts:39` is `vi.mock('typescript', () => ({ default: fakeTs }))`, where `fakeTs`
  (`:7-31`) is a hand-written object with `version`, four enums, `flattenDiagnosticMessageText`,
  `displayPartsToString` and two config parsers — no `LanguageService`, no checker. Of the eight test
  files in that package only `tsDiagnostics.test.ts` imports real `typescript`, and only for pure
  diagnostic conversion. Compounding it, `createService()` (`typescriptLsp.worker.ts:425-441`) sources
  its libs from `createDefaultMapFromCDN` — over the network — which no test can depend on.

---

## Milestone 0 — Four capture rules that paint nothing

`effort S` · `risk low` · unconditional, and independent of everything else in this file

**Why here.** Highlight pseudo-elements do not apply font properties. CSS Pseudo-Elements 4 admits
only colour, background-colour, text-decoration, text-shadow and text-stroke into
`::highlight()`, and this repo already knows it on one side of the house: `VirtualizedTextHighlightStyle`
(`virtualizedTextViewInternals.ts:47-55`) offers `backgroundColor`, `color`, `textDecoration`,
`zIndex` and no font properties, and `rangeHighlightRule` (`virtualizedTextViewHighlights.ts:1482-1490`)
emits exactly those three declarations. The token side does not know it: `STYLE_PROPERTIES`
(`style-utils.ts:3-12`) carries `fontStyle` and `fontWeight`, and `buildHighlightRule` (`:32-38`)
emits them into `::highlight()` rules where they are inert.

That is a live rendering defect, not a design input. Four capture rules declare font properties
(`captures.ts:33-68`): `comment` (`color` + `fontStyle`), `text.title` (`color` + `fontWeight`),
`text.emphasis` (`fontStyle` **only**) and `text.strong` (`fontWeight` **only**). The first two lose
their italic and bold and keep their colour. **The last two declare nothing else**, so
`normalizeTokenStyle` keeps them, `buildHighlightRule` emits `::highlight(x) { font-style: italic; }`,
`SharedTokenHighlights.acquire` registers a live `Highlight` for them, and every `*emphasis*` and
`**strong**` span in a markdown document is painted by a rule with no visible effect. They are
uncoloured. The shiki path produces the same shapes — `shiki/editor-tokens.ts:22,24` set
`style.fontStyle = 'italic'` and `style.fontWeight = 700` from the theme's font-style bits — so
swapping highlighters does not rescue them.

**The fix is a decision, not a measurement.** Give `text.emphasis` and `text.strong` a colour of
their own so markdown emphasis is visible at all, and stop emitting the inert declarations. Do not
delete `fontStyle`/`fontWeight` from `EditorTokenStyle`: shiki populates them from real theme data
and a future non-highlight render path may want them. Split `STYLE_PROPERTIES` so the key-building
table and the declaration-emitting table are no longer the same list — which is the same split
Milestone 4 would have needed and gets for free here.

**Exit criteria.** `buildHighlightRule` emits no `font-style` or `font-weight` declaration for any
input, asserted directly on a style that declares both. `serializeTokenStyle` still folds
`fontStyle` and `fontWeight` into the key, so two tokens differing only in weight remain distinct
styles — asserted, because splitting the table is exactly the edit that would silently collide them.
A markdown fixture containing `*emphasis*` and `**strong**` produces tokens whose resolved style
declares a colour, and a test asserts the resolved colour differs from the surrounding `text` colour;
this test fails on today's code. `resolveEditorScopeStyle('comment')` still declares a colour after
the change. No token in any existing fixture changes its resolved colour except the two markdown
scopes named, asserted by the existing token suite passing untouched.

- [ ] **Split the style-key table from the CSS-declaration table in `style-utils.ts`** — `S`
- [ ] **Give `text.emphasis` and `text.strong` a colour so they paint at all** — `S`
- [ ] **Markdown fixture test that fails today and passes after** — `S`

---

## Milestone 1 — Exact-span capture overlaps resolved where the names still exist

`effort S` · `risk low` · unconditional, and pays whether or not the rest of this plan ships

**Why here.** Overlapping tokens are live today and they paint in an order nobody chose.
`collectCapture` in the tree-sitter worker de-duplicates on
`${startIndex}:${endIndex}:${captureName}:${languageId}` (`treeSitter.worker.ts:997`) — the capture
*name* is in the key, so two captures over the same span with different names both survive, and
`sortCaptures` (`:1395-1396`) only orders them. In a `.ts` file, `const MAX = 10` produces four
tokens over exactly the same span of `MAX`: `@variable` (`javascript-highlights.scm:4`), `@constant`
(`:54-59`), `@constructor` (`:51-52`) and `@type` (`typescript-highlights.scm:7-8`). Each resolves to
a different style, each style gets its own `Highlight`, all four sit at priority 0, and equal-priority
highlights paint in registry insertion order — which is "first time this document's shared registry
saw that style key", i.e. a function of which file was opened first and what was in it. **The colour
of `MAX` is a function of session history.**

**Fix it in the worker, where the capture names still exist.** `treeSitterCapturesToEditorTokens`
runs inside the tree-sitter worker (`treeSitter.worker.ts:1149-1151`) and receives every capture with
its `captureName` attached; capture-to-style resolution happens there, and raw capture names ship to
the main thread only when `includeCaptures` is on, gated by `needsSyntaxCaptures` (`Editor.ts:483`).
So the ranking table lives beside `CAPTURE_STYLE_RULES` in `captures.ts:33-68`, and the resolution is
"among captures with identical `start` and `end`, keep the highest-ranked name". One function, no
wire-format change, no `EditorTokenStyle` change, no `Highlight.priority` change, and no entanglement
with the shared priority space documented above.

There is a second, quieter payoff. `appendEditorTokenIndexEntry` (`tokenIndex.ts:46-51`) sets
`nonOverlapping = false` the moment `token.start < builder.previousEnd`, and two tokens over an
identical span trip it every time. So `nonOverlapping` is false today for any TypeScript file
containing a capitalised identifier, and cutting exact-span duplicates should restore it. Should —
nested captures over *different* spans would still trip it, and this plan does not know how many of
those the shipped queries produce, so the exit criterion below measures it on a fixture and records
the number rather than asserting a result.

**What this deliberately does not fix.** Partial overlaps — a capture over a larger node containing a
capture over a smaller one — are not exact-span and stay order-dependent. That is a rarer and less
visible case than the one this milestone names, and resolving it needs either nesting semantics in
the renderer or a real priority mechanism. Pin the current behaviour with a test rather than leaving
it undescribed, and do not extend the ranking to cover it.

**Exit criteria.** Given a `.ts` fixture containing `const MAX = 10`, `treeSitterCapturesToEditorTokens`
returns exactly one token over the span of `MAX`, and its style is the constant colour rather than
the type colour — a node test that names that expectation explicitly and fails on today's code. No
two tokens in its output share both `start` and `end`, asserted over a fixture exercising all four
overlapping rules. The same document parsed twice, with the module-level style cache warm from a
different document in between, produces byte-identical token output — the property that made colour
depend on session history, asserted directly rather than through paint. A happy-dom test using the
Map-backed registry from `rangeDecorationPaintOrder.test.ts` opens two documents in a fixed order,
then the same two reversed, and asserts the set of registered token-highlight style keys and the
style resolved for `MAX` are identical across both runs. `getEditorTokenIndex(tokens).nonOverlapping`
is computed for a ~500-line TypeScript fixture and its value is recorded in this file as a
blockquote, before and after; if it is still false, the remaining overlap kinds are named there. A
partial-overlap fixture has its current resolution pinned by a test whose comment says the outcome is
order-dependent and unfixed.

**That measurement needs a real TypeScript grammar, and no TypeScript wasm is checked into this
repo** — `packages/tree-sitter-languages/src/grammars/` holds exactly two files,
`tree-sitter-markdown.wasm` and `tree-sitter-markdown-inline.wasm`. The TypeScript grammar arrives as
a dependency, at `packages/tree-sitter-languages/node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm`
(with `tree-sitter-tsx.wasm` beside it). **Load it the way `packages/markdown/test/replacements.test.ts:19-40`
loads the markdown ones**: `await Parser.init()`, then `Language.load(await readFile(wasmPath))`, then
`new Query(language, await readFile(queryPath, 'utf8'))`, all from `web-tree-sitter`, with the paths
built off `process.cwd()` as that file does at `:15`. The query text is
`typescript-highlights.scm` concatenated with `javascript-highlights.scm`, which is what ships
(`packages/tree-sitter-languages/src/index.ts:180-183`). A hand-written capture fixture will not
substitute: the point of the measurement is to find overlap kinds this plan has not enumerated, and a
fixture can only contain the ones its author already thought of — which is the same reason
`replacements.test.ts` gives for parsing for real (`:9-14`).

- [ ] **A static rank over the capture scope names, beside `CAPTURE_STYLE_RULES`** — `S`
- [ ] **Exact-span resolution inside `treeSitterCapturesToEditorTokens`** — `S`
- [ ] **`nonOverlapping` measured before and after on a real fixture, recorded here** — `S`
- [ ] **Partial overlaps pinned, not fixed** — `S`

---

## Milestone 2 — A TypeScript service the tests can actually run

`effort M` · `risk medium` · **prerequisite for Milestones 3–5; also the cost gate**

**Why here.** Every exit criterion in Milestone 3 needs a real type checker, and the package has
never had one. `Promise` ⇒ `defaultLibrary` requires a genuine `lib.es5.d.ts` in the VFS, because the
classifier reads `program.isSourceFileDefaultLibrary`; `Color` ⇒ `enum` and `const answer` ⇒
`variable`+`readonly` require `classifySymbol2` over a real checker. Against `fakeTs` all of them are
unwriteable. And the cost number this plan's conditionality hangs on — what
`getEncodedSemanticClassifications` bills on the worker that is already answering completion, hover
and diagnostics — cannot be measured without the same harness. An earlier draft of this plan made
that measurement its `effort S` go/no-go gate without noticing that the measurement needs
infrastructure that does not exist. This milestone is that infrastructure, and it is where the gate
now sits.

Two obstacles, both concrete. `createService()` (`typescriptLsp.worker.ts:425-441`) builds its lib map
with `createDefaultMapFromCDN` — a network fetch, which no test may depend on. The installed
`node_modules/typescript/lib/lib.*.d.ts` files are the same content on disk; the harness reads them
into the `Map<string, string>` that `createSystem` wants, and `createService` gains a seam that lets a
test supply a prebuilt map instead of fetching one. Second, `vi.mock('typescript')` is module-wide in
`worker.test.ts`, so the real-service tests belong in a new file that does not mock it rather than in
an edit to that one.

**Exit criteria.** A helper in `packages/typescript-lsp/test/` builds a `ts.LanguageService` over a
VFS whose libs come from the installed `typescript` package on disk, with no network access — asserted
by the test suite passing with fetch stubbed to throw. Against that service,
`getEncodedSemanticClassifications` over a fixture returns a non-empty `spans` array whose length is a
multiple of three. `createService` accepts an injected lib map and still fetches from the CDN when
none is given, asserted both ways. A benchmark in the same package reports wall-clock for
`getEncodedSemanticClassifications` over (a) a whole ~5,000-line TypeScript file and (b) a 100-line
span of it, on a warm service — and, **on the same warm service and the same fixture**, for (c)
`getCompletionsAtPosition` and (d) `getQuickInfoAtPosition`. **All four numbers are written into this
file as a blockquote before Milestone 3 begins.**

**The threshold is (c) and (d), not a constant.** The worker has one message loop and no queue —
`handleIncomingMessage` (`typescriptLsp.worker.ts:110-118`) dispatches on arrival and every handler's
walk is synchronous — so a classification walk blocks every other language feature for exactly its own
duration. The only question a number can answer is therefore whether semantic tokens introduce a
**new** worst-case block or hide inside one the worker already has. **If (a) costs more than the
slower of (c) and (d), Milestone 3 is range-only and this plan says so here**; if it costs less, the
whole-document shape is on the table and the choice is made on other grounds.

An earlier draft compared (a) against `DEFAULT_DIAGNOSTIC_DELAY_MS` (150, `typescriptLsp.worker.ts:26`).
**That is not a budget and must not be used as one** — it is a debounce interval, the time we wait
before starting diagnostics, which says nothing about how long work may take once started. Left
visible here so nobody reintroduces it.

- [ ] **Lib map read from disk, and a seam in `createService` to inject it** — `M`
- [ ] **A real `ts.LanguageService` in a test, in a file that does not `vi.mock('typescript')`** — `M`
- [ ] **Whole-file versus span classification cost, benchmarked and recorded here** — `S`

---

## Milestone 3 — A server that answers

`effort M` · `risk medium` · **conditional: do not start without a human go-ahead**

**Why here.** Nothing in this repo answers `textDocument/semanticTokens/*`
(`typescriptLsp.worker.ts:169-187`), and the client half is untestable end-to-end without it — a client
built first can only be exercised against a mock, which is exactly the kind of test that passes while
the feature does not work. Writing the server first also settles the legend, and the legend is what
Milestone 4's theme vocabulary is a function of.

The mapping is mechanical and worth stating so nobody re-derives it. `getEncodedSemanticClassifications(fileName, span, ts.SemanticClassificationFormat.TwentyTwenty)`
returns `{ spans: number[] }` of triples `(start, length, encoded)`, where `encoded = ((typeIndex + 1) << 8) | modifierSet`
— `TokenEncodingConsts.typeOffset = 8`, `modifierMask = 255`. Decode is `typeIndex = (encoded >> 8) - 1`
and `modifiers = encoded & 255`. The legend we publish is the twelve TS types in enum order with
`member` renamed to the LSP-standard `method`, and the six modifiers in enum order:
`['class','enum','interface','namespace','typeParameter','type','parameter','variable','enumMember','property','function','method']`
and `['declaration','static','async','readonly','defaultLibrary','local']`. Re-encoding TS's absolute
`(start, length)` triples into LSP's relative `(deltaLine, deltaStartChar, length, type, modifiers)`
5-tuples uses the document's existing line starts.

**Which request shape** is decided by Milestone 2's benchmark and not before. The default — and the
recommendation — is **range only**: `getEncodedSemanticClassifications` already takes a span,
`DocumentRangeSemanticTokensProvider` has no resultId, no delta and no release by design
(`references/vscode/src/vs/editor/common/languages.ts:2495`), and the worker is shared with
completion, hover and diagnostics, so a whole-file type-check walk is a head-of-line block on every
other language feature. Viewport-ranged answering is also already this codebase's idiom for colour:
the syntax controller runs tree-sitter in `syntaxMode: 'range'` (`syntaxController.ts:411`). It is
additionally what makes Milestone 4 affordable — a viewport's worth of identifiers is hundreds of
spans, not tens of thousands.

**Cancellation, honestly.** The worker has no request queue and cannot interrupt a running walk.
`handleIncomingMessage` (`typescriptLsp.worker.ts:110-118`) calls `void handleRequest(message)` the
moment a message arrives, and every handler's only `await` is `ensureService()` (`:415-423`), which
after warm-up returns an already-resolved promise and continues in a **microtask**. A
`$/cancelRequest` arrives as a separate message event — a macrotask — so by the time it is delivered,
the synchronous `getEncodedSemanticClassifications` walk has already finished. Adding the handler can
therefore only **suppress an already-computed response**; it cannot save the work. One exception,
worth a sentence so it is not mistaken for a general capability: on a **cold** service `ensureService`
(`:415-423`) awaits `createService` (`:425-441`), which fetches libs over the network, so a cancel
arriving during warm-up lands before any walk starts and does save real work. That is the first
request after the worker boots, and only that one. Say so in the
handler's comment, and do not write an exit criterion that claims otherwise. The two mechanisms that
would actually save work are the client-side debounce Milestone 4 already has, and `ts`'s own
cooperative token — `collectTokens` calls `cancellationToken.throwIfCancellationRequested()` — which
in a worker needs a `SharedArrayBuffer`/`Atomics`-backed `HostCancellationToken`. That is de-scoped;
see De-scopings.

**Exit criteria.** `initializeResult` advertises `semanticTokensProvider` with a legend, and a test
asserts the legend arrays are exactly the twelve and six names above in that order. Against the real
service from Milestone 2, one test drives the worker with a single fixture containing an enum, an
interface, a class, a `const`, a `let`, a parameter, a method reference in non-call position, a
`lib.d.ts` symbol, a JSX tag name and an import-clause binding, and asserts the decoded
`(offset, length, type, modifiers)` for the whole fixture as one expected array — `Color`⇒`enum`,
`Color.Red`⇒`enumMember`, `const answer`⇒`variable`+`readonly`, `let answer`⇒`variable` without it,
`Promise`⇒`defaultLibrary`, and no tuple covering the JSX tag name or the import binding. **One
assertion over the whole decoded array, not a positive test and a separate "produces no token" test**
— a bare absence assertion passes when the server produces nothing at all. A `$/cancelRequest` naming
an in-flight semantic-token request causes no response message to be posted for that id, and the test
asserts the classification call still ran, so the comment about what cancellation can and cannot do
stays true. Requesting a range answers only tokens intersecting that range, and the response's first
tuple's `deltaLine` is absolute from line zero, not from the range start.

- [ ] **`semanticTokensProvider` capability and legend** — `S`
- [ ] **TS classification triples re-encoded as LSP relative 5-tuples** — `M`
- [ ] **`$/cancelRequest` handled as response suppression, with a comment saying it is only that** — `S`
- [ ] **One whole-fixture assertion covering all twelve types, six modifiers and both documented holes** — `M`

---

## Milestone 4 — The client: decode, theme, and the layer the view already composes

`effort L` · `risk high` · **conditional**

**Why here.** Last of the building milestones because it consumes all three that precede it: the
style-table split from M0, the deterministic syntactic colour from M1, and the legend and harness from
M2 and M3. It is the largest and the riskiest.

### The layering decision, and why it changed

An earlier draft of this plan merged semantic tokens into the syntactic token array inside
`EditorSyntaxController.setTokens`. **That was wrong on two counts, both verified.** `setTokens` is on
the per-keystroke path — path 4 in *Every path that adopts tokens* above — so every character typed
would have paid a concat, an `Array.sort` and a full `createEditorTokenIndexBuilder` walk over the
whole document's tokens; and because the merged array is fresh, `tokenProjectionLiveRangeStatus`
(`tokenProjection.ts:55-65`) returns `null`, so `adoptTokens` (`virtualizedTextViewHighlights.ts:120-160`)
skips both live-range fast branches and falls into `adoptChangedTokens` — a full token re-render, per
character, on the main thread. The lazy `Proxy` array (`tokenProjection.ts:284`), the projection
metadata `WeakMap` (`:33`) and the `sameLineTokenEdit` reconciliation exist precisely to keep that
path off the re-render branch. That draft also claimed the cost "is already what every window parse
does" — false, because window parses happen on scroll and parse completion, not per character. And it
was placed where path 7 bypasses it, so semantic colour would have vanished on every scroll-back over
a cached window.

Four shapes are on the table. The fourth is the one this plan takes.

**(a) Merge into the syntactic array, at `setTokens` or at the `Editor.ts:476-479` chokepoint.**
Rejected. At `setTokens` it is bypassed by path 7. At the chokepoint it covers all seven paths but
still runs on path 4, so the per-keystroke costs above stand in full.

**(b) Give the view a genuine second token array, composed per painted row.** The view already builds
token segments per mounted row by bisecting the token index
(`appendIndexedTokenSegmentsForRows:705-720`), so a second array bisected the same way is bounded by
the viewport rather than the document, and `view.tokens` and its projection lineage stay untouched.
This is the honest fallback and it is real work: a second index, an overlay term in the per-row skip
signature (`tokenRowSignature`), overlay-aware segment composition, and a new public setter — which
is the prerequisite the critique's finding 3 correctly says does not exist. Call it `M`–`L` inside
`packages/editor`, on top of everything else in this milestone. **Take this only if (d) fails its
measurement.**

**(c) Route semantic tokens through the decoration store.** Rejected. Stacking and anchoring both
work there, but `EditorDecorationStore.applyEdits` visits **every** decoration on every edit, as its
own comment says (`decorationStore.ts:163-190`).

**(d) Paint them as range highlights — the second layer the view already composes.** Taken.
`setRangeHighlight(name, ranges, style)` is already on `EditorViewContributionContext`
(`plugins.ts:314-319`), already reaches `packages/lsp-plugin`, already stacks by declared `zIndex`
(`virtualizedTextViewHighlights.ts:274`), already paints only over mounted rows by bisection
(`:1265-1276`), already skips redundant updates by signature (`canSkipRangeHighlightUpdate:1165-1174`),
and is already how diagnostics, document highlights and find put colour on text.

**One highlight group per distinct resolved style — not one per semantic scope.** This is a design
change the verification pass's measurement forced, and it is the house pattern already:
`SharedTokenHighlights.acquire` keys on the serialized style, not on the capture name
(`sharedTokenHighlights.ts:49-63`). The scope axis is still at most 12 types × 7 modifier slots = 84
names, but `resolveEditorScopeStyle` falls back to the nearest declared ancestor, so those 84 scopes
resolve to only as many distinct styles as the theme actually declares — a handful. The distinction
matters because **the per-keystroke cost of shape (d) is one `setRangeHighlight` call per live group**,
so group count is the cost driver and scope count is not. Key the group on the four fields
`sameHighlightStyle` compares (`virtualizedTextViewHighlights.ts:1191-1200`) — `color`,
`backgroundColor`, `textDecoration`, `zIndex` — name it
`` `${context.highlightPrefix}semantic-${n}` `` per distinct key, and clear a group whose ranges empty
out, so the live count is the number of distinct semantic colours the viewport contains. The cost this
pays is that the painted layer no longer records *which* scope coloured a span, only what colour it
got; that is acceptable because shape (d) delivers semantic *colour* and not semantic *tokens*, and
shape (b) is the migration if that ever stops being true.

What (d) buys, stated so it is not re-litigated:

- **No new public API.** The channel the critique's finding 3 says is missing is missing *for tokens*.
  For painted spans it exists, is exposed, is disposable through the contribution's own lifecycle,
  and is used by three subsystems today. That deletes the largest unpriced prerequisite in the plan.
- **Nothing on the per-keystroke token path.** `view.tokens` is untouched; the live-range fast path,
  the lazy projection and `sameLineTokenEdit` all keep working exactly as they do now.
- **Viewport-bounded work, twice over.** The server answers a range (M3), and the view paints only
  mounted rows.
- **Per-property override for free.** A semantic group declaring only `color` overrides the token
  group's `color` and leaves `text-decoration` and `background-color` to fall through from whatever
  else covers the span. That is exactly the `bMask`/`aMask` semantics VS Code hand-writes in
  `references/vscode/src/vs/editor/common/tokens/sparseTokensStore.ts:176-213`, and here it is what
  the API does anyway. An earlier draft de-scoped per-property blend on the grounds that "priority is
  per-`Highlight`, not per-property" — that reason is wrong; the CSS Custom Highlight API resolves
  per property.
- **Anchoring for free.** `trackRanges` gives Milestone 5 its whole mechanism.

What (d) costs, owned rather than discovered:

- **It writes into the shared priority space.** See the table above. Settled below.
- **The repaint costs one `setRangeHighlight` call per live group, and Milestone 5 makes that
  per-keystroke.** Each call sorts the group's ranges (`sortedRangeHighlights:1216-1226`, `ranges.map`
  then `sort`), computes a signature across the mounted rows (`rangeHighlightSignature:1341-1352`),
  rebuilds the group's `Range` objects over mounted rows (`renderRangeHighlight:284-300`) and then
  rebuilds the view's whole range-rule stylesheet (`rebuildStyleRules:1449-1469`). With viewport-scoped
  groups each of those is tens of entries, not thousands — but the *count of calls* is the live group
  count, and it lands on the keystroke path once Milestone 5 repaints from `resolve()`. **This is the
  single largest estimate risk in this plan and it has a measured number already**; see the cost gate
  in the exit criteria below, and Risks.
- **Note where that cost is *not*.** `VirtualizedTextView` also re-runs `renderRangeHighlight` for
  every group from `renderSnapshot` (`virtualizedTextView.ts:854`) — but that loop sits behind
  `if (key === view.lastRenderedRowsKey) return` (`:843`), and a same-line keystroke changes no term of
  `rowsKey` (`virtualizedTextViewRows.ts:178-183` → `snapshotRowsKey`,
  `virtualizedTextViewHelpers.ts:140-147`) and never resets `lastRenderedRowsKey`
  (`applySameLineEdit:929-950` does not; `applyMultiLineEdit:964` and `finishTextReplacement:996` do).
  An earlier draft of this milestone's cost gate benchmarked that loop, and therefore benchmarked
  nothing. It is scroll and reflow work, not keystroke work.
- **It leaves the token pipeline out of the feature entirely.** No `EditorToken` for a semantic span,
  no packed-token reuse, no projection lineage. If a future consumer needs semantic *tokens* rather
  than semantic *colour* — a minimap, an exporter, a screen-reader description — this shape does not
  serve it and (b) is the migration.

### The priority band

Chosen with the numbers in hand, because "give tokens a positive rank" would have made every syntax
token outrank `DIAGNOSTIC_STYLES.error` for the `color` property and quietly reverted squiggled text
to its token colour. Since priority contests are per property, the only property in dispute is
`color`, and only three producers declare it.

| producer | today | after | why |
| --- | --- | --- | --- |
| syntax token highlights | 0 | 0 | unchanged, and unchanged deliberately — M1 fixed their ordering without touching this space |
| semantic overlay | — | 1 | must beat syntax token colour; must not beat an error or the current find match |
| `DIAGNOSTIC_STYLES.error` | 0 (implicit) | 2 (explicit) | one line in `plugin.styles.ts`; today it wins or loses against token colour by registry insertion order, which is session history |
| `FIND_CURRENT_STYLE` | 3 | 3 | unchanged; still wins `color` over everything, as it does today |

`FIND_SCOPE_STYLE` (1) and `FIND_MATCH_STYLE` (2) declare only `background-color` and so never contend
with the semantic overlay's `color` despite sharing its numbers. Leave them alone.

### The theme vocabulary

The type axis is a legal linear taxonomy and resolves through the milestone-11 trie for free —
`createEditorScopeStyles` (`theme.ts:490`) is generic, `resolveEditorScopeStyle` (`:540-559`) is
longest-prefix at arbitrary depth, and rules are sorted before insertion so a parent always precedes
its children (`:492`). The modifier axis is **not** expressible in it: an LSP token carries a *set* of
modifiers and the trie indexes a *sequence*, so `variable.readonly.local` finds nothing if the theme
declared only `variable.local`. VS Code's real resolver scores rules by modifier subset match, which
is not a prefix walk. **Decision: fix a canonical modifier precedence — `declaration`, `readonly`,
`static`, `async`, `defaultLibrary`, `local` — and emit at most the highest-ranked modifier present as
a single scope suffix.** `variable` + `{readonly, local}` resolves `variable.readonly`, falling back
to `variable` if the theme declared no such rule. This fits the existing trie exactly and bounds the
resolver's unbounded per-scope memo (`theme.ts:496`) to 12 × 7 = 84 keys. **It caps the *scope* count
at 84, not the highlight-group count** — groups are keyed by resolved style, so the live group count
is however many distinct styles those 84 scopes land on in the current theme, which is what the cost
gate below measures and what the design depends on being small.

Note the resolved style must be a `VirtualizedTextHighlightStyle`, not an `EditorTokenStyle` — no
`fontStyle`, no `fontWeight`, which is the same constraint M0 established for tokens and the reason
the modifier axis has colour and text-decoration to work with and nothing else.

`createEditorScopeStyles` is module-internal with exactly one consumer (`captures.ts:70`); the
package exports `registerEditorColor` and `editorColorValue` (`index.ts:100,105`) but not the trie
factory. A resolver living in `packages/lsp-plugin` needs it exported through
`packages/editor/src/public/syntax.ts`. That export is the *only* new surface this milestone adds.

**Colours.** `registerEditorColor` (`theme.ts:106`) is open-ended, so new ids cost no core change. Six
of the twelve types have no slot in the closed `EditorSyntaxThemeColor` union (`theme.ts:4-23`) and its
table (`:166-187`): class, enum, interface, parameter, enumMember, method. Register those as open ids
with `editorColorReference` defaults pointing at the nearest existing id, so a theme that declares
nothing new still looks deliberate — `compileFirstEditorColor` (`theme.ts:449-458`) makes "first one
defined" a cascade decision rather than one frozen at registration. Read registered ids, never
literals, exactly as `captures.ts:11-32` does: shiki populates `EditorTheme.syntax` from the VS Code
theme (`shiki/theme-extract.ts:39-48`), so a semantic layer reading `var(--editor-syntax-*)` stays
consistent with either highlighter rather than only with tree-sitter.

**A range-only server needs a `'viewport'` listener, and the house controller it copies does not have
one.** `documentHighlightController.update` is `if (kind !== 'selection' && kind !== 'content') return`
(`documentHighlightController.ts:45`), because "where else is this used" is a question about the
caret. Semantic colour is a question about the *visible text*, and Milestone 3 answers a range. So
`'viewport'` — a real update kind (`plugins.ts:327`), fired at `Editor.ts:2717` inside
`handleViewportChange` (`:2704`), the same handler that refreshes the syntax controller's visible
range — must request too, or scrolling into code that has never been requested leaves it
tree-sitter-coloured until the user types there. Copy `documentHighlightController`'s debounce shape,
not its filter, and give the viewport request its own delay the way `handleViewportChange` gives its
prefetch one (`VISIBLE_SYNTAX_SCROLL_DELAY_MS` = 16, `Editor.ts:187`, used at `:2712`) — bigger than
16 ms, since a semantic request costs a type-check walk and a scroll prefetch costs a parse — so a
flung scroll issues one request rather than one per frame.

**Exit criteria.** A `SemanticTokensController` in `packages/lsp-plugin` requests on a debounce,
cancels in flight on every input, gates on `serverCapabilities.semanticTokensProvider`, and discards a
response whose `ActiveDocument` is no longer the active one — the four checks copied from
`documentHighlightController.ts:87,89-105`, each asserted by a test. **Scrolling to a range that has
never been requested issues a request for it and paints the response** — asserted by driving the view
to a scroll position outside every previously requested range and checking both that a request was
made and that its range covers the new viewport; this is the criterion that stops the controller from
inheriting `documentHighlightController`'s `'selection'`/`'content'` filter verbatim. Decoding a
response with an out-of-legend type index, an out-of-legend modifier bit and a zero-length tuple
mixed in among four valid tuples yields exactly the four valid spans, at their correct absolute
offsets — **one test over one fixture**, so the relative-position cursor is proved to advance across
the dropped tuples rather than being proved only not to throw. In a happy-dom test using the
Map-backed registry from `rangeDecorationPaintOrder.test.ts`, an identifier covered by both a tree-sitter token style and a
semantic scope has both highlights registered, the semantic group's `priority` is 1, the token
group's is 0, and both declare `color`; clearing the semantic layer leaves only the token group. In
the same harness, text covered by an error diagnostic **and** a semantic token has the diagnostic
group at priority 2 above the semantic group at 1 — the regression assertion for the priority table,
which fails if anyone raises the token or semantic band later. **Scrolling into an already-parsed
window and back out repaints the semantic groups** — asserted by driving the view through the
scroll that reaches `repaintCachedVisibleSyntaxRange` (path 7) and checking the semantic groups still
hold ranges afterwards, because that is the path an earlier merge point silently lost. (Under shape
(d) that one is close to structurally guaranteed — the semantic groups are not on the syntactic token
path at all — so it is a cheap regression pin, not evidence the feature works; the viewport-request
criterion above is the one that catches a real hole.) `theme.syntax` and `theme.colors` set on the
host change semantic colours without a document reload. With a
highlighter plugin registered, a semantic response still paints — the layer is independent of which
producer owns the syntactic array.

### The cost gate

Separated out because it is the one criterion in this plan that can stop the milestone, and because
the version that stood here through two drafts could not.

**What the earlier version got wrong.** It drove 200 keystrokes and reported the per-render cost of
the `renderRangeHighlight` loop at `virtualizedTextView.ts:854`. **A keystroke never enters that
loop.** `renderSnapshot` returns at `:843` when `rowsKey` is unchanged; `rowsKey` is
`totalSize:firstIndex:lastIndex:count:horizontalKey` (`snapshotRowsKey`,
`virtualizedTextViewHelpers.ts:140-147`, reached through `rowsKey`, `virtualizedTextViewRows.ts:178-183`);
a same-line edit changes none of those, and `applySameLineEdit` (`virtualizedTextView.ts:929-950`) never
resets `lastRenderedRowsKey` — only `applyMultiLineEdit` (`:964`) and `finishTextReplacement` (`:996`)
do. Measured, not inferred: `rowsKey` before and after a same-line keystroke on a 200-row view were
both `4000:0:19:20:direct`. So the old criterion reported ≈0 no matter how expensive shape (d) turned
out to be, and its "if the delta exceeds one frame at 60 Hz, stop" branch was unreachable. **A gate
that cannot fail is worse than no gate**, which is why this section exists.

**Where the cost actually is.** `renderRangeHighlight` has exactly two callers: `:854`, above, and
`setRangeHighlight` (`virtualizedTextViewHighlights.ts:259-282`), which also sorts the group's ranges
and rebuilds the view's whole range-rule stylesheet. **One call per live group per repaint, and
Milestone 5 makes that per keystroke.** That is the number to measure.

**The benchmark.** In `packages/editor/test/`, using the Map-backed registry and `MockHighlight` from
`rangeDecorationPaintOrder.test.ts:8-19`: build a `VirtualizedTextView` over a 200-row document
(`setText:373`, `setScrollMetrics:554` for a 20-row viewport), give it *N* live range-highlight groups
of ~20 viewport ranges each, then drive 200 same-line keystrokes through `view.applyEdit` (`:495`),
re-pushing every group's shifted ranges through `view.setRangeHighlight` (`:825`) after each one —
which is Milestone 5's steady state, not a synthetic one. Report per-keystroke wall clock for
**N = 0, N = 1, N = 12, N = the live group count the shipped theme actually produces, and one
find-shaped run** — the three groups `findController.updateHighlights` (`findController.ts:629-642`)
pushes together, over a viewport's worth of matches. **All five numbers are recorded in this file as a
blockquote.**

**Two gates, each anchored to a quantity the same benchmark measures rather than to a constant picked
to pass.**

- **Growth must be no worse than linear in live group count: `cost(N)/cost(1) ≤ 1.25 × N`.**
  `rebuildStyleRules` (`virtualizedTextViewHighlights.ts:1449-1469`) runs at the end of every
  non-skipped `setRangeHighlight` and rebuilds a rule for *every* group, so *N* groups updated per
  keystroke is *N*² rule constructions plus *N* reads of `styleEl.textContent`. If this gate fails, the
  fix is small and lives in `packages/editor`: a range rule depends only on the group's name and style
  (`rangeHighlightRule:1482-1490`), so a group whose style is unchanged cannot change the rule set —
  mark the range-rule set dirty and flush once, exactly as `SharedStyleRules` already does for token
  rules (`style-utils.ts:61,77,89,93-97`). Do not treat a failure here as a reason to abandon shape (d).
- **Sustained-typing cost must not exceed what this editor already spends on this exact mechanism.**
  Find-as-you-type is the precedent: it re-pushes three range-highlight groups
  (`findController.ts:33,34-38,39`) from `updateHighlights` (`:629-642`), and it does so at most once
  per `FIND_RESEARCH_DELAY_MS` (100 ms, `:50`, with a 400 ms ceiling at `:51`) because, as its own
  comment says (`:45-48`), a re-search "is not a bill a keystroke can be handed". Convert both to a
  rate, in milliseconds of `setRangeHighlight` work per second of sustained typing at 12
  keystrokes/second: the semantic layer costs `12 × cost(N_live)`, find costs `10 × cost(3 groups)`.
  **Gate: the first must not exceed the second.** Both terms are measured in the same harness, so the
  harness's own biases cancel; the only judgement in it is the 1× factor, and that is the conservative
  direction — find is live only while its widget is open, semantic colour is live whenever a
  TypeScript file is on screen.

  If this gate fails, work the remedies in order, cheapest first, and re-measure after each: **(1)**
  the `rebuildStyleRules` dirty flag above; **(2)** drop the modifier axis entirely, which takes the
  scope count from 84 to 12 and the style count down with it, at the cost of `readonly` and `local`
  ceasing to be visible — a real loss, named in *What a reader actually gains*, and the first thing to
  spend; **(3)** coalesce Milestone 5's repaint the way find already coalesces its re-search, a delay
  floor with a ceiling, so a sustained run pays a bounded rate rather than a per-keystroke one;
  **(4)** shape (b). If none of them get under the gate, the honest outcome is that Milestones 4 and 5
  do not ship — which is what "conditional" has meant since the top of this file.

**What is already known, so the executing agent is not surprised by it.** The verification pass ran
this benchmark's shape against 84 groups — the count the plan proposed before groups were keyed by
resolved style — in happy-dom:

> ```
> 200 keystroke-shaped repaints, 84 groups, ranges shift : 2888.1 ms  (14.4  ms/keystroke)
> 200 repaints, 84 groups, ranges unchanged (skip path)  :   75.6 ms  ( 0.38 ms/keystroke)
> 200 repaints,  1 group,  ranges shift                  :   29.7 ms  ( 0.15 ms/keystroke)
> ```

happy-dom performs no layout, style recalc or paint, and a browser adds all three on top of whatever
JS the repaint costs — so these numbers omit a term that only ever adds. They are not a strict bound
in the other direction, because happy-dom's `Range` and DOM implementations are plain JS and may be
slower than a browser's at the same work; treat them as indicative of *shape* and rely on the
same-harness comparisons in the two gates for the verdict. Two things follow, and both are already
built into the design above rather than left for the measurement to discover. First, 84 live groups
is not affordable — hence one group per resolved style. Second, **the cost is close to linear in
group count, not quadratic**: 84 × the one-group figure is 12.6 ms of the 14.4 ms measured, leaving
~1.8 ms for everything super-linear, and re-measuring the `rebuildStyleRules` term in isolation
(84 groups × 84 rule builds × 200 keystrokes, plain JS, no DOM) costs 0.86 ms/keystroke. The
verification pass attributed the 14.4 ms to `rebuildStyleRules`' O(groups²); its own one-group
datapoint contradicts that. **Fixing `rebuildStyleRules` buys roughly a tenth; cutting the group count is what buys the milestone.** The
first gate above still exists because the quadratic term is real and grows, not because it dominates
today.

- [ ] **Export `createEditorScopeStyles` on the public syntax surface** — `S`
- [ ] **Legend decode: 5-tuples to absolute offsets, with the untrusted-input rejections** — `M`
- [ ] **Semantic scope resolver: type axis through the trie, one canonical modifier suffix** — `M`
- [ ] **One highlight group per distinct resolved style, not per scope name** — `S`
- [ ] **Six new registered colour ids with reference defaults** — `S`
- [ ] **Explicit `zIndex` on `DIAGNOSTIC_STYLES.error`, and the priority-table regression test** — `S`
- [ ] **`SemanticTokensController`: request on content, selection *and* viewport; decode, resolve,
      paint through `setRangeHighlight?.()`** — `L`
- [ ] **Per-keystroke `setRangeHighlight` cost at N = 0/1/12/live, benchmarked against both gates and
      recorded here** — `M`

---

## Milestone 5 — Holding the painted spans across the request window

`effort S` · `risk low` · **conditional**

**Why here.** Last, because it is a refinement that only becomes visible once the layer paints.
Between a keystroke and the next semantic response, the painted ranges describe text that has moved.
Dropping them makes identifiers flicker back to tree-sitter colour on every keystroke, which is worse
than approximate colour; leaving them unprojected paints the wrong spans.

**This milestone is what makes Milestone 4's cost gate the gate.** Repainting from `resolve()` on
every content update is precisely the "one `setRangeHighlight` per live group per keystroke" the gate
measures; M4's steady state without M5 is one repaint per *response*, which is a debounce apart and
cheap. So do not start M5 until M4's four numbers are recorded and both gates pass, and re-run the
benchmark afterwards if the controller ends up pushing more groups per keystroke than the gate
assumed. If the gate's second threshold fails, coalescing this repaint on a delay floor with a
ceiling — the shape `findController.ts:45-51` already uses, and for the same stated reason — is a
permitted remedy; taking it means the exit criteria below must flush the pending repaint before
asserting, rather than reading the painted set straight after the edit.

This milestone is `S` rather than the `M` an earlier draft rated it, because shape (d) does the work
with a primitive that already exists. **Hand the decoded spans to `context.trackRanges(ranges, bias)`
(`plugins.ts:310-313`) and repaint from `resolve()`.** The anchors are piece-table anchors minted by
`Editor.trackDocumentRanges` (`:2342-2357`); `resolveTrackedRanges` (`:2360-2374`) drops any span
whose text is gone, which is exactly right for an identifier that was deleted. Nothing here goes
through `EditorDecorationStore`, so none of that store's per-edit cost applies, and none of
`projectTokensThroughEdit`'s single-edit limitation applies either — a batch edit, multi-cursor, a
formatter response or Replace All all resolve the same way, because anchors are a property of the
buffer rather than of one `TextEdit`. The find plugin is the working model
(`packages/find/src/plugin.ts:430-444`, `findController.ts:390,710,717`).

**The bias pair is a decision and must be recorded here as a blockquote with its reason.** The
default `trackDocumentRanges` gives an unnamed caller is `{ startBias: 'left', endBias: 'right' }` —
"a region of the document", which absorbs text typed at either edge. For an identifier that is
probably right: typing a character inside or at the end of `foo` should keep the whole of `fooX`
coloured rather than leaving the new character uncoloured, and it matches what
`shouldExpandTokenForInsertion` (`tokenProjection.ts:790`) does on the token path and what VS Code
hand-writes as a special case for "typing a single word character" in
`references/vscode/src/vs/editor/common/tokens/sparseMultilineTokens.ts`. But a character typed
immediately *before* an identifier is usually not part of it, which argues for `startBias: 'right'`.
Read `packages/lsp-plugin/src/diagnosticProjection.ts:26-28` and `:98-103` for the house reasoning on
kept-and-shrunk versus dropped, pick one, and write down why.

Note the staleness schemes on the two sides do not currently agree and this controller sits astride
both: `EditorSyntaxController` compares `documentVersion` against `contentVersion` against
`parsedSyntaxContentVersion` (`syntaxController.ts:634-636`), while the LSP controllers compare
`requestId`, disposal, and `ActiveDocument` identity (`documentHighlightController.ts:103-105`). Do not
invent a third; this controller lives in `packages/lsp-plugin`, so use the LSP one and say so. If a
future change needs the syntax controller's view of edits — it should not, under shape (d) — the hook
is `EditorSyntaxController.projectCacheForChange` (`:311`) and its single-edit implementation
`projectSyntaxRangeCache` (`:797-814`, which bails on `change.edits.length !== 1`). Named here so
nobody invents a third plumbing path looking for it.

**Exit criteria.** Typing a character before a tracked semantic span shifts its painted range by
exactly one character, without a request having completed. Typing inside a span keeps it, grown or
shrunk per the recorded bias pair, and the test names that pair and its reason. A multi-cursor edit
inserting at five sites at once shifts all spans after each site correctly — the case
`projectTokensThroughEdit` cannot handle and `trackRanges` can, asserted because it is the reason
this shape was chosen. Deleting the whole text of a span removes it from the painted set. A response
that arrives describing a document version older than the current one is discarded without painting.
Under continuous typing, semantic colour never disappears wholesale and reappears — a test asserts the
union of painted ranges is non-empty at every step of a ten-keystroke sequence with no response in
between.

- [ ] **Hold decoded spans as tracked ranges, with a recorded bias pair** — `S`
- [ ] **Repaint from `resolve()` on every content update, not from the last response** — `S`
- [ ] **One staleness scheme — the LSP-controller convention — stated in the controller** — `S`

---

## De-scopings

Deliberate, so an executing agent does not re-expand them.

- **No delta protocol.** No `SemanticTokensEdits`, no `resultId` round trip, no
  `releaseDocumentSemanticTokens`, no backwards splice. The recommended shape is range requests, which
  have no delta by design (`references/vscode/src/vs/editor/common/languages.ts:2495`); and even on the
  whole-document path our only server is in-process with no previous-array cache to diff against. This
  removes the finding's entire named subject. If an out-of-process server ever appears, the reference
  implementation to port is `references/vscode/src/vs/editor/contrib/semanticTokens/browser/documentSemanticTokens.ts:338-374`
  — one allocation sized `src.length + Σ(data.length - deleteCount)`, filled back-to-front so source and
  destination never alias — plus the invalid-`edit.start` guard at `:350-355` that exists because a
  server once sent `4294967276` and hung the editor.
- **No interruptible classification.** `ts`'s cooperative cancellation
  (`collectTokens` → `cancellationToken.throwIfCancellationRequested()`) would need a
  `SharedArrayBuffer`/`Atomics`-backed `HostCancellationToken` reaching into the worker, plus the
  cross-origin isolation headers `SharedArrayBuffer` requires. `$/cancelRequest` suppresses the
  response and the client debounce prevents most of the requests; that is the whole of the protection
  and Milestone 3 says so in a comment.
- **No semantic tokens in the token array.** Shape (b) above — a genuine second `EditorToken[]` in the
  view — is costed and rejected in favour of (d), not forgotten. It stays the migration path if a
  consumer ever needs semantic *tokens* rather than semantic *colour*.
- **No whole-document request path**, unless Milestone 2's benchmark says the whole-file walk is cheap
  enough to sit behind the existing diagnostic debounce. Default to range.
- **No two-tier complete/partial store.** `setPartialSemanticTokens`, `SparseTokensStore.setPartial`,
  piece splitting and `viewportSemanticTokens.ts` exist in the reference because a document tier and a
  viewport tier coexist. With one tier there is one held set of ranges, replaced wholesale per response.
- **No multi-provider fan-out for tokens.** `EditorLanguageFeatureRegistry` (`plugins.ts:740`) exists
  and is used for paste handlers and completion sources, but the highlighter and syntax channels are
  deliberately single-owner (`plugins.ts:648-649`) and this plan does not change that. One semantic
  source, from one LSP client.
- **No capture names on the main thread.** Capture-to-style resolution happens in the worker
  (`treeSitter.worker.ts:1149-1151`) and raw captures ship only when `includeCaptures` is on, gated by
  `needsSyntaxCaptures` (`Editor.ts:483`). Milestone 1 resolves overlaps *inside* the worker precisely
  so this stays true; widening the parse payload is not needed by anything in this plan.
- **No partial-overlap resolution.** Milestone 1 fixes exact-span duplicates only. Nested captures
  over different spans stay order-dependent, pinned by a test rather than fixed.
- **No semantic colour in sticky scroll, the minimap or the diff panes.** They hold their own views
  and call `setTokens` on them directly (`stickyScroll.ts:194`, `DiffView.ts:558,831`); no
  editor-scoped view contribution reaches them, under shape (d) or any other shape in this plan.
- **No font properties anywhere in the highlight layer.** Milestone 0 removes the inert declarations;
  neither the semantic type axis nor its modifier axis may reintroduce them.
- **No language other than TypeScript and TSX.** No CSS, HTML, JSON or Markdown semantic tokens; those
  have no server here.
- **No modifier subset matching.** One canonical modifier suffix, per Milestone 4.

---

## Risks

What could make the estimates above wrong, worst first.

- **The repaint is one `setRangeHighlight` call per live group, and Milestone 5 puts it on the
  keystroke path.** This is measured, not feared: 14.4 ms per keystroke at 84 groups in happy-dom,
  which does no layout, style recalc or paint — so a lower bound. The plan's two answers are one
  highlight group per resolved *style* rather than per *scope*, which is what makes the group count
  small, and the cost gate in Milestone 4, which measures the real number at the real group count and
  can stop the milestone. **This is still the single largest estimate risk in the plan**, because the
  live group count depends on how many distinct colours the shipped theme declares for semantic
  scopes, and nobody has counted them yet. If the gate fails, shape (b) is the fallback and it is
  `M`–`L` of new work inside `packages/editor` plus a new public setter — i.e. a materially larger
  milestone than the one costed. Two lesser traps live here too: the arithmetic that says "every term
  is bounded by the viewport, so it is fine" is the same arithmetic that blessed the merge point this
  plan had to move; and the previous version of the gate pointed at
  `virtualizedTextView.ts:854`, a loop a same-line keystroke cannot reach, so it would have reported
  ≈0 and passed. Neither an argument nor a benchmark is worth anything here until you have checked
  which line it is actually timing.
- **The TypeScript worker is shared.** `getEncodedSemanticClassifications` needs a type checker
  (`program.getTypeChecker()` in `collectTokens`) and `reclassifyByType` calls `getTypeAtLocation` per
  identifier. That is the same machinery serving diagnostics, hover and completion from one worker with
  one message loop, and the worker cannot interrupt a running walk. Milestone 3 could make hover feel
  slower even when semantic tokens are painting correctly, and that regression will show up in a place
  nobody is looking for it.
- **Milestone 2 is infrastructure work priced as a milestone but historically absent for a reason.**
  Nobody has stood up a real `ts.LanguageService` in this package. The lib-map-from-disk approach is
  straightforward on paper; VFS setup, `lib` resolution and `jsx` configuration are where this kind of
  harness usually costs a day nobody budgeted. If it overruns, everything conditional after it is
  blocked and the two unconditional milestones are already done — which is the intended stop point.
- **The priority table is a cross-package agreement with no enforcement.** Milestone 4 writes numbers
  into `packages/lsp-plugin/src/plugin.styles.ts` and reads numbers out of `packages/find`. Nothing
  stops a future change to find's `zIndex` values from silently inverting the `color` contest. The
  regression test named in Milestone 4's exit criteria is the only thing holding it, and it must
  assert the *relative order* of all four producers, not just the two the semantic layer added.
- **Milestone 0 changes a table every token style flows through.** `style-utils.ts:3-12` currently
  drives both the style key and the CSS declarations from one list; splitting it is the kind of edit
  that quietly changes a key and invalidates every cached highlight, or quietly collides two styles
  that used to differ. The exit criterion asserting `serializeTokenStyle` still separates styles that
  differ only in weight exists for this reason and is not optional.
- **Milestone 1's `nonOverlapping` claim is a hypothesis, not a result.** Cutting exact-span
  duplicates removes the overlap kind we know about; whether the shipped queries produce others is
  unmeasured. The exit criterion records the measured value rather than asserting an outcome, and a
  false result there is information, not a failure.
- **Scope drift toward "just add the delta protocol too".** It is the named subject of the original
  finding and it will look like the obvious missing piece to anyone reading that finding rather than
  this plan. It is de-scoped above with a reason. Do not add it.
- **Scope drift toward "put them in the token array after all".** Shape (b) is written up above in
  enough detail to look inviting. It is the fallback, gated on one specific measurement failing. Do
  not take it because it feels more correct.

---

## Sequencing

Milestones 0 and 1 are unconditional, independent of each other, and independent of everything after.
M0 edits `style-utils.ts` and `captures.ts`; M1 edits `captures.ts` and the worker's capture-to-token
conversion. They share `captures.ts`, so run them in series rather than in two worktrees — M0 first,
because its table split is the smaller edit and M1's rank table sits beside the rules M0 touches.

Milestone 2 can start in parallel with either, in `packages/typescript-lsp`, which neither of them
touches. Its benchmark is an input to Milestone 3's request shape, so it must finish before M3 begins.

Milestones 3 and 4 are separable by package and can run in two worktrees once M0, M1 and M2 have
landed: M3 is confined to `packages/typescript-lsp`, M4 to `packages/lsp-plugin` plus two named edits
in `packages/editor` (`public/syntax.ts` to export `createEditorScopeStyles`, `theme.ts` for the six
colour ids). They meet only at the legend, so fix the legend arrays into a shared constant in M3's
first item and neither side blocks the other. **M4 no longer touches `syntaxController.ts` or the
view's token path at all** — that is the point of shape (d), and if an executing agent finds itself
editing either file, it has drifted into shape (b) and should stop and say so. One carve-out: if the
cost gate's first threshold fails, the `rebuildStyleRules` dirty-flag fix lands in
`virtualizedTextViewHighlights.ts`. That is the range-highlight path, not the token path, and it is
the one edit inside `packages/editor` this milestone may make beyond the two named above.

Milestone 5 is strictly after Milestone 4 and touches only the controller M4 adds.

Stop points, in order of preference if the work has to end early: after Milestone 1 (two defects
fixed, nothing else started — the best stop point in this plan); after Milestone 2 (a test harness
the package will want regardless, plus a recorded cost number that tells a future reader whether the
rest is affordable); after Milestone 4 (semantic colour paints and is correct at rest, but flickers
under typing). Stopping after Milestone 3 leaves a server nobody calls — dead code, so prefer
stopping before it.

---

## Review

This plan has been through two adversarial passes, in order: a **critique** that read the call chains
and returned fifteen findings, and a revision that answered them; then an independent **verification**
that re-read every citation fresh, re-derived the arguments, and ran its own browser and happy-dom
measurements. Recorded here because an executing agent needs to know which parts have been
stress-tested, which corrections were rejected and on what evidence, and where the remaining edges are.

### Pass 2 — verification

**Verdict: NOT-EXECUTABLE, for one named reason.** Milestone 4's cost gate benchmarked the wrong
function. Everything else it raised was a correction, not a blocker; Milestones 0–2 were found clean
and writable as stated, and all fifteen of the critique's findings were confirmed closed.

**The blocking finding, and what changed.** The gate drove 200 keystrokes and timed the
`renderRangeHighlight` loop at `virtualizedTextView.ts:854` — a loop guarded by
`if (key === view.lastRenderedRowsKey) return` at `:843` that a same-line keystroke provably never
enters. The verifier drove a real `VirtualizedTextView` through one and printed `rowsKey` either side:
both `4000:0:19:20:direct`. So the gate reported ≈0 regardless of the design's cost, and its
"stop the milestone" branch was unreachable. **Chosen remedy: fix the criterion *and* the design it
gates**, because the verifier's replacement measurement — 14.4 ms/keystroke at 84 groups, in an
environment that does no layout, style recalc or paint — already answers the question the old gate
deferred, and gating a shape we have measured to fail on a re-measurement would repeat the same defect
one level up. Milestone 4 now (a) keys highlight groups by **resolved style** rather than by scope
name, which is what makes the group count small, and (b) carries a *cost gate* section that
benchmarks `setRangeHighlight`-per-group-per-keystroke at N = 0/1/12/live plus a find-shaped
baseline, with two thresholds each anchored to a quantity the same benchmark measures — growth no
worse than linear in group count, and a sustained-typing rate no higher than the one find-as-you-type
already spends on the identical mechanism — rather than to a constant chosen to pass. Both can fail,
and on the numbers in hand the second one does at 84 groups, which is why the design changed too.
The prior measurement is quoted in the plan so an executing agent knows what to expect before
running it.

**A judgement of the verifier's that did not survive checking.** It attributed the 14.4 ms to
`rebuildStyleRules`' O(groups²). Its own datapoints say otherwise: 84 × the one-group figure (0.15 ms)
is 12.6 ms of the 14.4 ms measured, leaving ~1.8 ms for everything super-linear, and re-measuring the
`rebuildStyleRules` term alone (84 groups × 84 rule builds × 200 keystrokes, plain JS, no DOM) costs
0.86 ms/keystroke. The cost is close to linear in group count. This matters for the remedy: fixing
`rebuildStyleRules` buys about a tenth, so cutting the group count is what buys the milestone. The
quadratic term still gets its own gate, because it is real and it grows — but it is not the headline.

**A second finding, not on the blocking list, accepted anyway.** Milestone 3 recommends a range-only
server, and Milestone 4 specified its controller by copying `documentHighlightController`, whose
filter is `if (kind !== 'selection' && kind !== 'content') return` (`:45`). `'viewport'` is a real
update kind (`plugins.ts:327`, fired from `handleViewportChange` at `Editor.ts:2717`) and nothing in
the plan asked for it, so an agent executing literally would ship a feature where scrolling into
unvisited code stays tree-sitter-coloured until you type there. **Milestone 4 now names the
`'viewport'` request explicitly and carries an exit criterion for it**, and the pre-existing
scroll-back criterion is kept but is the weaker of the two — under shape (d) it is close to
structurally guaranteed.

**Smaller corrections accepted.**

- `tokenProjection.ts` has **four** exports, not three. `copyTokenProjectionMetadata` (`:67`) was
  missing from the plan's account and from the critique's. It is now named, along with why it is not a
  merge point despite looking like one, and both its call sites (`Editor.ts:655`,
  `virtualizedTextViewHighlights.ts:114-117`).
- Milestone 1's `nonOverlapping` measurement needs a real TypeScript grammar and **no TypeScript wasm
  is checked into this repo**. The dependency path
  (`packages/tree-sitter-languages/node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm`)
  and the loading pattern (`packages/markdown/test/replacements.test.ts:19-40`) are now both named in
  the criterion, with the reason a hand-written fixture cannot substitute.
- Milestone 2's threshold compared a wall clock to `DEFAULT_DIAGNOSTIC_DELAY_MS` — a debounce
  interval, which says when work starts and nothing about how long it may take. It now benchmarks
  `getCompletionsAtPosition` and `getQuickInfoAtPosition` on the same warm service and the same
  fixture, and asks whether the classification walk introduces a **new** worst-case block on a worker
  that has one message loop and no queue, or hides inside one that already exists. The old comparison
  is left visible as a thing not to reintroduce.
- Path 3 in *Every path that adopts tokens* was labelled `Editor.clearDocument`. `Editor.ts:646` is
  inside `setContent` (`:640-651`); `clearDocument` (`:945`) reaches it through `clear()` → `setContent('')`.
  Corrected.
- `setRangeHighlight`, `clearRangeHighlight` and `trackRanges` are **optional** members of
  `EditorViewContributionContext` (`plugins.ts:310,314,319`). The plan never said so; the house call
  style is `?.`. Now stated in Prerequisites and in Milestone 4's checklist.
- `projectSyntaxRangeCache` starts at `syntaxController.ts:797`, not `:795`. Corrected in both places.
- `$/cancelRequest` on a **cold** service does save real work, because `ensureService` awaits a
  network fetch. Milestone 3 now says so, scoped to the first request after the worker boots.

**Rejected, with the evidence.**

- *"Citation drift in `javascript-highlights.scm`: `@constructor` is `:53-54`, `@constant` `:56-61`,
  `@variable.builtin` `:63-65`, `function.method` `:46-48`."* **Wrong — the plan's numbers were
  already right.** `grep -n` on the file at HEAD: `@constructor` `:51-52`, the `@constant` rule
  `:54-59` (the bracketed alternation opens at `:54`), `@variable.builtin` `:61-63`, and the
  call-position `@function.method` `:44-46`. The file is unmodified in the working tree and has one
  commit touching it. The verifier's four line numbers are each +2 from the truth; the plan's are
  exact and are left alone.
- *"`rangeDecorations.ts` `zIndex ?? 0` is at `:77`."* Wrong; `grep -n "zIndex ?? 0"` puts it at
  `rangeDecorations.ts:75`, which is what the priority table already said. Left alone.
- *"`documentHighlightController.ts:44` is the update-kind filter."* Off by one — it is `:45`. The
  substance (that `'viewport'` is not handled) is right and is acted on above; the citation in the
  plan is `:45`.

### Pass 1 — critique

Fifteen findings; nine accepted, three accepted with the reasoning corrected, three rejected or
narrowed.

**Accepted, and the design changed.**

1. *The merge point was on the per-keystroke path.* Verified: `Editor.renderSessionChange`
   (`Editor.ts:2985-2996`) → `applyEdit` → `Editor.adoptTokens` (`:679-681`) → `syntax.setTokens`.
   A merge there costs a concat, a sort and an index rebuild per character, and loses the live-range
   fast path because the merged array is fresh. The plan's defence — "already what every window parse
   does" — was wrong: window parses are scroll-triggered, not per-character. **Milestone 4 no longer
   merges into the token array.** It paints through the range-highlight layer instead.
2. *A merge in `setTokens` is bypassed on scroll-back.* Verified at `syntaxController.ts:481`
   (`repaintCachedVisibleSyntaxRange`). The reviewer's second citation, `Editor.ts:477`, is not a
   bypass — it is the `adoptTokens` option callback that both `setTokens` and `:481` funnel into, and
   is therefore the one chokepoint that covers everything. **A new section, *Every path that adopts
   tokens*, enumerates all seven paths**, and Milestone 4 carries a scroll-back exit criterion.
3. *No channel exists for a plugin to supply tokens.* Verified: `EditorViewContributionContext`
   (`plugins.ts:257-319`) has `setRangeHighlight`/`clearRangeHighlight` and nothing token-shaped;
   `public/syntax.ts` has no setter; `EditorSyntaxController` is not exported from `index.ts`. The
   reviewer's *unconsidered fourth option* — the range-highlight channel, already exposed, already
   priority-aware, already windowed to mounted rows — is the right answer, and **it is the shape
   Milestone 4 now takes**. That deletes the prerequisite rather than adding it: no new public API
   beyond exporting `createEditorScopeStyles`. Shape (b), a genuine second token array composed per
   painted row, is costed as the fallback and gated on one measurement.
4. *No test in `packages/typescript-lsp` has run a real language service.* Verified:
   `worker.test.ts:39` mocks `typescript` wholesale, `fakeTs` has no `LanguageService`, only
   `tsDiagnostics.test.ts` imports real `ts`, and `createService` fetches libs over the network.
   **Promoted from an unlisted assumption to Milestone 2**, with the lib-map-from-disk and the
   `vi.mock` module-scope problem both named.
5. *"Asserts the painted colour" is not observable.* Verified: `::highlight()` styles are not
   reachable through `getComputedStyle`, `packages/editor/test/__screenshots__/` holds one failure
   artefact and there is no `toMatchScreenshot` anywhere. The house already answered this in
   `rangeDecorationPaintOrder.test.ts` with a happy-dom Map-backed registry and a `MockHighlight`
   carrying `priority`. **Every paint-order criterion in this plan now names that harness**, and the
   claim that these need a real browser is gone.
7. *M1 was about to break error diagnostics.* Verified: `DIAGNOSTIC_STYLES.error`
   (`plugin.styles.ts:114-118`) declares `color` with no `zIndex`, so it sits at 0 alongside every
   token highlight, and find sits at 1/2/3. Giving tokens a positive band would have made every token
   outrank the error's colour. **A new section, *The highlight priority space*, tabulates all four
   producers**, Milestone 4 sets an explicit band with a regression assertion, and Milestone 1 no
   longer touches `Highlight.priority` at all.
8. *The cheapest form of M1 was de-scoped by an argument that did not apply to it.* Verified:
   `treeSitterCapturesToEditorTokens` runs in the worker with `captureName` in hand
   (`treeSitter.worker.ts:1149-1151`), and identical-span duplicates trip
   `token.start < builder.previousEnd` at `tokenIndex.ts:51`. **Milestone 1 is now worker-side
   exact-span resolution** — one function, no wire change, no style-key change, no priority hazard —
   and the "no capture names on the main thread" de-scoping is rewritten to say it is *why* the fix
   goes in the worker.
9. *M1 was building M3's mechanism while claiming to be standalone.* Accepted, and resolved by 8:
   style-carried priority is gone from the unconditional work entirely, and the priority question is
   answered once, in Milestone 4, against a real semantic layer.
10. *The `$/cancelRequest` prerequisite cannot do what the plan said.* Verified: `handleIncomingMessage`
    (`:110-118`) dispatches immediately, `ensureService` (`:415-423`) resolves in a microtask after
    warm-up, and a cancel notification is a macrotask — the walk has already finished. **Milestone 3's
    criterion now asserts response suppression and asserts the work still ran**, the risk item about a
    queue of stale type-checks is deleted because there is no queue, and the `SharedArrayBuffer`
    cooperative token is named and de-scoped.
12. *M0 uncovered a live defect and filed it as a design input.* Verified: `text.emphasis`
    (`captures.ts:55`) and `text.strong` (`:58`) declare **only** a font property, so
    `normalizeTokenStyle` keeps them and `buildHighlightRule` emits an inert rule — those markdown
    tokens paint nothing at all today, on both the tree-sitter and shiki paths
    (`shiki/editor-tokens.ts:22,24`). **Milestone 0 is now a fix with a failing-today test**, not a
    measurement.
13. *Wrong prerequisite citation.* Verified: `lineStartForSnapshotLine` (`positions.ts:268-270`) and
    `rowForOffset` (`:243-262`) are module-private. Corrected to `lspPositionToOffsetInSnapshot`
    (`:33`), with the mistake left visible so nobody re-imports the private ones.
14. *M4 didn't name the hook it needed.* Accepted; `projectCacheForChange` (`syntaxController.ts:311`)
    and `projectSyntaxRangeCache` (`:797-814`) are named in Milestone 5 — though under shape (d) the
    milestone no longer needs them, because `trackRanges` handles batch edits that
    `projectTokensThroughEdit` cannot.
15. *Two exit criteria passed with the feature absent.* Accepted. Both are folded into
    single-fixture assertions that carry positive and negative expectations together.

**Accepted with the reviewer's reasoning corrected.**

6. *M0's method could not see what M0 named.* The reviewer is right that geometry and
   `getComputedStyle` cannot answer whether `::highlight()` applies font properties — highlight
   pseudo-elements never affect layout, so the advance cannot change even on an engine that honoured
   `font-weight`. But the reviewer's conclusion — that only a rendered-pixel comparison is honest —
   concedes too much. **The question is already settled twice over**: by CSS Pseudo-Elements 4, which
   admits only colour, background-colour, text-decoration, text-shadow and text-stroke; and by this
   repo's own range path, where `VirtualizedTextHighlightStyle` (`virtualizedTextViewInternals.ts:47-55`)
   offers no font properties and `rangeHighlightRule` (`:1482-1490`) emits none. The house already
   knows. So M0 needs no pixel infrastructure and no measurement — it needs the token path to stop
   emitting declarations the range path never offered.
11. *"We replace the style wholesale" is not what the mechanism does.* Correct, and the correction
    matters more than the reviewer says. Because the CSS Custom Highlight API resolves **per
    property**, the semantic layer gets `bMask`/`aMask` fall-through for free — which is now listed
    as a *benefit* of shape (d) rather than a de-scoping. It is also what makes the priority table
    tractable: only three producers declare `color`, so only three contend.

**Rejected or narrowed.**

- *Finding 2's second call site.* `Editor.ts:477` is the `adoptTokens` option callback — the sink that
  `syntaxController.ts:194` and `:481` both reach, not an independent path around them. Calling it a
  bypass obscures the useful fact, which is that it is the *only* chokepoint covering all seven
  adoption paths. The enumeration in this plan states it that way.
- *Finding 1's "the mitigation it offers is the design it says it isn't taking".* Fair as written, but
  the resolution is not the mitigation the reviewer had in mind. Per-painted-row merging (shape b) is
  costed here and **not** taken; the range-highlight layer is taken instead, and it is a second layer
  the view already composes — so the plan is no longer offering a fallback it refuses to name.
- *Finding 8's `nonOverlapping` claim.* The mechanism is verified and the direction is right, but
  "restores `nonOverlapping`" is stronger than the evidence: exact-span duplicates are one overlap
  kind and nested captures over different spans would trip the same check. Milestone 1's exit
  criterion measures the value on a real fixture and records it rather than asserting it.
- *The reviewer's overall recommendation that M3–M5 not be built.* This plan already said they are
  conditional and should not start without a human go-ahead, and the reviewer's cost objections
  (findings 1–4) have been absorbed rather than argued with — the plan is longer and the harness is
  now a milestone. What changed the arithmetic in the other direction is that the largest unpriced
  cost, a new plugin→token public API, turned out not to be needed. The recommendation stands as
  written in *Verdict, up front*: build M0, M1 and M2; ask before M3.
