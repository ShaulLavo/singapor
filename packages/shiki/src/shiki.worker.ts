import { createHighlighter, type HighlighterGeneric } from "shiki";
import { createIncrementalTokenizer, type IncrementalTokenizer } from "./tokenizer";
import { snapshotToEditorTokens } from "./editor-tokens";
import type {
  ShikiWorkerDocumentOptions,
  ShikiWorkerEditRequest,
  ShikiWorkerOpenRequest,
  ShikiWorkerRequest,
  ShikiWorkerResponse,
  ShikiWorkerResult,
} from "./workerTypes";

type DocumentState = {
  readonly documentId: string;
  readonly lang: string;
  readonly theme: string;
  readonly tokenizer: IncrementalTokenizer;
};

const documents = new Map<string, DocumentState>();
const documentTasks = new Map<string, Promise<ShikiWorkerResult | undefined>>();
const highlighterPromises = new Map<string, Promise<HighlighterGeneric<string, string>>>();

self.onmessage = (event: MessageEvent<ShikiWorkerRequest>): void => {
  void handleRequest(event.data);
};

const handleRequest = async (request: ShikiWorkerRequest): Promise<void> => {
  try {
    const result = await runRequest(request.payload);
    postResponse({ id: request.id, ok: true, result });
  } catch (error) {
    postResponse({ id: request.id, ok: false, error: createErrorMessage(error) });
  }
};

const runRequest = (
  payload: ShikiWorkerRequest["payload"],
): Promise<ShikiWorkerResult | undefined> => {
  if (payload.type === "open") {
    return runDocumentTask(payload.documentId, () => openDocument(payload));
  }
  if (payload.type === "edit") {
    return runDocumentTask(payload.documentId, () => editDocument(payload));
  }
  if (payload.type === "disposeDocument") {
    disposeDocument(payload.documentId);
    return Promise.resolve(undefined);
  }

  disposeAll();
  return Promise.resolve(undefined);
};

const runDocumentTask = (
  documentId: string,
  task: () => Promise<ShikiWorkerResult>,
): Promise<ShikiWorkerResult> => {
  const previous = documentTasks.get(documentId) ?? Promise.resolve(undefined);
  const next = previous.catch(() => undefined).then(task);
  documentTasks.set(documentId, next);
  void next.finally(() => clearDocumentTask(documentId, next)).catch(() => undefined);
  return next;
};

const clearDocumentTask = (
  documentId: string,
  task: Promise<ShikiWorkerResult | undefined>,
): void => {
  if (documentTasks.get(documentId) !== task) return;
  documentTasks.delete(documentId);
};

const openDocument = async (payload: ShikiWorkerOpenRequest): Promise<ShikiWorkerResult> => {
  const highlighter = await ensureHighlighter(payload);
  const { tokenizer } = await createIncrementalTokenizer({
    lang: payload.lang,
    theme: payload.theme,
    code: payload.text,
    highlighter,
  });

  const state = {
    documentId: payload.documentId,
    lang: payload.lang,
    theme: payload.theme,
    tokenizer,
  };
  documents.set(payload.documentId, state);
  return resultFromState(state);
};

const editDocument = async (payload: ShikiWorkerEditRequest): Promise<ShikiWorkerResult> => {
  const existing = documents.get(payload.documentId);
  if (!existing) return openDocument({ ...payload, type: "open" });
  if (!documentMatches(existing, payload)) return openDocument({ ...payload, type: "open" });

  if (payload.edit) {
    existing.tokenizer.applyEdit(payload.edit);
  } else {
    existing.tokenizer.update(payload.text);
  }

  return resultFromState(existing);
};

const ensureHighlighter = (
  options: ShikiWorkerDocumentOptions,
): Promise<HighlighterGeneric<string, string>> => {
  const langs = unique([options.lang, ...options.langs]);
  const themes = unique([options.theme, ...options.themes]);
  const key = highlighterKey(langs, themes);
  const existing = highlighterPromises.get(key);
  if (existing) return existing;

  const promise = createHighlighter({ langs, themes }) as Promise<
    HighlighterGeneric<string, string>
  >;
  highlighterPromises.set(key, promise);
  return promise;
};

const resultFromState = (state: DocumentState): ShikiWorkerResult => ({
  documentId: state.documentId,
  tokens: snapshotToEditorTokens(state.tokenizer.getSnapshot()),
});

const documentMatches = (state: DocumentState, payload: ShikiWorkerDocumentOptions): boolean =>
  state.lang === payload.lang && state.theme === payload.theme;

const disposeDocument = (documentId: string): void => {
  documents.delete(documentId);
  documentTasks.delete(documentId);
};

const disposeAll = (): void => {
  documents.clear();
  documentTasks.clear();
  for (const promise of highlighterPromises.values()) {
    void promise.then((highlighter) => highlighter.dispose()).catch(() => undefined);
  }
  highlighterPromises.clear();
};

const postResponse = (response: ShikiWorkerResponse): void => {
  self.postMessage(response);
};

const highlighterKey = (langs: readonly string[], themes: readonly string[]): string => {
  const normalizedLangs = [...langs].sort();
  const normalizedThemes = [...themes].sort();
  return JSON.stringify({ langs: normalizedLangs, themes: normalizedThemes });
};

const unique = (items: readonly string[]): string[] => Array.from(new Set(items));

const createErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};
