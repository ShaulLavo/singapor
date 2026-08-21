# Semantic tokens — editor-side execution plan

Companion to `docs/parity-plan.md`, for the one finding that programme left unbuilt:
**Semantic tokens: delta protocol with in-place Uint32Array splicing**, recorded `[~]` in Milestone 14
(`docs/parity-plan.md:827-833`), ranked last of all 99 findings, prose at
`docs/parity-monaco-codemirror.md:1633-1647`.

Same working protocol, rules and status key as `docs/parity-plan.md` — re-read that file's
**Working protocol** and **Rules** sections before starting.

**Scope of this file: what the editor library must do.** The defects that exist regardless of any
server, and the contract this library exposes so a host can feed it semantic tokens. It does not
describe spawning language servers, installing them, matching a server to a file, or the transport
that carries LSP messages. Those live in the consuming product's plan, which references the
**Contract** section below by name and by term id.

Audience: an agent who will follow this literally. Where this plan says a thing does not exist, it
does not exist; where it says something is conditional, do not build past the condition without
telling the human.

**Citations.** Line numbers are as of the working tree at `e5c0a0a` plus its local modifications, and
this branch moves. **The symbol name is the anchor; the number is a hint.** Every citation in this
file names a symbol or a string you can grep for. If a number is wrong and the symbol is there, the
citation is fine. If the symbol is gone, stop and say so.

**This plan has been through an adversarial critique, a revision, an independent verification pass, a
re-scoping against the real consumer, a seam reconciliation against the consuming product's plan, and
a closing pass that applied the decisions a re-check of that reconciliation handed down.** The Review
section at the end records all six, including which conclusions the later passes reversed, on what
evidence, and which seam terms were settled by decision rather than by merge. Read it before
executing.

---

## Execution status

**Milestones 0 through 6 are built, tested and green; Milestone 7 is the conformance fixture and is
tracked in its own section.** Every milestone's checklist below is ticked with a note on what landed,
and every measurement the plan asked for is recorded as a blockquote beside the milestone that asked
for it. Where the implementation departed from the plan as written — three additions in Milestone 4,
one clarification in Milestone 6 — the departure is written up under that milestone rather than made
silently.

