import {
  applyBatchToPieceTable,
  createPieceTableSnapshot,
  type PieceTableSnapshot,
  type TextEdit,
} from '@singapore-editor/core/document'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/index'
import { resolveTreeSitterLanguageContribution } from '../src'
import { createTreeSitterEditPayload } from '../src/session'
import {
  createTreeSitterSourceDescriptor,
  readTreeSitterInputRange,
  resolveTreeSitterSourceDescriptor,
} from '../src/treeSitter/source'
import type { TreeSitterParseResult, TreeSitterWorkerResult } from '../src/treeSitter/types'
import { TreeSitterWorkerClient } from '../src/treeSitter/workerClient'
import { runFanout } from './transport-fanout'

type Mode = 'string' | 'sab' | 'string-control'
type Metric = {
  name: string
  durationMs?: number
  units?: number
  bytes?: number
  chunks?: number
  spans?: number
  kind?: string
  sharedChunks?: number
  isolated?: boolean
  sabAvailable?: boolean
}
type Options = {
  repetitions: number
  lines: number[]
  edits?: number
  warmups?: number
  fanout?: boolean
}
type Sample = {
  mode: Mode
  lines: number
  repetition: number
  phase: string
  editIndex: number
  totalMs: number
  mainDescriptorMs: number
  mainPostMs: number
  workerResolveMs: number
  sourceUnits: number
  sourceChunks: number
  sourceSpans: number
  sourceKinds: string[]
  workerSharedChunks: number
  timings: ReadonlyArray<{ name: string; durationMs: number }>
  resultDigest: string
  resultVersion: number | null
  cancelled: boolean
  expectedVersion: number
}

declare global {
  var __sabBenchMode: Mode
  var __sabBenchMetrics: Metric[]
  var __sabBenchResponses: Metric[][]
  var sabBenchmark: { run(options: Options): Promise<unknown> }
}

const modes: Mode[] = ['string', 'sab', 'string-control']
const originalPost = Worker.prototype.postMessage
let postedMs = 0
let runId = 0

Worker.prototype.postMessage = function (message, transferOrOptions) {
  const started = performance.now()
  try {
    const options = Array.isArray(transferOrOptions)
      ? { transfer: transferOrOptions }
      : transferOrOptions
    return originalPost.call(this, message, options)
  } finally {
    postedMs += performance.now() - started
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DOMException(message, 'BenchmarkValidationError')
}

function textFixture(lines: number): string {
  const rows: string[] = []
  for (let line = 0; line < lines; line += 10) {
    rows.push(
      `export function value${line}() {\n`,
      '  const item = {\n',
      `    line: ${line},\n`,
      `    label: "line-${line}",\n`,
      '  };\n',
      '  if (item.line % 2 === 0) {\n',
      '    return item.label;\n',
      '  }\n',
      '  return String(item.line);\n',
      '}\n',
    )
  }
  return rows.join('')
}

function hash(text: string): string {
  let digest = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    digest = Math.imul(digest ^ text.charCodeAt(index), 16777619)
  }
  return (digest >>> 0).toString(16)
}

function digestResult(result: TreeSitterWorkerResult): string {
  if (!result) return 'cancelled'
  if ('captures' in result) {
    return hash(
      JSON.stringify({
        captures: result.captures,
        folds: result.folds,
        brackets: result.brackets,
        errors: result.errors,
        injections: result.injections,
        tokens: result.tokens,
        tokensPacked: result.tokensPacked,
        degraded: result.degraded,
      }),
    )
  }
  if ('changedRanges' in result)
    return hash(JSON.stringify({ status: result.status, changedRanges: result.changedRanges }))
  return hash(JSON.stringify(result))
}

function resetMetrics(): void {
  globalThis.__sabBenchMetrics = []
  globalThis.__sabBenchResponses = []
  postedMs = 0
}

function duration(metrics: Metric[], name: string): number {
  return metrics
    .filter((metric) => metric.name === name)
    .reduce((sum, metric) => sum + (metric.durationMs ?? 0), 0)
}

