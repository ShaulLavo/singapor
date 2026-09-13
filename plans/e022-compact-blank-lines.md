# E022: Prove compact blank lines with correct geometry

- Status: Proposed
- Kind: Research
- Owner: Editor
- Priority: P2
- Effort: M
- Dependencies: [E001](../examples/stress/README.md)
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`

## Outcome

Determine whether optional shorter empty lines can show more code while preserving accurate caret, scroll, and pointer behavior.
An empty row may occupy half the normal line height, but the file text and logical line numbers remain identical.
The result is a measured prototype and a go/no-go implementation decision, including the chosen row-height representation.
It does not promise that compact layout is cheap or production-ready before the geometry work is measured.

## Current code

- [fixedRowVirtualizer.ts](../packages/editor/src/virtualization/fixedRowVirtualizer.ts) already accepts `rowSizes`
  and can derive virtual rows from a variable-height index.
- [rowHeightIndex.ts](../packages/editor/src/virtualization/rowHeightIndex.ts) stores dense sizes and prefix starts.
  Updating scans for the first change and rewrites the suffix. Its update transfers ownership of previous offset storage.
  A one-line change near the top can therefore do work proportional to the document's row count.
- [virtualizedTextViewLayout.ts](../packages/editor/src/virtualization/virtualizedTextViewLayout.ts) currently passes
  only count, row gap, and uniform height to the virtualizer. `rowTop` multiplies row by stride.
  Pointer-row lookup also uses fixed-stride arithmetic. Wiring `rowSizes` alone would leave hit testing inconsistent.
- [virtualizedTextViewGeometry.ts](../packages/editor/src/virtualization/virtualizedTextViewGeometry.ts),
  [selection painting](../packages/editor/src/virtualization/virtualizedTextViewSelectionLayer.ts), and
  [displayTransforms.ts](../packages/editor/src/displayTransforms.ts) are downstream geometry consumers.
- Existing [virtualizer tests](../packages/editor/test/fixedRowVirtualizer.test.ts) cover the retained index path.
  Text-view geometry has both happy-dom and real-browser tests.
  The wishlist correctly says no production text-row producer feeds variable sizes today.

## Scope

Compare a dense variable-height prototype with a representation that stores compact-row exceptions or runs.
Include real text-row layout, caret rendering, pointer mapping, scroll anchoring, and toggling in the Editor demo.
Use strictly empty logical lines initially. Whitespace-only lines introduce wrap and indentation-display choices that need separate evidence.
Do not fake compaction by squashing glyphs while retaining the original scroll footprint; that cannot show more code.
Editor owns reusable layout options. Platform owns any eventual preference registration and app setting UI.
Do not redesign the entire display-transform stack unless the measurements identify a necessary shared contract.
If [E031](../docs/performance/e031-projection.md) has landed, prototype against its projection/geometry
owner; do not reintroduce an eager display-row array for compact heights.

## Design

Proposed `BlankLineLayout` is disabled or enabled with a validated height ratio.
The ratio scales the measured normal line height and stays positive to preserve navigable rows and caret visibility.
Define eligible rows from document content after folding/wrapping projection, with provenance back to the logical line.
Fold placeholders, injected text, diff-only rows, and wrapped continuations keep their declared normal height in the first prototype.
The viewport model owns the projected geometry for its own document/layout revision.
Two views sharing a buffer can use different blank-line policies without altering each other's line maps.

Prototype A uses the existing dense `RowHeightIndex` as the correctness baseline.
Pass the same geometry authority to virtualizer windowing, row top lookup, hit testing, selection painting, and reveal calculations.
Do not reuse an index after `updateRowHeightIndex` has transferred its mutable prefix storage.
Keep normal layout on its existing arithmetic path when compaction is disabled.

Prototype B stores height exceptions or runs with prefix aggregates and explicit edit ranges.
Compare memory, lookup cost, insertion/deletion cost, and blank/nonblank transitions against the dense baseline.
An unchanged line must not trigger a whole-document blank-line scan on every keystroke.
Track eligibility incrementally from document edits; rebuild only when projection or policy invalidates the relevant representation.
Measure initial classification separately from typing updates and scroll lookup.
Choose the simplest representation that satisfies the measured budget, including ordinary files.

All consumers answer vertical positions from the chosen row geometry.
An empty row gets a visible, unclipped caret and a pointer target covering its actual smaller rectangle.
Vertical navigation still moves by displayed rows. Page navigation uses viewport pixels and the geometry lookup.
When toggling, preserve a document anchor and its intra-row pixel position, then recompute and clamp scroll.
Font/zoom changes invalidate scaled heights. Pending layouts publish only if their document and projection revisions still match.
Disposal releases indexes and pending classification work.

Keep minimap line density uniform in the first prototype, but calculate its viewport indicator and click mapping consistently.
If the minimap contract assumes editor pixels are proportional to logical rows, record the required adapter change.
Decide whether mirrored compaction improves navigation only after comparing the two visuals in the same fixture.

## Steps

1. Add compact-layout scenarios to [E001](../examples/stress/README.md)'s fixtures and record the normal-layout baseline.
   Include alternating empty lines, long blank runs, huge files, folds, wraps, injected rows, and edits near the top.
2. Build prototype A and route all vertical mapping through one row geometry contract.
   Prove a click, caret rectangle, and virtualized row agree before benchmarking it.
3. Build prototype B behind the same demo picker and compare results on the same document revisions.
   Record classification cost, update cost, retained bytes, scroll lookup, and paint correctness.
4. Exercise interactions in a real browser, including toggle during typing, zoom, split views, and scrolling at the bottom.
   Inspect the actual caret and row rectangles rather than relying on the height-index unit test.
5. Write a decision record with raw benchmark artifacts, chosen eligibility/minimap policies, and the required production edits.
   If neither representation meets the measured budget, keep uniform layout and state the specific blocking cost.

## Verification

- Extend `fixedRowVirtualizer.test.ts` with boundary offsets, row gaps, fractional heights, and changed prefix geometry.
  These catch off-by-one visible windows and reuse of retired index storage.
- Add model tests for one line changing between empty/nonempty, line insertion/deletion, and policy changes.
  Count classification work to catch a hidden full-document scan on each edit.
- Extend `virtualizedTextViewGeometry.browser.test.ts` and the view browser tests with compact-line fixtures.
  Verify pointer hits, caret bounds, selection bands, reveal/page navigation, and scroll anchoring against actual rectangles.
- Test folded and wrapped content, selection spanning compact rows, IME at an empty line, zoom, and a minimap-enabled demo.
  Assert logical text and document line numbers remain unchanged when compaction toggles.
- Use `bun run bench:virtualization` and `bun run bench:transforms` in `packages/editor` as existing measurement entry points.
  Run focused browser files through `bun run test --project browser`, reusing the current development environment.
- Acceptance is a measured go/no-go decision with reproducing fixtures, correct geometry, and a bounded update design.
  A production public option additionally requires built-export checks and framework consumer typechecks when implemented.

## Risks and decisions

The retained variable-height index does not make the text view variable-height ready. Fixed-stride assumptions are the main correctness risk.
Sparse indexes may save memory while making every scroll lookup slower. Measure both before choosing one.
Whitespace-only line compaction can hide meaningful indentation or wrap into several rows; keep it outside the first eligibility policy.
If caret legibility requires a minimum pixel height, derive and verify that rule in the browser rather than selecting an arbitrary ratio.
