# BiDi geometry — execution plan

> **Status: Tier A M1-M5 complete; Tier B M6-M7 open, reconciled 2026-08-22.**
> This is the only active standalone Editor executable plan. It may run in the
> independent lane defined by
> [Platform's canonical cross-project roadmap](../../platform/PLAN.md); no
> environment work or Platform compatibility layer is required.

What this is: the first scoping of bidirectional-text geometry in this editor. The Monaco/CodeMirror
parity programme never carried it as a finding — it surfaced in milestone 2 as "the real finding
hiding behind" the `mightContainRTL` item, which closed `[~]` because a flag proving you may skip
bidi work is worthless when there is no bidi work to skip. The sole marker in the tree is the TODO
at `packages/editor/src/virtualization/virtualizedTextViewGeometry.ts:327-329`.

Who it is for: an agent executing this plan top-down, and a reviewer deciding whether to fund it at
all. **The most valuable output of this document is the sizing and the sequencing, not the design.**
Read "What happens today" and "The two ceilings" before anything else; they contain the decision.

- Reference checkouts (read-only, gitignored): `references/codemirror5`, `references/vscode`
- Execution protocol: the self-contained Working protocol and Rules below
- **This plan has been through an adversarial review and then an independent verification pass, both
  with real measurements.** Read the **Review** section at the end before executing anything.
  Several exit criteria in the first draft were unreachable; they were replaced and the milestones
  reordered, and the verification pass then found that one of those replacements — M4's clamp — did
  not fire on the case it was written for. That is fixed. The Review section says what is settled,
  what changed twice, and where the remaining sharp edges are.

> **Provenance correction.** The completed parity programme's milestone-2 `[~]` note cited the bidi
> TODO at `virtualizedTextViewGeometry.ts:161`. The lazy-plan work in milestone 4 moved it; it is now at
> `:327-329`, attached to `offsetToX` at `:322`.

> **Renumbering, since the review reordered execution.** The milestone that refuses to window a bidi
> line was M2 in the first draft and is now M5 — the measurements below show it cannot ship until
> the row is clickable without a whole-row boundary sweep. Everything between shifted down one: old
> M3 → **M2**, old M4 → **M3**, old M5 → **M4**. M1, M6 and M7 keep their numbers.

## Working protocol

1. Work the topmost incomplete milestone and, within it, the topmost unchecked item.
2. Before implementation, confirm against current source that the gap and cited seam still exist.
3. Adapt reference ideas to this editor's CSS Highlight API and fixed-row virtualization; do not
   copy another editor's DOM strategy.
4. Every implemented item gets a regression test in the package's existing Vitest setup.
5. Update this plan's checkbox immediately after each item lands; do not batch status updates.
6. A milestone is complete only after its scoped tests, typecheck, and lint pass.
7. Do not mark work complete without recording the passing commands.

## Rules

- Stay on the current task branch and never modify `references/`.
- Do not revert, reformat, or clean up unrelated work; format only changed files.
- Mark a false or architectural mismatch `[~]` with a one-line reason instead of forcing it in.
- Mark a blocker `[!]` inline and continue only with independent work.
- If a dependency is wrong, record the evidence and reorder instead of forcing the sequence.

## Status key

`[ ]` not started · `[x]` done, tested, committed · `[~]` deliberately skipped (reason required)
· `[!]` blocked (blocker required)

## Measurement conditions

Every number in this document was measured in headless Chromium via Playwright — the same engine the
`browser` vitest project runs — at `font: 14px monospace`, `tab-size: 4`, `white-space: pre`, in a
block-level row with the default LTR paragraph direction. Advances come out at 8.39–8.42px. **None
of these numbers may be hardcoded into a test.** They are here to justify decisions; the tests
compare our answer to the browser's answer on the same machine, for the reason given in Risks.

The reference corpus used throughout:

| name | text |
|---|---|
| `pureHebrew` | `אבגדהוזחט` |
| `pureArabic` | `مرحبا بالعالم` |
| `mixed` | `let x = שלום world` |
| `nested` | `אבג 123 דהו` (level-2 digits inside an RTL run) |
| `tabRtl` | `\tאבג דהו` |
| `override` | `abc<U+202E>defghi` |
| `latin` | `const value = 42` (control) |

**Two supplementary lines, used by exactly one criterion and by nothing else.** The seven above are
"the corpus"; every criterion that says "all seven lines" or "every corpus line" means those seven
and is unaffected by these. The verification pass found that M2's element-boundary rule — the item
this plan itself calls the most likely to be under-budgeted — has no line that reaches it: a
collapsed range at an element boundary returns zero client rects, and control units and widget units
carry `node: null`, but `override`'s U+202E is not a C1 control, `tabRtl`'s tab is plain text after
M1, and none of the seven holds a C1 control or an inline widget. So:

| name | text |
|---|---|
| `controlRtl` | `אבג<U+0085>דהו` (a C1 control, which `controlCharacterInfo` matches, inside an RTL run) |
| `widgetRtl` | `אבג דהו` carrying one inline widget replacement, mounted through the same inline-mapping path the markdown view uses |

---

## What the editor does with RTL text today

**It renders it correctly and then draws everything else in the wrong place.** That distinction
matters, so state it precisely: the glyphs are right, the furniture is wrong.

There is no bidi code, no `dir` attribute, no `direction:`/`unicode-bidi` CSS in `packages/`
(verified by grep over `*.ts` and `*.css`). Each row is its own block element, so the browser runs
the UBA per row with an LTR paragraph direction and paints the reordering itself. Our chunk spans
and text-node splits do not disturb that — measured: splitting `אבג 123 דהו` across four text nodes
moves no glyph by more than 0.03px. Every decoration painted through the CSS Custom Highlight API —
token colours, find matches, occurrences, brackets, diagnostics, merge conflicts — is therefore
**already correct**, because it goes in as a DOM `StaticRange`
(`virtualizedTextViewGeometry.ts:469`, `virtualizedTextViewHighlights.ts:280`) and the browser
splits it into visual rectangles.

Everything the editor positions by hand is wrong, and it is wrong at one root.
`appendUnitPlan` (`virtualizedTextViewGeometry.ts:912`) records a measured unit's logical start as
`UNIT_LEFT` and its logical end as `UNIT_RIGHT` (`:69-70`), and `resolvedUnitEdge` (`:973`) reads
`UNIT_LEFT` as `rect.left` and `UNIT_RIGHT` as `rect.left + rect.width`. Those constants name
**visual** sides of a measured rect and are used as **logical** edges. Inside an RTL run those are
swapped, so `offsetToX` returns each character's visual-left edge, which is that character's logical
*end*.

Two consequences, both measured:

- **Every caret on an RTL run is drawn one glyph off**, in the direction of the run.
- **The offset→x map collapses two offsets that are a whole glyph apart.** On `pureHebrew`,
  `offsetToX(7)` returns 8.39 and `offsetToX(9)` returns 8.41 — 0.02px apart, one boundary's worth
  of screen position shared by two offsets that are two glyphs apart in the text. Both land on the
  true position of boundary 8. The same collapse happens on `pureArabic` (11↔13), `nested` (9↔11),
  `tabRtl` (6↔8) and `override` (8↔10).

  > The first draft glossed this as "the same x as the *logical start* of the second-to-last
  > character". That is wrong and the review caught it: 8.39 is character 7's visual-**left**, which
  > inside an RTL run is character 7's logical **end**. Restating the bug as if it were the intent
  > is exactly how this defect survived. What collides is two offsets both reporting a third
  > offset's position.

Downstream, all of the following are hand-positioned from that number and inherit the defect:
the caret and every secondary caret (`virtualizedTextViewRows.ts:2724` → `Highlights.ts:341`), the
IME candidate box (`virtualizedTextViewRows.ts:2547`, `virtualizedTextViewComposition.ts:43`),
reveal-on-scroll (`virtualizedTextViewRows.ts:2628`), whitespace markers
(`virtualizedTextViewHiddenCharacters.ts:296-297`) and the suspicious-character warning box
(`:346-347`).

Selection is worse than off-by-one, because it is a bounding box. `appendRangeSegmentForChunk`
(`virtualizedTextViewGeometry.ts:1138`) emits one rectangle per mounted chunk with
`left = min(startX, endX)` and `width = |endX − startX|`, and `mergeSelectionSegments`
(`virtualizedTextViewSelectionLayer.ts:112`) then unions by *logical* start. A selection crossing a
direction boundary therefore paints one wide bar that covers text which is not selected and misses
text which is. The browser, asked for the same range, returns two rectangles.

Hit testing is approximately right for the wrong reason. `offsetForX`
(`virtualizedTextViewGeometry.ts:1187`) binary-searches boundary x's, falling back to the `xOrder`
permutation (`:1073`) whenever x stops ascending — which is exactly when a row contains RTL. That
keeps the search *well-defined*, so clicks are monotone and nothing crashes; but every answer is the
offset of the nearest **visual-left** boundary, so clicking a glyph gives you the offset one glyph
away and the "which half of the glyph did I click" decision is inverted inside RTL runs.

Long lines are in a different category. `shouldChunkLine` (`virtualizedTextViewRows.ts:1684`) mounts
only a logical slice of a line past the threshold, positioned by an LTR left spacer
(`:1583-1586`). You cannot window a bidi paragraph: the UBA resolves neutrals and levels over the
whole paragraph, so a slice reorders differently from the same characters inside the whole line. A
chunked RTL line shows the wrong characters at the wrong x, and no amount of geometry work
downstream can repair it.

**The dangerous part, and the reason this has gone unnoticed.** The geometry suite's central
invariant is `xToOffset(offsetToX(o)) → o'` with `offsetToX(o') ≈ offsetToX(o)`
(`packages/editor/test/virtualizedTextViewGeometry.test.ts:219-222`, and the browser twin). That is
self-consistency, not correctness, and it is direction-blind: it passes green on Hebrew while every
pixel is wrong. Nothing in this plan can be trusted until the invariants are restated against
`Range.getClientRects()`.

So the honest one-line answer to "how broken is it": **subtly and silently wrong, not obviously
broken.** Text is legible and correctly ordered. A user typing Hebrew sees a caret next to the wrong
letter, a selection highlighting the wrong letters, and clicks landing one letter off — and has no
error, no visual corruption, and no log line to point at.

---

## The two ceilings, and what a partial implementation buys

The references set two very different ceilings, and blurring them is how this project becomes three
times its estimate.

**Monaco does not implement bidi.** `MoveOperations.leftPosition`
(`references/vscode/src/vs/editor/common/cursor/cursorMoveOperations.ts:30-39`) is a logical
code-point step. There is no affinity anywhere in Monaco's `Position`. Its per-line `TextDirection`
is **decoration-driven and content-blind** (`viewModel/viewModelImpl.ts:856-873` counts decorations
carrying an explicit `textDirection`); a Hebrew line with no decoration is LTR to Monaco's cursor.
What Monaco actually does is four things: `containsRTL` (`base/common/strings.ts:674-686`) disables
the pixel-offset fast path (`viewParts/viewLines/viewLine.ts:552-570`, *"the text is guaranteed to
be entirely LTR"*); refuse to split tokens on RTL lines (`viewLayout/viewLineRenderer.ts:509-511`,
*"We can never split RTL text, as it ruins the rendering"*); read every position and range out of
`Range.getClientRects()` as a **list**, merged by x adjacency
(`viewParts/viewLines/rangeUtil.ts:46-70`, with the load-bearing comment at `:78-79` that in bidi
text the client rects do not come back sorted); and hit-test with a point-to-caret API. One caret,
drawn at the leftmost rect. That is the whole accommodation.

Monaco is also the only reference that answers the question this plan turned out to depend on most:
**which DOM node a boundary is addressed from.** `_actualReadPixelOffset`
(`viewLine.ts:643-651`) does not hand the engine a bare offset — it calls
`this._characterMapping.getDomPosition(column)` (`viewLayout/viewLineRenderer.ts:271`), which is
`charOffsetToPartData(column - 1)`: the rendered part holding the character *at* that column, with
the character's own offset inside it. The final boundary is set explicitly to the last part
(`:1187`, `setColumnInfo(len + 1, parts.length - 1, charOffsetInPart, …)`). Monaco then takes
`r[0].left` after a left-ascending sort. So Monaco's rule is: *address the collapsed range from the
node that holds the character starting at this boundary; if it comes back with more than one rect,
take the leftmost.* We need the same rule stated as explicitly, for the reason M2 gives.

**CodeMirror 5 does the full job.** A deliberately partial UBA in
`references/codemirror5/src/util/bidi.js` (215 lines, departing from the spec at `:164-168` to avoid
a levels array), `sticky: "before" | "after"` on every `Pos` (`src/line/pos.js:4-15`, compared by
`equalCursorPos`), a two-position caret with a secondary cursor at 85% height
(`src/display/selection.js:52-59`), per-run selection rectangles via `iterateBidiSections`
(`src/util/bidi.js:5`, used at `src/display/selection.js:97`), visual arrow-key motion
(`src/input/movement.js:44`) gated on a platform default (`option("rtlMoveVisually", !windows)`,
`src/edit/options.js:83`), and drag-anchor re-picking across bidi jumps (`bidiSimplify`,
`src/edit/mouse_events.js:337`). The clearest statement of the semantics in either codebase is the
comment table at `src/measurement/position_measurement.js:355-366`.

> **CodeMirror does not support the collapsed-range design and must not be cited as if it did.**
> `position_measurement.js:241-242` reads a side off a **non-collapsed single-character** rect, and
> the caller `cursorCoords` (`:376-395`) picks that side from
> `getBidiPartAt(order, ch, sticky)` after computing `getOrder(lineObj, cm.doc.direction)` — the run
> directions M2 deliberately declines to compute. The first draft cited `:241-242` in support of M2.
> An agent following that citation concludes run directions are required. Monaco alone supports this
> design.

### Tier A — "renders and clicks right" (Monaco parity)

Milestones 1–5 below. Confined to `virtualizedTextViewGeometry.ts`,
`virtualizedTextViewSelectionLayer.ts`, `virtualizedTextViewHiddenCharacters.ts`, plus signature
changes in `virtualizedTextView.ts` / `virtualizedTextViewRows.ts` and a gate plus a text-node
splitter in `virtualizedTextViewRows.ts`. Everything it needs already exists in the repo: DOM range
construction (`virtualizedTextViewGeometry.ts:453`), DOM-boundary addressing
(`domBoundaryForOffset`, `:506`, over `domBoundaryForChunkLocalOffset`, `:1563`), DOM-boundary
reading back (`offsetFromDomBoundary`, `:516`, exposed at `virtualizedTextView.ts:806`), a
`caretPositionFromPoint` wrapper (`virtualizedTextViewHelpers.ts:496`, today reachable only from a
self-check), the non-monotone boundary search (`xOrder`), and the lazy per-unit plan that survives
untouched.

### Tier B — "the cursor doesn't teleport" (CodeMirror 5 parity)

Milestones 6–7. Requires bidi run boundaries per row, **affinity as a field on `Selection<T>`**
(`packages/editor/src/selections.ts:22-28`) threaded through anchors, cursor history, the LSP
document copy, snippets, multi-cursor normalization, drag anchoring and IME, and
`SelectionGoal.horizontal` changed from a cell column to a pixel x. This is an editor-core project,
not a geometry project.

### What a partial implementation buys — the actual answer

**Tier A is a coherent, shippable product, and it should be sold as such rather than as a
half-finished bidi story.** After it: text renders correctly (it already does), carets and
selections land on the right glyphs, clicks land where you point, and arrow keys move logically.
That is exactly Monaco's behaviour and it is what a user editing bidi text encounters today in the
most widely used code editor in the world. There is no user-visible half-state to explain.

Three residues of Tier A must be stated up front, because a reviewer will find them and they are not
bugs:

- **Left arrow on an RTL line moves the caret to the right.** Monaco does this. It is logical motion,
  and it is the deliberate de-scoping in Tier B, not an oversight.
- **A caret at a direction boundary sits on one of two legitimate positions**, chosen by "leftmost
  rect" rather than by where the caret came from. The browser returns both and declines to rank
  them. Ranking them is what affinity is, and affinity is Tier B.
- **Consequently, clicking the far end of an embedded run puts the caret at its near end.** Measured
  on `mixed`: `caretPositionFromPoint` at x≈100 (the right edge of the Hebrew word) returns offset
  12, and offset 12's leftmost collapsed rect is at 67.22 — 33px to the left of the click. This is
  Monaco's behaviour too, it is visible, and it is the single most likely user report against Tier
  A. It is closed only by affinity (M6).

**Within Tier A the milestones are not equally shippable, and the ordering below reflects that.**

- **M1 is not "tests only".** Its first item changes how a tab renders on every line that also holds
  a non-ASCII character, which moves measured widths as well as glyphs. It is still `S`, and it is
  the single best value-per-risk item in the plan because it affects every mixed-script document
  whether or not that document has a single RTL character in it.
- **M2 is the load-bearing one.** Correcting the boundary edge fixes the caret, the IME box,
  reveal-on-scroll, row content width, and — via the unit-rect rule it introduces — whitespace
  markers.
- **M2 must not ship without M3.** This is the correction the review forced, and it is measured.
  M2 leaves `rangeSegments` and `suspiciousCharacterMarker` computing a span as `min`/`|Δ|` over two
  boundary x's. When one endpoint is a direction boundary, correcting the *other* endpoint makes the
  span worse: selecting the single space at offset 12 of `mixed` paints `left 67.22 width 42.00`
  after M2 where today it paints `left 100.83 width 8.39`, which is right. M3 replaces that
  arithmetic with the engine's rect list and closes it. **M2+M3 is one shipping unit.**
- **M4 is a repair, not a refinement, and it gates M5.** `resolveRowGeometry` (`:1059`) is the only
  whole-row boundary sweep in the file and `offsetForX` (`:1188`) is its only caller. On a long
  un-chunked RTL row that sweep is fatal — see M5's numbers. M4 is what stops it being reached.
- **M5 goes last** because un-chunking a bidi line is what creates the long un-chunked RTL row in the
  first place. Shipped in the first draft's position (second), it trades a wrong-pixels bug on rare
  files for a multi-second freeze on the same files.

So the minimum honest ship is **M1 + M2 + M3**, and the recommended ship is **M1–M5 in order**.

**Is half-done worse than not pretending?** The first draft answered "for Tier A: no — every
milestone strictly reduces the set of wrong pixels". **That sentence was false and has been
removed.** The measured counterexample is the space at offset 12 of `mixed` above: M2 alone takes a
marker that is correct today to one that is 42px wide and covers the word beside it. The honest
restatement:

> Tier A's *shipping units* each strictly reduce wrong pixels — M1, then M2+M3 together, then M4,
> then M5. Its *milestones* do not, and M2 in particular ships a regression that only M3 closes. The
> sequencing below is therefore a constraint, not a preference.

For Tier B the original answer stands and is **emphatic: yes, half-done is worse.** M6 (affinity)
has zero user-visible payoff on its own and touches the most safety-critical types in the editor; M7
without M6 cannot be built at all. Drawing CodeMirror's secondary caret without affinity is
specifically ruled out below: it shows the user two candidate positions while the model still holds
one, so typing inserts at a place the display has just implied it might not. **Do not start Tier B
unless funded to finish it.**

---

## Prerequisites

These must exist before milestone 2 begins. M1 creates the ones that do not exist yet.

- **A browser-project test harness.** `packages/editor/vitest.config.ts` already defines a `browser`
  project (headless Chromium via Playwright, `test/**/*.browser.test.ts`) precisely because
  *"happy-dom reports every rect empty"*. Every exit criterion in this plan is a pixel claim, so
  **nothing here may be asserted in the `node` or `dom` projects.** Note that vitest browser mode
  does not forward `console.log` to the terminal; data comes out through assertions.
- **A trustworthy RTL corpus.** Blocked on the tab-rendering defect in M1 — a tab-indented non-ASCII
  line does not currently render a tab.
- **An oracle that addresses boundaries through the row's own DOM.** Not a pristine text node. This
  is a prerequisite and not an implementation detail; see M1 and the measurement in M2.
- **A per-row `mightContainRTL` classifier**, built in M2 (it is needed there first, not in M5).
  `isSimpleRowText` (`virtualizedTextViewGeometry.ts:202`) admits only tab and U+0020–U+007E
  (`isSimpleRowCodeUnit`, `:1388`), and every RTL character and every bidi control is above U+007E.
  So `!isSimpleRowText(text) && containsRTL(text)` is the gate, the expensive half only runs on rows
  that already failed the ASCII check, and the classifier is a per-row property — bidi resolves per
  display row and each of our rows is exactly one display line in its own element.
- **A memo for that classifier, keyed on whatever retires the row's geometry.** Required before M5,
  not optional: M5 puts the classifier inside `shouldChunkLine`, which is `text.length > threshold`
  today and is called from `rowChunkKey` (`virtualizedTextViewRows.ts:1694`) and from `:1002`,
  `:1044`, `:1765` (a loop over every mounted row) and `:2504`, with `rowChunkKey` recomputed per
  snapshot at `:626`, `:710` and `:2006`. An absence proof is inherently O(n): a 2MB minified
  pure-ASCII line would pay a full 2M-code-unit scan per row per snapshot to establish that it has
  no RTL in it. Build the memo in M2 when the classifier is first written.
- **No prerequisite from the parity programme.** The lazy per-unit plan (`:782-810`, `:985`) is
  orthogonal to direction and survives; the calculated fast path (`:614`, `:645`,
  `KEY_COLUMN_DISTANCE` at `:34`) is provably unreachable for bidi text and needs no change at all.

---

## Milestone 1 — The oracle, the corpus, and a tab that is a tab

`effort S` · `risk medium` · Tier A

**Why here.** Every existing geometry invariant is direction-blind and passes green on Hebrew
(`packages/editor/test/virtualizedTextViewGeometry.test.ts:219-222` asserts that `offsetToX` and
`xToOffset` agree with each other, which they do while both are wrong). Nothing in this plan can be
verified until there is an oracle, and the only oracle available is the engine itself:
`Range.getClientRects()` in the `browser` project. Building it first also settles the shape of every
later exit criterion — they compare our answer to the browser's answer **on the same machine**,
never to a hardcoded pixel, which is what keeps them portable across font stacks. The tab defect is
here because it is discovered by, and would silently corrupt, the corpus: `appendRenderedText`
(`virtualizedTextViewGeometry.ts:264-298`) calls `oneCellControlCharacterLabel` (`:1446`, which
returns `String.fromCodePoint(0x2400 + code)` for every code 0–31, tab included) *before*
`controlCharacterInfo` (`:1440`), whose first line `if (code === 9) return null` is therefore
unreachable from this path. A tab on any non-ASCII line renders as `␉` in one cell.
`isSimpleRowText` treats tab as simple, so this only fires when a line mixes a tab with a non-ASCII
character — an accented letter, CJK, an emoji, or Hebrew — which is why it has never been seen. A
tab-indented RTL corpus line would be measuring different text than the plan thinks it is.

**The oracle's addressing rule is the load-bearing part of this milestone, not the rect reading.**
Measured: with `אבג ` and `123 דהו` as two adjacent text nodes in one element, a collapsed range at
the end of the first node reports `[58.83]` and one at the start of the second reports `[33.61]` —
one rect each, **25.22px apart**, for the same logical offset. The same offset in a single unsplit
node reports both, `[33.61, 58.83]`. An oracle that addresses a pristine node while the subject
addresses the row's own node reports a full-run disagreement as an M2 bug that is not one. The
oracle must go through `domBoundaryForOffset` (`virtualizedTextViewGeometry.ts:506`), the same entry
point the subject uses.

**Exit criteria.** A tab on a line containing a non-ASCII character renders as a real tab character
in the row's DOM text, advancing to the tab stop, and a regression test asserts the row's text
content code points contain U+0009 and not U+2409, and that the tab's own measured advance reaches
the next tab stop rather than one cell. A browser-project fixture mounts a view over the named
corpus in "Measurement conditions" and exposes three oracle helpers, **all of which resolve their
DOM position through `domBoundaryForOffset` on the mounted row**: one returning the full client-rect
list of a collapsed range at a given (row, offset); one returning the x-adjacency-merged client-rect
list of a (row, start, end) range; one returning the per-glyph rect table for a row, keyed by local
index. The first helper is asserted to return more than one rect at the direction boundaries of
`mixed`, `nested`, `tabRtl` and `override` and exactly one everywhere else, so the harness is proved
to be seeing the ambiguity rather than hiding it. The oracle agrees with `offsetToX`/`rangeSegments`
on `latin` to within 1px, proving the harness rather than the subject. A separate assertion proves
our DOM structure does not disturb reordering, **stated per glyph and not as rect-list equality**:
for every corpus line, every glyph's rect measured through our mounted row matches the same glyph's
rect measured over the same string in a single unsplit text node, to within 1px. (Rect-list equality
is the wrong assertion and would fail on correct output — measured: the same string split across
four text nodes yields six client rects where the unsplit node yields three, covering the identical
span.)

- [x] **Tab is unreachable behind the one-cell control label, so it renders `␉` on any non-ASCII line**
      `high` `S` — `virtualizedTextViewGeometry.ts:264-298`, `:1440`, `:1446`. Move the `code === 9`
      exemption ahead of the `oneCellControlCharacterLabel` call. Not a bidi defect; found while
      surveying for one, a blocker for the corpus, and the widest-reaching single fix here. It is
      `risk medium` and not `low`: it changes rendering and measured width for every line that mixes
      a tab with an accented letter, CJK, an emoji or RTL text, and the only existing coverage
      (`test/virtualizedTextView.test.ts:2395`, `:2423`) pins `␀` and `␡`, not tab.
- [x] **A collapsed-range, a merged-range and a per-glyph oracle in the browser project, all
      addressing through `domBoundaryForOffset`**
      `high` `S` — new `test/bidiGeometry.browser.test.ts` plus a shared fixture helper.
- [x] **The named RTL corpus, with the per-glyph reordering-is-undisturbed assertion**
      `high` `S` — the seven lines, plus the two supplementary lines `controlRtl` and `widgetRtl`
      built as separate fixtures so that no "all seven lines" criterion silently acquires two more
      rows. They exist only for M2's element-boundary criterion.

**Milestone 1 verification (2026-08-22).** The tab exemption and its DOM regression were already
present in the current source; the browser-project regression now proves its native tab-stop width.
Passing commands: `bun run test --project browser test/bidiGeometry.browser.test.ts`;
`bun run test --project dom test/virtualizedTextView.test.ts -t "paints a tab as a tab"`;
`bun run typecheck`; `bun run lint` (two pre-existing `unicorn(no-new-array)` warnings in
`src/syntax/packedTokens.ts`, no errors).

---

## Milestone 2 — The boundary reads its own edge from the engine

`effort L` · `risk medium` · Tier A · **ships together with M3**

**Why here.** This is the root defect. It comes after M1 because its exit criteria are pixel claims.
It does *not* need the chunking gate first: every corpus line is under twenty characters and none of
them chunk.

The design decision, and it is the one that keeps this milestone at `M` rather than `L`: **do not
compute run directions.** A boundary does not need to know which run it is in; it needs its x. This
is what Monaco does (`viewLine.ts:643-651` reads a collapsed range through `readHorizontalRanges`
and takes `r[0].left` after a left-ascending sort), and it composes with the lazy per-unit plan this
file is built on: a boundary already resolves on demand from its own unit. The change is confined to
how `boundaryX` (`virtualizedTextViewGeometry.ts:958`) and `resolvedUnitEdge` (`:973`) answer for a
row that might contain RTL. Rows that cannot contain RTL keep the existing path byte for byte, so
there is no regression surface and no cost on the overwhelmingly common case.

**Three things the first draft got wrong here, all measured, all now milestone work rather than
comment work.**

*One: the collapsed range must be addressed from a specific node, and the choice is semantic.* The
25.22px seam measurement is in M1. `MeasuredUnit` carries `node`/`nodeOffset` only for
`kind: 'text'`; `appendPartPlan` (`:845`) builds control units at `:861` and widget units at `:877`
with `node: null, nodeOffset: 0`. Worse than "needs a second path": `elementBoundary` (`:1603`)
returns `{ node: parent, offset: childIndex }`, and a collapsed range at an element boundary returns
**zero client rects** — measured on both sides of an `inline-block` control span sitting inside an
RTL run. The adjacent text nodes do answer (33.61 at the end of the preceding node, 25.20 at the
start of the following one, either side of the span's own box at `[25.22, 8.39]`). So the rule has
to be written down: **address the boundary from the DOM node holding the character that starts at
it, falling back to the end of the preceding text node when that character has no text node of its
own; if the range returns more than one rect, take the leftmost; if it returns none, take the
adjacent element's box edge on the side the neighbouring boundary is not on.** That is Monaco's rule
plus the element case Monaco does not have. `appendPlanBoundary`'s comment (`:942-956`) — "where
two units meet, the later of them stands there" — is then *correct as an addressing rule* and wrong
only as a statement about rect sides; keep the rule, rewrite the comment, and pin the choice in a
test.

*Two: nothing that spans more than a point may be computed from two boundary x's.* The whitespace
marker (`HiddenCharacters.ts:296-297`) takes `min`/`|Δ|` over `offsetToX(offset)` and
`offsetToX(end)`. The first draft claimed markers "become correct for free". Measured on the corpus,
they do not — and the failure is not symmetric:

| line, index | true glyph box | today | after M2 via two boundaries | after M2 via the unit rect |
|---|---|---|---|---|
| `nested` @3 (space) | `58.83 w8.41` | `33.61 w25.22` | `33.61 w33.61` | `58.83 w8.41` |
| `nested` @7 (space) | `25.20 w8.41` | `16.80 w8.40` | `25.20 w8.39` | `25.20 w8.41` |
| `mixed` @12 (space) | `100.83 w8.41` | `100.83 w8.39` | **`67.22 w42.00`** | `100.83 w8.41` |
| `tabRtl` @0 (tab) | `0 w33.61` | `0 w84.02` | `0 w33.59` | `0 w33.61` |

The `mixed` @12 row is the counterexample that killed "every milestone strictly reduces wrong
pixels": today's marker is right, and correcting only the boundary at 13 turns it into a 42px bar
over the neighbouring Hebrew word. The right answer is not a better tie-break — it is to stop
deriving a one-glyph box from two boundaries. **A whitespace marker covers exactly one grapheme,
which is exactly one `MeasuredUnit`, whose left and width `resolveUnit` (`:985`) already holds.**
Taking them directly is exact to ≤0.02px on every whitespace character in the corpus, LTR and RTL
alike, and costs no extra layout read. `suspiciousCharacterMarker` (`HiddenCharacters.ts:339`) spans
a *range* and has no such shortcut; it stays wrong until M3, and that is recorded, not fixed here.

*Three: `contentRight` cannot be `max` over one x per boundary.* `resolveRowGeometry`'s
`contentRight = max(boundary x)` (`:1059-1082`) underestimates `pureHebrew` today by one glyph
(67.20 against a true right edge of 75.63) and `nested` likewise (84.03 against 92.44) — the maximum
boundary is the *left* edge of the logically-first character. Correcting the boundary fixes those
two (75.61 and 92.42). It does **not** fix `tabRtl`: 84.02 before and after, against a true 92.42,
because the row's rightmost point lives in the *discarded* second rect of the direction boundary at
offset 1 (`{33.59, 92.41}`). Today both errors are masked by `estimatedRowContentWidth`. Take the
row width from one `selectNodeContents(row).getClientRects()` read instead — that is one layout read
for the whole row, it is what `measureRowContentWidth` (`:365`) already does per chunk, and it is
exact.

The remaining secondary site falls out unchanged: `xForOffset`'s nearest-boundary snap (`:1160`) is
reached only for offsets interior to an inline replacement, where the two neighbouring boundaries
may be in different runs and picking the nearer by *offset* is meaningless; clamp instead.

**Exit criteria.** For every offset on every corpus line, `offsetToX` equals the leftmost client
rect of a collapsed DOM range addressed through `domBoundaryForOffset` on the mounted row, to within
1px. On every corpus line, **no two offsets whose collapsed range returns exactly one client rect
share an x within 1px** — this is the injectivity that is achievable and it is the one that names
the defect: it fails today on `pureHebrew` (7↔9), `pureArabic` (11↔13), `nested` (9↔11), `tabRtl`
(6↔8) and `override` (8↔10), and must pass on all seven lines afterwards. Every remaining x
collision has at least one endpoint whose collapsed range returns more than one rect, and the exact
set of colliding pairs per corpus line is pinned in the test, so a new collision is a failure.
**`offsetForX`'s behaviour at such a collision is asserted at named sample points, because it is
x-dependent and not a property of the pair.** `boundaryOrderByX` (`:1132`) sorts by x and breaks an
*equal-x* tie by offset; `offsetForX` (`:1187-1198`) then takes `previous` when
`x - xs[previous] <= xs[next] - x`, i.e. on an exact *distance* tie. No pinned pair on the corpus
has equal x — `nested` 4 is at 33.61 and 7 at 33.59 — so the rule that actually decides is
nearest-x, and the assertion names its two sample points: sampling at 33.61 returns 4 and sampling
at 33.59 returns 7, asserted at exactly those x. The midpoint of a pinned pair is not asserted, and
neither is the exact-tie branch, which the corpus does not reach. "Resolves to the lower offset"
without a sample point is not a criterion. The caret element's `transform` places it within 1px of
the oracle for every offset on `mixed` and `nested`. Every whitespace marker on every corpus line
matches that character's own glyph rect from the per-glyph oracle to within 1px, and the marker's
width never exceeds one glyph advance. Row content width equals the browser's measured row width to
within 1px on all seven lines, `tabRtl` included. **On the two supplementary lines `controlRtl` and
`widgetRtl`, the boundaries either side of the element are resolved by the addressing rule's
zero-rect fallback and land within 1px of the adjacent text nodes' answers** — the only criterion in
this plan that exercises the element-boundary path, and the reason those two lines exist. A
pure-ASCII regression run shows no change in the number of layout reads per row.

> **Not an exit criterion, and deliberately so: `rangeSegments`.** M2 leaves it computing
> `min`/`|Δ|` over two boundary x's, and correcting the boundaries makes single-character selections
> adjacent to a direction boundary *worse* by the same arithmetic as the marker table above. The M2
> test suite pins the known-wrong values for `rangeSegments` on `mixed` `[12,13)` and `nested`
> `[3,4)` so that M3 has something to flip, and M2 does not ship on its own. **Pin them against the
> oracle and the row's measured advance `a`, never as pixels** — the rule at the top of this
> document applies to a pinned defect exactly as it applies to a pinned correct value. On `mixed`
> `[12,13)` the segment's left is `4a` to the left of the oracle's glyph box and its width is `5a`
> instead of `1a`; on `nested` `[3,4)` the left is `3a` to the left of the oracle's and the width is
> `4a` instead of `1a`. Measured under the conditions above those are `67.22 w42.00` against a true
> `100.83 w8.41`, and `33.61 w33.61` against a true `58.83 w8.41`.

- [x] **`boundaryX`/`resolvedUnitEdge` resolve from a collapsed DOM range on RTL-containing rows**
      `high` `M` — `virtualizedTextViewGeometry.ts:958`, `:973`, gated by the classifier. Keep the
      unit rect for `plan.widths`; take the boundary x from the engine. `UNIT_LEFT`/`UNIT_RIGHT`
      (`:69-70`) stop meaning visual sides and must be renamed to what `appendUnitPlan` (`:912`)
      actually writes — the unit's logical start and end — or the next reader repeats this bug.
- [x] **The node-addressing rule, written down and tested, including the element-boundary case**
      `high` `M` — `:942-956`, `:845-880`, `:1563`, `:1603`. A collapsed range at an element
      boundary returns zero rects; control and widget units have `node: null`. This is the item most
      likely to be under-budgeted, and until the two supplementary corpus lines exist it is also the
      item with no test that can fail — the seven-line corpus never reaches this path.
- [x] **The per-row `containsRTL` classifier, composed with `isSimpleRowText`, with its memo**
      `high` `S` — the expensive scan runs only on rows that already failed the ASCII check
      (`:202`, `:1388`). Model the character ranges on Monaco's generated regex
      (`references/vscode/src/vs/base/common/strings.ts:674`) but **add U+200E and U+202A–U+202E and
      U+2066–U+2069**, which that regex omits. Do not re-derive them: they are already in
      `INVISIBLE_CODE_POINT_DATA` (`packages/editor/src/unicodeHighlightData.ts:33`, verified to
      contain all eleven), so name the eleven explicitly and assert in a test that they are a subset
      of it, or the two lists drift. Memo the answer against the row's geometry cache key.
- [x] **Whitespace markers take the unit's own rect, not two boundaries**
      `high` `S` — `virtualizedTextViewHiddenCharacters.ts:296-297` plus a small geometry export
      over `resolveUnit` (`:985`). Exact on the whole corpus; costs no extra read.
- [x] **Row content width comes from one `selectNodeContents` read**
      `medium` `S` — `:1059-1082`, `:365`.
- [x] **The `xForOffset` interior snap clamps instead of picking the nearer offset**
      `medium` `S` — `:1160-1169`.

**Milestone 2 verification (2026-08-22).** Passing commands:
`bun run test --project browser test/bidiGeometry.browser.test.ts` (15 tests, including the two
known-wrong M3 range pins); `bun run test --project dom test/bidiText.test.ts
test/virtualizedTextViewGeometry.test.ts test/hiddenCharacters.test.ts` (39 tests);
`bun run typecheck`; `bun run lint` (the same two pre-existing `packedTokens.ts` warnings, no
errors).

> **Known gap this milestone records rather than closes.** An inline widget or a zero-rect segment
> inside an RTL run is still placed by `resolveUnit`'s back-chain (`:985-1009`), which stacks
> rightwards from the preceding unit. Fixing it needs the run direction this milestone deliberately
> avoids computing, and the triggering combination is markdown WYSIWYG inline replacements plus
> Hebrew. Likewise `rowTextLeftForOffset`'s unmounted-row fallback
> (`virtualizedTextViewRows.ts:2642`) stays `column × characterWidth`, so reveal-on-scroll aims at
> the wrong end of an unmounted RTL line; it is already an approximation for CJK and emoji, and it
> self-corrects on the mount that follows.

---

## Milestone 3 — Selection is a list of visual rectangles

`effort M` · `risk medium` · Tier A · **ships together with M2**

**Why here.** It closes the regression M2 opens, and a segment's endpoints are only meaningful once
boundary x's are. It is a small blast radius for its value: `rangeSegments`
(`virtualizedTextViewGeometry.ts:384`) has **exactly one non-test consumer**,
`virtualizedTextViewSelectionLayer.ts:77` (verified by grep across `packages/`). Everything else
that paints a range already goes through the CSS Highlight API and is already correct. That
asymmetry is the cheapest thing to point a reviewer at: this codebase has two range painters, one of
them is right today, and they disagree on screen.

The replacement is a simplification, not an addition. `createDomRangeForChunkRange` (`:453`) already
builds the Range; `Range.getClientRects()` already returns one rect per visual run intersected with
that range; Monaco's merge is 25 lines
(`references/vscode/src/vs/editor/browser/viewParts/viewLines/rangeUtil.ts:46-70`, coalescing within
0.9px for browser rounding) and carries the warning we need at `:78-79` — the rects do not come back
sorted in bidi text. What goes away is the `min`/`|Δ|` bounding box at `:1138-1158` and the
logical-start union at `SelectionLayer.ts:112-136`, which is precisely the operation that produces
the giant wrong bar. `SelectionSegment.start`/`end`, the dedupe key (`:138-144`) and the
`data-editor-selection-start/end` attributes must change with it: a visual rectangle no longer
corresponds to one logical span.

`suspiciousCharacterMarker` (`HiddenCharacters.ts:339`) reuses the result, and this is where it is
finally right. There is a pointed irony worth recording: the one feature in this repo that already
knows bidi exists — the trojan-source warning, whose doc comment at
`packages/editor/src/unicodeHighlight.ts:5-12` says a bidirectional override *"can reorder a line
until the code the compiler sees and the line the reviewer sees disagree"* — draws its warning box
in the wrong place, because of exactly the reordering it warns about.

**Exit criteria.** For every (line, start, end) in the corpus, `rangeSegments` returns the same
rectangle list as the browser's own `Range.getClientRects()` over the same offsets, merged by the
same 0.9px x-adjacency rule, to within 1px per edge and with the same count — the merge applied to
both sides, since our row's text-node splitting fragments the raw list without changing its
coverage. The known-wrong values M2 pinned are flipped: `rangeSegments` on `mixed` `[12,13)` and on
`nested` `[3,4)` each returns a single rect of one advance matching that character's own glyph rect
from the per-glyph oracle, to within 1px — `100.83 w8.41` and `58.83 w8.41` under the conditions
above, asserted against the oracle and not against those two numbers. A selection of the Hebrew word
in `mixed` paints one rectangle over that word's glyphs and nothing else. **A selection crossing a
direction boundary paints two disjoint rectangles, neither of which covers an unselected glyph —
asserted on `nested` `[2,6)`, which the engine returns as two rects of `2a` each with a `1a` gap
between them (measured `33.61 w16.81` and `58.83 w16.81`, an 8.41px gap), compared to the oracle
rather than to those numbers.** The criterion is named on that range and not on an arbitrary one,
because `nested` `[4,8)` also crosses a direction boundary and the engine returns rects of `1a` and
`3a` (measured `25.20 w8.41` and `33.61 w25.22`) which **abut exactly** and therefore coalesce to
one rectangle under the 0.9px rule this milestone mandates: correct output, one rectangle, and a
criterion phrased as "two rectangles" would fail it. The painted
`<span class="editor-virtualized-selection-range">` elements have `left`/`width` matching the
merged rects.
The suspicious-character marker for a U+202E override range covers the reordered glyphs it warns
about, asserted on `override`. `emptyRowSelectionSegment` (`SelectionLayer.ts:80`) is unchanged and
its tests still pass. Selection-layer keying still suppresses a rebuild when nothing moved, asserted
by count of DOM writes.

- [x] **`rangeSegments` returns one rect per visual run, from `Range.getClientRects()`**
      `high` `M` — `virtualizedTextViewGeometry.ts:384`, `:1138`.
- [x] **`mergeSelectionSegments` merges by x adjacency, not by logical start**
      `high` `S` — `virtualizedTextViewSelectionLayer.ts:112-136`, plus the segment identity and
      dedupe key at `:138-144`.
- [x] **The suspicious-character range marker reuses the segment list**
      `medium` `S` — `virtualizedTextViewHiddenCharacters.ts:339-352`, `:445-456`.

**Milestone 3 verification (2026-08-22).** Passing commands:
`bun run test --project browser test/bidiGeometry.browser.test.ts` (19 tests, exhaustive corpus
ranges and painted rects); `bun run test --project dom test/virtualizedTextViewGeometry.test.ts
test/virtualizedTextView.test.ts test/hiddenCharacters.test.ts` (169 tests); `bun run typecheck`;
`bun run lint` (the same two pre-existing `packedTokens.ts` warnings, no errors).

---

## Milestone 4 — Hit testing asks the engine

`effort L` · `risk medium` · Tier A · **prerequisite for M5**

**Why here.** The first draft placed this last and called it "the only milestone that is a genuine
refinement rather than a repair", on the reasoning that M2 restores injectivity and so makes
nearest-boundary hit testing already right. Injectivity is not restored — it cannot be — so that
reasoning is gone. What replaces it is a cost argument the first draft only gestured at, and the
numbers are not close.

`resolveRowGeometry` (`:1059`) is the only whole-row boundary sweep in the file, and `offsetForX`
(`:1188`) — reached by every `xToOffset`, i.e. every pointermove during a drag — is its **only**
caller. It reads one rect per grapheme. A collapsed or single-character `getClientRects()` costs, on
this machine, time linear in the length of the text node it addresses:

| Hebrew text node | µs per read |
|---|---|
| 100 code units | 2.7 |
| 500 | 9.0 |
| 2 000 | 31 |
| 10 000 | 150 |
| 50 000 | **711** |
| 50 000, split into 50-code-unit nodes | **2.0** |

So one `xToOffset` on an un-chunked 2 000-character Hebrew row costs ≈62ms, and on a 50
000-character one ≈35 **seconds**. `document.caretPositionFromPoint` at the same point costs 79µs (6
000 chars, one node), 611µs (50 000, one node), 4.3µs and 20µs respectively with 50-code-unit nodes.
That is the whole argument: M4 is not an accuracy refinement, it is the thing that stops a bidi row
from ever needing its boundaries swept, and M5 cannot land without it.

Both halves of the plumbing already exist: `hitTestNodeFromPoint`
(`virtualizedTextViewHelpers.ts:496-505`, with the `caretRangeFromPoint` fallback) is written and
currently reachable only from a diagnostic self-check at `:468`, and `offsetFromDomBoundary`
(`virtualizedTextViewGeometry.ts:516`) already maps a DOM boundary back through text parts, control
glyphs, inline widgets and element boundaries, exposed publicly at `virtualizedTextView.ts:806`.

The actual work is a seam, not an algorithm. `viewportPointMetrics`
(`virtualizedTextViewRows.ts:2673`) converts a client point to a row-local x and discards
`clientX`/`clientY`, and `textOffsetFromViewportPoint` (`virtualizedTextView.ts:789-803`) consumes
only the row-local x. The client point has to survive to the hit test. Every mouse consumer funnels
through here — drag-select (`inputSelectionController.ts:1489`, `:2030`), hover
(`packages/lsp-plugin/src/hoverDefinitionController.ts:160`, `:191`), document links
(`packages/editor/src/documentLinkPlugin.ts:95`) — so the seam is worth getting right once.

**Two measured facts the criteria have to be built around, or this milestone tests nothing.**

*The engine's own hit test disagrees with the engine's own caret rect at the visual edges of a line
— **inside** the row's text extent, not outside it.* Sweeping `caretPositionFromPoint` in 0.25px
steps across `nested` in a 600px-wide row, the bands are `0@[-0.25,4]`, `10@[4.25,12.5]`,
`9@[12.75,21]`, `8@[21.25,29.25]`, `4@[29.5,37.75]`, `5@[38,46]`, `6@[46.25,54.5]`, `7@[54.75,63]`,
`3@[63.25,71.25]`, `2@[71.5,79.75]`, `1@[80,88]`, `11@[88.25,…]`. `nested`'s measured text extent is
`[0, 92.44]`. The leftmost 4.2px — the outer half of the
visually-first glyph, and **well inside that extent** — resolve to offset **0**, whose own collapsed
rect is at 92.42, the far right of the row; symmetrically `[88.25, 92.44]` resolves to offset
**11**, whose rect is at 0.00. That is Chrome placing a point before the line's visual start at the
line's *logical* start, correct for an LTR paragraph and startling in an editor. It is not covered
by "within 1px of a direction boundary".

> **The previous revision of this plan clamped "when the point is outside the row's measured text
> extent on either side". That trigger never fires on the bands above, and the verification pass
> caught it.** The bands are `[L, L + a/2)` and `(R − a/2, R]` for extent `[L, R]` and advance `a` —
> both interior. A clamp keyed on the extent is a gate that looks like a gate and is not one; the
> facts were accepted and the remedy was then written where it could not reach them. What follows is
> keyed on the defect itself rather than on a proxy for it, and the criteria are keyed on the same
> thing.

**The trigger.** Take the engine's answer only if that offset has *some* client rect within one
character advance `a` of the sampled x — compared against the offset's **whole position set**, every
rect its collapsed range returns, not only the leftmost. Otherwise the engine has answered with an
offset that is nowhere near the click, and the answer is discarded. The margin is measured and wide:
a legitimate interior answer is a boundary of the glyph the point is inside, so it is at most `a`
away, while every failing case above is 25px or more away — anything in `(a, 25px)` separates them.
**Comparing against the whole position set rather than the leftmost rect is load-bearing, and the
leftmost-only form is wrong**: at `nested` x=61 the engine answers 7, whose leftmost rect is at
33.59 (27px away) and whose second rect is at 58.81 (2px away). 7 is legitimate there — it is offset
4's pinned twin — and a leftmost-only trigger would discard it and clamp a good interior click to a
third, wrong offset.

**The fallback, and why it is not "the boundary whose x is nearest the point".** That obvious
replacement is `offsetForX` (`:1188`), which calls `resolveRowGeometry` and sweeps every boundary in
the row — the sweep this milestone exists to prevent and which its own third item forbids, and which
costs ≈35 seconds on the 50 000-character rows M5 creates. Use instead what the sweep above
measures: **the trigger only fires within a half-advance of a visual end of the row, and the answer
there is the row's extremal boundary on that side** — which is what `offsetForX` already returns at
its own endpoints today (`:1191-1192`, `x <= xs[first]` / `x >= xs[last]`), so the clamp preserves
the row's existing behaviour rather than inventing one. Those two boundaries are resolvable in O(1)
per row and memoized against the row's geometry key:

1. `[L, R]` is the row's measured text extent, already read once by M2's `selectNodeContents`
   change.
2. Hit-test at `L + 0.75a` — three-quarters into the visually-first glyph, inside the reliable band
   and clear of both the misfire band and the glyph's midpoint — and map it through
   `offsetFromDomBoundary` to an offset `o`.
3. The visually-first glyph's two boundaries are `o` and exactly one of `o ± 1`. Read `offsetToX`
   for each candidate that is in range and take the one with a position within 1px of `L`; that is
   the left extremal boundary. If neither qualifies, keep `o`.
4. Symmetrically at `R − 0.75a` for the right extremal boundary.

On `nested` that yields 11 on the left and 0 on the right — the two answers the engine has
backwards. Cost is two hit tests and at most four collapsed-range reads per row, once per geometry
key.

**Where the trigger fires, measured across the corpus.** Both ends of `pureHebrew`, `pureArabic` and
`nested`, and nowhere else on any of the seven lines. The rule behind that is legible and worth
stating, because it is what makes an O(1) fallback sufficient: the misfire happens exactly when the
line's logical-endpoint boundary (0 or `length`) is a single-rect boundary sitting at the *opposite*
visual end. `mixed` and `latin` begin and end in LTR runs, so their endpoint boundaries are already
the extremal ones; `tabRtl` and `override` end in an RTL run but their endpoint boundary carries a
second rect at the extremal position (`tabRtl` 1↔8, `override` 3↔10 — two of the collisions M2
pins), so the engine's answer is within `a` and stands. If the trigger ever fires outside a
half-advance of an end — a future engine change — keep the engine's answer and let the assertion
below fail; do not fall back to the sweep.

*`caretPositionFromPoint` and `caretRangeFromPoint` are not interchangeable at a boundary.* Measured
across `nested` and `mixed`, they return the same offset everywhere except a 0.25–0.75px band at
each glyph midpoint, where `caretRangeFromPoint` switches later. `hitTestNodeFromPoint` prefers the
first and falls back to the second, so any criterion phrased against one API is not reproducible
through the helper. Exclude a 1px band around **every** boundary x, not only direction boundaries.

*And the obvious criterion is a tautology.* Implementing `xToOffset` as
`caretPositionFromPoint → offsetFromDomBoundary` and then asserting it equals
`caretPositionFromPoint → offsetFromDomBoundary` cannot see a bug in `offsetFromDomBoundary`, which
is the only new code in the milestone. Assert against the per-glyph rect table instead.

**Before starting, verify overlays are transparent to hit testing.** The point-to-caret APIs return
whatever node is topmost. `.editor-virtualized-selection-layer`
(`packages/editor/src/style.css:281-289`), `.editor-virtualized-hidden-character-layer` (`:298-305`)
and `.editor-virtualized-caret-layer` (`:381-387`) all set `pointer-events: none`, which their
children inherit; the `pointer-events: auto` sites (`:220-228`, `:438-450`) are block surfaces and
block rows, which do not sit over text. A `pointer-events: none` overlay was confirmed empirically
not to intercept the hit test, but that is a load-bearing assumption of this milestone and belongs
in a test, not in a survey.

**Exit criteria.** Three sweeps over disjoint x ranges, so that no sampled x is governed by two
criteria and none of the three can be satisfied by the implementation the other two describe.

*Interior.* For every corpus line and every x sampled in 1px steps that is at least 1px from every
boundary x of that row **and at least `a/2 + 1` inside each end of the row's measured text extent**,
`xToOffset` returns the offset the **per-glyph rect table** says it must: the point falls inside
exactly one glyph's box, and the answer is that glyph's logical start when the point is on the
glyph's logical-start side and its logical end otherwise, where the side is derived in the test from
the glyph's own rect ordering against its logical neighbours — **or an offset that M2's pinned
collision list names as that offset's twin.** The twin allowance is not slack: at `nested`
x∈[29.5,32.5] the table predicts 7 and the engine answers 4, and 4 and 7 occupy the same two screen
points (`{33.61, 58.83}` against `{33.59, 58.81}`), so no implementation can tell them apart and a
criterion naming one of them is unpassable. The test reads the twin list from the same pinned
constant M2 asserts, so a twin that is not already pinned is still a failure. The same sweep is
additionally asserted to agree with `caretPositionFromPoint` — a drift detector, not a definition;
on its own it is the tautology this milestone's third measured fact rules out, so if the per-glyph
comparison above is ever weakened this line must be deleted with it rather than left standing as the
survivor.

*Edges.* For every x within `a/2 − 1` of either end of the extent, `xToOffset` returns that end's
extremal boundary as resolved above: on `nested`, `xToOffset(row, 2)` returns **11** and not 0, and
`xToOffset(row, 90)` returns **0** and not 11; the same two-ended assertion holds on `pureHebrew`
and `pureArabic`. **The caret drawn there lands within 1px of the extent edge, not within 1px of the
click** — offset 11's rect is at 0.00 and the click was at 2, so the previous revision's "within 1px
of the click" was false by 2.0px and is deleted. The claim is that a click in the outer half of the
visually-first glyph puts the caret at that glyph's outer edge, which is where the row's text ends.

*The trigger itself.* Sweeping every corpus line at 0.25px, the set of x at which the engine's
answer has no rect within `a` of the sample is **exactly** the outer half-advance at each end of
`pureHebrew`, `pureArabic` and `nested`, and empty on `mixed`, `tabRtl`, `override` and `latin`.
This is the assertion that fails if a browser update moves the misfire, and it is the only reason
the fallback is allowed to stay O(1) instead of resolving the row.

The rest, unchanged in kind: clicking the left half of a glyph inside an RTL run selects the offset
after it in logical order and the right half the offset before it, asserted on `nested` at ד — the
third glyph from the row's visual left edge, its box `[2a, 3a]` from the extent's left edge
(`16.80–25.22` measured), giving 9 then 8. It is an interior glyph, chosen because the same claim is
false at the row's first and last glyph for the reason measured above. A drag-select started inside
an RTL run and dragged left extends the selection over the glyphs the pointer crossed. Hit testing
over a row carrying a painted selection, a whitespace marker and a caret returns the same offsets as
the same row with none of them. A 6 000-character Hebrew row mounted un-chunked answers `xToOffset`
without `resolveRowGeometry` being reached at all — including through the clamp — asserted by
instrumentation rather than by a timing. The unmounted-row fallback (`virtualizedTextView.ts:802`,
`column = x / characterWidth`) is unchanged for ASCII rows and its tests still pass.

- [x] **`textOffsetFromViewportPoint` carries the client point through to a DOM hit test on RTL rows**
      `high` `M` — `virtualizedTextView.ts:789`, `virtualizedTextViewRows.ts:2673`,
      `virtualizedTextViewHelpers.ts:496`, `virtualizedTextViewGeometry.ts:516`. **"Both halves of
      the plumbing already exist" is one line short of true, and the missing line is in the hit
      test.** `hitTestNodeFromPoint` (`virtualizedTextViewHelpers.ts:496-505`) is module-private and
      returns `Node | null`, discarding `position.offset` and `range.startOffset`;
      `offsetFromDomBoundary(row, node, offset)` (`:516`) needs both. Export it and widen its return
      to the node *and* the offset; its one existing caller (`:468`) reads only the node and is
      unaffected.
- [x] **In-extent edge bands clamp to the row's extremal boundary instead of the engine's answer**
      `high` `M` — the trigger over the whole position set, the O(1) extremal-boundary resolution
      and its memo, all specified above. This item was `S` and keyed on the point being *outside*
      the extent, where it fired on nothing; the size went with the trigger. Without it the
      milestone regresses M2 at both ends of every RTL row whose logical-endpoint boundary is
      single-rect, and drag-select anchored at a row's visual edge jumps by the width of the line.
- [x] **`offsetForX` is no longer reached on rows that might contain RTL**
      `high` `S` — `:1187`. This is what makes M5 affordable; assert it rather than assume it, and
      note that the clamp above is written the way it is so that it does not reach it either.
- [x] **Overlay layers are proven transparent to the point-to-caret APIs**
      `medium` `S` — `packages/editor/src/style.css:281`, `:298`, `:381`.

**Milestone 4 verification (2026-08-22).** The current bundled Chromium adds one engine-fact
variation to the recorded trigger set: `tabRtl` also misfires at its visual right edge because its
final collapsed boundary is single-rect on this run. The generic far-answer trigger and O(1)
extremal fallback repair it, and the oracle test pins the current firing set without hardcoded
pixels. Passing commands: `bun run test --project browser` (7 files, 62 tests); `bun run test
--project dom test/virtualizedTextView.test.ts test/editorOperations.test.ts` (146 tests);
`bun run typecheck`; `bun run lint` (the same two pre-existing `packedTokens.ts` warnings, no
errors).

---

## Milestone 5 — Refuse to window a bidi line

`effort L` · `risk medium` · Tier A

**Why here, and why last.** The gate itself is three lines and the first draft put it second on that
basis. The measurements in M4 say otherwise: un-chunking is what *creates* the un-measurable row,
and shipping it before M4 trades a wrong-pixels bug on rare files for a multi-second freeze on the
same files. Chunking is today the only thing bounding what `resolveRowGeometry` sweeps.

The reason to do it at all is unchanged and is the most serious single defect in this document.
`horizontalChunkWindow` (`virtualizedTextViewRows.ts:1703`) converts `scrollLeft` to a column
through `characterWidth`, mounts only that logical slice, and `setChunkedRowText` (`:1571`) plants
it behind a left spacer of `estimatedDisplayCellForColumn(...) × characterWidth` (`:1583-1586`).
Both halves assume logical order advances left-to-right. Worse, the slice is not merely
mis-positioned: the UBA resolves over the whole paragraph, so rendering characters `[0, 512)` of a
bidi line produces a different visual order than those same characters have inside the full line.
Monaco reaches the same conclusion from the other direction and refuses to split RTL tokens at all
(`references/vscode/src/vs/editor/common/viewLayout/viewLineRenderer.ts:509-511`). Wrapping chunks
in `unicode-bidi: isolate` would make the result deterministic and still wrong.

This milestone is also where `mightContainRTL` earns its keep. The parity programme closed that
finding `[~]` on the grounds that a flag proving you may skip bidi work is worthless with no bidi
work to skip. That was correct then. **This gate is its one genuine use in this codebase.**

**Two costs the first draft priced at zero, and the mitigation each needs.**

*The gate itself becomes O(n) on a hot path.* `shouldChunkLine` (`:1684`) is
`text.length > threshold` today, called from `rowChunkKey` (`:1694`) and from `:1002`, `:1044`,
`:1765` (a loop over mounted rows) and `:2504`, with `rowChunkKey` recomputed per snapshot at
`:626`, `:710` and `:2006`. Proving a line has no RTL in it requires scanning all of it. The memo
built in M2 is the prerequisite; this milestone must consume it, and must assert that a 2MB minified
pure-ASCII line costs one scan and not one per snapshot.

*Un-chunking removes both long-line defences, not one.* RTL rows fail `isSimpleRowText` and so take
`createRenderedChunkParts` (`virtualizedTextViewGeometry.ts:225`), which starts a fresh text node
only at a C1 control character or an inline widget — so `MAX_ROW_TEXT_NODE_LENGTH = 50` and
`createSplitTextChunkParts` (`virtualizedTextViewRows.ts:1659`) never apply to them. Un-chunking a
50 000-character Hebrew line therefore yields one 50 000-code-unit text node, at 711µs per boundary
read and 611µs per hit test. Splitting the same text into 50-code-unit nodes takes those to 2.0µs
and 20µs — a 350× and 30× improvement — and measurably does not disturb the layout: per-glyph rects
across a four-node split of `nested` match the unsplit node to 0.03px, and the raw client-rect list
of a range fragments without changing its coverage. The blocker `createSplitTextChunkParts` names in
its own doc comment is real and narrow: *"a fixed stride can cut a grapheme cluster in two"*. So
split RTL rows too, at grapheme boundaries, using the `segmentGraphemes` already in `appendPartPlan`
(`:855`).

> **A decision this milestone must make and record, not leave implicit.** Every text-node seam is a
> place where the boundary answer is determined by the node, and at a direction boundary the two
> nodes disagree by a whole run (M1's 25.22px measurement). A 50-unit stride on a long bidi line
> will put some seams on direction boundaries. Two honest options: (a) accept it — the M2 addressing
> rule makes the answer deterministic and it is one of the two legitimate positions either way — and
> pin the stride in a test so the geometry does not silently change when the stride does; or (b)
> nudge each seam forward to the next offset whose collapsed range returns exactly one rect, which
> costs one read per seam at mount (≈2ms on a 50 000-character line) and removes the coupling
> entirely. Decide explicitly and write the reason down; do not leave an executing agent to discover
> the coupling from a failing test.

**Exit criteria.** A row whose text contains any character in the RTL blocks or any bidi control
(U+200E/F, U+202A–U+202E, U+2066–U+2069) is never chunked, whatever its length: the mounted row has
`textRenderMode !== 'chunked'`, exactly one chunk covering the whole line, and a zero-width left
spacer. Its text is spread over text nodes no longer than the stride, split only at grapheme cluster
boundaries, asserted by walking the mounted parts. A 6 000-character Hebrew line at `scrollLeft = 0`
shows its visually-first glyph at the row's content-left edge, and `xToOffset(row, 0)` returns an
offset within the first display run rather than one from the middle of the line — x = 0 sits in M4's
edge band, so this resolves to the row's left extremal boundary, which is by construction a boundary
of the visually-first glyph. That criterion is well-defined only because M4 defines that band; it
was undefined in the previous revision, where "strictly inside the extent" excluded x = 0 and
"outside the extent" did not include it. **On that same line, a mount, a single click, and a
200-sample simulated drag each complete within 5× the same operation on a control row: a Latin line
of the same length, mounted un-chunked through the same forced path — raise the chunk threshold above
that fixture's length rather than making the classifier lie about it — so the two rows differ in
script and in nothing else.** The budget is a ratio and not a number, because a number anchors to nothing and
is passed by writing a large one. The ratio is anchored by measurement: with bounded text nodes the
per-read cost is flat in line length — 2.0µs on this plan's machine, 1.5µs on the verification
machine — so a correct implementation lands near 1×, while the defect this criterion exists to catch
is 300–800× (a collapsed `getClientRects()` on one 50 000-code-unit Hebrew node: 711µs here, 1 644µs
there, against those same 1.5–2.0µs for the identical text in 50-unit nodes). 5× is far above
per-read noise and two orders of magnitude below the defect, so the criterion is neither flaky nor
passable by a slow implementation. Both absolute numbers and the ratio go in the milestone note.
`resolveRowGeometry` is not reached during any of those three operations. The classifier's own unit
test covers a Latin-only line carrying a U+202E override (must classify as RTL-containing) and a CJK
line with no RTL character (must not), and asserts the memo is consulted rather than the scan re-run
across snapshots. A pure-ASCII line past the threshold still chunks exactly as before, asserted
against the existing chunking tests, and a 2MB minified ASCII line costs one classifier scan per
revision.

- [x] **`shouldChunkLine` refuses a row that might contain RTL, through the memo**
      `high` `S` — `virtualizedTextViewRows.ts:1684`, `:1694`. Record in the milestone note that
      this removes the only long-line *windowing* defence for those lines.
- [x] **Grapheme-aware bounded text nodes for RTL rows**
      `high` `M` — `virtualizedTextViewRows.ts:1659`, `virtualizedTextViewGeometry.ts:225`, `:855`.
      Without this the milestone is a hang, not a fix; with it the 50 000-character case is 2.0µs
      per read. Record the seam decision above.
- [x] **A length ceiling above which an RTL line is not laid out as measurable text at all**
      `medium` `M` — the residual. Even at 2.0µs per read, a row whose boundaries are all swept is
      linear in the line; M4 removes the sweep, and this ceiling is the backstop for whatever is
      left. Set it at the line length at which the 5× ratio above first fails on the test machine —
      a measured number, recorded with the measurement, not a guess — and state what the editor does
      above it.

**Milestone 5 verification (2026-08-22).** `shouldChunkLine` now consumes the revision memo, so this
removes the only long-line windowing defence for a BiDi row; the 2MB ASCII regression proves one
classifier scan per revision. Bounded nodes use option (a) at seams: keep the deterministic M2 rule
that addresses a boundary from the later character's node, because both seam positions are
legitimate without Tier B affinity and adding one layout read per seam would tax every mount. The
stride and later-node choice are pinned in the browser test. On the 6,000-character same-run probe,
Latin/RTL medians were 0.6/1.4ms to mount (2.33×), 40.6/8.0ms for a stabilized batch of 100
single-click operations (0.20×), and 18.5/45.9ms for a 200-step hit-test/selection/paint drag
(2.48×); none reached `resolveRowGeometry`. Ceiling calibration sampled increasingly long fully
laid-out rows: 28,000 still passed mount at 1.0/4.5ms (4.50×), while 32,000 was the first sampled
failure at 0.9/4.7ms (5.22×). Therefore rows of 32,000 or more code units that classify as BiDi show
a fixed endpoint-only placeholder instead of laying out measurable source text. Passing commands:
`bun run test --project browser test/bidiGeometry.browser.test.ts
test/bidiPerfProbe.browser.test.ts` (32 tests); `bun run test --project dom test/bidiText.test.ts
test/virtualizedTextView.test.ts test/virtualizedTextViewGeometry.test.ts
test/hiddenCharacters.test.ts` (173 tests); `bun run typecheck`; `bun run lint` (the same two
pre-existing `packedTokens.ts` warnings, no errors).

**Tier A final verification (2026-08-22).** Passing commands: editor package `bun run test` (128
files, 2,056 tests); editor browser `bun run test --project browser` (8 files, 76 tests); repository
`bun run typecheck`; repository `bun run lint` (the same two pre-existing warnings, no errors);
repository `bun run format:check` (17 packages). The repository formatter was run with explicit user
authorization and retained its incidental formatting of pre-existing Editor/LSP work.

**PR review follow-up (2026-08-22).** Edge-band clamping now precedes the engine-offset tolerance;
client points are converted through the row's transform scale before comparison with row-local
geometry; a grapheme longer than the 50-unit node bound takes the measurement-refusal path; and
both the start and end of a refused row have explicit hit zones. Each finding has a real-browser
regression in `test/bidiGeometry.browser.test.ts`. Oversized-grapheme detection now shares the
renderer segmentation pass for direct rows, while styled inline rows retain a whole-row preflight;
the stabilized 6,000-character probe passed its 5× ceiling in five consecutive browser runs. The
full verification commands above were rerun.

The second review pass adds bounded point fallback when a caret API misses or reports an overlay;
edge fallback compares the browser-measured logical endpoints; extremal caches never accept a null
geometry identity across recycled rows; and row extents range over source chunks rather than
selection, hidden-character, or fold overlays. Non-RTL Unicode rows retain their in-place same-line
edit path. The 6,000-character drag probe still reaches no whole-row boundary sweep.

> **Tier A ends here.** Everything below is a different project with a different budget.

---

## Milestone 6 — Caret affinity in the selection model

`effort XL` · `risk high` · Tier B · **do not start unless funded to finish M7**

**Why here.** It is the irreducible cost of Tier B and it cannot be bought from the browser at any
price. A collapsed range at a direction boundary returns both legitimate rects, **sorted by x, with
no indication which is the strong caret**. That ranking is a property of where the caret came from,
which means it is a property of the cursor, not of the geometry. CodeMirror 5 carries it as
`sticky: "before" | "after"` on every `Pos` (`references/codemirror5/src/line/pos.js:4-15`),
compares it in `equalCursorPos`, and threads it through `getBidiPartAt`
(`references/codemirror5/src/util/bidi.js:19`). Monaco has no such concept anywhere.

It is also the only thing that closes the visible residue Tier A ships with. Measured on `nested`,
the two offsets flanking a direction boundary occupy **the same pair of screen points**: offset 4
reports `{33.61, 58.83}` and offset 7 reports `{33.59, 58.81}`. No rule that assigns one x to each
offset can separate them — leftmost, rightmost, sticky-before and sticky-after all collide there,
and the same holds for offsets 8 and 12 on `mixed`. Non-injectivity at a direction boundary is a
property of the text. Affinity is not a better tie-break; it is the extra bit of state that makes
the question answerable at all.

`Selection<T>` (`packages/editor/src/selections.ts:22-28`) has `id / start / end / reversed / goal`
and nothing else, and it round-trips through piece-table anchors (`AnchorSelection`), the cursor
history recorded in parity milestone 3, the LSP document copy, snippet stops, and multi-cursor
normalization. The fallback selection id — the dedupe key — is
`selection:${anchor}:${head}:${direction}` (`:85-91`); two carets at the same offset with different
affinity are the same selection to it today. Drag anchoring needs the equivalent of CodeMirror's
`bidiSimplify` (`references/codemirror5/src/edit/mouse_events.js:337-364`), which re-picks the
anchor's side of a bidi jump so a selection does not invert under the mouse; that is the subtle part
and it has no analogue anywhere in `inputSelectionController.ts`.

**This milestone has no user-visible payoff.** That is not a criticism of the plan; it is the reason
the milestone is dangerous to start alone.

**Exit criteria.** A selection carries an affinity that survives an edit through piece-table
anchors, a cursor-history round trip, an undo/redo pair, LSP document sync, and multi-cursor
normalization. Two carets at the same offset with different affinity are not merged and do not
collide in the selection id. `caretPosition` returns the rect selected by affinity rather than the
leftmost, asserted against the CodeMirror truth table at
`references/codemirror5/src/measurement/position_measurement.js:355-366` for `ab`/`aB`/`Ab`/`AB`,
and on `mixed`: a click at x≈100 resolves to offset 12 (measured) and the caret is drawn at 100.83
rather than at 67.22. A drag starting inside an RTL run and crossing a direction boundary does not
invert the selection under the pointer. Every existing selection, history, snippet and multi-cursor
test still passes.

- [x] **Affinity on `Selection<T>` and its identity**
      `high` `L` — `packages/editor/src/selections.ts:22-28`, `:85-91`.
      Verified 2026-08-23 from `packages/editor`: `bun run test --project dom
      test/selections.test.ts` (20 tests); `bun run typecheck`; `./node_modules/.bin/oxlint
      src/selections.ts test/selections.test.ts test/graphemes.test.ts
      test/navigationTargets.test.ts`; `./node_modules/.bin/oxfmt --check` over the same four files.
- [x] **Affinity survives anchors, history, LSP sync, snippets and normalization**
      `high` `L` — Verified 2026-08-23: editor `bun run test --project dom
      test/selections.test.ts test/documentSession.test.ts test/history.test.ts
      test/cursorHistory.test.ts test/selectionRanges.test.ts test/snippets.test.ts` (124 tests),
      `bun run typecheck`, and `bun run build`; LSP `bun run test test/completion.test.ts
      test/completionController.test.ts test/completionCommit.test.ts
      test/completionSnippet.test.ts test/completionSources.test.ts` (74 tests) and
      `bun run typecheck`; tree-sitter `bun run test test/structuralSelection.test.ts` (5 tests)
      and `bun run typecheck`. Focused `oxlint`, `oxfmt --check`, and `git diff --check` passed
      across all changed files.
- [ ] **Drag anchoring re-picks the side across a bidi jump**
      `high` `M` — `packages/editor/src/editor/inputSelectionController.ts:2030`, `:2148`.
- [ ] **`caretPosition` returns one-or-two positions and the caret layer mounts the secondary**
      `medium` `M` — `virtualizedTextViewRows.ts:2724`, `virtualizedTextViewHighlights.ts:341`,
      `:1424`.

---

## Milestone 7 — Visual motion

`effort L` · `risk high` · Tier B

**Why here.** It is the only milestone that pays for M6, and it is blocked on it entirely: visual
motion needs to know which run the caret is in, and at a boundary that is an affinity question
before it is a geometry question.

It needs a per-row ordered run list, which per-offset x cannot supply. Two honest options. **Port
CodeMirror's `bidiOrdering`** (`references/codemirror5/src/util/bidi.js`, 215 lines, pure logic,
unit testable with no DOM) — cheaper and far more testable, but it models no explicit embedding
controls, caps at three levels, and therefore **disagrees with what the browser painted the moment a
U+202E appears** — on exactly the trojan-source lines this editor already flags
(`packages/editor/src/unicodeHighlight.ts:5-12`). Or **probe the engine**: a collapsed range returns
more than one client rect exactly at a direction boundary and one everywhere else — measured across
the whole corpus, and already the observable this plan's injectivity criterion is written against —
so the run boundaries of a row are recoverable by reading the boundaries the lazy plan already
resolves, with no extra concept, and they always agree with what was painted. The probe is the
honest choice for a codebase whose whole bidi strategy is "the engine already ran the algorithm";
the port is the cheap one. Decide explicitly and record it.

It also forces the vertical-goal change. `SelectionGoal.horizontal(x)`
(`packages/editor/src/selections.ts:9-20`) is named `x` but holds a **cell column** produced by
`visualColumnForOffset` (`virtualizedTextViewLayout.ts:260-274`) and consumed by
`offsetForViewportColumn` (`:277-297`), both of which are tab-expansion arithmetic over the display
string. Under bidi, cell index is not x divided by cell width. Changing it touches
`verticalMoveGoal` (`packages/editor/src/editor/navigationTargets.ts:355-372`), both transforms,
`offsetByDisplayRows`, and `inputSelectionController.ts:2736-2746`. **This is Tier B and not a Tier
A bug** — logical-column vertical motion is what Monaco does, so it is correct by parity today and
only becomes wrong once motion is visual.

Finally it is a product decision, not only an engineering one: CodeMirror gates the whole behaviour
behind `option("rtlMoveVisually", !windows)` (`references/codemirror5/src/edit/options.js:83`) —
visual on macOS and Linux, logical on Windows, matching the two platform conventions. Whatever this
editor chooses must be an option with a platform default, not a hardcode.

**Exit criteria.** Left and Right arrows move the caret one glyph left and one glyph right on screen
on every corpus line, including across direction boundaries and through `nested`'s level-2 run,
matching the CodeMirror truth table. Home and End remain logical (both references agree; that is
correct and unchanged). A run of Up/Down through lines of alternating direction keeps the caret
within 1px of its starting x, asserted against the oracle rather than against a column index. The
behaviour is behind an option whose default is visual on macOS and Linux and logical on Windows, and
the logical path is the Tier A behaviour byte for byte.

- [ ] **A per-row bidi run list, derived from the engine or ported, with the choice recorded**
      `high` `L`
- [ ] **Visual `cursorLeft`/`cursorRight`/`selectLeft`/`selectRight` behind a platform-defaulted option**
      `high` `M` — `packages/editor/src/editor/navigationTargets.ts:123-143`, `:145-163`.
- [ ] **`SelectionGoal.horizontal` carries a pixel x**
      `high` `M` — `packages/editor/src/selections.ts:9-20`,
      `virtualizedTextViewLayout.ts:260-297`, `navigationTargets.ts:228-241`, `:355-372`,
      `inputSelectionController.ts:2736-2746`.
- [ ] **Word-left/right: accept logical, or make visual with the same option**
      `medium` `M` — `navigationTargets.ts:129-136`, `:166-226`. Monaco accepts logical. Decide and
      record; do not leave it ambiguous.

---

## De-scopings

Carried here so an executing agent does not re-expand scope. Each is a decision, not an omission.

- **No injectivity of the offset→x map, in Tier A or Tier B.** Not softened — *removed*, because it
  is unreachable. Measured on `nested`: offsets 4 and 7 have the position sets `{33.61, 58.83}` and
  `{33.59, 58.81}` — the same two screen points — so every rule that picks one x per offset collides
  them, leftmost and rightmost and sticky-before and sticky-after alike. The same holds for offsets
  8 and 12 on `mixed`. What Tier A guarantees instead is the criterion M2 states: distinct x for
  every pair of offsets whose collapsed range returns exactly one rect, and a pinned list of the
  direction boundaries where the collapse is intrinsic. Under `offsetForX` the two x's of a
  colliding pair differ by less than a device pixel — `nested` 4 at 33.61 against 7 at 33.59 — so
  which one a click reaches is settled by sub-pixel rounding rather than by anything the user did or
  the editor knows, and under M4 the engine picks one and this plan accepts either (see M4's twin
  allowance). That is the affinity gap, and it is Tier B's to close.
- **No Unicode Bidirectional Algorithm implementation in Tier A.** Neither reference lays text out;
  the engine already ran the algorithm and painted the result. Any reimplementation disagrees with
  what was painted the moment an explicit override, an isolate, or an unhandled level appears — and
  this editor already detects those as suspicious characters. Tier A never needs run boundaries at
  all; Tier B needs them and must choose its source explicitly (M7).
- **No `unicode-bidi: isolate` on token spans**, despite Monaco doing it
  (`references/vscode/src/vs/editor/common/viewLayout/viewLineRenderer.ts:1019-1021`). Isolating
  each RTL-containing token span reorders the words whenever an RTL stretch crosses a token
  boundary. Monaco accepts that because isolation is what keeps its `CharacterMapping` part indices
  monotone; we have no such constraint, and adopting it would make our rendering worse than it is
  today.
- **No paragraph-direction detection and no RTL editor mode.** The editor's paragraph direction stays
  LTR; the gutter, the scroll direction and the layout are not mirrored. Both references default
  this way — CodeMirror's direction is a document option
  (`references/codemirror5/src/edit/options.js:164`) and Monaco's is decoration-driven and
  content-blind (`references/vscode/src/vs/editor/common/viewModel/viewModelImpl.ts:856-873`). Code
  is written in an LTR frame. Note the consequence, since M4 measured it: because the paragraph is
  LTR, the engine resolves a point in the outer half of the visually-first glyph of an RTL row to
  logical offset 0 — *inside* the row's text extent, not outside it, which is why M4's clamp is
  keyed on the engine's answer being far from the click rather than on the extent. M4 clamps that;
  do not "fix" it by flipping the paragraph direction.
- **No secondary caret in Tier A.** CodeMirror draws one
  (`references/codemirror5/src/display/selection.js:52-59`); it is cheap to mount and needs no model
  change, which is exactly why it is tempting. It is ruled out because it shows the reader two
  candidate positions while the model holds one, implying a distinction the editor cannot honour
  when the next keystroke inserts text. It arrives with affinity in M6 or not at all.
- **`SelectionGoal.horizontal` keeps holding a cell column through Tier A**
  (`packages/editor/src/selections.ts:9-20`, `virtualizedTextViewLayout.ts:260`). The field is
  misleadingly named and an agent will want to fix it; do not. Logical-column vertical motion is
  Monaco parity and is only wrong under visual motion (M7).
- **The minimap stays LTR.** `packages/minimap/src/renderer.ts` steps `dx` left-to-right per code unit
  into a canvas from a pre-rendered character sheet; RTL text draws mirror-image of the editor. At
  minimap scale this is cosmetic. Won't-fix.
- **Indent guides and gutters stay `column × characterWidth`** —
  `packages/scope-lines/src/index.ts:251`. Indentation is
  ASCII whitespace by definition, so the *column* is right even on an RTL line; only the side may
  not be. Low value, no dependency on anything here.
- **Wrap points stay direction-blind.** `createWrapMap` breaks at cell counts. Each wrapped row is its
  own block and gets its own bidi paragraph, which is what a hard break would produce anyway. An
  approximation, not a defect.
- **Inline widgets inside an RTL run keep the LTR back-chain placement**
  (`virtualizedTextViewGeometry.ts:985-1009`). Fixing it requires the run direction Tier A
  deliberately avoids computing, and the triggering case is markdown WYSIWYG inline replacements
  plus RTL text. Note this is *not* the same as the element-boundary hole M2 closes: M2 makes the
  boundary *readable*, this de-scoping is about where the widget's own box is placed.
- **No shaping-aware grapheme measurement.** `measuredTextSegmentRect` (`:1221`) and `firstRangeRect`
  (`:1359`) take `rects.item(0)`. Under Arabic or Indic shaping a range interior to a shaped cluster
  can report the whole cluster's rect or a zero-width one. See Risks — this is recorded as
  unverified, not as planned work.
- **Popup anchoring is unchanged.** `rangeClientRect`
  (`packages/editor/src/editor/inputSelectionController.ts:1496-1508`) takes `getClientRects()[0]`,
  anchoring hover, completion and signature-help on the first visual fragment of the range. Monaco
  does the same.
- **Horizontal chunk windowing is disabled for bidi lines, not made bidi-aware** (M5). It cannot be
  made bidi-aware; that is a property of the UBA, not of our implementation.
- **The calculated fast path is untouched, and provably so.** `isSimpleRowCodeUnit`
  (`virtualizedTextViewGeometry.ts:1388`) admits only tab and U+0020–U+007E, every RTL character and
  bidi control is above U+007E, and bidi is per-row — so `buildCalculatedRowGeometry`,
  `calculatedXToOffset` (`:645`), `KEY_COLUMN_DISTANCE` anchoring (`:34`) and the whole
  `column × characterWidth` machine can never see bidi text. Do not add a direction branch to any of
  them.

---

## Risks

What could make the estimate wrong, most load-bearing first.

- **The two-rect boundary has no correct answer without affinity, and that may not survive review.**
  This is the single biggest scope risk in the plan. Every Tier A exit criterion is stated as
  "matches the oracle's leftmost rect" rather than "is the correct caret position", because at a
  direction boundary there are two correct positions and the engine returns both sorted by x,
  declining to rank them. The visible consequence is measured and named in "The two ceilings": click
  the right edge of an embedded Hebrew word in an LTR line and the caret appears at its left edge,
  33px away. If a reviewer rejects that as the answer, Tier A does not close and Tier B becomes
  mandatory — turning an `M`-sized programme into an `XL` one. **Get agreement on this before M2,
  not after.**
- **The node-addressing rule is a hidden coupling between rendering and geometry.** Two text nodes
  meeting at a direction boundary give answers 25.22px apart for the same offset (M1). Today RTL
  rows are almost always a single text node — `createRenderedChunkParts` splits only at C1 controls
  and inline widgets — so the coupling is latent. M5 deliberately introduces many seams to make long
  lines affordable, at which point the stride becomes semantically load-bearing. This is the most
  likely place for a defect to appear months later, in a change that looks like a rendering tweak.
- **Shaping is unverified in both directions.** The survey work for this plan could not reproduce
  Arabic shaping: headless Chromium on the test machine renders `مرحبا بالعالم` at a uniform
  8.39–8.42px advance per code unit under `font-family: monospace`, one rect per character, isolated
  forms, no shaping. So it is not known whether a `Range` interior to a shaped cluster reports the
  cluster rect, a proportional slice, or zero width — and `measuredTextSegmentRect` (`:1221`) takes
  `rects.item(0)` either way. Two consequences: exit criteria must compare our answer to the
  **browser's own answer on the same machine** and never to a hardcoded pixel, or CI and a developer
  laptop with real fonts will disagree; and if shaping does report cluster rects, per-grapheme
  measurement inside Arabic ligatures needs work this plan has not scoped.
- **RTL rows roughly double their layout reads, and each read is linear in its text node.** Today one
  unit rect answers both of a unit's boundaries. Under M2 each boundary costs its own
  collapsed-range read, while the unit rect is still needed for width — and the per-read cost is
  2.7µs at 100 code units, 31µs at 2 000 and 711µs at 50 000 in one node. The lazy plan means only
  requested boundaries are read and the gate confines all of it to RTL rows, but a document that is
  entirely Hebrew pays it on every row. M5's bounded text nodes are what keep it flat. Measure
  before and after; do not assume.
- **`resolveRowGeometry` is the sweep that must never run on a bidi row.** It is the only whole-row
  boundary read in the file and `offsetForX` is its only caller. M4 exists to keep it unreached and
  asserts so; if a future change reintroduces a caller, a 50 000-character Hebrew line goes from
  20µs per click to tens of seconds with no test failing unless that assertion is kept.
- **Un-chunking removes the only long-line windowing defence for bidi lines** (M5). A 100k-character
  Hebrew line renders whole. There is no third option: a windowed bidi line is not slow, it is
  wrong. The length ceiling is in M5's item list rather than deferred to "a different feature",
  because without it the milestone is a hang.
- **The `containsRTL` classifier is a correctness dependency, not a heuristic.** A false negative
  leaves a line on the LTR path silently. Monaco's generated regex
  (`references/vscode/src/vs/base/common/strings.ts:674`) covers R and AL characters and **does**
  include U+200F, but omits U+200E and U+202A–U+202E and U+2066–U+2069, because Monaco's flag
  answers a different question. A U+202E in otherwise-Latin text reorders it, and that is precisely
  the trojan-source case this editor already flags. Composing with `isSimpleRowText` makes an
  omission survivable — every control is above U+007E, so such a row at least leaves the calculated
  fast path — but the gate itself must list them, and `INVISIBLE_CODE_POINT_DATA` already holds all
  eleven.
- **The hit-test seam is wider than it looks** (M4). Every mouse consumer in three packages funnels
  through `textOffsetFromViewportPoint`, and the client point currently dies inside
  `viewportPointMetrics`. The change is mechanical but touches drag-select, hover, and document
  links, and drag-select has its own anchor-remembering logic that a coordinate-space change can
  disturb.
- **The engine's two point-to-caret APIs are not interchangeable.** `caretPositionFromPoint` and
  `caretRangeFromPoint` return different offsets in a 0.25–0.75px band at every glyph midpoint, and
  `hitTestNodeFromPoint` (`virtualizedTextViewHelpers.ts:496`) prefers the first with the second as
  a fallback. A criterion phrased against one API is not reproducible through the helper on a
  browser that only has the other.
- **The completed parity programme's record predicts bugs in this work.** Its milestone notes
  recorded real defects the review caught in each milestone's own changes —
  several of them invisible to the test suite at the time. This plan's own first draft is another
  data point: three of five Tier A milestones had exit criteria that were unreachable, blind to a
  regression they caused, or tautological. Budget a review pass per milestone, and assume the first
  version of the collapsed-range path has an off-by-one at row and chunk edges.
- **Tier B's cost is dominated by a field, not by an algorithm.** If M6 is scoped as "add an
  affinity field", it will be estimated at `S` and cost `XL`. The cost is every consumer of
  `Selection<T>`: anchors, history, LSP sync, snippets, multi-cursor normalization, the dedupe key,
  and drag anchoring — and none of them can be tested for affinity by a test that does not already
  know bidi exists.

---

## Sequencing notes

**Strictly sequential within Tier A, and the order is not the order of the first draft.**
M1 before everything (no oracle, no verification, and its tab fix is a corpus prerequisite).
M2 before M3, and **M2 and M3 ship as one unit**: M2 corrects boundary x's, which makes every
`min`/`|Δ|` span whose other endpoint is a direction boundary worse, and M3 is what removes that
arithmetic. M3 before M4 only for tidiness; they touch disjoint concerns. M4 before M5, because M4
removes the whole-row boundary sweep that M5's un-chunked rows would otherwise trigger on every
pointermove. M5 last.

**Files touched, for worktree planning.** M1: `packages/editor/test/**` plus one function in
`virtualizedTextViewGeometry.ts`. M2: `virtualizedTextViewGeometry.ts`,
`virtualizedTextViewHiddenCharacters.ts`, plus a new classifier module.
M3: `virtualizedTextViewGeometry.ts`, `virtualizedTextViewSelectionLayer.ts`,
`virtualizedTextViewHiddenCharacters.ts`. M4: `virtualizedTextView.ts`,
`virtualizedTextViewRows.ts`, `virtualizedTextViewHelpers.ts`, `virtualizedTextViewGeometry.ts`.
M5: `virtualizedTextViewRows.ts`, `virtualizedTextViewGeometry.ts`.
M2, M3 and M4 all edit `virtualizedTextViewGeometry.ts` and must not run concurrently. Nothing in
Tier A parallelises usefully; do not open worktrees for it.

**Tier B is a separate programme with a separate decision.** M6 → M7 strictly, and M6 alone is
negative value. If Tier B is not funded, close it `[~]` with the reason "Monaco declined this too"
rather than leaving it open — an open Tier B invites an agent to start M6 on the reasoning that
affinity is "just a field".

**Total honest sizing.** Tier A is `S + L + M + L + L`. It has grown twice, and both times because
work was found rather than added: `S + S + M + M + M` in the first draft, `S + M + M + M + M` after
the review moved real work into M1 (the tab change is a rendering change, not a test), into M2 (the
node-addressing rule, the classifier and its memo, the unit-rect marker, the row-width read) and
into M5 (bounded text nodes and a length ceiling), and `S + L + M + L + L` after the verification
pass counted what those milestones actually hold:

| milestone | items | rating | why not one size smaller |
|---|---|---|---|
| M1 | 3×`S` | `S` | unchanged; three small items, one of which is a rendering change (hence `risk medium`) |
| M2 | 2×`M` + 4×`S` | `L` | the milestone the review loaded up; the addressing rule alone is flagged as the item most likely to be under-budgeted |
| M3 | 1×`M` + 2×`S` | `M` | unchanged, and the only Tier A milestone whose contents did not grow |
| M4 | 2×`M` + 2×`S` | `L` | a coordinate-space change across three packages, plus a clamp that now carries a per-row extremal-boundary resolution and a memo (was `S`, fired on nothing) |
| M5 | 2×`M` + 1×`S` | `L` | grapheme-aware node splitting, a recorded seam decision, a ratio budget and a measured length ceiling |

`S + M + M + M + M` was reported as "comparable to one of the parity programme's mid-sized
milestones". At `S + L + M + L + L` that is no longer true: Tier A is closer to two of them. It is
still smaller than the TODO at `virtualizedTextViewGeometry.ts:327-329` implies, because all three
things that TODO names (caret positions, hit testing, selection widths) have their correct
implementation sitting unused in the same file. **The minimum honest ship, M1 + M2 + M3, is
`S + L + M`** — and that is the number a reviewer funding a first slice should be given, not the
Tier A total. Tier B is `XL + L` across the editor core — still roughly twice Tier A, entirely in
the part the TODO does not mention, and the part the primary reference chose not to build.

---

## Review

This plan has been through two adversarial passes, in this order: a **review** that attacked the
first draft, and a **verification pass** that read the revised draft fresh, re-checked its citations
and re-ran its measurements on a different machine. The review's findings and their dispositions are
first; the verification pass, which returned NOT-EXECUTABLE on one named criterion, is at the end of
this section. An executing agent should read the whole section as the map of where the sharp edges
are, and should read the verification pass in particular as evidence that "a fix was added in
response to a finding" is not the same as "the finding is closed".

### Review pass

This plan was attacked by a reviewer who verified roughly thirty citations by reading and ran
Playwright probes against the design in headless Chromium. Every measurement below was re-run
independently before being accepted or rejected; the scripts live alongside this work and the
conditions are in "Measurement conditions".

**Accepted, and what changed.**

1. **M3's (now M2's) two exit criteria were mutually exclusive.** Confirmed and then strengthened.
   "Leftmost collapsed rect" and "no two offsets share an x" cannot both hold: on `nested` offsets 4
   and 7 come back at 33.61 and 33.59. Re-measuring showed the reviewer understated it — the
   collision is not an artifact of choosing *leftmost*. Offsets 4 and 7 have the position sets
   `{33.61, 58.83}` and `{33.59, 58.81}`: the same two screen points, so leftmost, rightmost,
   sticky-before and sticky-after all collide. Injectivity is unreachable under any rule.
   **Changed:** the criterion is replaced by "no two offsets whose collapsed range returns exactly
   one client rect share an x", plus a pinned list of the intrinsic collisions. That version fails
   today on five of seven corpus lines and passes after M2, so it names the defect instead of
   describing an aspiration. The claim "after M3 the map is injective again" is deleted wherever it
   appeared, and with it the stated reason the old M5 demoted to a refinement — which is why hit
   testing (now M4) moved up the order (see 4).
2. **The collapsed-range answer depends on which DOM node the boundary is addressed from.**
   Confirmed: `אבג ` / `123 דהו` as two nodes give 58.83 and 33.61 for the same offset, 25.22px
   apart. **Changed:** the tie-break is no longer "a comment correction plus a test" — M2 carries an
   explicit addressing rule, matched to Monaco's (`CharacterMapping.getDomPosition`, which addresses
   from the part holding the character at that column), and M1's oracle is required to resolve
   through `domBoundaryForOffset` on the mounted row. Re-measuring also turned up something worse
   than the reviewer found: a collapsed range at an *element* boundary — what `elementBoundary`
   returns for control glyphs and inline widgets — returns **zero** client rects, so those
   boundaries have no answer at all under the first draft's design.
