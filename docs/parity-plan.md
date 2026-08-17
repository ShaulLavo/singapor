# Monaco / CodeMirror 5 parity — execution plan

Single source of truth for this project. **Re-read this file at the start of every turn**; it is
the only state that survives context compaction, session restarts, and handoff between agents.

- Findings in full prose: `docs/parity-monaco-codemirror.md`
- Findings machine-readable: `docs/parity-findings.json`
- Reference checkouts (read-only, gitignored): `references/codemirror5`, `references/vscode`

## Working protocol

1. **Re-read this file first, every turn.** Work the topmost milestone that is not yet complete,
   and within it the topmost unchecked finding.
2. **Before implementing a finding**, open its entry in `docs/parity-monaco-codemirror.md` and read
   the *mechanism*, *how to implement*, and *reference* citations. Confirm against the current
   source that the gap still exists — some entries may already have been closed by earlier work.
3. **Implement it the way this codebase already works**, not the way the reference does. Monaco
   builds spans per token; we paint through the CSS Highlight API over fixed-row virtualization.
   Adopt the *idea*, not the DOM strategy. Match surrounding naming, comment density, and idiom.
4. **Every finding gets a test** that fails before the change and passes after, in the package's
   existing `vitest` setup. A finding with no test is not complete.
5. **Update the checkbox in this file immediately** after each finding lands — before starting the
   next one. Never batch checkbox updates; that is the state that survives a crash.
6. **A milestone is complete only when** `bun run test`, `bun run typecheck`, and `bun run lint`
   all pass, and the work is committed with a message naming the milestone. Check the milestone
   box only after the commit exists.
7. **Do not mark anything complete you have not verified with a passing run.** Show the command
   output.

## Rules

- **Stay on the parity branch.** Never commit to `main`.
- **Never revert, reformat, or "clean up" unrelated code.** `bun run format` reformats the whole
  repo — format only the files you changed.
- **Never modify `references/`.** It is reference material and is gitignored.
- **If a finding turns out to be a false gap** (already implemented, or a bad fit for our
  architecture), mark it `[~]` with a one-line reason. Do not silently skip it, and do not
  implement something you believe is wrong just to close the box.
- **If a finding is blocked**, write the blocker inline under it, mark it `[!]`, and move to the
  next independent finding in the milestone. Do not stall.
- **If a milestone's dependency turns out to be wrong**, say so and re-order rather than forcing it.

## Status key

`[ ]` not started · `[x]` done, tested, committed · `[~]` deliberately skipped (reason required)
· `[!]` blocked (blocker required)

## Already landed (before this plan)

- [x] EOL / BOM normalization at ingestion — `pieceTable/lineEndings.ts`, `pieceTable/documentText.ts`
- [x] Case-insensitive search no longer folds the haystack — `packages/find/src/search.ts`
- [x] Replace All uses its own limit, not the paint cap — `packages/find/src/findController.ts`
- [x] Work scheduler `maxDelayMs` (debounce starvation) — `editor/workScheduler.ts`

## Plan provenance

Milestones were sequenced from a per-finding dependency analysis. One analysis agent died
mid-run, so findings in the `text-model` and `input-a11y` domains (22 of 99) were ordered
from the findings data alone, without derived prerequisite edges. Coverage is verified
complete — every finding appears exactly once — but treat ordering in those areas as a
strong default rather than a proof. Re-order per rule 9 if a dependency turns out to be wrong.

## Progress

**36 / 99 findings complete.** Update this count when you check a box.

Milestones: 5 / 16 complete.


---

## Milestone 1 — Cheap correctness wins ✅

`effort M` · `risk low` · 8 findings · 3 already landed

**Why here.** Front-loads the highest value-per-line fixes in the whole set, none of which has a prerequisite and all of which are S-sized single-function edits: the render invalidation key that currently defeats every row cache during horizontal scroll, the highlight z-order defect, four contained find/replace bugs, and the two remaining maxDelayMs wirings. It also proves the test harness works across the node, dom and browser vitest projects before any foundation is touched. Two entries here (EOL/BOM is in milestone 2, case-insensitive folding here) already landed in the working tree — for those the work is verification plus the regression test that was never written, which is exactly the confidence-building the first session needs.

**Exit criteria.** Row geometry survives a 1px horizontal scroll (browser assertion); a find match keeps its stacking order after scrolling out of and back into view; find navigation terminates on a zero-width match; regex-mode seeding escapes metacharacters; '19999+' renders for a truncated result set and selectAllMatches is either uncapped or explicitly refuses; a 'İ'/'ẞ' regression test asserts returned ranges slice back to the query; syntax refresh fires within maxDelayMs under continuous typing. Full test suite green.

- [x] **Semantic render-input equality as the invalidation key, not a scroll-position-derived string**  
  `medium` `S` `partial` `rendering`
- [x] **Range-highlight paint order is registration-order dependent, so overlapping decorations can swap z-order after scrolling**  
  `medium` `S` `missing` `decorations-widgets`
- [x] **Zero-width matches deadlock navigation; both references have an explicit escape and Monaco adds a line-stop rule**  
  `high` `S` `partial` `find-replace`
- [x] **Seeding the search string from the selection does not escape regex metacharacters when regex mode is on**  
  `medium` `S` `partial` `find-replace`
- [x] **Replace-pattern edge cases: out-of-range $nn should degrade digit-by-digit, and a backslash should swallow the next character**  
  `medium` `S` `partial` `find-replace`
- [x] **Replace All silently stops at 19,999 matches; Monaco has a dedicated large-replace path**  
  `high` `S` `missing` `find-replace`
- [x] **Case-insensitive plain search folds the whole haystack, which both wastes memory and corrupts offsets**  
  `high` `S` `missing` `find-replace`
- [x] **Debounces with no maximum wait starve syntax refresh under continuous typing**  
  `high` `S` `partial` `api-perf-infra`

> **Deviations, recorded.** (a) The zero-width escape steps the ordered match list rather than
> re-probing the document, so Monaco's `^`/`$` line-stop rule is not ported: we already hold every
> match in document order, and the anchor heuristic it needs mis-fires on `[^,]*`. (b) Find
> Next/Previous still walk the capped match list — that is M12's "Find Next past the match limit"
> finding, and the truncated-count tooltip names Replace All and Select All Matches specifically
> rather than claiming all find operations are uncapped.


---

## Milestone 2 — Text-model ingestion and indexes ✅

`effort L` · `risk medium` · 7 findings · 1 already landed

