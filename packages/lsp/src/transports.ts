import type { LspTransport, LspTransportHandler } from "./types";

export type LspManagedTransport = LspTransport & {
  close(): void;
};

export type LspWebSocketLike = {
  readonly readyState?: number;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", handler: EventListener): void;
  addEventListener(type: "message", handler: EventListener): void;
  addEventListener(type: "error", handler: EventListener): void;
  addEventListener(type: "close", handler: EventListener): void;
  removeEventListener(type: "open", handler: EventListener): void;
  removeEventListener(type: "message", handler: EventListener): void;
  removeEventListener(type: "error", handler: EventListener): void;
  removeEventListener(type: "close", handler: EventListener): void;
};

export type LspWebSocketConstructor = new (
  url: string | URL,
  protocols?: string | readonly string[],
) => LspWebSocketLike;

export type LspWebSocketTransportOptions = {
  readonly protocols?: string | readonly string[];
  readonly WebSocketCtor?: LspWebSocketConstructor;
};

export type LspWorkerMessageFormat = "string" | "json";

export type LspWorkerLike = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", handler: EventListener): void;
  addEventListener(type: "error", handler: EventListener): void;
  removeEventListener(type: "message", handler: EventListener): void;
  removeEventListener(type: "error", handler: EventListener): void;
  terminate?(): void;
};

export type LspWorkerTransportOptions = {
  readonly messageFormat?: LspWorkerMessageFormat;
  readonly terminateOnClose?: boolean;
};

const WEB_SOCKET_OPEN = 1;

const mutableProtocols = (
  protocols: string | readonly string[] | undefined,
): string | string[] | undefined => {
  if (typeof protocols === "string") return protocols;
  if (!protocols) return undefined;
  return [...protocols];
};

export const createWebSocketLspTransport = (
  url: string | URL,
  options: LspWebSocketTransportOptions = {},
): Promise<LspManagedTransport> => {
  const WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;
  if (!WebSocketCtor) return Promise.reject(new Error("WebSocket is not available"));

  const socket = new WebSocketCtor(url, mutableProtocols(options.protocols));
  const transport = new WebSocketLspTransport(socket);
  if (socket.readyState === WEB_SOCKET_OPEN) return Promise.resolve(transport);

  return waitForWebSocketOpen(socket, transport);
};

export const createWorkerLspTransport = (
  worker: LspWorkerLike,
  options: LspWorkerTransportOptions = {},
): LspManagedTransport => new WorkerLspTransport(worker, options);

class WebSocketLspTransport implements LspManagedTransport {
  private readonly handlers = new Set<LspTransportHandler>();
  private closed = false;

  public constructor(private readonly socket: LspWebSocketLike) {
    this.socket.addEventListener("message", this.handleMessage);
  }

  public send(message: string): void {
    this.socket.send(message);
  }

  public subscribe(handler: LspTransportHandler): void {
    this.handlers.add(handler);
  }

  public unsubscribe(handler: LspTransportHandler): void {
    this.handlers.delete(handler);
  }

  public close(): void {
    if (this.closed) return;

    this.closed = true;
    this.handlers.clear();
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.close();
  }

  private readonly handleMessage = (event: Event): void => {
    const message = messageEventData(event);
    if (message === null) return;
    for (const handler of this.handlers) handler(message);
  };
}

class WorkerLspTransport implements LspManagedTransport {
  private readonly handlers = new Set<LspTransportHandler>();
  private readonly messageFormat: LspWorkerMessageFormat;
  private readonly terminateOnClose: boolean;
  private closed = false;

  public constructor(
    private readonly worker: LspWorkerLike,
    options: LspWorkerTransportOptions,
  ) {
    this.messageFormat = options.messageFormat ?? "string";
    this.terminateOnClose = options.terminateOnClose ?? false;
    this.worker.addEventListener("message", this.handleMessage);
  }

  public send(message: string): void {
    this.worker.postMessage(this.encodeMessage(message));
  }

  public subscribe(handler: LspTransportHandler): void {
    this.handlers.add(handler);
  }

  public unsubscribe(handler: LspTransportHandler): void {
    this.handlers.delete(handler);
  }

  public close(): void {
    if (this.closed) return;

    this.closed = true;
    this.handlers.clear();
    this.worker.removeEventListener("message", this.handleMessage);
    if (this.terminateOnClose) this.worker.terminate?.();
  }

  private encodeMessage(message: string): unknown {
    if (this.messageFormat === "string") return message;
    return JSON.parse(message) as unknown;
  }

  private readonly handleMessage = (event: Event): void => {
    const message = messageEventData(event);
    if (message === null) return;
    for (const handler of this.handlers) handler(message);
  };
}

const waitForWebSocketOpen = (
  socket: LspWebSocketLike,
  transport: LspManagedTransport,
): Promise<LspManagedTransport> =>
  new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
    };
    const handleOpen = (): void => {
      cleanup();
      resolve(transport);
    };
    const handleError = (): void => {
      cleanup();
      reject(new Error("WebSocket LSP transport failed to connect"));
    };
    const handleClose = (): void => {
      cleanup();
      reject(new Error("WebSocket LSP transport closed before opening"));
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);
  });

const messageEventData = (event: Event): string | null => {
  const data = (event as MessageEvent).data;
  if (typeof data === "string") return data;
  if (data === undefined) return null;
  return JSON.stringify(data);
};
