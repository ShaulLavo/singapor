import type { EditorTokenStyle } from '../tokens'
import { buildHighlightRule } from '../style-utils'
import type { HighlightRegistry } from './virtualizedTextViewTypes'

export type SharedTokenHandle = {
  readonly name: string
  readonly highlight: Highlight
}

type SharedTokenGroup = {
  readonly name: string
  readonly highlight: Highlight
  readonly style: EditorTokenStyle
  refCount: number
}

// Token highlight rules are theme-determined and identical across every editor
// instance, yet the CSS Custom Highlight API registry (`CSS.highlights`) and the
// `::highlight()` style rules are document-global. Letting each editor mint its own
// `<style>` in `<head>` + its own registry entries means every editor mount triggers a
// document-wide style recalc. This shares one ref-counted rule + Highlight per token
// `styleKey` per document, so mounting an editor whose styles already exist costs nothing.
const sharedByDocument = new WeakMap<Document, SharedTokenHighlights>()
let nextSharedTokenId = 0

export function getSharedTokenHighlights(
  doc: Document,
  registry: HighlightRegistry | null,
): SharedTokenHighlights | null {
  if (!registry) return null

  const existing = sharedByDocument.get(doc)
  if (existing) return existing

  const created = new SharedTokenHighlights(doc, registry)
  sharedByDocument.set(doc, created)
  return created
}

export class SharedTokenHighlights {
  readonly #doc: Document
  readonly #registry: HighlightRegistry
  readonly #styleEl: HTMLStyleElement
  readonly #groups = new Map<string, SharedTokenGroup>()
  #rulesDirty = false

  public constructor(doc: Document, registry: HighlightRegistry) {
    this.#doc = doc
    this.#registry = registry
    this.#styleEl = doc.createElement('style')
  }

  public acquire(styleKey: string, style: EditorTokenStyle): SharedTokenHandle {
    const existing = this.#groups.get(styleKey)
    if (existing) {
      existing.refCount += 1
      return { name: existing.name, highlight: existing.highlight }
    }

    const name = `editor-shared-token-${nextSharedTokenId++}`
    const highlight = new Highlight()
    const group: SharedTokenGroup = { name, highlight, style, refCount: 1 }
    this.#groups.set(styleKey, group)
    this.#registry.set(name, highlight)
    this.#rulesDirty = true
    return { name, highlight }
  }

  public release(styleKey: string): void {
    const group = this.#groups.get(styleKey)
    if (!group) return

    group.refCount -= 1
    if (group.refCount > 0) return

    this.#groups.delete(styleKey)
    this.#registry.delete(group.name)
    this.#rulesDirty = true
  }

  // Acquire/release only mark the rule set dirty; the stylesheet is written once per batch
  // when the view flushes its style rules, so adopting N new token styles is a single
  // document style mutation rather than N.
  public flush(): void {
    if (!this.#rulesDirty) return

    this.#rulesDirty = false
    this.#rebuild()
  }

  #rebuild(): void {
    const rules: string[] = []
    for (const group of this.#groups.values())
      rules.push(buildHighlightRule(group.name, group.style))

    const nextRules = rules.join('\n')
    if (this.#styleEl.textContent === nextRules) {
      this.#syncConnection(nextRules)
      return
    }

    this.#styleEl.textContent = nextRules
    this.#syncConnection(nextRules)
  }

  #syncConnection(rules: string): void {
    if (rules.length === 0) {
      this.#styleEl.remove()
      return
    }

    if (this.#styleEl.isConnected) return

    this.#doc.head.appendChild(this.#styleEl)
  }
}
