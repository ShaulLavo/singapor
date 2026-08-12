import type * as lsp from 'vscode-languageserver-protocol'
import type { LspDocumentSaveSync, LspDocumentSyncMode, LspDocumentSyncOptions } from './types'

const TEXT_DOCUMENT_SYNC_NONE = 0
const TEXT_DOCUMENT_SYNC_FULL = 1
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const defaultClientCapabilities = (): lsp.ClientCapabilities => ({
  general: {
    positionEncodings: ['utf-16'],
  },
  textDocument: {
    synchronization: {
      didSave: false,
      willSave: false,
      willSaveWaitUntil: false,
    },
    completion: {
      contextSupport: true,
      completionItem: {
        documentationFormat: ['markdown', 'plaintext'],
        labelDetailsSupport: true,
        // Servers defer the expensive parts of an item until resolve; without this they either
        // send nothing there or refuse the request. additionalTextEdits is the load-bearing one —
        // it carries the auto-import.
        resolveSupport: {
          properties: ['documentation', 'detail', 'additionalTextEdits'],
        },
        snippetSupport: true,
      },
    },
    // Servers only answer what the client advertises, so this has to be declared for
    // textDocument/signatureHelp to come back at all.
    signatureHelp: {
      contextSupport: true,
      signatureInformation: {
        documentationFormat: ['markdown', 'plaintext'],
        parameterInformation: {
          labelOffsetSupport: true,
        },
      },
    },
  },
  window: {
    showMessage: {},
  },
})

export const mergeClientCapabilities = (
  base: lsp.ClientCapabilities,
  override: lsp.ClientCapabilities | undefined,
): lsp.ClientCapabilities => mergeObjects(base, override) as lsp.ClientCapabilities

export const documentSyncModeFromCapabilities = (
  capabilities: lsp.ServerCapabilities | null,
): LspDocumentSyncMode => {
  return documentSyncOptionsFromCapabilities(capabilities).change
}

export const documentSyncOptionsFromCapabilities = (
  capabilities: lsp.ServerCapabilities | null,
): LspDocumentSyncOptions => {
  const sync = capabilities?.textDocumentSync
  if (!sync) return noDocumentSync()
  if (typeof sync === 'number') return numericDocumentSync(sync)

  return {
    change: syncModeFromKind(sync.change ?? TEXT_DOCUMENT_SYNC_NONE),
    openClose: sync.openClose === true,
    save: saveSyncFromOptions(sync.save),
  }
}

export const clientSupportsDidSave = (capabilities: lsp.ClientCapabilities): boolean =>
  capabilities.textDocument?.synchronization?.didSave === true

const noDocumentSync = (): LspDocumentSyncOptions => ({
  change: 'none',
  openClose: false,
  save: { enabled: false, includeText: false },
})

const numericDocumentSync = (kind: number): LspDocumentSyncOptions => {
  const change = syncModeFromKind(kind)
  return {
    change,
    openClose: change !== 'none',
    save: { enabled: false, includeText: false },
  }
}

const saveSyncFromOptions = (save: boolean | lsp.SaveOptions | undefined): LspDocumentSaveSync => {
  if (!save) return { enabled: false, includeText: false }
  if (save === true) return { enabled: true, includeText: false }
  return { enabled: true, includeText: save.includeText === true }
}

const syncModeFromKind = (kind: number): LspDocumentSyncMode => {
  if (kind === TEXT_DOCUMENT_SYNC_INCREMENTAL) return 'incremental'
  if (kind === TEXT_DOCUMENT_SYNC_FULL) return 'full'
  return 'none'
}

const mergeObjects = (base: unknown, override: unknown): unknown => {
  if (override === undefined) return cloneValue(base)
  if (!isRecord(base) || !isRecord(override)) return cloneValue(override)

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(base)) {
    result[key] = mergeObjects(base[key], override[key])
  }
  for (const key of Object.keys(override)) {
    if (key in result) continue
    result[key] = cloneValue(override[key])
  }

  return result
}

const cloneValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (!isRecord(value)) return value

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value)) result[key] = cloneValue(value[key])
  return result
}
