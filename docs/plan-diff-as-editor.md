> [!IMPORTANT]
> **STATUS: 🟡 SUPERSEDED for the Editor half (2026-08-21). M0–M5 landed on branch `diff-as-editor`.**
> `DiffView` and the canvas gutter are deleted; `createDiffPlugin` carries both modes. What shipped
> differs from the plan in three places, each recorded inline below: **§C2** was wrong about token
> painting (corrected in place — the failure is worse, not milder); **§C10**'s "re-apply cached
> tokens" is implemented by caching the *parsed per-side streams* and re-projecting synchronously,
> so a toggle cannot flash; and **overscan** is the core default 12 rather than `DiffView`'s 8
> (decision and reasoning pinned in `test/diffPlugin.test.ts` history / §4 M0 below).
>
> **The platform half is still 🟢 CURRENT and has not started.** Its §2 (the red typecheck) is
> independent and can land at any time; everything after it needs `bun link` from this worktree's
> `packages/diff` per §8.2, which has *not* been done — platform still resolves to the main
> checkout, deliberately.
>
> Editor half of a two-document pair. The platform half is
> [`/Users/shaul/Desktop/D/platform/docs/diff-as-editor-implementation-plan.md`](../../platform/docs/diff-as-editor-implementation-plan.md).
> **§ The contract** below is normative for everything that crosses the seam; the platform document cites
> its terms as `§C1`–`§C11` and does not restate them. `packages/diff` is symlinked into platform as
> `packages/editor-diff`, so every edit here lands there instantly — but `dist/` does not, which is why
> §C8 exists.
> **Both documents are part of the migration's deliverable**: when it lands, mark them SUPERSEDED rather
> than leaving them CURRENT and stale.

# Diff as Editor — deleting `DiffView` for one editor plugin

`DiffView` is a 1,317-line shell that mounts two `EditorSecondaryTextView`s and then hand-rolls
selection, copy, cursor shape, scroll sync, syntax highlighting and a canvas gutter — every one of
them because a secondary view is the renderer *without* the editor around it. This plan deletes the
shell and mounts real `Editor`s instead, with one plugin supplying the diff.

---

## 0. Skeptic's preface: what this actually buys

**It is not "hand-rolled renderer → core renderer".** `EditorSecondaryTextView` *is*
`VirtualizedTextView` re-exported (`packages/editor/src/public/secondaryViews.ts:15`), instantiated at
`DiffView.ts:299`. The rows already go through the core virtualizer. Anyone selling this as "stop
hand-rolling the renderer" is wrong, and the plan should not be approved on that basis.

**What it actually buys, in order of value:**

1. **Deleting behaviour we re-implemented badly** — hand-rolled selection (`DiffView.ts:355-431`),
   hand-rolled copy (`:433-447`), native-selection suppression (`style.css:197-207`). A real `Editor`
   has all of it, tested, with a caret and hit-testing we never built.
2. **Deleting the canvas gutter** (`canvasGutter.ts`, 354 L) — it exists solely because secondary views
   take no gutter contributions.
3. **A theme setter.** `DiffViewOptions.theme` has no setter, so platform rebuilds the entire view on a
   colour-mode change (`diff-view.tsx:69`). `Editor.setTheme` exists (`Editor.ts:1082`).
4. **One diff implementation instead of two.**

**What it does not buy:** a smaller codebase by as much as it looks. Scroll sync (~120 L), pane-group
wiring (~37 L) and the syntax pipeline (~270 L) *move*. And per §C10, more work lands in the host than
a first read suggests. Honest arithmetic in §5.

**What it costs:** a real `Editor` brings a caret, a focusable textarea, keyboard navigation,
tab-reachability, two aria-live announcers per pane, a cursor-line highlight, and **different clipboard
semantics** (§C9). Those are behaviour deltas, enumerated, not accidents to discover in review.

---

## 1. The contract

Normative. The platform document cites these ids.

### §C1 — One plugin, two row-delivery modes

There is exactly one exported plugin factory. It carries two internal modes; the mode is chosen by the
host and is not a second plugin.

| Mode | Editor's document | Other side's lines | Used by |
|---|---|---|---|
| `document` | **synthetic**, `documentMode: 'static'`, text = `joinRenderLines(rows)` | ordinary buffer rows | the diff view (both platform mount sites) |
| `overlay` | the host's **live, editable** buffer | `InjectedTextRow`s | live dirty-diff (example app) |

`document` mode is the parity path and the default. `overlay` mode is explicitly **non-parity** — §C2.