async function measure(
  identity: Pick<
    Sample,
    'mode' | 'lines' | 'repetition' | 'phase' | 'editIndex' | 'expectedVersion'
  >,
  request: () => Promise<TreeSitterWorkerResult>,
): Promise<Sample> {
  resetMetrics()
  const started = performance.now()
  const result = await request()
  const totalMs = performance.now() - started
  const main = globalThis.__sabBenchMetrics
  const worker = globalThis.__sabBenchResponses.flat()
  const descriptors = main.filter((metric) => metric.name === 'source.descriptor')
  const resolutions = worker.filter((metric) => metric.name === 'source.resolve')
  const kinds = descriptors
    .filter((metric) => (metric.chunks ?? 0) > 0)
    .map((metric) => metric.kind ?? 'missing')
  const expectedKind = identity.mode === 'sab' ? 'shared-utf16' : 'string'
  assert(
    kinds.every((kind) => kind === expectedKind),
    `wrong transport ${identity.mode}: ${kinds}`,
  )
  if (identity.phase === 'open-full') verifyWorkerMetrics(identity.mode, descriptors, worker)
  if (identity.phase.startsWith('query-')) assert(descriptors.length === 0, 'query resent source')
  if (identity.phase === 'edit') {
    assert(
      descriptors.every((metric) => (metric.units ?? 0) <= 16384),
      'edit resent unchanged chunks',
    )
  }
  assert(
    !result || !('degraded' in result) || !result.degraded?.length,
    'degraded parse in comparison',
  )
  assert(
    result && 'snapshotVersion' in result && result.snapshotVersion === identity.expectedVersion,
    'worker returned the wrong version',
  )
  return {
    ...identity,
    totalMs,
    mainDescriptorMs: duration(main, 'source.descriptor'),
    mainPostMs: postedMs,
    workerResolveMs: duration(worker, 'source.resolve'),
    sourceUnits: descriptors.reduce((sum, metric) => sum + (metric.units ?? 0), 0),
    sourceChunks: descriptors.reduce((sum, metric) => sum + (metric.chunks ?? 0), 0),
    sourceSpans: descriptors.reduce((sum, metric) => sum + (metric.spans ?? 0), 0),
    sourceKinds: kinds,
    workerSharedChunks: resolutions.reduce((sum, metric) => sum + (metric.sharedChunks ?? 0), 0),
    timings: result && 'timings' in result ? result.timings : [],
    resultDigest: digestResult(result),
    resultVersion: result && 'snapshotVersion' in result ? result.snapshotVersion : null,
    cancelled: !result,
  }
}

function verifyWorkerMetrics(mode: Mode, descriptors: Metric[], worker: Metric[]): void {
  assert(
    descriptors.some((metric) => (metric.chunks ?? 0) > 0),
    'source instrumentation did not observe open',
  )
  const isolation = worker.find((metric) => metric.name === 'worker.isolation')
  assert(isolation?.isolated && isolation.sabAvailable, 'worker is not SAB-capable in both arms')
  const shared = worker.reduce((sum, metric) => sum + (metric.sharedChunks ?? 0), 0)
  assert(mode === 'sab' ? shared > 0 : shared === 0, 'worker received the wrong source storage')
}

async function register(client: TreeSitterWorkerClient): Promise<void> {
  const contribution = TREE_SITTER_LANGUAGE_CONTRIBUTIONS.find((item) => item.id === 'typescript')
  assert(contribution, 'TypeScript contribution missing')
  await client.registerLanguages([await resolveTreeSitterLanguageContribution(contribution)])
}

async function release(client: TreeSitterWorkerClient, runtimeSessionId: string): Promise<void> {
  client.disposeDocument(runtimeSessionId)
  await client.awaitRuntimeSessionIdle(runtimeSessionId)
}

function editRequest(
  client: TreeSitterWorkerClient,
  runtimeSessionId: string,
  previous: PieceTableSnapshot,
  next: PieceTableSnapshot,
  edit: TextEdit,
  version: number,
): () => Promise<TreeSitterWorkerResult> {
  const payload = createTreeSitterEditPayload({
    documentId: 'transport.ts',
    runtimeSessionId,
    languageId: 'typescript',
    previousSnapshotVersion: version - 1,
    snapshotVersion: version,
    previousSnapshot: previous,
    nextSnapshot: next,
    edits: [edit],
    resultMode: 'parseOnly',
  })
  assert(payload, 'edit payload could not be generated')
  return () => client.edit(payload)
}

async function query(
  client: TreeSitterWorkerClient,
  runtimeSessionId: string,
  snapshot: PieceTableSnapshot,
  version: number,
): Promise<TreeSitterParseResult | undefined> {
  return client.queryRange({
    documentId: 'transport.ts',
    runtimeSessionId,
    snapshotVersion: version,
    languageId: 'typescript',
    includeHighlights: true,
    includeCaptures: true,
    range: { startIndex: Math.max(0, snapshot.length - 3000), endIndex: snapshot.length },
  })
}

async function trial(
  client: TreeSitterWorkerClient,
  mode: Mode,
  lines: number,
  repetition: number,
  edits: number,
): Promise<Sample[]> {
  globalThis.__sabBenchMode = mode
  const runtimeSessionId = `transport-${runId++}`
  let snapshot = createPieceTableSnapshot(textFixture(lines))
  let version = 1
  const base = {
    mode,
    lines,
    repetition,
    get expectedVersion() {
      return version
    },
  }
  const samples: Sample[] = []
  try {
    samples.push(
      await measure({ ...base, phase: 'open-full', editIndex: -1 }, () =>
        client.parse({
          documentId: 'transport.ts',
          runtimeSessionId,
          snapshotVersion: version,
          languageId: 'typescript',
          snapshot,
        }),
      ),
    )
    for (let index = 0; index < edits; index += 1) {
      const edit: TextEdit = {
        from: snapshot.length,
        to: snapshot.length,
        text: index === 0 ? '\n// typing ' : 'x',
      }
      const next = applyBatchToPieceTable(snapshot, [edit])
      version += 1
      const request = editRequest(client, runtimeSessionId, snapshot, next, edit, version)
      samples.push(await measure({ ...base, phase: 'edit', editIndex: index }, request))
      snapshot = next
    }
    samples.push(
      await measure({ ...base, phase: 'query-after-edits', editIndex: -1 }, () =>
        query(client, runtimeSessionId, snapshot, version),
      ),
    )
    const paste: TextEdit = {
      from: snapshot.length,
      to: snapshot.length,
      text: '\n' + textFixture(2000),
    }
    const pasted = applyBatchToPieceTable(snapshot, [paste])
    version += 1
    samples.push(
      await measure(
        { ...base, phase: 'large-paste', editIndex: -1 },
        editRequest(client, runtimeSessionId, snapshot, pasted, paste, version),
      ),
    )
    snapshot = pasted
    samples.push(
      await measure({ ...base, phase: 'query-after-paste', editIndex: -1 }, () =>
        query(client, runtimeSessionId, snapshot, version),
      ),
    )
    samples.push(
      await measure({ ...base, phase: 'query-control', editIndex: -1 }, () =>
        query(client, runtimeSessionId, snapshot, version),
      ),
    )
    return samples
  } finally {
    await release(client, runtimeSessionId)
  }
}

