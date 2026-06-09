# @singapor/diff

Diff rendering and editor-diff helpers for Singapor.

## Install

```sh
npm install @singapor/core @singapor/panes @singapor/diff
```

## Usage

```ts
import { DiffView, parseGitPatch } from "@singapor/diff";
import "@singapor/core/style.css";
import "@singapor/diff/style.css";

const files = parseGitPatch(patchText);
const diffView = new DiffView(document.querySelector("#diff")!, { files });
```

## Exports

- `DiffView` renders split or stacked file diffs.
- `createEditorDiffPlugin` adds live inline diff projection to an editor.
- `parseGitPatch` and `createTextDiff` build diff models.
- `createSplitProjection`, `createStackedProjection`, and `createLiveDiffProjection` expose render
  projections.
