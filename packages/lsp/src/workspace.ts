import type * as lsp from 'vscode-languageserver-protocol'
import type {
  LspLineStarts,
  LspDocument,
  LspDocumentOpenOptions,
  LspTextDocumentSnapshot,
  LspTextSnapshot,
  LspTextEdit,
  LspWorkspaceSyncTarget,
  LspWorkspaceEditOptions,
  LspWorkspaceSnapshotEditOptions,
} from './types'
import { registerDefaultLspWorkspaceFactory } from './workspaceFactory'

type MutableLspDocument = {
  uri: lsp.DocumentUri
  languageId: string
  version: number
  textCache?: string
  textSnapshot: LspTextSnapshot
  lineStarts: LspLineStarts
}

export class LspWorkspace {
  private readonly documentsByUri = new Map<lsp.DocumentUri, MutableLspDocument>()
  private readonly versionsByUri = new Map<lsp.DocumentUri, number>()
  /**
   * How many holders have this uri open.
   *
   * One workspace can be shared by several views — a split, a peek pane, two
   * tabs on one file — and `didOpen`/`didClose` are statements about the server's
   * copy of a document, not about any one view's interest in it. Counting is what
   * keeps the second view opening a file from being an error, and the first view
   * closing it from telling the server a document is gone while another view is
   * still editing it.
   */
  private readonly openCountsByUri = new Map<lsp.DocumentUri, number>()
  private client: LspWorkspaceSyncTarget | null = null

  public get documents(): readonly LspDocument[] {
    return Array.from(this.documentsByUri.values()).map(cloneDocument)
  }

  public attachClient(client: LspWorkspaceSyncTarget): void {
    this.client = client
  }

  public openDocument(options: LspDocumentOpenOptions): LspDocument {
    const open = this.documentsByUri.get(options.uri)
    if (open) return this.reopenDocument(open, options)

    this.openCountsByUri.set(options.uri, 1)
    const document = {
      uri: options.uri,
      languageId: options.languageId,
      textCache: options.text,
      textSnapshot: createStringTextSnapshot(options.text),
      lineStarts: arrayLspLineStarts(computeLineStarts(options.text)),
      version: this.nextVersion(options.uri),
    }
    this.documentsByUri.set(options.uri, document)
    this.client?.didOpenDocument(cloneDocument(document))
    return cloneDocument(document)
  }

  public updateDocument(
    uri: lsp.DocumentUri,
    text: string,
    options: LspWorkspaceEditOptions = {},
  ): LspDocument {
    const document = this.requireDocument(uri)
    const previousText = materializeDocumentText(document)
    if (previousText === text && !hasEffectiveEdits(options.edits)) return cloneDocument(document)

    const previousSnapshot = documentSnapshot(document)
    document.textCache = text
    document.textSnapshot = createStringTextSnapshot(text)
    document.lineStarts = arrayLspLineStarts(computeLineStarts(text))
    document.version = this.nextVersion(uri)
    this.client?.didChangeDocument(cloneDocument(document), {
      edits: options.edits ?? [],
      previousSnapshot,
      previousText,
    })
    return cloneDocument(document)
  }

  public updateDocumentSnapshot(
    uri: lsp.DocumentUri,
    options: LspWorkspaceSnapshotEditOptions,
  ): LspDocument {
    const document = this.requireDocument(uri)
    const previousSnapshot = documentSnapshot(document)
    if (sameSnapshotDocument(previousSnapshot, options) && !hasEffectiveEdits(options.edits)) {
      return cloneDocument(document)
    }

    document.textCache = undefined
    document.textSnapshot = options.textSnapshot
    document.lineStarts = options.lineStarts
    document.version = this.nextVersion(uri)
    this.client?.didChangeDocument(cloneDocument(document), {
      edits: options.edits ?? [],
      previousSnapshot,
    })
    return cloneDocument(document)
  }

  public closeDocument(uri: lsp.DocumentUri): void {
    const document = this.documentsByUri.get(uri)
    if (!document) return

    const remaining = (this.openCountsByUri.get(uri) ?? 1) - 1
    if (remaining > 0) {
      this.openCountsByUri.set(uri, remaining)
      return
    }

    this.openCountsByUri.delete(uri)
    this.documentsByUri.delete(uri)
    this.client?.didCloseDocument(cloneDocument(document))
  }

