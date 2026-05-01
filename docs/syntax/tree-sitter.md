# Tree-sitter Syntax System

## Decision

Tree-sitter is the default syntax engine for the editor. Shiki remains available as an optional highlighter package for hosts that prefer it.

Tree-sitter provides a single structural model for:

- syntax highlighting through highlight queries
- folds
- structural selection expand/shrink
- bracket and tag matching
- indentation
- language injections
- outline-style symbol extraction
- future semantic decorations and code-intelligence hooks

## Core Invariant

The piece table remains the canonical document model. A Tree-sitter parse is a derived projection over one `PieceTableSnapshot`.

Selections are stored as anchors, not Tree-sitter nodes. Tree-sitter can create, expand, shrink, and classify selections, but the resulting ranges must cross the API boundary as anchor-backed ranges.

This preserves correctness when:

- parsing is stale
- syntax is temporarily invalid
- no grammar exists for the file
- edits arrive faster than worker parsing
- undo/redo switches snapshots
- multi-cursor selections cross syntax boundaries

## Worker Ownership

Tree-sitter is worker-owned. Parser creation, grammar loading, parsing, incremental reparsing, query execution, injected-language parsing, and syntax-tree traversal all run in workers.

The main thread may render syntax results, but it must not synchronously parse or query during typing. It should only consume compact, snapshot-tagged worker outputs:

- highlight decorations
- fold ranges
- structural-selection ranges
- indentation hints
- bracket/tag match ranges
- outline or symbol summaries

Each parse result is tied to a document snapshot/version. Consumers must be able to reject syntax results whose base snapshot is older than the visible document state.

## Incremental Parse Pipeline

1. Worker receives an edit batch against snapshot `S`.
2. Piece table produces snapshot `S+1`.
3. The syntax system translates the edit batch into Tree-sitter input edits.
4. Tree-sitter incrementally reparses against `S+1`.
5. Queries run for invalidated or visible ranges first.
6. Query results are emitted as syntax decorations or structural ranges tagged with their base snapshot.

Open implementation details:

- exact Tree-sitter input adapter for piece-table reads
- worker protocol for parse/query requests and result cancellation
- parser package loading and language registry beyond the current plugin descriptor contract
- query asset format beyond raw highlight/fold/injection query strings
- parse tree retention across undo/redo
- memory limits and eviction policy
- cancellation or superseding behavior for stale parses

## Highlighting

Tree-sitter highlight queries are the long-term source of syntax highlighting.

Highlight output should be represented as dense decorations with offsets or line-scoped ranges. It must not allocate an anchor per token. The renderer may continue using the CSS Highlight API, but the source of ranges should be Tree-sitter query output.

## Structural Selection

Structural selection is syntax-driven and anchor-backed.

Examples:

- select smallest named node at cursor
- expand to containing expression/block/function/class
- shrink through the previous expansion stack
- select sibling node or list item
- select Tree-sitter leaf/token range

The selection model still stores `Selection<Anchor>[]`. Tree-sitter nodes are transient helpers for computing the next selection range.

## Folds

Fold ranges should be derived from Tree-sitter queries where a grammar is available. Manual folds and fallback indentation folds can coexist, but syntax folds are the primary path.

Fold ranges should cross into the display transform layer as anchor-backed ranges so FoldMap remains snapshot-aware.

## Injections

Language injections are part of the syntax system, not a separate tokenizer path.

Injected parse trees must retain parent snapshot identity and produce highlights/decorations in buffer coordinates so rendering and selection stay unified.

## Acceptance Criteria

| Deliverable | Acceptance Criteria |
|---|---|
| Worker-owned runtime | Parser creation, parsing, query execution, tree traversal, and injections all run off the main thread |
| Language registry | Loads parser + queries from registered language plugins by explicit language id inside workers |
| Piece-table input adapter | Tree-sitter can read document text without flattening whole files on every parse |
| Incremental edit bridge | Batched edits update the previous parse tree correctly |
| Parse snapshots | Parse results are tagged with document snapshot/version and stale results are rejected |
| Highlight queries | Tree-sitter query captures produce editor decorations compatible with CSS Highlight rendering |
| Structural selection | Expand/shrink/select-token produce anchor-backed selections |
| Fold queries | Syntax folds feed FoldMap as anchor-backed ranges |
| Injection support | Embedded languages produce correct ranges in parent buffer coordinates |
| Benchmarks | 10K, 50K, 100K-line parse/update/query timings and memory |
| Fallback behavior | Unknown language or failed parse leaves plain editing, selections, and rendering functional |