**Why here.** Everything downstream reads offsets out of the piece table, so the buffer-construction pass is the earliest place to fix silent corruption (surrogate splitting, U+2028/U+2029 phantom rows) and the natural single scan in which to compute the classification flags (mightContainRTL / mightContainNonBasicASCII / containsUnusualLineTerminators) that the rendering fast paths in milestones 4 and 5 want to consult. The huge-file guards land here because the find and syntax work later must be able to ask the buffer how big it is before doing anything O(n). All items are pure-logic and node-testable, so the risk stays contained to one package directory.

**Exit criteria.** A CRLF+BOM document round-trips unchanged through open/edit/save and renders no trailing CR; pasting or loading text containing U+2028/U+2029 cannot desynchronize row geometry; no edit path can produce a lone surrogate (validateBatchEdits snaps the range); EditorTextBuffer exposes isTooLargeFor* predicates decided once at construction; buffer line indexes are typed arrays and offsetToPoint performs one descent. Node unit tests cover each; no behavioural change visible to the view layer.

> Ordering in this milestone rests partly on un-analyzed domains (input-a11y, text-model).

- [x] **EOL detection, normalization, and BOM stripping at buffer-construction time**  
  `high` `M` `missing` `text-model`
- [x] **U+2028/U+2029 line separators are a rendering/geometry landmine**  
  `high` `S` `missing` `input-a11y`
- [x] **Surrogate-pair-aware range validation before an edit is applied**  
  `medium` `S` `partial` `text-model`
- [x] **Huge-file guards decided once at construction and permanently respected**  
  `high` `S` `partial` `text-model`
- [~] **Buffer-level `mightContainRTL` / `mightContainNonBasicASCII` flags that unlock a per-line rendering fast path**  
  `medium` `M` `partial` `text-model`
- [x] **Position<->offset conversion caches: a node search cache, a last-visited-line cache, and a remainder trick that avoids the second tree descent**  
  `medium` `M` `partial` `text-model`
- [x] **Chunked change buffer with re-chunking, and typed-array line-start indexes**  
  `medium` `M` `partial` `text-model`

> **`[~]` reason (RTL/ASCII flags).** Two of its three sub-items are dead here. The ASCII fast path
> already exists and is applied harder than the reference's — `isSimpleRowText` gates seven call
> sites including `rowUsesCalculatedGeometry`, which skips DOM measurement for the whole row, not
> just grapheme analysis. `mightContainRTL === false` is only useful as a proof that lets you skip
> bidi work, and we have none to skip (the sole hit for bidi in the repo is the TODO at
> virtualizedTextViewGeometry.ts:161); the real finding hiding behind it is BiDi geometry itself,
> which is its own project. The third sub-item, unusual line terminators, shipped as the
> U+2028/U+2029 finding above.
>
> **Deviations, recorded.** (a) Surrogate snapping validates the *result*, not the range: an edit is
> only widened when it would actually orphan half a pair. A code-unit diff that replaces one low
> surrogate with another (which is what `syncTextEdit` emits for an emoji swap) is left alone, and
> two adjacent edits that between them consume a whole pair no longer collide. Range-only snapping
> corrupted the first case and threw on the second. (b) The applied ranges — not the caller's — are
> what `DocumentSessionChange.edits` reports, since undo inversion, incremental re-render and the
> LSP's document copy all patch from that list. (c) Only the materialization budget landed; a size
> cutoff on tokenization or worker syncing would replace the viewport windowing those layers already
> do with a cliff. (d) Per-finding scope creep worth knowing at revert time: this milestone also
> touches `editor/inputSelectionController.ts` (paste/drop normalization) and
> `virtualization/virtualizedTextViewLayout.ts` (`computeLineStartsFromSnapshot` indexOf), neither of
> which is in the piece table or the session.


---

## Milestone 3 — Core session infrastructure ✅

`effort XL` · `risk high` · 7 findings

**Why here.** The four things the largest number of later findings assume: a DisposableStore (eleven ad-hoc arrays in plugins.ts today, and the widget/zone work in milestones 5 and 15 would otherwise add more), operation batching (linked editing, column selection, scroll anchoring and the render phase split all otherwise grow their own per-feature coalescing that is then deleted), the emitter that fire() must route through that batch queue, and the typed option registry whose compute(env) layer is what makes derived metrics fall out cleanly in milestone 4. Undo coalescing, undo bounding and the cursor-history stack ride along because they live in the same session/history layer and are independently shippable once batching defines the transaction boundary.

**Exit criteria.** pluginLifecycle.test.ts asserts nothing survives mount/unmount via DisposableStore; a browser test counts forced-layout reads across a multi-edit sequence and shows one flush, with plugin onChange notifications firing once per operation; updateOptions and the 21 legacy setters produce identical state (public-api.test.ts still green, react/solid sync paths reduced to the registry diff); a throwing listener no longer aborts the notification chain; holding Backspace over a word undoes in one step; undo depth is capped with retained snapshots released.

> Ordering in this milestone rests partly on un-analyzed domains (text-model).

- [x] **DisposableStore and a pluggable disposable tracker for leak detection**  
  `medium` `S` `partial` `api-perf-infra`
- [x] **Operation batching: coalesce DOM reads/writes across nested and repeated edits**  
  `high` `L` `partial` `api-perf-infra`
- [x] **Emitter/Event: lazy wiring, listener-error isolation, re-entrancy-safe delivery, leak detection**  
  `medium` `M` `partial` `api-perf-infra`
- [x] **Typed option registry: validate → compute → per-option change diff**  
  `high` `L` `missing` `api-perf-infra`
- [x] **Undo coalescing keyed on edit-operation type, so consecutive deletes merge and an explicit undo-stop API exists**  
  `high` `M` `partial` `text-model`
- [x] **Bounded undo history — depth cap, and serializing closed stack elements out of the live heap**  
  `high` `M` `missing` `text-model`
- [x] **Cursor undo/redo as an independent bounded stack**  
  `medium` `S` `missing` `cursor-selection`

