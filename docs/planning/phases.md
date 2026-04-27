# Implementation Phases

## Phase 1: Storage Foundation + Line-Break Augmentation

Resolve storage prerequisites, extend treap with line-break tracking.

| Deliverable | Acceptance Criteria |
|---|---|
| Opaque `BufferId` type | Complete. `PieceBufferId` is an opaque branded string. No string literal comparisons. |
| Chunked append buffer | Complete. Immutable chunks, each with own `BufferId`. Append O(1) amortized. 1000+ insertions = constant per-insertion time. |
| Piece.lineBreaks | Complete. Correct on creation and split. |
| subtreeLineBreaks aggregate | Complete. Maintained through all operations in aggregate function pattern. |
| offsetToPoint | Complete. Correct for all positions. |
| pointToOffset | Complete. Round-trips with offsetToPoint; clamps out-of-range columns. |

## Phase 2: Anchor System

Anchor type, creation, resolution (with liveness), comparison. Linear-scan first, then indexed.

| Deliverable | Acceptance Criteria |
|---|---|
| Anchor type + sentinels | MIN/MAX resolve correctly in all snapshots |
| anchorAt / anchorBefore / anchorAfter | Real anchors for all positions; live at creation |
| Boundary creation | At piece boundaries, left bias anchors to the left piece end; right bias anchors to the right piece start |
| Invisible-piece deletion | `Piece.visible` exists; delete marks pieces invisible; user-facing length/offsets count only visible pieces |
| resolveAnchor (linear-scan) | Correct after inserts, deletes; returns liveness |
| subtreeVisibleLength aggregate | Maintained in aggregate function; invisible pieces contribute 0 |
| Persistent reverse index | Keyed by piece interval start `(buffer, piece.start)`; O(log m); persistent; snapshot-isolated |
| Bridging | End-to-end resolution correct |
| Atomic snapshot production | Both roots produced atomically per edit |
| Correctness suite | Indexed matches linear-scan across all patterns |
| Benchmark | 10K, 50K, 100K-line: resolution time, index cost, memory, GC |
| applyBatch | k edits atomically, one snapshot, one undo entry |

## Phase 3: Selection Model

`Selection<T>`, `SelectionGoal`, multi-cursor with merge-on-overlap.

| Deliverable | Acceptance Criteria |
|---|---|
| `Selection<T>` | Complete. Generic selection type with id, start/end, reversed, and goal. |
| `SelectionGoal` | Complete. Stored with selections; pixel values remain display-derived. |
| Anchor-backed selections | Complete. Active state can be represented as `Selection<Anchor>[]`. |
| Lazy normalization | Complete. `SelectionSet` carries a snapshot-scoped normalization-valid flag; consumers normalize on demand. |
| Merge semantics | Complete. Resolved ranges sort by offset and merge when overlapping or touching. |
| Selection edits | Complete. Text replacement and backspace produce batch edits against the original snapshot. |
| Undo boundary | Complete. Minimal O(1) linked-stack history helper stores snapshots and selection state together. |

## Phase 4: Tree-sitter Syntax System

Replace Shiki as the long-term syntax path. Tree-sitter becomes the source of syntax structure, highlighting, folds, structural selection, indentation, injections, and related query-driven features.

| Deliverable | Acceptance Criteria |
|---|---|
| Worker-owned runtime | Parser creation, parsing, query execution, tree traversal, and injections all run off the main thread |
| Language registry | Parser and query assets load by language id / file type inside workers |
| Piece-table input adapter | Parser reads from the document model without whole-file flattening on every edit |
| Incremental edit bridge | Batch edits update Tree-sitter trees correctly |
| Parse snapshot identity | Parse results are tied to document snapshots; stale results are rejected |
| Highlight queries | Query captures emit dense decorations compatible with CSS Highlight rendering |
| Structural selection | Node/token expand and shrink produce `Selection<Anchor>[]` |
| Fold queries | Syntax folds produce anchor-backed ranges for FoldMap |
| Injection support | Embedded languages parse and highlight in parent buffer coordinates |
| Benchmark | 10K, 50K, 100K-line parse/update/query time, memory, GC |
| Fallback behavior | Unknown language or parser failure leaves editing and plain rendering functional |

## Phase 5: Display Transform Validation

FoldMap as first layer. Go/no-go for the layered abstraction.

| Deliverable | Acceptance Criteria |
|---|---|
| FoldMap + FoldPoint | Bidirectional conversion, all fold configurations |
| Layer interface validation | Full contract works |
| Invalidation precision | Tight bounds: interior = no output; boundary = fold only; external = shifted |
| Round-trip correctness | All in-range positions |
| Edge cases | Line boundary folds, nested, document edges, edit inside fold |
| Performance baseline | Single-layer overhead; extrapolate multi-layer |
| Go/no-go decision | Based on invalidation precision |

## Phase 6: Additional Transforms (Conditional)

Only if FoldMap succeeds. Scope depends on Phase 5.
