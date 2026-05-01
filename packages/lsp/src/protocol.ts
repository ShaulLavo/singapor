import type * as lsp from "vscode-languageserver-protocol";

export const JSON_RPC_VERSION = "2.0";
export const METHOD_NOT_FOUND = -32601;
export const REQUEST_CANCELLED = -32800;

export type LspRequestId = number | string;

export class LspResponseError extends Error {
  public readonly code: number;
  public readonly data: unknown;

  public constructor(error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  }) {
    super(error.message);
    this.name = "LspResponseError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class LspRequestCancelledError extends Error {
  public readonly code = REQUEST_CANCELLED;

  public constructor(message = "LSP request cancelled") {
    super(message);
    this.name = "LspRequestCancelledError";
  }
}

export const createRequestMessage = (
  id: LspRequestId,
  method: string,
  params: unknown,
): lsp.RequestMessage => {
  const message: lsp.RequestMessage = {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
  };
  if (params !== undefined) message.params = params as lsp.RequestMessage["params"];
  return message;
};

export const createNotificationMessage = (
  method: string,
  params?: unknown,
): lsp.NotificationMessage => {
  const message: lsp.NotificationMessage = {
    jsonrpc: JSON_RPC_VERSION,
    method,
  };
  if (params !== undefined) message.params = params as lsp.NotificationMessage["params"];
  return message;
};

export const createMethodNotFoundResponse = (
  id: LspRequestId | null,
  method: string,
): lsp.ResponseMessage => ({
  jsonrpc: JSON_RPC_VERSION,
  id,
  error: {
    code: METHOD_NOT_FOUND,
    message: `Method not implemented: ${method}`,
  },
});

export const isResponseMessage = (message: unknown): message is lsp.ResponseMessage => {
  if (!isObject(message)) return false;
  return "id" in message && !("method" in message);
};

export const isRequestMessage = (message: unknown): message is lsp.RequestMessage => {
  if (!isObject(message)) return false;
  return "id" in message && typeof message.method === "string";
};

export const isNotificationMessage = (message: unknown): message is lsp.NotificationMessage => {
  if (!isObject(message)) return false;
  return !("id" in message) && typeof message.method === "string";
};

export const responseResult = <TResult>(message: lsp.ResponseMessage): TResult => {
  if (message.error) throw new LspResponseError(message.error);
  return message.result as TResult;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