**One thing is open, and it is the decision the plan reserved for a human.** Milestone 5's cost gate
has two thresholds. Gate 1 passes with room to spare. **Gate 2 fails, by 3.7x, and it cannot be made
to pass.** The remedy ladder was worked in order: remedy 1 was applied and kept (worth 25%, more than
the plan's estimated tenth), remedy 2 was evaluated and rejected, and **remedy 3 turned out not to
exist** — the plan proposed coalescing the repaint "the way find already coalesces its re-search",
and find does not coalesce its repaint at all. Once that is corrected the comparison reduces to a
group-count ratio, and the group count cannot come down: a twenty-row window of TypeScript genuinely
contains about sixteen distinct kinds of thing and the shipped theme genuinely gives them about
fourteen colours. **The premise the gate was calibrated on — "a handful" — is what the measurement
disproves.** The numbers, the reasoning and what it leaves open are under Milestone 5.

---

### The adversarial review of the implementation

Six lenses over the finished code — decoder correctness, layer correctness, the `rebuildStyleRules`
change, the capability plumbing, Milestones 0 and 1, and conformance to §C1–§C9 — with every finding
handed to an independent verifier told to refute it. **Five findings survived, covering four distinct
defects. All four are fixed, each with a test that fails on the pre-fix tree.**

1. **`high` — a layer that outlived its document kept painting into the next one.**
   `SemanticTokenLayerOwner` disposes a layer on a document change, so the shipped plugin path was
   safe — but `createSemanticTokenLayer` is public, and a caller holding one layer across a switch
   kept the previous file's spans painted *and* kept re-anchoring them, because a tracked range built
   against one piece table resolves against another to a live offset rather than to nothing. This is
   exactly what §C5's document check exists to prevent, reached from the side `push()` cannot see.
   `update()` now clears the painted state when the document underneath it changes.
2. **`high` — the capture specificity table was read by exact lookup while styles resolve by
   longest prefix.** The shipped queries only emit two-segment names, all of which are in the table,
   so nothing in this repo was affected. A grammar contributed through `registerLanguage` using the
   ordinary three-segment convention got the *inverse* of the intended rule: `keyword.declaration.function`
   fell below `variable` and lost its span to the one capture the table calls the fallback.
   `captureRank` now walks prefixes the way the style trie does.
3. **`medium` — a tuple that clamped away to nothing was counted as a zero-length tuple.** It is not
   one: it arrived with a real length and began past the end of the text, which almost always means
   the response describes a longer document than the `lineStarts` and `textLength` it was decoded
   against — a stale snapshot on the host's own side. Booking it under rule 4, whose documentation
   says such tuples "are common in the wild", tells the host to ignore the one signal pointing at its
   own bug. It is now counted under `pastEndOfDocument`, whose meaning is widened to both axes of the
   same failure.
4. **`low` — the capability builder's rationale was attached to the wrong declaration.** A private
   `type Writable<T>` sat between the JSDoc block and `semanticTokensClientCapability`, so the one
   export §C3 tells every host to call had no documentation on hover. Moved.

**What the review confirmed as sound**, having tried specifically to break each: the relative
5-tuple cursor advances correctly across every rejection path; bit 31 of the modifier set decodes
correctly despite `1 << 31` being negative in JavaScript (now pinned by a test); the overlap
truncation in `normalizeSpans` never emits a zero-length or inverted range; the `rebuildStyleRules`
version counter cannot produce a stale stylesheet — `sameHighlightStyle` compares a superset of what
`rangeHighlightRule` reads, and the shared-token flush happens before the early return; and
`serializeTokenStyle` still produces byte-identical output after the M0 table split.

---

## Verdict, up front

**Milestones 0 through 3 are unconditional and should be built.** M0 and M1 close two live,
reproducible defects with nothing to do with LSP — four capture rules that paint nothing at all, and
overlapping tree-sitter tokens that paint in an order nobody chose. M2 builds the real-TypeScript
test harness the package has never had. M3 is the plumbing that is, today, **the single hard blocker
on this entire feature**: `packages/lsp-plugin` never forwards a client-capability override to
`LspClient`, so no host using the shipped LSP plugin can declare `textDocument.semanticTokens` at
all, and no server will send tokens no matter what the host does. M3 also hands the host the first of
the two handles the seam needs and neither plan owned before Pass 4 — the `LspClient` itself; the
second, the `SemanticTokenLayer`, comes with M5.

**Milestones 4 through 7 — semantic tokens proper — are conditional on a human saying the gain is
wanted**, and the gain is now much larger than the previous version of this plan believed. See
*The re-scoping* below: the argument that "tree-sitter plus shiki already deliver most of the visible
colour" was measured against an example app with six grammars and one TypeScript worker. Against the
real consumer it inverts.

**The delta protocol is back on the table, but not as editor work.** The previous version de-scoped
it on the grounds that no host here runs an out-of-process server with its own token cache. That is
no longer true. It is still true that decoding and delta reassembly do not belong behind the paint
contract, and Contract §C7 says where they do belong and why.

Honest rating: M0 `S`, M1 `S`, M2 `M`, M3 `S`, M4 `M`, M5 `L`, M6 `S`, M7 `M`. Call M0–M3 `M` in
total and unconditional; M4–M7 `L`, `risk high`, because the largest milestone's cost can only be
validated against a real viewport and a real theme.

---

## The re-scoping

The previous version of this plan was written against one consumer: the example app in this repo,
with six tree-sitter grammars and a single in-process TypeScript worker. That consumer is not the
one that matters. The real consumer runs **37 language servers as separate processes over stdio**,
behind a proxy, over a WebSocket, and reaches this library through `createLanguageServerPlugin`
unforked. Two of the previous plan's load-bearing conclusions were reached against the wrong evidence
and are re-examined here rather than inherited.

### Claim 1: "tree-sitter plus shiki already deliver most of the visible colour, so the feature is incremental"

**Rejected. It inverts under the real consumer, and the inversion is the whole case for the feature.**

What this repo ships: `TREE_SITTER_LANGUAGE_CONTRIBUTIONS`
(`packages/tree-sitter-languages/src/index.ts:60-68`) is exactly seven entries — javascript, typescript,
html, css, json, markdown, markdown_inline — and `packages/tree-sitter-languages/src/grammars/` holds
exactly two `.wasm` files, both markdown; the rest arrive as npm dependencies. Ten `.scm` query files,
covering the same set.

What the real consumer paints with: those grammars for a handful of ids, and a TextMate/shiki list of
roughly thirty more. Beyond that list, files are painted **as plain text**. The languages with no
colour at all today include Zig, Typst, Nix, OCaml, Clojure, Haskell, F#, Julia, TeX, Gleam, Prisma
and Astro — every one of which has a server in the registry.

So the claim is false in two separate ways, and the second is much larger than the previous plan's
TypeScript-identifier caveat:

1. For roughly a dozen languages the editor delivers **no colour whatsoever**, and the language server
   is the *only* source of structure that exists. There is no incremental gain to argue about; there
   is a blank page versus a coloured one.
2. For the thirty TextMate languages the editor delivers keyword, string and comment colour with **no
   ability to resolve an identifier at all** — regex-grade colouring with no symbol table behind it.

The previous plan's sentence — *"it still holds for every other token kind and every other language we
ship"* — does not survive. It was true of the example app's six grammars and is false of the product.

**The consequence for sequencing is concrete and it flips the obvious target.** TypeScript is where
tree-sitter is strongest, so it is where semantic tokens prove the least and where the visible delta
is smallest. It is a bad first target, not a good one. The languages that have nothing today are the
ones that pay, and they are also the ones whose servers ship the most unusual legends — which is
exactly the stress the contract needs. This is a host-side sequencing decision and the product's plan
owns the ranked list; the editor-side consequence is that **nothing in this plan may assume the
TypeScript legend, or twelve types and six modifiers, or any fixed legend at all.** See §C3.

### Claim 2: "the delta protocol only pays when a server re-sends tokens for a large file per keystroke, which no host here has"

**Half reversed.** The *precondition* the previous plan named as absent is now present by name; the
*conclusion* about where the work goes changes, and the de-scoping from the paint contract stands for
a different and better reason.

The previous plan wrote: *"What would have to change: an out-of-process server, over a transport where
bytes cost something, that maintains its own token cache."* All three now hold. Several of the
registry's servers advertise `full: { delta: true }` and maintain exactly that cache, over stdio to a
separate process, behind a socket. That is the described workload, arrived by name.

Two things temper it, and both belong in the contract rather than in a milestone:

- **Delta is a minority capability.** The large majority of the servers in the registry cannot use it
  at all — either they offer full-only, or they offer no semantic tokens whatsoever. A contract whose
  spine is delta is wrong for most of the fleet. **Delta must be an optional branch on the request
  side, never a term the paint layer knows about.**
- **The cache and its invalidation cannot be split across the seam.** A `resultId` cache is only
  correct if whoever holds it can see every event that invalidates it. Contract §C7 states where it
  goes and lists the invalidating events, including two that are invisible from inside the editor.

### Three further premises that do not survive

- **"Cancellation can only suppress an already-computed response."** That was a fact about an
  in-process worker with one message loop, where a `$/cancelRequest` arrives a macrotask after the
  synchronous walk has finished. Over stdio to a separate process it is simply false:
  `LspClient.abortRequest` sends `$/cancelRequest` on the wire
  (`packages/lsp/src/client.ts:501-508`), and a server that honours it abandons real work. The
  de-scoping of interruptible classification was worker-specific. Cancellation is now a live term of
  the contract — §C8.
- **"The legend is twelve types and six modifiers."** The legend is a property of whichever server
  answered, arrives in that server's `initializeResult`, and is **index-addressed, not a set** — real
  legends ship the same name at several indices. A decoder that inverts a legend into a name→index map
  is wrong. §C3 and Milestone 4.
- **"`augmentsSyntaxTokens` is a client fact."** It is a per-language fact here, because whether the
  editor already has syntactic colour for a file depends on whether a tree-sitter grammar or a shiki
  grammar was registered for that language id — which the host knows and the editor does not, at the
  point the capability is declared. §C3 hands it to the host, deliberately.

---

## The contract — `SemanticTokenLayer`

**This is the seam. The consuming product's plan references this section by name and cites its terms
as `Contract §C1` … `§C9`. Nothing here may be restated differently in either document.**

**`§C1`–`§C9` is the canonical numbering and this file is where the terms are defined.** The
consuming product's plan cites these ids and **does not restate their terms**; where it needs to
record a product-only consequence of a term it does so as commentary under that id, marked as
consequence rather than definition. Restatement is what let the two documents drift once already —
see *Pass 4* in the Review. A tenth term is added as a sub-term of an existing id, never as a `§C10`.
**Every term below opens by naming its owner, and the *Contract at a glance* tables at the end of this
section list every term and every disputed sub-term with its owner and, where the owner is the editor,
the milestone that delivers it.** A reader of either document should be able to answer "whose
deliverable is this?" without opening the other.

The contract has one governing idea. **The editor paints decoded spans; it never speaks LSP.** No
legend crosses it, no 5-tuples, no `resultId`, no `SemanticTokensDelta`, no document URI, no
capability object. The host does every piece of protocol work and hands the editor a plain array of
absolute offsets with names on them.

That line is drawn at the **paint layer**, not at the repository boundary. The editor repo ships two
things at two different levels, and it matters that both plans hold them apart:

- **The paint layer** — `SemanticTokenLayer` in `packages/editor`. Knows nothing about LSP. This is
  the contract. Everything below is a term of it.
- **One request-side artifact, and it is a function rather than a controller** —
  `decodeSemanticTokens` in `packages/lsp-plugin` (§C7, Milestone 4). It ships in this repo, **it is
  on the host's side of the contract even though it lives in this repo**, and it is the *only* decoder
  either plan may build. Everything else on the request side — when to ask, what to ask for, caching,
  delta, throttling, cancellation — is the host's own code. **The editor ships no
  `SemanticTokensController`.** Earlier drafts named one here and no milestone ever scheduled it, so
  Pass 4 cut it rather than let the contract name an artifact nobody builds. The shape to copy is
  `packages/lsp-plugin/src/documentHighlightController.ts` (§C8), and the host writes it.

### §C1 — What the host hands the editor

**Owner: the editor defines every type in this term; the host builds the values.** The declarations
below are the single source of truth for the payload, the demand request and the push verdict. A
field spelled differently in any other document is a defect in that document, not a synonym.

One array of spans, in one push, with a version stamp.

```ts
export type SemanticTokenSpan = {
  /** Absolute offset into the document text, UTF-16 code units, inclusive. */
  readonly start: number
  /** Absolute offset, UTF-16 code units, exclusive. */
  readonly end: number
  /** The legend NAME, already decoded by the host. Never an index. */
  readonly tokenType: string
  /** Legend NAMES, already decoded from the modifier bitset. Order is not significant. */
  readonly tokenModifiers?: readonly string[]
}

export type SemanticTokenPayload = {
  /** Must equal the active document's `EditorViewSnapshot.documentId` (`plugins.ts:215`). */
  readonly documentId: string
  /** The editor `textVersion` these spans describe. See §C5 — this is the correlation key. */
  readonly textVersion: number
  readonly spans: readonly SemanticTokenSpan[]
}

/** The demand signal, §C8. Editor → host. Carries no document URI: see below. */
export type SemanticTokenRangeRequest = {
  readonly documentId: string
  readonly textVersion: number
  /** Absolute offset, UTF-16, inclusive — `snapshot.visibleRows[0].startOffset`. */
  readonly start: number
  /** Absolute offset, UTF-16, exclusive — `snapshot.visibleRows.at(-1).endOffset`. */
  readonly end: number
}

export type SemanticTokenDropReason = 'version-too-old' | 'version-ahead' | 'document-changed'

/** The verdict `push()` returns synchronously, §C5. The host must read it. */
export type SemanticTokenPushResult =
  | {
      readonly status: 'painted'
      /** 0 when the stamp was current; n when the spans were projected through n edits. */
      readonly projectedThroughEdits: number
      /** Spans that reached a highlight group. */
      readonly paintedSpans: number
      /**
       * Distinct `tokenType` names that resolved to no style and no alias, so their spans painted
       * nothing (§C4). Empty in the healthy case. This is the only signal a host has that a
       * server's custom legend is falling on the floor.
       */
      readonly unresolvedTypeNames: readonly string[]
    }
  | { readonly status: 'dropped'; readonly reason: SemanticTokenDropReason }
```

**The payload and the demand request are both keyed by `documentId`, and neither carries a document
URI.** `documentId` is `EditorViewSnapshot.documentId` — an editor-side identity with no LSP meaning.
Mapping it onto a `textDocument.uri` is host work, on the host's side of the seam, in both directions.
A demand request carrying a URI would be the editor speaking LSP, which the governing idea forbids,
and it would be wrong as well as forbidden: one editor document can be open against a pooled backend
several tabs share, so the URI is the pool's fact and not the document's.

**Names, not indices.** This is the term most likely to be got wrong on one side and not the other.
The legend is per-server, index-addressed, and legends are not sets — real servers ship the same name
at several distinct indices, and at least one server computes its legend as the intersection of its
own token types with the ones the *client* declared. If the editor took indices it would need the
legend, and the legend is host data by §C3. Handing names means the index→name decode happens exactly
once, on the host side, **by index**, and the editor never has an opportunity to get it wrong.

**Normalisation the editor performs, so the host does not have to.** Spans may arrive in any order.
The editor sorts by `start`, drops zero-length spans, and clamps to the document length — the same
defences `setRangeHighlight` already applies to range input
(`packages/editor/src/virtualization/virtualizedTextViewHighlights.ts`, the clamp and the
zero-length drop inside `sortedRangeHighlights` / `addMountedRangeHighlightRangesForRow`). Server data
is untrusted input and both sides treat it that way.

**Overlaps are not supported.** LSP's `overlappingTokenSupport` defaults to false and the editor does
not honour it: where two spans overlap, the later one by `start` wins and the earlier is truncated.
**The host must not declare `overlappingTokenSupport: true`** — see §C4 on why declaring a flag the
client cannot honour is a protocol lie a real server acts on. It follows that **the host is not
required to sort, de-duplicate or de-overlap before pushing, and must not assert that it has.** The
editor normalises unconditionally (above); a host-side claim of "spans sorted, non-overlapping" is an
assertion about untrusted server data that no server guarantees and neither side checks.

**Multi-line spans are supported**, because the paint layer takes offsets and paints across mounted
rows. **Ownership of `multilineTokenSupport` was split, and the gate is now open.** The *gate* was the
editor's: `semanticTokensClientCapability()` refused the flag until Milestone 5's multi-line exit
criterion passed. It passes — a semantic span crossing a newline paints across two mounted rows, in
`packages/editor/test/semanticTokenPaintOrder.test.ts` — so the builder accepts the flag and emits
the key when asked. The *declaration* remains the host's, per §C3, and stays opt-in rather than
default-on: it is a statement about the host's own pipeline as much as the editor's, and a host that
re-derives spans from `{line, character}` pairs may not be able to honour it even though the layer
can. A host that declares nothing gets no key, and absent is what the wire means by false.

Multi-line *decoding* is a separate question that never needed the capability: it is asserted over a
literal 5-tuple array in Milestone 4.

### §C2 — Coordinate space

**Owner: the editor defines the unit; the host converts into it before pushing.** Confirmed identical
in both documents by Pass 4 and deliberately left untouched by it.

**Absolute offsets into the document text, in UTF-16 code units, `start` inclusive and `end`
exclusive.** Not LSP `{line, character}`. Not UTF-8 bytes. Not row-relative.

The client already declares `general.positionEncodings: ['utf-16']`
(`packages/lsp/src/capabilities.ts:28-30`), UTF-16 code units are JS string indices, and the editor's
paint APIs take offsets. A 5-tuple therefore decodes to an absolute offset with no encoding
conversion at all, and the conversion helper the host needs already exists —
`lspPositionToOffsetInSnapshot` (`packages/lsp/src/positions.ts:33`) is one of eleven exports from
that module; `lineStartForSnapshotLine` and `rowForOffset` are **not** exported, do not reach for
them.

If a future host negotiates a different `positionEncoding`, the conversion is that host's problem and
happens before the payload is built. The contract's unit does not change.

### §C3 — Who owns the legend, and who declares the capability

**Owner: the host, for both. The editor has no API that accepts a legend, never sees one, and declares
no `textDocument.semanticTokens` block of its own. The editor's entire deliverable under this term is
three pass-throughs and one builder, all in Milestone 3.** This is the term Pass 4 found each plan had
assigned to the other, which is why the division of labour below is written out piece by piece with no
gap left in it.

Four independent reasons, each fatal on its own:

1. The legend arrives in a specific server's `initializeResult` and differs per server. There are
   dozens of servers behind one editor.
2. Legends are index-addressed and contain duplicate names. Only a decode *by index* is correct, and
   the decode happens once, host-side, before §C1.
3. At least one server computes its advertised legend as the **intersection** of its own token types
   with the `tokenTypes` array the client declared. The declared client capability is therefore an
   *input to the server*, not merely a local decoding table — which makes the legend a negotiated
   property of a connection, and connections are host-owned.
4. In the real deployment, backends are pooled and shared across editor tabs, and the first
   connecting client's `initializeResult` is cached and replayed to later ones. **The legend is a
   property of the pooled backend, fixed by whichever tab connected first.** No per-editor object can
   own it.

**Corollary, and it is load-bearing. The capability block: who builds it, from what, at what
granularity.**

- **The editor builds no block and bakes no default.** `defaultClientCapabilities()`
  (`packages/lsp/src/capabilities.ts:27-84`) declares **no** `textDocument.semanticTokens` block, and
  Milestone 3 asserts that it still does not. The editor cannot know whether a given host paints
  tokens at all, so a default here would make every server in a fleet compute tokens nobody draws.
- **The editor ships the builder, and its job is to prevent a lie.**
  `semanticTokensClientCapability(options)`, exported from `packages/lsp` (Milestone 3), produces a
  block that declares **exactly** what the shipped decoder honours and nothing more: it cannot express
  `overlappingTokenSupport: true` (§C1), it does not offer `dynamicRegistration` at all (below), and
  it accepts `multilineTokenSupport` only because Milestone 5's exit criterion for it now passes
  (§C1) — before that it refused the flag.
- **The editor ships the pass-through.** `capabilities` and `clientInfo` reach `LspClient` through
  `LspConnectionOptions` **and both plugin option types** (Milestone 3). None of that exists today,
  which is the blocker.
- **The host calls the builder and passes the result in.** Choosing `tokenTypes`, `tokenModifiers`,
  `requests` and `formats` is host work, because reason 3 above makes the declared block an *input to
  the server* and therefore a property of a connection, and connections are host-owned.
- **The host also decides the granularity at which a block is built, and it is not per editor tab.**
  Reason 4 is the constraint: backends are pooled and the first connecting client's `initializeResult`
  is replayed to later ones, so two tabs declaring different blocks against one pooled backend both
  silently get whichever block connected first. The host must therefore build a block that is
  byte-identical for every client of a given pooled backend, and **the invariant test that it is
  belongs to the host's plan**, because only the host knows what its pooling key is.
- **`augmentsSyntaxTokens` is the host's, answered per server rather than per client**, because
  whether the editor already has syntactic colour for a file depends on which grammar the host
  registered for that language id — which the host knows and the editor does not, at the point the
  capability is declared.
- **`clientInfo.name` is load-bearing and the host chooses the value**: at least one server branches
  on it and disables the `full` request for clients identifying as a particular editor. The editor
  passes it through (Milestone 3) and picks nothing.
- **A host that hand-writes its own block instead of calling the builder is free to, and owns the
  consequences.**

**`dynamicRegistration` is de-scoped on both sides, deliberately, and this is the one place that says
so.** Declaring it makes several servers return **no provider at all** from `initialize`, expecting to
register later via `client/registerCapability` — and *nothing in either plan will ever answer that
request*: the editor's `LspClient.handleRequest` (`packages/lsp/src/client.ts:483-489`) answers every
inbound server request with method-not-found, and in the real deployment the proxy answers
`client/registerCapability` itself with `null` and never forwards it. An earlier draft of this plan
proposed an inbound request seam to fix the editor's half; Pass 4 cut it, because the half the
transport owns is de-scoped in the product's plan and half a route is a seam that ships dead.
**Consequence, stated plainly so that neither plan waits for the other: a server that registers
`semanticTokensProvider` only dynamically is invisible to this feature, and the builder will not let a
host claim otherwise.**

**The host needs a handle on the client to do any of this, and today the narrow factory gives it
none.** `LanguageServerConnectionContext` — `{ client: LspClient, workspace: LspWorkspace }`,
`packages/lsp-plugin/src/plugin.ts`, already exported from that package — reaches a host only through
`onConnectionCreated` / `onConnected`, and those exist on `LanguageServerAdapterPluginOptions` alone
while the real consumer uses `createLanguageServerPlugin`. **Exposing them on
`LanguageServerPluginOptions` and forwarding them is an editor deliverable, in Milestone 3, alongside
the capability plumbing.** The other plan may assume the handle exists and cites that milestone for
it.

### §C4 — Who resolves a token type to a style

**Owner: the editor, for the resolver, the vocabulary, the theme and the colour ids (Milestone 4). The
host owns the `scopeAliases` table it feeds in, because that table is per server.**

**The editor.** The host hands names; the editor maps `tokenType` plus `tokenModifiers` to a scope
string, and the scope string to a `VirtualizedTextHighlightStyle`, through the same longest-prefix
scope trie the tree-sitter path already uses — `createEditorScopeStyles`
(`packages/editor/src/theme.ts:529`), whose single consumer today is
`packages/editor/src/syntax/captures.ts:70`.

The reason is not preference. The theme is the editor's, the registered colour ids are the editor's
(`registerEditorColor`, `editorColorValue`, `editorColorReference`, `firstEditorColor` are exported
from `packages/editor/src/index.ts:99-105`), and a host that resolved styles itself would produce
semantic colour that drifts from the tree-sitter and shiki colour in the same document. One resolver,
one theme, one set of colour ids.

Three sub-terms:

- **The standard vocabulary is the editor's.** `EditorSyntaxThemeColor` (`theme.ts:4-21`) is a closed
  union of seventeen ids and covers only a fraction of LSP's standard token types. Milestone 4 owns
  registering the rest, with `editorColorReference` defaults so an undeclared theme still looks
  deliberate.
- **Server-specific names are the host's, expressed as aliases.** A host may supply a
  `scopeAliases: Record<string, string>` mapping a server's custom type name onto a scope the theme
  knows. The editor ships the pass-through and the `null` fall-through (Milestone 4) and **ships no
  per-server table, ever** — there are dozens of servers and their legends run to fifty-plus custom
  names each. **Populating it is host work, per server, and at product scale it is not optional**: a
  server whose legend is fifty-seven types of which thirty-eight are non-standard paints the standard
  nineteen and drops the rest until someone writes its aliases. Which servers get a table first, and
  what goes in it, is ranked in the product's plan and nowhere here.
- **An unresolved name paints nothing — and says so.** If a type name resolves to no rule at any
  prefix and has no alias, the span is dropped and the syntactic layer shows through unchanged.
  Falling through to tree-sitter colour is strictly better than painting a wrong colour, and it is
  what makes an unknown legend safe. **It is also indistinguishable from success by eye**, which is
  how a plan can "open a file and see semantic colour" while two thirds of a legend is on the floor.
  So the drop is reported rather than silent: `push()` returns the distinct unresolved names in
  `SemanticTokenPushResult.unresolvedTypeNames` (§C1), and **surfacing them is the host's**, because
  the host is the side that knows which server produced them and where its diagnostics go.

**No font properties, ever.** Highlight pseudo-elements do not apply them. The resolved style is a
`VirtualizedTextHighlightStyle` (`virtualizedTextViewInternals.ts:47-55`): `backgroundColor`, `color`,
`textDecoration`, `zIndex`, and nothing else. Milestone 0 establishes this on the token side; the
semantic layer may not reintroduce it.

### §C5 — Versioning, and what happens to tokens for a document version that has moved

**Owner: the editor decides and reports (Milestones 5 and 6); the host stamps the version and
implements the resync branch.** Pass 4 confirmed both documents already agreed on the key itself.

**The correlation key is the editor's own `textVersion`. Never the LSP document version.**

This is the term most likely to be wrong on both sides at once, so the reason is recorded in full.
In the real deployment, LSP document-version identity is broken across the wire: the proxy rewrites
the client's `version` on every `didOpen` and `didChange` to a counter of its own
(`apps/server/src/lsp/proxy-session.ts`, `handleDidChange` → `document.backendVersion += 1` →
`rewriteDidChangeVersion`), and strips the `version` field from `publishDiagnostics` before broadcast
(`serverNotificationForClient`). A token response cannot be correlated to a client-side document
version through anything the protocol currently carries. The editor's own version check on diagnostics
(`packages/lsp-plugin/src/documentSync.ts`, `publishDiagnostics`, `diagnostics.version !== active.lspVersion`)
only passes today because the field it compares has been deleted, which makes the check vacuous.

So the contract routes around every number the proxy touches:

> **The host records `EditorViewSnapshot.textVersion` at the moment it issues the request, and stamps
> that same number on the payload it pushes back. The editor compares it against the current
> `textVersion` and takes exactly one of four branches.**

| Stamped `textVersion` vs current | Editor's action | Reported as |
| --- | --- | --- |
| Equal | Paint as given. | `{ status: 'painted', projectedThroughEdits: 0 }` |
| Older, and `snapshot.editsSinceTextVersion(stamped)` returns edits | Project every span through those edits with the bias pair from §C6, drop spans whose text is gone, paint the rest. | `{ status: 'painted', projectedThroughEdits: n }` |
| Older, and `editsSinceTextVersion` returns `null` | Drop the whole payload. Fire `onResyncRequired('version-too-old')`. | `{ status: 'dropped', reason: 'version-too-old' }` |
| Newer than current, or `documentId` is not the active document | Drop the whole payload. Fire `onResyncRequired(...)`. | `{ status: 'dropped', reason: 'version-ahead' \| 'document-changed' }` |

`editsSinceTextVersion` is an optional member of `EditorViewSnapshot`
(`packages/editor/src/plugins.ts:224`) backed by `DocumentEditChain`, which keeps `MAX_ENTRIES = 128`
transitions (`packages/editor/src/editor/editChain.ts`) and returns `null` for a chain that is broken
or too old. **The 128-entry limit is why the third branch exists and is not hypothetical**: a slow
cold server plus fast typing reaches it. A host must implement the resync branch.

`push()` returns its verdict synchronously rather than swallowing it, because a host that cannot see
its payload was dropped will sit on a stale `resultId` forever. **A host that ignores the return value
is not conformant.** The fourth branch is also why `documentId` cannot be dropped from the payload:
**it is a term of §C1, not a convenience.** With pooled backends and a shared root, a response
arriving after the user switched documents is an ordinary path, and a payload that cannot name its
document paints the previous file's spans onto this one.

**A drop does not clear what is already painted, and neither does a resync.** The editor keeps the
last good paint anchored through §C6 until a newer payload replaces it; `clear()` is a separate,
explicit call the host makes when it wants the layer empty. This matters because the alternative is
visible: Milestone 6's exit criterion asserts that semantic colour never disappears wholesale and
reappears, and a host — or a plan — that answers every drop by clearing the layer produces exactly
that flicker.

### §C6 — Anchoring, and the bias pair

**Owner: the editor, entirely (Milestone 6). The host has no deliverable under this term, and must not
project spans itself before pushing — §C5's second branch is the editor's job and the bias pair below
is the reason it has to be.**

Between the request and the response the text has moved, and the spans describe where it was. The
editor holds painted spans as piece-table anchors through `context.trackRanges(ranges, bias)`
(`packages/editor/src/plugins.ts:310-313` → `Editor.trackDocumentRanges`, `Editor.ts:2380`), resolving
them on every content update; `resolveTrackedRanges` (`Editor.ts:2398`) drops any span whose text is
gone, which is exactly right for a deleted identifier.

**The bias pair is `{ startBias: 'right', endBias: 'left' }`, and the reason is recorded here so
neither plan re-derives it differently.** A semantic span describes a symbol the server has already
classified. A character typed immediately before an identifier is not part of it; a character typed
immediately after it changes what the identifier *is*, and the server has not been asked yet. Holding
the span to what the server actually described — kept and shrunk rather than grown — means the new
character shows syntactic colour for one request window instead of showing semantic colour the server
never granted it. This is the same reasoning and the same pair the diagnostics path already records
for the same window (`packages/lsp-plugin/src/diagnosticProjection.ts`, `DIAGNOSTIC_STICKINESS`); the
two are deliberately consistent.

The default `trackDocumentRanges` gives an unnamed caller is `{ startBias: 'left', endBias: 'right' }`
— "a region of the document" (`Editor.ts:2376-2385`). **The semantic layer must name its pair
explicitly and not inherit the default.**

Anchors are a property of the buffer, so batch edits, multi-cursor edits, a formatter response and a
Replace All all resolve correctly — which single-edit token projection cannot do.

### §C7 — Where decoding and the delta cache live

**Owner: the host runs both. The editor ships the decoder — one implementation, in
`packages/lsp-plugin`, Milestone 4 — and owns nothing else under this term.** Pass 4 confirmed both
documents already agreed on where the *cache* goes; they had each specified a *decoder*.

**On the request side of the seam. Never behind the paint layer.**

The paint layer has no `resultId`, no previous array, no splice, and no concept of a delta. It takes
decoded absolute spans (§C1) and that is the whole of its input. This is not squeamishness about
complexity; it is a correctness requirement, and there are three reasons:

1. **The cache's lifetime is the connection's, and the editor's document lifetime is not.** In the
   real deployment an inactive tab has its language-server plugin torn down and its socket closed,
   while the document stays open in the editor; the connection is rebuilt on focus. A cache living
   behind the paint layer would outlive the `resultId` it is keyed by and offer a delta base the
   server has already forgotten — or, worse, that a *different* pooled backend never knew.
2. **Delta is a minority capability.** Most servers in the registry cannot use it. A paint contract
   that carried delta terms would make every full-only server pay for a branch it can never take.
3. **The invalidating events are not all visible from inside the editor.** Two of them are structural:
   a second tab on the same pooled backend opening the same file causes the proxy to reconcile with a
   full-text `didChange` this tab never hears about, silently invalidating its `resultId`; and idle
   disposal of the backend after a timeout discards the server's own token cache and every `resultId`
   in it. **Whoever holds the cache must be able to observe every event that invalidates it — so the
   cache and its invalidation trigger may not be split across the seam.** A host that runs the cache
   in the browser must be given an explicit invalidation call by whatever *can* see those events. A
   host that runs the cache next to the proxy and always hands the browser full arrays is equally
   conformant, and the paint layer cannot tell the difference. **That choice is the product plan's to
   make and this plan does not make it.**

**There is exactly one decoder and the editor ships it**: `decodeSemanticTokens(data, legend, …)`,
exported from **`packages/lsp-plugin`** (Milestone 4). That package is the request side of the seam
even though it lives in this repo, so the decoder sits on the host's side of the paint boundary while
still having one implementation and one test suite. **The host calls it and does not write its own.**
Shipping it is not the same as owning it: it runs on the host's side of the seam, on the host's
schedule, against the host's legend.

**The decoder reports what it discarded; the host is the consumer that logs it.** A rejection rule that
drops a tuple silently is indistinguishable from a server that sent fewer tokens, so
`decodeSemanticTokens` returns **`{ spans, drops }`** — a count per rejection rule — rather than a bare
array. This is the same fix `unresolvedTypeNames` already is for the *style* drop (§C4), applied to the
*decode* drop: the editor makes the loss countable, and the host decides what to do with the count.
**The return type is declared in Milestone 4 and nowhere else**, and any "counted and logged once per
session per server" policy is the host's, built on these numbers — the editor logs nothing and
aggregates nothing, because it does not know what a session or a server is.

This is not tidiness. The relative 5-tuple cursor is stateful and its rejection rules are the kind
that produce *plausible wrong offsets* rather than exceptions — a second implementation that drops an
out-of-legend tuple without advancing the cursor corrupts every span after it and still paints
something. Pass 4 found the decoder specified in both plans, the second copy having kept rule 2's drop
and lost its advance. **Milestone 4 owns the exit criteria for all five rules**, including the
one-fixture test that proves the cursor advances across dropped tuples; no other document restates
them.

### §C8 — Throttling, cancellation, and the demand signal

**Owner: the host, for all of it, including the one throttling number. The editor supplies the demand
signal and the primitives, and names no milliseconds anywhere in this term.**

- **Demand.** The editor fires `onRangeNeeded(request: SemanticTokenRangeRequest)` — the type is
  declared in §C1 — when the visible offset range changes. The offsets come from the snapshot the
  editor already has: `snapshot.visibleRows[0].startOffset` through `visibleRows.at(-1).endOffset`
  (`plugins.ts:239`), which is what the editor's own syntax controller already does for window parses.
  `'viewport'` is a real update kind (`plugins.ts:327`) fired from `Editor.handleViewportChange`
  (`Editor.ts:2742`) **once per scroll event, un-throttled**, so a signal with no delay on it is one
  per frame during a flung scroll.
- **The editor guarantees exactly two things about this signal, and neither of them is a policy.**
  First, it fires at most once per `'viewport'` update — never once per row, per span, or per frame
  within one update. Second, if the host supplies `viewportDelayMs`, the editor honours it as a
  trailing debounce and coalesces everything inside the window into one call. **There is no default:
  unset means zero, and zero means the editor adds no delay of its own.**
- **The number is the host's, and there is only one of it.** This is a Pass 4 decision rather than a
  preference. The editor cannot measure what it does not run; the host is the side that measured real
  servers over real stdio; and two debounces stacked on one signal is a latency that neither plan
  budgets and neither plan would own. So **the host picks the delay, states it in its own plan, and
  passes it as `viewportDelayMs`.** An earlier draft of this file shipped a 120 ms default and called
  it "a floor, not a policy", which was untrue the moment it exceeded the host's own number. **A
  millisecond figure for the viewport signal appearing in this plan again is a defect.**
- **Policy is the host's.** Whether to answer a demand with a range request, a full request, a
  full/delta request, or nothing at all; how long to wait; whether to answer at all for a server that
  blocks on indexing — all host. The editor does not know which servers offer `range`, and the split
  across the registry is real: some offer full and range, some full only, some none.
- **Cancellation is real and it is the host's to fire.** `LspClient.abortRequest` sends
  `$/cancelRequest` on the wire (`packages/lsp/src/client.ts:501-508`), driven by an `AbortSignal` in
  `RequestOptions` or by `requestHandle().cancel()`. It survives the proxy, which remaps the request
  id and forwards it. This is not response suppression — a server that honours cancellation abandons
  real work.
- **The default request timeout is wrong for this and the host must override it.**
  `LspClientConfig.timeoutMs` defaults to **3000 ms** (`packages/lsp/src/client.ts`, `this.timeoutMs =
  config.timeoutMs ?? 3000`), and a cold server on a large project will exceed that on its first
  answer. `RequestOptions.timeoutMs` overrides per request; the host sets it.
- **All three primitives need the client, and reaching it is an editor deliverable, in Milestone 3.**
  `abortRequest`, `RequestOptions.signal` and per-request `timeoutMs` are all methods on `LspClient`,
  which a host using the narrow `createLanguageServerPlugin` factory cannot reach today. §C3 names the
  fix and the milestone.

The house shape for all of this already exists and should be copied rather than reinvented:
`packages/lsp-plugin/src/documentHighlightController.ts` is 137 lines carrying a 150 ms debounce with
`cancel()` on every input, a capability gate, a per-request `AbortController`, and a three-part
staleness check (`requestId`, `disposed`, and `ActiveDocument` identity). **Copy its five parts; do
not copy its update-kind filter** — `if (kind !== 'selection' && kind !== 'content') return` is a
question about the caret, and semantic colour is a question about the visible text.

### §C9 — How the host reaches the layer, and how the editor tells it to stop

**Owner: the editor creates the layer, hands it over, and fires the signals (Milestone 5, plus the
notification pass-through in Milestone 3); the host holds the handle and responds to all three
signals.**

**The handle comes first, because Pass 4 found that neither plan created one.** `SemanticTokenLayer`
is created by the editor's LSP plugin, inside the view contribution that gives it a viewport, a
snapshot and a lifecycle — a host cannot construct one itself and get those. So the plugin hands it
out: **both plugin option types gain a `semanticTokens` block (Milestone 5)** carrying the layer's
options from §C1, §C4 and §C8 plus a callback that receives the layer when it is created, in the house
shape `onConnectionCreated` already uses — the callback may return an `EditorDisposable` and the
editor disposes it with the layer. Supplying the block is what makes the plugin create a layer at all,
so a host that paints no tokens pays nothing. A host with no plugin can still implement §C1 over
`Editor.setRangeDecorations` (channel D below), at the cost of doing its own scope resolution.

Three signals, and the host must implement all three.

1. **Disposal.** `SemanticTokenLayer` is an `EditorDisposable`. Disposing clears every highlight group
   it owns. The plugin contribution's own lifecycle already drives this: a document change, a language
   change or a torn-down connection disposes the contribution. **The host's correct response to
   disposal is to stop requesting, drop its cache, and drop its reference to the layer** — see §C7
   reason 1.

   **A layer never spans two documents or two language ids, and this sentence is the canonical
   statement of its lifetime.** The layer is scoped to the contribution that created it, so a document
   or language change disposes both; the handle the host is holding is dead from that moment, and the
   replacement arrives as a *new* layer through a fresh `onLayer(layer, {documentId, languageId})`
   call carrying the new identity (M5). It follows that **`clear()` across a document change is dead
   code, not a reset** — the groups are already gone, and the handle it would be called on is
   disposed. A plan that models one long-lived layer cleared between documents is describing a
   different editor; where the two documents differ on this, this term governs.
2. **Resync.** `onResyncRequired(reason)` fires when the editor has dropped a payload and cannot
   recover by projection: `'version-too-old'` (the edit chain could not reach the stamped version),
   `'document-changed'`, `'version-ahead'`. **The host's correct response is to discard any `resultId`
   and issue a full, non-delta request.** A host that answers a resync with a delta request is
   incorrect and the editor cannot detect it.
3. **Demand ceasing.** No `onRangeNeeded` for a region means the editor is not painting there. It does
   not mean the host must forget it. There is deliberately no "release" signal in the contract:
   LSP's `releaseDocumentSemanticTokens` is a server-cache concern on the far side of the transport,
   and inventing an editor-side echo of it would put a protocol term behind the paint layer for no
   gain.

**What the contract does not carry, stated so neither plan invents it.**
`workspace/semanticTokens/refresh` is a server→client *request*, and **the request route is de-scoped
on both sides.** The editor's `LspClient.handleRequest` answers every inbound server request with
method-not-found (`packages/lsp/src/client.ts:483-489`) and will keep doing so; the real deployment's
proxy answers this one `-32601` and never forwards it. An earlier draft of this plan built an inbound
request seam for it, and Pass 4 cut it: the transport half is de-scoped in the product's plan, so the
seam would have shipped with no consumer on the transport that matters. §C3 records the identical
outcome for `client/registerCapability`.

**The route that can exist is a notification, and its plumbing is split with both halves named.** A
transport may downgrade the server's request into a client-bound *notification*; whether it does, and
what that notification is called, is the product plan's decision and its deliverable. **The editor's
half is that a host can register a handler for it at all**, and today it cannot:
`LspClientConfig.notificationHandlers` exists (`packages/lsp/src/client.ts`), but
`LspConnection.createClient()` hardcodes a single entry for `textDocument/publishDiagnostics` and
`LspConnectionOptions` exposes no way to add another. **Merging host-supplied notification handlers
through both plugin option types is an editor deliverable, in Milestone 3, part one** — the same shape
as the capability gap, and the only half of refresh this plan owns. It is *part one* of that milestone,
not part three: part three is `semanticTokensClientCapability()`, and a citation of "M3 part three" for
a refresh handler is pointing at the capability builder.

**Nothing about refresh reaches the paint layer.** There is no refresh trigger, no fourth demand
reason, no new callback and no new drop reason. On receipt the host calls `layer.clear()` and issues a
fresh request, which is `onResyncRequired`'s counterpart in the other direction and was already the
contract term. Until the transport half lands, a host that needs invalidation triggers it from its own
events in exactly the same way.

### Contract at a glance

Every row names the side whose plan owns the deliverable. Where the owner is the editor, the milestone
that delivers it is named in bold; where it is the host, the deliverable is described in the product's
plan and not here.

| Term | Editor's deliverable | Host's deliverable |
| --- | --- | --- |
| §C1 payload, demand and verdict types | **defines all four types**; normalises, sorts, drops zero-length, clamps, truncates overlaps (**M5**) | builds the values, decoded, names not indices; reads the verdict |
| §C2 coordinate space | defines the unit: absolute UTF-16 offsets | converts before pushing |
| §C3 legend and capability | never sees a legend; `semanticTokensClientCapability()`, the `capabilities`/`clientInfo` pass-through and the client handle (**M3**); **no block in `defaultClientCapabilities()`** | owns the legend; **calls the builder and passes the block in**; picks its granularity and owns the invariant test; answers `augmentsSyntaxTokens` per server; chooses `clientInfo.name` |
| §C4 type → style | resolver, vocabulary, colour ids, `scopeAliases` pass-through, `null` fall-through (**M4**); reports `unresolvedTypeNames` (**M5**) | **supplies `scopeAliases`, per server**; surfaces the unresolved names |
| §C5 versioning | compares the stamped `textVersion`, projects or drops, reports the verdict (**M5**, **M6**) | stamps it; implements the resync branch; does not `clear()` on a drop |
| §C6 anchoring | holds spans as anchors, `{startBias:'right', endBias:'left'}` (**M6**) | — (must not pre-project) |
| §C7 decode + delta cache | **the one decoder**, `decodeSemanticTokens` in `packages/lsp-plugin`, with all five rejection rules and their tests, returning `{spans, drops}` (**M4**) | calls it; owns the cache **and** its invalidation; **reads `drops` and owns any logging policy**; **writes no second decoder** |
| §C8 throttle + cancel | demand signal coalesced per viewport update, honouring a host-supplied `viewportDelayMs`; `AbortSignal` plumbing (**M5**); the client handle (**M3**) | **all policy, including the one debounce number**; sets `timeoutMs`; fires cancellation |
| §C9 handle + teardown | creates the layer and hands it over through the `semanticTokens` plugin block (**M5**); `dispose()`, `onResyncRequired`; merged `notificationHandlers` (**M3**) | holds the handle; stops requesting, drops the cache and the reference; on refresh calls `clear()` and re-requests |

The sub-terms Pass 4 found floating, each with the owner it now has and where that is stated:

| Sub-term | Owner | Stated in |
| --- | --- | --- |
| `textDocument.semanticTokens` block: content and granularity | host | §C3 |
| `augmentsSyntaxTokens` | host, per server | §C3 |
| `multilineTokenSupport` — the gate | editor (**M3** builder, **M5** criterion) — **open** | §C1 |
| `multilineTokenSupport` — the declaration | host, opt-in now the gate is open | §C1, §C3 |
| `overlappingTokenSupport` | neither: unexpressible by construction | §C1, §C3 |
| `dynamicRegistration` / `client/registerCapability` | **de-scoped on both sides** | §C3 |
| `workspace/semanticTokens/refresh` — request route | **de-scoped on both sides** | §C9 |
| `workspace/semanticTokens/refresh` — notification route | host, except the `notificationHandlers` pass-through (editor, **M3**) | §C9 |
| `scopeAliases` table contents | host, per server | §C4 |
| The viewport debounce number | host, and there is exactly one | §C8 |
| The decoder | editor ships it (**M4**), host calls it | §C7 |
| The decoder's drop counts | editor returns them (**M4**), host logs them | §C7 |
| The `LspClient` handle | editor exposes it (**M3**) | §C3 |
| The `SemanticTokenLayer` handle | editor creates it and hands it over (**M5**) | §C9 |
| The request-side controller | host writes its own; **the editor ships none** | preamble, §C8 |

### One structural limit both plans must state in the same words

**Semantic colour will never reach the minimap, sticky scroll or the diff panes.** Those views hold
their own `VirtualizedTextView` instances and read colour from `snapshot.tokens` through
`createEditorSecondaryViewProjection().syntaxColors.tokens`
(`packages/editor/src/public/secondaryViews.ts:102-105`). A range-highlight layer is not a token, and
no editor-scoped view contribution reaches those views. A pinned function signature in sticky scroll
will show tree-sitter colour while the same line below it shows semantic colour.

This is a **product decision, not an implementation detail**. The only shape that would fix it is
shape (b) in Milestone 5 — a genuine second token array — which is costed there and not taken.

---

## What exists today, and what does not

### Five channels that already put colour on text

Enumerated because the previous version of this plan said no plugin channel for tokens exists, which
is true for an *overlay* and not flatly true.

**(A) `Editor.setTokens(tokens)` / `Editor.setDocument({text, tokens})`** — `Editor.ts:656`, `:687`.
Public, host-facing, no plugin needed, and the only channel that reaches the secondary views. Also
**single-owner and hostile to co-existence**: `EditorSyntaxController.applySyntaxResult` and
`applyHighlightResult` both call it on every parse, so a host-supplied array is overwritten by the
next one. Usable only when no syntax or highlighter provider is registered — which is never, in the
real consumer.

**(B) `EditorHighlighterProvider`** — `plugins.ts:165-168`, registered through `registerHighlighter`
(`:648`), selected first-non-null single-winner (`EditorPluginHost.createHighlighterSession`,
`plugins.ts:920-929`). A session answers `refresh` / `applyChange` with `{ tokens, theme }`.
**This is a plugin-registered token channel and it already exists.** It does not solve this problem,
because registering one makes the syntax controller stop asking tree-sitter for tokens entirely
(`syntaxController.ts:409`, `includeHighlights: !this.highlighterSession`, and `:655`,
`if (!this.highlighterSession) this.setTokens(nextTokens)`). It is a *replacement* layer, whole-document,
and it is what shiki uses. Say this rather than saying the channel is absent.

**(C) `EditorViewContributionContext.setRangeHighlight` / `clearRangeHighlight`** —
`plugins.ts:314-319`, wired at `Editor.ts:2371-2372`. **This is the channel the contract paints
through.** Optional members; the house call style is `context.setRangeHighlight?.(…)`
(`documentHighlightController.ts`, the `paint` method). Three subsystems use it today: diagnostics,
document highlights and find.

**(D) `Editor.setRangeDecorations(EditorRangeDecoration[])`** — `Editor.ts:1137`, type at
`editor/types.ts:38-49`. The host-facing twin of (C), needing no plugin. It groups decorations by
resolved style and sorts by `zIndex` (`editor/rangeDecorations.ts:31`, `:75`) — which is exactly the
"one group per distinct resolved style" Milestone 5 derives. Two caveats: group names embed the
group's index so input must arrive in stable paint order, and it is a wholesale replacement with a
full array comparison per call. **A host that cannot use plugins can implement the contract on top of
this**, at the cost of doing its own scope resolution.

**(E) `EditorRangeHighlightContributionContext`** — the same two methods handed to decoration
contributions.

### The blocker

`grep -rn "semanticTokens" packages/` returns **nothing**. There is no decoder, no capability, no
controller, no theme vocabulary. That is expected. The part that is not expected is that a host
cannot even ask:

`LspConnection.createClient()` (`packages/lsp-plugin/src/lspConnection.ts:62-74`) constructs the
`LspClient` with `rootUri`, `workspaceFolders`, `workspace`, `timeoutMs`, `initializationOptions` and
one notification handler. **It never passes `capabilities`, and it never passes `clientInfo`** — both
of which `LspClientConfig` accepts (`packages/lsp/src/client.ts`, the `capabilities` and `clientInfo`
fields) and both of which `LspClient` merges over `defaultClientCapabilities()` in its constructor.
`LspConnectionOptions` (`lspConnection.ts:16-21`) has no such field; neither does
`LanguageServerPluginOptions` (`packages/lsp-plugin/src/types.ts:46-62`) nor
`LanguageServerAdapterPluginOptions` (`plugin.ts:100-153`).

`defaultClientCapabilities()` (`packages/lsp/src/capabilities.ts:27-84`) declares
`general.positionEncodings`, synchronization, completion, codeAction, signatureHelp and
`window.showMessage`. **There is no `textDocument.semanticTokens` block, and no way for a host to add
one.** The block being absent is correct and stays that way (§C3); the *absence of a way to add one*
is the defect.

Two further holes of the same shape, found in Pass 4 and closed by the same milestone:

- **No client handle through the narrow factory.** `LanguageServerConnectionContext` —
  `{ client, workspace }`, `plugin.ts` — reaches a host only through `onConnectionCreated` /
  `onConnected`, and `createLanguageServerPlugin` (`plugin.ts:196-216`) forwards neither: it forwards
  `rootUri`, `hoverMarkdownCodeBackground`, `initializationOptions`, `timeoutMs`, a transport factory
  and six `on*` callbacks. `LanguageServerPluginOptions` (`types.ts:46-62`) has no member that yields
  a client. So a host on the narrow factory cannot issue a request, override `timeoutMs` per request,
  or cancel one — §C8's three primitives are all methods it has no way to call.
- **No second notification handler.** `LspClientConfig.notificationHandlers` exists, and
  `createClient()` (`lspConnection.ts:62-74`) fills it with exactly one entry, for
  `textDocument/publishDiagnostics`, with no way for a host to add another. That is the editor's half
  of §C9's refresh route.

That is Milestone 3, and it is still small: three pass-throughs, one handle, one builder and a type.

### The highlight priority space, as it stands

One global namespace that four subsystems write into with no shared table anywhere.
`Highlight.priority` is written in exactly one place in the whole virtualization directory —
`group.highlight.priority = style.zIndex ?? 0` (`virtualizedTextViewHighlights.ts:274`), on the range
path. Token highlights never set it, so every token highlight sits at the default 0.

| Producer | priority | properties declared |
| --- | --- | --- |
| syntax token highlights | 0 (default, never written) | `color`, and `text-decoration` on `text.uri` |
| range decorations, default | 0 (`rangeDecorations.ts:75`) | varies |
| `DIAGNOSTIC_STYLES.error` (`plugin.styles.ts:114-118`) | **0 (no `zIndex`)** | `color`, `background-color`, `text-decoration` |
| `DIAGNOSTIC_STYLES.warning` / `information` / `hint` (`:119-121`) | 0 | `background-color` |
| `FIND_SCOPE_STYLE` (`findController.ts:39`) | 1 | `background-color` |
| `FIND_MATCH_STYLE` (`:33`) | 2 | `background-color` |
| `FIND_CURRENT_STYLE` (`:34-38`) | 3 | `background-color`, `color` |

Two consequences an executing agent must hold on to. **Priority only decides between highlights that
declare the same property** — the CSS Custom Highlight API resolves per property, so a
background-only highlight and a colour-only highlight never contend. The only real contest for `color`
today is token(0) vs `DIAGNOSTIC_STYLES.error`(0) vs `FIND_CURRENT_STYLE`(3). And **that first contest
is currently a coin flip**: equal priority falls back to registry insertion order, so whether an error
squiggle's red text survives over a syntax-coloured identifier depends on session history.
Milestone 5 has to write into this space and therefore has to settle it.

---

## Prerequisites

All exist today unless marked.

- **A controller shape to copy.** `packages/lsp-plugin/src/documentHighlightController.ts`, 137 lines:
  options bag, update-kind filter, stored-timer debounce with `cancel()` on every input, capability
  gate before requesting, per-request `AbortController`, and the three-part staleness check
  (`requestId`, `disposed`, `ActiveDocument` identity). Copy five of the six; see §C8 on the filter.
- **A plugin channel that carries painted spans, exposed and priority-aware.** `setRangeHighlight` /
  `clearRangeHighlight` on `EditorViewContributionContext` (`plugins.ts:314-319`). Groups are named per
  view through `context.highlightPrefix` (`Editor.ts:420`, `:2349`), stack by declared `zIndex`, and
  are painted only over mounted rows by bisection. **All three of `trackRanges?`,
  `setRangeHighlight?`, `clearRangeHighlight?` are optional members** (`plugins.ts:310,314,319`) —
  call them with `?.` and never assert them into existence with `!`.
- **A tracked-range primitive with declared stickiness.** `context.trackRanges` (`plugins.ts:310-313`)
  → `Editor.trackDocumentRanges` (`:2380`) → `resolveTrackedRanges` (`:2398`). Does **not** go through
  `EditorDecorationStore`, so it does not pay that store's visit-every-decoration-per-edit cost.
- **Host-side projection without a plugin.** `EditorViewSnapshot.editsSinceTextVersion`
  (`plugins.ts:224`) plus `projectDecorationRangeThroughEdits`, publicly exported from
  `packages/editor/src/public/extensions.ts:9-12`. This is what §C5's second branch is built on and
  what diagnostics already use.
- **Document identity that makes the staleness check valid.** `ActiveDocument`
  (`packages/lsp-plugin/src/pluginTypes.ts:41-49`) is minted fresh per change and carries both
  `textVersion` and `lspVersion`, plus `lineStarts` and `fullText`.
- **Offset decoding for LSP positions.** `lspPositionToOffsetInSnapshot`
  (`packages/lsp/src/positions.ts:33`). **Do not reach for `lineStartForSnapshotLine` or
  `rowForOffset`** — an earlier draft cited both and neither is exported; `grep -n "^export "` on that
  file lists eleven and those two are not among them.
- **Real cancellation on the wire.** `LspClient.abortRequest` (`client.ts:501-508`) sends
  `$/cancelRequest` and rejects with `LspRequestCancelledError`, driven by `RequestOptions.signal`.
- **The happy-dom paint-order harness.** `packages/editor/test/rangeDecorationPaintOrder.test.ts`
  substitutes a `Map`-backed `VirtualizedTextHighlightRegistry` and a
  `class MockHighlight extends Set<Range> { priority = 0 }` through `setHighlightRegistry`
  (`packages/editor/src/public/testing.ts`). **This is the house answer for every "which highlight
  wins" assertion in this plan.** `::highlight()` styles are not reachable through
  `getComputedStyle`; do not write these as browser tests.
- **NEW, Milestone 2:** a TypeScript language-service test harness. No test in
  `packages/typescript-lsp` has ever constructed a real `ts.LanguageService`; `test/worker.test.ts`
  mocks `typescript` wholesale with a hand-written object that has no `LanguageService` and no checker,
  and `createService()` sources its libs from `createDefaultMapFromCDN` — over the network, which no
  test may depend on.
- **NEW, Milestone 3:** a client-capability and `clientInfo` pass-through, a client handle on the
  narrow factory, and host-supplied notification handlers merged with the connection's own. See
  *The blocker*.
- **NEW, Milestone 5:** a way for the host to reach the `SemanticTokenLayer` the plugin creates —
  there is no such channel today, and §C9 defines it.

---

## Milestone 0 — Four capture rules that paint nothing

`effort S` · `risk low` · unconditional, and independent of everything else in this file

**Why here.** Highlight pseudo-elements do not apply font properties. CSS Pseudo-Elements 4 admits
only colour, background-colour, text-decoration, text-shadow and text-stroke into `::highlight()`, and
this repo already knows it on one side of the house: `VirtualizedTextHighlightStyle`
(`virtualizedTextViewInternals.ts:47-55`) offers `backgroundColor`, `color`, `textDecoration`, `zIndex`
and no font properties. The token side does not know it: `STYLE_PROPERTIES`
(`packages/editor/src/style-utils.ts:3-12`) carries `fontStyle` and `fontWeight`, and
`buildHighlightRule` (`:32-38`) emits them into `::highlight()` rules where they are inert.

That is a live rendering defect, not a design input. Four capture rules declare font properties in
`CAPTURE_STYLE_RULES` (`packages/editor/src/syntax/captures.ts:34-68`): `comment` (`:36`, colour +
`fontStyle`), `text.title` (`:59`, colour + `fontWeight`), **`text.emphasis` (`:55`, `fontStyle`
only)** and **`text.strong` (`:58`, `fontWeight` only)**. The first two lose their italic and bold and
keep their colour. The last two declare nothing else, so `normalizeTokenStyle` keeps them,
`buildHighlightRule` emits `::highlight(x) { font-style: italic; }`, a live `Highlight` is registered
for them, and every `*emphasis*` and `**strong**` span in a markdown document is painted by a rule with
no visible effect. **They are uncoloured.** The shiki path produces the same shapes, so swapping
highlighters does not rescue them.

**The fix is a decision, not a measurement.** Give `text.emphasis` and `text.strong` a colour of their
own so markdown emphasis is visible at all, and stop emitting the inert declarations. Do not delete
`fontStyle`/`fontWeight` from `EditorTokenStyle`: shiki populates them from real theme data and a
future non-highlight render path may want them. Split `STYLE_PROPERTIES` so the key-building table and
the declaration-emitting table are no longer the same list.

**Exit criteria.** `buildHighlightRule` emits no `font-style` or `font-weight` declaration for any
input, asserted directly on a style that declares both. `serializeTokenStyle` still folds `fontStyle`
and `fontWeight` into the key, so two tokens differing only in weight remain distinct styles —
asserted, because splitting the table is exactly the edit that would silently collide them. A markdown
fixture containing `*emphasis*` and `**strong**` produces tokens whose resolved style declares a
colour, and a test asserts the resolved colour differs from the surrounding `text` colour; this test
fails on today's code. `resolveEditorScopeStyle('comment')` still declares a colour after the change.
No token in any existing fixture changes its resolved colour except the two markdown scopes named,
asserted by the existing token suite passing untouched.

- [x] **Split the style-key table from the CSS-declaration table in `style-utils.ts`** — `S`
      → `STYLE_KEYS` (identity, all five fields) and `HIGHLIGHT_DECLARATIONS` (paint, three fields).
- [x] **Give `text.emphasis` and `text.strong` a colour so they paint at all** — `S`
      → registered ids `syntax.textEmphasis` and `syntax.textStrong`, defaulting through
      `editorColorReference` to `syntax.type` and `syntax.constant`, so a theme can override them by
      id and one that declares nothing still looks deliberate.
- [x] **Markdown fixture test that fails today and passes after** — `S`
      → `packages/tree-sitter-languages/test/captureTokens.test.ts`, driving the real markdown and
      markdown_inline grammars through the same injection the worker performs. Verified failing on
      the pre-fix tree and passing after.

---

## Milestone 1 — Exact-span capture overlaps resolved where the names still exist

`effort S` · `risk low` · unconditional, and pays whether or not the rest of this plan ships

**Why here.** Overlapping tokens are live today and they paint in an order nobody chose.
`collectCapture` in the tree-sitter worker de-duplicates on
`${startIndex}:${endIndex}:${captureName}:${languageId}` — the capture *name* is in the key, so two
captures over the same span with different names both survive, and `sortCaptures` only orders them. In
a `.ts` file, `const MAX = 10` produces four tokens over exactly the same span of `MAX`: `@variable`
(`javascript-highlights.scm:4`), `@constant` (`:54-59`), `@constructor` (`:51-52`) and `@type`
(`typescript-highlights.scm:7-8`). Each resolves to a different style, each style gets its own
`Highlight`, all four sit at priority 0, and equal-priority highlights paint in registry insertion
order — which is "first time this document's shared registry saw that style key", i.e. a function of
which file was opened first and what was in it. **The colour of `MAX` is a function of session
history.**

**Fix it in the worker, where the capture names still exist.** `treeSitterCapturesToEditorTokens`
runs inside the tree-sitter worker and receives every capture with its `captureName` attached;
capture-to-style resolution happens there, and raw capture names ship to the main thread only when
`includeCaptures` is on. So the ranking table lives beside `CAPTURE_STYLE_RULES`
(`captures.ts:34-68`), and the resolution is "among captures with identical `start` and `end`, keep
the highest-ranked name". One function, no wire-format change, no `EditorTokenStyle` change, no
`Highlight.priority` change, and no entanglement with the shared priority space.

There is a second, quieter payoff. `appendEditorTokenIndexEntry` sets `nonOverlapping = false` the
moment `token.start < builder.previousEnd`, and two tokens over an identical span trip it every time.
So `nonOverlapping` is false today for any TypeScript file containing a capitalised identifier, and
cutting exact-span duplicates should restore it. **Should** — nested captures over *different* spans
would still trip it, and this plan does not know how many the shipped queries produce, so the exit
criterion measures it and records the number rather than asserting a result.

**What this deliberately does not fix.** Partial overlaps — a capture over a larger node containing a
capture over a smaller one — are not exact-span and stay order-dependent. Pin the current behaviour
with a test rather than leaving it undescribed, and do not extend the ranking to cover it.

**Exit criteria.** Given a `.ts` fixture containing `const MAX = 10`,
`treeSitterCapturesToEditorTokens` returns exactly one token over the span of `MAX`, and its style is
the constant colour rather than the type colour — a node test that names that expectation explicitly
and fails on today's code. No two tokens in its output share both `start` and `end`, asserted over a
fixture exercising all four overlapping rules. The same document parsed twice, with the module-level
style cache warm from a different document in between, produces byte-identical token output — the
property that made colour depend on session history, asserted directly rather than through paint. A
happy-dom test using the Map-backed registry opens two documents in a fixed order, then the same two
reversed, and asserts the set of registered token-highlight style keys and the style resolved for
`MAX` are identical across both runs. `getEditorTokenIndex(tokens).nonOverlapping` is computed for a
~500-line TypeScript fixture and its value is recorded in this file as a blockquote, before and after;
if it is still false, the remaining overlap kinds are named there. A partial-overlap fixture has its
current resolution pinned by a test whose comment says the outcome is order-dependent and unfixed.

**That measurement needs a real TypeScript grammar, and no TypeScript wasm is checked into this
repo** — `packages/tree-sitter-languages/src/grammars/` holds exactly two files, both markdown. The
TypeScript grammar arrives as a dependency, at
`packages/tree-sitter-languages/node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm` (with
`tree-sitter-tsx.wasm` beside it). **Load it the way `packages/markdown/test/replacements.test.ts:19-40`
loads the markdown ones**: `await Parser.init()`, then `Language.load(await readFile(wasmPath))`, then
`new Query(language, await readFile(queryPath, 'utf8'))`, all from `web-tree-sitter`, with paths built
off `process.cwd()`. The query text is `typescript-highlights.scm` concatenated with
`javascript-highlights.scm`, which is what ships. A hand-written capture fixture will not substitute:
the point of the measurement is to find overlap kinds this plan has not enumerated, and a fixture can
only contain the ones its author already thought of.

**The measurement, taken as specified: the real TypeScript grammar, the real shipped queries
(`typescript-highlights.scm` + `javascript-highlights.scm`), three real ~500-line source files from
this repo, through `treeSitterCapturesToEditorTokens` and into `getEditorTokenIndex`.**

> ```
>                                                lines  tokens  nonOverlapping  exact-span dupes  nested
> BEFORE
>   packages/lsp/src/client.ts                     558    3448           false               474       5
>   packages/editor/src/theme.ts                   599    3242           false               377     111
>   packages/lsp-plugin/src/completionController.ts 613   2957           false               307       0
> AFTER
>   packages/lsp/src/client.ts                     558    2974           false                 0       5
>   packages/editor/src/theme.ts                   599    2865           false                 0     111
>   packages/lsp-plugin/src/completionController.ts 613   2650            TRUE                 0       0
> ```

**The hypothesis was half right, which is why the criterion measured instead of asserting.**
Exact-span duplicates are gone everywhere — 474, 377 and 307 of them, roughly one token in seven —
and one of the three files does flip `nonOverlapping` to true. The other two do not, and the
remaining overlap has one cause: **template literals**. A `@string` (and, under injection, an
`@embedded`) capture covers the whole literal while `@punctuation.special` (`${`, `}`),
`@variable`, `@property` and `@function` capture inside it. Those are nested, not exact-span, so
Milestone 1 deliberately leaves them alone and the partial-overlap test pins them. Ranked by
frequency across the two files that stayed false:

> ```
>   42  string ⊃ punctuation.bracket        20  string ⊃ embedded
>   42  embedded ⊃ punctuation.bracket      20  punctuation.special ⊃ embedded
>   40  string ⊃ punctuation.special         9  string ⊃ punctuation.delimiter
>   29  string ⊃ variable                    7  string ⊃ property
>   29  embedded ⊃ variable                  7  string ⊃ function
> ```

A file with no template literal is now non-overlapping; a file with one is not, and never was going
to be under an exact-span rule.

- [x] **A static rank over the capture scope names, beside `CAPTURE_STYLE_RULES`** — `S`
      → `CAPTURE_SPECIFICITY` in `packages/editor/src/syntax/captures.ts`
- [x] **Exact-span resolution inside `treeSitterCapturesToEditorTokens`** — `S`
      → `exactSpanWinners`, same file. Only captures that would produce a token at all are
      candidates, so a winner can never be a name that resolves to no style and swallow a sibling
      that does.
- [x] **`nonOverlapping` measured before and after on a real fixture, recorded here** — `S`
- [x] **Partial overlaps pinned, not fixed** — `S`
      → `packages/tree-sitter-languages/test/captureTokens.test.ts`, "leaves partial overlaps
      alone, order-dependent as they were".

---

## Milestone 2 — A TypeScript service the tests can actually run

`effort M` · `risk medium` · unconditional · **prerequisite for Milestone 7**

**Why here, and what changed.** The previous version of this plan made this milestone the cost gate
for an in-process TypeScript semantic-token server that was going to be the product's only source of
tokens. That framing is gone: the product's tokens come from dozens of out-of-process servers, and the
example app's TypeScript worker is not a product feature.

**What survives is more important than what changed.** This repo has no way to test its own LSP stack
against a real language service, and it needs one for a reason the re-scoping makes sharper: the
contract in this file is a contract with a host the editor repo does not contain. **The only way this
repo can assert its own half end-to-end, in CI, without the product, is against a server it controls.**
Milestone 7 builds that server; this milestone builds the harness it needs. It also happens to close a
long-standing hole — the package has eight test files and only one of them imports real `typescript`,
for pure diagnostic conversion.

Two obstacles, both concrete. `createService()` in `typescriptLsp.worker.ts` builds its lib map with
`createDefaultMapFromCDN` — a network fetch, which no test may depend on. The installed
`node_modules/typescript/lib/lib.*.d.ts` files are the same content on disk; the harness reads them
into the `Map<string, string>` that `createSystem` wants, and `createService` gains a seam that lets a
test supply a prebuilt map instead of fetching one. Second, `vi.mock('typescript')` is module-wide in
`worker.test.ts`, so the real-service tests belong in a **new file that does not mock it**.

**Exit criteria.** A helper in `packages/typescript-lsp/test/` builds a `ts.LanguageService` over a VFS
whose libs come from the installed `typescript` package on disk, with no network access — asserted by
the test suite passing with fetch stubbed to throw. Against that service,
`getEncodedSemanticClassifications` over a fixture returns a non-empty `spans` array whose length is a
multiple of three. `createService` accepts an injected lib map and still fetches from the CDN when none
is given, asserted both ways. A benchmark in the same package reports wall-clock for
`getEncodedSemanticClassifications` over (a) a whole ~5,000-line TypeScript file and (b) a 100-line
span of it, on a warm service — and, on the same warm service and the same fixture, for (c)
`getCompletionsAtPosition` and (d) `getQuickInfoAtPosition`. **All four numbers are recorded in this
file as a blockquote.**

**Those numbers are a datum, not a gate, and this is the change from the previous version.** They
price the example app's in-process worker, which has one message loop and no queue, so a classification
walk blocks every other language feature for its own duration. They say nothing about a
`rust-analyzer` in its own process. Record them, use them to choose the fixture server's request shape
in Milestone 7, and **do not let them gate Milestones 4–6**, which are about a contract the example
app's worker is only one possible implementer of.

An earlier draft compared (a) against `DEFAULT_DIAGNOSTIC_DELAY_MS`. **That is not a budget and must
not be used as one** — it is a debounce interval, the time we wait before starting diagnostics, which
says nothing about how long work may take once started. Left visible here so nobody reintroduces it.

**The measurement, taken as specified.** A warm `ts.LanguageService`, nothing mocked, libs read from
`node_modules/typescript/lib`, `fetch` never called. The fixture is 5,027 lines of real TypeScript
from this repo, assembled by `bench/semanticClassification.ts`: every `.ts` file under
`packages/typescript-lsp/src` and then `packages/minimap/src`, in path order, each file's body
wrapped in its own `namespace` and its imports dropped, so the concatenation parses as one module
and two files that both define `isRecord` do not collide. It parses clean — zero syntactic
diagnostics — and classifies to 7,894 tokens. `bun run bench:semantic-classification` from
`packages/typescript-lsp`; Apple M1, bun 1.3.10, TypeScript 6.0.3; 3 warm-up then 20 measured
iterations.

> ```
>                                                       average       p95     worst
>  (a) getEncodedSemanticClassifications, whole file    22.514ms  24.783ms  36.134ms
>  (b) getEncodedSemanticClassifications, 100-line span  0.380ms   0.403ms   0.410ms
>  (c) getCompletionsAtPosition (member, after a `.`)    0.212ms   0.466ms   0.556ms
>  (d) getQuickInfoAtPosition                            0.114ms   0.458ms   0.597ms
>
>  first, cold, whole-file classification               239.900ms
>  spread of (a)'s average across four runs        19.7ms – 30.0ms
> ```

**The ratio is the finding, not the milliseconds.** 100 lines is a fiftieth of the fixture and (b) is
a sixtieth of (a): on a warm service, classification is linear in the range you ask for and carries
no fixed cost worth naming, so a server answering a range question pays no whole-file tax to do it.
(c) and (d) are the other things the example app's single message loop has to interleave with, and
both sit in the same sub-millisecond band as (b). It is (a), alone, that is two orders of magnitude
away from all three. Note (c) is a *member* completion, taken after a `.` at a position the checker
can answer — a global-scope completion is a much larger list and a different number.

**These four numbers are a datum, not a gate.** They price the example app's in-process TypeScript
worker on one machine — one message loop, no queue, so (a) is time no other language feature can
use. They say nothing about an out-of-process server, which is where the product's tokens actually
come from, and nothing in Milestones 4–6 may be conditioned on them.

- [x] **Lib map read from disk, and a seam in `createService` to inject it** — `M`
      → `createService(libraryFiles?)` in `packages/typescript-lsp/src/typescriptLsp.worker.ts`,
      reachable through the existing `__typeScriptLspWorkerInternalsForTests` export. Omit the
      argument and the `createDefaultMapFromCDN` call is exactly what it was.
      `typeScriptLibraryFilesFromDisk` in `packages/typescript-lsp/test/realTypeScriptService.ts`
      builds the map, resolving the lib directory through `createRequire`.
- [x] **A real `ts.LanguageService` in a test, in a file that does not `vi.mock('typescript')`** — `M`
      → `packages/typescript-lsp/test/realTypeScriptService.test.ts`. `globalThis.fetch` is stubbed
      to throw for the whole file; `getEncodedSemanticClassifications` over a fixture returns a
      non-empty `spans` whose length is a multiple of three, and both directions of the seam are
      asserted — injected map builds without a fetch, no map takes the CDN URL.
- [x] **Whole-file versus span classification cost, benchmarked and recorded here as a datum** — `S`
      → `packages/typescript-lsp/bench/semanticClassification.ts`, wired as
      `bun run bench:semantic-classification`. Numbers in the blockquote above.

---

## Milestone 3 — The plumbing a host needs: capabilities in, a client handle out

`effort S` · `risk low` · **unconditional. This is the blocker, and it is three pass-throughs, one
handle, one builder and a type.**

**Why here.** Nothing else in this plan can be exercised against a real server until this lands, and it
is independently useful — it is a general capability pass-through, not a semantic-tokens one. Today a
host reaching this library through `createLanguageServerPlugin` cannot influence the `initialize`
params at all beyond `rootUri`, `initializationOptions` and `timeoutMs`. Per §C3 the capability's
*content* is the host's to choose, and the mechanism does not exist.

**Part one: capabilities, `clientInfo` and notification handlers in.** `LspClientConfig` already
accepts all three (`packages/lsp/src/client.ts`: `capabilities`, `clientInfo`,
`notificationHandlers`), and `LspClient` already merges `capabilities` over
`defaultClientCapabilities()` in its constructor. The gap is entirely in `packages/lsp-plugin`: add
them to `LspConnectionOptions` (`lspConnection.ts:16-21`), pass them in `createClient()` (`:62-74`),
add them to `LanguageServerAdapterPluginOptions` (`plugin.ts:100-153`) and to the narrow
`LanguageServerPluginOptions` (`types.ts:46-62`), and forward them in `createLanguageServerPlugin`
(`plugin.ts:196-216`). **Both option types, not just the adapter one** — the real consumer uses the
narrow factory, so a knob added only to the adapter is a knob it cannot reach.

`notificationHandlers` is a **merge, not a replacement.** `createClient()` installs its own
`textDocument/publishDiagnostics` entry and the entire diagnostics feature hangs off it, so
host-supplied entries are merged around it and a host entry for that method must not displace it.
This is the editor's half of §C9's refresh route and the only half this plan owns.

**Part two: a client handle through the narrow factory.** `onConnectionCreated(context)` and
`onConnected(context)` already exist on `LanguageServerAdapterPluginOptions` and already carry
`LanguageServerConnectionContext = { client, workspace }`, which is already exported from the package.
Add both to `LanguageServerPluginOptions` and forward them in `createLanguageServerPlugin`, keeping
`onConnectionCreated`'s `EditorDisposable | void` return — that is how a host tears its own controller
down with the connection. **Without this a host on the narrow factory cannot issue a token request,
override `timeoutMs` per request, or cancel one** (§C8), and the product's plan cites this milestone
for the handle.

**Part three: `semanticTokensClientCapability()`.** Exported from `packages/lsp`. Builds a
`textDocument.semanticTokens` block from the caller's choices — `requests` (`full`, `full.delta`,
`range`), `tokenTypes`, `tokenModifiers`, `formats`, `multilineTokenSupport`, `augmentsSyntaxTokens` —
and its whole purpose is that **what it can produce is exactly what the shipped decoder honours**.
Three flags are absent by construction rather than defaulted, and each absence is a term of the
contract: §C1 forbids `overlappingTokenSupport: true`, so it is not a settable option; §C1 gates
`multilineTokenSupport` on Milestone 5's exit criterion, so the builder rejects it until then; and §C3
de-scopes `dynamicRegistration` on both sides, so the builder does not offer it at all. This is the
mechanism that stops the client declaring a flag it cannot honour, which a real server will act on.

