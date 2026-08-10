# @singapor/decode

Opt-in editor plugin that animates a file _writing itself_ when it opens — the text reveals as if
it were being generated in front of you. The plugin's presence is the switch: include
`createDecodePlugin(...)` in the editor's plugin list to turn it on, remove it to turn it off.

```ts
import { createDecodePlugin } from '@singapor/decode'
import '@singapor/decode/style.css'

createDecodePlugin({ mode: 'autoregressive' }) // or 'parallel'
```

## Modes

- `autoregressive` — writes line by line from the top (classic typewriter), a caret riding the edge.
- `parallel` — every line writes itself left→right at once, with a short top-down cascade.

`diffusion` (words bloom mid-screen out of order, glyphs settling from scrambled → correct) is the
next mode to land on this same scaffold.

## How it works

The reveal never touches the editor's real, recycled rows. It hides them with one CSS rule, paints a
self-owned overlay of clone lines positioned from the editor's own geometry (`visibleRows`,
`--editor-gutter-width`), and reveals each line with a GPU `clip-path` sweep (WAAPI). Because syntax
color is painted by the CSS Custom Highlight API over the real text, the finish is a blur-masked
crossfade where the highlighted text "blooms" in. Any keypress, click, or scroll cancels instantly —
the editor underneath was live the whole time. Honors `prefers-reduced-motion` (no animation).
