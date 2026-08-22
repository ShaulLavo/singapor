import { describe, expect, it } from 'vitest'

import { LspWorkspace, type LspDocument } from '../src/index.ts'

type SyncCall =
  | { readonly kind: 'open'; readonly uri: string }
  | { readonly kind: 'change'; readonly uri: string; readonly text: string }
  | { readonly kind: 'close'; readonly uri: string }

/** Records what the workspace decided the server should be told, and nothing else. */
function trackedWorkspace() {
  const calls: SyncCall[] = []
  const workspace = new LspWorkspace()
  workspace.attachClient({
    didOpenDocument: (document: LspDocument) => calls.push({ kind: 'open', uri: document.uri }),
    didChangeDocument: (document: LspDocument) =>
      calls.push({
        kind: 'change',
        text: document.textSnapshot.materializeFullText(),
        uri: document.uri,
      }),
    didCloseDocument: (document: LspDocument) => calls.push({ kind: 'close', uri: document.uri }),
    didSaveDocument: () => {},
  })

  return { calls, workspace }
}

const URI = 'file:///w/a.ts'

describe('LspWorkspace shared open documents', () => {
  it('announces one didOpen however many holders open the same uri', () => {
    const { calls, workspace } = trackedWorkspace()

    workspace.openDocument({ languageId: 'typescript', text: 'const a = 1', uri: URI })
    workspace.openDocument({ languageId: 'typescript', text: 'const a = 1', uri: URI })

    expect(calls).toEqual([{ kind: 'open', uri: URI }])
  })

  it('keeps the document open until the last holder closes it', () => {
    const { calls, workspace } = trackedWorkspace()
    workspace.openDocument({ languageId: 'typescript', text: 'const a = 1', uri: URI })
    workspace.openDocument({ languageId: 'typescript', text: 'const a = 1', uri: URI })

    workspace.closeDocument(URI)

    // The point of the count: one view going away must not tell the server a
    // document another view is still editing has gone.
    expect(workspace.getDocument(URI)).not.toBeNull()
    expect(calls.some((call) => call.kind === 'close')).toBe(false)

    workspace.closeDocument(URI)

    expect(workspace.getDocument(URI)).toBeNull()
    expect(calls.at(-1)).toEqual({ kind: 'close', uri: URI })
  })

  it('reconciles the server copy when a later holder opens newer text', () => {
    const { calls, workspace } = trackedWorkspace()
    workspace.openDocument({ languageId: 'typescript', text: 'const a = 1', uri: URI })

    workspace.openDocument({ languageId: 'typescript', text: 'const a = 2', uri: URI })

    expect(calls).toEqual([
      { kind: 'open', uri: URI },
      { kind: 'change', text: 'const a = 2', uri: URI },
    ])
  })

  it('sends nothing extra when two holders agree about the text', () => {
    const { calls, workspace } = trackedWorkspace()
    workspace.openDocument({ languageId: 'typescript', text: 'const a = 1', uri: URI })

    workspace.openDocument({ languageId: 'typescript', text: 'const a = 1', uri: URI })

    expect(calls.filter((call) => call.kind === 'change')).toEqual([])
  })

  it('reopens cleanly after the count reaches zero', () => {
    const { calls, workspace } = trackedWorkspace()
    workspace.openDocument({ languageId: 'typescript', text: 'const a = 1', uri: URI })
    workspace.closeDocument(URI)

    workspace.openDocument({ languageId: 'typescript', text: 'const a = 1', uri: URI })

    expect(calls).toEqual([
      { kind: 'open', uri: URI },
      { kind: 'close', uri: URI },
      { kind: 'open', uri: URI },
    ])
  })

  it('refuses a reopen that disagrees about the language', () => {
    const { workspace } = trackedWorkspace()
    workspace.openDocument({ languageId: 'typescript', text: 'const a = 1', uri: URI })

    expect(() =>
      workspace.openDocument({ languageId: 'javascript', text: 'const a = 1', uri: URI }),
    ).toThrow(/reopened as javascript/)
  })
})
