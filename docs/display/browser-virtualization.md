# Browser Layout + 2D Virtualizer Plan

The editor should use browser layout carefully instead of owning a parallel text layout engine.
The renderer should virtualize what it asks the browser to lay out, then use native DOM ranges,
CSS Highlight API, selection APIs, and measured browser boxes for geometry.

## Direction

- Browser layout is the source of visual truth.
- CSS Highlight API remains the selection and syntax paint path until a better paint path exists.
- Virtualization owns visibility, mounting, and scroll-space management, not glyph measurement.
- Geometry queries should be local to mounted DOM. Avoid full-document `Range` walks.
- The first implementation should be a custom 2D virtualizer inspired by `/Users/shaul/vibe2`.

## Architecture

### Scroll Space

The editor owns one scroll container.

Inside it:

- a spacer establishes total document height
- mounted rows are absolutely positioned by virtual row start
- each mounted row lets the browser lay out its text normally
- horizontal scrolling is native

### Vertical Virtualization

Start with fixed-height rows:

- `totalHeight = lineCount * rowHeight`
- `visibleStart = floor(scrollTop / rowHeight)`
- `visibleEnd = ceil((scrollTop + viewportHeight) / rowHeight)`
- render visible rows plus overscan

Later, support variable-height rows for wrapping:

- maintain measured row heights
- store prefix sums / Fenwick tree for row -> y and y -> row
- update only rows whose measured height changes

### Horizontal Virtualization

Do not build a full x-position model.

Use browser layout and mounted DOM:

- no-wrap mode may mount the full visible row text initially
- long-line mode can split a logical line into horizontal text chunks
- chunks are mounted only around the horizontal viewport plus overscan
- chunk boundaries are chosen conservatively by UTF-16 offsets, not by measured glyphs
- browser layout determines actual glyph positions inside mounted chunks

### Geometry Queries

Geometry comes from mounted DOM:

- selection/caret: DOM `Range.getClientRects()`
- hit testing: `caretPositionFromPoint` / `caretRangeFromPoint`
- row bounds: virtualizer row positions plus measured DOM row height
- token/decorations: intersect token offsets with mounted rows/chunks, then paint through CSS Highlight API or mounted spans

If a query targets an unmounted region, scroll/mount it first or return a stale-safe miss.

## Inspired By vibe2

Useful patterns from `/Users/shaul/vibe2/packages/code-editor`:

- `createFixedRowVirtualizer.ts`: small fixed-row math, scroll listener, `ResizeObserver`, overscan, stable `VirtualItem` records
- `createTextEditorLayout.ts`: browser-measured char/line metrics, fixed-row virtualizer, visible range, content width from visible scans
- `TextFileEditorInner.tsx`: one scroll element, spacer height, absolute overlay layers, visible row rendering
- `useSelectionRects.ts`: selection work is limited to virtual rows

For this codebase, translate those ideas to framework-free TypeScript.

## First Milestone

1. Introduce a small framework-free fixed-row virtualizer module.
2. Keep the current `<pre>`/text-node editor path as the baseline.
3. Add a prototype virtualized view behind an internal option or test harness.
4. Use native browser selection and CSS Highlight API for selection paint.
5. Render only visible line DOM nodes plus overscan.
6. Validate scrolling, hit testing, selection, syntax highlights, and typing.

## Acceptance Criteria

- No independent text layout engine.
- No full-document DOM for large files in the virtualized path.
- Browser selection/caret hit testing remains authoritative.
- CSS Highlight selection behavior matches the pre-virtualized editor.
- 10K, 50K, and 100K-line files scroll without mounting offscreen rows.
- Long lines do not force full horizontal paint work once horizontal chunking is enabled.
