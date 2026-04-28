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

- FoldMap end-to-end prototype
- FoldMap invalidation precision (go/no-go)
- Conversion benchmark through FoldMap
- Fold-boundary edge cases
- If FoldMap succeeds: design next layer (likely wrapping)
- Define virtual row and horizontal chunk records for browser-backed rendering
- Build fixed-row virtualizer math and tests before wiring it into the editor
- Validate native browser selection, caret, and hit-testing on mounted virtual rows
- Validate vertical virtualization with browser scroll height and overscanned row windows
- Validate horizontal chunking for long lines without full DOM materialization
- Verify CSS Highlight API can paint visible syntax/selection ranges over mounted content
- Benchmark 2D virtualization with long documents, 50K-character lines, dense decorations, and wide scroll windows

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
