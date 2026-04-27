# Progress

Last updated: 2026-04-27

## Current Status

Phase 3 selection core is implemented locally on top of the Phase 1 storage foundation and Phase 2
anchor system.

Latest committed Phase 1 work:

- Commit `f51e08a` — `Build phase 1 storage foundation`
- Commit `85ed5b5` — `Add editor planning docs and fix test runner`

Validation after Phase 1:

- `bun run typecheck` passed
- `bun run test` passed
- `bun run lint` passed
- `bun run build` passed
- `bun run bench:piece-table` passed in `packages/editor`
- Build still emits the existing Vite large chunk warning for the example app

Validation after Phase 2:

- `bun run typecheck` passed in `packages/editor`
- `bun run test` passed in `packages/editor`
- `bun run lint` passed in `packages/editor`
- `bun run bench:piece-table` passed in `packages/editor`
- `bun run bench:anchors` passed in `packages/editor`

Validation after Phase 3:

- `bun run typecheck` passed
- `bun run test` passed
- `bun run lint` passed
- `bun run build` passed
- `bun run bench:piece-table` passed in `packages/editor`
- `bun run bench:anchors` passed in `packages/editor`

## Done

### Planning

- Added `AGENTS.md` with project instructions for coding agents.
- Added architecture and design docs for storage, positions, anchors, editing, display transforms, collaboration, performance, phases, and open work.
- Locked the main storage direction: persistent treap-backed piece table.
- Locked the position hierarchy: Offset, Point, Anchor.
- Locked and implemented the anchor model.
- Defined implementation phases and acceptance criteria.

### Test Harness

- Fixed the piece-table test import to use Vitest instead of `bun:test`.
- Confirmed the normal repo test path runs through Turbo/Vitest.

### Phase 1: Storage Foundation + Line-Break Augmentation

- Changed `PieceBufferId` from the old `'original' | 'add'` union to an opaque branded string type.
- Removed string-literal buffer comparisons from the piece-table implementation.
- Replaced the single growing add string with append-only chunk buffers.
- Added fresh opaque buffer IDs for inserted chunks.
- Kept original text as its own immutable buffer chunk.
- Decided to keep chunk storage exposed as `ReadonlyMap` at the type boundary; no debug-only accessor layer for now.
- Added `Piece.lineBreaks`.
- Added `subtreeLineBreaks` to treap nodes.
- Maintained line-break aggregates through node creation, cloning, splitting, merging, and updates.
- Added `offsetToPoint`.
- Added `pointToOffset`.
- Added public exports for the piece-table API from `@editor/core`.
- Added tests for:
  - basic insert/delete
  - snapshot isolation
  - 1000 small insertions creating distinct buffer chunks
  - large insert chunk splitting
  - line-break aggregates through edits/splits
  - offset-to-point conversion
  - point-to-offset conversion with column clamping
  - offset/point round trips
  - deterministic randomized insert/delete/readback fuzz scenarios
  - empty document, trailing newline, and very long single-line edge cases
- Added a real piece-table insertion benchmark for the 1000+ insertion acceptance criterion.

### Phase 2: Anchor System

- Added anchor types, `Anchor.MIN`, and `Anchor.MAX`.
- Added `anchorAt`, `anchorBefore`, and `anchorAfter`.
- Enforced code-point boundaries when creating anchors.
- Added `resolveAnchorLinear` as the correctness baseline.
- Added indexed `resolveAnchor` using a snapshot-local lazy reverse-index cache keyed by `(buffer, piece.start)`.
- Added `compareAnchors`.
- Added `Piece.visible`.
- Added `subtreeVisibleLength`; user-facing length, reads, edits, and point conversion now count visible pieces only.
- Changed delete to mark affected pieces invisible instead of removing them physically.
- Preserved deleted anchor resolution with liveness and replacement bias behavior.
- Added `applyBatchToPieceTable` for non-overlapping batch edits against the original snapshot.
- Added tests for:
  - invisible-piece deletion
  - sentinel resolution
  - boundary creation and bias
  - deleted liveness
  - replacement bias
  - surrogate-pair boundary rejection
  - empty-snapshot real anchors
  - indexed resolver parity with the linear baseline
  - batch edits
- Added `bench:anchors` for 10K, 50K, and 100K-line anchor resolution/index-cost measurements.

### Phase 3: Selection Model

- Added `Selection<T>`, `SelectionGoal`, and anchor-backed `Selection<Anchor>` helpers.
- Added `SelectionSet<T>` with a snapshot-scoped normalization-valid dirty flag.
- Implemented snapshot-relative selection resolution.
- Implemented lazy normalization by resolved offsets.
- Locked merge behavior for overlapping or touching ranges and duplicate cursors.
- Implemented selection-aware text replacement through `applyBatchToPieceTable`.
- Implemented backspace for selected ranges and collapsed cursors, including surrogate-pair handling.
- Added a minimal O(1) linked-stack snapshot+selection history helper for undo/redo boundaries.
- Added tests for selection resolution, normalization, multi-selection edits, backspace, and undo/redo.

### Phase 4: Tree-sitter Syntax System

- Replace Shiki as the long-term syntax path.
- Keep Tree-sitter parser creation, parsing, query execution, tree traversal, and injections worker-owned.
- Add a worker-side language registry for parser and query assets.
- Build a piece-table input adapter for Tree-sitter.
- Translate batch edits into Tree-sitter input edits.
- Tie parse results to document snapshots and reject stale syntax output.
- Use Tree-sitter highlight queries for syntax decorations.
- Use Tree-sitter queries for folds, structural selection, indentation, injections, and bracket/tag matching.
- Keep active selections stored as anchors; Tree-sitter nodes are transient inputs for selection commands.
- Benchmark parse/update/query time, memory, and GC at 10K, 50K, and 100K lines.

### Phase 5: Display Transform Validation

- Prototype `FoldMap`.
- Implement `FoldPoint`.
- Validate bidirectional conversion.
- Validate invalidation precision.
- Cover fold edge cases: boundaries, nesting, document edges, and edits inside folds.
- Benchmark single-layer transform overhead.
- Make the go/no-go decision for layered display transforms.

### Phase 6: Additional Transforms

- Conditional on Phase 5 succeeding.
- Likely candidates: wrapping and decoration-related transforms.
- Scope still depends on FoldMap results.

## Larger Open Areas

- Layout system design is still open.
- Main-thread versus worker layout split is still open.
- Tree-sitter worker protocol, parser/query loading, memory policy, and worker scheduling are not designed yet.
- Scheduler design is not started.
- Viewport and virtualization design is not started.
- Decoration system design is deferred.
- Undo/redo stack wiring has a minimal snapshot+selection helper; worker transaction ownership remains open.
- Collaboration is not a current goal, but storage choices preserve future compatibility.

## Immediate Next Step

Start Phase 4 Tree-sitter syntax-system design and prototype the parser/query pipeline.
