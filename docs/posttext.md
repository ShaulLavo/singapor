# Posttext Layout Engine Plan

## Goal

Build **Posttext**, an incremental text layout engine for a browser code editor.

It must:

- avoid DOM measurement APIs entirely
- support **incremental relayout** after edits
- support **2D virtualization**:
  - vertical virtualization for rows / blocks
  - horizontal virtualization for very long lines / wide content
- provide precise geometry for:
  - wrapping
  - hit testing
  - selections
  - decorations
  - offset ↔ x/y conversion

---

## Inspiration

Posttext is inspired by Pretext’s core split:

- an expensive **prepare** phase
- a cheap **layout** phase

But unlike Pretext, Posttext is designed for **constantly changing editor text**.

So the end-state goal is:

- **incremental prepare**
- **bounded invalidation**
- **cheap local relayout**
- **queryable layout artifacts**

---

## Core Principles

- **No DOM reads in the hot path**
  - no `getBoundingClientRect`
  - no `offsetHeight`
  - no browser layout dependency for text metrics once measurement data exists

- **Prepare and layout are separate**
  - prepare computes reusable text-analysis artifacts
  - layout consumes those artifacts to produce wrapped visual output

- **Layout is incremental**
  - edits invalidate only bounded regions
  - unchanged regions keep their prepared and layout state

- **Layout is queryable**
  - layout is not just for painting
  - it must answer editor questions precisely and fast

- **2D virtualization is required**
  - vertical-only virtualization is insufficient
  - long lines must not force full horizontal realization

## Coherence Pass: First Implementation Contract

Posttext is coherent as an end-state direction, but the first implementation must be narrower than
the full plan. Start with an isolated layout core, not a renderer replacement.

### What can start now

Build a pure TypeScript layout package inside `packages/editor` that consumes:

- a `PieceTableSnapshot`
- visible document offsets and Points
- explicit layout metrics (`charWidth`, `lineHeight`, `tabSize`, font identity)
- viewport rectangles
- edit batches from `DocumentSessionChange`

It should not depend on DOM nodes, CSS Highlight objects, `Selection`, or `Anchor`.

### What must wait

Do not replace the current text-node / CSS Highlight renderer until the layout core has stable query
APIs and benchmarks. The current renderer still owns native editing behavior, DOM selection syncing,
and syntax highlighting. Posttext can first run as a model behind tests and a debug/prototype view.

### Coordinate contract

- Document coordinates are UTF-16 visible offsets from `PieceTableSnapshot`.
- `Point` remains `{ row, column }` in document space.
- Posttext owns visual coordinates only: `{ x, y }`, visual lines, boxes, and viewport slices.
- Layout output may reference offsets and Points, but never stores anchors.
- Folded or transformed coordinates must enter through an explicit transform adapter later.

### Initial constraints

The first implementation targets the editor's current rendering assumptions:

- monospace code font
- single line height
- `white-space: pre` / no soft wrap as the first executable slice
- tabs expanded by configured tab stops
- no bidi, proportional-font shaping, inline widgets, or injected-width content yet

These constraints are not the final product. They create a measurable base for vertical and
horizontal virtualization before adding soft wrap and width-sensitive inline content.

---

## Required Queries

The engine must support these as first-class operations:

1. `offset -> x, y`
2. `x, y -> offset`
3. `viewport(x1, y1, x2, y2) -> visible layout artifacts`
4. `line/block -> visual bounds`
5. `range -> boxes / quads`
6. `offset -> visual line / wrapped fragment`

These queries must remain efficient under incremental edits.

---

## End-State Architecture

### 1. Text Analysis / Prepare Layer

This is the expensive part.

For each layout unit, compute and cache:

- grapheme boundaries
- break opportunities
- measured advances
- bidi/script metadata if needed
- tab/injected-width metadata
- width-affecting inline content metadata

This layer should produce **prepared text artifacts** that can be reused across relayouts.

### 2. Layout Layer

Consumes prepared artifacts and a width constraint, then computes:

- wrapped visual lines
- segment x positions
- visual heights
- line bounds
- hit-testable geometry

This layer should be mostly arithmetic over cached data.

### 3. Viewport / Virtualization Layer

Consumes layout artifacts and exposes only what is needed for the visible 2D window.

Responsibilities:

- vertical windowing
- horizontal windowing
- clipping to visible ranges
- prefix-sum / aggregate queries for y lookup
- line-local width queries for x lookup

---

## Layout Unit

This is still the main open design question.

Candidates:

- logical line
- paragraph/block
- editor-defined chunk
- hybrid unit

### Required properties of a layout unit

A unit must be:

- independently preparable
- independently relayoutable
- capable of bounded invalidation
- suitable for vertical and horizontal virtualization
- small enough that edits do not cause global work
- large enough that cross-boundary spill is manageable

### Current direction

Start from **logical line as the invalidation root**.

Reason:

- editor edits are often line-local
- line identity matters for editor UX
- long-line behavior can still be handled inside the unit

For the first implementation, a logical line is the external unit and long lines are internally
subdivided into fixed-size chunks for preparation and horizontal viewport queries. This keeps edit
invalidation line-based while avoiding full geometry materialization for a 50K-character line.

This remains subject to benchmarking. If line-local chunks still create too much invalidation or
memory pressure, the fallback is a hybrid unit: logical lines for identity, chunked text blocks for
storage and measurement.

---

## 2D Virtualization Model

### Vertical virtualization

The engine must avoid realizing full geometry for off-screen rows / blocks.

It needs:

- aggregate heights
- fast mapping from y-range to layout units / visual lines
- efficient incremental updates when heights change

### Horizontal virtualization

The engine must avoid realizing full geometry for off-screen x ranges of long lines.

It needs:

- cumulative x advances per visual line
- line-local segment lookup by x-range
- ability to materialize only visible spans for a given line
- fast `x -> offset` and `offset -> x` within a visible line

### Required property

A 50k-character line must not force:
- full paint geometry creation
- full selection geometry creation
- full visible-range realization

outside the visible x window.

---

## Invalidation Model

This is load-bearing.

Every layout layer must define:

1. **input invalidation unit**
2. **internal cached state unit**
3. **output invalidation unit**
4. **spill / propagation rules**

### Minimum invalidation contract

For any edit, the engine must answer:

- which layout unit(s) are dirty
- which prepared artifacts are dirty
- whether wrapping spills into adjacent units
- which visible rows are affected
- which x-ranges of long lines are affected

### Non-goal

No global relayout after every edit.

### Required behavior

Edits should invalidate:

- the edited unit
- a bounded spill region if wrapping or inline width changes propagate
- no more than necessary

For the first no-wrap implementation:

- changed text invalidates the intersecting logical line range
- line insert/delete shifts later line indices but does not require relayout of later line contents
- vertical y lookup can be arithmetic while line height is fixed
- horizontal x lookup is line-local and must not allocate per-character boxes for long lines

When soft wrap is added, a changed line can change its own visual-line count and height aggregate.
It should not force text preparation for unrelated logical lines.

---

## Width-Affecting Concerns

These are part of one physical layout subsystem.

Do **not** treat these as fully independent layers in implementation unless proven safe:

- tab expansion
- inline injected content
- inline widgets that affect width
- wrap computation
- glyph advances

Why:

They all affect visual width, and width is not cleanly composable.

So while the architecture may describe multiple transforms, the physical implementation can fuse width-sensitive concerns.

---

## Data Structures

### Prepared Artifacts

Per layout unit:

- measured segments
- break opportunities
- grapheme / cluster boundaries
- width metadata
- optional bidi metadata

### Layout Artifacts

Per layout unit:

- visual lines
- wrapped fragments
- cumulative x positions
- heights / ascent / descent
- local hit-test tables

### Aggregates

Need structures for:

- cumulative heights across units / visual rows
- cumulative widths within visual lines
- fast viewport lookup in both dimensions

### Dirty State

Need explicit dirty markers for:

- prepare invalidation
- relayout invalidation
- spill invalidation
- viewport projection invalidation

---

## API Shape

### Prepare

```ts
prepareUnit(unitText, config) -> PreparedUnit
```

### Incremental Prepare

```ts
updatePreparedUnit(prevPrepared, edit, nextUnitText, config) -> PreparedUnit
```

### Layout

```ts
layoutUnit(prepared, width, config) -> LayoutUnit
```

### Viewport Query

```ts
queryViewport(layoutState, rect) -> VisibleLayoutSlice
```

