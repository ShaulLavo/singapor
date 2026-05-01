import type * as lsp from "vscode-languageserver-protocol";
import {
  defaultClientCapabilities,
  documentSyncModeFromCapabilities,
  mergeClientCapabilities,
} from "./capabilities";
import {
  createMethodNotFoundResponse,
  createNotificationMessage,
  createRequestMessage,
  isNotificationMessage,
  isRequestMessage,
  isResponseMessage,
  LspRequestCancelledError,
  responseResult,
  type LspRequestId,
} from "./protocol";
import { createLspContentChanges } from "./positions";
import type {
  LspDocument,
  LspDocumentSyncMode,
  LspNotificationHandler,
  LspTextEdit,
  LspTransport,
  LspUnhandledNotificationHandler,
} from "./types";
import { LspWorkspace } from "./workspace";

export type LspClientState = "disconnected" | "initializing" | "ready" | "failed";

export type LspClientConfig = {
  readonly rootUri?: lsp.DocumentUri | null;
  readonly workspaceFolders?: readonly lsp.WorkspaceFolder[] | null;
  readonly clientInfo?: lsp.InitializeParams["clientInfo"];
  readonly initializationOptions?: unknown;
  readonly capabilities?: lsp.ClientCapabilities;
  readonly timeoutMs?: number;
  readonly processId?: number | null;
  readonly locale?: string;
  readonly workspace?: LspWorkspace;
  readonly notificationHandlers?: Readonly<Record<string, LspNotificationHandler<LspClient>>>;
  readonly unhandledNotification?: LspUnhandledNotificationHandler<LspClient>;
};

type PendingRequest = {
  readonly id: LspRequestId;
  readonly method: string;
  readonly params: unknown;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly abortCleanup?: () => void;
};