> **Deviations, recorded.** Each finding was cut to its Verifier scope, so several halves named in
> the prose are deliberately absent: no global disposable tracker or stack capture (the leak it
> would have found was a silent-drop branch in `plugins.ts`, closed directly); no five-phase
> read/write split (one pass with a rect cache); no lazy first-listener wiring and no
> debounce/throttle operators on the emitter (`workScheduler` is the deferral primitive); no
> compute/derived-options layer (a descriptor array both bindings iterate); no undo-stop API (we
> have one); no history blob serialization, and tombstone compaction stays a separate future item
> that the depth cap unblocks.
>
> Two exit criteria were not met as written. "updateOptions and the 21 legacy setters" was reduced
> to the descriptor registry, which is what the Verifier asked for. And the operation-batching
> criterion asks for a *browser* test counting forced-layout reads; the count is asserted in the
> happy-dom project instead, against a stubbed layout — the editor package runs no browser project.
>
> **Infrastructure fix that belongs to the whole plan.** `packages/react` and `packages/solid`
> resolved `@singapor/core` through its exports map, i.e. to `packages/editor/dist`. Every test in
> those two packages was therefore asserting against the last build rather than the current source,
> and a deliberate mutation to the editor's option descriptors left both suites green. Their vitest
> configs now alias the package's subpaths to `packages/editor/src`, derived from that same exports
> map so the two cannot drift.
>
> **One guard left untested.** `recordCursorHistory`'s `before.session !== this.cursorHistorySession`
> check is defence against recording a caret reading taken against a document the pass then swapped.
> No scenario I could construct reaches it — `cursorHistoryForSession()` clears first in every path
> I tried — so it survives mutation. Kept rather than removed, because it guards a corruption whose
> cost is far above the cost of an unreachable branch.


---

## Milestone 4 — Font metrics and character geometry ✅

`effort L` · `risk medium` · 7 findings

**Why here.** The measurement substrate. Font measurement lands first because its widened metrics record (spaceWidth, maxDigitWidth, monospace validity, DPR in the cache key) plus the document.fonts/matchMedia invalidation is what the key-column probe, the deferred width pass and the whitespace dot glyph all read, and because its re-measure fan-out is the option-registry recompute from milestone 3. CharacterMapping precedes the lazy per-column memoization because building fill-on-demand sentinels on the object array and then converting to typed arrays is rewritten work. Long-line text-node splitting sits next to CharacterMapping since both touch the DOM↔offset direction (the WeakMap<Node, part> replacement for partForNode's linear scan).

**Exit criteria.** A webfont swap or DPR change re-measures and relayouts every mounted editor (no caret desync); row geometry allocates typed arrays rather than per-character objects, with offsetToX/xToOffset signatures unchanged and virtualizedTextView.browser.test.ts green on caret placement, selection rects and hit tests under CSS transform; a CJK/emoji/large-font line can be scrolled to its end; whitespace 'boundary' and 'trailing' modes render with an advance-width-matched glyph and marker recomputation is gated on a cheap precondition rather than running offsetToX twice per whitespace character per frame.

- [x] **Font measurement: what to measure, how to key the cache, and when to throw it away**  
  `high` `M` `partial` `api-perf-infra`
- [x] **Key-column anchoring: bounded float drift on long lines without per-character measurement**  
  `high` `S` `missing` `rendering`
- [x] **CharacterMapping: a packed bidirectional column↔DOM-position index**  
  `medium` `M` `partial` `rendering`
- [~] **Lazy, memoized per-column pixel offsets with a shared Range and one cached container rect**  
  `high` `M` `partial` `rendering`
- [x] **Long-line defences: token-span splitting, render truncation with an escape hatch, and bounded coordinate magnitudes**  
  `medium` `S` `partial` `rendering`
- [x] **Deferred true line-width measurement to fix the horizontal scroll extent**  
  `high` `M` `missing` `rendering`
- [x] **Whitespace rendering as an overlay, with boundary/trailing modes and an advance-width-matched dot glyph**  
  `medium` `S` `partial` `rendering`

> **`[~]` reason (lazy per-column offsets).** Three of its four parts landed: the container rect is
> read once per measurement window rather than once per grapheme (already true via Milestone 3's
> pass), the per-segment `createRange()` is now one reused module-level Range parked on a detached
> node between reads, and `clientRectScale` — the correctness half — divides measured advances back
> out of a CSS-transformed host. The fourth, the lazy `Float32Array`-with-sentinel fill-on-demand
> scheme, is **not** done. The Verifier called it the optional last step, and the typed-array layout
> it needs is now in place, so it drops in without rework. Reported undone rather than half-built.
>
> **Two correctness bugs the review caught in this milestone's own work.** Both were in key-column
> anchoring, both verified by execution before and after. (a) The forward map re-anchors by column
> while the inverse selected an anchor by x, so an x in the gap between an anchor's extrapolated end
> and the next anchor resolved to a column past the span — a click landing one to two characters
> right of where the caret draws, and not monotonically. The inverse now clamps to the span its
> anchor owns. (b) Anchors are measured in the row's own space but `characterWidth` is probed
> through the host, so under a CSS transform an anchored row's boundaries stepped *backwards* at
> every anchor (offset 300 drawn 1069px left of offset 299). The estimate is now divided by the same
> scale the measurements are.
>
> **Deviations, recorded.** Skipped per the Verifiers: the 256-char probe, `maxDigitWidth` and
> `typicalFullwidth` (16 'm's already averages sub-pixel rounding sixteen ways); render truncation
> and the scroll-height ceiling (already solved) and the `translateY` magnitude (degrades precision,
> breaks nothing); the reference's `offsetWidth` approach to line width (`contain: size` makes row
> `offsetWidth` useless here). `monospaceAssumptionsAreValid` is also not done — the font-load and
> DPR invalidation that landed covers the case it guards, so it would be a second detector for the
> same staleness.
>
> **Exit criterion, since closed.** It asks for `virtualizedTextView.browser.test.ts` green on caret
> placement, selection rects and hit tests under CSS transform. That file was gated behind a real
> `Highlight` constructor which no project provided, so it had not run in a long time. Commit
> `2c90a8b` gives the editor package a real browser project and repairs the two assertions that had
> rotted against it; the suite now runs 1123 tests with none skipped. Milestone 3's forced-layout
> count remains asserted under happy-dom against a stubbed layout.


---

## Milestone 5 — Layout, scroll anchoring, and surface hosting ✅

`effort L` · `risk high` · 7 findings

**Why here.** Scroll anchoring is the one true foundation in the widget slice and must land in fixedRowVirtualizer.setOptions, not in blockSurfaceController, or the measure-and-correct convergence work built on top is thrown away — hence both are here, in that order. The layout index suffix-invalidation comes with them because applyMeasuredEditorBlockSizes currently forces a full index rebuild per ResizeObserver tick. The render phase split follows the deferred width pass from milestone 4 so it can absorb it and the shared RowReadingContext, and it establishes the read-then-write contract that the zone/overlay hosting work then obeys. Overlay reserved widths land here so the sticky-scroll header in milestone 9 has a width to respect.