### Geometry

```ts
offsetToXY(layoutState, offset) -> { x, y }
xyToOffset(layoutState, x, y) -> offset
rangeToBoxes(layoutState, start, end) -> Box[]
```

This is conceptual; exact signatures remain open.

## First API Slice

The first concrete API should be smaller:

```ts
type PosttextMetrics = {
  readonly charWidth: number;
  readonly lineHeight: number;
  readonly tabSize: number;
};

type PosttextViewport = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

createPosttextLayout(snapshot, metrics) -> PosttextLayoutState
updatePosttextLayout(state, change, metrics) -> PosttextLayoutState
queryPosttextViewport(state, viewport) -> VisibleLayoutSlice
offsetToXY(state, offset) -> { x, y }
xyToOffset(state, x, y) -> offset
rangeToBoxes(state, start, end) -> Box[]
```

Implementation detail can be more specific, but the public boundary should preserve these
properties:

- all inputs are immutable or treated as immutable
- all outputs are snapshot-scoped
- no DOM objects cross the boundary
- metrics are injected, not read by the core
- viewport queries can return spans instead of one box per character

---

## Interaction with the Editor

### Inputs

Posttext consumes:

- text content by unit
- offsets / Points
- width constraints
- inline width-affecting metadata
- fold visibility information

### Outputs

Posttext provides:

- visual lines
- visible 2D slices
- geometry for cursor / selection / decoration painting
- offset/x/y mapping
- line/block bounds

### Important boundary

Layout does **not** store anchors.

Layout works with:

- offsets
- Points
- prepared/layout artifacts

Anchors stay in the document/position layer.

---

## Research / Validation Questions

These are the important remaining questions:

### 1. What is the final layout unit?
We need benchmarking and real editor scenarios to decide.

### 2. How much spill is acceptable?
If rewrap of one unit constantly spills into many others, the unit is wrong.

### 3. What data must be cached in prepare?
We need to know the minimum set of reusable artifacts that makes relayout cheap.

### 4. What is the correct horizontal virtualization model?
Need a concrete answer for very long lines.

### 5. What aggregate structures do we need for y and x queries?
Need to choose structures that support fast incremental updates.

### 6. How do folds interact with prepared/layout units?
Need to decide whether folding invalidates layout state or bypasses it.

### 7. What is the cost of width-affecting inline content?
Need to verify whether tabs, injected text, and inline widgets can stay in one width subsystem without exploding complexity.

---

## Build Plan

### Step 1 - Define the unit
- lock logical line as the v0 unit
- define line identity by snapshot row plus document offset range
- define chunking inside long lines
- define v0 invalidation rules for no-wrap layout

### Step 2 - Build the no-wrap layout core
- produce visible line slices from a snapshot
- map viewport y-range to document rows
- map viewport x-range to line-local spans
- implement offset/x/y and range-to-box queries

### Step 3 - Add edit invalidation
- accept `DocumentSessionChange`
- invalidate changed logical lines
- update line ranges and height aggregates
- preserve unchanged prepared/layout artifacts

### Step 4 - Benchmark the base
- 10K, 50K, 100K-line files
- 50K-character lines
- rapid single-line edits
- wide horizontal viewports
- range boxes over long selections

### Step 5 - Integrate behind a debug/prototype view
- keep the current renderer as the default
- expose layout query results for verification
- compare browser hit testing against Posttext hit testing

### Step 6 - Add soft wrap
- compute wrapped visual lines inside a logical line
- update height aggregates when wrapping changes
- preserve horizontal virtualization for very long wrapped lines

### Step 7 - Integrate with transforms and renderer
- connect FoldMap or transform adapters
- connect selection/decorations
- decide whether the renderer becomes DOM spans, canvas, CSS Highlights, or a hybrid
- validate no DOM measurement in hot paths after metrics are seeded

---

## Deliverables

- layout unit spec
- invalidation model
- prepare artifact spec
- layout artifact spec
- 2D virtualization spec
- query API spec
- benchmark suite
- prototype integrated into editor shell

---

## Summary

Posttext is not “Pretext but faster.”

It is:

- **Pretext’s prepare/layout split**
- made **incremental**
- made **editor-aware**
- made **queryable**
- made **2D-virtualized**
- and designed for **dynamic code editing from day 0**