function verifyUnicode(): { cases: number; codeUnits: number } {
  const corpus = [
    'ascii',
    'é中\0',
    '\ud800x\udc00',
    'x'.repeat(16383) + '😀tail',
    'x'.repeat(4095) + '😀tail',
    'x'.repeat(16384) + '\ufeff�end',
  ]
  let codeUnits = 0
  for (const text of corpus) {
    const snapshot = createPieceTableSnapshot(text)
    verifySource(snapshot, false)
    verifySource(snapshot, true)
    codeUnits += snapshot.length
  }
  return { cases: corpus.length, codeUnits }
}

function verifySource(snapshot: PieceTableSnapshot, shared: boolean): void {
  const descriptor = createTreeSitterSourceDescriptor(snapshot, { useSharedBuffers: shared })
  const input = resolveTreeSitterSourceDescriptor(new Map(), 'unicode', descriptor)
  const roundtrip = readTreeSitterInputRange(input, 0, snapshot.length)
  const baseline = createTreeSitterSourceDescriptor(snapshot, { useSharedBuffers: false })
  const ordinary = resolveTreeSitterSourceDescriptor(new Map(), 'baseline', baseline)
  assert(
    roundtrip === readTreeSitterInputRange(ordinary, 0, snapshot.length),
    'source changed UTF-16 units',
  )
}

function verifyDigests(samples: Sample[]): void {
  const expected = new Map<string, string>()
  for (const sample of samples) {
    assert(!sample.cancelled, 'sequential request cancelled unexpectedly')
    const key = `${sample.lines}:${sample.phase}:${sample.editIndex}`
    const signature = JSON.stringify([
      sample.resultDigest,
      sample.resultVersion,
      sample.sourceUnits,
      sample.sourceChunks,
      sample.sourceSpans,
    ])
    const previous = expected.get(key)
    if (previous !== undefined)
      assert(previous === signature, `result or source traffic mismatch ${key}`)
    expected.set(key, signature)
  }
}

async function run(options: Options): Promise<unknown> {
  assert(
    crossOriginIsolated && typeof SharedArrayBuffer === 'function',
    'benchmark document is not isolated',
  )
  resetMetrics()
  const unicode = verifyUnicode()
  const clients = new Map<Mode, TreeSitterWorkerClient>()
  const samples: Sample[] = []
  try {
    for (const mode of modes) {
      const client = new TreeSitterWorkerClient()
      clients.set(mode, client)
      await warmClient(client, mode, options.warmups ?? 3)
    }
    for (const lines of options.lines) {
      await runSize(clients, samples, options, lines)
    }
    verifyDigests(samples)
  } finally {
    for (const client of clients.values()) await client.dispose()
  }
  const fanout = options.fanout
    ? await runFanout({
        repetitions: options.repetitions,
        sizes: [1_000_000, 8_000_000],
        workers: [1, 2, 4],
      })
    : null
  return {
    schemaVersion: 1,
    options,
    page: {
      isolated: crossOriginIsolated,
      sabAvailable: typeof SharedArrayBuffer === 'function',
      userAgent: navigator.userAgent,
    },
    unicode,
    samples,
    fanout,
  }
}

async function warmClient(
  client: TreeSitterWorkerClient,
  mode: Mode,
  warmups: number,
): Promise<void> {
  await register(client)
  for (let warmup = 0; warmup < warmups; warmup += 1) await trial(client, mode, 1000, -1, 3)
}

async function runSize(
  clients: Map<Mode, TreeSitterWorkerClient>,
  samples: Sample[],
  options: Options,
  lines: number,
): Promise<void> {
  for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
    const offset = repetition % modes.length
    const rotated = [...modes.slice(offset), ...modes.slice(0, offset)]
    const order = repetition % 2 === 0 ? rotated : rotated.reverse()
    for (const mode of order) {
      const client = clients.get(mode)
      assert(client, 'missing trial client')
      samples.push(...(await trial(client, mode, lines, repetition, options.edits ?? 20)))
    }
  }
}

globalThis.sabBenchmark = { run }
