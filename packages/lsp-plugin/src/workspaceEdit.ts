import type * as lsp from 'vscode-languageserver-protocol'

export type WorkspaceEditDocument = {
  readonly uri: string
  readonly edits: readonly lsp.TextEdit[]
}

export type WorkspaceEditPlan = {
  /** Text edits grouped per document, in the order the server listed them. */
  readonly documents: readonly WorkspaceEditDocument[]
  /**
   * Resource operations (create/rename/delete file) the server asked for. Kept separate because a
   * client that cannot perform them must refuse the whole edit rather than apply half of it.
   */
  readonly resourceOperations: readonly string[]
}

/**
 * Flattens a WorkspaceEdit into per-document text edits.
 *
 * Both shapes are handled: the legacy `changes` map and `documentChanges`, which is what servers
 * send once the client advertises it. Versioned document edits carry the version the server based
 * them on; it is deliberately dropped here, because this client has no way to prove the document
 * has not moved since and pretending otherwise would be worse than not claiming it.
 */
export function workspaceEditPlan(edit: lsp.WorkspaceEdit | null | undefined): WorkspaceEditPlan {
  if (!edit) return { documents: [], resourceOperations: [] }

  if (edit.documentChanges) return planFromDocumentChanges(edit.documentChanges)

  return { documents: planFromChanges(edit.changes), resourceOperations: [] }
}

/** True when the plan touches anything but `uri` — the caller cannot apply it as a local edit. */
export function workspaceEditTouchesOtherDocuments(plan: WorkspaceEditPlan, uri: string): boolean {
  if (plan.resourceOperations.length > 0) return true

  return plan.documents.some((document) => document.uri !== uri && document.edits.length > 0)
}

export function workspaceEditForDocument(
  plan: WorkspaceEditPlan,
  uri: string,
): readonly lsp.TextEdit[] {
  return plan.documents.find((document) => document.uri === uri)?.edits ?? []
}

function planFromChanges(
  changes: lsp.WorkspaceEdit['changes'],
): readonly WorkspaceEditDocument[] {
  if (!changes) return []

  return Object.entries(changes).map(([uri, edits]) => ({ edits, uri }))
}

function planFromDocumentChanges(
  documentChanges: NonNullable<lsp.WorkspaceEdit['documentChanges']>,
): WorkspaceEditPlan {
  const documents: WorkspaceEditDocument[] = []
  const resourceOperations: string[] = []

  for (const change of documentChanges) {
    if ('kind' in change) {
      resourceOperations.push(change.kind)
      continue
    }

    // documentChanges may carry annotated edits (plain text plus a label) or snippet edits. The
    // annotation is dropped, but a snippet edit is recorded as unsupported rather than skipped:
    // applying the rest would be a partial edit presented as a whole one.
    const edits: lsp.TextEdit[] = []
    for (const entry of change.edits) {
      if (!('newText' in entry)) {
        resourceOperations.push('snippet')
        continue
      }

      edits.push({ newText: entry.newText, range: entry.range })
    }

    documents.push({ edits, uri: change.textDocument.uri })
  }

  return { documents, resourceOperations }
}
