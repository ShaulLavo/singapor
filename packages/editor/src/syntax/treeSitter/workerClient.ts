import type {
  TreeSitterEditRequest,
  TreeSitterLanguageId,
  TreeSitterParseResult,
  TreeSitterWorkerRequest,
  TreeSitterWorkerRequestPayload,
  TreeSitterWorkerResponse,
} from "./types";

type PendingRequest = {
  readonly resolve: (result: TreeSitterParseResult | undefined) => void;
  readonly reject: (error: Error) => void;
};

export type TreeSitterParsePayload = {
  readonly documentId: string;
  readonly snapshotVersion: number;
  readonly languageId: TreeSitterLanguageId;
  readonly text: string;
};

export type TreeSitterEditPayload = Omit<TreeSitterEditRequest, "type">;

const supportsWorkers = (): boolean => typeof Worker !== "undefined";

let worker: Worker | null = null;
let nextRequestId = 1;
let initPromise: Promise<void> | null = null;
const pendingRequests = new Map<number, PendingRequest>();

const getWorker = (): Worker | null => {
  if (!supportsWorkers()) return null;
  if (worker) return worker;

  worker = new Worker(new URL("./treeSitter.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = handleWorkerMessage;
  worker.onerror = handleWorkerError;
  return worker;
};

const ensureWorkerReady = async (): Promise<Worker | null> => {
  const handle = getWorker();
  if (!handle) return null;

  if (!initPromise) {
    initPromise = postRequest({ type: "init" }).then(() => undefined);
  }

  await initPromise;
  return handle;
};

export const canUseTreeSitterWorker = (): boolean => supportsWorkers();

export const parseWithTreeSitter = async (
  payload: TreeSitterParsePayload,
): Promise<TreeSitterParseResult | undefined> => {
  const handle = await ensureWorkerReady();
  if (!handle) return undefined;
  return postRequest({ type: "parse", ...payload });
};

export const editWithTreeSitter = async (
  payload: TreeSitterEditPayload,
): Promise<TreeSitterParseResult | undefined> => {
  const handle = await ensureWorkerReady();
  if (!handle) return undefined;
  return postRequest({ type: "edit", ...payload });
};

export const disposeTreeSitterDocument = (documentId: string): void => {
  void postRequest({ type: "disposeDocument", documentId }).catch(() => undefined);
};

export const disposeTreeSitterWorker = async (): Promise<void> => {
  if (!worker) return;

  try {
    await postRequest({ type: "dispose" });
  } finally {
    worker.terminate();
    worker = null;
    initPromise = null;
    rejectPendingRequests(new Error("Tree-sitter worker disposed"));
  }
};

const postRequest = (
  payload: TreeSitterWorkerRequestPayload,
): Promise<TreeSitterParseResult | undefined> => {
  const handle = getWorker();
  if (!handle) return Promise.resolve(undefined);

  const id = nextRequestId++;
  const request: TreeSitterWorkerRequest = { id, payload };

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    handle.postMessage(request);
  });
};

const handleWorkerMessage = (event: MessageEvent<TreeSitterWorkerResponse>): void => {
  const response = event.data;
  const pending = pendingRequests.get(response.id);
  if (!pending) return;

  pendingRequests.delete(response.id);
  if (response.ok) {
    pending.resolve(response.result);
    return;
  }

  pending.reject(new Error(response.error));
};

const handleWorkerError = (event: ErrorEvent): void => {
  const error = new Error(event.message || "Tree-sitter worker failed");
  rejectPendingRequests(error);
  initPromise = null;
};

const rejectPendingRequests = (error: Error): void => {
  for (const request of pendingRequests.values()) request.reject(error);
  pendingRequests.clear();
};