3. **M3 (now M2) makes whitespace markers worse while its criterion cannot see it.** The conclusion
   is right and the criterion was indeed scoped past the failing case. **Changed:** M2 stops
   deriving a one-glyph box from two boundaries and takes the unit's own rect, which is exact to
   ≤0.02px on every whitespace character in the corpus. The criterion now covers every whitespace
   character on every corpus line and bounds the marker's width at one glyph advance.
4. **M5's (now M4's) two criteria contradict, and the engine disagrees with itself at line edges.**
   Confirmed: on `nested` in a 600px row, `caretPositionFromPoint` returns offset 0 for the leftmost
   4.2px, and offset 0's own rect is at 92.42. **Changed:** M4 gains an explicit clamp outside the
   row's measured text extent, its tolerance band is stated around *every* boundary x rather than
   only direction boundaries, and the tautological criterion is replaced by one asserted against a
   per-glyph rect table, which can see a bug in `offsetFromDomBoundary`. **The clamp half of this
   was wrong and is superseded — see the verification pass below.** It was keyed on the point being
   outside the row's text extent, and every measured band is inside it.
5. **M2 (now M5) is well over its stated effort.** Confirmed, and by a wider margin than the review
   claimed. `shouldChunkLine` does become O(n) on a per-snapshot path, and RTL rows do lose the
   50-code-unit node splitting as well as the chunk window. The measurement that settles it: a
   collapsed `getClientRects()` on a 50 000-code-unit Hebrew text node costs 711µs, against 2.0µs
   for the same text in 50-code-unit nodes. `resolveRowGeometry` reads one per grapheme, so one
   `xToOffset` on that row is ≈35 seconds. **Changed:** the milestone moved from second to last;
   bounded grapheme-aware text nodes and a length ceiling became items rather than a deferred
   "different feature"; the classifier memo became a prerequisite built in M2; and the exit criteria
   include a measured per-operation budget, because nothing else can see this defect. **That budget
   was self-referential and is now a ratio against an equal-length Latin control row — see the
   verification pass below.**
