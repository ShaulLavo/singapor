# @singapor/solid

Solid bindings for `@singapor/core`.

## Install

```sh
npm install @singapor/core @singapor/solid solid-js
```

## Usage

```tsx
import { createEditor } from "@singapor/solid";
import { onMount } from "solid-js";
import "@singapor/core/style.css";

export function EditorPanel() {
  let host!: HTMLDivElement;
  const controller = createEditor({
    document: {
      documentId: "example.ts",
      text: "const value = 1;\n",
      languageId: "typescript",
    },
  });

  onMount(() => controller.mount(host));

  return <div ref={host} />;
}
```

## Exports

- `createEditor` creates a Solid-owned editor controller.
- The controller exposes Solid accessors for editor state, snapshots, text, change metadata, and
  command helpers.
