# Display Transforms

## Problem

Buffer coordinates (row/column in actual text) differ from screen coordinates. Folded code, expanded tabs, wrapped lines, and block decorations create divergence. The editor must convert between these spaces.

## Hypothesis: Composable Layered Transforms

Exploring whether display transforms can be a chain of composable layers, each with own state, edit response, and bidirectional coordinate conversion. **Hypothesis under validation, not committed architecture.**

### Alternatives considered

1. **Monolithic display mapper:** Simpler, potentially faster, harder to test/extend.
2. **Virtual document model (VS Code-style):** Conceptually clean, memory-intensive.
3. **Ad-hoc per consumer:** Doesn't scale.

### Why exploring layers

- Each layer independently testable
- Additive extensibility
- Validated by Zed at scale

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

Protocol is proposed, not locked. FoldMap is the experiment.

---

## FoldMap (Validation Layer)

First layer to validate the abstraction. Simplest transform: collapse contiguous regions into single-line placeholders.

Sorted array of fold ranges (start/end Anchors). Converts between buffer Points and FoldPoints by skipping folds.

### FoldMap Invalidation Analysis

| Edit location | Output invalidation |
|---|---|
| Inside fold (not touching boundaries) | None |
| Touching fold boundary | Placeholder if fold survives; full region if fold destroyed |
| Outside any fold | Coordinate-shifted pass-through |
| Fold toggled | Fold's output range |

Smallest recomputable unit: a single fold region.

### The Go/No-Go Question

Can FoldMap produce tight enough invalidation that a layer above would not need to globally recompute?

**If yes:** proceed with additional layers.
**If no:** collapse to monolithic mapper.

### Deferred until after FoldMap

- Invalidation analysis for wrapping, tab expansion, block decorations
- Multi-layer round-trip chain design
- Layout model
- Whether some transforms must be fused

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

The demo app still contains a Shiki tokenizer package. That is implementation debt, not the long-term plan. New syntax-system design should target Tree-sitter query output and adapt it to the renderer's decoration/highlight API.