6. **The CodeMirror citation for the collapsed-range design says the opposite.** Confirmed by
   reading: `position_measurement.js:241-242` reads a side off a non-collapsed single-character
   rect, and `cursorCoords` picks that side from `getBidiPartAt` after computing `getOrder`.
   **Changed:** the citation is deleted and replaced by an explicit warning, and Monaco's
   `getDomPosition` path is documented in its place as the only reference that supports this design.
7. **`MeasuredUnit.node` is null for two of the three unit kinds.** Confirmed at `:861` and `:877`,
   and the consequence is worse than "needs a second path" — see 2. **Changed:** it is now an M2
   item in its own right, flagged as the one most likely to be under-budgeted.
8. **M4's (now M3's) "two rectangles" criterion fails on correct output.** Confirmed: `nested`
   `[4,8)` returns `25.20 w8.41` and `33.61 w25.22`, which abut exactly and coalesce correctly under
   the 0.9px rule. **Changed:** the criterion names `nested` `[2,6)` (an 8.41px gap, genuinely two
   rects) and records `[4,8)` as the case that must *not* be asserted as two.
9. **"M1 adds tests only" is wrong.** Confirmed by reading: the tab fix changes rendering and
   measured advance on every line mixing a tab with a non-ASCII character, and the only existing
   coverage pins `␀`/`␡`. **Changed:** M1's risk is now `medium`, the item says so, and the exit
   criterion additionally asserts the tab's advance reaches the tab stop.
