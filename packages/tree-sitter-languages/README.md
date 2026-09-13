# @singapore-editor/tree-sitter-languages

Bundled Tree-sitter language contributions for Singapore.

The package includes JavaScript, TypeScript, TSX, JSX, HTML, CSS, JSON, Markdown, and Markdown-inline
language contributions and queries.

## Install

```sh
npm install @singapore-editor/core @singapore-editor/tree-sitter @singapore-editor/tree-sitter-languages
```

## Usage

```ts
import { Editor } from '@singapore-editor/core/editor'
import { javaScript, typeScript } from '@singapore-editor/tree-sitter-languages'

const editor = new Editor(document.querySelector('#editor')!, {
  plugins: [javaScript({ jsx: true }), typeScript({ tsx: true })],
})
```

## Exports

- `javaScript`, `typeScript`, `html`, `css`, `json`, and `markdown` create language plugins.
- `TREE_SITTER_LANGUAGE_CONTRIBUTIONS` exports the bundled contribution list.
- Individual constants such as `JAVASCRIPT_TREE_SITTER_LANGUAGE` expose raw contributions.