**The builder is the editor's whole contribution to §C3's content, and the host calls it.** This plan
does not choose `tokenTypes`, does not answer `augmentsSyntaxTokens`, and does not decide how many
distinct blocks a host builds or at what granularity. §C3 says why each of those is the host's, and
the product's plan owns them.

**What is deliberately not here: an inbound server-request seam.** An earlier draft added
`LspClientConfig.requestHandlers` so that `workspace/semanticTokens/refresh` and
`client/registerCapability` could be answered. **Pass 4 cut it.** Both methods are answered by the
transport before they ever reach this client — the proxy replies `-32601` to the first and `null` to
the second and forwards neither — so the seam would have shipped with no consumer, a test suite, and
a standing invitation to declare `dynamicRegistration`. `LspClient.handleRequest`
(`packages/lsp/src/client.ts:483-489`) keeps answering method-not-found unconditionally, and §C3 and
§C9 record the consequences as de-scopings on both sides rather than as gaps waiting on the other
plan.

**Exit criteria.** A host constructing a plugin through the **narrow** `createLanguageServerPlugin`
factory can supply `capabilities` and `clientInfo`, and a test asserts both appear verbatim in the
`initialize` params the transport sees. Supplied capabilities merge over
`defaultClientCapabilities()` rather than replacing it — asserted by a host declaring only
`textDocument.semanticTokens` and the resulting params still carrying `general.positionEncodings`
and the completion block. `defaultClientCapabilities()` still declares **no**
`textDocument.semanticTokens` block, asserted, and a comment beside it says why: the content is the
host's per §C3 and a default here would be a lie for every host that does not implement the layer.
**That assertion is the editor's half of a Pass 4 decision and the product's plan does not
contradict it** — see §C3. `semanticTokensClientCapability()` produces a block whose `requests`,
`tokenTypes` and `tokenModifiers` round-trip through
`mergeClientCapabilities(defaultClientCapabilities(), …)` unchanged; it has no way to express
`overlappingTokenSupport: true` or `dynamicRegistration`; and it emits `multilineTokenSupport` only
when a caller asks for it, Milestone 5's criterion for that flag having passed. **The two forbidden
flags are absent from the emitted block, never present as `false`** — the builder has no option that
produces either key at all, and absent is what the wire means by false. Any test on either side
asserts that the key **is not there**; a test asserting `flag === false` asserts something this
builder cannot produce, and a plan deliverable written as `dynamicRegistration: false` is describing
an emitted key that will never exist. The same holds for `multilineTokenSupport` when a host does not
ask for it. A host on the
**narrow** factory receives a `LanguageServerConnectionContext` from `onConnectionCreated`, issues a
request through `context.client` with a per-request `timeoutMs`, and cancels it with an
`AbortSignal` — asserted end to end against a stub transport, because those three are the whole of
§C8's primitive set and none of them is reachable today. A host-supplied notification handler for a
method the connection does not install is invoked, **and a host-supplied handler does not displace
`textDocument/publishDiagnostics`** — asserted by driving both notifications through the transport
and seeing diagnostics still arrive.

