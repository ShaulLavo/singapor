import type * as lsp from "vscode-languageserver-protocol";
import type { LspClient } from "./client";
import type {
  LspDocument,
  LspDocumentOpenOptions,
  LspTextEdit,
  LspWorkspaceEditOptions,
} from "./types";

type MutableLspDocument = {
  uri: lsp.DocumentUri;
  languageId: string;
  version: number;
  text: string;
};

export class LspWorkspace {
  private readonly documentsByUri = new Map<lsp.DocumentUri, MutableLspDocument>();
  private readonly versionsByUri = new Map<lsp.DocumentUri, number>();
  private client: LspClient | null = null;

  public get documents(): readonly LspDocument[] {
    return [...this.documentsByUri.values()].map(cloneDocument);
  }

  public attachClient(client: LspClient): void {
    this.client = client;
  }

  public openDocument(options: LspDocumentOpenOptions): LspDocument {
    if (this.documentsByUri.has(options.uri)) {
      throw new Error(`LSP document already open: ${options.uri}`);
    }

    const document = {
      uri: options.uri,
      languageId: options.languageId,
      text: options.text,
      version: this.nextVersion(options.uri),
    };
    this.documentsByUri.set(options.uri, document);
    this.client?.didOpenDocument(document);
    return cloneDocument(document);
  }

  public updateDocument(
    uri: lsp.DocumentUri,
    text: string,
    options: LspWorkspaceEditOptions = {},
  ): LspDocument {
    const document = this.requireDocument(uri);
    const previousText = document.text;
    if (previousText === text && !hasEffectiveEdits(options.edits)) return cloneDocument(document);

    document.text = text;
    document.version = this.nextVersion(uri);
    this.client?.didChangeDocument(document, previousText, options.edits ?? []);
    return cloneDocument(document);
  }

  public closeDocument(uri: lsp.DocumentUri): void {
    const document = this.documentsByUri.get(uri);
    if (!document) return;

    this.documentsByUri.delete(uri);
    this.client?.didCloseDocument(document);
  }

  public getDocument(uri: lsp.DocumentUri): LspDocument | null {
    const document = this.documentsByUri.get(uri);
    return document ? cloneDocument(document) : null;
  }

  public connected(): void {
    for (const document of this.documentsByUri.values()) {
      this.client?.didOpenDocument(document);
    }
  }

  public disconnected(): void {
    return;
  }

  private nextVersion(uri: lsp.DocumentUri): number {
    const version = (this.versionsByUri.get(uri) ?? -1) + 1;
    this.versionsByUri.set(uri, version);
    return version;
  }

  private requireDocument(uri: lsp.DocumentUri): MutableLspDocument {
    const document = this.documentsByUri.get(uri);
    if (document) return document;
    throw new Error(`LSP document is not open: ${uri}`);
  }
}

const cloneDocument = (document: MutableLspDocument): LspDocument => ({ ...document });

const hasEffectiveEdits = (edits: readonly LspTextEdit[] | undefined): boolean => {
  if (!edits) return false;
  return edits.some((edit) => edit.from !== edit.to || edit.text.length > 0);
};
