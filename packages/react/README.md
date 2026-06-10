# @singapor/react

React bindings for `@singapor/core`.

## Install

```sh
npm install @singapor/core @singapor/react react react-dom
```

## Usage

```tsx
import { EditorHost, useEditor } from '@singapor/react'
import '@singapor/core/style.css'

export function EditorPanel() {
  const controller = useEditor({
    document: {
      documentId: 'example.ts',
      text: 'const value = 1;\n',
      languageId: 'typescript',
    },
  })

  return <EditorHost controller={controller} />
}
```

## Exports

- `useEditor` creates and synchronizes an editor controller with React state.
- `EditorHost` mounts the editor into the DOM.
- `useEditorSelector` subscribes to selected editor store values.
- `createReactEditorBlocksPlugin` renders editor block surfaces through React portals.