- [x] **`capabilities`, `clientInfo` and merged `notificationHandlers` through `LspConnectionOptions` and both plugin option types** — `S`
      → `lspConnection.ts` (`LspConnectionOptions` + `createClient`), `plugin.ts`
      (`LanguageServerAdapterPluginOptions`, the resolved options, `createLanguageServerPlugin`),
      `types.ts` (`LanguageServerPluginOptions`). The publishDiagnostics merge runs the plugin's
      handler first and the host's after, so a host entry for that method adds rather than displaces.
- [x] **`onConnectionCreated` / `onConnected` on the narrow factory, so the host holds the `LspClient`** — `S`
      → forwarded in `createLanguageServerPlugin`. `RequestOptions` is now exported from
      `packages/lsp` as `LspRequestOptions` as well: §C8's three primitives are per-request
      `timeoutMs`, `signal`, and `requestHandle().cancel()`, and the type naming two of them was
      module-private.
- [x] **`semanticTokensClientCapability()`, constrained to what the decoder honours** — `S`
      → `packages/lsp/src/semanticTokens.ts`, with `SEMANTIC_TOKEN_TYPES` and
      `SEMANTIC_TOKEN_MODIFIERS` exported beside it. `overlappingTokenSupport` and
      `dynamicRegistration` are not options and no code path emits either key.
      `multilineTokenSupport` shipped refused, and **the gate was opened once M5's criterion passed**
      — the builder now accepts it and emits the key only when a caller asks.
