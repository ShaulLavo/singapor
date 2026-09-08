# E010: Prove a shared allocator and concurrent hash map

- Status: Proposed
- Kind: Research
- Owner: Editor
- Priority: P3
- Effort: L
- Dependencies: [E009](e009-worker-transport-costs.md)
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`, 2026-09-05.

## Outcome

Establish whether multiple workers benefit from sharing one chunk-dedup table and allocator.
Prove allocation, publication, collision handling, and table growth on a bounded prototype.
For example, two workers intern equal chunk text concurrently and obtain one stable content record
without reading a partially written key or losing either request.
Finish with a measured adoption or rejection decision before the editor depends on this code.

## Current code

- [Tree-sitter source chunks](../packages/tree-sitter/src/treeSitter/source.ts) already have
  string and shared UTF-16 payloads, with ordinary per-worker `Map` caches.
- [Sent-chunk tracking](../packages/tree-sitter/src/treeSitter/sourceChunkRetention.ts) uses
  per-document maps of chunk ID to length. It is not content-addressed deduplication.
- [Text buffers](../packages/editor/src/pieceTable/buffers.ts) and
  [piece types](../packages/editor/src/pieceTable/pieceTableTypes.ts) are JavaScript data structures.
  No SAB allocator or concurrent map is implemented there.
- E009 supplies the transport cost and actual channel-capability evidence that justifies this experiment.

## Scope

Prototype an open-addressing map over typed arrays, a bounded arena allocator,
immutable key storage, table-root publication, and a reproducible multi-worker test setup.
Use content-addressed chunk dedup as the candidate first consumer.
Evaluate style and string interning as a second consumer only after the first is measured.
Keep main-thread-only collections as ordinary `Map` instances.
This plan does not convert the piece tree or enable production node reuse.

## Design

Proposed records contain a hash, key offset and length, value handle, and explicit slot state.
Use `Uint32Array` cells for atomic control and separate views for immutable key bytes or UTF-16 units.
Choose key encoding explicitly and preserve exact JavaScript string content, including lone surrogates.
Resolve hash collisions with full key comparison. A matching hash never proves equal content.

Distinguish empty, claimed, and published slots so a reader cannot treat a claimed slot as initialized.
Use `Atomics.compareExchange` to claim a slot only if concurrent writers actually justify the cost.
Keep a single-writer design as the control. Do not add multiple writers without a consumer need.
Specify how a failed claimant releases temporary storage and how probes handle interrupted publication.
Publish a completed table generation through one atomic root record or a proved equivalent protocol.
Readers must retain the table generation for their complete lookup.

Start with a bump allocator and bounded lifetime, retaining old tables until all prototype workers stop.
Model a freelist, size classes, alignment, out-of-space results, and ownership of duplicate allocations.
Exercise freelist reuse only in a quiescent mode until E012 supplies safe reader reclamation.
This avoids a dependency cycle with E012 while still testing allocator mechanics.

Use fixed-size arena segments as a fallback. Growable SAB is an optional separately detected capability.
Document every shared control field and publication ordering against the
[ECMAScript memory model](https://tc39.es/ecma262/2023/multipage/memory-model.html).
Plain payload writes occur before publication and never race with later mutation.
Proposed branded arena offsets, table generations, and record handles prevent accidental cross-arena access.
Validate worker messages at the boundary and trust the resulting internal types.

## Steps

1. Define the consumer workload and compare duplicated local maps with a single-writer shared table.
   Include total retained key bytes and contention, not just lookups per second.
2. Implement an isolated allocator prototype with fixed bounds and deterministic failure results.
   Demonstrate allocation, alignment, quiescent release, reuse, and segmented growth.
3. Add the map and controlled concurrent insertions with forced collisions and duplicate keys.
   Record linearization points for insert, lookup, and table-root replacement.
4. Add cross-worker schedule controls that pause writers after claiming and before publication.
   Prove that readers never observe incomplete records and shutdown never waits forever.
5. Replay E009 chunk-dedup workloads and record a go or no-go decision.
   List the remaining lifetime obligations that E012 must discharge before production adoption.

## Verification

Place proposed allocator and map tests beside the experimental module, following package test scripts.
Use actual browser workers with shared memory enabled for concurrency tests.
Run the same consumer workload without shared memory to prove fallback output equality.
Test equal hashes with unequal keys, concurrent equal keys, empty keys, maximum lengths,
table growth during lookup, failed allocation, interrupted insertion, and worker disposal.
Those cases catch collisions mistaken for equality, duplicate publication, stale roots, and leaked claims.
Measure main-thread work, total memory, throughput, and longest lookup under contention.

Adopt only if the real shared consumer improves E009's declared target beyond sample variation
and the state-machine tests find no partial or stale read.
If an owner process with ordinary maps meets the target more cheaply, end with that decision.
Do not export an unused toolkit or register a setting for a research prototype.

## Risks and decisions

A hash map can add more synchronization than repeated immutable chunk transfer costs.
Refcounts alone do not solve lookup-versus-free races. E012 owns safe reclamation.
Offset width and maximum arena size are explicit limits, with failure paths before integer overflow.
Growing or replacing typed-array views must not invalidate handles still held by readers.
All experimental allocations are released by teardown even if the adoption decision is no-go.
