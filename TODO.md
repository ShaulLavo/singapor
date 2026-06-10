# TODO

Backlog of larger ideas we want but are deliberately not doing right now.

Inspired by [Text Editor Data Structures](https://cdacamar.github.io/data%20structures/algorithms/benchmarking/text%20editors/c++/editor-data-structures/)
(the fredbuf write-up, [repo](https://github.com/cdacamar/fredbuf)) — see also the discussion of
where our persistent treap already differs from its immutable RB tree.

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
- **Look into LSP incremental sync.** `packages/lsp/src/positions.ts` (~line 301) falls back to
  `createFullContentChange(materializeFullText())` — every degraded sync sends the whole document;
  look into incremental `TextDocumentContentChangeEvent`s.

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

Stepping stones (each independently justified):

1. SoA-ify the tree behind the existing API — main-thread perf + GC win, prerequisite.
2. Epoch-based reclamation — already wanted for tombstone compaction; becomes the arena GC
   (workers advertise oldest held root; recycle nodes unreachable from anything older).
3. SAB arena + atomic root publish — tier-2-only storage backend swap at the end.
