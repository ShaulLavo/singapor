# @singapor/core

Core runtime for the Singapor code editor.

This package contains the editor class, document model, selection and anchor primitives, syntax
session contracts, rendering types, plugin APIs, themes, keymaps, and the core stylesheet.

## Install

```sh
npm install @singapor/core
```

Singapor packages publish TypeScript source and CSS assets. Use them with a bundler or runtime that
can transpile TypeScript from dependencies.

## Basic Usage

```ts
import { Editor } from "@singapor/core/editor";
import "@singapor/core/style.css";

const editor = new Editor(document.querySelector("#editor")!);

editor.openDocument({
  documentId: "example.ts",
  text: "const value = 1;\n",
  languageId: "typescript",
});
```

## Main Entry Points

- `@singapor/core` exports the public editor, document, rendering, syntax, keymap, and plugin APIs.
- `@singapor/core/editor` exports the `Editor` runtime and editor-specific types.
- `@singapor/core/document` exports document sessions, snapshots, piece-table helpers, anchors, and
  text edit primitives.
- `@singapor/core/extensions` exports plugin contribution contracts.
- `@singapor/core/rendering` exports themes and rendering types.
- `@singapor/core/syntax` exports syntax provider and syntax token helpers.
- `@singapor/core/style.css` is the base editor stylesheet.
