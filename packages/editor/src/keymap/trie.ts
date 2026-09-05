import {
  normalizeKeyName,
  normalizeRegisterableHotkey,
  parseHotkey,
  rawHotkeyToParsedHotkey,
} from '@tanstack/hotkeys'
import type { KeymapBinding, KeymapPlatform } from './types'

export type KeymapNode<Payload> = {
  readonly next: ReadonlyMap<string, KeymapEdge<Payload>>
  readonly candidates: readonly KeymapBinding<Payload>[]
  readonly descendants: readonly KeymapBinding<Payload>[]
}
export type KeymapEdge<Payload> = { readonly keys: string; readonly node: KeymapNode<Payload> }
type MutableNode<Payload> = {
  next: Map<string, { keys: string; node: MutableNode<Payload> }>
  candidates: KeymapBinding<Payload>[]
  descendants: KeymapBinding<Payload>[]
}
export function buildKeymapTrie<Payload>(
  bindings: readonly KeymapBinding<Payload>[],
  platform: KeymapPlatform,
): KeymapNode<Payload> {
  const root = emptyNode<Payload>()
  for (const binding of bindings) insertBinding(root, binding, platform)
  return root
}
function emptyNode<Payload>(): MutableNode<Payload> {
  return { next: new Map(), candidates: [], descendants: [] }
}
function insertBinding<Payload>(
  root: MutableNode<Payload>,
  binding: KeymapBinding<Payload>,
  platform: KeymapPlatform,
) {
  let node = root
  for (const stroke of binding.chord) {
    node.descendants.push(binding)
    const parsed =
      typeof stroke === 'string'
        ? parseHotkey(stroke, platform)
        : rawHotkeyToParsedHotkey(stroke, platform)
    const identity = edgeKey(parsed.key, parsed.alt, parsed.ctrl, parsed.meta, parsed.shift)
    let edge = node.next.get(identity)
    if (!edge) edge = { keys: normalizeRegisterableHotkey(stroke, platform), node: emptyNode() }
    node.next.set(identity, edge)
    node = edge.node
  }
  node.candidates.push(binding)
}
export function trieStep<Payload>(
  node: KeymapNode<Payload>,
  event: Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): KeymapEdge<Payload> | null {
  const printed = normalizeKeyName(event.key)
  const edge = node.next.get(
    edgeKey(printed, event.altKey, event.ctrlKey, event.metaKey, event.shiftKey),
  )
  if (edge) return edge
  // A Latin layout owns its printed letters; AZERTY Z must not activate physical W.
  if (/^[a-z]$/i.test(printed)) return null
  const physical = physicalKeyName(event.code)
  if (!physical) return null
  return (
    node.next.get(edgeKey(physical, event.altKey, event.ctrlKey, event.metaKey, event.shiftKey)) ??
    null
  )
}
function edgeKey(key: string, alt: boolean, ctrl: boolean, meta: boolean, shift: boolean): string {
  return `${key}:${(alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0)}`
}
const punctuation: Readonly<Record<string, string>> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
}
function physicalKeyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)?.[1]
  if (letter) return letter
  const digit = /^Digit([0-9])$/.exec(code)?.[1]
  return digit ?? punctuation[code] ?? null
}