- [x] **A comment on `defaultClientCapabilities()` recording why semantic tokens are not in it** — `S`
      → and a test asserting the block is still absent, which is the editor's half of the Pass 4
      decision that the block's content is the host's.

**Verified in both directions.** All seven assertions in
`packages/lsp-plugin/test/narrowFactoryPlumbing.test.ts` fail on the pre-M3 tree — including
`onConnectionCreated never fired on the narrow factory`, which is the blocker itself — and pass
after.

---

## Milestone 4 — The decoder and the token-type vocabulary

`effort M` · `risk medium` · **conditional**

**Why here.** It is the half of §C1 and §C4 that has no dependency on the paint layer, so it can be
built and fully tested against literal arrays, in parallel with Milestone 5. It is also where every
hazard that comes from real legends gets absorbed, so that Milestone 5 only ever sees clean spans.

### The decoder

`decodeSemanticTokens(data, legend, lineStarts)` in **`packages/lsp-plugin`**, exported publicly from
that package's index. Walks LSP's relative 5-tuple cursor — `(deltaLine, deltaStartChar, length,
tokenTypeIndex, tokenModifierBitset)` — and returns the spans of §C1 **together with a count of what it
threw away**:

```ts
// packages/lsp-plugin. Declared here and in no other document, per §C7.
export type SemanticTokenDecodeDrops = {
  /** Rule 2: tokenTypeIndex outside the legend. Tuple dropped, cursor still advanced. */
  readonly outOfLegendType: number
  /** Rule 4: zero-length tuple. */
  readonly zeroLength: number
  /** Rule 5: deltaLine ran past the last line. */
  readonly pastEndOfDocument: number
  /** Rule 3: modifier bits beyond the legend's length. The SPAN SURVIVES; only the bits are lost. */
  readonly unknownModifierBits: number
}

export type SemanticTokenDecodeResult = {
  readonly spans: readonly SemanticTokenSpan[]
  readonly drops: SemanticTokenDecodeDrops
}
```

**Counts, not samples, and all four are zero in the healthy case.** They exist because §C7's rules
discard input from an untrusted source, and a silent discard is indistinguishable from a server that
sent less — the same reason `push()` returns `unresolvedTypeNames` (§C4). The decoder neither
aggregates nor logs: whether these are summed per server, reported once per session, or ignored is the
host's policy on the host's side of the seam.

**It lives in `packages/lsp-plugin` rather than `packages/lsp` because that package is the request
side of the seam** (§C7): the decoder runs on the host's schedule against the host's legend, and
placing it beside the plugin says so structurally. **It is the only decoder either plan builds** — the
product's plan calls this export, and a second implementation there is a defect in that document. Pass
4 found one, and the copy had kept rule 2's drop while losing its advance.

Five rules, each of which exists because a real server violates it:

1. **Decode by index. Never invert the legend into a name→index map.** Real legends ship the same name
   at several indices — one server ships `variable` at three distinct indices and `function` at two.
   An inverted map silently mis-decodes every duplicate.
2. **An out-of-legend `tokenTypeIndex` drops the tuple but still advances the cursor.** The relative
   cursor is stateful; skipping a tuple without advancing corrupts every offset after it.
3. **Modifier bits beyond the legend's length are ignored, not errors.** The bitset is 32 bits and a
   legend may declare six.
4. **Zero-length tuples are dropped.** They cannot paint and they are common in the wild.
5. **Every offset is clamped to the document length**, and a tuple whose `deltaLine` runs past the last
   line is dropped rather than throwing.

**Rules 2 through 5 each increment their own counter** in `drops`, above; rule 1 is a decoding
discipline with nothing to count, and the clamp in rule 5 modifies rather than discards, so it is not
counted either.

The absolute-offset conversion is a line-start lookup plus the character offset, with no encoding
conversion, per §C2.

### The vocabulary

`EditorSyntaxThemeColor` (`theme.ts:4-21`) is a **closed union of seventeen ids** and covers only a
fraction of LSP's standard token types. Missing entirely: `class`, `enum`, `interface`, `struct`,
`parameter`, `enumMember`, `event`, `method`, `macro`, `modifier`, `regexp`, `operator`, `decorator`.

`registerEditorColor` (`theme.ts`) is open-ended, so new ids cost no core change and the closed union
does not have to be reopened. Register the standard LSP token types as open ids with
`editorColorReference` defaults pointing at the nearest existing id, so a theme that declares nothing
new still looks deliberate. Read registered ids, never literals, exactly as `captures.ts:11-32` does —
shiki populates `EditorTheme.syntax` from the VS Code theme, so a semantic layer reading
`var(--editor-syntax-*)` stays consistent with either highlighter rather than only with tree-sitter.

**Do not register anything for a specific server's custom names.** Per §C4 those arrive as
`scopeAliases` from the host, and there are dozens of servers with fifty-plus custom names each.

### The modifier axis

The type axis is a legal linear taxonomy and resolves through the scope trie for free —
`createEditorScopeStyles` (`theme.ts:529`) is generic and longest-prefix at arbitrary depth. **The
modifier axis is not expressible in it**: an LSP token carries a *set* of modifiers and the trie
indexes a *sequence*, so `variable.readonly.local` finds nothing if the theme declared only
`variable.local`. Subset scoring is not a prefix walk.

**Decision: fix a canonical modifier precedence and emit at most the highest-ranked modifier present as
a single scope suffix.** `declaration`, `readonly`, `static`, `abstract`, `async`, `defaultLibrary`,
`deprecated`, `documentation`, `modification`, `local` — in that order. `variable` + `{readonly, local}`
resolves `variable.readonly`, falling back to `variable` if the theme declared no such rule. This fits
the existing trie exactly and bounds the resolver's per-scope memo.

**It caps the scope count, not the highlight-group count.** Groups are keyed by resolved style
(Milestone 5), so the live group count is however many distinct styles those scopes land on in the
current theme. With a per-server legend running to fifty-plus type names, this distinction is now
*more* load-bearing than it was when the legend was assumed to be twelve: fifty types collapse to
however many colours the theme actually declares, which is a handful.

**Exit criteria.** Decoding a response with an out-of-legend type index, an out-of-legend modifier bit
and a zero-length tuple mixed in among four valid tuples yields exactly the four valid spans, at their
correct absolute offsets — **one test over one fixture**, so the relative cursor is proved to advance
across the dropped tuples rather than being proved only not to throw. **That same fixture asserts
`drops`**: `{outOfLegendType: 1, zeroLength: 1, unknownModifierBits: 1, pastEndOfDocument: 0}`, and a
clean fixture returns all four at zero — so a rule that starts discarding silently fails a test rather
than costing a host its colour with no way to see why (§C7). A tuple past the last line increments
`pastEndOfDocument`, and the modifier-bit case increments `unknownModifierBits` **while still yielding
its span**, since that rule loses bits rather than a token. A legend that declares the same
name at two indices decodes both indices to that name, and a test asserts the decoder does not build an
inverted map — asserted by a legend where index 0 and index 7 are both `variable` and a fixture using
both, expecting two spans. A multi-line tuple decodes to a span whose `end` is on a later line than its
`start`. A tuple whose `deltaLine` runs past the last line is dropped and the ones before it survive.
Every standard LSP token type resolves to a declared colour under the shipped theme, asserted by name
over the whole list; a name absent from the theme and from `scopeAliases` resolves to `null` and the
caller drops the span. A `scopeAliases` entry mapping a custom name onto an existing scope resolves to
that scope's style. `variable` + `{readonly, local}` resolves the same style as `variable` +
`{readonly}`, and both differ from bare `variable` when the theme declares `variable.readonly`.

**These are the decoder's whole exit criteria and they live here** (§C7). The product's plan cites this
milestone and does not restate the rules, because rule 2 in particular is the kind that is easy to
restate with the drop and without the advance — which is exactly the defect Pass 4 found.

- [x] **`decodeSemanticTokens` in `packages/lsp-plugin`, with the five rejection rules, returning `{spans, drops}`** — `M`
      → `packages/lsp-plugin/src/semanticTokenDecoder.ts`, exported from that package's index.
- [x] **Standard LSP token types registered as colour ids with reference defaults** — `S`
      → thirteen new ids in `packages/editor/src/syntax/semanticTokens.ts`: `syntax.class`,
      `syntax.enum`, `syntax.interface`, `syntax.struct`, `syntax.parameter`, `syntax.enumMember`,
      `syntax.event`, `syntax.method`, `syntax.macro`, `syntax.modifier`, `syntax.regexp`,
      `syntax.operator`, `syntax.decorator`.
- [x] **Scope resolver: type axis through the trie, one canonical modifier suffix** — `M`
      → `createSemanticTokenStyles`, same file.
- [x] **`scopeAliases` pass-through, and `null` for an unresolved name** — `S`
- [x] **Export `createEditorScopeStyles` on the public syntax surface** — `S`
      → plus `EditorScopeStyleRule` and `EditorScopeStyles`, from both `@singapor/core` and
      `@singapor/core/syntax`.

**Three additions to the specification as written, each recorded here rather than made silently.**

1. **`decodeSemanticTokens` takes a document, not a bare `lineStarts`.** The signature is
   `(data, legend, { lineStarts, textLength })`. Rule 5 clamps every offset to the document length
   and `lineStarts` alone cannot say where the last line ends.
2. **`SemanticTokenDecodeDrops` carries a fifth counter, `malformedTuple`.** It counts a trailing
   partial tuple and a tuple carrying a value that is not a non-negative integer. Neither is one of
   the five rules — it is input that was never a 5-tuple — but the reason the other four counters
   exist applies unchanged: a truncated frame that decoded to silence is indistinguishable from a
   short answer. On a non-integer the decoder stops rather than continuing, because the cursor cannot
   be advanced by a value that is not a number and guessing would put every later span at a plausible
   wrong offset. **The addition is additive**: a host reading the four documented fields is
   unaffected.
3. **`definition` is inserted into the modifier precedence, after `declaration`.** The plan's list
   omits it while including the non-standard `local`, and `semanticTokensClientCapability()` declares
   `definition` as one of the ten standard modifiers — so a token carrying only that one would
   otherwise have fallen to an unranked position for no reason. Unlisted modifiers rank below every
   listed one and ties among them go to the lexicographically first, so a modifier *set* resolves
   identically however it was ordered, which §C1 requires.

`data` is typed `ArrayLike<number>` rather than `number[]`, so a host holding a `Uint32Array`
does not have to copy it; there is a test for that.

---

## Milestone 5 — The paint layer: `SemanticTokenLayer`

`effort L` · `risk high` · **conditional**

**Why here.** It is the editor's half of the contract and the largest and riskiest thing in this plan.
It consumes M0's style-table split and M4's resolver, and — because §C1 takes decoded spans — it can be
tested end to end against a literal array with no server anywhere in the test.

### The layering decision, re-verified

An earlier draft merged semantic tokens into the syntactic token array inside
`EditorSyntaxController.setTokens`. **That was wrong on two counts, both verified and both still true.**
`setTokens` is on the per-keystroke path — `Editor.applyEdit` → `Editor.adoptTokens` (`Editor.ts:681`)
→ `syntax.setTokens` — so every character typed would pay a concat, an `Array.sort` and a full token
index rebuild over the whole document; and because the merged array is fresh,
`tokenProjectionLiveRangeStatus` (`tokenProjection.ts:55`) returns `null`, so `adoptTokens` skips both
live-range fast branches and falls into a full token re-render, per character, on the main thread. It
was also placed where `EditorSyntaxController.repaintCachedVisibleSyntaxRange` bypasses it, so semantic
colour would have vanished on every scroll-back over a cached window.

Four shapes are on the table. The fourth is the one this plan takes.

**(a) Merge into the syntactic array.** Rejected — the per-keystroke costs above, in full.

**(b) Give the view a genuine second token array, composed per painted row.** The view already builds
token segments per mounted row by bisecting the token index, so a second array bisected the same way is
bounded by the viewport rather than the document, and `view.tokens` and its projection lineage stay
untouched. This is the honest fallback and it is real work: a second index, an overlay term in the
per-row skip signature, overlay-aware segment composition, and a new public setter. Call it `M`–`L`
inside `packages/editor`, on top of everything else in this milestone. **It is also the only shape that
could ever reach the minimap, sticky scroll and the diff panes.** Take it only if (d) fails its
measurement, or if the structural limit named in the Contract stops being acceptable.

**(c) Route semantic tokens through the decoration store.** Rejected — `EditorDecorationStore.applyEdits`
visits **every** decoration on every edit, as its own comment says.

**(d) Paint them as range highlights — the second layer the view already composes.** Taken.
`setRangeHighlight(name, ranges, style)` is already on `EditorViewContributionContext`
(`plugins.ts:314-318`), already reaches `packages/lsp-plugin`, already stacks by declared `zIndex`
(`virtualizedTextViewHighlights.ts:274`), already paints only over mounted rows by bisection, already
skips redundant updates by signature (`canSkipRangeHighlightUpdate`, `:1165`), and is already how
diagnostics, document highlights and find put colour on text.

**One highlight group per distinct resolved style — not one per semantic scope.** This is the house
pattern already: `SharedTokenHighlights.acquire` keys on the serialized style, not on the capture name.
The per-repaint cost of shape (d) is **one `setRangeHighlight` call per live group**, so group count is
the cost driver and scope count is not. Key the group on the four fields `sameHighlightStyle` compares
(`virtualizedTextViewHighlights.ts:1190-1200`) — `color`, `backgroundColor`, `textDecoration`, `zIndex`
— name it `` `${context.highlightPrefix}semantic-${n}` `` per distinct key, and clear a group whose
ranges empty out, so the live count is the number of distinct semantic colours the viewport contains.

**Under the real consumer this decision got more important, not less.** The previous version reasoned
about a fixed twelve-type legend. A per-server legend of fifty-plus types would be fifty-plus groups
under the rejected scheme; keyed by resolved style it is still a handful, because a theme declares a
handful of colours. **The group count is a property of the theme, not of the server.** That is the
sentence that makes this design survive an unknown legend, and it is worth stating in both plans.

What (d) costs, owned rather than discovered:

- **It writes into the shared priority space.** Settled below.
- **The repaint costs one `setRangeHighlight` call per live group, and Milestone 6 makes that
  per-keystroke.** Each call sorts the group's ranges, computes a signature across the mounted rows,
  rebuilds the group's `Range` objects over mounted rows, and then rebuilds the view's whole
  range-rule stylesheet (`rebuildStyleRules`, `:1449-1469`). With viewport-scoped groups each of those
  is tens of entries — but the *count of calls* is the live group count. **This is the single largest
  estimate risk in this plan and it has a measured number already**; see the cost gate.
- **Note where that cost is *not*.** `VirtualizedTextView` also re-runs `renderRangeHighlight` for every
  group from `renderSnapshot` — but that loop sits behind `if (key === view.lastRenderedRowsKey) return`,
  and a same-line keystroke changes no term of `rowsKey` and never resets `lastRenderedRowsKey`. An
  earlier draft benchmarked that loop and therefore benchmarked nothing. It is scroll and reflow work,
  not keystroke work.
- **It leaves the token pipeline out of the feature entirely** — and therefore the secondary views, per
  the Contract's structural limit.

### The priority band

Chosen with the numbers in hand. Since priority contests are per property, the only property in dispute
is `color`, and only three producers declare it.

| producer | today | after | why |
| --- | --- | --- | --- |
| syntax token highlights | 0 | 0 | unchanged deliberately — M1 fixed their ordering without touching this space |
| semantic layer | — | 1 | must beat syntax token colour; must not beat an error or the current find match |
| `DIAGNOSTIC_STYLES.error` | 0 (implicit) | 2 (explicit) | one line in `plugin.styles.ts`; today it wins or loses against token colour by registry insertion order, i.e. session history |
| `FIND_CURRENT_STYLE` | 3 | 3 | unchanged; still wins `color` over everything |

`FIND_SCOPE_STYLE` (1) and `FIND_MATCH_STYLE` (2) declare only `background-color` and so never contend
with the semantic layer's `color` despite sharing its numbers. Leave them alone.

### The API

```ts
// packages/editor — public surface. The payload, request and result types are §C1's.
export type SemanticTokenLayerOptions = {
  readonly name: string
  readonly scopeAliases?: Readonly<Record<string, string>>
  /**
   * Trailing debounce applied to onRangeNeeded, in milliseconds. NO DEFAULT: unset means zero, and
   * zero means the editor adds no delay of its own. The number is the host's, per §C8.
   */
  readonly viewportDelayMs?: number
  readonly onRangeNeeded?: (request: SemanticTokenRangeRequest) => void
  readonly onResyncRequired?: (reason: SemanticTokenDropReason) => void
}

export type SemanticTokenLayer = EditorDisposable & {
  push(payload: SemanticTokenPayload): SemanticTokenPushResult
  clear(): void
}
```

```ts
// packages/lsp-plugin — added to BOTH LanguageServerPluginOptions and
// LanguageServerAdapterPluginOptions, per §C9. Its presence is what makes the plugin create a layer;
// a host that supplies nothing here pays nothing.
export type LanguageServerSemanticTokensOptions = Omit<SemanticTokenLayerOptions, 'name'> & {
  /**
   * Receives the layer the view contribution created, in the shape onConnectionCreated already
   * uses: return an EditorDisposable and the editor disposes it with the layer.
   */
  onLayer?(
    layer: SemanticTokenLayer,
    document: { readonly documentId: string; readonly languageId: string },
  ): EditorDisposable | void
}
```

