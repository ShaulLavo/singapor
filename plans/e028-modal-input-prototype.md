# E028: Prove modal editing through public extensions

- Status: Proposed
- Kind: Research
- Owner: Editor
- Priority: P2
- Effort: M
- Dependencies: [E026](e026-command-metadata.md), [E027](e027-extension-hooks.md)
- Inspected baseline: Editor `9abb944f3a2b8d6516953fdec75e8df5e1a94811`.

## Outcome

Build a small modal editing plugin entirely through supported package exports. Use it to
expose assumptions that prevent third-party input behavior before the runtime plugin API
is declared stable. The deliverable includes the plugin, its browser proof, and a gap report.

The reference interaction is `i`, type text, Escape, `3w`, `dw`, Undo. Normal mode must not
insert the command letters. Insert mode must retain normal browser text input and composition.
The same document opened in another view must not inherit the first view's mode accidentally.

## Current code

[The public keymap API](../packages/editor/src/public/keymap.ts) already exports chord
recognition, cancellation, and binding updates. [The runtime types](../packages/editor/src/keymap/types.ts)
accept arbitrary typed payloads. No new chord recognizer is needed for this prototype.

[Editor keymap presets](../packages/editor/src/keymap/presets.ts) currently bind a finite
`EditorCommandId`. [Command context](../packages/editor/src/editor/commands.ts) carries only
a keyboard event. E026 addresses metadata and a typed path for contributed commands.

[InputSelectionController](../packages/editor/src/editor/inputSelectionController.ts) owns
beforeinput, hidden textarea reconciliation, composition, and fallback text input.
[inputState.ts](../packages/editor/src/editor/inputState.ts) tracks which source owns selection.
Changing key bindings alone does not establish that normal mode can suppress text input safely.

[Plugin contexts](../packages/editor/src/plugins.ts) expose selection reads, batch edits,
view contributions, and command registration through distinct contexts. They do not promise
a complete replaceable input loop. E027 provides the experimental contract to prove here.

## Scope

Implement normal and insert modes, `h`, `j`, `k`, `l`, `w`, `b`, line start and end,
positive counts, `d` with a motion, `dd`, and one text object, `diw`. Include Escape and Undo.
Add bar and block cursor presentation through a public view option or a narrow new hook.

Document the supported grammar and its differences from Vim. Registers, macros, command-line
mode, visual mode, dot repeat, plugins for Vim, and full compatibility are outside this proof.
Platform integration and a persistent user setting require later host work.

Place the prototype in a proposed `examples/app/src/modal/` feature or a clearly experimental
package if independent package imports make the proof stronger. Do not import core internals
from the plugin. Any required core change must expose a narrow, tested public contract first.

## Design

Model mode and pending input as a discriminated union. Normal idle, count pending, operator
pending, and insert are distinct states. An operator-pending state carries a valid operator
and count. Escape, blur, disable, document replacement, and disposal cancel pending work.

Use the shipped keymap runtime to recognize finite sequences and route typed intents. Keep
Vim grammar state, such as counts and operator composition, in the plugin. Do not implement
another event listener chain that races Editor's keymap or native beforeinput handling.

Use E027's selected consume-or-delegate hook to suppress normal-mode insertion and delegate
insert-mode text to the default input owner. Composition events must not become normal-mode
commands. Specify how a composition started during a mode switch completes or cancels.

Compute motion ranges without committing intermediate selections. Compose an operator with
those ranges, normalize overlap across cursors, and apply one batch edit against one snapshot.
One command produces one undo entry, with selection restoration matching that command.

Mode belongs to the view contribution, not a module-level singleton. Document changes belong
to the document session and can appear in other views without sharing pending command state.
Readonly mode permits motions but rejects edits even through programmatic command dispatch.

Draw block cursors using the existing rendering owner after measuring grapheme geometry.
Keep the hidden input usable for composition and accessibility. Avoid a second cursor overlay
that disagrees with folds, wrapping, bidirectional text, or the browser's active composition.

## Steps

1. Write the finite grammar and expected text, selections, and undo result for each command.
   Trace how the E027 proposal and E026 declarations express each operation.
2. Implement the smallest missing public input operation. Migrate the default handler through
   it and prove normal editing still delegates once before building the modal plugin.
3. Implement per-view mode, motion, counts, and cancellation using the shared keymap runtime.
   End with visible mode changes and no stray inserted command letters.
4. Compose delete operators with ranges and one batch edit. Add the text object and multicursor
   normalization only after the single-cursor behavior and undo proof pass.
5. Add block cursor presentation and the demo toggle through public extension mechanisms.
   Exercise folds, wrapped rows, composition, and two views in the running browser demo.
6. Write a proposed `docs/architecture/modal-input-findings.md` with each API obstacle, the
   smallest fix, and remaining limitations. Feed evidence to E025's stability decision.

## Verification

Build core first with `bun run build` from `packages/editor`. Use the existing
[keymap runtime tests](../packages/editor/test/keymap-runtime.test.ts) for relevant changes.
Add pure grammar tests only for count parsing, cancellation, and operator range composition.
They must catch a wrong range or illegal pending state, not duplicate the implementation.

Use [chord browser tests](../packages/editor/test/chords.browser.test.ts) and
[composition browser tests](../packages/editor/test/imeComposition.browser.test.ts) as the
patterns for trusted keyboard and native input. Run affected browser files with
`bun run test --project browser test/chords.browser.test.ts test/imeComposition.browser.test.ts`.

Add browser scenarios for one invocation per event, normal-mode letter suppression, IME in
insert mode, Escape during a pending operator, readonly delete, two views, and disposal.
Use Unicode graphemes, wrapped lines, folded ranges, and overlapping cursors to catch incorrect
motion or cursor geometry. Verify batch undo restores text and selections together.

Run `bun run typecheck` from `packages/react` after public contract changes. The demo must
resolve built exports. Acceptance requires zero internal imports in the plugin and an explicit
go or no-go conclusion on whether the proposed input API supports this bounded grammar.

## Risks and decisions

A successful `keydown` demo can still break IME, dictation, dead keys, or clipboard input.
Do not accept the proof without native input scenarios and single-owner commit behavior.
If the next command requires a broad Editor object escape hatch, stop and redesign that
operation. Keep unsupported Vim behavior documented instead of expanding the prototype forever.
