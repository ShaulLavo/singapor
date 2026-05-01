import type * as lsp from "vscode-languageserver-protocol";
import type { LspDocumentSyncMode } from "./types";

const TEXT_DOCUMENT_SYNC_NONE = 0;
const TEXT_DOCUMENT_SYNC_FULL = 1;
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2;

export const defaultClientCapabilities = (): lsp.ClientCapabilities => ({
  general: {
    positionEncodings: ["utf-16"],
  },
  textDocument: {
    synchronization: {
      didSave: false,
      willSave: false,
      willSaveWaitUntil: false,
    },
  },
  window: {
    showMessage: {},
  },
});

export const mergeClientCapabilities = (
  base: lsp.ClientCapabilities,
  override: lsp.ClientCapabilities | undefined,
): lsp.ClientCapabilities => mergeObjects(base, override) as lsp.ClientCapabilities;

export const documentSyncModeFromCapabilities = (
  capabilities: lsp.ServerCapabilities | null,
): LspDocumentSyncMode => {
  if (!capabilities?.textDocumentSync) return "none";

  const sync = capabilities.textDocumentSync;
  if (typeof sync === "number") return syncModeFromKind(sync);
  return syncModeFromKind(sync.change ?? TEXT_DOCUMENT_SYNC_NONE);
};

const syncModeFromKind = (kind: number): LspDocumentSyncMode => {
  if (kind === TEXT_DOCUMENT_SYNC_INCREMENTAL) return "incremental";
  if (kind === TEXT_DOCUMENT_SYNC_FULL) return "full";
  return "none";
};

const mergeObjects = (base: unknown, override: unknown): unknown => {
  if (override === undefined) return cloneValue(base);
  if (!isRecord(base) || !isRecord(override)) return cloneValue(override);

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(base)) {
    result[key] = mergeObjects(base[key], override[key]);
  }
  for (const key of Object.keys(override)) {
    if (key in result) continue;
    result[key] = cloneValue(override[key]);
  }

  return result;
};

const cloneValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) result[key] = cloneValue(value[key]);
  return result;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