**Exit criteria.** Inserting or measuring a 100px block above the viewport, and folding a region above the viewport, leave the first visible row unchanged (browser test on fixedRowVirtualizer); a settling block re-sums the height index only from the changed row; hidden-character marker computation is a distinct pass from the DOM write and the plugin render contract is documented; block rows accept an ordinal and an incremental add/remove path that does not re-run every provider; an opt-in overlay-hosted block surface keeps focus, scroll position and IME state across scroll recycling; the find widget no longer underlaps the minimap and z-index values come from one documented scale.

- [x] **Preserve the visual anchor when content height changes above the viewport**  
  `medium` `S` `missing` `decorations-widgets`
- [x] **Sparse, lazily-summed layout index instead of a dense per-line prefix array**  
  `medium` `M` `partial` `rendering`
- [x] **Measure-back-and-correct loop with scroll-position compensation for variable-height rows**  
  `high` `M` `partial` `rendering`
- [x] **Type-enforced read/write phase separation (RenderingContext vs RestrictedRenderingContext)**  
  `high` `L` `missing` `rendering`
- [x] **View zone knobs we lack: ordinal tiebreak, before-first-line, render-in-hidden-areas, margin twin, min scroll width, suppressMouseDown**  
  `medium` `M` `partial` `decorations-widgets`
- [x] **ZoneWidget: view zone reserves whitespace, the DOM lives in a stable overlay widget driven by onDomNodeTop — our block-row DOM is destroyed on scroll recycle**  
  `high` `M` `partial` `decorations-widgets`
- [x] **Overlay widgets: declarative corner anchoring with stacking, and widget min-width feeding the editor's scroll width**  
  `medium` `M` `partial` `decorations-widgets`

> **Deviations, recorded.** Skipped per the Verifiers: the RenderingContext/RestrictedRenderingContext
> class hierarchy (rows are their own layout boundary here, so the two-pass split plus a documented
> contract buys what the type split would); the render-into-flow-and-converge architecture (our
> virtualizer already converges through the ResizeObserver path); the zero-per-line index
> representation (`view.model.rows` is already dense, so only the suffix watermark applies); five of
> the six view-zone knobs (only `ordinal` and the incremental add/remove path were worth it —
> `suppressMouseDown` is moot, there is no mousedown handler on the block container); and declarative
> corner anchoring with stackOrdinal (one find widget does not need a widget-position abstraction).
>
> Scroll anchoring landed in `fixedRowVirtualizer.updateOptions` and NOT in `blockSurfaceController`,
> as the plan requires. The controller needed no change at all: `applyMeasuredEditorBlockSizes` only
> rewrites heights on existing rows, so a settle lands in the equal-row-count branch. Adding
> compensation there as the prose sketched would have double-applied the delta.
>
> **A real bug the review caught in this milestone's own work.** Anchoring gave up whenever the next
> layout carried no height index, so withdrawing the last variable-height row above the viewport —
> the case that needs it most — jumped the reader by that row's height. A layout with no index is a
> uniform document, not an unanchorable one; it now anchors through the base-height arithmetic.
>
> **A limit that cannot be fixed at this layer.** Row heights are the only evidence the virtualizer
> has, so a run of rows identical in height to the ones it displaced is invisible: prepending five
> plain lines to a document of plain lines reads exactly like appending five to the end, and the
> anchor stays put. Folds of uniform text above the viewport are unanchored for the same reason.
> Distinguishing them needs the caller to say where it edited. Stated in the source at
> `anchorRowInNextLayout` so a reader does not assume it is covered.
>
> **Ships without an in-repo consumer.** `hosting: 'hoisted'` on a block surface is covered end to
> end — a surface keeps focus, draft text and scroll position across scroll recycling and across a
> provider re-resolution — but nothing in this repo or its example app sets it.


---

## Milestone 6 — Decoration model

`effort L` · `risk high` · 4 findings

**Why here.** Consolidates the three edit-tracking mechanisms we already have into one identified, owned, stickiness-configurable store, and only then widens the options type so one decoration can fan out to several surfaces — doing the fan-out first means retrofitting identity and rewriting it. The model-side and view-side statements of this work are the same job seen from two ends and are scheduled adjacently for that reason. The visible-window index for highlight painting belongs here because it is the same viewport-query partitioning, and it also serves LSP diagnostics and document highlights, not just find (which consumes it in milestone 12).

**Exit criteria.** A single decoration store with per-decoration id/owner/priority and per-endpoint stickiness bias, with diagnosticProjection and occurrenceHighlights migrated off their hand-rolled tracking and their existing tests green; one registered decoration drives text, gutter and minimap surfaces from one object with affects* flags on the change signal; per-row highlight painting binary-seeks a sorted range set instead of scanning all ranges per mounted row, verified by a browser benchmark with 20k ranges. Overview ruler explicitly out of scope.

> Ordering in this milestone rests partly on un-analyzed domains (text-model).

- [ ] **Edit-tracked decoration identity: interval tree + 4-way stickiness + collapseOnReplaceEdit**  
  `high` `L` `partial` `decorations-widgets`
- [ ] **Decorations as an interval tree with lazy subtree deltas and a four-way stickiness taxonomy**  
  `medium` `L` `partial` `text-model`
- [ ] **One decoration object, many surfaces — text, glyph margin, line margin, minimap, overview ruler, injected text**  
  `high` `L` `partial` `decorations-widgets`
- [ ] **Highlight painting is O(mounted rows × total matches) per frame, with no visible-window index**  
  `high` `M` `missing` `find-replace`


---

## Milestone 7 — Word, grapheme, and vertical motion

`effort L` · `risk medium` · 7 findings

**Why here.** Line-scoping the classifier goes first because it re-signatures exactly the functions that the stop-policy, word-part and grapheme findings rewrite; doing any of them against the materialized full document means writing them twice. Word-navigation types then unlock the word-part clamp, which is literally Math.max/min against the two candidate policies. Grapheme movement and the grapheme-aware backspace are one piece of work (both rewrite backspaceRangeForSelection), and soft-tab backspace branches into the same function, so all three are co-scheduled to avoid merge conflicts. Home/End and vertical motion close out navigationTargets.ts while it is already open.

