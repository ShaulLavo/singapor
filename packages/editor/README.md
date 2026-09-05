# @singapor/core

Core runtime for the Singapor code editor.

This package contains the editor class, document model, selection and anchor primitives, syntax
session contracts, rendering types, plugin APIs, themes, keymaps, and the core stylesheet.

## Install

```sh
npm install @singapor/core
```

Singapor packages publish TypeScript source and CSS assets. Use them with a bundler or runtime that
can transpile TypeScript from dependencies.

## Basic Usage

```ts
import { Editor } from '@singapor/core/editor'
import '@singapor/core/style.css'

const editor = new Editor(document.querySelector('#editor')!)

editor.openDocument({
  documentId: 'example.ts',
  text: 'const value = 1;\n',
  languageId: 'typescript',
})
```

## Main Entry Points

- `@singapor/core` exports the public editor, document, rendering, syntax, keymap, and plugin APIs.
- `@singapor/core/editor` exports the `Editor` runtime and editor-specific types.
- `@singapor/core/document` exports document sessions, snapshots, piece-table helpers, anchors, and
  text edit primitives.
- `@singapor/core/extensions` exports plugin contribution contracts.
- `@singapor/core/rendering` exports themes and rendering types.
- `@singapor/core/syntax` exports syntax provider and syntax token helpers.
- `@singapor/core/style.css` is the base editor stylesheet.

## Chords and host keymaps

Declare shortcuts as a non-empty `chord` array. Single strokes use the same field.
Each Editor owns its sequence state and cancels it when focus leaves the editor.

```ts
const editor = new Editor(container, {
  keymap: {
    layers: [
      {
        id: 'comments',
        bindings: [
          {
            chord: ['Mod+K', 'Mod+C'],
            command: 'editor.action.commentLine',
            when: ['writable'],
          },
        ],
      },
    ],
  },
})
```

`keymap.preset` selects `default` or `vscode`. The default pack puts folding under
`Mod+K`; the VS Code pack uses its folding shortcuts and adds supported language
navigation, formatting, hover, and comment chords. Packs contain only commands
implemented by this Editor. They do not supply VS Code workbench commands.

Later layers precede earlier layers. Rows within a layer retain declaration order,
including rows with the same chord and different `when` conditions. At each stroke,
the runtime captures one context and tries eligible terminal candidates in order
until one dispatch claims the event. A declined candidate runs once, then falls
through. An eligible single stroke wins over a longer sequence with the same prefix.

An available prefix consumes the event immediately and starts a five-second timer.
After that prefix, completion and unmatched keys stay consumed even if availability
changes. Held keys remain owned through release. Repeats do not extend the timer.
`setKeymap()` replaces bindings and cancels pending state. `enabled: false` disables
shortcuts while native typing, selection, composition, and clipboard handling stay
active. Disabling retains ownership of consumed keys until release.

Hosts combining Editor and application commands can import `createKeymapRuntime`
from `@singapor/core/keymap`, supply a DOM root and ordered generic bindings, and
provide synchronous context, availability, and dispatch callbacks. The returned
runtime mounts immediately and exposes `claimKeybinding`, `updateBindings`,
`setEnabled`, `cancel`, and `dispose`. Hosts must call `cancel()` when their exact
command target changes and `dispose()` when its owner unmounts. Embedded editors
then use `keymap: { enabled: false }`; their public commands remain available.

The keymap entry point imports without a DOM. `getKeymapContext()` exposes the
Editor facts used by pack conditions. `getInputElement()` identifies the native
editor input so a host can distinguish it from local widget inputs. Local widgets
handle their own idle key events before the runtime; a widget that stops an event
also prevents an application bubble listener from seeing it.
