# E009: Decide worker transport changes from measured costs

- Status: Proposed
- Kind: Research
- Owner: Editor
- Priority: P2
- Effort: M
- Dependencies: [E001](e001-stress-fixtures.md)
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`, 2026-09-05.

## Outcome

Produce a reproducible cost model for moving text and syntax results between the editor and workers.
Decide whether the existing shared UTF-16 transport earns its encoding, decoding, and retention costs.
For example, compare a warm Tree-sitter update under ordinary string transport and shared buffers,
including time spent after the worker replies and before the visible result can paint.
No shared-memory architecture proceeds on historical anecdotes alone.

## Current code

- [Tree-sitter source](../packages/tree-sitter/src/treeSitter/source.ts) sends visible piece
  descriptors and 16 Ki-code-unit chunks using strings or `shared-utf16` payloads.
- Shared chunks already decode once in `resolveChunkPayload` and cache the resulting string.
  The wishlist's repeated-decode claim is stale. Encoding still fills UTF-16 units in JavaScript.
- [Chunk retention](../packages/tree-sitter/src/treeSitter/sourceChunkRetention.ts) tracks
  sent chunk lengths per document and invalidates them by document epoch.
  Those chunk identifiers derive from buffer IDs and offsets, not content hashes.
- [Worker client](../packages/tree-sitter/src/treeSitter/workerClient.ts) owns worker requests
  and lifecycle. [Packed tokens](../packages/editor/src/syntax/packedTokens.ts) already exist.
- [Shared-chunk tests](../packages/tree-sitter/test/source-sharedChunks.test.ts) exercise the
  source path. [Syntax benchmark](../packages/tree-sitter/bench/treeSitter-syntax.ts) is an existing entry point.

## Scope

Measure input encoding, descriptor creation, message transfer, worker decode, parse, result packing,
client unpacking, merge, allocation, retained bytes, and visible completion separately.
Compare actual supported channels. A remote LSP connection remains a serialization boundary.
Keep Tree-sitter in a browser WASM worker as the current default.
Native server parsing is a follow-up experiment only if measured cold parse warrants its host cost.

## Design

Use E001 fixtures with fixed edit streams, warm-up rules, browser versions, and machine metadata.
Compare ordinary strings, transferable typed arrays where the protocol permits ownership transfer,
and the existing shared UTF-16 path with its shipped decode-once cache.
Measure `slice`, `structuredClone`, manual UTF-16 fill, and decode separately as explanations,
then verify the complete consumer path. Microbenchmark wins alone cannot select a transport.

Include cold open, warm small edits, large paste, branch-changing undo, document replacement,
worker restart, and multiple retained documents. Count bytes in both main and worker heaps.
Check dedup identity across a buffer ID reused after undo and a same-length replacement.
An ID plus length is not a general content-addressed identity.

Separate three decisions in the report: retain or remove per-message shared chunks,
change result representation to avoid eager token objects, and research shared document storage.
Removing `shared-utf16` does not reject E010 through E013.
If shared chunks win, retain decode-once caching and document its lifecycle.
If they lose, propose deleting that path and every caller and test of its obsolete behavior.

Shared memory needs compatible channel capabilities, not one deployment-wide toggle.
Record actual isolation, base SAB, growable SAB, and asynchronous wait support independently.
Browser isolation affects availability and embedding behavior. Use the
[MDN isolation reference](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
when evaluating a host experiment. This plan does not change Platform serving headers.

## Steps

1. Instrument existing wide diagnostics to attribute transport costs to request and document version.
   Verify the instrument distinguishes an intentionally large payload from a small control.
2. Run the transport matrix against the same Tree-sitter grammar and E001 workload.
   Preserve raw samples and report medians, tails, peak memory, and repeated-run variation.
3. Measure residual packed-token unpacking and object allocation before proposing shared results.
   Compare lazy packed views with the current public token representation in a bounded prototype.
4. Inspect real channel capabilities in the running demo and Platform integration.
   Mark an unavailable capability as unavailable, not as a zero-cost benchmark result.
5. Write a decision table with keep, remove, or defer for each candidate and a follow-up scope.
   Link the measurements needed by E010 and E011.

## Verification

Use `bun run bench:syntax` from `packages/tree-sitter` as the existing benchmark control.
Use `bun run test test/source-sharedChunks.test.ts test/treeSitter-workerClient.test.ts`
there for source identity and lifecycle behavior when changing instrumentation or experiments.
Use `bun run test:browser` there for actual worker messaging and failure handling.
Extend correctness checks for lone surrogates, supplementary characters, chunk reuse, and disposal.
They catch accidental text normalization and stale dedup cache entries.

Approve a candidate only when complete-consumer savings exceed observed run-to-run variation,
improve the declared latency or memory target, and do not regress p95 input-to-paint latency.
Set a concrete target from E001 before comparing candidates. Publish a no-go decision if none qualifies.

## Risks and decisions

Shared storage still needs worker-local strings for string-consuming parser callbacks.
Cross-worker memory estimates may omit native WASM memory. Account for that separately.
The wishlist's June timing numbers are historical context, not baseline results for this plan.
Keep unsupported capability fallback as a real measured control throughout later SAB research.
