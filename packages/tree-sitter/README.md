# @singapor/tree-sitter

Tree-sitter syntax runtime for `@singapor/core`.

This package provides the syntax provider, language registry, worker client, source adapter, and
structural selection helpers. Pair it with `@singapor/tree-sitter-languages` for bundled language
contributions.

## Install

```sh
npm install @singapor/core @singapor/tree-sitter
```

## Usage

```ts
import { createTreeSitterSyntaxProvider } from "@singapor/tree-sitter";

const syntaxProvider = createTreeSitterSyntaxProvider();
```

Register the provider with an editor plugin context, or use `createTreeSitterLanguagePlugin` when
you already have language contributions to install.

## Exports

- `createTreeSitterSyntaxProvider` creates a syntax provider backed by a Tree-sitter worker.
- `createTreeSitterLanguagePlugin` registers language contributions with the default provider.
- `TreeSitterWorkerClient` and `createTreeSitterWorkerBackend` expose the worker transport.
- `expandTreeSitterSelection`, `shrinkTreeSitterSelection`, and `selectTreeSitterToken` provide
  structural selection helpers.
