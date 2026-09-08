# E012: Reuse shared storage only after every reader releases it

- Status: Proposed
- Kind: Research
- Owner: Editor
- Priority: P3
- Effort: L
- Dependencies: [E006](e006-tombstone-reclamation.md), [E010](e010-shared-memory-toolkit.md), [E011](e011-packed-piece-tree.md)
- Inspected baseline: `9abb944f3a2b8d6516953fdec75e8df5e1a94811`, 2026-09-05.

## Outcome

Prove that shared tree nodes, text records, and old map generations can be recycled while
workers continue reading immutable snapshots.
A worker paused on an old root must read the same text after the main thread publishes many edits.
When that worker releases its root, unreachable storage becomes eligible for reuse.
The result is a tested reclamation protocol and a measured production-adoption decision.

## Current code

- [History](../packages/editor/src/history.ts) retains persistent roots through JavaScript references.
  [DocumentSession](../packages/editor/src/documentSession.ts) has additional transaction and clean-state owners.
- [Piece buffers](../packages/editor/src/pieceTable/buffers.ts) rely on JavaScript lifetime management.
  There is no arena-slot reuse protocol in the current piece table.
- [Tree-sitter source retention](../packages/tree-sitter/src/treeSitter/sourceChunkRetention.ts)
  uses document epochs to invalidate sent-chunk bookkeeping. Those epochs do not protect memory reclamation.
- [Worker requests](../packages/tree-sitter/src/treeSitter/types.ts) already carry versions,
  generations, and optional cancellation buffers. Cancellation is not proof that a reader stopped.
- E006 supplies root and anchor ownership rules. E010 and E011 supply experimental arenas and handles.

## Scope

Define reader registration, root acquisition, release, retirement, and safe reuse.
Cover tree nodes, reverse-index nodes, text chunks, line indexes, and shared map generations.
Prove failure handling for cancelled tasks, disposed documents, and terminated workers.
Do not convert production storage until the ownership and memory-order argument is reviewable.
Do not use timeout expiry as permission to reclaim memory a living worker may still access.

## Design

Propose reader slots with explicit unregistered, quiescent, and active states.
An active state identifies a reader generation and a protected publication generation.
Separate task cancellation from the acknowledgement that all reads and cached handles have ended.
Nested tasks in one worker must protect the oldest held root or use distinct reader slots.

Specify the acquisition handshake that prevents a writer from reclaiming a root between
the reader loading its identifier and announcing protection.
One candidate is announce, load, and validate against a publication sequence, retrying on change.
Write down the exact ordering and prove it against the
[ECMAScript memory model](https://tc39.es/ecma262/2023/multipage/memory-model.html).
No plain shared write may race with a read of a published immutable record.

Epoch age alone does not establish reachability in a persistent tree.
An old node can still be reachable from the newest root through structural sharing.
First prove a record unreachable from current, history, saved, transaction, and reader-owned roots.
Then retire it and wait until the relevant reader grace period ends before reusing its slot.
Compare tracing protected roots with reference counts on immutable edges plus deferred reuse.
Use E006's retention graph as the semantic control.

Prevent ABA errors with generation-bearing handles or equivalent proven non-reuse rules.
Publish a handle and its generation coherently. Define sequence wrap and arena-exhaustion behavior.
A stalled worker pins memory until it releases or the owner confirms worker termination.
Under pressure, retire an entire arena generation and use the ordinary transport if needed.
Bound retirement bookkeeping and expose blocked bytes by reader and root owner.

## Steps

1. Write the state machine and list all owning roots and worker-local cached references.
   Produce a counterexample for naive load-then-announce acquisition and for age-only reclamation.
2. Build a deterministic schedule runner that can pause each reader and writer at protocol boundaries.
   Validate the proposed acquisition and publication order before adding reuse.
3. Add retirement and reuse to the E010 allocator and E011 tree prototype.
   Check reachability with the E005 inspector before every test-controlled free operation.
4. Exercise task cancellation, document disposal, reader stalls, worker crashes, and restart.
   Verify that each path releases safely or reports a retained owner without corrupting data.
5. Compare tracing and reference-count candidates under E001 churn workloads.
   Publish pause, allocation, retained-byte, and reclamation-delay measurements with the decision.

## Verification

Use actual workers for shared-memory access and deterministic unit tests for ownership transitions.
Run tests through the package script containing the experimental code.
Force slot reuse while old snapshots are retained, reverse history branches, and hold nested reader tasks.
These cases catch premature frees that ordinary final-text assertions miss.
Poison retired slots before reuse in tests and compare every reader result with a private snapshot oracle.
Test duplicate release, stale worker acknowledgements, counter wrap simulation, and interrupted acquisition.
Verify that confirmed worker termination permits cleanup while an unresponsive live worker still pins data.

Adopt when adversarial schedules preserve all protected reads and released storage is reclaimed
within the measured maintenance budget under normal reader progress. If neither candidate meets
those conditions, close the research with the failing schedules or measurements and block adoption.
Require no p95 input-to-paint regression and bounded bookkeeping beyond legitimately pinned data.
If correctness needs an unbounded pause or a process-wide lock, stop and report the alternative cost.

## Risks and decisions

The most expensive retained root may belong to undo history rather than a worker.
Reclamation cannot promise constant memory while users deliberately retain unlimited history branches.
Weak references and garbage-collection timing cannot stand in for an explicit cross-worker release.
Keep prototype teardown reliable even if the chosen protocol is rejected.
