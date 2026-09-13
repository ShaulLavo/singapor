import { createStringTextSnapshot } from '@singapore-editor/core/document'
import type { EditorViewSnapshot } from '@singapore-editor/core/extensions'
import { arrayLspLineStarts, type LspTextDocumentSnapshot } from '@singapore-editor/lsp'

/**
 * The view's text and line-start index as an LSP document snapshot, so position conversion
 * never rescans the text. Plain-array line starts (tests) adapt lazily.
 */
export function viewDocumentSnapshot(snapshot: EditorViewSnapshot): LspTextDocumentSnapshot {
  return {
    textSnapshot: snapshot.textSnapshot ?? createStringTextSnapshot(snapshot.fullText),
    lineStarts: snapshot.lineStartsView ?? arrayLspLineStarts(snapshot.lineStarts),
  }
}
