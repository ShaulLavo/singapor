/*
 * The one suite in this package that runs against a real TypeScript checker.
 *
 * `worker.test.ts` replaces `typescript` and `@typescript/vfs` with fakes at module scope, which is
 * right for asserting the worker's message plumbing and useless for asserting anything a checker
 * computes. So this lives in its own file, and mocks neither.
 *
 * `fetch` is stubbed to throw for the whole file. That is the assertion, not a precaution: the
 * milestone this suite closes is "the tests can build a language service with the network off", and
 * a stub that throws is the only way to prove no code path quietly dialled out.
 */

import ts from 'typescript'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as lsp from 'vscode-languageserver-protocol'
import {
  createRealTypeScriptService,
  REAL_SERVICE_COMPILER_OPTIONS,
  typeScriptLibraryFilesFromDisk,
} from './realTypeScriptService'

const FIXTURE_FILE_NAME = '/src/fixture.ts'
const FIXTURE_SOURCE = `export type Shape = {
  readonly kind: 'circle' | 'square'
  readonly size: number
}

export interface Renderer {
  render(shape: Shape): string
}

export class ConsoleRenderer implements Renderer {
  #prefix: string

  constructor(prefix: string) {
    this.#prefix = prefix
  }

  render(shape: Shape): string {
    return \`\${this.#prefix}:\${shape.kind}:\${shape.size}\`
  }
}

export const renderAll = (renderer: Renderer, shapes: readonly Shape[]): string[] =>
  shapes.map((shape) => renderer.render(shape))
`

// Anything that reaches the network from inside a test is a bug, so say so where it is thrown —
// the message is what the CDN assertion below matches on.
const OFFLINE_MESSAGE = 'the TypeScript LSP suites must not reach the network'
const offlineFetch = vi.fn((_input: unknown): never => {
  throw new Error(OFFLINE_MESSAGE)
})

describe('a real TypeScript language service, offline', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', offlineFetch)
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    offlineFetch.mockClear()
  })

  it('builds a service from the lib files installed on disk', () => {
    const libraries = typeScriptLibraryFilesFromDisk()
    const env = createRealTypeScriptService(new Map([[FIXTURE_FILE_NAME, FIXTURE_SOURCE]]))

    expect(libraries.get('/lib.es5.d.ts')).toContain('interface Array<T>')
    expect(env.getSourceFile(FIXTURE_FILE_NAME)?.text).toBe(FIXTURE_SOURCE)
    expect(env.languageService.getSemanticDiagnostics(FIXTURE_FILE_NAME)).toEqual([])
    expect(offlineFetch).not.toHaveBeenCalled()
  })

  it('classifies a fixture into whole triples of encoded spans', () => {
    const env = createRealTypeScriptService(new Map([[FIXTURE_FILE_NAME, FIXTURE_SOURCE]]))

    const { spans } = env.languageService.getEncodedSemanticClassifications(
      FIXTURE_FILE_NAME,
      ts.createTextSpan(0, FIXTURE_SOURCE.length),
      ts.SemanticClassificationFormat.TwentyTwenty,
    )

    expect(spans.length).toBeGreaterThan(0)
    expect(spans.length % 3).toBe(0)
    expect(offlineFetch).not.toHaveBeenCalled()
  })

  it('keeps the harness compiler options identical to the worker defaults', async () => {
    const { __typeScriptLspWorkerInternalsForTests } = await import('../src/typescriptLsp.worker')

    expect(REAL_SERVICE_COMPILER_OPTIONS).toEqual(
      __typeScriptLspWorkerInternalsForTests.defaultCompilerOptions(),
    )
  })

  it('lets createService take a lib map instead of fetching one', async () => {
    const { __typeScriptLspWorkerInternalsForTests } = await import('../src/typescriptLsp.worker')
    setWorkspaceFiles([{ path: 'src/fixture.ts', text: FIXTURE_SOURCE }])

    const state = await __typeScriptLspWorkerInternalsForTests.createService(
      typeScriptLibraryFilesFromDisk(),
    )

    expect(offlineFetch).not.toHaveBeenCalled()
    expect(state.env.getSourceFile(FIXTURE_FILE_NAME)?.text).toBe(FIXTURE_SOURCE)
    expect(
      state.env.languageService.getEncodedSemanticClassifications(
        FIXTURE_FILE_NAME,
        ts.createTextSpan(0, FIXTURE_SOURCE.length),
        ts.SemanticClassificationFormat.TwentyTwenty,
      ).spans.length,
    ).toBeGreaterThan(0)
  })

  it('still fetches the lib files from the CDN when no lib map is given', async () => {
    const { __typeScriptLspWorkerInternalsForTests } = await import('../src/typescriptLsp.worker')
    setWorkspaceFiles([])

    await expect(__typeScriptLspWorkerInternalsForTests.createService()).rejects.toThrow(
      OFFLINE_MESSAGE,
    )

    expect(offlineFetch).toHaveBeenCalled()
    expect(String(offlineFetch.mock.calls[0]?.[0])).toContain(
      `playgroundcdn.typescriptlang.org/cdn/${ts.version}/typescript/lib/lib.`,
    )
  })
})

function setWorkspaceFiles(files: readonly { path: string; text: string }[]): void {
  send({
    jsonrpc: '2.0',
    method: 'editor/typescript/setWorkspaceFiles',
    params: { files },
  })
}

function send(message: lsp.NotificationMessage): void {
  const target = globalThis as unknown as {
    onmessage?: (event: MessageEvent) => void
  }
  target.onmessage?.(new MessageEvent('message', { data: message }))
}
