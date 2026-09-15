# E036: Measure Monaco's view mechanisms against the calculated geometry path

- Status: Proposed
- Kind: Research
- Owner: Editor
- Priority: P1
- Effort: M
- Dependencies: [E001](../examples/stress/README.md), [E002](../docs/performance/input-latency.md)
- Inspected baseline: `5f68ce6ae086bea10d9708ed56580e173d4dfee2`, 2026-09-14; references/vscode read at the same time.

## Outcome

The view layer knows, with numbers, which of Monaco's rendering and geometry mechanisms would
move Singapore's typing, hit-test, and idle costs, and which it already has. Each candidate ends
in a measured go/no-go with a bounded follow-up. For example: a Go file indented with tabs
should place the caret and answer a click from column arithmetic, the way an ASCII file with
spaces does today, instead of resolving every row's geometry through `Range.getClientRects`.

The comparison target is the VS Code checkout under [references/vscode](../references/vscode),
read at the same time as this plan. Monaco's mechanisms are a control, not a spec.

## Current code

Singapore already has Monaco's fast path. Treat "column times width" as done, not as the win.

- [Row geometry](../packages/editor/src/virtualization/virtualizedTextViewGeometry.ts):
  `rowUsesCalculatedGeometry` picks arithmetic geometry for a row with no inline mapping, simple
  text (`isSimpleRowText` in [textCharacters.ts](../packages/editor/src/textCharacters.ts):
  printable ASCII plus tab), and no tab. Every other row is measured lazily per unit and, for
  `xToOffset` or row width, resolved as a whole (`resolveRowGeometry`, counted by
  `getRowGeometrySweepCount`). Long calculated rows re-anchor on a real advance every
  `KEY_COLUMN_DISTANCE = 300` columns, which is Monaco's `MaxMonospaceDistance` exactly.
- [Font metrics](../packages/editor/src/virtualization/browserMetrics.ts): `characterWidth` is
  the width of sixteen `m` divided by sixteen. The cache key includes device pixel ratio and the
  font properties. There is no monospace check and no ligature check: a proportional font or
  ligatures make the calculated path silently wrong, and nothing demotes a row when that happens.
- [Measurement batching](../packages/editor/src/editor/Editor.ts): `withOperation` opens a
  refcounted row-rect measurement window; `invalidateRowRectMeasurements` runs after a session
  render and after a caret reveal. Ordering of reads against writes is by convention, not type.
- [Hidden input](../packages/editor/src/editor/inputSelectionController.ts):
  `refreshHiddenInputContent` is called before caret measurement with the comment "Focused
  textarea writes flush layout". Typed text arrives through `beforeinput` or a value diff
  (`deduceHiddenInputEdit`). No EditContext path exists.
- [Caret blink](../packages/editor/src/style.css) is a CSS `steps(1, end)` animation on the
  caret layer.
- Instrumentation that exists: `getRowGeometrySweepCount`, `getRtlTextClassificationScanCount`,
  and the stress runner's `profile:input --mode trace`, which reports layout counts per call site
  ([stress README](../examples/stress/README.md)).

Monaco counterparts, for the record (paths under `references/vscode/src/vs/editor/`):

- `browser/viewParts/viewLines/viewLine.ts`: `FastRenderedViewLine` requires basic ASCII, LTR,
  monospace optimizations, no foreign elements. Tabs stay on the fast path through a per-column
  horizontal-offset table. `monospaceAssumptionsAreValid` compares arithmetic width against
  `offsetWidth` and demotes every fast line when they differ by 2px or more. The slow path keeps
  a per-column `Float32Array` pixel cache and snaps a measured x onto the arithmetic grid when
  within 1px.
- `browser/config/fontMeasurements.ts`: monospace is `|/-_ilm%` plus digits measured in regular,
  italic and bold agreeing within 0.001px, and never with ligatures on. Readings under 2px are
  marked untrusted and re-read after five seconds.
- `browser/view/renderingContext.ts`: the write phase receives `RestrictedRenderingContext`,
  which has no measurement API, so a view part cannot read layout while writing.
- `browser/controller/editContext/native/nativeEditContext.ts`: EditContext is the default input
  path; the browser reports `updateRangeStart/End` so no value diff is needed, and the editor
  feeds character bounds back for the IME window.
- `browser/viewParts/viewCursors/viewCursors.ts`: flat blink is a JS interval, not CSS, citing a
  Chromium step-timing battery issue; the caret holds solid for 500ms after any move.

Drift to check again: whether `rowUsesCalculatedGeometry` gained a tab branch, whether any
monospace probe appeared in `browserMetrics.ts`, and whether the hidden-input flush comment
still describes a forced layout on the typing path.

## Scope

Deliverables are measurements, one decision per candidate, and a short follow-up scope for each
go. Candidates, in the order to run them:

1. Tabbed rows on the calculated path.
2. Monospace and ligature verification with demotion to measured geometry.
3. Forced layout on the typing path from the hidden input refresh.
4. Measured-path per-column cache and snap-to-grid.
5. Caret blink idle cost, CSS animation versus a JS interval.
6. EditContext as the primary input route on Chromium.

Out of scope: Monaco's GPU line renderer, selection corner rounding, screen-reader paging, and
any change to the document model. The compile-time read/write split is recorded as a design idea
for the view refactor, not measured here. No candidate is implemented beyond what its
measurement needs; a go decision produces a follow-up entry.

## Design

