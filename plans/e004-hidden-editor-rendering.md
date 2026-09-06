# E004: Suspend rendering in zero-height views

- Status: Implemented
- Kind: Implementation
- Owner: Editor
- Priority: P2
- Effort: S
- Dependencies: [E001](e001-stress-fixtures.md)
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`

## Outcome

A hidden retained editor keeps its document and view state while mounting no text rows and
registering no token ranges. Revealing it restores the correct scroll position, selection, and
highlighting without requiring an edit. An editor at the end of a visible document still renders
its final line normally.

## Current code

- [computeFixedRowVisibleRange](../packages/editor/src/virtualization/fixedRowVirtualizer.ts)
  still clamps a nonempty document's range to at least one row. Its overscan path can expand that
  range even when measured viewport height is zero.
- The same module already supports optional `rowSizes` and measured scroll geometry. Cover both
  fixed and indexed row paths instead of changing only the arithmetic helper.
- [VirtualizedTextView](../packages/editor/src/virtualization/virtualizedTextView.ts),
  [row rendering](../packages/editor/src/virtualization/virtualizedTextViewRows.ts), and
  [sharedTokenHighlights](../packages/editor/src/virtualization/sharedTokenHighlights.ts) own
  the corresponding DOM and range lifetime.

The old count of 13 hidden rows is historical evidence. Measure current row/range counts before
changing the clamp, including an unmeasured first mount.

## Scope

Suspend view rendering, not the document, undo history, or other visible views over that document.
Investigate whether hidden syntax work should be separately bounded, but do not add worker
suspension to this patch unless required for correctness. Retained tab policy stays with the host.

## Design

Distinguish unmeasured, measured-zero, visible, and disposed lifetimes where measurement requires
it. Determine whether font metrics or initial focus need a measurement element; satisfy that need
explicitly rather than silently keeping a real text row mounted.

An empty visible range must stay empty through overscan, row-height indexing, range registration,
and spacer calculation. Keep logical document height and saved logical scroll position available
without confusing them with the element's temporary zero geometry. Resize notification must be
sufficient to reveal current content, including edits made while hidden.

## Steps

1. Reproduce a hidden view with a visible sibling and count mounted rows/highlight ranges. Trace
   why the minimum-row clamp exists and test the known-good visible final-line case.
2. Define the smallest state change that distinguishes a hidden view from an unmeasured mount.
   Verify no metric bootstrap or focus consumer depends on a text row staying mounted.
3. Make both range computation paths preserve an empty range and release this view's ranges.
   Keep shared highlight registrations belonging to the sibling intact.
4. Restore on resize with the latest document and selection. Cancel pending rendering on disposal.
5. Measure retained hidden rows, range count, memory, and reveal latency against E001 controls.

## Verification

Extend [virtualizer tests](../packages/editor/test/fixedRowVirtualizer.test.ts) for range arithmetic,
[view tests](../packages/editor/test/virtualizedTextView.test.ts) for row/range cleanup, and
[browser tests](../packages/editor/test/virtualizedTextView.browser.test.ts) for actual layout.
Check `display:none`, a zero-height parent, initial hidden mount, hide/show cycles, and dispose while
hidden. Include wraps, folds, a long line, indexed row heights, and a saved deep scroll position.

Acceptance requires zero text rows/ranges for a measured hidden view, correct reveal without user
input, no sibling range deletion, and no blank first visible mount. Assert rendered text and caret
geometry after reveal; a lower DOM node count by itself cannot prove the change works.

## Risks and decisions

Initial measurement can report zero before fonts or layout settle. Define the transition using
real browser evidence. Browser scroll-height limits and resize coalescing can corrupt restoration
if temporary zero geometry overwrites the retained logical scroll. Stop if the proposed fix hides
that state bug with a forced scroll-to-top.

## Implementation evidence

Implemented against `715516cfd631b34c1922b0eba7323e036645e1b8` on 2026-09-06.

- Fixed and indexed ranges stay empty at zero height, including overscan and cached windows.
  Unmeasured virtualized views also mount no rows. Static views bootstrap their intrinsic height
  before measurement, then suspend on a measured zero viewport while retaining their spacer.
- Existing row retirement deletes this view's ranges. Empty views release shared token style
  registrations without removing sibling ranges and cancel pending row-width measurements.
- Dedicated metric probes handle font measurement. Hidden probes no longer cache fallback
  geometry. Reveal updates font metrics and gutter width before wrapping and rendering the latest
  text and selection. Hidden edits keep the last wrap width and logical document height.
- Logical scroll positions survive zero geometry and coalesced hide/reveal notifications.
  Native scroll restoration follows spacer rendering, including compressed vertical scrolling
  and horizontal long-line chunks. Hidden rows retain the known horizontal content extent.

The browser regressions check `display:none`, zero-height parents, initial hidden mounts, static
and indexed layouts, wraps and folds, hidden edits, disposal, and repeated hide/reveal cycles.
Caret checks compare native ranges with drawn geometry and viewport bounds without scrolling
the caret into view. The compressed-scroll case restores an offset above 17 million pixels.

The [E004 measurements](../examples/stress/results/hidden-rendering.md) reuse E001's seeded
ordinary, 500,000-line, and 1 MB long-line fixtures with two visible siblings. They include a
frozen baseline, an unchanged control, raw memory samples, and reveal observations. Ordinary
hidden views drop from 13 mounted rows and 65 token ranges to zero. Row pools remain bounded
and reusable after a previously visible view hides; document and undo state stay alive.

Hidden views request no new visible syntax range because they have no mounted rows. Initial
and edit parsing still run, and previously scheduled syntax warming can continue. Pausing those
worker requests needs a separate lifecycle policy and is outside this rendering change.

Verification passes the focused virtualizer, view, layout, geometry, Editor integration, font
metrics, and secondary-view tests, plus 17 Chromium browser tests. Core build, typecheck, lint,
repository formatting, and the backlog verifier also pass.
