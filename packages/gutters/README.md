# @singapor/gutters

Line-number and fold-gutter plugins for `@singapor/core`.

## Install

```sh
npm install @singapor/core @singapor/gutters
```

## Usage

```ts
import { Editor } from "@singapor/core/editor";
import { createFoldGutterPlugin, createLineGutterPlugin } from "@singapor/gutters";
import "@singapor/core/style.css";
import "@singapor/gutters/style.css";

const editor = new Editor(document.querySelector("#editor")!, {
  plugins: [createLineGutterPlugin(), createFoldGutterPlugin()],
});
```

## Exports

- `createLineGutterPlugin` adds a line-number gutter.
- `createFoldGutterPlugin` adds fold controls for syntax fold markers.
- `createLineGutterContribution` and `createFoldGutterContribution` expose the lower-level gutter
  contributions.
- `@singapor/gutters/style.css` imports both gutter styles.