### §C2 — Why `overlay` mode can never reach parity

`injectedTextDisplayRow` sets `startOffset === endOffset`
(`packages/editor/src/displayTransforms.ts:887-888`). The consumers of the offset space give up on it:

| Capability | Behaviour on an injected row | Verified at |
|---|---|---|
| selection geometry | returns `[]` | `virtualizedTextViewGeometry.ts:398` — `if (row.source === 'injected') return []` |
| hit-testing / copy | returns null | `virtualizedTextViewRows.ts:2508` — `if (row.source === 'injected') return null` |
| range highlights (inline word-diff) | dropped unless the range straddles the anchor offset | `virtualizedTextViewHighlights.ts:1284-1285` |
| syntax token painting | **paints the wrong tokens** — see below | `virtualizedTextViewHighlights.ts:759`, `:805` |

> [!WARNING]
> **Corrected 2026-08-21 during M0.** An earlier revision of this section claimed token painting
> *bails* on the degenerate range, making the injected side uniformly inert. It does not. Chunk
> offsets are derived as `rowStartOffset + localIndex`, not from the row's `endOffset`, so
> `chunk.endOffset <= chunk.startOffset` never fires and the injected row is painted with whatever
> tokens live at `[anchorOffset, anchorOffset + text.length)` **in the document buffer** — some
> following document line's tokens, not the deleted line's. Overlay deletions are not uncoloured,
> they are *miscoloured*, which is the worse of the two. Pinned by
> `test/overlayModeLimits.test.ts`; the other three rows above were re-verified and are exact.

So in `overlay` mode the injected side has no selection, no copy, no inline diff, and colouring that
is actively wrong. Giving injected rows a real offset space means threading a parallel coordinate
system through the hottest render path. **Out of scope, and must not be attempted inside this plan.**

**`overlay` mode also forfeits §C4.** Injected rows are one of the conditions that disable the
plain-display-row fast path (`virtualizedTextViewLayout.ts:783-791`), so row index ≠ projection index
there. Anything addressing rows by index must be `document`-mode only.

### §C3 — `document` mode: the host owns the document, the plugin publishes rows

**Verified: no plugin context can mutate document text.** `EditorPluginContext` (`plugins.ts:645-661`)
has no document-mutating member; `EditorRowDecorationContributionContext.setRowDecorations`
(`:390-393`) is decorations only; `EditorViewContributionContext` (`:257-320`) has no text API. So the
split is forced, not chosen:

```
plugin.setFile(file)            // host pushes the DiffFile
plugin.getRows()                // -> readonly DiffRenderRow[]
plugin.onDidChangeRows(cb)      // fires on file change and region toggle
host: editor.setText(joinRenderLines(plugin.getRows()))
      editor.setTokens(cachedTokens)      // §C10
```

### §C4 — Row index ≡ buffer row ≡ projection index

In `document` mode every projection row is one real buffer line, so `rows[i]` is buffer row `i` and is
stamped `data-editor-virtual-row="i"` by the core (`virtualizedTextViewRows.ts:580`). Row decorations
key off the same value (`:2100`). Platform's line-comment layer depends on this identity.

**It holds only on the plain-display-row fast path**, which requires `!foldMap && !wordWrap &&
!blockRows && !inlineMap && !injectedTextRows` (`virtualizedTextViewLayout.ts:783-791`). Every one of
those is therefore forbidden in a `document`-mode diff editor. This is also what makes **block surfaces
unusable here** — `blockRows.length > 0` sets `hasModelRowProjections()` true (`:790`) and kills the
identity outright.

### §C5 — The plugin owns expansion state and publishes it

Collapsed regions are keyed `"{oldStart}:{newStart}"` (`projection.ts:246-248`), not by hunk ordinal.

```
plugin.getExpandedRegions(): ReadonlySet<string>
plugin.toggleRegion(key: string): void
```

Hosts **must not** mirror this state. Platform currently does, keyed by `hunkIndex`, and it is broken —
trailing-tail regions carry `hunkIndex === undefined` (`projection.ts:294-310`) and are unmirrorable in
principle.

### §C6 — Behaviour deltas the host must decide, not discover