type RequestOptions = {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export class LspClient {
  public readonly workspace: LspWorkspace;
  public serverCapabilities: lsp.ServerCapabilities | null = null;
  public initializeResult: lsp.InitializeResult | null = null;

  private readonly config: LspClientConfig;
  private readonly timeoutMs: number;
  private transport: LspTransport | null = null;
  private state: LspClientState = "disconnected";
  private nextRequestId = 1;
  private initializePromise: Promise<void> | null = null;
  private syncMode: LspDocumentSyncMode = "none";
  private readonly pendingRequests = new Map<LspRequestId, PendingRequest>();
  private readonly syncedDocuments = new Set<lsp.DocumentUri>();

  public constructor(config: LspClientConfig = {}) {
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? 3000;
    this.workspace = config.workspace ?? new LspWorkspace();
    this.workspace.attachClient(this);
    this.receiveMessage = this.receiveMessage.bind(this);
  }

  public get connected(): boolean {
    return this.transport !== null;
  }

  public get initialized(): boolean {
    return this.state === "ready";
  }

  public get initialization(): Promise<void> | null {
    return this.initializePromise;
  }

  public connect(transport: LspTransport): Promise<void> {
    this.disconnect();
    this.transport = transport;
    this.state = "initializing";
    transport.subscribe(this.receiveMessage);
    this.initializePromise = this.initialize();
    return this.initializePromise;
  }

  public disconnect(): void {
    const transport = this.transport;
    if (transport) transport.unsubscribe(this.receiveMessage);

    this.transport = null;
    this.state = "disconnected";
    this.initializePromise = null;
    this.initializeResult = null;
    this.serverCapabilities = null;
    this.syncMode = "none";
    this.syncedDocuments.clear();
    this.rejectPendingRequests(new Error("LSP client disconnected"));
    this.workspace.disconnected();
  }

  public async shutdown(): Promise<void> {
    if (!this.transport) return;

    await this.request("shutdown");
    this.sendNotification("exit");
    this.disconnect();
  }

  public request<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams,
    options: RequestOptions = {},
  ): Promise<TResult> {
    if (!this.transport) return Promise.reject(new Error("LSP client is not connected"));
    if (this.state === "ready") return this.requestInner<TResult>(method, params, options);
    return this.awaitInitialization().then(() =>
      this.requestInner<TResult>(method, params, options),
    );
  }

  public notify<TParams = unknown>(method: string, params?: TParams): Promise<void> {
    if (!this.transport) return Promise.reject(new Error("LSP client is not connected"));
    if (this.state === "ready") {
      this.sendNotification(method, params);
      return Promise.resolve();
    }

    return this.awaitInitialization().then(() => this.sendNotification(method, params));
  }

  public notification<TParams = unknown>(method: string, params?: TParams): Promise<void> {
    return this.notify(method, params);
  }

  public cancelRequest(params: unknown): void {
    const pending = this.pendingRequestForParams(params);
    if (!pending) return;

    this.sendNotification("$/cancelRequest", { id: pending.id });
  }

  public hasCapability(name: keyof lsp.ServerCapabilities): boolean | null {
    if (!this.serverCapabilities) return null;
    return Boolean(this.serverCapabilities[name]);
  }

  public didOpenDocument(document: LspDocument): void {
    if (this.state !== "ready") return;
    if (this.syncMode === "none") return;
    if (this.syncedDocuments.has(document.uri)) return;

    this.syncedDocuments.add(document.uri);
    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: document.uri,
        languageId: document.languageId,
        version: document.version,
        text: document.text,
      },
    });
  }

  public didChangeDocument(
    document: LspDocument,
    previousText: string,
    edits: readonly LspTextEdit[],
  ): void {
    if (this.state !== "ready") return;
    if (this.syncMode === "none") return;
    if (!this.syncedDocuments.has(document.uri)) return;

    this.sendNotification("textDocument/didChange", {
      textDocument: { uri: document.uri, version: document.version },
      contentChanges: createLspContentChanges(previousText, document.text, {
        incremental: this.syncMode === "incremental",
        edits,
      }),
    });
  }

  public didCloseDocument(document: LspDocument): void {
    if (this.state !== "ready") return;
    if (!this.syncedDocuments.delete(document.uri)) return;

    this.sendNotification("textDocument/didClose", {
      textDocument: { uri: document.uri },
    });
  }

  private async initialize(): Promise<void> {
    try {
      const result = await this.requestInner<lsp.InitializeResult>(
        "initialize",
        this.initializeParams(),
      );
      this.applyInitializeResult(result);
      this.sendNotification("initialized", {});
      this.workspace.connected();
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }

  private initializeParams(): lsp.InitializeParams {
    return {
      processId: this.config.processId ?? null,
      clientInfo: this.config.clientInfo ?? { name: "@editor/lsp" },
      locale: this.config.locale,
      rootUri: this.config.rootUri ?? null,
      capabilities: mergeClientCapabilities(defaultClientCapabilities(), this.config.capabilities),
      initializationOptions: this.config.initializationOptions,
      workspaceFolders: this.config.workspaceFolders ? [...this.config.workspaceFolders] : null,
    };
  }

  private applyInitializeResult(result: lsp.InitializeResult): void {
    this.initializeResult = result;
    this.serverCapabilities = result.capabilities;
    this.syncMode = documentSyncModeFromCapabilities(result.capabilities);
    this.state = "ready";
  }

  private requestInner<TResult>(
    method: string,
    params: unknown,
    options: RequestOptions = {},
  ): Promise<TResult> {
    const transport = this.requireTransport();
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const message = createRequestMessage(id, method, params);

    return new Promise<TResult>((resolve, reject) => {
      const pending = this.createPendingRequest(
        id,
        method,
        params,
        (result) => resolve(result as TResult),
        reject,
        options,
      );
      this.pendingRequests.set(id, pending);
      this.sendMessage(transport, message, pending);
    });
  }

  private createPendingRequest(
    id: LspRequestId,
    method: string,
    params: unknown,
    resolve: (result: unknown) => void,
    reject: (error: unknown) => void,
    options: RequestOptions,
  ): PendingRequest {
    const timeout = setTimeout(() => this.timeoutRequest(id), options.timeoutMs ?? this.timeoutMs);
    const pending: PendingRequest = { id, method, params, timeout, resolve, reject };
    if (!options.signal) return pending;

    const abort = () => this.abortRequest(id);
    options.signal.addEventListener("abort", abort, { once: true });
    return { ...pending, abortCleanup: () => options.signal?.removeEventListener("abort", abort) };
  }

  private sendMessage(
    transport: LspTransport,
    message: lsp.RequestMessage,
    pending: PendingRequest,
  ): void {
    try {
      transport.send(JSON.stringify(message));
    } catch (error) {
      this.deletePendingRequest(pending.id);
      pending.reject(error);
    }
  }

  private sendNotification(method: string, params?: unknown): void {
    const transport = this.requireTransport();
    transport.send(JSON.stringify(createNotificationMessage(method, params)));
  }

  private receiveMessage(message: string): void {
    const parsed = JSON.parse(message) as unknown;
    if (isResponseMessage(parsed)) {
      this.handleResponse(parsed);
      return;
    }
    if (isNotificationMessage(parsed)) {
      this.handleNotification(parsed);
      return;
    }
    if (isRequestMessage(parsed)) {
      this.handleRequest(parsed);
    }
  }

  private handleResponse(message: lsp.ResponseMessage): void {
    if (message.id === null) return;

    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;

    this.deletePendingRequest(message.id);
    try {
      pending.resolve(responseResult(message));
    } catch (error) {
      pending.reject(error);
    }
  }

  private handleNotification(message: lsp.NotificationMessage): void {
    const handler = this.config.notificationHandlers?.[message.method];
    if (handler?.(this, message.params, message)) return;
    if (defaultNotificationHandler(this, message)) return;
    this.config.unhandledNotification?.(this, message.method, message.params, message);
  }

  private handleRequest(message: lsp.RequestMessage): void {
    const transport = this.requireTransport();
    const id = message.id ?? null;
    transport.send(JSON.stringify(createMethodNotFoundResponse(id, message.method)));
  }

  private timeoutRequest(id: LspRequestId): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    this.deletePendingRequest(id);
    pending.reject(new Error(`LSP request timed out: ${pending.method}`));
  }

  private abortRequest(id: LspRequestId): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    this.sendNotification("$/cancelRequest", { id });
    this.deletePendingRequest(id);
    pending.reject(new LspRequestCancelledError());
  }

  private pendingRequestForParams(params: unknown): PendingRequest | null {
    for (const pending of this.pendingRequests.values()) {
      if (pending.params === params) return pending;
    }

    return null;
  }

  private deletePendingRequest(id: LspRequestId): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    pending.abortCleanup?.();
    this.pendingRequests.delete(id);
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.abortCleanup?.();
      pending.reject(error);
    }

    this.pendingRequests.clear();
  }

  private awaitInitialization(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    return Promise.reject(new Error("LSP client is not initialized"));
  }

  private requireTransport(): LspTransport {
    if (this.transport) return this.transport;
    throw new Error("LSP client is not connected");
  }
}

const defaultNotificationHandler = (
  _client: LspClient,
  message: lsp.NotificationMessage,
): boolean => {
  if (message.method === "window/logMessage") return handleWindowLogMessage(message.params);
  if (message.method === "window/showMessage") return handleWindowShowMessage(message.params);
  return false;
};

const handleWindowLogMessage = (params: unknown): boolean => {
  const message = messageText(params);
  if (!message) return true;

  const type = messageType(params);
  if (type === 1) console.error(`[lsp] ${message}`);
  else if (type === 2) console.warn(`[lsp] ${message}`);
  else console.info(`[lsp] ${message}`);
  return true;
};

const handleWindowShowMessage = (params: unknown): boolean => {
  const message = messageText(params);
  if (!message) return true;

  const type = messageType(params);
  if (type === 1) console.error(`[lsp] ${message}`);
  else if (type === 2) console.warn(`[lsp] ${message}`);
  else console.info(`[lsp] ${message}`);
  return true;
};

const messageText = (params: unknown): string | null => {
  if (!isRecord(params)) return null;
  return typeof params.message === "string" ? params.message : null;
};

const messageType = (params: unknown): number => {
  if (!isRecord(params)) return 3;
  return typeof params.type === "number" ? params.type : 3;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
