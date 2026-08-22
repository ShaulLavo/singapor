# TODO

Backlog of larger ideas we want but are deliberately not doing right now.

> This is an unordered product and technical-debt backlog, not an execution
> index. Cross-project order is authoritative in
> [Platform's `PLAN.md`](../platform/PLAN.md). The only active standalone Editor
> executable plan is [BiDi geometry Tier B](docs/plan-bidi-geometry.md); promote
> any other item into a bounded plan before implementation.

Inspired by [Text Editor Data Structures](https://cdacamar.github.io/data%20structures/algorithms/benchmarking/text%20editors/c++/editor-data-structures/)
(the fredbuf write-up, [repo](https://github.com/cdacamar/fredbuf)) — see also the discussion of
where our persistent treap already differs from its immutable RB tree.

Many items below were mined from a long-form interview with the fredbuf author about Fred, his
closed-source editor built on fredbuf (local clone: `/Users/shaul/Desktop/D/Editors/fredbuf`),
and a second interview with Allen Webster about 4coder and its customization layer (local clone:
`/Users/shaul/Desktop/D/Editors/4coder`). Each item carries enough context to be picked up
without having seen those interviews.

## Visual piece-tree debug tool

A debugging/inspection tool for the piece table, ideally visual (render the treap: node
priorities, piece order keys, visible/invisible pieces, cached subtree sums, the reverse index).
The fredbuf author credits `print_tree`/`print_piece`-style utilities as the reason the project
got finished at all; we currently have no tree printer and no invariant checker in
`packages/editor/src/pieceTable/`.

Scope ideas, smallest first:

- `validatePieceTreeInvariants(snapshot)` — walk the tree and re-derive every cached field
  (subtree lengths, visible lengths, line breaks, min/max order), check in-order `order` is
  ascending, check the reverse index mirrors the tree. Usable as a property check in tests.
- `debugPrintPieceTree(snapshot)` — text dump of tree shape with piece metadata.
- Visual layer on top: render snapshots side by side across undo history, highlight which nodes
  were path-copied by an edit. Would double as a teaching/marketing artifact for the editor.

## Reduce editor memory footprint

Two related fronts:

- **Tombstone accumulation.** Deletes mark pieces `visible: false` and keep them in the treap
  forever (`markTreeInvisible` in `packages/editor/src/pieceTable/tree.ts`). Tree height and
  split/merge cost grow with all-time edit count, not document size — the classic piece-table
  "long edit session" degradation, in log form. Need a churn benchmark first (interleaved
  insert/delete, measure piece count and op latency), then a compaction pass that drops invisible
  pieces once no live history snapshot or anchor can reference them (e.g. when the undo stack is
  trimmed). `normalizePieceOrders` already shows the rebuild-the-world hook pattern.
- **Full-text materialization.** Find, tree-sitter sync, minimap summaries, and LSP all call
  `materializeFullText()`, and `createDocumentTextSnapshot` retains full-text caches — so in
  practice we often hold the entire document as a flat string next to the piece table, doubling
  memory. The piece-walker work (in progress) is the enabler for removing most of these.
- **Look into LSP incremental sync.** Mostly done (June 2026): the dominant fallback was
  deferred syncs batching behind rapid input and losing their edits ('missing-edits' →
  full 48MB sync per typing burst); `DocumentEditChain` (`core/src/editor/editChain.ts`)
  now hands deferred consumers composed base-coordinate edits since any text version, and
  syncs log `snapshot-incremental`. The `fullSnapshotContentChange` fallbacks in
  `packages/lsp/src/positions.ts` remain as the safety net (reasons are recorded via the
  `lsp.contentChanges.path` diagnostic) — fine unless that diagnostic shows them firing.

## Research: SAB-backed SoA piece tree (LMDB-style shared snapshots)

Long-term dream: back the piece tree with a SharedArrayBuffer arena in structure-of-arrays layout
(`left: u32[]`, `right: u32[]`, `pieceStart: u32[]`, subtree sums, `flags: u8[]`, index 0 = null)
so same-cluster workers read the document directly — no descriptors, no chunk shipping.

Why it's sound here: the treap is persistent (path-copying, nodes never mutated), so an
append-only arena + one `Atomics.store` to publish the new root gives wait-free coherent
snapshots to readers with no locks — workers can keep reading an old root while main publishes
new ones. Same architecture as LMDB's copy-on-write B-tree / RCU. `Atomics.waitAsync` gives
push-free freshness.

Constraints learned up front:

- **SAB never crosses a process boundary** (agent cluster only), so SAB cannot be *the*
  foundation — it's a transport tier.
- **Tiers compose per channel, not per deployment.** The Platform app
  (`/Users/shaul/Desktop/D/Platform`) already mixes them in one editor instance: LSP is tier 0
  (WebSocket to `apps/server`'s LSP proxy), minimap and tree-sitter are tier 1 in-browser workers
  (`createTreeSitterWorkerBackend()` in `apps/web/.../editor-plugins.ts`), and tree-sitter could
  move server-side behind its backend interface at any time. Capability (`sharedMemory`) must be
  negotiated per backend channel at handshake; one deployment runs several tiers at once.
- **Tier model**: one logical protocol (immutable snapshots, content-addressed chunks, send-once
  dedup — already transport-agnostic) with three transports: tier 0 remote backend (strings over
  socket/IPC), tier 1 same-cluster workers (structured-clone strings), tier 2 crossOriginIsolated
  channels (SAB arena, shared tree).
- **Decision: tree-sitter stays in-browser (wasm worker) as default.** Context: the product is
  always a local server + UI (Electron bundle, or CLI launching the server + browser UI), so the
  server is loopback — RTT ~0.1–0.5ms, comparable to a worker hop. Per-keystroke latency is
  therefore a tie between wasm-in-worker and native-over-localhost; the call is operational:
  wasm wins on grammar distribution (one platform-independent artifact vs native prebuilds per
  OS/arch/ABI for the CLI) and zero new backend/doc-sync code. Native server tree-sitter wins on
  cold parse (~2–3x), browser-heap relief, and CPU isolation — keep it as a benchmark-gated
  future `TreeSitterBackend` implementation (content sync could piggyback the existing LSP
  `didChange` channel); revisit if cold-parse on realistic large files measurably hurts.
  Consequences: tree-sitter is the flagship tier-2 consumer. We control the serving headers, but
  tier 2 is still strictly opportunistic, never assumed: the UI must run in arbitrary user
  browsers (CLI mode opens the default browser; capability floor includes old/locked-down
  engines, and growable SAB is newer than base SAB), and COOP/COEP has collateral even where
  supported (every subresource needs CORP/CORS; COOP severs window.opener and breaks OAuth
  popups). Tier 1 is the contract; tier 2 upgrades per session/channel when the handshake allows.
- **The walker is the seam**: `PieceTableWalker` is storage-blind. Tier 0/1 workers implement it
  over decoded chunk caches; tier 2 over the SAB arena; consumers (tree-sitter callback, diff,
  future find/minimap) never know which tier they're on.
- **JS string tax**: no string views over external memory — every consumer needing a real
  `string` pays a decode (`String.fromCharCode`) into a worker-local cache. SAB removes transfer
  and protocol, never decode.
- **Today's `shared-utf16` chunk path is dead code in practice**: no deployment sets COOP/COEP
  (Platform app has none → `crossOriginIsolated` false), it re-decodes on every read
  (`readUtf16Text` in `packages/tree-sitter/src/treeSitter/source.ts`), and the encode side is a
  per-char JS loop. Bench string `slice` vs SAB decode and `structuredClone` vs manual fill —
  the same numbers price tier 2's read path — then either delete `shared-utf16` or convert it to
  decode-once-and-cache. Per-message SAB transport and tier-2 storage-layer sharing are separate
  decisions; killing the first does not touch the second.

Evidence from the June 2026 typing-latency hunt (1M-line / 48MB fixture, Chromium):

- The tree itself is not the main-thread cost: full treap edit (`editor.view.applyEdit`)
  held at ~0.6ms/keystroke through every profile and never appeared as a hot leaf. Every
  real win was O(document) work *around* the tree (line-break scans, snapshot lineStarts
  rebuilds, full-text materialization, message payloads). Step 1 below is therefore
  justified as the tier-2 prerequisite, not as a standalone perf win.
- Message-passing priced: one ±250k-char tree-sitter refresh ships ~193k tokens + 34k
  brackets (`treeSitter.parseResult.payload` diagnostic). As object arrays that cost
  ~97ms/20-keystrokes of main-thread deserialize + ~305ms GC; packed SoA + transferables
  (`core/src/syntax/packedTokens.ts`) cut that to 12ms + 40ms. The residual is the
  client-side unpack into 193k `EditorToken` objects + merge — exactly the part tier-2
  shared results (or an SoA in-memory token model with lazy views) would delete.
- New primitives that slot into the plan: `DocumentEditChain` (tier-1 chunk-mirror sync is
  now built, not hypothetical), per-buffer `\n` offset indexes
  (`pieceTable/buffers.ts` `lineIndexes` — an SoA sidecar the arena design must carry or
  workers rebuild), and `LineStartsView` (snapshots expose base + suffix-delta line
  starts instead of materialized arrays; minimap/LSP/scope-lines consume the view).
- Worker-copy staleness is the recurring bug factory: the LSP full-sync regression, the
  minimap baseline drift (its structural-scan skip silently never fired because the
  baseline was post-edit state), and the edit chain itself all exist only because workers
  synchronize copies via messages. Tier 2 deletes the bug class, not just the copy cost.

Stepping stones (each independently justified):

0. **SAB hash map (the toolkit proving ground).** Open-addressing map over typed-array
   views: `Uint32Array` key/value cells, insert via `Atomics.compareExchange` slot claim,
   resize by publishing a new table root, string keys as `{offset, len}` into a bump/
   freelist allocator with byte-compare on probe. It is the arena project minus tree
   invariants and minus persistence — the cheapest way to build and battle-test the whole
   SAB toolkit (allocator, atomics discipline, epoch reclamation, growable-SAB handling,
   cross-worker test harness) before the piece tree depends on it. First consumer already
   named in the tier model: the content-addressed chunk dedup table
   (`hash(chunk) → { sabOffset, length, refcount }`); second: cross-worker style/string
   interning. Guardrail: main-thread-only tables stay plain `Map` — the SAB map only pays
   when one table is read from multiple threads.
1. SoA-ify the tree behind the existing API — prerequisite for the arena; do not expect a
   measurable main-thread win on its own (the treap held ~0.6ms/keystroke at 1M lines).
2. Epoch-based reclamation — already wanted for tombstone compaction; becomes the arena GC
   (workers advertise oldest held root; recycle nodes unreachable from anything older).
3. SAB arena + atomic root publish — tier-2-only storage backend swap at the end.
4. **Worker-parallel find-all (the payoff consumer).** Fred-style: chunk the document by line
   ranges, fan the *same immutable snapshot* out to N workers (tier 1: chunk mirrors kept in
   sync via the now-existing `DocumentEditChain`; tier 2: read the SAB root directly), each worker searches its
   chunks and streams matches back through a results queue so the UI renders matches + a
   progress bar incrementally; cancellation via a shared flag/epoch workers poll between
   chunks. Persistence makes this lock-free by construction — a worker can never observe a
   mutation, only an older root. Fred details worth copying: the main/UI thread participates
   in the search with roughly a 2x share of the work (it would otherwise idle waiting to
   join), and per-worker timing is surfaced in its debug overlay (his numbers: ~23ms over a
   20MB/636k-line file, debug build). Extends naturally from one buffer to cross-file find-all
   over a chosen root directory. Single-threaded in-buffer find improvements are a separate
   TODO ("Faster in-buffer find"); this item is strictly the parallel/multi-file tier.

## Undo history as a graph (never lose an edit state)

The fredbuf trick, condensed: with append-only text buffers and a path-copying (persistent)
piece tree, every edit already produces a brand-new root while old roots stay valid forever —
so keeping *all* history is just not dropping old root pointers. fredbuf's undo entry is
literally `{ tree root, edit offset }` (`fredbuf.h:21` in the local clone), i.e. "every edit is
two pointers big"; Fred builds its branching history graph in the editor layer on top of the
buffer's `commit_head()/head()/snap_to()` primitives, and undo/redo just swap which root is
current.

We already have every prerequisite: a persistent path-copying treap
(`packages/editor/src/pieceTable/tree.ts`), append-only buffers
(`packages/editor/src/pieceTable/buffers.ts`), O(1) snapshots, and
`packages/editor/src/history.ts` storing `{ snapshot, selections, transaction }` per entry in
persistent stacks, with typing-run coalescing (`amendEditorHistory` + `shouldAmendTypingRun` in
`documentSession.ts`). The single flaw: `commitEditorHistory` (`history.ts`, the `redo: null`)
discards the redo branch on every new commit — editing after an undo orphans the abandoned
states, exactly the behavior Fred was built to escape.

Change: replace the twin undo/redo stacks with a tree.
`HistoryNode { snapshot, selections, transaction, parent, children[], createdAt }` plus a
`current` pointer. Undo = move to `parent`; redo = move to the most-recently-created child
(plain linear undo/redo UX is unchanged); commit = append a child and **never delete
siblings**; amend (typing coalescing) = update `current` in place, as today.
`DocumentSession` is the only consumer (`packages/editor/src/documentSession.ts` ~406–435
undo/redo, ~495–549 commit paths). Memory cost is identical per edit (structural sharing; GC
reclaims what no root references) — abandoned branches add a few pointers each. Optional
safety valve: cap node count and prune oldest leaves.

Sub-TODO — persist history across sessions: each node already stores a `DocumentTransaction`;
serialize the tree as transactions + parent links and replay on open (Fred's planned approach
too). Needs an integrity check (content hash) since the file can change on disk outside the
editor.

## Undo graph widget (Fred-style time-travel UI)

Depends on "Undo history as a graph" above. A panel rendering the history tree as a node graph
with visible branches — Fred's marquee feature (Ctrl+Shift+Z):

- Click any node → jump the document to that state (snapshot swap via `DocumentSession`;
  selections are stored per node, so cursors restore as part of the jump).
- Walking nodes shows the diff for each step; selecting any **two** nodes — including across
  branches — shows the diff between them. All diffs are computed on demand by walking the two
  snapshots and are never stored: any two states are just two roots over shared buffers.
- Parent↔child pairs: `diffPieceTableSnapshots` (`packages/editor/src/pieceTable/diff.ts`)
  already computes the minimal single edit without materializing either document — exactly
  right for per-step display.
- Arbitrary pairs need a real line-level diff (Myers or histogram over line hashes, ~100 lines
  of code). `packages/diff` already renders hunks (`editorDiffPlugin.ts`, `model.ts`) — only the
  compute step is missing. Pull line text through the piece walker to keep avoiding full
  materialization.
- Label nodes with the transaction metadata we already record (source, timestamp). Far-future
  extra from Fred's own wishlist: merge two nodes into a combined state.

## Faster in-buffer find (single-threaded)

Current state: `packages/find/src/search.ts` matches with `RegExp.exec`/`String.indexOf` over
`host.materializeFullText()` (`packages/find/src/findController.ts`) — every search
materializes the whole document (also flagged under "Reduce editor memory footprint") and runs
on the main thread.

- Benchmark first, on the stress fixtures (see "Standing stress fixtures" below): literal +
  regex find on a ~600k-line file, warm and cold.
- Research pass, then pick: Boyer–Moore–Horspool (Fred's matcher; skips by needle length) vs
  V8's `indexOf` (native SIMD — beating it from JS is not a given; measure, don't assume).
  The regex path likely stays `RegExp` but can run per-chunk with overlap.
- Search over piece-walker chunks (`createPieceTableWalker`) instead of one giant string,
  handling matches that straddle chunks (overlap window = needle length − 1). Keeps memory
  flat and works on any historical snapshot.
- Case-insensitive matching without lowercasing the entire document (per-chunk folding inside
  the matcher).
- Incremental re-search on edit: the edit chain (incremental document sync work) yields exact
  dirty ranges — rescan only affected spans plus a match-length margin, not the whole buffer.
- UX bar from Fred: *every* match found and highlighted instantly as you type the query (not
  first-match-then-enter-enter), with a live match count.

Scope note: single-threaded and single-buffer only. Worker-parallel and cross-file find-all
live in the SAB TODO, stepping stone 4.

## Input latency as an enforced budget

Fred's feel comes from a designed priority: events on the keystroke→glyph path are processed
first, and everything else (highlighting, line guides, occurrence match, minimap) is async and
late-bound. We believe this too — make it enforced rather than aspirational:

- Write the invariant down (ARCHITECTURE.md): the synchronous keystroke path is
  input → piece-table commit → layout → paint of affected lines. Nothing else may ride it.
- Instrument it: performance marks around that path, surfaced in the dev instrumentation
  panel; dev-mode warning when a keystroke exceeds a main-thread budget (e.g. 4ms).
- Audit current sync riders (tree-sitter sync hooks, minimap `workerClient` posts, scope-lines
  recompute, `packages/editor/src/editor/occurrences.ts`) and demote anything paint doesn't
  need.
- Regression guard: a typing-burst-on-large-file scenario in the standing benchmark harness.

## Look into: windowed/streamed loading for massive files

Maybe-future. A 48MB document currently flows whole through every layer: one `fs.read`
returns the full text, the piece table holds it, and the tree-sitter structural parse
covers the entire document — which sits right at the WASM memory ceiling (a single
duplicated parse request was enough to tip `parse root` into `Aborted()` during the
June 2026 StrictMode-leak hunt; the worker parse dedupe made it survivable, not
comfortable). Two candidate directions, possibly combined:

- Sliding-window document view: the frontend never materializes massive files whole.
  Stream the file in ranges and keep a window (plus margins) resident; the piece table,
  syntax, LSP sync, and minimap all operate on the window. Big design lift: offsets
  become window-relative, cross-window edits and search need a spill path.
- Capped structural parse: keep whole-file text but bound the tree-sitter parse to a
  window around the viewport (the token query machinery is already windowed via
  `VISIBLE_SYNTAX_*_CHARS`); reparse on window moves like the prefetch path does.
  Much cheaper to ship, doesn't fix memory for the text itself.

## Look into: render nothing at zero-height viewports

Possible optimization, needs investigation. A virtualized view whose scroll element measures
`viewportHeight === 0` still mounts rows and registers token highlight ranges:
`computeFixedRowVisibleRange` clamps the visible range to at least one row
(`packages/editor/src/virtualization/fixedRowVirtualizer.ts`, the `Math.max(start + 1, rawEnd)`
clamp) and `DEFAULT_OVERSCAN = 12` extends it, so a 0-sized editor mounts 13 rows of real text
and pushes their ranges into the shared `editor-shared-token-*` highlight registry. Observed
2026-06-11 in the platform app, where keep-alive `display:none` tabs each held 13 rows / 32–47
ranges (host-side lifecycle tracked in the platform repo:
`docs/editor-tab-lifecycle-performance.md`).

The optimization: at zero height, mount no rows, register no highlight ranges, skip token
reconcile; cold-mount normally on the first nonzero measure.

Before changing anything, find out why the ≥1-row clamp exists — likely some consumer needs one
mounted row (font-metrics bootstrapping?). If so, satisfy that need explicitly rather than via
the clamp.

## Cursor position navigation history (alt+left / alt+right)

Not covered by edit history: `history.ts` stores selections per *edit*, so undo restores
cursors at edit boundaries — but pure navigation (a click somewhere far, goto-line, find jump,
go-to-definition) creates no entry. Fred keeps a per-buffer trail of cursor positions you can
walk back/forward through; cheap to build, used constantly.

- Record a waypoint on "jumps" only (cause-based: mouse click, goto-line, find jump, goto-def —
  or a distance heuristic like >10 lines), dedupe adjacent waypoints, ring buffer (~128) per
  document view.
- Store anchors, not offsets (`packages/editor/src/pieceTable/anchors.ts`), so waypoints
  survive edits; resolve at jump time and drop dead ones.
- Browser back/forward semantics per pane: walking back and then jumping somewhere new
  truncates the forward tail.

## Copy selection as styled HTML

Fred attaches a `text/html` clipboard flavor carrying the syntax colors, so pasting into
Gmail/Docs/Slack keeps highlighting. Small feature, outsized delight — and nearly free for us
since highlight tokens already exist.

- On copy, build inline-styled HTML for the selected range from the token stream
  (`packages/editor/src/tokens.ts` / shiki pipeline): `<pre>` + spans with explicit inline
  `color`/font styles — no classes, paste targets strip stylesheets. Write a `ClipboardItem`
  with both `text/plain` and `text/html`; the copy command runs inside a user gesture so
  `navigator.clipboard.write` is permitted.
- Fred lesson: dark-theme colors look terrible pasted onto white. Emit a light theme by
  default (or a setting: current/light/dark) regardless of the editor's theme.
- Multicursor: mirror plain-text copy semantics (per-selection blocks joined with newlines).

## Dev instrumentation panel (ship the debug tooling)

Fred ships its debug surface *to users*: a fuzzy-searchable config/debug-flag explorer, live
per-thread search timings, an FPS overlay, and an arena tracker showing each subsystem's peak
memory with click-to-jump-to-the-allocating-line. The habit to copy: instrumentation is a
first-class, always-one-keystroke-away widget, not scattered logs. We already do some of this —
consolidate and expand:

- One fuzzy-searchable panel toggling debug flags at runtime (`packages/editor/src/debug.ts`
  is the seed; flags currently live as scattered consts).
- Frame/paint timing and input→paint latency (feeds the input-latency budget TODO).
- Retained-memory estimates per subsystem: piece table (buffer bytes, live vs tombstone piece
  counts — numbers "Reduce editor memory footprint" needs anyway), tree-sitter trees, minimap,
  LSP caches.
- Search/highlight timing breakdowns when those run.

Related: "Visual piece-tree debug tool" above is the deep inspector for one subsystem; this is
the shallow always-on dashboard.

## Tree-sitter syntax tree inspector (with a Zed comparison step)

Fred binds F11 to a panel showing the live tree-sitter parse tree of the current buffer and
uses it to debug highlight queries. We have the parse infra (`packages/tree-sitter`, worker
backend; `packages/editor/src/syntax`); the inspector is mostly UI:

- Panel of nodes (kind, byte/point range, named vs anonymous, error/missing flags),
  live-updating from the existing incremental parses.
- Two-way sync: cursor move highlights the node path to root; clicking a node selects its
  range in the editor.
- **Step 1 — Zed comparison:** Zed is open source and ships `debug: open syntax tree`
  (github.com/zed-industries/zed). Study its UX and implementation (selection sync, how it
  handles huge trees without rendering everything) plus the tree-sitter web playground, and
  write up findings before designing ours.
- Payoff beyond query debugging: groundwork for tree-sitter-driven go-to-definition (Fred's
  plan: most go-to-def only needs syntactic info, no LSP).

## Standing stress fixtures + interactive benchmarks

Fred's habit: keep absurd files around (a 636k-line / ~20MB C file, a Unicode stress file) and
routinely jump to line 500k, search, and edit — in debug builds — so regressions are *felt*
immediately. We already work this way ad hoc; make it repeatable:

- `scripts/` generator or fetcher for fixtures: huge real-code file (500k+ lines), a
  pathological single long line, Unicode-heavy text, CRLF/LF mixes.
- Scripted scenarios with numbers recorded in-repo so perf shifts show up in diffs: open →
  first paint, goto-line 500k, typing burst, find-all of a frequent token, full scroll sweep.
- Reuse the harness for the churn benchmark "Reduce editor memory footprint" wants and the
  cold-start measurement "Defer startup work" wants; exercises
  `packages/editor/src/virtualization/` where scroll stalls were just fixed (commit 824e4cb).

## File explorer: flattened view

Fred's explorer has an "anchor" toggle that flattens everything under a chosen root into one
fuzzy-filterable list of files — salvaged from three failed project-system attempts and kept
because it's independently useful with no project concept required. The same anchored root
later defines the file set for cross-file find-all (SAB TODO, stepping stone 4).

This repo has no explorer package — the explorer lives app-side (Platform repo,
`/Users/shaul/Desktop/D/Platform`), so implementation likely lands there with any reusable
fuzzy-list widget extracted here. Recorded here so it travels with the rest of the Fred notes.

## Plugin system: study Fred's runtime-compiled plugin model

Background (self-contained, since Fred is closed-source): Fred is the editor built by the
fredbuf author. A Fred plugin is a single C file that the *running editor* compiles with an
embedded Tiny C Compiler (TCC) in ~1ms into an in-memory executable code page — no DLLs, no
restart; you recompile and rebind from the command palette while the target buffer stays open.
Plugins get the full editor C API, deliberately unsandboxed (local trusted code). The API
surface is generated from one declarative `.dat` file via X-macros, so the dispatch table,
TCC symbol registration, and docs can never drift apart. Capabilities a plugin gets: register
editor commands with a UI name + description (surfaced in the command palette, bindable to
hotkeys, resolved by C function name via `TCC get symbol`), a batch-edit API where one batch =
one undo point, per-cursor access so a command can act on individual multicursors (e.g. the
community "align cursors with spaces" plugin), message-feed notifications, and scratch memory
arenas. Power users stripped his helper layer and pulled in their own C libraries — the plugin
file is just C.

Ours today: compile-time plugin modules wired at build (`packages/editor/src/plugins.ts`;
examples: `packages/find/src/plugin.ts`, `packages/lsp-plugin`,
`packages/diff/src/editorDiffPlugin.ts`, `packages/editor/src/mergeConflictPlugin.ts`). There
is no user-authored runtime plugin story.

The TODO is a design doc, not code:

- Gap analysis against the Fred capability list: command registration with palette metadata,
  keybinding registration, batch edits guaranteed to be a single undo entry, per-selection/
  multicursor operations, snapshot + walker reads, notifications, panel/widget contribution.
  Which does our internal plugin interface already expose? Which are missing or implicit?
- Pick the TS analog of "TCC": dynamic `import()` of user ESM from a config dir with file
  watching for hot reload, vs bundling esbuild-wasm to compile user TS in-editor in
  milliseconds (closest to Fred's instant feel). Deployment is a local server + browser UI,
  so loading local user code is natural; the sandboxing stance can match Fred's (trusted
  local code) — but document that decision explicitly.
- Define the stability boundary (public plugin API vs internals), taking Fred's lesson:
  generate bindings/docs from one source of truth so they cannot drift.

## Defer startup work off the first-paint path

Fred starts about as fast as Notepad *in a debug build* by pushing every initialization it can
onto background threads (a trick credited to File Pilot) — only window/GL setup stays on the
critical path. Our translation: first paint needs only plain text + layout.

- Audit editor mount → first visible text for synchronous work; paint unstyled virtualized
  lines immediately and enhance in place as subsystems come online.
- Lazy-attach everything else: tree-sitter wasm fetch/compile, LSP connect, minimap worker
  spawn, shiki/theme load — none may gate first paint; each upgrades the view when ready.
- Watch for dynamic-import waterfalls at mount.
- Measure cold start in the benchmark harness (see "Standing stress fixtures").

## Command metadata: single source of truth

4coder lesson. Its commands are declared at the definition site as `CUSTOM_COMMAND_SIG(name)` +
`CUSTOM_DOC("...")`, and a metadata generator parses the source into a table of
`{ fn, name, doc, source file, line }` (`custom/generated/command_metadata.h` in the local
clone) that powers the in-editor command lister and the docs site. The author calls redundant
metadata systems the thing that wore him down — he built two or three of them — and the
committed generated file still contains `C:\4ed\...` absolute paths from his machine, a fossil
of exactly that maintenance pain. The rule worth keeping: a command's name, documentation, and
default bindings live in *one* declaration next to its code; everything else is derived.

Our gap: `packages/editor/src/editor/commands.ts` is a bare string-union `EditorCommandId` — no
titles, descriptions, or categories anywhere; handlers are wired separately (command router),
keybindings separately (`packages/editor/src/editor/keymap.ts`). Adding a command touches
several files, and a future command palette would need yet another parallel list.

Change: one declaration per command — `{ id, title, doc, category?, defaultBindings, handler }`
— in a single registry; derive the `EditorCommandId` type from it (`as const` + `keyof`) so
type strictness is kept, and derive palette entries, docs, and keybinding-conflict UI from the
same table. No codegen needed: 4coder's generator pass exists only because C cannot iterate its
own globals — in TS the "metaprogram" is an object in a Map. Plugins contribute commands
through the same declaration shape (see the "Plugin system" TODO).

## Editor hook taxonomy: inventory and completeness check

4coder lesson. Its entire default editor behavior hangs off ~15 named hooks (grep
`set_custom_hook` in the local clone's `custom/` layer): layout, per-view render, whole-screen
render, the per-view input handler itself, tick, scroll-animation delta rule, begin/end buffer,
save, edit-range, new-file, buffer-name resolver, view-change. Two standouts:
`HookID_ViewEventHandler` — the *entire per-view input loop* is replaceable customization code,
which is what makes deep emulation (vim) possible at all — and `HookID_DeltaRule` — the
scroll/cursor animation curve is a tiny pluggable strategy function (`fixed_time_cubic_delta`).
A small, explicitly named, complete hook set is the backbone of a customization layer.

The TODO (feeds the "Plugin system" design doc): inventory our actual extension points — plugin
surface (`packages/editor/src/plugins.ts`, `pluginLifecycle`), command router, display
projection registry, block providers, syntax provider sessions, save/load paths — name each
one, and run a completeness check against the 4coder list: layout/display projection, render
decoration, input/keymap pipeline, tick/frame, scroll animation curve, buffer lifecycle
(open/close/save/edit-range), view lifecycle. Decide per hook: public plugin API vs
internal-only. The input pipeline deserves special attention — make it wrappable (a default
handler a plugin can decorate or replace) rather than hardcoded.

## Stress-test the input/command substrate with a modal (vim) layer

4coder lesson. Substrate assumptions bake in silently: its customization layer was shaped by
emacs-style habits, and vim-style emulation turned out much harder to build on it than
emacs-style behavior. Fred avoided this by making vim motions + multicursor first-class from
day one. Cheapest insurance: build a modal layer *early*, while assumptions are still cheap to
fix. The point is not shipping vim — a modal layer exercises everything a non-modal one never
touches:

- Mode state in the input pipeline (`packages/editor/src/editor/input.ts`, `inputState.ts`,
  `keymap.ts`) — can a binding set switch keymaps per mode?
- Key *sequences* and operator-pending states (`d` → `i` → `w`), counts, and commands
  parameterized by them — does our command shape allow arguments beyond "function over editor
  context", and can commands compose?
- Per-mode cursor rendering (block vs bar) and selection semantics.

Deliverable: a minimal modal binding set (normal/insert modes, a handful of motions and
operators composed from existing commands) written as if by a third party against the
plugin/keybinding API, plus a list of every place the substrate fought back. Run this before
the plugin API is declared stable.

## Compact blank lines (display-time)

4coder ships layout as pluggable variants, one of which — `layout_unwrapped_small_blank_lines`
— renders blank lines at roughly half height: more code on screen, file untouched.
Display-only, cheap, surprisingly pleasant.

Ours would be an opt-in display option rendering empty (or whitespace-only) lines at a fraction
of the line height. Reality check first: text rows go through `fixedRowVirtualizer`
(`packages/editor/src/virtualization/`), which implies uniform text-row heights — block rows
are the existing variable-height path. So step 1 is feasibility: can the virtualizer take a
per-row height exception cheaply, or is the compact look better faked (same logical row height,
squashed visual line-box)? Then: point mapping through the display-transform stack (wrap/blocks
already shift vertical mapping), cursor rendering on a compact line, and whether the minimap
mirrors the compaction. Doubles as a proof that the display pipeline can handle per-row height
variation — the same muscle future layout variants will need.

## Hot/cold data structure vocabulary

Adopt Allen Webster's framing as project terminology (an ARCHITECTURE.md section; mostly
writing, no code). **Cold** = serialized, position-independent encodings where the byte
sequence alone carries the meaning — safe to copy, store, and hand across process boundaries.
**Hot** = pointer-rich runtime encodings of the *same information*, tuned for fast
mutation/query, meaningless outside their process. Programs constantly translate between the
two; being explicit about which side a structure lives on (and where the translations happen)
sharpens design discussions — e.g. it cleanly explains why history persistence should serialize
*transactions* (cold) and replay them into snapshots (hot) rather than dumping the tree.

The write-up: define the terms and inventory ours — cold: file text on disk, serialized
session/workspace state, the planned history-persistence format (transactions + parent links),
LSP wire messages, structured-clone worker payloads; hot: piece-tree snapshots and the reverse
index, buffer line indexes, anchors, tree-sitter trees, worker-side chunk mirrors. Note the
translation points (open/save, edit-chain worker sync, future history replay) and use the
vocabulary in future TODOs and docs.
