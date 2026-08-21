# @singapor/diff

Diff rendering and editor-diff helpers for Singapor.

## Install

```sh
npm install @singapor/core @singapor/diff
```

## Usage

A diff is a real `Editor` with one plugin. The plugin owns the diff model, the projected rows, the
expansion state and the gutter; the **host owns the editor's document**, because no plugin context
can mutate document text. So the host pushes the plugin's rows in and re-applies its tokens:

```ts
import { createDiffPlugin, joinRenderLines, parseGitPatch } from '@singapor/diff'
import { Editor } from '@singapor/core/editor'
import '@singapor/core/style.css'
import '@singapor/diff/style.css'

const plugin = createDiffPlugin({ mode: 'document', side: 'stacked' })
const editor = new Editor(host, {
  cursorLineHighlight: { gutterNumber: false, gutterBackground: false, rowBackground: false },
  documentMode: 'static',
  editability: 'readonly',
  keymap: { defaultBindings: false, layers: [] },
  plugins: [plugin],
  tabSize: 4,
})

const push = () => {
  // `setText` clears tokens, so the tokens go back on immediately or a toggle flashes uncoloured.
  editor.setText(joinRenderLines(plugin.getRows()), { languageId: null })
  editor.setTokens(plugin.getTokens())
}
plugin.onDidChangeRows(push)
plugin.onDidChangeTokens(() => editor.setTokens(plugin.getTokens()))

plugin.setFile(parseGitPatch(patchText)[0])
```

Four of those options are load-bearing rather than taste:

- **`languageId: null`** — the editor's document is the *interleaved* buffer. Give it a real language
  and tree-sitter parses that interleaving and feeds the result into folds, brackets and injections.
  The language belongs to the plugin's own per-side syntax documents, which is where it lives.
- **`tabSize`** — omit it and `adoptDocumentTabSize` guesses from the buffer on every `setText`, so
  tab width flips per file *and* per expansion toggle.
- **`cursorLineHighlight`** with explicit `false`s — the default is `rowBackground: true`, which
  paints a cursor line on top of the diff row tint. `undefined` means *default*, not off.
- **`keymap: { defaultBindings: false, layers: [] }`** — a real editor otherwise brings find and the
  edit commands into a read-only diff.

Split mode is two editors, `side: 'old'` and `side: 'new'`, laid out and scroll-synced by the host.
The two panes stay aligned only while word wrap is off and no fold map is set; the plugin reports
`getDocumentModeViolations()` if the row-index identity it depends on is ever broken.

## Modes

- **`document`** (default) — the editor holds a synthetic buffer of the projected rows. Deletion rows
  are real document lines, so they highlight, select and copy like any other text. This is the
  parity path.
- **`overlay`** — the editor holds the host's live, editable buffer and deletions arrive as injected
  rows. Injected rows have no offset space (`startOffset === endOffset`), which means no selection,
  no copy, no inline word-diff, and syntax colouring borrowed from whatever document text sits at
  the anchor offset. Non-parity by construction — see `test/overlayModeLimits.test.ts`. Use it for a
  live dirty-diff against an editable document, not for a diff view.

## Exports

- `createDiffPlugin` — the one plugin factory, carrying both modes.
- `parseGitPatch` and `createTextDiff` build diff models.
- `createSplitProjection`, `createStackedProjection`, and `createLiveDiffProjection` expose render
  projections.
- `joinRenderLines` turns projected rows into the buffer text the host pushes in.
- `projectDiffSyntaxTokens` maps full-file token streams onto projected rows.
