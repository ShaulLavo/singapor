# Open Work

Consolidated validation, design, and measurement tasks.

## Completed Validation (Phase 2)

- Invisible-piece deletion, `subtreeVisibleLength`, visible-offset reads/edits, persistent reverse index, and indexed-vs-linear resolution are implemented and covered by tests.
- Anchor liveness is validated for delete-and-retype, single replacement, batched replacement, boundary clamping, sentinels, piece-boundary bias, surrogate-pair enforcement, fuzz scenarios, and undo/redo snapshot swaps.
- `bench:anchors` covers 10K, 50K, and 100K-line files with resolution timing, reverse-index rebuild timing, invisible-piece delete/retype timing, reverse-index/invisible-piece counts, memory samples, and forced-GC samples.

## Coordinate Validation

- Benchmark offset-vs-point as canonical coordinate
- Validate Offset intermediary for Point-heavy workloads
- Consider caching in `anchorToPoint`
- Validate `SelectionGoal` pixel values against the eventual display/layout layer

## Display Validation

- FoldMap end-to-end prototype complete
- FoldMap invalidation precision complete; go decision made for a second validation layer
- Conversion benchmark through FoldMap complete via `bun run bench:fold-map` in `packages/editor`
- Fold-boundary edge cases covered: nested, document edges, boundary edits, and edits inside folds
- Virtual row and horizontal chunk records for browser-backed rendering complete
- Fixed-row virtualizer math and tests complete
- Native browser selection, caret, and hit-testing validation over mounted virtual rows complete
- Vertical virtualization with browser scroll height and overscanned row windows complete
- Horizontal chunking for long lines without full DOM materialization complete
- CSS Highlight API paints visible syntax/selection ranges over mounted content and chunks
- Syntax fold candidates render gutter controls and toggle collapsed FoldMap rows
- Initial 2D virtualization benchmark complete for 100K-line documents and 50K-character lines via `bun run bench:virtualization` in `packages/editor`
- Display transform core complete for shared invalidation primitives, tab-column mapping, wrap rows, block-row primitives, and virtualizer integration
- Extend 2D virtualization benchmarks to dense decorations and wider scroll-window scenarios

## Scheduling Validation

- Lean syntax scheduler slice complete: syntax and plugin highlight refreshes now use a shared latest-result-wins helper with stale result/error dropping, disposal cleanup, and request timing.
- Rapid edit syntax/highlight debounce complete: edit-triggered refreshes are delayed by 75ms and repeated edits coalesce to the latest document text; open, undo, redo, and full refresh remain immediate.
- Helper and editor coverage complete for delayed supersession, stale result/error rejection, dispose cleanup, rapid edit coalescing, and immediate non-edit refreshes.
- Implement main-thread frame coalescing for viewport and mounted highlight updates beyond the existing virtualizer scroll coalescing
- Implement worker-side priority lanes for transactions, visible syntax, interactive queries, background work, and idle cleanup
- Add stale-result rejection tests for every worker result type not covered by the lean syntax/highlight helper
- Add coalescing tests for scroll events and visible syntax requests
- Add starvation tests: visible and interactive work must run while background work is pending
- Add pressure-state reporting and degradation behavior for huge files
- Add lane timing counters and benchmark assertions against the performance targets

## Syntax Validation

- Design worker protocol for parse/query requests, cancellation, and snapshot-tagged results
- Choose browser-compatible Tree-sitter runtime and parser packaging strategy
- Design worker-side language registry for parsers and query assets
- Prototype piece-table input adapter without whole-file flattening on every edit
- Translate batch edits into Tree-sitter input edits
- Tie parse results to `PieceTableSnapshot` versions and reject stale output
- Convert highlight query captures into dense editor decorations
- Convert structural selection node/token ranges into anchor-backed selections
- Derive syntax fold ranges for FoldMap
- Validate language injections with parent-buffer coordinates
- Benchmark parse/update/query time, memory, and GC on 10K, 50K, and 100K-line files

## Undo/Redo Validation

- Rapid undo/redo performance
- Interleaved multi-entry history validation once worker transactions own edit boundaries
- Decide final ownership boundary for history once worker transactions are introduced

## Scale Validation

- Baseline benchmarks before new features
- Define "representative editing patterns"
- Multi-cursor targets (100 cursors x FoldMap)
- Tree-sitter visible-range query latency under rapid edits
- 50K+ line stress tests
- GC profiling under rapid editing
- 100+ edits without resolving, then resolve all

## Storage Validation

- Chunked buffer: constant per-insertion time, bounded GC, large paste handling
- Undo/redo-heavy storage benchmarks

## Testing Strategy

- Round-trip invariants for all conversions
- Edit stability: random edits, verify anchor resolution
- Multi-snapshot consistency: old snapshots intact after new edits
- Display layer isolation tests
- Fuzz testing: random insert/delete/anchor sequences
- Surrogate pair handling with emoji and non-BMP characters