10. **Small factual corrections.** All confirmed.
    `packages/editor/test/suspiciousCharacters.test.ts:19-21` does define U+202E/U+2066/U+2069, so
    "no RTL character anywhere in `packages/`" is narrowed to source and CSS;
    `INVISIBLE_CODE_POINT_DATA` (`unicodeHighlightData.ts:33`) was verified to hold all eleven bidi
    controls and the classifier is now told to reuse it rather than re-derive them; Monaco's regex
    **does** include U+200F, so that sentence is corrected while its conclusion stands;
    `rowTextLeftForOffset` is at `:2642`.
11. **"Every milestone strictly reduces the set of wrong pixels" is false.** Accepted, though the
    reviewer's counterexample does not hold up and a better one does. The reviewer offered `nested`
    @3, where the marker goes from `33.61 w25.22` to `33.61 w33.61` — wider, but the wrongly-painted
    region is unchanged at 25.22px and the missed glyph goes from 8.41px to zero, so the symmetric
    difference against the true box `58.83 w8.41` *falls*, from 33.63 to 25.24. The real
    counterexample is `mixed` @12: today `100.83 w8.39`, which is correct; after correcting only the
    boundary at 13, `67.22 w42.00`, a bar over the neighbouring Hebrew word. **Changed:** the
    sentence is deleted, the sequencing argument is restated around shipping *units* rather than
    milestones, and M2+M3 is declared one unit with the known-wrong values pinned in M2 so M3 has
    something to flip.