**Exit criteria.** No word or character operation materializes full document text (readRange-based NavigationTargetContext, all inputSelectionController call sites converted); WordStart/WordEnd/Accessibility command ids exist and word motion cannot cross a newline; deleteWordPartLeft/Right land; caret movement and Backspace agree with Intl.Segmenter on ZWJ sequences and skin-tone modifiers; Backspace inside indentation removes one tab stop; arrow-down from a selection collapses to the correct edge and Home escalates first-non-blank → line start. textRanges.test.ts, wordPart.test.ts and the browser wrap tests green.

> Ordering in this milestone rests partly on un-analyzed domains (input-a11y).

- [ ] **Word/character operations are line-scoped with a Uint8Array classifier; ours materialize the whole document and run regexes per character**  
  `medium` `M` `missing` `cursor-selection`
- [ ] **Word navigation has three distinct stop policies; ours is a fourth that matches none**  
  `high` `M` `partial` `cursor-selection`
- [ ] **Word-part (subword) motion clamped between the word-start and word-end candidates**  
  `medium` `S` `partial` `cursor-selection`
- [ ] **Grapheme-cluster movement and emoji-aware backspace (move ≠ delete granularity)**  
  `high` `M` `missing` `cursor-selection`
- [ ] **Backspace is code-point aware but not grapheme-cluster aware**  
  `medium` `S` `partial` `input-a11y`
- [ ] **Atomic soft-tab movement and tab-stop-aware backspace inside indentation**  
  `high` `M` `missing` `cursor-selection`
- [ ] **Vertical motion and Home/End from selection edges, wrapped lines, and first-non-blank**  
  `medium` `M` `partial` `cursor-selection`


---

## Milestone 8 — Multi-cursor, mouse, and clipboard

`effort XL` · `risk high` · 8 findings

**Why here.** The selection merge rules are the highest-blast-radius change in the cursor slice and they introduce the lastAddedIndex that Cmd+D needs, so they lead. Mouse dispatch, column selection and drag-to-move all collide in the same 30 lines of handleMouseDown, so they are done in one pass rather than three rebases. Clipboard metadata, cut and empty-selection line copy join them because multi-cursor copy/paste is only meaningful once the selection set has stable ordering and identity, and because handleCopy/handlePaste sit beside the mouse handlers in the same controller.

**Exit criteria.** Touching-but-not-overlapping selections no longer merge, direction and goal column survive normalization, and index 0 is the true primary (selections.test.ts extended); Cmd+D from a caret is whole-word/case-sensitive and searches from the last-added selection; shift-click extends and double/triple-click drag keeps word/line granularity; alt+drag and the keyboard column-select commands produce a rectangle that is cleared on edit; expand-selection works in a file with no grammar; three-cursor copy then three-cursor paste round-trips per selection; Cmd+X works and caret-only copy takes the line; dragging a selection moves it and external drops land at the drop caret.

> Ordering in this milestone rests partly on un-analyzed domains (input-a11y).

- [ ] **Multi-cursor merge rules: touching vs overlapping, direction preservation, and last-added priority**  
  `high` `S` `partial` `cursor-selection`
- [ ] **Cmd+D from a collapsed caret is whole-word and case-sensitive, and searches from the last-added selection**  
  `high` `S` `partial` `cursor-selection`
- [ ] **Mouse dispatch matrix: shift-click extend, and word/line-granularity drag via a Range-valued anchor**  
  `high` `M` `missing` `cursor-selection`
- [ ] **Column (box) selection: a persistent from/to visual-column rectangle, driven by mouse and keyboard**  
  `high` `L` `missing` `cursor-selection`
- [ ] **Smart-select as a ranked ladder of ranges, not a single tree walk**  
  `medium` `M` `partial` `cursor-selection`
- [ ] **Clipboard carries no editor metadata, so multi-cursor copy/paste degenerates into one blob**  
  `high` `M` `missing` `input-a11y`
- [ ] **No cut handler at all, and no empty-selection line copy/cut**  
  `high` `M` `missing` `input-a11y`
- [ ] **Drag-and-drop of text is non-functional: no dragover, no dragstart, no move semantics**  
  `high` `M` `partial` `input-a11y`


---

## Milestone 9 — Folding model and sticky scroll

`effort L` · `risk medium` · 5 findings

**Why here.** Anchor-keying the collapse store is a net deletion that every other folding item writes into, so it goes first — fold-by-level, fold-all and the auto-unfold guard would all be rewritten otherwise, and landing it first also makes the syntax-vs-indentation provider swap invisible to the user instead of silently dropping collapse state. Fold-by-level computes the parent chain, and the indentation provider guarantees a fold model even with no grammar, which together are exactly what sticky scroll needs; sticky scroll therefore closes the milestone as its visible payoff, using the overlay reserved widths from milestone 5.

**Exit criteria.** A failing-first test proving collapse survives an edit above the fold now passes, and the offset-keyed remap machinery is deleted; an unparsed file folds by indentation with #region markers honoured, and the syntax provider taking over does not drop collapse state; the caret landing in hidden lines unfolds and selections clamp across them; foldAll/foldLevel N/foldRecursively/manual-fold commands and keybindings exist with a single nesting representation; the sticky header renders enclosing scopes through the normal row path in a sticky layer, pushes out correctly, and respects the minimap's reserved width.

- [ ] **Fold collapse state is keyed by content offsets, so any earlier edit silently expands folds**  
  `high` `M` `missing` `folding-brackets`
- [ ] **Two range providers (syntax + indentation fallback), with #region markers and off-side rule**  
  `high` `M` `missing` `folding-brackets`
- [ ] **Auto-unfold when the caret lands inside hidden lines, and selection clamping across them**  
  `high` `S` `partial` `folding-brackets`
- [ ] **Fold by level, fold recursively, fold all regions, manual folds from selection**  
  `medium` `M` `missing` `folding-brackets`
- [ ] **Sticky scroll: enclosing-scope header from the fold/outline model, with a push-out transition**  
  `high` `L` `missing` `rendering`


---

## Milestone 10 — Language configuration and indentation

`effort L` · `risk medium` · 5 findings

**Why here.** The consolidation point for language knowledge currently split across autoClose.ts, editActions.ts and the tree-sitter fold queries; onEnterRules, indentationRules and wordPattern are consumed by reindent, continue-list, linked editing and format-on-type, and reindent in particular has literally nothing to write before those rules exist. Document-wide indentation guessing lands with them because the same milestone is already replacing the per-line tab-vs-space inference. Comment tokens at the caret's embedded language is orthogonal plumbing (languageIdAt) but shares editActions.ts, so it rides along.

