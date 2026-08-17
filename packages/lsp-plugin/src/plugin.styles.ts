import type { VirtualizedTextHighlightStyle } from '@singapor/core/rendering'

import type { LanguageServerDiagnosticSeverity } from './diagnostics'

/**
 * Highlight style applied to the identifier range under the pointer while the
 * user holds the navigation modifier (Cmd on macOS, Ctrl elsewhere) over a
 * jumpable definition. Renders as a transparent-background token with a
 * blue underline so the editor's base syntax colouring stays visible and the
 * affordance matches familiar IDE go-to-definition visuals. The colour
 * (`#60a5fa`, Tailwind blue-400) is chosen to read on both light and dark
 * editor themes without piercing through the foreground text.
 */
export const LINK_HIGHLIGHT_STYLE: VirtualizedTextHighlightStyle = {
  backgroundColor: 'transparent',
  color: '#60a5fa',
  textDecoration: 'underline solid #60a5fa',
}

/**
 * Per-severity highlight styles applied by the Language Server plugin to the
 * ranges produced by `diagnosticHighlightGroups`. Errors get a translucent
 * red background plus a wavy red underline so they are unmistakable even on
 * noisy syntax colouring; warnings / information / hints get progressively
 * subtler translucent backgrounds (amber / blue / slate) with no underline,
 * following the severity ordering the styling is meant to convey. All colours
 * are expressed as alpha-blended RGB so they compose over any editor theme
 * without hard-coding a foreground/background pair.
 */
export const DIAGNOSTIC_STYLES: Record<
  LanguageServerDiagnosticSeverity,
  VirtualizedTextHighlightStyle
> = {
  error: {
    backgroundColor: 'rgba(239, 68, 68, 0.16)',
    color: 'rgba(248, 113, 113, 1)',
    textDecoration: 'underline wavy rgba(220, 38, 38, 1)',
  },
  warning: { backgroundColor: 'rgba(245, 158, 11, 0.26)' },
  information: { backgroundColor: 'rgba(59, 130, 246, 0.22)' },
  hint: { backgroundColor: 'rgba(148, 163, 184, 0.22)' },
}
