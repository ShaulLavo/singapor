# E013: Let eligible workers read shared immutable document snapshots

- Status: Proposed
- Kind: Research
- Owner: Cross-repo
- Priority: P3
- Effort: XL
- Dependencies: [E010](e010-shared-memory-toolkit.md), [E011](e011-packed-piece-tree.md), [E012](e012-epoch-reclamation.md)
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`, 2026-09-05.

## Outcome

Evaluate publishing one immutable document snapshot for several eligible workers to read directly.
A Tree-sitter worker can finish reading an old version while the editor publishes a newer root.
The same editor can use shared memory for one channel, string chunks for another,
and serialized messages for a remote backend.
Unsupported environments keep a fully functional ordinary transport.

## Current code

- [Tree-sitter source](../packages/tree-sitter/src/treeSitter/source.ts) already has chunk
  descriptors, string caching, and optional per-message shared UTF-16 payloads.
- [Worker protocol](../packages/tree-sitter/src/treeSitter/types.ts) carries document versions
  and request generations. It does not expose a shared piece-tree arena handshake.
- [Worker client](../packages/tree-sitter/src/treeSitter/workerClient.ts) owns worker lifecycle.
  [The current walker](../packages/editor/src/pieceTable/walker.ts) traverses object nodes.
- [Platform plugins](../../platform/apps/web/src/features/editor/utils/plugins.ts) compose
  syntax and optional minimap consumers. Platform has a separate
  [LSP proxy](../../platform/apps/server/src/lsp/proxy-session.ts).
- E011 and E012 are proposed packed storage and reclamation prerequisites, not shipped APIs.

## Scope

Prototype one shared snapshot reader with Tree-sitter as the first consumer.
Include capability negotiation, immutable publication, fallback, cancellation, and disposal.
Demonstrate a second reader only after the first shows an end-to-end benefit.
Keep in-browser WASM Tree-sitter as the default implementation.
Server-native parsing remains a separate benchmark-gated backend proposal.
Production header, authentication, embedding, and asset-loading changes belong to Platform.

## Design

Propose a channel capability result distinguishing serialized, cloned-chunk, and shared-arena access.
Negotiate each backend channel independently. Same-origin deployment does not prove shared-memory eligibility.
Retain one document-version and cancellation model across transports.
Do not claim the existing source IDs are content-addressed. E010 must establish actual content identity
before the protocol relies on hash-based deduplication.

Publish a descriptor containing coherent references to the tree, reverse index, text storage,
line-index data, logical text version, and arena generation.
Prefer one atomic pointer to an immutable descriptor over independent root and version stores.
If the descriptor requires multiple control words, prove the consistency protocol explicitly.
Readers acquire and release through E012. Published nodes and text remain immutable.
An atomic root alone is insufficient if side tables still mutate underneath the reader.

Implement the existing walker behavior over packed storage so parser consumers request ranges
without depending on transport. Preserve UTF-16 offsets and exact text.
Cache decoded strings per immutable chunk generation when a parser requires JavaScript strings.
Shared memory removes transport copies but does not eliminate that decode cost.
Benchmark asynchronous notification against ordinary messages. Never block the UI thread waiting for freshness.

Platform must test cross-origin isolation with its real assets, external integrations, and popup flows.
The [MDN SharedArrayBuffer reference](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
describes the security requirements. Detect base SAB and growable SAB separately.
On unsupported capability, failed initialization, or a worker restart, establish the latest version
through the ordinary channel without showing stale syntax as current.

## Steps

1. Confirm E009's expected savings still exist after E007 and other consumer improvements.
   Recheck Platform's actual headers and channel topology at the implementation baseline.
2. Implement an isolated shared-snapshot descriptor and reader using E011 and E012.
   Compare every range and line lookup with the existing snapshot implementation.
3. Add negotiated Tree-sitter input access with the ordinary source path as the control.
   Prove version identity through open, edit bursts, cancellation, and document replacement.
4. Run an explicit Platform integration experiment with its existing server and browser setup.
   Record asset, authentication-popup, and embedding effects before proposing deployment changes.
5. Measure complete parse-to-paint and retained memory with one and multiple consumers.
   Publish an adoption decision with the exact host work required for production use.

## Verification

Use `bun run test:browser` from `packages/tree-sitter` for existing real-worker coverage.
Extend source and worker tests through that package's `test` script for the proposed channel variants.
Verify capability combinations with shared memory unavailable, available, and failing during setup.
Compare shared and ordinary outputs for edits, undo, injections, long lines, and malformed Unicode.
Hold old roots during growth and document close to catch mixed-version reads and premature reuse.
Test stale responses after disposal and two views sharing one document with separate worker tasks.
Build changed package exports and check React, Solid, minimap, and Platform plugin consumers.

Adopt only if complete-consumer savings beat E009's target and observed variation,
typing latency does not regress, retained memory remains bounded by declared owners,
and every unsupported environment passes the ordinary transport scenarios.
Production adoption also requires Platform's concrete integration checks to pass. A measured no-go
completes this research with the ordinary transport retained and the rejected tradeoff recorded.

## Risks and decisions

Shared arrays cannot replace serialization across process or agent-cluster boundaries.
Packing document storage does not remove syntax-result unpacking measured by E009.
Avoid a second production document truth maintained only for shared readers.
If maintaining both representations erases the savings, reject the integration and retain the current channel.