**Exit criteria.** One registry holds pairs, comment tokens, onEnterRules, indentationRules and wordPattern, registrable from the public API, with lineBreakIndent replaced by the three-tier onEnter and indentation.test.ts green; opening a 2-space file in a 4-space editor adopts the file's unit; reindent lines/selection is a command that masks brackets inside strings and comments; Enter continues and terminates markdown/list items and renumbers following ordered items, guarded to collapsed carets; toggling a comment inside an embedded language block uses that language's tokens at a normalized insertion column.

> Ordering in this milestone rests partly on un-analyzed domains (text-model).

- [ ] **Language configuration as declarative data: onEnterRules and indentationRules**  
  `high` `M` `partial` `folding-brackets`
- [ ] **Model-level indentation guessing (tabSize + insertSpaces) with an alignment-vs-indentation heuristic**  
  `medium` `S` `partial` `text-model`
- [ ] **Reindent lines / reindent selection driven by indentation rules**  
  `medium` `M` `missing` `folding-brackets`
- [ ] **Continue-list on Enter, including empty-item termination and renumbering of following items**  
  `medium` `S` `missing` `folding-brackets`
- [ ] **Comment tokens resolved at the caret's embedded language, plus insertion-point column normalization**  
  `medium` `S` `partial` `folding-brackets`


---

## Milestone 11 — Color registry, brackets, and auto-close

`effort L` · `risk medium` · 6 findings

**Why here.** The color registry has to land before plugin packages start contributing colors (merge and equality iterate known-key tables today, so a contributed color would be invisible), and the scope trie should be seeded from registered ids so theme.ts's public shape is only touched once — hence both here, registry first. Bracket-pair colorization is the first consumer of the registry's derived colors, and the min-indentation guide refinement is an independent ten-line win alongside it. Token-gated auto-close is the mechanism that the multi-cursor-surround finding consumes as its isOK gate, so it precedes it; linked editing closes the milestone using the wordPattern from milestone 10.

**Exit criteria.** Colors are registered ids with per-theme-type defaults and Darken/Lighten/Transparent/OneOf derivations, written as generated CSS rules through the existing refcounted stylesheet rather than inline styles, with merge/equality respecting contributed ids and one plugin package migrated off hardcoded colors; scope resolution is a memoized trie with inheritance that reproduces current output for every scope the two tables covered; a quote typed inside a string or comment does not auto-close, surround works with multiple selections, renaming a JSX tag updates its partner in one undo unit, and guides use per-pair min indentation with bracket levels behind a capped, opt-in colorization.

- [ ] **Extensible color registry with per-theme-type defaults and derived colors**  
  `high` `M` `partial` `api-perf-infra`
- [ ] **Theme scope matching should be a trie with inheritance, not exact-match plus first-segment fallback**  
  `high` `M` `partial` `api-perf-infra`
- [ ] **Auto-close gated on token type, with the 'neutral character' tokenizer probe for quotes**  
  `high` `M` `partial` `folding-brackets`
- [ ] **Auto-closing: token-aware quote suppression via a 'neutral character' probe, and multi-cursor surround**  
  `medium` `M` `partial` `cursor-selection`
- [ ] **Linked editing: mirrored ranges kept in sync with minimal prefix/suffix-trimmed edits**  
  `high` `M` `missing` `folding-brackets`
- [ ] **Bracket-pair guides and colorization derived from the AST, including min-indentation per pair**  
  `high` `L` `partial` `folding-brackets`


---

## Milestone 12 — Find engine

`effort L` · `risk medium` · 7 findings

**Why here.** Everything in the find slice hangs off the text-source API change: writing the incremental from-cursor searcher, the misaligned-chunk dual run, or the deferred re-search against a materialized string means writing them twice. The controller-level assertFindState harness is written first inside this milestone (it needs no prerequisite and is the only thing that can see the scope, zero-width and match-limit bugs), then the source refactor, then find-in-selection, which introduces the anchor plumbing on EditorFindHost that the debounce/incremental-repair work requires — debouncing before anchor-tracked matches would paint highlights at stale offsets and is a regression. Minimap surfacing lands last, registering through the decoration fan-out from milestone 6.

**Exit criteria.** findMatches reads through a {length, readRange, lineStartsView} source with a single-line loop and no 'm' flag on the single-line path, and the whole find suite runs twice — once over a plain string, once over a deliberately misaligned piece tree — driven by an assertFindState controller harness; Replace All in selection cannot rewrite outside the scope, and the scope survives a replace as anchors; Find Next past the match limit reaches the next match rather than the top of the file; Replace One performs one scan; re-search is scheduled with maxDelayMs and pending matches stay offset-correct while typing; matches appear on the minimap, row-merged above the coalescing threshold.

- [ ] **Search materializes the entire document as one string; neither reference ever does**  
  `high` `L` `missing` `find-replace`
- [ ] **Monaco runs every find test twice, the second time over a piece tree with deliberately misaligned chunk boundaries**  
  `medium` `S` `missing` `find-replace`
- [ ] **Find-in-selection scope is recomputed from the live selection, so it is destroyed by the first replace and silently widens to the whole document**  
  `high` `M` `missing` `find-replace`
- [ ] **Find Next past the match limit jumps to the top of the file instead of to the next match**  
  `high` `M` `missing` `find-replace`
- [ ] **Replace One re-scans the whole document with capture groups enabled just to replace one match**  
  `medium` `S` `missing` `find-replace`
- [ ] **Every content change triggers a synchronous full re-search; both references debounce it and repair incrementally**  
  `high` `L` `missing` `find-replace`
- [ ] **Find matches are not surfaced on the minimap or scrollbar, and Monaco's >1000-match merge is the reason that is not trivial**  
  `medium` `M` `missing` `find-replace`


---

## Milestone 13 — Completion pipeline

`effort L` · `risk medium` · 5 findings

**Why here.** The feature registry lands first as the dispatch seam (a second multi-valued channel, not a change to registerFeature), then the insert/replace and stale-offset fix, which must precede the longer-lived session because a session that survives more keystrokes makes the request-time offset race strictly worse. Session lifetime is the gate: today the widget hides on every selection update, so incremental re-filtering has no previous array to extend and commit characters would almost never fire. Fuzzy scoring with match positions and commit characters therefore follow it, in that order.

