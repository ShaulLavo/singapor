# @singapor/gutters

Line-number and fold-gutter plugins for `@singapor/core`.

## Install

```sh
npm install @singapor/core @singapor/gutters
```

## Usage

```ts
import { Editor } from '@singapor/core/editor'
import { createFoldGutterPlugin, createLineGutterPlugin } from '@singapor/gutters'
import '@singapor/core/style.css'
import '@singapor/gutters/style.css'

const editor = new Editor(document.querySelector('#editor')!, {
  plugins: [createLineGutterPlugin(), createFoldGutterPlugin()],
})
```

Fold icons accept strings, DOM factories, or a `FoldGutterSvgIcon` descriptor through `icon`,
`expandedIcon`, and `collapsedIcon`:

```ts
createFoldGutterPlugin({
  icon: { kind: 'svg', viewBox: '0 0 16 16', path: 'M2 5L8 11L14 5Z' },
  iconClassName: 'fold-icon',
})
```

SVG icons use `currentColor` and fill their wrapper. Set its dimensions through `iconClassName`;
the parent button's `data-editor-fold-state` is `expanded` or `collapsed` for state styling.
Strings and SVG descriptors support provisional paint snapshots. DOM factories disable fold-gutter
snapshots because restoring them would require the source fold marker.

## Exports

- `createLineGutterPlugin` adds a line-number gutter.
- `createFoldGutterPlugin` adds fold controls for syntax fold markers.
- `createLineGutterContribution` and `createFoldGutterContribution` expose the lower-level gutter
  contributions.
- `@singapor/gutters/style.css` imports both gutter styles.