The layer is created from a view contribution through the contribution context — which is why a host
cannot construct one itself and why the plugin has to hand it over (§C9). Because §C1 has no LSP in
it, a host with no plugin at all can still implement the contract over `Editor.setRangeDecorations`
(channel D above), at the cost of doing its own scope resolution. **The editor ships no controller to
drive the layer**: when to request, what to request, whether to cache and how long to wait are the
host's per §C7 and §C8, and the shape to copy is `documentHighlightController.ts`.

**Exit criteria.** Pushing a payload whose `textVersion` equals the current one paints one highlight
group per distinct resolved style, and a test asserts the group count equals the number of distinct
styles rather than the number of distinct type names — asserted with a payload carrying twenty type
names that the theme resolves onto three colours. Pushing a payload for a `documentId` that is not
the active document returns `{status:'dropped', reason:'document-changed'}` and paints nothing. A
host supplying the `semanticTokens` block to the **narrow** `createLanguageServerPlugin` factory
receives the layer through `onLayer` and can push to it; a host supplying no block gets no layer and
no `onRangeNeeded` at all — **asserted both ways, because "the plugin creates it and hands it over"
is a Pass 4 deliverable that neither plan owned before.** Switching the document, or its language id,
disposes that layer and delivers a **new** one through a second `onLayer` call carrying the new
`documentId` — asserted, because a host that instead holds one layer across documents and `clear()`s
it is calling a disposed handle (§C9). In a happy-dom test using the Map-backed
registry from `rangeDecorationPaintOrder.test.ts`, an identifier covered by both a tree-sitter token
style and a semantic span has both highlights registered, the semantic group's `priority` is 1, the
token group's is 0, and both declare `color`; clearing the layer leaves only the token group. In the
same harness, text covered by an error diagnostic **and** a semantic span has the diagnostic group
at priority 2 above the semantic group at 1 — **the regression assertion for the priority table,
asserting the relative order of all four producers**, which fails if anyone raises the token or
semantic band later. A span whose type name resolves to no rule and has no alias paints nothing, and
the tree-sitter colour under it is unchanged — the fall-through §C4 depends on — **and its name
appears exactly once in `push()`'s `unresolvedTypeNames`, deduplicated across spans**, which is the
signal §C4 requires so that a legend falling on the floor is visible rather than merely silent. **A
span crossing a newline paints across two mounted rows**; this is the criterion that gates the host
declaring `multilineTokenSupport` per §C1. **It passes, and the gate was opened**: the capability
builder accepts the flag. Two overlapping spans resolve to the later one truncating the earlier, with no group
containing a zero-length range. Scrolling to a range that has never been requested fires
`onRangeNeeded` with a range covering the new viewport, and the request carries `documentId` and
`textVersion` and **no URI** (§C1). With a test-supplied `viewportDelayMs`, a flung scroll of twenty
synthetic viewport events fires it **once**; with `viewportDelayMs` unset the editor adds no delay
of its own and each viewport update fires at most one call — **asserted both ways, because the delay
is the host's number and this plan names none** (§C8). Scrolling into an already-parsed window and
back out leaves the semantic groups still holding ranges. `theme.syntax` and `theme.colors` set on
the host change semantic colours without a document reload. With a highlighter plugin registered, a
pushed payload still paints — the layer is independent of which producer owns the syntactic array.

### The cost gate

Separated out because it is the one criterion that can stop the milestone, and because the version that
stood here through two drafts could not fail.

**What the earlier version got wrong.** It drove 200 keystrokes and timed the `renderRangeHighlight`
loop inside `renderSnapshot`. **A keystroke never enters that loop** — `renderSnapshot` returns early
when `rowsKey` is unchanged, a same-line edit changes no term of `rowsKey`, and `applySameLineEdit`
never resets `lastRenderedRowsKey`. Measured, not inferred: `rowsKey` before and after a same-line
keystroke on a 200-row view were both `4000:0:19:20:direct`. So the old criterion reported ≈0 no matter
how expensive shape (d) turned out to be. **A gate that cannot fail is worse than no gate.**

**Where the cost actually is.** `renderRangeHighlight` has exactly two callers: that loop, and
`setRangeHighlight` (`virtualizedTextViewHighlights.ts:259-301`), which also sorts the group's ranges
and rebuilds the view's whole range-rule stylesheet. **One call per live group per repaint, and
Milestone 6 makes that per keystroke.** That is the number to measure.

**The benchmark.** In `packages/editor/test/`, using the Map-backed registry and `MockHighlight`: build
a `VirtualizedTextView` over a 200-row document with a 20-row viewport, give it *N* live
range-highlight groups of ~20 viewport ranges each, then drive 200 same-line keystrokes through
`view.applyEdit`, re-pushing every group's shifted ranges through `view.setRangeHighlight` after each
one — which is Milestone 6's steady state, not a synthetic one. Report per-keystroke wall clock for
**N = 0, 1, 12, the live group count the shipped theme actually produces, and one find-shaped run** —
the three groups `findController.updateHighlights` pushes together, over a viewport's worth of matches.
**All five numbers are recorded in this file as a blockquote.**

**Two gates, each anchored to a quantity the same benchmark measures rather than to a constant picked
to pass.**

- **Growth must be no worse than linear in live group count: `cost(N)/cost(1) ≤ 1.25 × N`.**
  `rebuildStyleRules` (`:1449-1469`) runs at the end of every non-skipped `setRangeHighlight` and
  rebuilds a rule for *every* group, so *N* groups updated per keystroke is *N*² rule constructions. If
  this gate fails, the fix is small and lives in `packages/editor`: a range rule depends only on the
  group's name and style, so a group whose style is unchanged cannot change the rule set — mark the
  range-rule set dirty and flush once, exactly as `SharedStyleRules` already does for token rules. Do
  not treat a failure here as a reason to abandon shape (d).
- **Sustained-typing cost must not exceed what this editor already spends on this exact mechanism.**
  Find-as-you-type is the precedent: it re-pushes three range-highlight groups from `updateHighlights`,
  at most once per `FIND_RESEARCH_DELAY_MS` (100 ms, with a 400 ms ceiling) because, as its own comment
  says, a re-search "is not a bill a keystroke can be handed". Convert both to a rate, in milliseconds
  of `setRangeHighlight` work per second of sustained typing at 12 keystrokes/second: the semantic
  layer costs `12 × cost(N_live)`, find costs `10 × cost(3 groups)`. **Gate: the first must not exceed
  the second.** Both terms are measured in the same harness, so the harness's biases cancel; the only
  judgement is the 1× factor, and that is the conservative direction — find is live only while its
  widget is open, semantic colour is live whenever a file with a server is on screen.

  If this gate fails, work the remedies in order, cheapest first, re-measuring after each: **(1)** the
  `rebuildStyleRules` dirty flag; **(2)** drop the modifier axis entirely, which cuts the scope count
  and the style count with it, at the cost of `readonly`, `static` and `local` ceasing to be visible;
  **(3)** coalesce Milestone 6's repaint the way find already coalesces its re-search, a delay floor
  with a ceiling, so a sustained run pays a bounded rate; **(4)** shape (b). If none get under the
  gate, the honest outcome is that Milestones 5 and 6 do not ship.

**What is already known, so the executing agent is not surprised.** The verification pass ran this
benchmark's shape against 84 groups — the count an earlier draft proposed before groups were keyed by
resolved style — in happy-dom:

> ```
> 200 keystroke-shaped repaints, 84 groups, ranges shift : 2888.1 ms  (14.4  ms/keystroke)
> 200 repaints, 84 groups, ranges unchanged (skip path)  :   75.6 ms  ( 0.38 ms/keystroke)
> 200 repaints,  1 group,  ranges shift                  :   29.7 ms  ( 0.15 ms/keystroke)
> ```

happy-dom performs no layout, style recalc or paint, and a browser adds all three on top of whatever JS
the repaint costs — so these omit a term that only ever adds. They are not a strict bound in the other
direction either, because happy-dom's `Range` and DOM implementations are plain JS; treat them as
indicative of *shape* and rely on the same-harness comparisons for the verdict. Two things follow, both
already built into the design. First, 84 live groups is not affordable — hence one group per resolved
style. Second, **the cost is close to linear in group count, not quadratic**: 84 × the one-group figure
is 12.6 ms of the 14.4 ms measured, leaving ~1.8 ms for everything super-linear, and re-measuring the
`rebuildStyleRules` term in isolation costs 0.86 ms/keystroke. **Fixing `rebuildStyleRules` buys
roughly a tenth; cutting the group count is what buys the milestone.** The first gate exists because
the quadratic term is real and grows, not because it dominates today.

- [x] **`SemanticTokenLayer`: normalise, resolve, group by style, paint through `setRangeHighlight?.()`** — `L`
      → `packages/editor/src/semanticTokenLayer.ts`.
- [x] **One highlight group per distinct resolved style, not per scope name** — `S`
- [x] **`onRangeNeeded` from `'viewport'`, coalesced per update, honouring a host-supplied `viewportDelayMs` with no default** — `S`
      → also fired on `'document'`, `'content'` and `'layout'`, and deduplicated on
      `(documentId, textVersion, start, end)` so a caret moving inside an unchanged viewport is
      silent. An edit under an unmoved viewport *does* re-ask, because the text the host answered
      about has changed; whether to answer is the host's, per §C8.
- [x] **The `semanticTokens` block on both plugin option types, handing the layer to the host** — `S`
      → `SemanticTokenLayerOwner` in `packages/lsp-plugin/src/semanticTokens.ts`. The view
      contribution is per *view* and outlives a document change, so the owner watches the identity
      and tears the layer down on a document or language change rather than re-pointing it.
- [x] **Explicit `zIndex` on `DIAGNOSTIC_STYLES.error`, and the four-producer priority regression test** — `S`
      → `packages/lsp-plugin/test/highlightPriority.test.ts`. It reads the real values from all
      three packages instead of restating them, which needed `FIND_HIGHLIGHT_Z_INDEX` exported from
      `@singapor/find` — the enabling change for a cross-package agreement that nothing enforced.
- [x] **Multi-line span paints across two mounted rows, gating `multilineTokenSupport`** — `S`
      → asserted in `packages/editor/test/semanticTokenPaintOrder.test.ts`. **The gate is now open**:
      `semanticTokensClientCapability()` accepts the flag and emits the key when asked. See M3.
- [x] **Per-keystroke `setRangeHighlight` cost at N = 0/1/12/live, benchmarked against both gates and recorded here** — `M`

### The cost gate: gate 1 passes, **gate 2 fails**, and the reason is not what the plan expected

`packages/editor/test/semanticTokenRepaintCost.test.ts`, in happy-dom with the Map-backed registry:
200 rows, a 20-row viewport, 20 ranges per group, 200 same-line keystrokes with every group
re-pushed after each one.

> ```
>                          before remedy 1     after remedy 1
>   N = 0                    0.2272 ms/ks        0.2419 ms/ks
>   N = 1                    0.5121              0.3740
>   N = 3   (find-shaped)    1.3527              0.6669
>   N = 12                   2.7302              1.9677
>   N = 16  (live)           3.2868              2.4692
>
>   live group count for a TypeScript viewport under the shipped theme: 16
>   GATE 1  growth cost(16)/cost(1) = 6.60   bound 20.00   PASS
>   GATE 2  semantic 29.63 ms/s vs find 6.67 ms/s          FAIL by 4.4x
>           per-repaint cost(16)/cost(3) = 3.70x — which is the whole of it
> ```

**Remedy 1 was applied and kept.** `rebuildStyleRules` ran at the end of every non-skipped
`setRangeHighlight` and rebuilt a rule for *every* group, so N groups pushed per keystroke meant N²
rule constructions to arrive at an identical string. A range rule reads only a group's name and its
style, so a repaint that merely moves ranges cannot change one: the view now counts the changes that
*can* — a group added, removed or restyled — and skips the rebuild otherwise. Worth 25% at N=16,
better than the plan's estimated tenth, and it makes find and the diagnostics layer cheaper too.

**Remedy 3 is not available, and finding out why corrected the gate's own premise.** The plan
proposed coalescing Milestone 6's repaint "the way find already coalesces its re-search". Find does
not coalesce its repaint. `scheduleResearch` calls `followPendingMatches()` on **every** content
update — resolving its tracked ranges and calling `updateHighlights()` — and defers only the
re-search, which is the expensive half. So find repaints at the full keystroke rate, and the gate's
`10 x cost(3 groups)` undercounts it. Coalescing the *paint* instead would leave colour trailing the
text by however many characters the delay covered, which is exactly what find's design avoids.

**Remedy 2 was evaluated and rejected.** Dropping the modifier axis takes the live count from 16 to
14, at the cost of `readonly`, `static` and `defaultLibrary` ceasing to be visible. It does not
approach the gate.

**Remedy 4, shape (b), was not taken.**

**Why the gate cannot be met, stated plainly.** Once the repaint rate is fixed — and it is the same
rate on both sides, since find repaints per keystroke too — the comparison reduces to one number:
cost per repaint at the live group count against cost per repaint at find's three. That is **3.7x**,
and it is a group-count ratio. The group count cannot come down. A twenty-row window of TypeScript
genuinely contains about sixteen distinct kinds of thing, and the theme genuinely gives them about
fourteen colours; collapsing every colour id introduced for semantic tokens back onto the ids that
existed before them takes 16 to 14, not to 3. **The premise the gate was calibrated on — "fifty
types collapse to however many colours the theme actually declares, which is a handful" — is what
the measurement disproves.** The group count is a property of the theme, exactly as Milestone 5
argued; it is just that a theme declares fourteen colours rather than a handful.

### What a real browser says, and why the gate's number is not one to act on

**The gate was computed in happy-dom, and a follow-up pass in real Chromium found that the two do
not agree about the thing the gate measures.** The finding is about the harness, not the design, and
it cuts in the design's favour — but only part-way, and the rest is an honest "not measured".

**Where the happy-dom cost actually goes.** Instrumenting the real code path rather than reasoning
about it: at 16 groups, `addMountedRangeHighlightRanges` is **85%** of the per-keystroke cost and
everything else is noise — the signature 3%, the sort 0.7%, the style rules 0.1%. So the gate is,
almost entirely, a measurement of building DOM `Range` objects and resolving their boundaries.

**The same instrumentation in Chromium says something different.** The whole of `setRangeHighlight`
— every line the gate is about — costs **≈0.4 ms per keystroke at 16 groups**, against happy-dom's
2.2 ms for the identical work. That figure is stable: it reproduced at 0.412, 0.419, 0.375 and 0.422
across four runs and both orderings. Isolated, a live `Range` costs 0.18 µs in Chromium against
0.35 µs in happy-dom — only 1.9x — so the gap is not `Range` construction itself but happy-dom's
boundary resolution around it.

**What could not be measured, stated plainly.** The rest of the per-keystroke cost lands in
`applyEdit`, as browser-side style and paint work deferred out of the highlight mutation. Every
attempt to measure it end to end failed a control: running the configuration table forwards and then
backwards, the numbers tracked **position in the list** rather than configuration — `N=0` measured
2.35 ms forwards and 4.86 ms backwards, `N=16` measured 5.51 forwards and 1.97 backwards. Three
methodology bugs were found and fixed along the way (the document grew by a character per keystroke
until measuring one enormous row swamped the benchmark; configurations were not warmed
individually; groups from one configuration stayed registered into the next) and the order
dependence survived all three. A leak was ruled out directly: disposing a view drains
`CSS.highlights` to zero on every cycle.

**So the honest position on gate 2 is weaker than "fails by 3.7x".** That ratio is a happy-dom
number for a quantity Chromium prices about five times lower, and the part of the frame budget that
actually matters — deferred style and paint — is unmeasured. **Getting a trustworthy number needs a
real benchmarking harness (isolated pages, forced GC, an order control that passes), which this repo
does not have and which is follow-up work rather than a blocker.** What is not in doubt: the gate as
specified does not pass, the live group count is ~14–16 and intrinsic, and the layer is opt-in.

**What that leaves.** 2.5 ms of JavaScript per repaint at 16 groups in happy-dom, and ≈0.4 ms for
the same work in Chromium. The layer is opt-in: a host that supplies no `semanticTokens` block
creates no layer, fires no demand signal and pays none of it. Gate 2 is
reported as failed rather than relaxed, and the test asserts a **regression guard** on the measured
ratio instead of a gate the design provably cannot meet — a gate that sits red forever stops meaning
anything. **Whether that trade is acceptable is the product decision the plan reserved for a human,
and it is the one open question left in this milestone.**

---

## Milestone 6 — Holding painted spans across the request window

`effort S` · `risk low` · **conditional**

**Why here.** Last of the building milestones, because it is the refinement that only becomes visible
once the layer paints — and because **it is what makes Milestone 5's cost gate the gate.** Repainting
from `resolve()` on every content update is precisely the "one `setRangeHighlight` per live group per
keystroke" the gate measures; M5's steady state without M6 is one repaint per *response*, which is a
debounce apart and cheap. Do not start M6 until M5's five numbers are recorded and both gates pass, and
re-run the benchmark afterwards if the layer ends up pushing more groups per keystroke than the gate
assumed.

This is the implementation of §C5 and §C6. Two mechanisms, and they answer different questions:

- **`trackRanges` answers "where is this span now".** Hand the resolved spans to
  `context.trackRanges(ranges, { startBias: 'right', endBias: 'left' })` (`plugins.ts:310-313`) and
  repaint from `resolve()`. Anchors are a property of the buffer, so a batch edit, multi-cursor, a
  formatter response or a Replace All all resolve the same way — the case single-edit token projection
  cannot handle, and the reason this shape was chosen.
- **`editsSinceTextVersion` answers "is this payload still usable".** A response arrives stamped with a
  `textVersion` that has since moved; §C5's four-branch table decides whether to project it, and
  `projectDecorationRangeThroughEdits` (exported from `public/extensions.ts:9-12`) does the projecting
  with the same bias pair. **The `null` branch is not optional** — `DocumentEditChain` keeps 128
  entries and a slow cold server plus fast typing reaches that.

Do not invent a third staleness scheme. `EditorSyntaxController` compares `documentVersion` against
`contentVersion` against `parsedSyntaxContentVersion`; the LSP controllers compare `requestId`,
disposal and `ActiveDocument` identity. This layer lives on the LSP side of the house, so use the LSP
one and say so in the code.

**Exit criteria.** Typing a character before a tracked semantic span shifts its painted range by exactly
one character, without a request having completed. Typing a character immediately after a span leaves
that character **outside** the span — the assertion that pins the bias pair, with the test naming the
pair and quoting §C6's reason. A multi-cursor edit inserting at five sites at once shifts all spans
after each site correctly. Deleting the whole text of a span removes it from the painted set. A payload
stamped with a `textVersion` five edits old paints at offsets projected through those five edits, and
`push()` returns `projectedThroughEdits: 5`. A payload stamped with a version the edit chain can no
longer reach returns `{status:'dropped', reason:'version-too-old'}`, paints nothing, and fires
`onResyncRequired('version-too-old')` **exactly once** — asserted by driving more than 128 recorded
edits between the stamp and the push. Under continuous typing, semantic colour never disappears
wholesale and reappears — a test asserts the union of painted ranges is non-empty at every step of a
ten-keystroke sequence with no response in between.

- [x] **Hold painted spans as tracked ranges with the §C6 bias pair, repaint from `resolve()`** — `S`
      → one `EditorTrackedRanges` **per group** rather than one per payload, because `resolve()`
      drops the ranges whose text is gone and so cannot be indexed back onto a parallel array of
      styles. Repainted on every `'content'` update, which is what find does.
- [x] **§C5's four-branch version table, with `push()` returning its verdict** — `S`
- [x] **`onResyncRequired` on the broken-chain branch, fired once** — `S`
      → asserted by driving 200 recorded edits between the stamp and the push.
- [x] **One staleness scheme — the LSP-controller convention — stated in the code** — `S`

