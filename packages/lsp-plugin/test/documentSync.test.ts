import type { EditorViewSnapshot } from '@singapor/core/extensions'
import { LspWorkspace, type LspDocumentChange, type LspWorkspaceSyncTarget } from '@singapor/lsp'
import { describe, expect, it, vi } from 'vitest'
import type * as lsp from 'vscode-languageserver-protocol'

import { DocumentSync, type DocumentSyncDiagnosticsPresenter } from '../src/documentSync'

describe('DocumentSync', () => {
  it('opens, updates, and closes documents through the LSP workspace', () => {
    const workspace = new LspWorkspace()
    const presenter = new TestPresenter()
    const onDocumentClosed = vi.fn()
    const sync = new DocumentSync(workspace, presenter, { onDocumentClosed })

    sync.sync(editorSnapshot({ fullText: 'let value = 1;' }), null)
    expect(sync.activeDocument?.lspVersion).toBe(0)
    expect(workspace.getDocument('file:///src/index.ts')?.text).toBe('let value = 1;')

    sync.sync(editorSnapshot({ fullText: 'let value = 2;', textVersion: 1 }), null)
    expect(sync.activeDocument?.lspVersion).toBe(1)
    expect(workspace.getDocument('file:///src/index.ts')?.text).toBe('let value = 2;')

    onDocumentClosed.mockClear()
    sync.close()

    expect(onDocumentClosed).toHaveBeenCalledOnce()
    expect(presenter.clear).toHaveBeenCalledOnce()
    expect(workspace.getDocument('file:///src/index.ts')).toBeNull()
    expect(presenter.publishSummary).toHaveBeenLastCalledWith('file:///src/index.ts', 1, [])
  })

  it('filters descriptors through language and URI predicates', () => {
    const workspace = new LspWorkspace()
    const sync = new DocumentSync(workspace, new TestPresenter(), {
      onDocumentClosed: vi.fn(),
      shouldSyncLanguageId: (languageId) => languageId === 'typescript',
      shouldSyncUri: (uri) => uri.endsWith('.ts'),
    })

    sync.sync(editorSnapshot({ languageId: 'markdown' }), null)
    expect(sync.activeDocument).toBeNull()

    sync.sync(editorSnapshot({ documentId: 'src/readme.md' }), null)
    expect(sync.activeDocument).toBeNull()

    sync.sync(editorSnapshot({ documentId: 'src/index.ts' }), null)
    expect(sync.activeDocument?.uri).toBe('file:///src/index.ts')
  })

  it('renders matching diagnostics and ignores stale versions', () => {
    const workspace = new LspWorkspace()
    const presenter = new TestPresenter()
    const sync = new DocumentSync(workspace, presenter, { onDocumentClosed: vi.fn() })

    sync.sync(editorSnapshot({ fullText: 'abc' }), null)
    sync.publishDiagnostics({
      uri: 'file:///src/index.ts',
      version: 0,
      diagnostics: [diagnostic(1, 0, 1)],
    })
    sync.publishDiagnostics({
      uri: 'file:///src/index.ts',
      version: 99,
      diagnostics: [diagnostic(2, 1, 2)],
    })

    expect(sync.diagnostics).toHaveLength(1)
    expect(presenter.render).toHaveBeenCalledOnce()
    expect(presenter.publishSummary).toHaveBeenCalledWith('file:///src/index.ts', 0, [
      diagnostic(1, 0, 1),
    ])
  })

  it('emits shared document sync events in open/change/close ordering', () => {
    const workspace = new LspWorkspace()
    const target = new SyncTargetRecorder()
    workspace.attachClient(target)
    const sync = new DocumentSync(workspace, new TestPresenter(), {
      onDocumentClosed: vi.fn(),
    })

    sync.sync(editorSnapshot({ documentId: 'src/index.ts', fullText: 'let value = 1;' }), null)
    sync.sync(
      editorSnapshot({
        documentId: 'src/index.ts',
        fullText: 'let value = 2;',
        textVersion: 2,
      }),
      documentChange([{ from: 12, to: 13, text: '2' }]),
    )
    sync.sync(
      editorSnapshot({
        documentId: 'src/other.ts',
        fullText: 'export const other = 1;',
        textVersion: 3,
      }),
      null,
    )
    sync.close()

    expect(target.events).toEqual([
      'open:file:///src/index.ts:0:let value = 1;',
      'change:file:///src/index.ts:1:12-13=2',
      'close:file:///src/index.ts:1',
      'open:file:///src/other.ts:0:export const other = 1;',
      'close:file:///src/other.ts:0',
    ])
  })
})

class TestPresenter implements DocumentSyncDiagnosticsPresenter {
  public readonly clear = vi.fn()
  public readonly render = vi.fn()
  public readonly publishSummary = vi.fn()
}

class SyncTargetRecorder implements LspWorkspaceSyncTarget {
  public readonly events: string[] = []

  public didOpenDocument(document: Parameters<LspWorkspaceSyncTarget['didOpenDocument']>[0]): void {
    this.events.push(`open:${document.uri}:${document.version}:${document.text}`)
  }

  public didChangeDocument(
    document: Parameters<LspWorkspaceSyncTarget['didChangeDocument']>[0],
    change: LspDocumentChange,
  ): void {
    this.events.push(`change:${document.uri}:${document.version}:${editsText(change)}`)
  }

  public didSaveDocument(): void {
    this.events.push('save')
  }

  public didCloseDocument(
    document: Parameters<LspWorkspaceSyncTarget['didCloseDocument']>[0],
  ): void {
    this.events.push(`close:${document.uri}:${document.version}`)
  }
}

function editorSnapshot(options: {
  readonly documentId?: string | null
  readonly languageId?: string | null
  readonly fullText?: string
  readonly textVersion?: number
}): EditorViewSnapshot {
  const fullText = options.fullText ?? 'const value = 1;'
  return {
    documentId: options.documentId ?? 'src/index.ts',
    languageId: options.languageId ?? 'typescript',
    fullText,
    lineStarts: [0],
    lineCount: 1,
    textVersion: options.textVersion ?? 0,
    textSnapshot: stringTextSnapshot(fullText),
  } as unknown as EditorViewSnapshot
}

function stringTextSnapshot(text: string): EditorViewSnapshot['textSnapshot'] {
  return {
    length: text.length,
    materializeFullText: () => text,
    readRange: (start, end) => text.slice(start, end),
    forEachTextChunk: (visit) => visit(text, 0, text.length),
  }
}

function documentChange(
  edits: readonly { readonly from: number; readonly to: number; readonly text: string }[],
): Parameters<DocumentSync['sync']>[1] {
  return {
    kind: 'edit',
    edits,
  } as unknown as Parameters<DocumentSync['sync']>[1]
}

function editsText(change: LspDocumentChange): string {
  if (change.edits.length === 0) return 'full'
  return change.edits.map((edit) => `${edit.from}-${edit.to}=${edit.text}`).join(',')
}

function diagnostic(severity: lsp.DiagnosticSeverity, start: number, end: number): lsp.Diagnostic {
  return {
    severity,
    message: 'message',
    range: {
      start: { line: 0, character: start },
      end: { line: 0, character: end },
    },
  }
}