**Rejected, with the evidence.**

- **"RTL rows always split into multiple nodes because they fail `isSimpleRowText`"** (part of finding
  2). The opposite is true, and it matters. Failing `isSimpleRowText` routes a row to
  `createRenderedChunkParts` (`virtualizedTextViewGeometry.ts:225`), which appends a new text part
  only at an inline widget or a C1 control character (`appendRenderedText`, `:264-298`;
  `controlCharacterInfo`, `:1440`, matches only 128–159). It is the *simple* path,
  `createSplitTextChunkParts` (`virtualizedTextViewRows.ts:1659`), that splits every 50 code units.
  A plain Hebrew line is one text node today. The seam problem is therefore latent rather than
  universal — it bites at control glyphs, inline widgets, and chunk edges — and the plan says so.
  The finding's *other* half, that the tie-break is a live semantic decision and the oracle must go
  through the row's own DOM, is accepted in full, and M5 makes the seam problem universal on long
  lines on purpose.
- **"The two APIs disagree by one glyph at every glyph midpoint"** (part of finding 4). Measured in
  0.25px steps across `nested` and `mixed`, `caretPositionFromPoint` and `caretRangeFromPoint`
  return the same offset everywhere except a 0.25–0.75px band at each transition, where the range
  API switches later. The reviewer's three sample points (x=4.5, 29.5, 88.5) all sit inside such a
  band. The conclusion — that a criterion phrased against one API is not reproducible through
  `hitTestNodeFromPoint` — is accepted and acted on; the characterisation is not, and an agent told
  to expect a one-glyph systematic offset would go looking for a bug that is not there.
