# @singapor/panes

Small DOM utility for resizable pane groups.

## Install

```sh
npm install @singapor/panes
```

## Usage

```ts
import { ResizablePaneGroup } from '@singapor/panes'
import '@singapor/panes/style.css'

const group = new ResizablePaneGroup(document.querySelector('#panes')!, {
  orientation: 'horizontal',
  panes: [
    { id: 'left', element: document.querySelector('#left')!, defaultSize: 40 },
    { id: 'right', element: document.querySelector('#right')!, defaultSize: 60 },
  ],
})
```

## Exports

- `ResizablePaneGroup` mounts accessible split handles and manages percentage layouts.
- `ResizablePaneGroupOptions`, `ResizablePaneLayout`, and related types describe pane and handle
  configuration.