**Exit criteria.** registerProvider(token, selector, provider) supports multiple providers with a priority ordering while existing capability tokens keep throw-on-duplicate; accepting a suggestion after further typing applies against the current caret via overwriteBefore/overwriteAfter and honours InsertReplaceEdit; the widget survives backspace and typing, re-requests only when isIncomplete, and cancels on Monaco's conditions; labels render highlighted match runs from a bounded DP scorer with incremental re-filter; a commit character accepts the focused item and still inserts the character in the same undo entry, behind an option, with a test asserting the character is not lost.

- [ ] **LanguageFeatureRegistry: score-based, multi-provider language feature dispatch**  
  `high` `L` `partial` `language-features`
- [ ] **Completion insert-vs-replace ranges: we silently drop the replace range**  
  `high` `S` `partial` `language-features`
- [ ] **Incomplete completion lists: per-provider re-query with item reuse, instead of hide-and-refetch**  
  `high` `M` `missing` `language-features`
- [ ] **Suggest filtering: bounded fuzzy DP scoring with match positions, incremental re-filter, and filterText/label split**  
  `high` `L` `partial` `language-features`
- [ ] **Commit characters: accepting the focused suggestion on the next typed character**  
  `medium` `S` `partial` `language-features`


---

## Milestone 14 — Formatting, snippets, and code actions

`effort L` · `risk high` · 5 findings

**Why here.** Formatter minimization is the best value-per-effort item in the language slice and must precede any on-type formatting, since without it every keystroke's response is a line-sized replace that resets anchors, decorations and folds. On-type formatting is then implemented as the local, synchronous reindent route driven by the indentation rules from milestone 10 — the highest-regression-risk item here, so it lands with the minimization safety net already in place. Snippet mirrors and indentation normalization, and code actions (whose prerequisites — workspace-edit applier, diagnostics, floating widget — all already exist), fill out the milestone; semantic tokens rank last of everything and sit here as an optional overlay on the milestone-11 trie.

**Exit criteria.** A whole-document formatter response that changes one line applies as one small edit (regression test), with adjacent-edit merging, no-op dropping and a size cap; typing a closing brace dedents the line locally and synchronously, gated on trigger characters and cancelled by edits before the caret; snippet placeholder mirrors update live, server snippets are indentation-normalized on insert, and transforms/choices parse; code actions appear from a 250ms oracle debounced on both cursor and diagnostic changes, filter by dotted-prefix kind, order isPreferred first, resolve command-only actions, and bind editor.action.autoFix; semantic tokens, if shipped, layer over tree-sitter rather than replacing it.

- [ ] **Re-diffing formatter output into minimal edits before applying it**  
  `high` `S` `missing` `language-features`
- [ ] **Format-on-type, gated by provider trigger characters and cancelled by any edit before the caret**  
  `medium` `M` `missing` `language-features`
- [ ] **Snippet engine: placeholder mirrors, transforms with regex + case-shorthands, choices, and indentation normalization**  
  `high` `L` `partial` `language-features`
- [ ] **Code actions: hierarchical kind filtering, isPreferred ordering, and 'auto fix'**  
  `high` `M` `missing` `language-features`
- [ ] **Semantic tokens: delta protocol with in-place Uint32Array splicing**  
  `medium` `L` `missing` `language-features`


---

## Milestone 15 — Injected text and anchored widgets

`effort L` · `risk high` · 4 findings

**Why here.** The zero-width anchor guard in inlineMap is the single line blocking phantom content, and it also introduces the new non-plain-text inline chunk kind that arbitrary-DOM replacements need, so those two are adjacent. Ghost text is the payoff: we already own the expensive half (anchored, wrap-aware injected text the cursor arithmetic understands), and its prerequisite is conditional on whether a zero-width spec survives inlineMap's dedup — resolving that is exactly the injected-text work, so it is scheduled before. The shared anchoredSurface helper for the four LSP controllers lands here too, on the milestone-3 disposables and the milestone-5 layer conventions.

**Exit criteria.** A zero-width anchored injection renders as its own inline chunk with per-side cursor stops and attached payload reaching the hit test, with inlay hints demonstrated end to end and the markdown WYSIWYG tests still green; a single-line range can be replaced by a mounted DOM node whose measured width feeds geometry and whose mount survives row recycling (multi-line collapsed marks explicitly out of scope); the four LSP floating controllers share one flip/clamp/re-anchor helper over CSS anchor positioning; ghost text renders from a computeGhostText of an arbitrary text edit with accept and partial-accept commands and defined Tab precedence against snippets.

- [ ] **Injected text as a first-class concept: phantom content at a zero-width anchor, with cursor stops and hit-test payload**  
  `high` `L` `partial` `decorations-widgets`
- [ ] **Replacing a text range with an arbitrary DOM node, and collapsed marks spanning multiple lines**  
  `medium` `L` `missing` `decorations-widgets`
- [ ] **Content widgets: an editor-managed layer for position-anchored floating UI with declarative fit preferences**  
  `high` `L` `missing` `decorations-widgets`
- [ ] **Inline completions / ghost text: deriving renderable inline parts from an arbitrary text edit**  
  `medium` `M` `partial` `language-features`


---

## Milestone 16 — Input pipeline and accessibility

`effort XL` · `risk high` · 7 findings

**Why here.** Left for last because it is the most self-contained cluster and because several members want earlier foundations: the paged screen-reader window and IME both rewrite how the hidden textarea's value and position are managed, so the diff-based input deduction (which stops clearing the value) has to land first or it invalidates them; the aria-live channel precedes tab-focus mode, which announces through it; unicode highlighting builds on the hidden-character overlay and the option registry; and copy-with-syntax-highlighting consumes the theme trie from milestone 11. Nothing else in the plan depends on this milestone, so it can also be pulled forward if accessibility is needed sooner.

**Exit criteria.** Input is deduced by diffing textarea state rather than racing keydown against input (no double-insert or dropped characters under autocorrect, dictation or dead keys), with inputState-style unit tests; the candidate window appears under the caret and composition text is visible inline; the hidden textarea carries a paged content window with the caret relationship so a screen reader reads lines and selections; fold, multi-cursor, occurrence and find-wrap actions announce through an aria-live channel; Ctrl+M toggles tab-focus and Tab then moves focus (WCAG 2.1.2); confusable and invisible characters are highlighted with per-language allowances behind options; copy emits styled text/html under a size cap and the paste path exposes the full DataTransfer to registered providers.