**One clarification the criterion needed.** `projectedThroughEdits` counts the edits
`editsSinceTextVersion` hands back, and that list is **composed** — five keystrokes at one caret
arrive as one edit, not five. The count is therefore "how many edits the spans were actually carried
through", which is the honest number and the only one the layer can know. The test drives five edits
at five separate sites so the criterion's `projectedThroughEdits: 5` is a real five.

---

## Milestone 7 — A conformance fixture: the editor proves its own half

`effort M` · `risk medium` · **conditional; requires Milestone 2**

**Why here.** Everything in Milestones 3–6 is a contract with a host this repo does not contain. Tested
only against literal arrays, the contract is proved *self-consistent* and not proved *implementable* —
which is exactly the class of test that passes while the feature does not work. The example app's
TypeScript worker is the only server this repo controls, so it is the only way to close the loop in CI.

**This is a test fixture, not a product feature, and the re-scoping is the reason.** The previous
version of this plan made an in-process TypeScript semantic-token server the *point* of the work and
priced the request shape off a worker benchmark. Under the real consumer it proves the least of any
language — TypeScript is where tree-sitter is strongest — and it is not how the product gets tokens.
Build it because it exercises the seam end to end, and rank the languages that actually pay in the
product's plan, not here.

The mapping is mechanical.
`getEncodedSemanticClassifications(fileName, span, ts.SemanticClassificationFormat.TwentyTwenty)`
returns `{ spans: number[] }` of triples `(start, length, encoded)`, where
`encoded = ((typeIndex + 1) << 8) | modifierSet`. Decode is `typeIndex = (encoded >> 8) - 1` and
`modifiers = encoded & 255`. Re-encode TS's absolute triples into LSP's relative 5-tuples using the
document's line starts. Publish a legend and advertise `semanticTokensProvider`. Choose range-only or
whole-document using Milestone 2's recorded numbers, and say in the code which one and why.

**Deliberately make the fixture awkward.** A conformance fixture that only exercises the easy path
proves nothing about the servers the product actually runs. The legend this fixture publishes must
carry, by construction: **a duplicate name at two indices**, **a non-standard type name** that the
theme does not know, and **a modifier the editor's canonical precedence ranks below another one present
on the same token**. All three are ordinary in real legends and all three are where a decoder breaks.

**Exit criteria.** The example app, with the plugin configured through the **narrow**
`createLanguageServerPlugin` factory, a host-supplied `capabilities` from
`semanticTokensClientCapability()`, and the layer received through the plugin's `semanticTokens`
block, paints semantic colour over a real TypeScript file — asserted end to end, from `initialize`
through the shipped decoder to registered highlight groups in the Map-backed registry, with no mock
between the worker and the layer. **This is the only test in either repo that drives the whole seam in
one process**, which is why M3's two handles and M4's decoder are all exercised through their real
entry points here rather than stubbed. The fixture legend's duplicate name decodes correctly at both
indices. Its non-standard type name paints nothing until a `scopeAliases` entry is supplied, and paints
the aliased colour once it is. A `$/cancelRequest` naming an in-flight request causes no response to be
posted for that id. Requesting a range answers only tokens intersecting that range, and the response's
first tuple's `deltaLine` is absolute from line zero, not from the range start — the encoding mistake
that is invisible until a host scrolls. Driving ten keystrokes with the worker's response artificially
delayed past the edit-chain window produces exactly one `onResyncRequired` and no wrong-offset paint —
**the §C5 branch that has no other way to be tested.**

- [x] **`semanticTokensProvider` and a deliberately awkward legend in the example worker** — `S`
      → `SEMANTIC_TOKEN_LEGEND` in `packages/typescript-lsp/src/typescriptLsp.worker.ts`, advertised
      with `full` and `range`: `function` at two indices, the non-standard `typeAlias`, and `local`
      alongside `readonly` on every reference to a local `const`.
- [x] **TS classification triples re-encoded as LSP relative 5-tuples** — `M`
      → `encodeSemanticTokens` in the same file, index-aligned with `classifier.v2020` so
      TypeScript's type index passes through untouched, answering both requests with a comment
      recording that M2's 0.380 ms against 22.514 ms is why §C8's demand should be answered with
      `range`.
- [x] **End-to-end: `initialize` → request → decode → resolve → registered highlight groups** — `M`
      → `packages/typescript-lsp/test/semanticTokenConformance.test.ts` drives the narrow factory
      over a stub socket into the worker module in one process — legend duplicate at both indices,
      `typeAlias` painting nothing until aliased, a range answered with `deltaLine` absolute from
      line zero, and `$/cancelRequest` posting no response for the id it names.
- [x] **The delayed-response resync path, driven for real** — `S`
      → the same file: ten keystrokes with the socket's delivery held, then a burst past the
      128-transition chain, producing exactly one `version-too-old` and a paint still anchored to
      the identifiers it started on.

**One exit criterion is internally inconsistent and was resolved rather than met as written.** It
asks for "the example app, with the plugin configured through the **narrow**
`createLanguageServerPlugin` factory". The example app reaches the language server through
`createTypeScriptLspPlugin`, which is built on `createLanguageServerAdapterPlugin`; it cannot be
both. The resolution: the conformance test uses the narrow factory directly against the real worker,
and the example-app-facing half is four pass-throughs on `TypeScriptLspPluginOptions`
(`capabilities`, `clientInfo`, `semanticTokens`, `onConnectionCreated`), asserted separately. **So
the example app can now paint semantic colour but does not yet ask for any** — the request side is
a host deliverable this plan de-scopes ("the host writes its own request side", §C8), and writing one
into the example app would have been the first thing on the far side of the seam.

**Two mutation checks, run against the finished tests rather than trusted.** Encoding the first
tuple's `deltaLine` relative to the range start instead of line zero fails the range criterion;
deleting the `$/cancelRequest` route fails the cancellation criterion. Both would otherwise be tests
that pass whatever the code does.

**One behaviour worth knowing before reading the legend test.** The `local`-ranks-below-`readonly`
criterion is only observable at *reference* sites: at the declaration TypeScript also sets
`declaration`, which the editor's canonical precedence ranks above `readonly`, so `const started = …`
paints as a plain variable while the later `started` paints as a constant. That is correct under one
canonical suffix, and the test asserts both halves rather than hiding the first.

---

## De-scopings

Deliberate, so an executing agent does not re-expand them.

- **No delta protocol behind the paint layer.** No `SemanticTokensEdits`, no `resultId`, no
  `releaseDocumentSemanticTokens`, no backwards splice in `packages/editor`. Contract §C7 says why, and
  says the delta branch belongs on the request side together with its invalidation trigger. **This is
  not the previous version's de-scoping and must not be quoted as one** — that one said delta pays for
  nobody here, which is no longer true. If a host implements it, the reference to port is
  `references/vscode/src/vs/editor/contrib/semanticTokens/browser/documentSemanticTokens.ts:338-374` —
  one allocation sized `src.length + Σ(data.length - deleteCount)`, filled back-to-front so source and
  destination never alias — plus the invalid-`edit.start` guard at `:350-355` that exists because a
  server once sent `4294967276` and hung the editor.
- **No legend in the editor.** §C3. There is no API that accepts one and there will not be.
- **No per-server tables in the editor.** Custom type names arrive as `scopeAliases` from the host.
  Dozens of servers, fifty-plus custom names each; a table here would be stale the week it landed.
- **No semantic tokens in the token array.** Shape (b) in Milestone 5 is costed and rejected in favour
  of (d), not forgotten. It stays the migration path if a consumer ever needs semantic *tokens* rather
  than semantic *colour*.
- **No semantic colour in sticky scroll, the minimap or the diff panes.** Structural under shape (d);
  see the Contract's closing note. Stated in both plans in the same words.
- **No overlapping-token support.** §C1. The host must not declare the capability.
- **No modifier subset matching.** One canonical modifier suffix, per Milestone 4.
- **No multi-provider fan-out for tokens.** The highlighter and syntax channels are deliberately
  single-owner (`plugins.ts:648-649`) and this plan does not change that. One semantic source at a time.
- **No capture names on the main thread.** Capture-to-style resolution happens in the tree-sitter
  worker and raw captures ship only when `includeCaptures` is on. Milestone 1 resolves overlaps inside
  the worker precisely so this stays true.
- **No partial-overlap resolution in the tree-sitter path.** Milestone 1 fixes exact-span duplicates
  only; nested captures over different spans stay order-dependent, pinned by a test rather than fixed.
- **No font properties anywhere in the highlight layer.** Milestone 0 removes the inert declarations;
  neither the semantic type axis nor its modifier axis may reintroduce them.
- **No second decoder, and no controller.** `decodeSemanticTokens` in `packages/lsp-plugin` is the
  only decoder either plan builds (§C7), and the editor ships no `SemanticTokensController` — an
  earlier draft named one in the contract and no milestone ever scheduled it. The host writes its own
  request side, copying `documentHighlightController.ts`.
- **No inbound server-request seam, and therefore no dynamic registration.** `LspClient.handleRequest`
  keeps answering method-not-found unconditionally. Both named consumers —
  `workspace/semanticTokens/refresh` and `client/registerCapability` — are answered by the transport
  and never forwarded, so the seam would ship dead. §C3 and §C9 record this as a de-scoping on both
  sides, not as a gap either plan is waiting on.
- **No throttling number in this plan.** §C8's `viewportDelayMs` has no default and the editor names
  no milliseconds for the viewport signal. The host owns the policy and the number, because it is the
  side that can measure real servers.
- **No transport, no server lifecycle, no installation, no server matching, no throttling policy.**
  Every one of these is on the far side of the contract. If an executing agent finds itself writing
  code about a process, a socket or a `resultId` inside `packages/editor`, it has crossed the seam and
  should stop and say so.

---

## Risks

What could make the estimates above wrong, worst first.

- **The repaint is one `setRangeHighlight` call per live group, and Milestone 6 puts it on the
  keystroke path.** Measured, not feared: 14.4 ms per keystroke at 84 groups in happy-dom, which does no
  layout, style recalc or paint — so a lower bound. The two answers are one group per resolved *style*
  rather than per *scope*, and the cost gate, which can stop the milestone. **Still the single largest
  estimate risk**, because the live group count depends on how many distinct colours the shipped theme
  declares for semantic scopes, and nobody has counted them. If the gate fails, shape (b) is the
  fallback and it is `M`–`L` of new work inside `packages/editor` plus a new public setter. Two lesser
  traps: the arithmetic that says "every term is bounded by the viewport, so it is fine" is the same
  arithmetic that blessed the merge point this plan had to move; and a previous gate pointed at a loop a
  same-line keystroke cannot reach, so it would have reported ≈0 and passed. **Neither an argument nor a
  benchmark is worth anything here until you have checked which line it is actually timing.**
- **The contract has two authors and one seam, and this risk has now fired twice.** §C1's payload
  shape, §C3's legend ownership and the capability block, §C5's `textVersion` correlation and §C7's
  decoder placement are each a place where two documents can each look complete and disagree. Pass 4
  cross-checked them and returned **INCONSISTENT** on ten findings, the worst being the capability
  block, which each plan had assigned to the other — so both halves would have shipped green with
  every exit criterion passing and no server ever emitting a token. **There are now three mitigations,
  not one: the product's plan cites these terms by id and does not restate them; every term above
  names its owner and every disputed sub-term is in the ownership table; and the ids are fixed at
  `§C1`–`§C9`, so a new term arrives as a sub-term rather than as a `§C10` the other document has
  never heard of.** The root cause was a drafting race — the other document mirrored a superseded
  draft of this one — so the standing rule is that **a change to any term in the contract section is
  not landed until the other document's citation of that term has been re-read.** If an executing
  agent finds the two documents describing the same term differently, that is a blocking defect in the
  pair, not a detail to reconcile locally — stop and say so. **The second firing was the fix itself**:
  Pass 4's two reconcilers wrote in parallel against each other's superseded text and ended up owning
  half of *different* refresh routes, which Pass 5 closed by decision. The rule the second firing adds
  is that **the two documents are not reconciled in parallel** — one side lands, the other reads what
  landed.
- **§C5 routes around a broken version identity, and the thing it routes around could be fixed
  underneath it.** The correlation key is the editor's `textVersion` precisely because the LSP version
  is rewritten in flight and stripped from diagnostics. If the transport were later changed to preserve
  version identity, §C5 would still be correct but would look like belt-and-braces, and someone would
  simplify it back to the LSP version. The reason is recorded in the contract for that reason. Do not
  simplify it without changing both plans.
- **The legend is unknown at design time.** Every earlier draft of this plan sized its tables against a
  legend it had read. The real legends are per-server, run to fifty-plus custom names, and include
  duplicates and non-standard names inserted mid-list. **The three defences are: decode by index, resolve
  by prefix with a `null` fall-through, and group by resolved style.** All three are cheap and all three
  are load-bearing. A change that weakens any of them re-opens this risk.
- **`dynamicRegistration` is a trap that produces silence, not an error — so it is de-scoped on both
  sides rather than half-built.** Several servers return no provider at all from `initialize` when the
  client declares it, expecting `client/registerCapability`, which neither the editor nor the
  transport will ever answer (§C3). The residual risk is no longer that a host declares it — the
  builder cannot produce it — but that some server in the registry offers tokens *only* dynamically
  and is therefore invisible, with no diagnostic. **Counting those servers is the product plan's
  work**, and it is a count rather than a defect: the answer may well be zero.
- **The priority table is a cross-package agreement with no enforcement.** Milestone 5 writes numbers
  into `packages/lsp-plugin/src/plugin.styles.ts` and reads numbers out of `packages/find`. Nothing stops
  a future change to find's `zIndex` values from silently inverting the `color` contest. The regression
  test is the only thing holding it, and it must assert the *relative order* of all four producers.
- **Milestone 0 changes a table every token style flows through.** `STYLE_PROPERTIES` currently drives
  both the style key and the CSS declarations from one list; splitting it is the kind of edit that
  quietly changes a key and invalidates every cached highlight, or quietly collides two styles that used
  to differ. The exit criterion asserting `serializeTokenStyle` still separates styles differing only in
  weight exists for this reason and is not optional.
- **Milestone 1's `nonOverlapping` claim is a hypothesis, not a result.** The exit criterion records the
  measured value rather than asserting an outcome; a false result there is information, not a failure.
- **Milestone 2 is infrastructure priced as a milestone but historically absent for a reason.** VFS
  setup, `lib` resolution and `jsx` configuration are where this kind of harness usually costs a day
  nobody budgeted. If it overruns, only Milestone 7 is blocked — which is the intended shape, since
  M3–M6 no longer depend on it.
- **Scope drift toward "put them in the token array after all".** Shape (b) is written up in enough
  detail to look inviting, and the secondary-views limit makes it look *correct*. It is the fallback,
  gated on one specific measurement failing or on a product decision to colour the minimap. Do not take
  it because it feels more principled.
- **Scope drift toward "the editor should just own the legend, it would be simpler".** It would be
  simpler and it would be wrong for four independent reasons, listed in §C3. Two of them — pooled
  backends and client-intersected legends — are invisible from inside this repo, which is exactly why
  they are written down here.

---

## Sequencing

Milestones 0 and 1 are unconditional, independent of each other, and independent of everything after.
M0 edits `style-utils.ts` and `captures.ts`; M1 edits `captures.ts` and the worker's capture-to-token
conversion. They share `captures.ts`, so run them in series — M0 first, because its table split is the
smaller edit and M1's rank table sits beside the rules M0 touches.

Milestone 3 is unconditional and independent of both, in `packages/lsp` and `packages/lsp-plugin`. It
is three pass-throughs, one handle, one builder and a type, and it is the blocker, so **land it early
regardless of whether the conditional work is approved** — a host that cannot declare a capability
cannot even evaluate the feature, and a host that cannot reach the client cannot issue a request even
once the capability exists. It is also the milestone the product's plan is blocked on, and the only
one it is blocked on before the approval gate.

Milestone 2 can start in parallel with any of them, in `packages/typescript-lsp`, which none of them
touch. It is now a prerequisite for Milestone 7 only.

Milestones 4 and 5 are separable and can run in two worktrees, and Pass 4 moved the decoder, so the
file split is worth naming exactly. M4 is a **new file** in `packages/lsp-plugin` for the decoder plus
two named edits in `packages/editor` (`theme.ts` for the colour ids, `public/syntax.ts` to export
`createEditorScopeStyles`); M5 is `packages/editor` plus the plugin option types and
`plugin.styles.ts` in `packages/lsp-plugin`. They share a package but not a file, and they meet only at
the `SemanticTokenSpan` type — fix that type in M4's first item and neither side blocks the other.
**M5 does not touch `syntaxController.ts` or the view's token path at all** — that is the point of shape
(d), and an executing agent editing either file has drifted into shape (b) and should stop and say so.
One carve-out: if the cost gate's first threshold fails, the `rebuildStyleRules` dirty-flag fix lands in
`virtualizedTextViewHighlights.ts`, which is the range-highlight path, not the token path.

Milestone 6 is strictly after Milestone 5 and touches only what M5 added. Milestone 7 is after 2, 3, 4,
5 and 6, because it asserts all of them at once.

**What the consuming product waits on, recorded here because only this document knows where the
milestone boundaries are.** The other plan's first milestone needs **M3** and nothing else: the
capability pass-through, the builder and the client handle. Its first token-painting milestone needs
**M4 and M5 both** — M4 for the decoder, the colour ids and `scopeAliases`, M5 for the layer and the
handle that delivers it — and neither is small. **Both are conditional on a human approving the
feature** (see *Verdict, up front*); if that approval is declined, everything in the other plan after
its first milestone is blocked indefinitely. That gate is stated here because the editor owns it, and
the other plan cites it rather than restating it.

Stop points, in order of preference if the work has to end early: **after Milestone 3** (two defects
fixed, a test harness the package wants regardless, and the blocker removed so a host can experiment —
the best stop point in this plan); after Milestone 5 (semantic colour paints and is correct at rest, but
flickers under typing); after Milestone 6. Stopping after Milestone 4 leaves a decoder nobody calls —
dead code, so prefer stopping before it.

---

## Review

This plan has been through six adversarial passes, in order: a **critique** that read the call chains
and returned fifteen findings; a revision that answered them; an independent **verification** that
re-read every citation and ran its own measurements; a **re-scoping** against the consumer that
actually exists; a **seam reconciliation** that cross-checked this file against the consuming
product's plan, term by term; and a **closing pass** that applied the two decisions a re-check of that
reconciliation handed down. Recorded here because an executing agent needs to know which parts have
been stress-tested, which corrections were rejected and on what evidence, and where the edges are.
Passes are listed newest first.

### Pass 5 — closing the re-check

**Verdict: two decisions and a handful of wording edits; no term changed hands.** A re-check of Pass 4
closed ten of its eleven findings on both sides and found that the two reconcilers, drafting in
parallel, had each built one half of a *different* refresh route — the same race Pass 4 was convened to
fix, with the sides swapped.

- **Refresh takes the notification route, and the request route is de-scoped in both documents.** This
  side already had it right and nothing here changed: `requestHandlers` ships in no checklist and no
  exit criterion, and §C9, M3 and the De-scopings all say the request route is dead on both sides. The
  notification downgrade wins because its editor half — merged `notificationHandlers` through
  `LspConnectionOptions` and both plugin option types — is already scheduled with an exit criterion,
  making it the cheaper of the two. §C9 now also states that this is **M3 part one**, because five
  citations in the other document pointed at "M3 part three", which is `semanticTokensClientCapability()`.
- **The decoder returns its drops.** §7.2 of the other plan promised that an out-of-legend legend index
  is "counted and logged once per session per server", and `decodeSemanticTokens` returned only spans,
  so the count was unimplementable. It now returns `{spans, drops}` — a count per rejection rule,
  declared in M4 and nowhere else — which is exactly what `push()`'s `unresolvedTypeNames` already is
  for the style drop. The editor counts; the host logs, because only it knows what a session or a
  server is. M4's fixture asserts the counts, and the checklist item names the return shape.

