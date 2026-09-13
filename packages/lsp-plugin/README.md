# @singapore-editor/lsp-plugin

Editor integration layer for LSP-backed Singapore language features.

This package adapts `@singapore-editor/lsp` transports to `@singapore-editor/core` plugins for diagnostics,
completion, hover, definition navigation, references, and document synchronization.

## Install

```sh
npm install @singapore-editor/core @singapore-editor/lsp @singapore-editor/lsp-plugin
```

## Usage

```ts
import {
  createLanguageServerAdapterPlugin,
  createWebSocketLspTransportFactory,
} from '@singapore-editor/lsp-plugin'

const plugin = createLanguageServerAdapterPlugin({
  name: 'typescript-lsp',
  createTransport: createWebSocketLspTransportFactory('ws://localhost:3000/lsp'),
  documentSync: {
    shouldSyncLanguageId: (languageId) => languageId === 'typescript',
  },
})
```

## Exports

- `createLanguageServerAdapterPlugin` creates the full editor integration.
- `createLanguageServerPlugin` exposes a lower-level plugin factory.
- `createWebSocketLspTransportFactory` and `createWorkerLspTransportFactory` create transport
  factories.
- Diagnostic, path, markdown tooltip, completion, and document-sync helpers are available through
  subpath exports.
