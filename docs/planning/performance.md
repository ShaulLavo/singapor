# Performance Targets & System Pressure

## Performance Targets

| Operation | Target | Measurement |
|---|---|---|
| Insert / delete | < 1 ms | 100K-line document, p99 |
| offsetToPoint / pointToOffset | < 0.5 ms | 100K-line document |
| resolveAnchor (indexed) | < 0.1 ms | 100K-line, 10K pieces |
| Reverse index update | < 0.5 ms | 100K-line, amortized |
| Snapshot switch (undo/redo) | < 0.01 ms | O(1) root swap |
| FoldMap conversion | < 0.5 ms | 100K-line, 100+ folds |
| Tree-sitter visible edit reparse | < 5 ms async | 100K-line document, visible edit |
| Tree-sitter visible highlight query | < 4 ms async | Visible range after edit |
| Structural selection query | < 2 ms async | Node expand/shrink at cursor |
| 100-cursor selection resolution | < 10 ms | 100K-line, FoldMap active |
| Memory per snapshot delta | < 1 KB | Single char insertion |

## GC Budget

| Constraint | Target |
|---|---|
| Max GC pause during typing | < 4 ms (25% of 16ms frame) |
| Pause frequency | No > 4ms pause more than once/sec |
| Heap growth rate | Sublinear over 1000 insertions |
| Heap after undo trim | Returns to baseline |

**Mitigations:** Pool nodes, batch keystrokes into single piece, tune chunk sizes.

## System Pressure

| Dimension | Typical | Stress | Extreme |
|---|---|---|---|
| Document size | 1K-10K lines | 50K-100K | 500K+ |
| Cursors | 1-5 | 20-50 | 100+ |
| Decorations | 100-500 | 5K-10K | 50K+ |
| Syntax captures | 1K-5K | 50K-100K | 500K+ |
| Edit frequency | 1-5/sec | 10-20/sec | 100+/sec |
| Pieces | 50-500 | 1K-5K | 10K+ |

## What Breaks First

1. **Write-path overhead:** ~20-40 persistent-tree mutations/sec under rapid editing. GC pressure, not algorithmic complexity.
2. **Resolution consistency:** Reverse index must exactly mirror treap per snapshot.
3. **Selection merge at scale:** 100 selections x O(log n) per frame.
4. **Soft-wrap invalidation:** Re-wrapping long lines.
5. **Display round-trip:** 50K decorations through multiple transforms.
6. **Tree-sitter memory pressure:** parse trees, query captures, and injected-language trees retained across snapshots.
7. **Add-buffer growth:** Solved by chunked buffer (Phase 1).

## Risks

| Risk | Mitigation | Status |
|---|---|---|
| Write-path constant factor | Two structures only; measure; pool if needed | Needs measurement |
| Index consistency | Atomic snapshot production; linear-scan baseline | Needs implementation |
| Snapshot consistency | Structural sharing, O(1) root swap | **Locked** |
| Add-buffer scaling | Chunked append buffer | **Resolved** |
| GC from cloning | Batch keystrokes; pool nodes | Needs measurement |
| Surrogate enforcement | `anchorAt` as sole entry point; fuzz tests | Needs verification |
| Layer invalidation | FoldMap validation; fallback to monolithic | **Open** |
| Tree-sitter parse/query memory | Snapshot-scoped retention limits; visible-first queries; stale-result rejection | Needs design |
| Anchor debugging | Debug inspector | Planned |
