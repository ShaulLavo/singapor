# @singapor/minimap

Worker-backed minimap plugin for `@singapor/core`.

## Install

```sh
npm install @singapor/core @singapor/minimap
```

## Usage

```ts
import { Editor } from '@singapor/core/editor'
import { createMinimapPlugin } from '@singapor/minimap'
import '@singapor/core/style.css'
import '@singapor/minimap/style.css'

const editor = new Editor(document.querySelector('#editor')!, {
  plugins: [createMinimapPlugin()],
})
```

## Exports

- `createMinimapPlugin` adds the minimap view contribution.
- `EditorMinimapOptions` configures side, size, autohide behavior, slider visibility, and section
  headers.
- `@singapor/minimap/style.css` contains the minimap stylesheet.
