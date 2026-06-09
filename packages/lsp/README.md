# @singapor/lsp

Runtime-neutral LSP client primitives for Singapor packages.

This package is the low-level transport and protocol layer. Use `@singapor/lsp-plugin` when you want
an editor plugin that connects these primitives to `@singapor/core`.

## Install

```sh
npm install @singapor/lsp
```

## Usage

```ts
import { LspClient, createWebSocketLspTransport } from "@singapor/lsp";
```

## Exports

- `LspClient` manages request, response, notification, and workspace synchronization state.
- `createWebSocketLspTransport` and `createWorkerLspTransport` create managed transports.
- Position helpers convert between editor offsets and LSP positions.
- Protocol error helpers expose LSP response and cancellation errors.
- `lsp` re-exports `vscode-languageserver-protocol` types.
