# @singapor/markdown

Markdown live preview for the Singapore editor. Markdown text stays the document — this renders it as
formatted text without ever converting it into another model.

```ts
import { createMarkdownPreviewPlugin } from '@singapor/markdown'
import '@singapor/markdown/style.css'

new Editor(container, {
  plugins: [markdown(), createMarkdownPreviewPlugin()],
})
```

The plugin's presence is the switch. It needs a markdown language plugin alongside it (for example
`markdown()` from `@singapor/tree-sitter-languages`), because it reads that grammar's captures.

## What it does

| Source                  | Rendered        |
| ----------------------- | --------------- |
| `# Title`               | `Title`         |
| `a **bold** b`          | `a bold b`      |
| `an _em_ word`          | `an em word`    |
| ``use `code` here``     | `use code here` |
| `[docs](https://x.dev)` | `docs`          |
| `![alt](img.png)`       | `alt`           |
| `- item`                | `• item`        |

Ordered lists, block quotes, escapes, and fenced code blocks are deliberately left as written.

## How it works

There is no second document model. The buffer holds markdown text and the editor's inline display
transform paints something else over parts of it — see [Display: Transforms](../../docs/display/transforms.md).
Because the text never changes, undo, selections, folds, find, and anchors all keep working on the
markdown itself, and there is no round-trip to lose fidelity to.

Constructs reveal as you reach them: put the caret anywhere inside `**bold**` and both fences come
back, so it stays editable as plain text.

`markdownInlineReplacements(text, captures)` is exported on its own if you want the derivation
without the plugin.