Three smaller edits, all making an existing statement unambiguous rather than changing it. **The
layer's lifetime is canonical here** (§C9, signal 1): a document or language change disposes the
contribution *and* the layer, the replacement arrives through a fresh `onLayer(layer, {documentId,
languageId})`, and `clear()` across that boundary is dead code — the other plan modelled one layer held
across documents. **The capability flags are absent, never `false`** (M3 exit criteria): the builder has
no option that emits the key, so a test must assert the key is not there, and a deliverable written as
`dynamicRegistration: false` names a key that cannot exist. And M5 gains one criterion asserting the
second `onLayer` call.

**Confirmed already correct and left alone:** §C8 names no milliseconds and `viewportDelayMs` has no
default, so the other plan's argument against "a floor with a nonzero default" is answering text this
file deleted in Pass 3 — the action it justifies is still right; §C3's and §C9's titles are current, and
citations of their pre-Pass-4 titles are the other document's to fix. **Milestones 0, 1, 2, 6 and 7,
shape (d), the priority band and the cost gate were not touched by this pass.**

### Pass 4 — seam reconciliation

**Verdict: INCONSISTENT, across ten findings, and the worst of them was fatal in the quiet way.** An
independent cross-check read this file and the consuming product's plan in full, opened every citation
on both sides, and found that **the `textDocument.semanticTokens` capability block was claimed by
neither plan and forbidden by one**: this plan's Milestone 3 asserted that `defaultClientCapabilities()`
declares no such block, while the other plan asserted that it does and that the product had no knob to
vary it. Executed as written, both halves ship green, every exit criterion passes, and **no server ever
emits a token** — the same silent failure this plan calls the single hard blocker, reached from the
other direction. Three further findings were blocking or high: the client handle and the layer handle
existed in neither plan's milestones; the payload and the layer API were declared differently field by
field; and the decoder was specified twice, the second copy having kept rule 2's *drop* and lost its
*advance*, which corrupts every offset after a dropped tuple.

**Root cause, worth knowing because it explains four findings at once.** The other document mirrored a
**superseded draft** of this one: it argued against three sentences Pass 3 had already deleted,
including the one this plan explicitly forbids being quoted as a de-scoping. Its six-term `C1`–`C6`
structure and its `type` / `modifiers` / `subscribe` API belong to that draft, not to this file. The
drift was a drafting race, not a disagreement — which is why the mitigation is a process rule (see
Risks) and not an argument.

**No citation on either side pointed at a symbol that had moved or vanished.** The "symbol is the
anchor, number is a hint" policy at the top of this file held under an adversarial re-read of both
repos. The single nit raised — `RequestOptions` is not exported, though `request` and `requestHandle`
are public — affects no term.

**The decisions. These were handed down rather than merged, and they bind both documents.** Several
findings could not be closed by reconciling wording, because both documents were internally consistent
and mutually exclusive.

- **The capability block is the host's to build, from a builder this repo ships.** This plan keeps its
  assertion that `defaultClientCapabilities()` declares no block: the editor cannot know whether a
  host paints tokens, and a default would make every server in a fleet compute tokens nobody draws.
  The builder, the `capabilities`/`clientInfo` pass-through and the client handle are the editor's,
  all in M3. Block granularity, `augmentsSyntaxTokens` and the invariant test that one pooled backend
  sees one block are the host's. §C3.
- **The client handle and the layer handle are editor deliverables** — M3 and M5 respectively — and
  the other plan cites those milestones. Neither appeared in any checklist before this pass. §C3, §C9.
- **One decoder, shipped from `packages/lsp-plugin`, with its exit criteria here.** M4 moved it out of
  `packages/lsp` so that it sits structurally on the request side; the other plan calls it instead of
  writing its own. §C7.
- **`§C1`–`§C9` is the canonical numbering**, this file defines the terms, and the other document
  cites ids without restating them. New terms arrive as sub-terms, never as a `§C10`.
- **The viewport debounce number belongs to the host**, which is the side that measured real servers
  over real stdio. This plan's 120 ms default is deleted and this plan now names no number.

**What changed here, finding by finding.**

1. **The capability block.** §C3 rewritten as a division of labour with an owner named for every
   piece, including the pooled-backend granularity constraint and `augmentsSyntaxTokens`. M3's
   assertion kept and marked as the editor's half of the decision. `multilineTokenSupport` split in
   §C1 into a gate (editor, M3 builder + M5 criterion) and a declaration (host), with the consequence
   spelled out: before the gate opens, a conformant server sends no multi-line token, so no live-server
   test of multi-line painting can pass honestly.
2. **The two handles.** M3 gains `onConnectionCreated` / `onConnected` on the narrow factory; M5 gains
   the `semanticTokens` plugin block that hands the layer out, with a typed `onLayer` callback in the
   house `EditorDisposable | void` shape. Both have exit criteria. §C9 now opens with the handle
   rather than with teardown.
3. **The payload and the layer API.** §C1 declares all four types in full — `SemanticTokenSpan`,
   `SemanticTokenPayload`, `SemanticTokenRangeRequest`, `SemanticTokenPushResult` — as the single
   source of truth, with `documentId`'s branch and the absence of a URI both argued rather than merely
   stated. Added: a drop does not clear the paint, and a host that ignores `push()`'s return value is
   not conformant.
4. **Refresh.** The request route is de-scoped on **both** sides and §C9 says so. The editor's inbound
   `requestHandlers` seam is **cut** from M3, because both of its named consumers are answered by the
   transport and never forwarded — it would have shipped dead. What replaces it is the notification
   route's editor half: host-supplied `notificationHandlers`, merged rather than replacing the
   connection's own `publishDiagnostics` entry. No new layer trigger and no fourth demand reason; on
   receipt the host calls `clear()` and re-requests, which was already the contract term.
5. **`scopeAliases`.** Kept as the host's, said so explicitly and at product scale, and the editor now
   makes the failure visible rather than silent: `push()` reports `unresolvedTypeNames`, because a
   legend falling on the floor is otherwise indistinguishable from success by eye.
6. **The decoder.** Moved to `packages/lsp-plugin`, declared the only one, and M4's exit criteria
   marked as the whole test suite for the five rules.
7. **Throttling.** The 120 ms default is gone. §C8 now guarantees coalescing and honours a
   host-supplied `viewportDelayMs` with no default, and M5's flung-scroll criterion is asserted both
   with a number and without one. §C1 also records that the host need not sort or de-overlap and must
   not assert that it has.
8. **Sequencing.** A new paragraph names what the other plan waits on — M3 for its first milestone,
   M4 **and** M5 for its first painting milestone — and names the human-approval gate that the other
   plan did not mention at all.
9. **Numbering.** Fixed at `§C1`–`§C9` in the contract preamble, with an owner on every term and a
   second *Contract at a glance* table listing every disputed sub-term with its owner.
10. **Root cause.** Recorded above; the standing process rule is in Risks.
11. **Terms that already agreed** — the coordinate space, names-not-indices, `textVersion` as the
    correlation key, the delta cache's placement and the minimap limit — were confirmed identical on
    both sides and **deliberately left untouched**; §C2, §C5 and §C7 say so in a line each, so a later
    reader does not reopen them. The one loose end the cross-check named is closed by deletion:
    `SemanticTokensController` was named in the contract and scheduled in no milestone, so the editor
    now ships no controller and the de-scopings say so.

**What this pass did not touch.** Milestones 0, 1 and 2 have no seam in them and were not re-examined.
Shape (d), the priority band, the cost gate and both its thresholds, and the `trackRanges` anchoring
mechanism are all unchanged: nothing in the cross-check bore on them.

### Pass 3 — re-scoping against the real consumer

**Verdict: the plan was internally sound and aimed at the wrong host.** Passes 1 and 2 both reasoned
about the example app in this repo — six tree-sitter grammars, one in-process TypeScript worker,
`postMessage` as the transport. The consumer that matters runs 37 language servers as separate
processes over stdio behind a proxy, and reaches this library through the unforked, *narrow*
`createLanguageServerPlugin` factory. Nothing in Milestones 0–2 was affected. Everything downstream was.

**What was reversed.**

- **"tree-sitter plus shiki already deliver most of the visible colour."** Rejected. It was measured
  against seven grammars and a thirty-entry TextMate list. Against the product, roughly a dozen
  languages have no colour at all and thirty more have no ability to resolve an identifier. The
  conclusion inverts: the feature is not incremental, and **TypeScript is a bad first target rather than
  the obvious one**, because it is the single language where the existing colour is strongest.
- **"The delta protocol should not be built at all."** Half reversed. The precondition the previous
  plan named as absent — an out-of-process server, over a transport where bytes cost something, with its
  own token cache — is now present by name for a minority of the fleet. What replaces the de-scoping is
  a *placement* decision (§C7) with three reasons, one of which is new and structural: **a `resultId`
  cache is only correct if its holder can observe every invalidating event, and two of those events are
  invisible from inside the editor.** The paint contract is unchanged either way, which is the point.
- **"Cancellation can only suppress an already-computed response."** Rejected. That was a property of a
  worker with one message loop; over stdio, `$/cancelRequest` reaches a server that abandons real work,
  and it survives the proxy. §C8.
- **"Milestone 2's benchmark is the cost gate."** Rejected as a gate, kept as a datum. It prices an
  in-process worker that is no longer on the product path.
- **"Milestone 3: write a TypeScript semantic-token server."** Re-scoped from a product feature to a
  **conformance fixture** (now Milestone 7), and deliberately made awkward — a duplicate legend name, a
  non-standard type, a lower-ranked modifier — because a fixture that only exercises the easy path
  proves nothing about the servers the product runs.

**What was added.**

- **A named contract section**, `SemanticTokenLayer`, with nine cited terms, because the deliverable is
  two plans meeting at one seam and the common failure is two documents that each look complete and
  disagree about it.
- **A new blocker, found in this pass and promoted to unconditional Milestone 3.**
  `LspConnection.createClient` never forwards `capabilities` or `clientInfo`, and no option type at any
  layer the real consumer touches exposes them. Without it no host can declare
  `textDocument.semanticTokens` and no server will ever send tokens. Three lines. It had been invisible
  because the example app constructs its client differently.
- **§C5's four-branch version table**, because LSP document-version identity does not survive the
  transport: versions are rewritten on every `didOpen`/`didChange` and stripped from `publishDiagnostics`.
  The editor's own diagnostics version check passes today only because the field it compares has been
  deleted. The correlation key is the editor's `textVersion` and nothing else.
- **The `clientInfo` and `dynamicRegistration` hazards**, because both produce *silence* rather than an
  error, and silence is the failure mode nobody debugs.

**What survived unchanged, and is worth saying so.** Shape (d) — paint through the range-highlight layer,
one group per distinct resolved style — survived, and got *stronger*: it was chosen when the legend was
assumed to be twelve types, and the argument for it is that **group count is a property of the theme,
not of the server**, which is what makes it safe against a fifty-type legend nobody has read yet. The
priority band, the cost gate and both its thresholds, the `trackRanges` anchoring mechanism, and every
Milestone 0–2 exit criterion also survived; all were re-checked against the working tree in this pass.

**One correction of the earlier passes' citations.** Line numbers past roughly `Editor.ts:2300` have
drifted again since Pass 2 recorded its own drift table. That table is deleted rather than updated,
because a table of line numbers is a thing that goes stale between the writing and the reading. The
policy at the top of this file replaces it: **grep the symbol.**

### Pass 2 — verification

**Verdict: NOT-EXECUTABLE, for one named reason.** Milestone 4's cost gate benchmarked the wrong
function. Everything else was a correction, not a blocker; Milestones 0–2 were found clean and writable
as stated, and all fifteen of the critique's findings were confirmed closed.

**The blocking finding, and what changed.** The gate drove 200 keystrokes and timed the
`renderRangeHighlight` loop inside `renderSnapshot` — a loop guarded by an early return on an unchanged
`rowsKey` that a same-line keystroke provably never enters. The verifier drove a real
`VirtualizedTextView` through one and printed `rowsKey` either side: both `4000:0:19:20:direct`. So the
gate reported ≈0 regardless of the design's cost, and its "stop the milestone" branch was unreachable.
**Chosen remedy: fix the criterion *and* the design it gates**, because the verifier's replacement
measurement — 14.4 ms/keystroke at 84 groups, in an environment that does no layout, style recalc or
paint — already answered the question the old gate deferred. The milestone now keys highlight groups by
**resolved style** rather than by scope name, and carries a cost gate with two thresholds each anchored
to a quantity the same benchmark measures. Both can fail, and on the numbers in hand the second one does
at 84 groups, which is why the design changed too.

**A judgement of the verifier's that did not survive checking.** It attributed the 14.4 ms to
`rebuildStyleRules`' O(groups²). Its own datapoints say otherwise: 84 × the one-group figure (0.15 ms)
is 12.6 ms of the 14.4 ms measured, leaving ~1.8 ms for everything super-linear, and re-measuring the
`rebuildStyleRules` term alone costs 0.86 ms/keystroke. The cost is close to linear in group count.
Fixing `rebuildStyleRules` buys about a tenth; cutting the group count is what buys the milestone. The
quadratic term still gets its own gate, because it is real and it grows — but it is not the headline.

**A second finding, not on the blocking list, accepted anyway.** The controller was specified by copying
`documentHighlightController`, whose filter is `if (kind !== 'selection' && kind !== 'content') return`.
`'viewport'` is a real update kind (`plugins.ts:327`) fired from `handleViewportChange`, and nothing in
the plan asked for it, so an agent executing literally would ship a feature where scrolling into
unvisited code stays tree-sitter-coloured until you type there. The viewport demand signal is now §C8 and
carries its own exit criterion — including that a flung scroll fires it once, which Pass 3 added after
confirming the update kind is un-throttled at source.

**Smaller corrections accepted.**

- `tokenProjection.ts` has **four** exports, not three. `copyTokenProjectionMetadata` was missing from
  the plan's account and from the critique's; it carries one array's metadata onto *a copy of itself*
  and is not a merge point despite looking like one.
- Milestone 1's `nonOverlapping` measurement needs a real TypeScript grammar and **no TypeScript wasm is
  checked into this repo**. The dependency path and the loading pattern
  (`packages/markdown/test/replacements.test.ts:19-40`) are now both named in the criterion.
- Milestone 2's threshold compared a wall clock to `DEFAULT_DIAGNOSTIC_DELAY_MS` — a debounce interval,
  which says when work starts and nothing about how long it may take. Replaced; the old comparison is
  left visible as a thing not to reintroduce.
- `setRangeHighlight`, `clearRangeHighlight` and `trackRanges` are **optional** members of
  `EditorViewContributionContext`. The plan never said so; the house call style is `?.`.
- `$/cancelRequest` on a **cold** in-process service does save real work, because `ensureService` awaits
  a network fetch. (Pass 3 note: this became moot for the product, where cancellation saves real work on
  every request, not only the first.)

**Rejected, with the evidence.** Four claimed citation drifts in `javascript-highlights.scm`,
`rangeDecorations.ts` and `documentHighlightController.ts` were each checked with `grep -n` against HEAD
and each was wrong by one or two lines in the verifier's favour; the plan's numbers were already right
and were left alone.

### Pass 1 — critique

Fifteen findings; nine accepted, three accepted with the reasoning corrected, three rejected or narrowed.

**Accepted, and the design changed.**

1. *The merge point was on the per-keystroke path.* Verified: `renderSessionChange` → `applyEdit` →
   `Editor.adoptTokens` → `syntax.setTokens`. A merge there costs a concat, a sort and an index rebuild
   per character, and loses the live-range fast path because the merged array is fresh. The plan's
   defence — "already what every window parse does" — was wrong: window parses are scroll-triggered, not
   per-character. **The plan no longer merges into the token array.**
2. *A merge in `setTokens` is bypassed on scroll-back.* Verified at
   `EditorSyntaxController.repaintCachedVisibleSyntaxRange`. The reviewer's second citation was not a
   bypass — it is the `adoptTokens` option callback both paths funnel into, and is therefore the one
   chokepoint covering everything.
3. *No channel exists for a plugin to supply tokens.* Verified for an *overlay*. The reviewer's
   unconsidered fourth option — the range-highlight channel, already exposed, already priority-aware,
   already windowed to mounted rows — is the right answer and is the shape taken. (Pass 3 note: the
   finding as stated is too strong. `EditorHighlighterProvider` **is** a plugin-registered token channel
   and shiki uses it; it does not solve this problem because it *replaces* the syntactic layer rather
   than overlaying it, and the plan now says that rather than saying the channel is absent.)
4. *No test in `packages/typescript-lsp` has run a real language service.* Verified. Promoted to
   Milestone 2, with the lib-map-from-disk and the `vi.mock` module-scope problem both named.
5. *"Asserts the painted colour" is not observable.* Verified: `::highlight()` styles are not reachable
   through `getComputedStyle`. The house already answered this with the happy-dom Map-backed registry and
   `MockHighlight`; every paint-order criterion names that harness.
7. *M1 was about to break error diagnostics.* Verified: `DIAGNOSTIC_STYLES.error` declares `color` with
   no `zIndex`, so it sits at 0 alongside every token highlight, and find sits at 1/2/3. Giving tokens a
   positive band would have made every token outrank the error's colour. The priority space is now
   tabulated and the band is explicit with a regression assertion.
8. *The cheapest form of M1 was de-scoped by an argument that did not apply to it.* Verified:
   `treeSitterCapturesToEditorTokens` runs in the worker with `captureName` in hand. M1 is now worker-side
   exact-span resolution — one function, no wire change, no style-key change, no priority hazard.
9. *M1 was building the semantic layer's mechanism while claiming to be standalone.* Accepted, resolved
   by 8: style-carried priority is gone from the unconditional work entirely.
10. *The `$/cancelRequest` prerequisite cannot do what the plan said.* Verified for the in-process
    worker; the risk item about a queue of stale type-checks was deleted because there is no queue.
    (Pass 3 note: reversed for the product — see §C8.)
12. *M0 uncovered a live defect and filed it as a design input.* Verified: `text.emphasis` and
    `text.strong` declare **only** a font property, so an inert rule is emitted and those markdown tokens
    paint nothing at all today, on both the tree-sitter and shiki paths. M0 is now a fix with a
    failing-today test, not a measurement.
13. *Wrong prerequisite citation.* Verified: `lineStartForSnapshotLine` and `rowForOffset` are
    module-private. Corrected to `lspPositionToOffsetInSnapshot`, with the mistake left visible.
14. *M4 didn't name the hook it needed.* Accepted; under shape (d) the milestone no longer needs the
    syntax controller's edit hooks at all, because `trackRanges` handles the batch edits single-edit token
    projection cannot.
15. *Two exit criteria passed with the feature absent.* Accepted. Both are folded into single-fixture
    assertions carrying positive and negative expectations together.

**Accepted with the reviewer's reasoning corrected.**

6. *M0's method could not see what M0 named.* The reviewer is right that geometry and `getComputedStyle`
   cannot answer whether `::highlight()` applies font properties — highlight pseudo-elements never affect
   layout. But the conclusion that only a rendered-pixel comparison is honest concedes too much: the
   question is settled twice over, by CSS Pseudo-Elements 4 and by this repo's own range path, where
   `VirtualizedTextHighlightStyle` offers no font properties and `rangeHighlightRule` emits none. M0 needs
   no pixel infrastructure — it needs the token path to stop emitting declarations the range path never
   offered.
11. *"We replace the style wholesale" is not what the mechanism does.* Correct, and it matters more than
    the reviewer said. Because the CSS Custom Highlight API resolves **per property**, the semantic layer
    gets fall-through for free — listed as a benefit of shape (d) rather than a de-scoping. It is also
    what makes the priority table tractable: only three producers declare `color`, so only three contend.

**Rejected or narrowed.** The `adoptTokens` option callback is the sink both adoption paths reach, not an
independent path around them. Per-painted-row merging (shape b) is costed and not taken, so the plan is
not offering a fallback it refuses to name. And "restores `nonOverlapping`" is stronger than the
evidence, so M1 measures the value and records it rather than asserting it.

**The reviewer's overall recommendation that the conditional milestones not be built** was answered in
Pass 1 by absorbing its cost objections. Pass 3 changes the answer in the other direction: the largest
argument against building — that the feature is incremental over colour we already have — was measured
against the wrong consumer and does not hold. The recommendation now stands as written in *Verdict, up
front*: build M0 through M3; ask before M4.