| # | `DiffView` today | Real `Editor` | Host action |
|---|---|---|---|
| 1 | one pane holds a selection (`DiffView.ts:373-379`) | each editor owns its own | clear the other on focus |
| 2 | no caret, no keymap | full keymap, find, edit commands | `keymap: { defaultBindings: false, layers: [] }` |
| 3 | panes not tab-reachable (`DiffView.ts:310`) | `tabIndex = 0` | set explicitly |
| 4 | no cursor-line highlight | **ON by default** — `DEFAULT_CURSOR_LINE_HIGHLIGHT = { gutterNumber: false, gutterBackground: true, rowBackground: true }` (`virtualizedTextView.ts:160-164`) | pass explicit `false`s; `undefined` means *default*, i.e. on |
| 5 | no announcers | `new EditorAnnouncer(container)` per editor (`Editor.ts:413`) — two aria-live regions in split | accept, or suppress |
| 6 | clipboard: plain text only | §C9 | §C9 |

### §C7 — The split alignment invariant

Split mode is two editors holding two documents. `leftRows[i]` and `rightRows[i]` share a visual band
only while both panes have identical row height, **word wrap off**, and **no fold map**. The projection
guarantees equal row counts by pushing the *same row object* into both arrays (`projection.ts:94-101`);
nothing guarantees the rendering side. This is the same precondition as §C4 — assert once, for both.

### §C8 — Two-repo sequencing

`platform/apps/web/vite.config.ts:76-91` resolves `@singapor/*` to Editor **source**, but only for
`apply: 'serve'`. Build and `tsgo` go through `exports` → `dist/`. Resolution is **all-or-nothing per
package**, and the module list is snapshotted at config load.

Land Editor-side first, **rebuild `packages/diff`**, then platform, in one session. Restart the dev
server after any `packages/diff/package.json` change.

**This work happens in a git worktree of the Editor repo** — see §8, which is not optional reading:
platform binds to the *main checkout* by absolute path in three places, so a worktree is invisible to
platform until you repoint the link registry.

### §C9 — Clipboard semantics change, and this is the sharpest visible delta

`Editor`'s copy is **not** byte-identical to `DiffView`'s (`DiffView.ts:433-447`). Three divergences:

1. **Rich text.** `Editor` also writes `text/html` (`inputSelectionController.ts:2474` →
   `writeRichTextPayload`). `DiffView` wrote only `text/plain`. Pasting a diff selection into a doc or
   chat now carries syntax-coloured HTML.
2. **Collapsed caret copies a line.** `clipboardPayload()` returns the caret's line + `\n` when nothing
   is selected (`:2959-2965`); `DiffView` returned `''` and did not `preventDefault`. Cmd+C with no
   selection now copies e.g. `Show 12 unmodified lines`.
3. **Shared clipboard state.** `writeClipboardPayload` keeps module-level `lastCopied` and writes a
   private metadata type (`clipboardMetadata.ts:25-28`) the paste path reads. A diff copy now
   participates in a later paste into a real editor.

**And a contradiction to resolve at the mount site:** `selectionSyncMode: 'none'` short-circuits before
`domSelection.addRange` (`inputSelectionController.ts:1418-1421`). Copy then depends entirely on the
hidden textarea. Decide explicitly whether the diff keeps native selection; do not copy
`selectionSyncMode: 'none'` from the search-result precedent without testing copy.

The plain-text payload itself *is* identical — row text carries no `+`/`-` markers
(`projection.ts:230-232`).

### §C10 — Five `VirtualizedTextView` options `Editor` does not forward

`Editor.ts:427-445` builds the option bag and omits all of these, each of which `DiffView` used:

| Option | `DiffView` use | Consequence |
|---|---|---|
| `overscan` | `:305`, public as `DiffViewOptions.overscan` | accept core default 12, or add to `EditorOptions` (~5 L) |
| `gutterWidth` (fn) | `:302-303` | must move to `EditorGutterContribution.width` |
| `selectionHighlightName` | `:306`, per pane | `Editor` hardcodes `${highlightPrefix}-selection` (`:444`) — already unique per editor |
| `onViewportChange` | `:304`, drove the canvas repaint | `Editor` consumes it (`:443`); use a view contribution |
| `className` | `:301` `'editor-diff-text editor-virtualized'` | `Editor` hardcodes `'editor'` (`:428`), which pulls in the whole `.editor` block (`editor/style.css:20-60`) |

`className` is not cosmetic. `.editor` declares a full `--editor-*` set at specificity (0,1,0); the diff
override is (0,2,0) `!important` (`diff/style.css:187-195`) so its four vars win, but everything it does
*not* override — `--editor-caret-color`, `--editor-cursor-line-*`, all `--editor-syntax-*` — is now
declared from two rules. Decide which wins before, not after, the visual diff.

Two more `Editor`-only behaviours on `setText`:

- **`adoptDocumentTabSize`** runs on every `setText`/`openDocument` unless `tabSize` is set
  (`Editor.ts:1348`, `:1269`, impl `:1386-1390`). Neither platform mount site passes `tabSize` today and
  the secondary view never guessed — so tab width could flip per file **and per expansion toggle** on a
  synthetic buffer full of placeholders and `Show N unmodified lines` rows. **The host must pass an
  explicit `tabSize`.**
- **`setText` clears tokens** (`Editor.ts:648` → `setTokens([])`) and `syntax.startDocument` recreates
  the highlighter session (`syntaxController.ts:197-213`). `DiffView` re-applied cached tokens
  synchronously (`:552`, `:558`) so a toggle never flashed uncoloured. The plugin cannot do this — it has
  no editor handle. **The host calls `Editor.setTokens(cached)` (public, `:656`) immediately after every
  `setText`.**

### §C11 — The editor's `languageId` must be `null`

`refreshSyntax` gates on `getLanguageId()` (`syntaxController.ts:502`). Give the diff editor a real
language and it tree-sitter-parses the **interleaved** synthetic buffer, then feeds that garbage parse
into `setSyntaxFolds`, bracket matching, injections and inline-replacement providers (`:655-668`).
Tokens themselves are safe (`:655` defers to the highlighter session), everything else is not.

The language belongs **inside the plugin's own syntax documents** (`DiffView.ts:1273-1275`), which is
where `DiffView` already put it. The editor's document stays language-less.

---

## 2. Ground truth

### 2.1 `DiffView` has zero consumers in this repo

The example app already migrated. `showDiff()` swaps plugins on the *same real editor* and leaves
`diffHost.hidden = true` (`examples/app/src/app.ts:104-112`); `diffHost` is a vestigial empty div
(`components/editorPane.ts:12-14`). Nothing constructs a `DiffView`.

### 2.2 A real `Editor` in happy-dom is already proven

`packages/diff/test/editorDiffPlugin.test.ts:20` constructs `new Editor(container, { plugins })` under
happy-dom and asserts rendered row text and gutter contents. `vitest run` in `packages/diff`: **5 files,
41 tests, green.** No environment spike is needed — the existence proof is committed.

### 2.3 Four things are already dead

| Dead thing | Evidence |
|---|---|
| `createDiffGutterContribution` + `createDiffGutterCell` + `diffGutterText` (`gutters.ts:23-38,100-121`) | referenced only by `test/gutters.test.ts`; `updateCell(){}` is a no-op |
| Example app's Split/Stacked buttons (`components/topBar.ts:9-10,29-30,37-38,60-61,70-78`) | wired to `() => undefined` (`sourceController.ts:63-64`) |
| `DiffSyntaxTokens` (`types.ts:107`) | unreferenced repo-wide |
| `.editor-diff-gutter-row-{addition,deletion,hunk,placeholder}` (`style.css:235-240`) | `background: inherit` inherits from `.editor-virtualized-gutter`, not the row tint — **already inert** |

### 2.4 Two public API surfaces have zero consumers — drop, don't port

- **Hunk navigation.** `revealNextHunk`, `revealPreviousHunk`, `revealHunk`, `getCurrentHunk`,
  `DiffHunkLocation`: no references outside `DiffView.ts` and its own test, in either repo.
- **The entire `splitPane` option surface.** `createHandle`, `minSize`, `maxSize`, `defaultLayout`,
  `onLayoutChange`, `onLayoutChanged`, `disabled` — **zero call sites** except `DiffView.test.ts:350`.

### 2.5 `@singapor/panes` is a `DiffView`-only dependency

Reachable from `packages/diff` only via `DiffView.ts:21`, `types.ts:7`, `style.css:1`. The dependency
moves to the app with the split layout. `knip` will flag it if left behind.

### 2.6 `test/DiffView.test.ts` is the behaviour spec