> Ordering in this milestone rests partly on un-analyzed domains (input-a11y).

- [ ] **Diff-based input deduction as the robust fallback, instead of a keydown timing race**  
  `high` `M` `partial` `input-a11y`
- [ ] **In-progress IME composition is invisible and the candidate window lands at the viewport corner**  
  `high` `L` `missing` `input-a11y`
- [ ] **Screen readers get an empty 1x1 textarea: no paged content window, no caret relationship**  
  `high` `L` `missing` `input-a11y`
- [ ] **No aria-live announcement channel for editor actions**  
  `medium` `S` `missing` `input-a11y`
- [ ] **Tab-focus mode: an accessibility escape hatch from the Tab key**  
  `medium` `S` `missing` `input-a11y`
- [ ] **Unicode ambiguous/invisible character highlighting**  
  `high` `L` `missing` `input-a11y`
- [ ] **Copy with syntax highlighting, and the paste-provider (paste-as) pipeline**  
  `medium` `XL` `missing` `input-a11y`


---

## Sequencing notes

Scope: the 99 titles are exactly the findings in docs/parity-findings.json whose ourStatus is not 'present' — the two excluded are 'Refcounted dynamic CSS rule factory...' and 'Randomized differential testing of the range store...'. Two included titles ('EOL detection, normalization, and BOM stripping...' in M2, 'Case-insensitive plain search folds the whole haystack...' in M1) already landed in the working tree; they are scheduled as verify-and-add-the-missing-regression-test items, not re-implementations, and the surrounding items in those milestones build directly on them.

Hard prerequisite edges and where they forced the order:
- CharacterMapping → lazy per-column offsets (M4, in that order): fill-on-demand sentinels built on the object array would be rewritten by the typed-array conversion.
- Font measurement → key-column anchoring, deferred line width, whitespace glyph (all M4, after it); the option registry (M3) → font measurement, because the 'metrics changed, relayout everything' fan-out is the registry's recompute.
- Preserve the visual anchor → measure-back-and-correct (M5): implementing anchoring inside blockSurfaceController first would be thrown away; both entry points funnel through fixedRowVirtualizer.setOptions.
- Edit-tracked decoration identity (and its model-side twin) → one decoration, many surfaces (M6): widening the options type before identity exists means rewriting the fan-out.
- Line-scoped word/character operations → word stop policies → word-part clamp (M7, strict chain); grapheme movement and grapheme-aware backspace are one edit to backspaceRangeForSelection and soft-tab backspace branches into the same function, so all three are adjacent.
- Multi-cursor merge rules → Cmd+D (M8): lastAddedIndex lives on the selection set.
- Fold anchor-keying → auto-unfold, fold-by-level, and (transitively) sticky scroll (M9); the indentation provider and fold-by-level both precede sticky scroll because they supply the ancestor chain and the no-grammar fallback.
- Language configuration → reindent, continue-list, format-on-type (M10 → M14); reindent has nothing to write before indentationRules exist.
- Token-gated auto-close → multi-cursor surround / quote suppression (M11, in that order).
- Find text source → incremental find-next, Replace One, the misaligned-chunk dual run and the deferred re-search; find-in-selection → debounce, because the anchor plumbing it adds to EditorFindHost is what keeps deferred matches offset-correct (M12, internal order 70 → harness/dual-run → scope → next/replace → debounce → minimap; write the assertFindState harness half of the dual-run finding before touching the source API, as the behavioural net).
- Incomplete completion lists → commit characters and incremental re-filter (M13); insert/replace stale-offset fix scheduled before the longer-lived session that makes it worse.
- Injected text zero-width anchor → ghost text (M15); the new inline chunk kind is shared with arbitrary-DOM replacement, hence adjacency.
- Diff-based input deduction → paged screen-reader window and IME (M16), all three own the hidden textarea's value/position; aria-live → tab-focus mode.

Foundations deliberately placed early despite cost: DisposableStore, operation batching, the emitter and the option registry (M3), font metrics and CharacterMapping (M4), scroll anchoring and the render phase split (M5), the decoration store (M6). Each has three or more dependents that would otherwise grow per-feature versions to be deleted later.

Deliberate de-scopings carried into the milestones (from the per-finding analysis, so the executing agent does not re-expand them): no red-black interval tree (piece-table anchors plus a per-endpoint bias pair spans the four stickiness values); no overview ruler; no multi-line collapsed marks; no RenderingContext class hierarchy (two-pass split plus a documented contract); no Monaco placement loop for floating widgets (CSS anchor positioning already does it); no _largeReplaceAll; no ColumnRange machinery for ghost text; scroll-height ceiling and render truncation are already solved, so long-line work is the text-node cap only; declarative corner anchoring is reduced to exposing reserved widths plus a z-index scale; three of the six view-zone knobs are already satisfied.

## Parallelizable work

Milestones 1–3 must run in sequence and alone: M1 is the harness shakedown, and M2/M3 change the buffer, the notification order and the options surface that everything else observes. After M3 lands, four tracks are largely disjoint in files and can run concurrently in separate worktrees:

- Rendering track: M4 → M5 → M6 (strictly sequential within itself; packages/editor/src/virtualization plus editor/rangeDecorations, displayProjectionRegistry).
- Cursor/input track: M7 → M8 (textRanges, navigationTargets, selections, inputSelectionController, mouseSelection). Touches inputSelectionController, which M16 also touches — do not run M8 and M16 concurrently.
- Language track: M9 → M10 → M11 (foldState/folds/foldMap, languageConfiguration, indentation, autoClose, tree-sitter, theme). M9's sticky-scroll item wants M5's reserved overlay widths, so start M9 after M5 or accept a follow-up to offset the header.
- Find track: M12 (packages/find plus two host methods). Independent of everything except M1; its minimap item prefers M6's fan-out, so either run M12 after M6 or land the bespoke host method knowing it is replaced later.

M13 → M14 (language features, packages/lsp-plugin) is a fifth track that can start any time after M3 and only weakly touches the others — except that M14's format-on-type consumes M10's indentation rules, so schedule it after M10.

M15 must not run concurrently with M4/M5 (it edits inlineMap, displayTransforms and virtualizedTextViewRows, and packages/editor/test/inlineReplacement*.test.ts are already being changed in the working tree — coordinate before starting). M16 is the most isolable large chunk and can be pulled forward to any point after M3 if accessibility is needed sooner, provided its last item waits for M11's theme trie and it does not overlap M8 in inputSelectionController.
