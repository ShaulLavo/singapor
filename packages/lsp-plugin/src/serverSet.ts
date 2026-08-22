import type { LspClient, LspRequestOptions } from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'

import type { AcquiredLanguageServerLane } from './lane'
import {
  LANGUAGE_SERVER_FEATURE_IDS,
  type LanguageServerFeatureId,
  type LanguageServerFeatureRanks,
} from './types'

export type LanguageServerSetLane = {
  readonly id: string
  readonly features: LanguageServerFeatureRanks
  readonly connection: AcquiredLanguageServerLane
  readonly onInteractiveReady?: () => void
  readonly onError?: (error: unknown) => void
}

type LaneResult = {
  readonly lane: LanguageServerSetLane
  readonly result: unknown
}

export class LanguageServerSet {
  readonly #lanes: readonly LanguageServerSetLane[]
  readonly #provenance = new WeakMap<object, LanguageServerSetLane>()
  readonly #requestClient: LspClient

  public constructor(lanes: readonly LanguageServerSetLane[]) {
    this.#lanes = lanes
    this.#requestClient = new RoutedLanguageServerClient(this) as unknown as LspClient
  }

  public get client(): LspClient {
    return this.#requestClient
  }

  public declared(feature: LanguageServerFeatureId): readonly LanguageServerSetLane[] {
    return this.#lanes
      .filter((lane) => lane.features[feature] !== undefined)
      .toSorted((left, right) => compareFeatureRank(left, right, feature, this.#lanes))
  }

  public ready(
    feature: LanguageServerFeatureId,
    method?: string,
  ): readonly LanguageServerSetLane[] {
    return this.declared(feature).filter((lane) => {
      if (!lane.connection.isReady()) return false
      return laneSupports(lane, feature, method)
    })
  }

  public designated(feature: LanguageServerFeatureId): LanguageServerSetLane | null {
    return this.declared(feature)[0] ?? null
  }

  public hasReadyLane(): boolean {
    return this.#lanes.some((lane) => lane.connection.isReady())
  }

  public capabilities(): lsp.ServerCapabilities | null {
    if (!this.hasReadyLane()) return null

    return {
      codeActionProvider: codeActionCapability(this.ready('codeActions')),
      documentFormattingProvider: this.ready('formatting').length > 0,
      documentHighlightProvider: this.ready('documentHighlights').length > 0,
      hoverProvider: this.ready('hover').length > 0,
      renameProvider: this.ready('rename').length > 0,
      signatureHelpProvider: this.ready('signatureHelp').length > 0 ? {} : undefined,
    }
  }

  public request<TResult, TParams>(
    method: string,
    params?: TParams,
    options: LspRequestOptions = {},
  ): Promise<TResult> {
    if (method === 'textDocument/hover') {
      const lanes = this.ready('hover', method)
      if (lanes.length === 1) {
        return this.requestSingle(lanes[0], method, params, options, null) as Promise<TResult>
      }

      return this.mergedHover(params, options) as Promise<TResult>
    }
    if (method === 'textDocument/codeAction') {
      const lanes = this.ready('codeActions', method)
      const lane = lanes.length === 1 ? lanes[0] : undefined
      if (lane) {
        return this.requestSingle(lane, method, params, options, [], (result) =>
          this.mergeArrayResults('codeActions', [{ lane, result }]),
        ) as Promise<TResult>
      }

      return this.mergedArray('codeActions', method, params, options) as Promise<TResult>
    }
    if (method === 'textDocument/documentHighlight') {
      const lanes = this.ready('documentHighlights', method)
      if (lanes.length === 1) {
        return this.requestSingle(lanes[0], method, params, options, []) as Promise<TResult>
      }

      return this.mergedArray('documentHighlights', method, params, options) as Promise<TResult>
    }
    if (method === 'codeAction/resolve')
      return this.resolveCodeAction(params, options) as Promise<TResult>

    const feature = featureForMethod(method)
    if (!feature) return Promise.resolve(null as TResult)

    const lane = this.ready(feature, method)[0]
    return this.requestSingle(lane, method, params, options, null) as Promise<TResult>
  }

  async mergedHover<TParams>(params: TParams | undefined, options: LspRequestOptions) {
    const results = await this.requestAll('hover', 'textDocument/hover', params, options)
    const hovers = results.flatMap(({ result }) => (isHover(result) ? [result] : []))
    if (hovers.length === 0) return null

    return {
      contents: {
        kind: 'markdown',
        value: hovers.map((hover) => hoverContentsText(hover.contents)).join('\n\n---\n\n'),
      },
      range: hovers.find((hover) => hover.range)?.range,
    } satisfies lsp.Hover
  }

  async mergedArray<TParams>(
    feature: 'codeActions' | 'documentHighlights',
    method: string,
    params: TParams | undefined,
    options: LspRequestOptions,
  ) {
    const results = await this.requestAll(feature, method, params, options)
    return this.mergeArrayResults(feature, results)
  }

  mergeArrayResults(feature: 'codeActions' | 'documentHighlights', results: readonly LaneResult[]) {
    const merged: unknown[] = []
    for (const { lane, result } of results) {
      if (!Array.isArray(result)) continue

      for (const item of result) {
        if (!isRecord(item)) continue
        if (feature === 'codeActions' && !usableCodeAction(item, lane)) continue

        this.#provenance.set(item, lane)
        merged.push(item)
      }
    }

    return merged
  }

  async resolveCodeAction<TParams>(params: TParams | undefined, options: LspRequestOptions) {
    const lane = isRecord(params) ? this.#provenance.get(params) : undefined
    const owner = lane ?? this.ready('codeActions', 'codeAction/resolve')[0]
    if (!owner) return params ?? null

    return this.requestSingle(owner, 'codeAction/resolve', params, options, params ?? null)
  }

  requestSingle<TParams, TResult = unknown>(
    lane: LanguageServerSetLane | undefined,
    method: string,
    params: TParams | undefined,
    options: LspRequestOptions,
    fallback: TResult,
    transform: (result: unknown) => TResult = (result) => result as TResult,
  ): Promise<TResult> {
    if (!lane) return Promise.resolve(fallback)

    return lane.connection.client.request(method, params, options).then(
      (result) => {
        lane.onInteractiveReady?.()
        return transform(result)
      },
      (error) => {
        if (!isAbortError(error)) lane.onError?.(error)
        return fallback
      },
    )
  }

  async requestAll<TParams>(
    feature: LanguageServerFeatureId,
    method: string,
    params: TParams | undefined,
    options: LspRequestOptions,
  ): Promise<readonly LaneResult[]> {
    const requests = this.ready(feature, method).map(async (lane) => {
      try {
        const result = await lane.connection.client.request(method, params, options)
        lane.onInteractiveReady?.()
        return { lane, result }
      } catch (error) {
        if (!isAbortError(error)) lane.onError?.(error)
        return { lane, result: null }
      }
    })

    return Promise.all(requests)
  }
}

class RoutedLanguageServerClient {
  public constructor(private readonly servers: LanguageServerSet) {}

  public get initialized(): boolean {
    return this.servers.hasReadyLane()
  }

  public get serverCapabilities(): lsp.ServerCapabilities | null {
    return this.servers.capabilities()
  }

  public request<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams,
    options?: LspRequestOptions,
  ): Promise<TResult> {
    return this.servers.request<TResult, TParams>(method, params, options)
  }
}

export function allLanguageServerFeatures(rank = 0): LanguageServerFeatureRanks {
  return Object.fromEntries(LANGUAGE_SERVER_FEATURE_IDS.map((feature) => [feature, rank]))
}

export function laneSupports(
  lane: LanguageServerSetLane,
  feature: LanguageServerFeatureId,
  method?: string,
): boolean {
  const capabilities = lane.connection.client.serverCapabilities
  if (!capabilities) return false
  if (feature === 'diagnostics') return true
  if (feature === 'completion') return Boolean(capabilities.completionProvider)
  if (feature === 'hover') return Boolean(capabilities.hoverProvider)
  if (feature === 'navigation') return supportsNavigation(capabilities, method)
  if (feature === 'signatureHelp') return Boolean(capabilities.signatureHelpProvider)
  if (feature === 'codeActions') return Boolean(capabilities.codeActionProvider)
  if (feature === 'formatting') {
    if (method === 'textDocument/onTypeFormatting') {
      return Boolean(capabilities.documentOnTypeFormattingProvider)
    }

    return Boolean(capabilities.documentFormattingProvider)
  }
  if (feature === 'rename') return Boolean(capabilities.renameProvider)
  if (feature === 'documentHighlights') return Boolean(capabilities.documentHighlightProvider)
  return Boolean(capabilities.semanticTokensProvider)
}

function supportsNavigation(capabilities: lsp.ServerCapabilities, method?: string): boolean {
  if (method === 'textDocument/references') return Boolean(capabilities.referencesProvider)
  if (method === 'textDocument/implementation') return Boolean(capabilities.implementationProvider)
  if (method === 'textDocument/typeDefinition') return Boolean(capabilities.typeDefinitionProvider)
  return Boolean(capabilities.definitionProvider)
}

function featureForMethod(method: string): LanguageServerFeatureId | null {
  if (method === 'textDocument/signatureHelp') return 'signatureHelp'
  if (method === 'textDocument/formatting') return 'formatting'
  if (method === 'textDocument/onTypeFormatting') return 'formatting'
  if (method === 'textDocument/rename') return 'rename'
  if (method === 'textDocument/definition') return 'navigation'
  if (method === 'textDocument/references') return 'navigation'
  if (method === 'textDocument/implementation') return 'navigation'
  if (method === 'textDocument/typeDefinition') return 'navigation'
  return null
}

function compareFeatureRank(
  left: LanguageServerSetLane,
  right: LanguageServerSetLane,
  feature: LanguageServerFeatureId,
  lanes: readonly LanguageServerSetLane[],
): number {
  const rank = (left.features[feature] ?? 0) - (right.features[feature] ?? 0)
  if (rank !== 0) return rank

  return lanes.indexOf(left) - lanes.indexOf(right)
}

function usableCodeAction(item: Record<string, unknown>, lane: LanguageServerSetLane): boolean {
  if (item.edit !== undefined) return true
  if (typeof item.command === 'string') return true

  const provider = lane.connection.client.serverCapabilities?.codeActionProvider
  return isRecord(provider) && provider.resolveProvider === true
}

function codeActionCapability(
  lanes: readonly LanguageServerSetLane[],
): lsp.ServerCapabilities['codeActionProvider'] {
  if (lanes.length === 0) return false
  const resolves = lanes.some((lane) => {
    const provider = lane.connection.client.serverCapabilities?.codeActionProvider
    return isRecord(provider) && provider.resolveProvider === true
  })

  return resolves ? { resolveProvider: true } : true
}

function isHover(value: unknown): value is lsp.Hover {
  return isRecord(value) && value.contents !== undefined
}

function hoverContentsText(contents: lsp.Hover['contents']): string {
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) return contents.map(markedStringText).join('\n\n')
  if ('kind' in contents) return contents.value
  return markedStringText(contents)
}

function markedStringText(value: lsp.MarkedString): string {
  if (typeof value === 'string') return value
  return ['```' + value.language, value.value, '```'].join('\n')
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  return isRecord(error) && error.name === 'LspRequestCancelledError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