575 lines, 12 cases — the only written record of what parity means. Tests 6–12 are pure functions over
`projectDiffSyntaxTokens` and port unchanged. Note case `:113-134` ("toggles expandable hunk rows from
gutter clicks") pins §3.4.

---

## 3. The design

### 3.1 Shape

```
createDiffPlugin({
  mode: 'document' | 'overlay',        // §C1
  side: 'old' | 'new' | 'stacked',
  syntaxBackend?: DiffSyntaxBackend,
  syntaxHighlight?: boolean,
}) => DiffPlugin

type DiffPlugin = EditorPlugin & {
  setFile(file: DiffFile | null): void
  getRows(): readonly DiffRenderRow[]
  onDidChangeRows(cb: () => void): EditorDisposable
  getExpandedRegions(): ReadonlySet<string>   // §C5
  toggleRegion(key: string): void
}
```

Stacked = one editor, `side: 'stacked'`. Split = two editors, `side: 'old'` / `'new'`, plus a
host-owned scroll sync (§3.5). No `getHunkRows` — §2.4.

### 3.2 What each existing module becomes

| Module | Lines | Fate |
|---|---|---|
| `DiffView.ts` | 1,317 | **delete** (but port §3.4 and §C10 pieces first) |
| `canvasGutter.ts` | 354 | **delete** |
| `projection.ts` | 402 | **survives, now load-bearing** |
| `liveProjection.ts` | 198 | **survives** — `overlay` mode |
| `model.ts`, `inline.ts` | 467 | untouched; platform imports them directly |
| `gutters.ts` | 181 | keep `diffGutterWidth`/`diffGutterNumberText`/`diffGutterIndicatorText`/`diffGutterLayout`/`diffGutterColor`; delete the dead trio |
| `editorDiffPlugin.ts` | 255 | **becomes the one plugin** |
| `lines.ts` | 51 | untouched |

### 3.3 The gutter

One DOM cell per row via `registerGutterContribution` (`plugins.ts:596-603`). Four traps:

**Pixel parity.** The canvas derives lane geometry from character width:
`Math.ceil(characters * characterWidth + GUTTER_NUMBER_RESERVED_WIDTH)` — **ceil applied after the +6**
(`gutters.ts:169`), indicator 12px, 4px right inset. The existing plugin CSS uses
`grid-template-columns: minmax(0,1fr) minmax(0,1fr) 12px` (`style.css:262`). These do not line up. Keep
`diffGutterLayout` and write its results into CSS custom properties per width recompute.

**Side-awareness is per-lane, not per-pane.** In stacked mode one gutter has two number lanes and
`diffGutterColor(row, kind, …)` is called per lane (`canvasGutter.ts:270`): for one addition row the
**old lane is foreground and the new lane is green** (`gutters.ts:141-142`). A row-class-only CSS scheme
cannot express this — the lane spans need their own type-aware selectors.

**Scroll cost.** Today's `setGutterLaneText` does three `querySelector` calls per row per update
(`editorDiffPlugin.ts:246-255`) — ~132 lookups per repaint at 44 mounted rows, on the exact path the
Aug-2026 scroll work fixed. Cache lane elements on the cell at `createCell`; never query in `updateCell`.

**Width refresh ordering.** `DiffView.updatePaneRows` calls `refreshGutterWidth()` explicitly *before*
decorations (`DiffView.ts:551`). The incidental refresh inside `applyComposedRowDecorations`
(`Editor.ts:2303-2305`) fires *after*. Not equivalent for a width that feeds row `left` offsets — verify,
or add a plugin-facing invalidation.

### 3.4 Gutter clicks need the Y-hit-test — it is **not** deletable

Expanding a collapsed region by clicking its gutter must keep working (`DiffView.test.ts:113-134`).
`closest('[data-editor-virtual-row]')` cannot resolve it:

- `.editor-virtualized-gutter` is **`pointer-events: none`** (`packages/editor/src/style.css:132`) — a
  click in the gutter band hits the scroll element, never a gutter node.
- Gutter rows carry `data-editor-virtual-gutter-row`, not `data-editor-virtual-row`
  (`virtualizedTextViewRows.ts:1845` vs `:580`).
- Text rows start at `left: var(--editor-gutter-width)` (`style.css:200`), so no row element sits under
  the gutter band.

**Port `paneRowIndexFromPoint` (`DiffView.ts:487-500`) into the plugin's view contribution.** For the
same geometric reason, the imperative `cursor: pointer` (`DiffView.ts:461-476`) is **also not
redundant** — `.editor-diff-row-expandable { cursor: pointer }` is on the row element only, so deleting
it loses the pointer cursor over the gutter half of an expandable separator, which is the half users
click. `DiffView.test.ts:122-124,132-133` assert `view.style.cursor` directly.

**Event ordering.** The plugin's `mousedown` beats the editor's own (`inputSelectionController.ts:258`,
installed at `Editor.ts:633`) only because view contributions are created earlier (`Editor.ts:580`).
That is registration order, not phase. Use `stopImmediatePropagation` and pin it with a test.

### 3.5 Scroll sync is host work, not a view contribution

`EditorViewContributionContext.setScrollTop` is **vertical-only** (`plugins.ts:298`); there is no
`setScrollLeft`. `DiffView` syncs both axes (`DiffView.ts:645-647`). Sync therefore goes through
`Editor.getScrollPosition`/`setScrollPosition` (`Editor.ts:1070-1080`), which is host-level.

**Trap:** the virtualizer redefines `scrollTop`/`scrollHeight` on the scroll element
(`fixedRowVirtualizer.ts:1234-1261`), and `scrollMode: 'static'` **removes** those definitions
(`:598-600, 635-645`), silently no-opping any sync. The platform's readonly-editor precedent sets
`scrollMode` conditionally — **do not copy that option into the diff.**

---

## 4. Milestones

> **Landed.** M0–M5 are done; the notes below record what each turned into.

**M0 — Spike, before any deletion.** ✅ `test/documentMode.test.ts` (the gate) and
`test/overlayModeLimits.test.ts` (its falsifying inverse — read them together). The gate had to be
re-expressed: happy-dom ships no CSS Custom Highlight API, and that is what paints tokens, so the
tests install a recording polyfill (`test/support/highlightPolyfill.ts`) and assert that a token
range lands *inside the deletion row's element*. **Overscan decision: accept the core default 12.**
Adding `overscan` to `EditorOptions` would widen the change to `@singapor/core`'s public API and
force a second `bun link` repoint (§8.2) to buy back four rows; 12 renders strictly more than
`DiffView`'s 8 and so cannot drop content. Measured as 9 vs 13 mounted rows before the M1 test was
retired with `DiffView`.

**M0 (original text).** ~20 lines: `Editor` with `documentMode: 'static'`,
`editability: 'readonly'`, `languageId: null`, explicit `tabSize`, text =
`joinRenderLines(createStackedProjection(file).rows)`, and a plugin returning hand-built tokens from
`registerHighlighter`. **Gate: deletion rows highlight, are selectable, and copy.** Extend
`test/editorDiffPlugin.test.ts` — the harness already works (§2.2).

Decide `overscan` here (§C10): accept 12, or add it to `EditorOptions` and forward it.

**M1 — Characterise before changing.** ✅ Done and retired with `DiffView`, as planned. Overscan came
out as the two numbers above. Horizontal scroll-sync clamping was **not** asserted: `DiffView.ts:645-647`
is an unconditional `target.scrollLeft = source.scrollLeft`, so any clamping is the browser's, applied
on write — and happy-dom does not emulate it, so an assertion there would have been measuring
happy-dom. The contract (verbatim mirroring, no compensation, panes silently desynchronise until the
source scrolls back into the target's range) is recorded here for the platform half's §3.5 to
reproduce or deliberately improve on.

**M1 (original text).** Assertions against *current* `DiffView` for the two behaviours
with no tests, so "parity" is falsifiable: horizontal scroll-sync clamping when panes have different
content widths (`DiffView.ts:645-647`), and overscan. Throwaway once M4 lands.

**M2 — The gutter, benchmarked.** ✅ `src/diffGutter.ts`. All four traps addressed; the benchmark was
replaced with a **direct assertion**, which is a stronger guard than a wall-clock number in a fake
DOM: `test/diffPlugin.test.ts` spies on every mounted cell and asserts `updateCell` performs **zero**
`querySelector` calls (trap 3 — lanes are resolved once at `createCell` into a `WeakMap`). Trap 1 is
asserted too: lane geometry is published as `--editor-diff-gutter-columns` from `diffGutterLayout`,
and the test fails if any column is a `fr`. Trap 2 became `diffGutterLaneTone`/`diffGutterRowTone`,
which replace `diffGutterColor`/`diffGutterIndicatorColor` — one branching implementation for both,
resolved to colour in CSS.

**M2 (original text).** Build per §3.3. Benchmark wheel scroll on the known-bad file from the
Aug-2026 trace before writing gutter code and after. >10% frame-time regression is a blocker.

**M3 — The plugin.** ✅ `src/editorDiffPlugin.ts`. The §C4/§C7 assertion is
`documentModeViolations`, which checks the *identity itself* on the rows actually mounted
(`row.index === row.bufferRow`, all rows `source: 'document'`, `lineCount === rows.length`) rather
than enumerating the features that would break it — that list goes stale the moment a new projection
lands. Read back via `plugin.getDocumentModeViolations()`.

**M3 (original text).** Absorb `document` mode; expose §C3/§C5; port §3.4. Add the §C4/§C7 assertion:
equal row counts across panes after every `setText`, and fail loudly if wrap, folds, blocks, inline maps
or injected rows are active on a `document`-mode diff editor.

**M4 — Delete, and port the spec.** ✅ Everything in §5 is gone. One behaviour the old code encoded
only implicitly had to be made explicit: `DiffDecorationContribution` must repaint cells **before**
announcing an injected-row change, because a row the rebuild unmounts keeps whatever its cell last
rendered — disabling a live diff otherwise left a stale `4+` on a detached cell. The old
`refresh()`'s odd duplicated call order was carrying that; it is now one commented method.

**M4 (original text).** Remove `DiffView.ts`, `canvasGutter.ts`, the dead trio, hunk
navigation, the `splitPane` surface, the `@singapor/panes` dependency, the `DiffView`-only types, the
`style.css` blocks in §5, and the example app's dead chrome. Port `test/DiffView.test.ts`.

**M5 — Docs.** ✅ `packages/diff/README.md` rewritten around the host-owns-the-document contract,
including why each of the four load-bearing editor options is not taste. `TODO.md:212`,
`docs/parity-monaco-codemirror.md:711` and the four `docs/parity-findings.json` citations were
re-cited, not resolved — each cited `DiffView` as evidence of *absence* ("grep finds X only here"),
so the claims stand and only the file reference moved.

**M5 (original text).** `packages/diff/README.md:14,19,24-25`; refresh the stale `DiffView.ts:446/:636/:1220`
citations in `docs/parity-findings.json`, `docs/parity-monaco-codemirror.md:711`, `TODO.md:212` — none of
those findings is resolved by this work, only re-cited. **Mark this document and its platform twin
SUPERSEDED.**

Platform milestones begin **after** M4 plus a `packages/diff` rebuild (§C8).

---

## 5. Deletion inventory and honest arithmetic

**Delete outright:** `src/DiffView.ts` (1,317), `src/canvasGutter.ts` (354), `src/gutters.ts:23-38`
+`:100-121`, hunk-navigation members, `src/index.ts:3` and matching type exports, `package.json:34`
(`@singapor/panes`), `src/types.ts` members `DiffViewMode`/`DiffSplitPaneId`/`DiffSplitPaneLayout`/
`DiffHunkLocation`/`DiffSplitHandleContext`/`DiffSplitPaneOptions`/`DiffViewOptions`/`DiffSyntaxTokens`
and the `@singapor/panes` import at `:7`, `test/DiffView.test.ts`, and the example chrome at
`components/editorPane.ts:6,12-14,19`, `components/topBar.ts:9-10,29-30,37-38,60-61,70-78`,
`test/components/topBar.test.ts:19-24`, `examples/app/src/style.css:112,121`.

**`style.css`** — delete `:1` (panes import), `:34-42`, `:44-100`, `:102-135`, `:137-185`, `:197-207`,
`:235-240` (inert, §2.3), `:242-254`, `:291-299`, `:301-307`, `:309-321`. **Keep** `:3-32` (the var
block — platform overrides it), `:187-195`, `:209-233`, `:256-289`.

**Arithmetic.** ~1,671 lines deleted. The "created" figure is a **floor, not an estimate**: §C3, §C10 and
§3.5 all push work into the host that a first read assigned to the plugin. Expect ~700–900 across the
plugin and the platform app component, and do not quote a net saving as a selling point.

---

## 6. Risks

| # | Risk | De-risk |
|---|---|---|
| R1 | `document` mode does not highlight/select deletion rows | **M0 gate.** Harness already exists (§2.2). |
| R2 | Gutter DOM cells regress scroll perf | benchmark before *and* after (M2); cache lane elements; >10% blocks |
| R3 | Gutter pixel drift: `ceil(x+6)` vs `ceil(x)+6`, `1fr 1fr 12px`, per-lane side colours, `#9cdcfe` hardcoded twice (`canvasGutter.ts:64`, `style.css:223`) | screenshot-diff split+stacked × light+dark; decide the `#9cdcfe` question explicitly in the PR |
| R4 | Someone "unifies" by making `overlay` the one true path | §C2 is normative; cite it in review |
| R5 | Split panes drift when wrap/folds/blocks get enabled later | §C4/§C7 assertion in M3 |
| R6 | `dist/` still ships a deleted class | §C8; rebuild between M4 and the platform half |
| R7 | Platform typecheck is **red today** | platform document fixes it as its first commit |
| R8 | Gutter-click expansion silently breaks | §3.4; `DiffView.test.ts:113-134` must be ported, not dropped |
| R9 | Clipboard behaviour changes without anyone noticing | §C9; decide `selectionSyncMode` and test copy explicitly |
| R10 | Tab width flips per file/toggle | §C10; pass an explicit `tabSize` |
| R11 | Garbage tree-sitter parse of the interleaved buffer | §C11; `languageId: null` |

---

## 7. Explicitly out of scope

- Giving injected rows a real offset space (§C2).
- **Block surfaces.** Doubly excluded: `registerBlockProvider` has no production consumer and no
  browser-test coverage, *and* blocks set `hasModelRowProjections()` true, which kills the row-index
  identity §C4 depends on. Nothing here needs them; nothing here may start using them.
- Multi-file diff. Both platform mount sites pass `showFileList: false` and render `files[0]` only
  (`DiffView.ts:675-677`); reproduce that, do not fix it here.
- Word wrap, folding, minimap, whitespace rendering, per-hunk stats, stage/revert — absent in `DiffView`,
  stay absent. Wrap and folding are additionally **forbidden** by §C4.

---

## 8. Working in a worktree

**Explicitly authorised by the operator for this migration, and scoped to the Editor repo only.**
Platform stays on `main` per its own operator rule (`platform/plans/README.md`) — do not create a
platform branch or worktree.

Isolation is worth having here: this repo carries unrelated uncommitted WIP, `main` is the branch
platform resolves against, and the migration deletes ~1,700 lines across a package platform imports
live. A worktree keeps a half-finished deletion out of the running dev server until you choose to expose
it.

### 8.1 The problem a worktree creates

Platform binds to **`/Users/shaul/Desktop/D/Editor` by absolute path, in three places**. A worktree at
any other path is invisible to all three:

| Binding | Where | Points at |
|---|---|---|
| `link:@singapor/*` overrides → the global bun link registry | `platform/package.json:44-60`; `~/.bun/install/global/node_modules/@singapor/*` | absolute symlinks into `/Users/shaul/Desktop/D/Editor/packages/*` — **this is the real resolution path** |
| `platform/packages/editor-*` symlinks | `→ ../../Editor/packages/*` | tooling/IDE convenience only — **not** workspace members (`platform/package.json` workspaces excludes them; `knip.json:3` ignores them) |
| Vite dev source resolution | `platform/apps/web/vite.config.ts:76-91` | derives source paths from whatever the above resolve to, snapshotted at config load |

So creating the worktree changes nothing on its own. Platform keeps compiling the old `DiffView`.

### 8.2 The mechanism

```bash
git -C /Users/shaul/Desktop/D/Editor worktree add ../Editor-diff-as-editor -b diff-as-editor
```

Then, **only when you want platform to see the worktree**, repoint the link registry from inside it.
`bun link` in a package overwrites that package's entry in the global registry:

```bash
cd /Users/shaul/Desktop/D/Editor-diff-as-editor/packages/diff && bun link
```

`@singapor/diff` is the only package this migration changes, so it is the only one to repoint — unless
§C10 adds `overscan` to `EditorOptions`, in which case `packages/editor` (`@singapor/core`) needs the
same treatment.

**Restore when done**, or every future platform session silently resolves the diff package to a stale
worktree:

```bash
cd /Users/shaul/Desktop/D/Editor/packages/diff && bun link
git -C /Users/shaul/Desktop/D/Editor worktree remove ../Editor-diff-as-editor
```

Repointing is **machine-global**, not project-local — it affects every consumer of `@singapor/diff` on
this machine while it is in force. Treat it as a mode you are in, not a step you did.

### 8.3 Three gotchas, in the order they will bite

1. **Carry the uncommitted `scripts/build-package.ts` fix into the worktree.** `main` currently has an
   uncommitted change reordering `copyCss()` *before* `buildJavaScript()`, so a watching dev server
   never sees a `dist` where `index.js` exists but its `import './style.css'` cannot resolve. A worktree
   branched from `main` does **not** carry it. This plan both rebuilds `packages/diff` and edits
   `style.css`, so building from a worktree without that fix reintroduces exactly the race it was
   written for. Commit it first, or cherry-pick it into the worktree before the first build.
2. **A stale worktree already exists** from a previous session — `git worktree list` shows one under a
   scratchpad path on `chore/inline-timer-justification`. Prune before adding
   (`git worktree prune`) so `worktree list` stays readable.
3. **Restart the platform dev server after repointing.** The Vite module list is snapshotted at config
   load (§C8), so a live server keeps serving source from the old path.

### 8.4 Do not run repo-wide formatting in the worktree

Committed sources here are not `oxfmt`-clean, so `bun run format` rewrites unrelated files and buries
the migration diff. Format only the files this plan touches.