The decision that needs evidence is whether the measured path is a cost on real files at all.
The stress fixtures are space-indented, so the calculated path may have hidden the measured
path's cost from every existing number. Step 1 answers that first.

Counters to add, in the geometry module beside `rowGeometrySweepCount`: rows built calculated,
rows built measured, and the reason a row was excluded (inline mapping, non-simple text, tab).
Report them through the stress runner alongside layout counts so a run states its row mix.

Tabs (candidate 1): the exclusion comment says CSS tab stops disagree with the estimated grid
after a horizontal spacer. The proposed fix is Monaco's: expand each tab to a run of no-break
spaces sized `tabSize - (visibleColumn % tabSize)` at render time, so the DOM advance equals the
arithmetic advance by construction and `tab-size` no longer participates. That changes row
rendering, hidden-character markers for tabs, and copy behaviour must keep the tab character.
Measure before proposing; if tabbed rows are rare in the corpus the change is not worth it.

Monospace verification (candidate 2): probe `|/-_ilm%`, digits, and space in regular, bold and
italic during `measureTextMetrics`; monospace holds when advances agree within a small epsilon
and `font-variant-ligatures` is not enabled. When it does not hold, `rowUsesCalculatedGeometry`
returns false. A cheap runtime check, one `offsetWidth` on the longest calculated row per
metrics change, demotes if the arithmetic width is off by 2px or more. This is correctness work
that the research must size; the go decision is on cost, the bug exists regardless.

Typing-path layout (candidate 3): `profile:input --mode trace` already attributes layouts to
call sites. The question is whether the hidden-input write forces a layout that the caret
measurement then pays for, and whether writing the input after the caret read removes it.

## Steps

1. Row-mix baseline. Add the calculated/measured/exclusion counters and print them from the
   stress runner. Run the input-latency and scroll suites on the existing fixtures, then on two
   added fixtures: a tab-indented Go or C file of comparable size, and a Markdown file with
   inline replacements. Evidence: a table of row mix and sweep counts per fixture.
2. Tabbed rows. Prototype no-break-space tab expansion behind a flag on a branch; confirm
   `bufferColumnToVisualColumn` already yields the same columns. Run step 1's suites with the
   flag on and off on the tab fixture. Evidence: hit-test and caret-move latency, layout counts,
   and the browser geometry tests passing with the flag on.
3. Monospace verification. Add the probe set and the demotion check. Measure the added cost of
   `measureTextMetrics` and confirm a proportional font and a ligature font each demote. Evidence:
   the probe cost in microseconds, and two browser tests that fail without the check by placing
   the caret at the wrong x.
4. Typing-path layout. Trace the typing suite, attribute every forced layout, and try reordering
   the hidden-input write after the caret read. Evidence: layout count per keystroke before and
   after, and the E002 gate unchanged or better.
5. Measured-path cache. On the Markdown and RTL fixtures, count units resolved per hit test with
   and without a per-row resolved-x cache that survives across queries within a revision, plus
   snap-to-grid for ASCII rows that fell to measurement only because of a tab. Evidence: units
   resolved and time per query.
6. Blink idle cost. Record GPU process and renderer CPU over 30s idle with the caret visible,
   with the CSS animation and with a JS interval toggling visibility. Evidence: the two readings,
   same machine, same session, interleaved.
7. EditContext spike. On Chromium, route typing and IME through EditContext behind a flag,
   keeping the textarea for screen readers. Run the composition suites. Evidence: which of the
   deduced-input cases in `inputState.ts` become unreachable, and composition latency.
8. Decision record. One row per candidate: measured delta, go or no-go, follow-up scope.

## Verification

- Step 1 is the acceptance gate for continuing: if measured rows are under 5% of rendered rows
  on every fixture including the tab and Markdown ones, candidates 1, 4 and 5 are no-go without
  further work and the record says so.
- Existing entry points: `bun run test` in `packages/editor` (the `browser` project runs the
  `*.browser.test.ts` geometry, long-line, bidi and IME suites), `examples/stress` `bench:input`,
  `profile:input`, and `input:compare` for isolated build comparison.
- New tests, each named for the failure it catches: a browser test that a tab-indented row places
  the caret at the same x as the measured path (catches a wrong visible column after a tab); a
  browser test that a proportional font demotes to measured geometry (catches a caret drawn at
  the wrong x with no error); a trace assertion that a keystroke forces at most the recorded
  number of layouts (catches the hidden-input flush returning).
- Every performance number is a before/after under the same runner, browser, and fixture, with
  the previous build as the control, following E002's isolated-build procedure.

## Risks and decisions

- Tab expansion changes what the DOM contains. Copy, find highlights, and hidden-character
  markers must see one tab character, not spaces. If that leaks, stop and keep tabs measured.
- The monospace probe runs on every font change. If it costs more than a frame it must move off
  the first-paint path per E003.
- EditContext is Chromium-only. A go means two input routes for the foreseeable future; the
  decision must weigh that against the deduced-input cases it removes. It also matters for any
  non-DOM host later, because it is the API shape a native host would implement.
- Monaco demotes globally on one violated line. A per-row demotion is cheaper to reason about
  but leaves the average-width drift; the anchor mechanism already caps that. Decide in step 3.
- Stop condition: if step 1 shows the calculated path already covers the corpus and step 4 shows
  no forced layout per keystroke, the remaining candidates are recorded as no-go and this entry
  closes with the counters as its lasting deliverable.
