# @singapor/typescript-lsp

TypeScript language-service plugin for Singapor.

This package wires the generic LSP adapter to a browser worker backed by TypeScript and
`@typescript/vfs`.

## Install

```sh
npm install @singapor/core @singapor/typescript-lsp
```

## Usage

```ts
import { Editor } from "@singapor/core/editor";
import { createTypeScriptLspPlugin } from "@singapor/typescript-lsp";

const editor = new Editor(document.querySelector("#editor")!, {
  plugins: [createTypeScriptLspPlugin()],
});
```

## Exports

- `createTypeScriptLspPlugin` registers completion, diagnostics, hover, definition, and reference
  behavior for TypeScript documents.
- `createTypeScriptLspWorkerOwner` exposes the worker owner for custom wiring.
- `summarizeDiagnostics` and `diagnosticHighlightGroups` expose diagnostic helpers.
- `fileNameToDocumentUri`, `documentUriToFileName`, and related path helpers are re-exported.
