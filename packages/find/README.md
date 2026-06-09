# @singapor/find

Find and replace plugin for `@singapor/core`.

## Install

```sh
npm install @singapor/core @singapor/find
```

## Usage

```ts
import { Editor } from "@singapor/core/editor";
import { createEditorFindPlugin } from "@singapor/find";
import "@singapor/core/style.css";
import "@singapor/find/style.css";

const editor = new Editor(document.querySelector("#editor")!, {
  plugins: [createEditorFindPlugin()],
});
```

## Exports

- `createEditorFindPlugin` registers find, replace, and match-selection commands.
- `createEditorFindContributionProviders` exposes the find widget and capability providers.
- `EDITOR_FIND_FEATURE` and `EDITOR_FIND_FEATURE_ID` expose the find feature capability token.
