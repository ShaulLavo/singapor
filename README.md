# Singapore Editor

Singapore Editor is a browser-based code editor toolkit focused on very low-latency editing,
syntax-aware interactions, browser-native rendering, and plugin-driven extension points.

The name is a nod to Monaco Editor: another editor named after a city-state.

The editor core owns the in-memory document model and editing runtime. It does not own persistence:
host applications provide text, decide where files live, and choose how documents are loaded, saved,
cached, or synchronized.

The package surface is meant to be installed, embedded, and extended. The core editor exposes
plugins for gutters, view contributions, syntax/language registration, highlighters, themes,
commands, and editor features. The app in `examples/app` is a demo integration of those packages,
not the product boundary.

## Status

This repository is an active implementation workspace. The API and package boundaries are still
moving, but the current packages include:

- A core editor package with an in-memory piece-table document model, immutable snapshots,
  offset/point conversion, durable anchors, selections, and undo/redo helpers.
- Rendering through the CSS Highlight API, mounted-row painting, fixed-row virtualization, and
  horizontal chunking for very long lines.
- Editing behavior for multi-selection edits, keyboard navigation, folds, display transforms, and
  syntax-aware structural selection.
- Worker-backed Tree-sitter parsing/query support for syntax highlights, folds, structural
  selection, and language-specific behavior.
- Plugin APIs for gutters, view contributions, editor features, highlighters, themes, commands, and
  language registration.
- First-party plugins/packages for line gutters, fold gutters, find/replace, scope lines, minimap,
  TypeScript LSP support, and Tree-sitter language registration.
- An optional Shiki highlighter plugin for hosts that prefer Shiki tokenization.
- A Vite example app that wires the packages into a file-browser-style demo.

For the implementation history, see [PROGRESS.md](PROGRESS.md). For system design and open
architecture questions, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Packages

| Package | Purpose |
| --- | --- |
| `@editor/core` | Core editor runtime, document model, anchors, selections, syntax sessions, folds, transforms, virtualization, renderer, themes, and plugin contracts. |
| `@editor/gutters` | Line-number and fold-gutter plugins for the core editor. |
| `@editor/find` | Find and replace plugin for the core editor. |
| `@editor/minimap` | Minimap plugin with worker-backed document rendering. |
| `@editor/scope-lines` | Scope-line view contribution plugin. |
| `@editor/tree-sitter-languages` | Tree-sitter language contributions and queries for JavaScript, TypeScript, HTML, CSS, and JSON. |
| `@editor/typescript-lsp` | TypeScript language-service plugin built on the generic LSP layer. |
| `@editor/lsp` | Generic LSP transport and plugin primitives. |
| `@editor/shiki` | Optional Shiki highlighter plugin for hosts that prefer Shiki tokenization. |
| `@editor/example-app` | Demo application using the editor, language plugins, gutters, minimap, and File System Access/GitHub-backed source browsing. |

## Requirements

- [Bun](https://bun.sh/) `1.3.10` or compatible.
- A modern browser with CSS Highlight API support for the full rendering path.
- Playwright browser dependencies for browser and e2e tests.

## Getting Started

Install dependencies:

```sh
bun install
```

Run the example app:

```sh
bun run dev
```

The root `dev` script runs Turborepo. The demo app itself lives in `examples/app` and is served by
Vite.

Minimal editor embedding looks like this:

```ts
import { Editor } from "@editor/core/editor";
import "@editor/core/style.css";

const editor = new Editor(document.querySelector("#editor")!);
editor.openDocument({
  documentId: "example.ts",
  text: "const value = 1;\n",
  languageId: "typescript",
});
```

## Common Commands

Run the main workspace checks:

```sh
bun run typecheck
bun run test
bun run lint
bun run build
```

Format the workspace:

```sh
bun run format
```

Check formatting without writing changes:

```sh
bun run format:check
```

Run package-specific browser tests:

```sh
bun --cwd packages/editor run test:browser
bun --cwd packages/minimap run test:browser
bun --cwd packages/shiki run test:browser
```

Run the example app e2e tests:

```sh
bun --cwd examples/app run test:e2e
```

## Benchmarks

Editor benchmarks live in `packages/editor/bench`:

```sh
bun --cwd packages/editor run bench:piece-table
bun --cwd packages/editor run bench:anchors
bun --cwd packages/editor run bench:syntax
bun --cwd packages/editor run bench:fold-map
bun --cwd packages/editor run bench:transforms
bun --cwd packages/editor run bench:virtualization
```

## Documentation

- [Architecture](ARCHITECTURE.md) - main-thread/worker split, core systems, data flow, and open questions.
- [Progress](PROGRESS.md) - implementation phases, validation history, and current open areas.
- [Storage: Piece Table](docs/storage/piece-table.md) - treap-backed storage model.
- [Positions: Types & Conversions](docs/positions/types-and-conversions.md) - offsets, points, and conversions.
- [Positions: Anchors](docs/positions/anchors.md) - durable position references.
- [Editing: Selections & Undo](docs/editing/selections-and-undo.md) - selection, batch edit, and history model.
- [Display: Transforms](docs/display/transforms.md) - transform layers and invalidation.
- [Display: Browser Virtualization](docs/display/browser-virtualization.md) - browser layout and viewport strategy.
- [Syntax: Tree-sitter](docs/syntax/tree-sitter.md) - syntax engine design.

## Source Layout

```text
packages/editor/                  Core editor package
packages/gutters/                 Line and fold gutter plugins
packages/minimap/                 Minimap plugin and worker renderer
packages/tree-sitter-languages/   Tree-sitter grammar/query plugin package
packages/shiki/                   Optional Shiki highlighter plugin
examples/app/                     Demo app
docs/                             Design documents
opensrc/                          Local source references for selected dependencies
```

## Notes

Singapore Editor is optimized for design validation and performance work, not for publishing a
stable editor API yet. Prefer the design docs, tests, and package-local behavior as the source of
truth when changing core systems.
