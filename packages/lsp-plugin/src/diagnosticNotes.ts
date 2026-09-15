import type { TooltipNote } from '@singapore-editor/plugin-ui'
import type * as lsp from 'vscode-languageserver-protocol'

import { DIAGNOSTIC_FOREGROUND_COLORS } from './plugin.styles'

/** The lines a hover shows under its text for the diagnostics at that offset. */
export function diagnosticNotes(diagnostics: readonly lsp.Diagnostic[]): readonly TooltipNote[] {
  return diagnostics.map(diagnosticNote)
}

function diagnosticNote(diagnostic: lsp.Diagnostic): TooltipNote {
  return {
    label: severityLabel(diagnostic),
    color: severityColor(diagnostic),
    text: typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value,
  }
}

function severityLabel(diagnostic: lsp.Diagnostic): string {
  if (diagnostic.severity === 2) return 'warning'
  if (diagnostic.severity === 3) return 'info'
  if (diagnostic.severity === 4) return 'hint'
  return 'error'
}

function severityColor(diagnostic: lsp.Diagnostic): string {
  if (diagnostic.severity === 2) return DIAGNOSTIC_FOREGROUND_COLORS.warning
  if (diagnostic.severity === 3) return DIAGNOSTIC_FOREGROUND_COLORS.information
  if (diagnostic.severity === 4) return DIAGNOSTIC_FOREGROUND_COLORS.hint
  return DIAGNOSTIC_FOREGROUND_COLORS.error
}