- **"M5 (now M4) regresses M2, so re-scope it or close it `[~]`."** The measured facts behind this are
  accepted — the edge bands are real and M4 now clamps for them — but the recommendation is
  rejected. Nearest-boundary hit testing is not a viable fallback on the rows this plan creates:
  with M5's un-chunking, `resolveRowGeometry` costs ≈35 seconds on a 50 000-character Hebrew row and
  ≈62ms on a 2 000-character one, against 20µs and a few µs for the engine's hit test. M4 is the
  only reason M5 is affordable at all, which is why it moved *earlier* rather than being cut.
- **"M3's diagnosis of today's collision is right in substance but its gloss is inverted"** — accepted,
  and noted here only because it is the one place where accepting the correction changed prose
  rather than design. The corrected sentence is in "What the editor does with RTL text today".

**Kept deliberately, because the review endorsed them and they are load-bearing.** The substrate
reading and its citations; the Tier A / Tier B split; the refusal to ship a secondary caret without
affinity; the rule that every criterion compares to the browser's own answer on the same machine and
never to a hardcoded pixel; the unreproduced-shaping refusal stated as a risk rather than resolved
by guessing; and "half-done Tier B is worse than nothing — do not start unless funded to finish".

### Verification pass

A verifier then read the revised plan fresh, re-verified roughly forty `file:line` citations by
reading them, and re-ran every load-bearing measurement in its own headless Chromium on a machine
about 2× slower than the one the plan was measured on. All ratios reproduced; absolute microsecond
figures differ by that factor and both are now recorded where a criterion depends on them. Nine of
the eleven review findings above were re-measured and confirmed closed, including the two the
reviewer had partly wrong (the node-splitting claim and the "every milestone reduces wrong pixels"
counterexample), and every citation checked landed. Finding 7 was found closed in design but not in
its criteria — see the sharp edges at the end of this section — and finding 4 was found not closed
at all. **The verdict was NOT-EXECUTABLE, for that one reason.**

