# Progress

Last updated: 2026-04-27

## Current Status

Phase 1 storage foundation is built and committed.

Latest committed Phase 1 work:

- Commit `f51e08a` — `Build phase 1 storage foundation`
- Commit `85ed5b5` — `Add editor planning docs and fix test runner`

Validation after Phase 1:

- `bun run typecheck` passed
- `bun run test` passed
- `bun run lint` passed
- `bun run build` passed
- Build still emits the existing Vite large chunk warning for the example app

## Done

### Planning

- Added `AGENTS.md` with project instructions for coding agents.
- Added architecture and design docs for storage, positions, anchors, editing, display transforms, collaboration, performance, phases, and open work.
- Locked the main storage direction: persistent treap-backed piece table.
- Locked the position hierarchy: Offset, Point, Anchor.
- Locked the anchor model at the design level, but not implementation.
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

## Not Done Yet

### Phase 1 Follow-Up

- Add a real benchmark file for the 1000+ insertion acceptance criterion instead of relying only on the structural test.
- Add broader randomized/fuzz tests for insert/delete/readback.
- Add explicit tests for empty documents, trailing newline documents, and very long single-line documents.
- Decide whether `PieceTableBuffers.chunks` should be exposed as read-only only at the type level or wrapped behind debug-only accessors.

### Phase 2: Anchor System

- Implement anchor types and sentinel anchors.
- Implement `anchorAt`, `anchorBefore`, and `anchorAfter`.
- Enforce code-point boundaries when creating anchors.
- Implement linear-scan `resolveAnchor` baseline.
- Add `subtreeVisibleLength` aggregate.
- Implement persistent reverse index keyed by `(buffer, offset)`.
- Bridge reverse index entries to treap nodes.
- Produce atomic snapshots containing both treap root and reverse-index root.
- Add correctness tests proving indexed resolution matches the linear baseline.
- Add deletion/bias/liveness tests.
- Add `applyBatch` for atomic multi-edit operations.
- Benchmark anchor resolution and reverse-index update cost.

### Phase 3: Selection Model

- Implement `Selection<T>`.
- Implement `SelectionGoal`.
- Store active selections as `Selection<Anchor>[]`.
- Implement lazy normalization with dirty flags.
- Implement multi-cursor merge-on-overlap behavior.
- Wire selections into editing commands.

### Phase 4: Display Transform Validation

- Prototype `FoldMap`.
- Implement `FoldPoint`.
- Validate bidirectional conversion.
- Validate invalidation precision.
- Cover fold edge cases: boundaries, nesting, document edges, and edits inside folds.
- Benchmark single-layer transform overhead.
- Make the go/no-go decision for layered display transforms.

### Phase 5: Additional Transforms

- Conditional on Phase 4 succeeding.
- Likely candidates: wrapping and decoration-related transforms.
- Scope still depends on FoldMap results.

## Larger Open Areas

- Layout system design is still open.
- Main-thread versus worker layout split is still open.
- Scheduler design is not started.
- Viewport and virtualization design is not started.
- Decoration system design is deferred.
- Undo/redo stack wiring is designed conceptually but not implemented.
- Collaboration is not a current goal, but storage choices preserve future compatibility.

## Immediate Next Step

Start Phase 2 only after adding a small Phase 1 benchmark/fuzz pass, or accept Phase 1 as practically complete and begin anchor implementation with a linear resolver first.
