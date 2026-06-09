# @singapor/lsp-plugin

Editor integration layer for LSP-backed Singapor language features.

This package adapts `@singapor/lsp` transports to `@singapor/core` plugins for diagnostics,
completion, hover, definition navigation, references, and document synchronization.

## Install

```sh
npm install @singapor/core @singapor/lsp @singapor/lsp-plugin
```

## Usage

```ts
import {
  createLanguageServerAdapterPlugin,
  createWebSocketLspTransportFactory,
} from "@singapor/lsp-plugin";

const plugin = createLanguageServerAdapterPlugin({
  name: "typescript-lsp",
  createTransport: createWebSocketLspTransportFactory("ws://localhost:3000/lsp"),
  documentSync: {
    shouldSyncLanguageId: (languageId) => languageId === "typescript",
  },
});
```

## Exports

- `createLanguageServerAdapterPlugin` creates the full editor integration.
- `createLanguageServerPlugin` exposes a lower-level plugin factory.
- `createWebSocketLspTransportFactory` and `createWorkerLspTransportFactory` create transport
  factories.
- Diagnostic, path, markdown tooltip, completion, and document-sync helpers are available through
  subpath exports.
