import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createError } from '@singapore-editor/core/logging/evlog'

type BuildPlugin = {
  name: string
  setup(builder: {
    onResolve(
      filter: { filter: RegExp },
      run: (args: { path: string; resolveDir: string }) => {
        path: string
        namespace?: string
      },
    ): void
    onLoad(
      filter: { filter: RegExp; namespace?: string },
      run: (args: { path: string }) => Promise<{
        contents: string
        loader: 'js' | 'ts'
      }>,
    ): void
  }): void
}

declare const Bun: {
  resolveSync(specifier: string, directory: string): string
  build(options: {
    entrypoints: string[]
    outdir: string
    target: 'browser'
    format: 'esm'
    splitting: boolean
    external: string[]
    minify: boolean
    sourcemap: 'external'
    naming: string
    plugins: BuildPlugin[]
  }): Promise<{ success: boolean; logs: unknown[] }>
}

const benchDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(benchDirectory, '../../..')
const routePrefix = '/__sab-bench__/'
export const transportBuildDirectory = '/work/tmp/sab-bench/build'

function benchmarkFailure(code: string, why: string): never {
  throw createError({
    message: why,
    status: 422,
    code,
    why,
    fix: 'Check the benchmark source anchors and current build dependencies.',
  })
}

function replaceOnce(source: string, anchor: string, replacement: string): string {
  const occurrences = source.split(anchor).length - 1
  if (occurrences !== 1) {
    benchmarkFailure(
      'BENCH_SOURCE_DRIFT',
      `Expected one occurrence of ${anchor}; got ${occurrences}`,
    )
  }
  return source.replace(anchor, replacement)
}

