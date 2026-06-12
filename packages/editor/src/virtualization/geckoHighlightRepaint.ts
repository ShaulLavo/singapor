import type { HighlightRegistry } from './virtualizedTextViewTypes'

// WORKAROUND (Gecko): after Highlight range mutations over recycled text nodes
// (row virtualization rewrites `textNode.data` in place, then swaps the row's
// StaticRanges), Firefox intermittently keeps painting ::highlight() from a
// stale snapshot: token colors land at the previous row's offsets (words split
// across colors) or later-registered override buckets stop painting. The
// registered ranges are verifiably correct when this happens — re-registering
// every registry entry in order forces Gecko to rebuild highlight paint.
// Chromium and WebKit do not need this. See docs/display/browser-quirks.md.

const pendingRegistries = new WeakSet<HighlightRegistry>()
let nudgeEnabled: boolean | null = null

export function scheduleHighlightRepaintNudge(
  document: Document,
  registry: HighlightRegistry | null,
): void {
  if (!registry?.entries) return
  if (!highlightRepaintNudgeEnabled(document)) return
  if (pendingRegistries.has(registry)) return

  pendingRegistries.add(registry)
  queueMicrotask(() => {
    pendingRegistries.delete(registry)
    reregisterHighlights(registry)
  })
}

export function reregisterHighlights(registry: HighlightRegistry): void {
  if (!registry.entries) return

  const entries = Array.from(registry.entries())
  for (const [name] of entries) registry.delete(name)
  for (const [name, highlight] of entries) registry.set(name, highlight)
}

/** Force the Gecko nudge on/off; pass `null` to restore engine detection. */
export function setHighlightRepaintNudgeEnabled(enabled: boolean | null): void {
  nudgeEnabled = enabled
}

function highlightRepaintNudgeEnabled(document: Document): boolean {
  if (nudgeEnabled !== null) return nudgeEnabled

  nudgeEnabled = 'MozAppearance' in document.documentElement.style
  return nudgeEnabled
}
