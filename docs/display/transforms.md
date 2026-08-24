# Display Transforms

## Problem

Buffer coordinates (row/column in actual text) differ from screen coordinates. Folded code, inline
replacements, expanded tabs, and wrapped lines create divergence. The editor must convert between
these spaces.

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
the common layer shape, tab column conversion, and wrap rows.

---

## FoldMap (Validation Layer)

First layer to validate the abstraction. Simplest transform: collapse contiguous regions into single-line placeholders.

Sorted array of fold ranges (start/end Anchors). Converts between buffer Points and FoldPoints by skipping folds.

### FoldMap Invalidation Analysis

| Edit location                         | Output invalidation                                                    |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Inside fold (not touching boundaries) | None; anchors refresh against the next snapshot                        |
| Touching fold boundary                | Placeholder if fold survives; placeholder expands if fold is destroyed |
| Outside any fold                      | Coordinate-shifted pass-through in `FoldPoint` space                   |
| Fold toggled                          | Fold's output range                                                    |

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

The removed block-row and block-surface APIs are not part of the transform architecture and are not
compatibility targets.

---

## InlineMap (Second Validation Layer)

FoldMap hides whole rows. InlineMap hides and substitutes _within_ a row: the primitive a markdown
live-preview view needs to paint `**bold**` as bold, `# Title` as a heading, and `![](img.png)` as an
image, while the buffer keeps holding plain markdown text.

Implementation: `packages/editor/src/inlineMap.ts` (anchored state, invalidation) and the inline
section of `packages/editor/src/displayTransforms.ts` (stateless row and column math), matching how
FoldMap's state lives apart from the shared wrap/tab primitives.

### Shape

A replacement is a single-line source span painted as substitute text. Empty text hides the span;
non-empty text stands in for it. Per buffer line, `createInlineRow` produces the display text plus a
contiguous segment list covering the whole line, so column conversion in either direction is total.

**Locked:**

- Replacements are intra-line. A span crossing a newline is a fold, not a replacement, and is dropped.
- Replacement text may not contain a newline, so **the layer never adds or removes rows**. Its own
  invalidations always carry `lineCountDelta: 0`; row deltas ride on the external-edit invalidation.
- Replacements are atomic. No display column ever resolves to a source column strictly inside one,
  and a source range overlapping any part of a replacement paints all of it.
- Overlapping replacements are rejected at normalization; the first (outermost) wins.
- Replacements do not absorb edits at their edges — start anchors right, end anchors left — so text
  typed next to `**bold**` lands outside the hidden markers. This is deliberately the inverse of
  FoldMap, whose ranges grow at their boundaries.

### Ambiguity rule

Hidden spans are zero-width in display space, so several source columns share one display column.
`display -> source -> display` is always the identity. `source -> display -> source` is not, at a
hidden boundary. The inverse resolves by bias: `before`/`nearest` to the earliest source column,
`after` to the latest. Horizontal motion passes the bias matching its direction.

### Reveal

`revealInlineMap` drops every replacement that the caret or selection touches, plus the rest of each
touched group, and returns a derived map. Reveal is construct-scoped, not marker-scoped: a caret
anywhere inside `**bold**` unhides both fences. Because mapping and painting both read the revealed
map, they cannot disagree about what is currently hidden.

### InlineMap Invalidation Analysis

| Edit location                        | Output invalidation                                  |
| ------------------------------------ | ---------------------------------------------------- |
| Inside a hidden span, no newline     | None; nothing visible changed                        |
| Touching a replacement that survives | That row, `replacement-changed`                      |
| Touching a replacement that dies     | That row, `replacement-dropped`                      |
| Outside every replacement            | Edited rows, `external-edit`, carrying the row delta |

Smallest recomputable unit: one buffer row. Merging keeps the most specific reason so a coincident
external edit cannot bury the fact that a replacement was dropped.

### Wiring

`Editor.setInlineMap` / `VirtualizedTextView.setInlineMap` install the map. The view keeps the map it
was given and derives what it renders by revealing whatever the current selections touch, so the
caret restores markdown source as it moves and re-hides it on the way out.

The invariant that makes the rest work: **a chunk's `startOffset`/`endOffset` are buffer offsets,
while `localStart`/`localEnd` and every index into row text are display indices.** Anywhere the two
used to be mixed by plain addition now goes through `rowLocalIndexForOffset` /
`rowOffsetForLocalIndex` in `virtualizedTextViewInlineMapping.ts`, which collapse to exactly the old
arithmetic when a row has no mapping. That covers caret DOM boundaries, hit testing, visual-column
motion, chunk construction, hidden-character markers, selection signatures, and token/range
highlight painting.

Native caret APIs also return display-local DOM indices. When they are unavailable or report an
overlay, measured BiDi hit testing maps its fallback local index through
`rowOffsetForLocalIndex(..., 'nearest')` and clamps the result to the row's buffer span. Raw
`row.startOffset + localIndex` is invalid for both inline insertions and replacements because their
display and source lengths differ.

The same-line and plain-row edit fast paths patch row text using buffer-space offsets, so an active
inline map routes edits to a full rebuild via `hasModelRowProjections`.

### Producing replacements

`EditorInlineReplacementProvider` is the contribution point: given the document text, its language,
and the current syntax captures, it returns `InlineReplacementSpec[]`. Providers register through the
plugin context and compose — every registered provider contributes, and the inline map resolves
overlaps outermost-first. Editor rebuilds the map whenever fresh captures settle, so a provider never
schedules anything itself.

`registerInlineReplacementProvider` is optional on `EditorPluginContext` so that adding it did not
break hand-written contexts. The plugin host always provides it; a plugin that finds it missing is
running on a host too old for the contribution and should say so rather than silently registering
nothing.

`@singapor/markdown` is the first consumer. It derives replacements from the existing markdown
highlight queries, which name things generically (`punctuation.delimiter` covers both emphasis fences
and link brackets), so constructs are recovered structurally: by containment for emphasis and code
spans, by adjacency for links and images.

### Still open

- Wrapping may split a multi-character replacement across rows; the wrap pass does not yet treat
  replacements as unbreakable units.
- Edits drop the map and wait for the next parse to supply a fresh one, matching how FoldMap behaves.
  `updateInlineMapForEdit` can carry it across an edit once the host drives that.

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
