# Browser Quirks

Browser-specific workarounds in the editor. Every workaround in the code gets an
entry here: the user-visible symptom, the root cause, the chosen fix and why, a
minimal repro, and the upstream bug. Keep entries dated with the engine versions
they were verified against, so they can be re-tested and removed when upstream
fixes ship.

Related inline workarounds already documented at their call sites:

- `packages/editor/src/style.css` — `will-change: transform` on virtualized rows
  (WebKit re-resolves registered CSS Highlight ranges when a painted row's
  transform changes).

## Safari renders every line number as "0"

**Verified 2026-06 against:** WebKit 26.4 (Playwright webkit-2272) — broken;
Chromium 147, Firefox 148 — correct. Upstream: [WebKit bug 308446
"Counters evaluation with style containment"](https://bugs.webkit.org/show_bug.cgi?id=308446),
open at time of writing.

### Symptom

In Safari the line-number gutter shows `0` for every row. Chromium and Firefox
show correct line numbers.

### How line numbers are rendered

The line gutter does not write digits into the DOM. Each gutter cell carries an
inline `counter-set: editor-line <n>` (`packages/gutters/src/lineGutter.ts`),
and the digits are painted by CSS:

```css
.editor-virtualized-line-number::before {
  content: counter(editor-line, var(--editor-line-gutter-counter-style, decimal));
}
```

This is deliberate: pseudo-element text stays out of text selection and the
clipboard, there is no per-scroll text-node churn when recycled rows are
renumbered, and the `counterStyle` plugin option lets consumers swap numbering
via any `@counter-style` name without JS formatting.

### Root cause

The virtualizer merges the `editor-virtualized-gutter-cell` class onto the very
element the gutter contribution returns from `createCell`
(`packages/editor/src/virtualization/virtualizedTextViewRows.ts`,
`createGutterCell`). That class used to apply `contain: layout paint style`.

WebKit mis-scopes CSS counters under style containment: when the **same
element** has `contain: style` and a `counter-set`, the counter is not visible
to that element's own `::before`, so `counter()` falls back to `0`. Per
[css-contain](https://drafts.csswg.org/css-contain/#containment-style), style
containment scopes counter properties to the element's subtree — which includes
its own pseudo-elements — and Chromium and Firefox render it that way.

The failure needs both halves on one element. Style containment on
*ancestors* of the counter-carrying element works fine in WebKit, which is why
only the gutter cell (and not the row/root containment) ever broke.

### Repro matrix

Minimal repro, WebKit-only failure on the marked rows:

```html
<style>
  .num::before { content: counter(editor-line); }
  .lps { contain: layout paint style; }
  .lp  { contain: layout paint; }
</style>
<span class="num lps" style="counter-set: editor-line 42"></span> <!-- WebKit: 0 -->
<span class="num" style="counter-set: editor-line 42; contain: style"></span> <!-- WebKit: 0 -->
<span class="num lp" style="counter-set: editor-line 42"></span> <!-- 42 everywhere -->
<span class="lps"><span class="num" style="counter-set: editor-line 42"></span></span> <!-- 42 everywhere -->
```

Also verified unaffected: dynamic CSSOM assignment (`el.style.counterSet`),
post-paint value mutation, `hidden` toggling, `var()` as the `counter()` style
argument, and the full root > row > cell containment chain — WebKit handles all
of those once the counter-carrying element itself has no style containment.

### Fix

`.editor-virtualized-gutter-cell` uses `contain: layout paint`, dropping
`style` (`packages/editor/src/style.css`). Layout and paint containment carry
the actual virtualization wins; style containment on a leaf cell only scoped
counters/quotes — and the only counters in play are exactly the ones it broke.
Rows and the editor root keep full `layout paint style` containment.

Rejected alternatives:

- **Wrap the counter in a child span** — an extra DOM node per mounted row per
  contribution, purely to dodge the bug.
- **Write digits via `textContent`** — puts line numbers back into
  selection/clipboard reach, adds text-node updates on every remount/renumber,
  and drops `@counter-style` support.

### Contract

Anything returned from a gutter contribution's `createCell` gets the cell class
merged onto it. Do not re-add `contain: style` (or `contain: strict`/
`content-visibility`, which imply it) to gutter cell elements that rely on CSS
counters.