**The blocking finding: M4's clamp was papered over, not implemented.** The review's finding 4 —
that the engine's hit test disagrees with its own caret rect at a line's visual edges — was
accepted, its measurements were recorded correctly, and a clamp was added. The clamp fired on
nothing. It was keyed on "the point is outside the row's measured text extent", and every measured
misfire band is *inside* the extent: `nested`'s extent is `[0, 92.44]` and the bad bands are
`[0, 4]` and `[88.25, 92.44]`, the outer half of the visually-first and visually-last glyph. The
criterion then contradicted itself in one sentence — it filed `xToOffset(row, 2)` under the
out-of-extent clause while x=2 is inside the extent — and its worked example failed its own stated
tolerance by 2.0px even if the clamp had fired. A criterion an executing agent cannot write a
failing test for is worse than no criterion, because it looks like a gate and is not one.

**Both the design and the criterion were changed, and the design first.** Fixing only the criterion
was not available: there was no implementation for a corrected criterion to gate. M4 now specifies

- a **trigger** keyed on the defect — the engine's answer is discarded when that offset has no client
  rect within one character advance of the sampled point — with the measured separation that makes
  it safe (legitimate answers ≤ 1 advance, every misfire ≥ 25px);
- a **fallback** to the row's extremal boundary on that side, resolved in O(1) per row and memoized,
  which is what `offsetForX` already returns at its own endpoints;