  /**
   * A second holder opening a document the server already has.
   *
   * No `didOpen`: the server's copy exists and re-announcing it is a protocol
   * error. The text is still reconciled, because the newest opener is the one
   * that just read the file and a stale server copy is worse than a redundant
   * `didChange` — `updateDocument` sends nothing when the text already matches,
   * which is the ordinary case of two views on one buffer.
   */
  private reopenDocument(
    open: MutableLspDocument,
    options: LspDocumentOpenOptions,
  ): LspDocument {
    this.openCountsByUri.set(options.uri, (this.openCountsByUri.get(options.uri) ?? 1) + 1)
    if (open.languageId !== options.languageId) {
      throw new Error(
        `LSP document open as ${open.languageId}, reopened as ${options.languageId}: ${options.uri}`,
      )
    }

    return this.updateDocument(options.uri, options.text)
  }

  public saveDocument(uri: lsp.DocumentUri): void {
    const document = this.documentsByUri.get(uri)
    if (!document) return

    this.client?.didSaveDocument(cloneDocument(document))
  }

  public getDocument(uri: lsp.DocumentUri): LspDocument | null {
    const document = this.documentsByUri.get(uri)
    return document ? cloneDocument(document) : null
  }

  public connected(): void {
    for (const document of this.documentsByUri.values()) {
      this.client?.didOpenDocument(cloneDocument(document))
    }
  }

  public disconnected(): void {
    return
  }

  private nextVersion(uri: lsp.DocumentUri): number {
    const version = (this.versionsByUri.get(uri) ?? -1) + 1
    this.versionsByUri.set(uri, version)
    return version
  }

  private requireDocument(uri: lsp.DocumentUri): MutableLspDocument {
    const document = this.documentsByUri.get(uri)
    if (document) return document
    throw new Error(`LSP document is not open: ${uri}`)
  }
}

function cloneDocument(document: MutableLspDocument): LspDocument {
  return defineLazyDocumentText({
    uri: document.uri,
    languageId: document.languageId,
    version: document.version,
    textSnapshot: document.textSnapshot,
    lineStarts: document.lineStarts,
  })
}

function defineLazyDocumentText<TDocument extends Omit<LspDocument, 'text'>>(
  document: TDocument,
): TDocument & { readonly text: string } {
  Object.defineProperty(document, 'text', {
    configurable: true,
    enumerable: true,
    get: () => document.textSnapshot.materializeFullText(),
  })
  return document as TDocument & { readonly text: string }
}

function documentSnapshot(document: MutableLspDocument): LspTextDocumentSnapshot {
  return {
    textSnapshot: document.textSnapshot,
    lineStarts: document.lineStarts,
  }
}

function materializeDocumentText(document: MutableLspDocument): string {
  return document.textCache ?? document.textSnapshot.materializeFullText()
}

function createStringTextSnapshot(text: string): LspTextSnapshot {
  return {
    length: text.length,
    materializeFullText: () => text,
    readRange: (start, end) => text.slice(start, end),
  }
}

export function arrayLspLineStarts(lineStarts: readonly number[]): LspLineStarts {
  return {
    length: lineStarts.length,
    at: (index) => lineStarts[index],
    indexForOffset: (offset) => arrayRowForOffset(lineStarts, offset),
    toArray: () => lineStarts,
  }
}

function arrayRowForOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0
  let high = lineStarts.length - 1
  let row = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    if ((lineStarts[middle] ?? 0) <= offset) {
      row = middle
      low = middle + 1
      continue
    }
    high = middle - 1
  }
  return row
}

function computeLineStarts(text: string): number[] {
  const starts = [0]
  let index = text.indexOf('\n')

  while (index !== -1) {
    starts.push(index + 1)
    index = text.indexOf('\n', index + 1)
  }

  return starts
}

function sameSnapshotDocument(
  left: LspTextDocumentSnapshot,
  right: LspTextDocumentSnapshot,
): boolean {
  return left.textSnapshot === right.textSnapshot && left.lineStarts === right.lineStarts
}

const hasEffectiveEdits = (edits: readonly LspTextEdit[] | undefined): boolean => {
  if (!edits) return false
  return edits.some((edit) => edit.from !== edit.to || edit.text.length > 0)
}

registerDefaultLspWorkspaceFactory(() => new LspWorkspace())
