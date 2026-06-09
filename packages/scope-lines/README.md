# @singapor/scope-lines

Scope-line view contribution plugin for `@singapor/core`.

## Install

```sh
npm install @singapor/core @singapor/scope-lines
```

## Usage

```ts
import { Editor } from "@singapor/core/editor";
import { createScopeLinesPlugin } from "@singapor/scope-lines";
import "@singapor/core/style.css";
import "@singapor/scope-lines/style.css";

const editor = new Editor(document.querySelector("#editor")!, {
  plugins: [createScopeLinesPlugin()],
});
```

## Exports

- `createScopeLinesPlugin` renders vertical guides for visible syntax scopes.
- `ScopeLinesPluginOptions` controls mode, active-scope rendering, minimum span, and custom classes.
