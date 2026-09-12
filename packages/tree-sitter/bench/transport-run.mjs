import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createError } from '../../editor/src/logging/evlog.ts'
import { buildTransportBenchmark, transportBuildDirectory } from './transport-build.ts'

const prefix = '/__sab-bench__/'
const benchDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(benchDirectory, '../../..')
const { values } = parseArgs({
  options: {
    repetitions: { type: 'string', default: '10' },
    lines: { type: 'string', default: '10000,50000' },
    edits: { type: 'string', default: '20' },
    warmups: { type: 'string', default: '3' },
    fanout: { type: 'boolean', default: false },
    output: { type: 'string', default: '/work/tmp/sab-bench/results.json' },
    origin: { type: 'string', default: 'http://127.0.0.1:3300' },
    executable: { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
})

function failure(code, why) {
  return createError({
    message: why,
    status: 422,
    code,
    why,
    fix: 'Inspect the benchmark configuration and browser diagnostics.',
  })
}

function positiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw failure('BENCH_INVALID_OPTION', `${name} must be a positive integer`)
  }
  return parsed
}

const options = {
  repetitions: positiveInteger(values.repetitions, 'repetitions'),
  lines: values.lines.split(',').map((value) => positiveInteger(value, 'lines')),
  edits: positiveInteger(values.edits, 'edits'),
  warmups: positiveInteger(values.warmups, 'warmups'),
  fanout: values.fanout,
}
const origin = new URL(values.origin).origin
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
}
const html = '<!doctype html><meta charset="utf-8"><title>SAB transport benchmark</title>'
const errors = []

function contentType(path) {
  if (path.endsWith('.wasm')) return 'application/wasm'
  if (path.endsWith('.js')) return 'text/javascript'
  if (path.endsWith('.json') || path.endsWith('.map')) return 'application/json'
  return 'application/octet-stream'
}

async function fulfillBenchmark(route) {
  const url = new URL(route.request().url())
  if (url.origin !== origin || !url.pathname.startsWith(prefix)) {
    await route.abort('blockedbyclient')
    return
  }
  if (url.pathname === `${prefix}index.html`) {
    await route.fulfill({ status: 200, headers, contentType: 'text/html', body: html })
    return
  }
  const relative = decodeURIComponent(url.pathname.slice(prefix.length))
  const path = resolve(transportBuildDirectory, relative)
  if (!path.startsWith(transportBuildDirectory + '/')) {
    await route.abort('blockedbyclient')
    return
  }
  await route.fulfill({
    status: 200,
    headers,
    contentType: contentType(path),
    body: await readFile(path),
  })
}

function git(...args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
}

async function fileHashes(directory, paths) {
  const entries = await Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(join(directory, path))
      return [path, createHash('sha256').update(bytes).digest('hex')]
    }),
  )
  return Object.fromEntries(entries)
}

async function provenance(manifest) {
  const benchmarkFiles = [
    'transport-build.ts',
    'transport-run.mjs',
    'transport-browser.ts',
    'transport-fanout.ts',
  ]
  const outputFiles = [
    'browser.js',
    'browser.js.map',
    'worker.js',
    'worker.js.map',
    'manifest.json',
    ...Object.keys(manifest.assets).map((path) => path.slice(prefix.length)),
  ]
  return {
    capturedAt: new Date().toISOString(),
    editorHead: git('rev-parse', 'HEAD').trim(),
    dirtyTrackedPaths: git('diff', '--name-only', 'HEAD', '-z').split('\0').filter(Boolean),
    untrackedPaths: git('ls-files', '--others', '--exclude-standard', '-z')
      .split('\0')
      .filter(Boolean),
    machine: {
      cpuModels: [...new Set(cpus().map((cpu) => cpu.model))],
      logicalCpus: cpus().length,
      platform: platform(),
      arch: arch(),
      release: release(),
      memoryBytes: totalmem(),
    },
    runtime: { bunVersion: process.versions.bun, nodeCompatibilityVersion: process.versions.node },
    benchmarkFileHashes: await fileHashes(benchDirectory, benchmarkFiles),
    buildOutputHashes: await fileHashes(transportBuildDirectory, outputFiles),
  }
}

console.log(JSON.stringify({ phase: 'build', options }))
const manifest = await buildTransportBenchmark()
const sourceProvenance = await provenance(manifest)
const browser = await chromium.launch({
  headless: !values.headed,
  ...(values.executable ? { executablePath: values.executable } : {}),
})

try {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('**/*', fulfillBenchmark)
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    errors.push(message.text())
  })
  await page.goto(`${origin}${prefix}index.html`)
  const capability = await page.evaluate(() => ({
    crossOriginIsolated: globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
  }))
  if (!capability.crossOriginIsolated || !capability.sharedArrayBuffer) {
    throw failure('BENCH_ISOLATION_UNAVAILABLE', JSON.stringify(capability))
  }
  console.log(JSON.stringify({ phase: 'run', capability }))
  await page.evaluate(async () => {
    await import('/__sab-bench__/browser.js')
  })
  const result = await page.evaluate((options) => globalThis.sabBenchmark.run(options), options)
  if (errors.length > 0) throw failure('BENCH_BROWSER_ERRORS', errors.join('\n'))
  const output = resolve(values.output)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(
    output,
    JSON.stringify(
      {
        options,
        capability,
        browserVersion: browser.version(),
        manifest,
        provenance: sourceProvenance,
        result,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(JSON.stringify({ phase: 'complete', output }))
} finally {
  await browser.close()
}