function hash(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

function sourceTarget(packageDirectory: string, target: unknown): string | null {
  if (typeof target !== 'string' || !target.startsWith('./dist/')) return null
  if (!target.endsWith('.js')) return null
  const stem = resolve(packageDirectory, target.replace('./dist/', './src/').slice(0, -3))
  return [stem + '.ts', stem + '.tsx', stem + '.js'].find(existsSync) ?? null
}

async function sourceAliases(): Promise<Map<string, string>> {
  const aliases = new Map<string, string>()
  const packagesDirectory = join(repositoryRoot, 'packages')
  for (const entry of await readdir(packagesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    await addPackageAliases(aliases, join(packagesDirectory, entry.name))
  }
  return aliases
}

async function addPackageAliases(aliases: Map<string, string>, packageDirectory: string) {
  const packagePath = join(packageDirectory, 'package.json')
  if (!existsSync(packagePath)) return
  const manifest: unknown = JSON.parse(await readFile(packagePath, 'utf8'))
  if (!manifest || typeof manifest !== 'object' || !('name' in manifest)) return
  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@singapore-editor/')) return
  if (!('exports' in manifest) || !manifest.exports || typeof manifest.exports !== 'object') return
  for (const [subpath, declaration] of Object.entries(manifest.exports)) {
    const target = importTarget(declaration)
    const path = sourceTarget(packageDirectory, target)
    if (!path) continue
    aliases.set(manifest.name + (subpath === '.' ? '' : subpath.slice(1)), path)
  }
}

function importTarget(declaration: unknown): unknown {
  if (typeof declaration === 'string') return declaration
  if (!declaration || typeof declaration !== 'object' || !('import' in declaration)) return null
  return declaration.import
}

const metricHelpers = `
const benchSourceMetric = (name, durationMs, descriptor) => {
  const units = descriptor.chunks.reduce((total, chunk) => total +
    (chunk.kind === 'string' ? chunk.text.length : chunk.length), 0)
  const kind = descriptor.chunks[0]?.kind ?? 'none'
  ;(globalThis.__sabBenchMetrics ??= []).push({
    name, durationMs, units, bytes: units * 2, chunks: descriptor.chunks.length,
    spans: descriptor.pieces.length, sourceUnits: descriptor.length, kind,
    sharedChunks: descriptor.chunks.filter(chunk => chunk.kind === 'shared-utf16' &&
      chunk.buffer instanceof SharedArrayBuffer).length,
  })
}

export const createTreeSitterSourceDescriptor = (...args) => {
  const started = performance.now()
  const descriptor = benchOriginalCreateTreeSitterSourceDescriptor(...args)
  const durationMs = performance.now() - started
  benchSourceMetric('source.descriptor', durationMs, descriptor)
  return descriptor
}

export const resolveTreeSitterSourceDescriptor = (...args) => {
  const started = performance.now()
  const input = benchOriginalResolveTreeSitterSourceDescriptor(...args)
  const durationMs = performance.now() - started
  benchSourceMetric('source.resolve', durationMs, args[2])
  return input
}
`

function instrumentSource(source: string): string {
  source = replaceOnce(
    source,
    'export const createTreeSitterSourceDescriptor =',
    'const benchOriginalCreateTreeSitterSourceDescriptor =',
  )
  source = replaceOnce(
    source,
    'export const resolveTreeSitterSourceDescriptor =',
    'const benchOriginalResolveTreeSitterSourceDescriptor =',
  )
  source = replaceOnce(
    source,
    'options.useSharedBuffers ?? supportsSharedTreeSitterSource()',
    "options.useSharedBuffers ?? (globalThis.__sabBenchMode === 'sab')",
  )
  return source + metricHelpers
}

function instrumentClient(source: string): string {
  source = replaceOnce(
    source,
    "new URL('./treeSitter.worker.ts', import.meta.url)",
    `new URL('${routePrefix}worker.js', globalThis.location.origin)`,
  )
  return replaceOnce(
    source,
    'handle.onmessage = (event) => this.handleWorkerMessage(event)',
    `handle.onmessage = (event) => {
      globalThis.__sabBenchResponses?.push(event.data.__sabBenchMetrics ?? [])
      this.handleWorkerMessage(event)
    }`,
  )
}

function resolveAsset(specifier: string, resolveDirectory: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return resolve(resolveDirectory, specifier)
  }
  return Bun.resolveSync(specifier, resolveDirectory)
}

export async function buildTransportBenchmark() {
  await mkdir(join(transportBuildDirectory, 'assets'), { recursive: true })
  const aliases = await sourceAliases()
  const sourceHashes = new Map<string, string>()
  const assets = new Map<string, string>()
  const workerEntry = join(transportBuildDirectory, 'worker-entry.ts')
  const workerModule = join(
    repositoryRoot,
    'packages/tree-sitter/src/treeSitter/treeSitter.worker.ts',
  )
  await writeFile(
    workerEntry,
    `
import * as workerModule from ${JSON.stringify(workerModule)}
globalThis.__sabBenchWorkerModule = workerModule
globalThis.__sabBenchMetrics = []
const originalPost = globalThis.postMessage.bind(globalThis)
globalThis.postMessage = (response, transfer) => {
  const metrics = globalThis.__sabBenchMetrics.splice(0)
  metrics.push({ name: 'worker.isolation', isolated: globalThis.crossOriginIsolated,
    sabAvailable: typeof SharedArrayBuffer === 'function' })
  originalPost({ ...response, __sabBenchMetrics: metrics }, transfer)
}
`,
  )

  const plugin: BuildPlugin = {
    name: 'sab-benchmark-current-source',
    setup(build) {
      build.onResolve({ filter: /^@singapore-editor\// }, (args) => {
        const path = aliases.get(args.path)
        if (!path)
          benchmarkFailure('BENCH_SOURCE_EXPORT_MISSING', `No source export for ${args.path}`)
        return { path }
      })
      build.onResolve({ filter: /\?(raw|url)$/ }, (args) => {
        const separator = args.path.lastIndexOf('?')
        const specifier = args.path.slice(0, separator)
        const kind = args.path.slice(separator + 1)
        return { path: resolveAsset(specifier, args.resolveDir), namespace: `bench-${kind}` }
      })
      build.onLoad({ filter: /.*/, namespace: 'bench-raw' }, async (args) => ({
        contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`,
        loader: 'js',
      }))
      build.onLoad({ filter: /.*/, namespace: 'bench-url' }, async (args) => {
        const bytes = await readFile(args.path)
        const name = `${hash(bytes).slice(0, 16)}-${basename(args.path)}`
        const output = join(transportBuildDirectory, 'assets', name)
        await writeFile(output, bytes)
        assets.set(`${routePrefix}assets/${name}`, args.path)
        return {
          contents: `export default ${JSON.stringify(`${routePrefix}assets/${name}`)}`,
          loader: 'js',
        }
      })
      build.onLoad({ filter: /\/treeSitter\/(source|workerClient)\.ts$/ }, async (args) => {
        const source = await readFile(args.path, 'utf8')
        sourceHashes.set(args.path, hash(source))
        const contents =
          basename(args.path) === 'source.ts' ? instrumentSource(source) : instrumentClient(source)
        return { contents, loader: 'ts' }
      })
    },
  }

  for (const { entrypoint, output } of [
    { entrypoint: join(benchDirectory, 'transport-browser.ts'), output: 'browser.js' },
    { entrypoint: workerEntry, output: 'worker.js' },
  ]) {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      outdir: transportBuildDirectory,
      target: 'browser',
      format: 'esm',
      splitting: false,
      external: ['module'],
      minify: false,
      sourcemap: 'external',
      naming: output,
      plugins: [plugin],
    })
    if (!result.success) benchmarkFailure('BENCH_BUILD_FAILED', result.logs.map(String).join('\n'))
  }

  const manifest = {
    builtAt: new Date().toISOString(),
    repositoryRoot,
    sourceHashes: Object.fromEntries(sourceHashes),
    sourceAliases: Object.fromEntries(aliases),
    assets: Object.fromEntries(assets),
    instrumentation: [
      'source default mode override',
      'descriptor and resolve timing',
      'worker response metrics',
    ],
  }
  await writeFile(
    join(transportBuildDirectory, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  return manifest
}

if (import.meta.main) {
  await buildTransportBenchmark()
  console.log(transportBuildDirectory)
}
