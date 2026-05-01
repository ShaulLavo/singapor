import type {
  DocumentSessionChange,
  EditorPlugin,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from "@editor/core";
import type * as lsp from "vscode-languageserver-protocol";
import { LspClient, type LspClientConfig } from "./client";
import type { LspTextEdit } from "./types";
import {
  createWebSocketLspTransport,
  type LspManagedTransport,
  type LspWebSocketTransportOptions,
} from "./transports";
import { LspWorkspace } from "./workspace";

export type LspPluginRoute =
  | string
  | URL
  | ((snapshot: EditorViewSnapshot) => string | URL | null | undefined);

export type LspPluginDocumentUriResolver = (
  snapshot: EditorViewSnapshot,
) => lsp.DocumentUri | null | undefined;

export type LspPluginLanguageIdResolver = (snapshot: EditorViewSnapshot) => string;

export type LspPluginStatus = "idle" | "connecting" | "ready" | "error";

export type LspPluginOptions = {
  readonly route: LspPluginRoute;
  readonly rootUri?: lsp.DocumentUri | null;
  readonly workspaceFolders?: readonly lsp.WorkspaceFolder[] | null;
  readonly clientConfig?: Omit<LspClientConfig, "rootUri" | "workspace" | "workspaceFolders">;
  readonly transportOptions?: LspWebSocketTransportOptions;
  readonly documentUri?: LspPluginDocumentUriResolver;
  readonly languageId?: LspPluginLanguageIdResolver;
  readonly onStatusChange?: (status: LspPluginStatus) => void;
  readonly onError?: (error: unknown) => void;
};

type ActiveConnection = {
  readonly id: number;
  readonly routeKey: string;
  readonly client: LspClient;
  readonly workspace: LspWorkspace;
};

type ActiveDocument = {
  readonly uri: lsp.DocumentUri;
  readonly languageId: string;
  readonly text: string;
  readonly textVersion: number;
};

type DocumentDescriptor = {
  readonly uri: lsp.DocumentUri;
  readonly languageId: string;
  readonly text: string;
  readonly textVersion: number;
};

export function createLspPlugin(options: LspPluginOptions): EditorPlugin {
  return {
    name: "editor.lsp",
    activate(context) {
      return context.registerViewContribution({
        createContribution: (contributionContext) =>
          new LspPluginContribution(contributionContext, options),
      });
    },
  };
}

class LspPluginContribution implements EditorViewContribution {
  private activeConnection: ActiveConnection | null = null;
  private activeDocument: ActiveDocument | null = null;
  private transport: LspManagedTransport | null = null;
  private connectionId = 0;
  private disposed = false;

  public constructor(
    context: EditorViewContributionContext,
    private readonly options: LspPluginOptions,
  ) {
    this.update(context.getSnapshot(), "document", null);
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void {
    if (this.disposed) return;
    if (!shouldSyncDocument(kind, snapshot, this.activeDocument)) return;

    this.syncDocument(snapshot, change ?? null);
  }

  public dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.disconnect();
  }

  private syncDocument(snapshot: EditorViewSnapshot, change: DocumentSessionChange | null): void {
    const descriptor = this.createDocumentDescriptor(snapshot);
    if (!descriptor) {
      this.closeActiveDocument();
      return;
    }

    const connection = this.ensureConnection(snapshot);
    if (!connection) {
      this.closeActiveDocument();
      return;
    }

    this.openOrUpdateDocument(connection.workspace, descriptor, change);
  }

  private ensureConnection(snapshot: EditorViewSnapshot): ActiveConnection | null {
    const route = this.resolveRoute(snapshot);
    if (!route) {
      this.disconnect();
      return null;
    }

    const routeKey = route.toString();
    if (this.activeConnection?.routeKey === routeKey) return this.activeConnection;

    this.disconnect();
    return this.connect(route, routeKey);
  }

  private connect(route: URL, routeKey: string): ActiveConnection {
    const workspace = new LspWorkspace();
    const client = new LspClient({
      ...this.options.clientConfig,
      rootUri: this.options.rootUri ?? null,
      workspaceFolders: this.options.workspaceFolders ?? null,
      workspace,
    });
    const connection: ActiveConnection = {
      id: this.connectionId + 1,
      routeKey,
      client,
      workspace,
    };

    this.connectionId = connection.id;
    this.activeConnection = connection;
    this.setStatus("connecting");
    void this.connectTransport(connection, route);
    return connection;
  }

  private async connectTransport(connection: ActiveConnection, route: URL): Promise<void> {
    try {
      const transport = await createWebSocketLspTransport(route, this.options.transportOptions);
      if (!this.isCurrentConnection(connection)) {
        transport.close();
        return;
      }

      this.transport = transport;
      await connection.client.connect(transport);
      if (this.isCurrentConnection(connection)) this.setStatus("ready");
    } catch (error) {
      if (!this.isCurrentConnection(connection)) return;
      this.setStatus("error");
      this.options.onError?.(error);
    }
  }

  private openOrUpdateDocument(
    workspace: LspWorkspace,
    descriptor: DocumentDescriptor,
    change: DocumentSessionChange | null,
  ): void {
    const active = this.activeDocument;
    if (!active || active.uri !== descriptor.uri || active.languageId !== descriptor.languageId) {
      this.closeActiveDocument();
      workspace.openDocument(descriptor);
      this.activeDocument = descriptor;
      return;
    }

    if (active.textVersion === descriptor.textVersion && active.text === descriptor.text) return;

    workspace.updateDocument(descriptor.uri, descriptor.text, {
      edits: editsForChange(change),
    });
    this.activeDocument = descriptor;
  }

  private closeActiveDocument(): void {
    const active = this.activeDocument;
    const connection = this.activeConnection;
    this.activeDocument = null;
    if (!active || !connection) return;

    connection.workspace.closeDocument(active.uri);
  }

  private disconnect(): void {
    this.closeActiveDocument();
    this.activeConnection?.client.disconnect();
    this.transport?.close();
    this.transport = null;
    this.activeConnection = null;
    this.connectionId += 1;
    this.setStatus("idle");
  }

  private createDocumentDescriptor(snapshot: EditorViewSnapshot): DocumentDescriptor | null {
    const uri = this.resolveDocumentUri(snapshot);
    if (!uri) return null;

    return {
      uri,
      languageId: this.resolveLanguageId(snapshot),
      text: snapshot.text,
      textVersion: snapshot.textVersion,
    };
  }

  private resolveRoute(snapshot: EditorViewSnapshot): URL | null {
    const route =
      typeof this.options.route === "function" ? this.options.route(snapshot) : this.options.route;
    if (!route) return null;
    return normalizeWebSocketRoute(route);
  }

  private resolveDocumentUri(snapshot: EditorViewSnapshot): lsp.DocumentUri | null {
    const resolved = this.options.documentUri?.(snapshot);
    if (resolved !== undefined) return resolved;
    return defaultDocumentUri(snapshot.documentId);
  }

  private resolveLanguageId(snapshot: EditorViewSnapshot): string {
    return this.options.languageId?.(snapshot) ?? snapshot.languageId ?? "plaintext";
  }

  private isCurrentConnection(connection: ActiveConnection): boolean {
    return !this.disposed && this.activeConnection?.id === connection.id;
  }

  private setStatus(status: LspPluginStatus): void {
    this.options.onStatusChange?.(status);
  }
}

const shouldSyncDocument = (
  kind: EditorViewContributionUpdateKind,
  snapshot: EditorViewSnapshot,
  active: ActiveDocument | null,
): boolean => {
  if (kind === "document" || kind === "content" || kind === "clear") return true;
  if (!active) return false;
  return active.textVersion !== snapshot.textVersion;
};

const editsForChange = (change: DocumentSessionChange | null): readonly LspTextEdit[] => {
  if (!change) return [];
  return change.edits;
};

const defaultDocumentUri = (documentId: string | null): lsp.DocumentUri | null => {
  if (!documentId) return null;
  if (hasUriScheme(documentId)) return documentId;

  const path = documentId.startsWith("/") ? documentId : `/${documentId}`;
  return `file://${encodeURI(path)}`;
};

const hasUriScheme = (value: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);

const normalizeWebSocketRoute = (route: string | URL): URL => {
  const url = route instanceof URL ? new URL(route.href) : new URL(route, routeBaseUrl());
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url;
};

const routeBaseUrl = (): string => globalThis.location?.href ?? "http://localhost/";
