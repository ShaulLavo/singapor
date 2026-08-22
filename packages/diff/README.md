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
  // Tokens go back on immediately: `setText` clears them on its way through
  // `resetOwnedDocument` -> `setDocument` -> `setContent`, so a toggle would otherwise repaint
  // uncoloured.
  //
  // `Editor.syncText` is the cheaper alternative — it computes the minimal prefix/suffix edit
  // rather than tearing the document down, and for an expansion that edit is exactly the inserted
  // lines. It is not the default here because it also preserves caret and selection across rows
  // that have moved, and an expansion moves every row below the region: a reader holding a
  // selection would find it pointing at different text. Worth taking if your host has no selection
  // to lose.
  editor.setText(joinRenderLines(plugin.getRows()), { languageId: null })
  editor.setTokens(plugin.getTokens())
}
plugin.onDidChangeRows(push)
plugin.onDidChangeTokens(() => editor.setTokens(plugin.getTokens()))

plugin.setFile(parseGitPatch(patchText)[0])
```

Four of those options are load-bearing rather than taste:

- **`languageId: null`** — the editor's document is the _interleaved_ buffer. Give it a real language
  and tree-sitter parses that interleaving and feeds the result into folds, brackets and injections.
  The language belongs to the plugin's own per-side syntax documents, which is where it lives.
- **`tabSize`** — omit it and `adoptDocumentTabSize` guesses from the buffer on every `setText`, so
  tab width flips per file _and_ per expansion toggle.
- **`cursorLineHighlight`** with explicit `false`s — the default is `rowBackground: true`, which
  paints a cursor line on top of the diff row tint. `undefined` means _default_, not off.
- **`keymap: { defaultBindings: false, layers: [] }`** — a real editor otherwise brings find and the
  edit commands into a read-only diff.

Split mode is two editors, `side: 'old'` and `side: 'new'`, laid out and scroll-synced by the host.
**Give both plugins the same region store**, or expanding a collapsed region on one side leaves the
other where it was and every row below it misaligns:

```ts
const regions = createDiffRegionStore()
const left = createDiffPlugin({ mode: 'document', side: 'old', regions })
const right = createDiffPlugin({ mode: 'document', side: 'new', regions })
```

This is not the mirroring the design forbids — there is one store, and both sides read it, rather
than two sets kept in step. The panes also stay aligned only while word wrap is off and no fold map
is set; the plugin reports `getDocumentModeViolations()` if the row-index identity it depends on is
ever broken.

Expansion is per _diff_, not per path: pushing the same path with different content resets it,
because region keys are absolute line numbers and any edit above a region renumbers it. Pushing an
identical file again keeps it.

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

- `createDiffPlugin` — the one plugin factory, carrying both modes. `mode` is required.
- `createDiffRegionStore` — shared expansion state for the two sides of a split view.
- `parseGitPatch` and `createTextDiff` build diff models.
- `createSplitProjection`, `createStackedProjection`, and `createLiveDiffProjection` expose render
  projections.
- `joinRenderLines` turns projected rows into the buffer text the host pushes in.
- `projectDiffSyntaxTokens` maps full-file token streams onto projected rows.
