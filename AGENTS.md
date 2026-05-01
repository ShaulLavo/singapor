# AGENTS.md

Instructions for AI coding agents working with this codebase.

## Project Overview

Browser-based code editor targeting ultra-low latency typing (<1-2ms perceived). Treap-backed piece table with persistent immutable snapshots, CSS Highlight API rendering, and a committed Tree-sitter syntax system.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the high-level system design: main thread vs worker split, core systems, data flow, and remaining open questions.

## Design Documents

### Storage

- [Piece Table](docs/storage/piece-table.md) — Treap-backed piece table, buffers, snapshots, aggregate maintenance, enrichment roadmap, Phase 1 prerequisites (opaque BufferId, chunked append buffer)

### Positions

- [Types & Conversions](docs/positions/types-and-conversions.md) — Offset, Point, Anchor hierarchy; line-break augmentation; conversion functions
- [Anchors](docs/positions/anchors.md) — Durable position references, creation, deletion/bias rules, resolution architecture (reverse index + enriched treap), snapshot consistency

### Editing

- [Selections & Undo](docs/editing/selections-and-undo.md) — Anchor-based selections, multi-cursor, lazy normalization, batch edits, edit/patch representation, snapshot-based undo

### Display

- [Transforms](docs/display/transforms.md) — Layered transform hypothesis, layer interface, invalidation protocol, FoldMap validation, decoration constraints

### Syntax

- [Tree-sitter](docs/syntax/tree-sitter.md) — Committed syntax engine for highlighting, folds, structural selection, indentation, injections, and query-driven features

## Codebase

### Packages

| Package | Purpose | Key files |
|---|---|---|
| `packages/editor` | Core editor: piece table + CSS Highlight API renderer | `src/pieceTable/pieceTable.ts`, `src/pieceTable/pieceTableTypes.ts`, `src/editor.ts`, `src/tokens.ts` |
| `packages/shiki` | Optional Shiki highlighter/tokenizer plugin | `src/tokenizer.ts`, `src/editor-tokens.ts` |
| `examples/app` | Demo app with file browser | `src/app.ts`, `src/main.ts` |

### What's Implemented

- **Piece table** — Treap with persistent snapshots, insert/delete/read, structural sharing
- **CSS Highlight API renderer** — Token-based syntax highlighting via `Highlight` objects
- **Anchors and selections** — Durable anchor resolution, selection sets, and snapshot-aware history helpers
- **Tree-sitter syntax path** — Worker-backed parsing/query support and structural selection integration
- **Display transforms and virtualization** — FoldMap, row virtualization, long-line chunking, and mounted-range highlight painting
- **Shiki highlighter** — Optional highlighter/tokenizer package for hosts that prefer Shiki
- **Example app** — File System Access API browser + editor integration

### Still Evolving

- Worker transaction ownership and scheduling boundaries
- Decoration system beyond current syntax/selection highlight paths
- Performance validation for very large files, dense decorations, and rapid editing

### Key Types (in code)

| Type | Location |
|---|---|
| `Piece` | `packages/editor/src/pieceTable/pieceTableTypes.ts` |
| `PieceBufferId` | `packages/editor/src/pieceTable/pieceTableTypes.ts` |
| `PieceTreeNode` | `packages/editor/src/pieceTable/pieceTableTypes.ts` |
| `PieceTableSnapshot` | `packages/editor/src/pieceTable/pieceTableTypes.ts` |
| `EditorToken`, `EditorTokenStyle`, `TextEdit` | `packages/editor/src/tokens.ts` |
| `TokenPatch`, `IncrementalTokenizer` | `packages/shiki/src/tokenizer.ts` |
| `Editor` (class) | `packages/editor/src/editor.ts` |

### Terminology

- **Piece** — the fundamental text-slice record. Other editors sometimes call this a "fragment" (e.g., Zed). In this codebase, it's always a Piece.

## Build & Test

Monorepo managed by Turborepo with Bun.

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is available in `opensrc/` for deeper understanding of implementation details.

See `opensrc/sources.json` for the list of available packages and their versions.

Use this source code when you need to understand how a package works internally, not just its types/interface.

### Fetching Additional Source Code

To fetch source code for a package or repository you need to understand, run:

```bash
npx opensrc <package>           # npm package (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python package (e.g., npx opensrc pypi:requests)
npx opensrc crates:<package>    # Rust crate (e.g., npx opensrc crates:serde)
npx opensrc <owner>/<repo>      # GitHub repo (e.g., npx opensrc vercel/ai)
```

<!-- opensrc:end -->