- **three exit sweeps over disjoint x ranges** — interior, edges, and the trigger's own firing set —
  so no x is governed by two criteria and none can be passed by the implementation another
  describes;
- a **twin allowance** in the interior sweep, read from the collision list M2 already pins. M4 had
  never referred to that list, and without the allowance the criterion is unpassable at `nested`
  x∈[29.5,32.5], where the table predicts 7, the engine answers 4, and the two occupy the same two
  screen points.

M4's effort went `M` → `L` and the clamp item `S` → `M` with it.

**Two things in the verifier's proposed remedy were checked and not taken.**

- **"Otherwise take the boundary whose x is nearest the point" is the sweep this milestone forbids.**
  Nearest-boundary over a row *is* `offsetForX` → `resolveRowGeometry`, which M4's own third item
  exists to keep unreached and which costs ≈35 seconds on the 50 000-character rows M5 creates.
  Adopting it would have closed the criterion by reintroducing the defect the milestone is for. The
  O(1) extremal-boundary resolution replaces it, and it is sufficient for a measured reason: the
  trigger fires only within a half-advance of a visual end of the row. That fact is now itself an
  exit criterion, so the assumption fails loudly if a browser update breaks it.
- **The trigger must compare against the offset's whole position set, not its leftmost rect.** Stated
  as "that offset's own leftmost x", the trigger misfires on the twin bands the same remedy asks us
  to accept: at `nested` x=61 the engine answers 7, whose leftmost rect is 27px away and whose
  second rect is 2px away. The leftmost-only form discards a good answer and clamps to a third,
  wrong offset. This is a one-word correction to the rule and it is load-bearing.

**The smaller items, all closed.**

- **M5's budget criterion was self-referential** — "within a stated per-operation budget measured on
  the machine running the test" is passed by writing a large number. It is now a **ratio**: mount,
  click and a 200-sample drag on a 6 000-character Hebrew line, each within 5× the same operation on
  a same-length Latin line mounted un-chunked through the same forced path. The ratio is anchored by
  the measurement the verifier reproduced — 1.5–2.0µs per read with bounded nodes against
  711µs/1 644µs on one unbounded node, a 300–800× defect — so 5× sits two orders of magnitude below
  what it must catch and well above per-read noise. The M5 length ceiling is likewise re-anchored to
  the length at which that ratio first fails, measured rather than guessed.
- **The `orderByX`/`offsetForX` tie-break was unspecified.** It is x-dependent, not a property of the
  pair: `nested` 4 sits at 33.61 and 7 at 33.59, so sampling 33.61 gives 4 and sampling 33.59 gives
  7, and the exact-*distance*-tie branch that returns the lower offset is never reached on the
  corpus. M2 now names both sample points and states that the midpoint and the exact-tie branch are
  not asserted. The De-scopings entry that claimed the higher offset is "unreachable by click" is
  corrected: both are reachable, and which one a click reaches is settled by sub-pixel rounding.
- **`hitTestNodeFromPoint` is one line short of the plumbing M4 claimed already exists.** Verified in
  source: it is module-private at `virtualizedTextViewHelpers.ts:496-505` and returns `Node | null`,
  discarding `position.offset` and `range.startOffset`, while `offsetFromDomBoundary` (`:516`) needs
  both. M4's first item now says so and says what to do.
- **M5's `xToOffset(row, 0)` sampled an undefined point.** x = 0 was excluded by "strictly inside the
  extent" and not included by "outside the extent". It now falls in M4's edge band by construction,
  and M5 says so and says the criterion depends on M4 having landed.
- **M2 and M3 hardcoded pixels into criteria**, against this document's own rule at the top. The
  pinned known-wrong `rangeSegments` values in M2 and the flipped values and rect gaps in M3 are now
  expressed as multiples of the row's measured advance and as comparisons against the oracle, with
  the measured pixels kept only as parenthetical illustrations.
- **Sizing was light where the review had pushed work in.** Re-rated item by item in "Total honest
  sizing": M2 `M` → `L` (2×`M` + 4×`S`), M4 `M` → `L` (2×`M` + 2×`S`), M5 `M` → `L` (2×`M` + 1×`S`).
  Tier A is `S + L + M + L + L`, up from `S + M + M + M + M`, and the claim that it is comparable to
  one mid-sized parity milestone is withdrawn — it is closer to two. The minimum honest ship,
  M1 + M2 + M3, is `S + L + M`.

**What the verification pass confirms is solid, so an agent does not re-litigate it.** M1, M2 and M3
were found executable with criteria that measurably fail today and pass after: the single-rect
injectivity criterion was specifically attacked and held (all five collisions it must catch are
single-rect, and the post-fix collision set is empty on all seven lines); the whitespace-marker
table reproduces to the hundredth of a pixel and the unit-rect design is exact; the node-seam and
element-boundary measurements reproduce, including zero client rects on both sides of an
inline-block span; `nested` `[2,6)` and `[4,8)` reproduce exactly, so M3's choice of range is right;
`resolveRowGeometry`'s only caller really is `offsetForX` and `rangeSegments` really has one
non-test consumer.

**Remaining sharp edges, stated so they are not discovered as failing tests.**

- **The element-boundary case had no corpus line that reaches it** — the other half of finding 7,
  which the verifier called closed in design but not in criteria. Control units and widget units
  carry `node: null` and a collapsed range at an element boundary returns zero rects, both verified;
  but `override`'s U+202E is not a C1 control, `tabRtl`'s tab becomes plain text after M1, and none
  of the seven lines holds a C1 control or an inline widget, so M2's most-likely-under-budgeted item
  had no test that could fail. **Closed** by two supplementary corpus lines (`controlRtl`,
  `widgetRtl`, defined under "Measurement conditions"), an M1 item that builds them, and one M2
  criterion that uses them. They are deliberately kept out of "the corpus" so that no existing "all
  seven lines" criterion silently changes meaning. The residual sharp edge is that they are the only
  coverage of that path: if an executing agent drops them, the addressing rule ships untested and
  nothing goes red.
- **Arabic shaping is still unreproduced** on either measurement machine, and the Risks section says
  what follows from that. Nothing in the two review passes changed it.
- **The trigger's firing set is an engine fact, not a spec fact.** M4's third sweep pins it, which is
  the right response, but a Chromium update that changes where `caretPositionFromPoint` misfires
  will fail that assertion rather than any user-visible test. Read the failure as news, not as a
  bug.
