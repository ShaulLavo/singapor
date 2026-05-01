# Display Transforms

## Problem

Buffer coordinates (row/column in actual text) differ from screen coordinates. Folded code, expanded tabs, wrapped lines, and block decorations create divergence. The editor must convert between these spaces.

## Decision: Proceed With Layered Transforms

FoldMap validated the core contract: a layer can own local state, update that state against a new
snapshot, and emit output-space invalidations tight enough for the layer above to avoid global
recomputation. The decision is **go** for the layered abstraction, with the constraint that future
layers still need their own validation before the approach is considered locked for every transform.

### Alternatives considered

1. **Monolithic display mapper:** Simpler, potentially faster, harder to test/extend.
2. **Virtual document model (VS Code-style):** Conceptually clean, memory-intensive.
3. **Ad-hoc per consumer:** Doesn't scale.

### Why layers remain viable

- Each layer independently testable
- Additive extensibility
- FoldMap validates tight invalidation for hidden regions, boundary edits, and external edits

**Honest constraint:** Some transforms (tabs, wrapping) may need to be fused in practice.

---

## Layer Interface (Proposed)

Five responsibilities:

1. **Accept edits, determine invalidation**
2. **Update local state** (invalidated portion only)
3. **Emit output invalidation** — `InvalidationSet` in this layer's output coordinate space
4. **Coordinate conversion** — `toThisLayer(point, bias)` and `fromThisLayer(point, bias)`
5. **snapshot()** — immutable view for rendering

The key: layer must communicate **what changed in its output space**. Without this, the layer above recomputes from scratch.

### Invalidation Protocol (Proposed)

Typed ranges: `InvalidatedRange<T>` with `start`, `end`, `lineCountDelta`.

`InvalidationSet<T>` = sorted, non-overlapping ranges for the layer above to reprocess.

- **Ranges not edits:** consuming layer needs region scope, not old content
- **Per-range `lineCountDelta`:** shifts happen at specific locations; single aggregate forces full reprocessing
- **Coordinate shifting between ranges:** walk ranges accumulating deltas. O(ranges) not O(document)
- **Parameterized by `T`:** type system enforces coordinate space matching
- **Empty ranges:** no-op, layer absorbed the edit

FoldMap implements this protocol with `InvalidatedRange<FoldPoint>` records. Shared transform
primitives now live in `packages/editor/src/displayTransforms.ts`, including typed invalidations,
the common layer shape, tab column conversion, wrap rows, and block-row primitives.

---

## FoldMap (Validation Layer)

First layer to validate the abstraction. Simplest transform: collapse contiguous regions into single-line placeholders.

Sorted array of fold ranges (start/end Anchors). Converts between buffer Points and FoldPoints by skipping folds.

### FoldMap Invalidation Analysis

| Edit location | Output invalidation |
|---|---|
| Inside fold (not touching boundaries) | None; anchors refresh against the next snapshot |
| Touching fold boundary | Placeholder if fold survives; placeholder expands if fold is destroyed |
| Outside any fold | Coordinate-shifted pass-through in `FoldPoint` space |
| Fold toggled | Fold's output range |

Smallest recomputable unit: a single fold region.

### The Go/No-Go Question

Can FoldMap produce tight enough invalidation that a layer above would not need to globally recompute?

**Decision:** go. FoldMap gives no output invalidation for edits hidden inside folds, local
placeholder invalidation for surviving boundary edits, expansion invalidation when a fold is
destroyed, and pass-through invalidation for external edits. This is precise enough to continue to a
second validation layer instead of collapsing immediately to a monolithic mapper.

### Implemented after FoldMap

- Tab expansion uses configurable `tabSize` math shared with the renderer.
- Wrapping is represented as transform-produced display rows using monospace measured columns.
- Block rows are internal transform primitives that occupy row units without creating buffer text.
- The virtualizer consumes transform-produced rows and supports variable row sizes for block rows.

---

## Decorations (Not Yet Designed)

Constraints defined, design deferred until anchors and selections validated.

### Known

- Range-based with style metadata
- Dense decorations (50K+ Tree-sitter highlight captures) must NOT use one anchor per endpoint
- Invalidation at least line-granular
- Different lifetimes: syntax (Tree-sitter async, high volume), lint (async, medium), transient (frequent, low volume)
- Tree-sitter is the committed source for syntax highlighting, folds, structural selection, indentation, injections, and bracket/tag matching.

### Key question: how dense decorations reference positions

Candidates:
- **Offset-based with Patch rebase:** No anchor overhead. CodeMirror approach.
- **Line-anchored + intra-line offsets:** O(lines) anchors not O(tokens).
- **Interval tree:** Query-efficient but maintenance overhead.

### Current rendering

CSS Highlight API renderer: `packages/editor/src/editor.ts`
Token types: `packages/editor/src/tokens.ts` (`EditorToken`, `EditorTokenStyle`, `TextEdit`)

### Current implementation note

The repo also contains an optional Shiki highlighter package. Transform design should continue to accept renderer-facing decoration/highlight output from whichever syntax or highlighting package a host chooses.
