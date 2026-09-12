# E003: Keep optional startup work off first paint

- Status: Implemented
- Kind: Implementation
- Owner: Editor
- Priority: P1
- Effort: M
- Dependencies: [E001](e001-stress-fixtures.md)
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`

## Outcome

Show usable text promptly on a cold open and add optional language features when they become
ready. A slow grammar load must not leave a blank editor. Preserve fast prepared opens and the
existing guarantee that stale prepared data cannot become current document truth.

## Current code

- [Editor](../packages/editor/src/editor/Editor.ts) already separates document attachment,
  prepared rendering, and syntax refresh.
- [Prepared documents](../packages/editor/src/editor/preparedDocument.ts) describe exact revision
  and configuration matches, stage outcomes, and one-shot transfers.
- [SyntaxController](../packages/editor/src/editor/syntaxController.ts) owns structural and
  highlighter sessions independently.
- [Prepared-document tests](../packages/editor/test/preparedDocument.test.ts) and
  [Platform's prepared-open tests](../../platform/apps/web/src/features/editor/tests/prepared-open.browser.tsx)
  protect existing adoption and visual handoff behavior.

The old wishlist predates these contracts. Profile what still blocks the current constructor and
document attachment; do not replace the prepared-document system with a second preload path.

## Scope

Audit standalone Editor cold and warm opens, remove demonstrated synchronous blockers, and verify
the eventual feature upgrades. Platform filesystem reads, app bundle startup, and its visual-only
cache remain outside this implementation. A paired host verification is required if a public
event's timing or meaning changes.

## Design

Keep document text, minimal line metrics, selection, and essential layout available for first
paint. Start independent optional initialization together when dependencies permit. Attach results
only when document revision, configuration tags, and runtime session identity still match.

Preserve the distinction between first text paint and first highlighted paint. Prepared results
may satisfy both at once. An inert old screenshot or cached text image cannot satisfy the current
document's correctness gate. Disposal must cancel pending adoption and release transferred resources.

## Steps

1. Measure construction, attachment, first text paint, and highlighted paint using E001. Attribute
   waits to code, asset resolution, worker creation, and first parse rather than a single total.
2. Identify remaining synchronous work or import waterfalls. For each candidate, explain which
   readiness contract allows it to move and which default behavior is visible meanwhile.
3. Implement one observed improvement at a time using the current preparation/session APIs.
   Keep live typing and document replacement functional during initialization.
4. Verify late success, failure, cancellation, theme change, and two simultaneous editors.
   An optional provider failure must end in an observable state, not indefinite loading.
5. Record before/after cold and warm timings and verify built package imports in the existing
   example. Keep any host-facing event change explicit in the delivery notes.

## Verification

Build the affected packages, then run the existing prepared-document suite through the core
package's `test` script. Add real-browser tests that delay the external asset or worker boundary,
assert visible text while delayed, type before readiness, then observe the correct final highlight.

Reject stale prepared revision/configuration transfers and prove dispose-before-ready releases
the session. Compare ordinary and huge files, cold and prepared opens, and with/without plugins.
Acceptance requires a measured first-text improvement in the diagnosed case while preserving the
existing exact-revision and paint-event assertions. If no remaining blocker is found, close with
the calibrated baseline and regression evidence; do not invent a rewrite to force an improvement.
A changed callback timestamp alone is no proof.

## Risks and decisions

Plain-text-first can cause a visual flash; measure it against the current prepared path and keep
ready results ready. Fonts and metrics can affect caret correctness, so separate optional language
work from required geometry. Coordinate with existing [Plan 071](../../platform/plans/071-syntax-highlight-retry.md)
for highlight failure recovery; do not implement an independent retry loop here.

## Implementation evidence

- Behavior and ownership: [file-open first paint](../docs/performance/first-paint.md).
- Reproducible built-package runner: [E003 matrix](../examples/stress/README.md#first-text-and-highlighted-paint).
- Matched baseline, unchanged control, candidate, and diagnostic records:
  [measured results](../examples/stress/results/first-paint/README.md).
- Real-browser delayed grammar, typing, failure, disposal, replacement, and theme checks:
  [first-paint contracts](../packages/editor/test/firstPaint.browser.test.ts).

The measured blocker was synchronous fallback-fold scanning during unprepared attachment.
It now uses the existing secondary-work queue; explicit fold commands flush it immediately.
Prepared folds retain their atomic first-render adoption. No new preload path or retry loop was added.

On the 500,000-line plain-text fixture, median cold attachment fell from 120.5 ms to 84.3 ms.
The screenshot-completion upper bound for visible text fell from 230.2 ms to 188.2 ms.
The unchanged control measured 117.2 ms and 219.1 ms respectively. Warm and prepared results,
measurement variability, and the worker-disposal fence are recorded with the raw samples.

Core builds, typecheck, lint, prepared-document contracts, focused fold tests, and four new browser
checks pass. The existing example also passes a built-output rendering and trusted-input check.
Platform's 11 visible-snapshot browser checks pass against the linked package. Public paint-event
phases and generation fields retain their meaning; optional fallback markers can now follow text.
