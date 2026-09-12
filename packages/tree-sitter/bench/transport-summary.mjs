import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createError } from '../../editor/src/logging/evlog.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    format: { type: 'string', default: 'markdown' },
    'json-output': { type: 'string' },
    'markdown-output': { type: 'string' },
  },
})

function fail(message) {
  throw createError({
    message,
    status: 422,
    code: 'BENCH_SUMMARY_INVALID',
    why: message,
    fix: 'Supply one complete transport benchmark JSON file with matching comparison arms.',
  })
}

function number(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`Invalid ${label}`)
  return value
}

function timing(sample, names) {
  const selected = sample.timings.filter((item) => names.includes(item.name))
  if (selected.length === 0) return null
  return selected.reduce((sum, item) => sum + number(item.durationMs, item.name), 0)
}

function treeSample(sample) {
  if (!['string', 'sab', 'string-control'].includes(sample.mode)) fail('Unknown syntax mode')
  if (!Array.isArray(sample.timings)) fail('Missing syntax timings')
  if (sample.cancelled) fail('Sequential syntax sample was cancelled')
  return {
    ...sample,
    slot: sample.editIndex,
    metrics: {
      totalMs: sample.totalMs,
      mainWorkMs:
        number(sample.mainDescriptorMs, 'mainDescriptorMs') +
        number(sample.mainPostMs, 'mainPostMs'),
      mainDescriptorMs: sample.mainDescriptorMs,
      mainPostMs: sample.mainPostMs,
      workerResolveMs: sample.workerResolveMs,
      workerParseMs: timing(sample, ['treeSitter.parse']),
      workerQueryMs: timing(sample, ['treeSitter.query', 'treeSitter.queryRange']),
      workerEditMs: timing(sample, ['treeSitter.edit']),
    },
    traffic: {
      sourceUnits: sample.sourceUnits,
      sourceChunks: sample.sourceChunks,
      sourceSpans: sample.sourceSpans,
    },
  }
}

function fanoutSample(sample) {
  if (!['string', 'shared-utf16'].includes(sample.mode)) fail('Unknown fanout mode')
  if (!Array.isArray(sample.workerScanMs) || sample.workerScanMs.length !== sample.workers)
    fail('Missing fanout worker timings')
  const prepare = number(sample.prepareMs, 'prepareMs')
  const post = number(sample.syncPostMs, 'syncPostMs')
  const allReaders = number(sample.allReadersMs, 'allReadersMs')
  return {
    ...sample,
    slot: sample.retainedRead,
    metrics: {
      totalMs: sample.totalMs ?? prepare + allReaders,
      mainWorkMs: sample.mainWorkMs ?? prepare + post,
      prepareMs: prepare,
      syncPostMs: post,
      allReadersMs: allReaders,
      slowestWorkerScanMs: Math.max(...sample.workerScanMs),
    },
    traffic: sample.counters,
  }
}

function group(rows, keys) {
  const groups = new Map()
  for (const row of rows) {
    const identity = Object.fromEntries(keys.map((key) => [key, row[key]]))
    const key = JSON.stringify(identity)
    const entry = groups.get(key) ?? { identity, rows: [] }
    entry.rows.push(row)
    groups.set(key, entry)
  }
  return [...groups.values()]
}

function median(sorted) {
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

function stats(values) {
  const sorted = values
    .filter((value) => value !== null)
    .map((value) => number(value, 'metric'))
    .sort((a, b) => a - b)
  return {
    count: sorted.length,
    median: median(sorted),
    p95: sorted.length === 0 ? null : sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  }
}

function summarizeMetrics(rows) {
  return Object.fromEntries(
    Object.keys(rows[0].metrics).map((key) => [key, stats(rows.map((row) => row.metrics[key]))]),
  )
}

function summarizeTraffic(rows) {
  return Object.fromEntries(
    Object.keys(rows[0].traffic).map((key) => {
      const measured = stats(rows.map((row) => row.traffic[key]))
      return [key, { min: measured.min, max: measured.max }]
    }),
  )
}

function summarizeGroup({ identity, rows }) {
  const result = {
    ...identity,
    count: rows.length,
    repetitions: new Set(rows.map((row) => row.repetition)).size,
    metrics: summarizeMetrics(rows),
    traffic: summarizeTraffic(rows),
  }
  if (rows[0].workerScanMs) {
    result.workerScanMs = rows[0].workerScanMs.map((_, index) => ({
      worker: index,
      ...stats(rows.map((row) => row.workerScanMs[index])),
    }))
  }
  return result
}

function indexedRows(rows) {
  const indexed = new Map()
  for (const row of rows) {
    number(row.repetition, 'repetition')
    number(row.slot, 'sample slot')
    const key = JSON.stringify([row.repetition, row.slot])
    if (indexed.has(key)) fail(`Duplicate ${row.mode} sample ${key}`)
    indexed.set(key, row)
  }
  return indexed
}

function pairedRows(rows, mode) {
  const baseline = indexedRows(rows.filter((row) => row.mode === 'string'))
  const candidate = indexedRows(rows.filter((row) => row.mode === mode))
  if (baseline.size === 0 || baseline.size !== candidate.size)
    fail(`Missing paired samples for ${mode}`)
  return [...baseline].map(([key, row]) => {
    const other = candidate.get(key)
    if (!other) fail(`Missing ${mode} pair ${key}`)
    return { repetition: row.repetition, baseline: row, candidate: other }
  })
}

function repetitionDelta(rows, metric, repetition) {
  const baseline = stats(rows.map((row) => row.baseline.metrics[metric]))
  const candidate = stats(rows.map((row) => row.candidate.metrics[metric]))
  if (baseline.count !== candidate.count) fail(`Unmatched metric ${metric}`)
  if (baseline.count === 0) return null
  return {
    repetition,
    observationsPerMode: baseline.count,
    baselineMs: baseline.median,
    candidateMs: candidate.median,
    deltaMs: candidate.median - baseline.median,
  }
}

function pairedMetric(repetitions, metric) {
  const pairs = repetitions
    .map(({ identity, rows }) => repetitionDelta(rows, metric, identity.repetition))
    .filter((pair) => pair !== null)
  const deltas = stats(pairs.map((pair) => pair.deltaMs))
  return {
    repetitions: pairs.length,
    medianDeltaMs: deltas.median,
    p95DeltaMs: deltas.p95,
    minDeltaMs: deltas.min,
    maxDeltaMs: deltas.max,
    wins: pairs.filter((pair) => pair.deltaMs < 0).length,
    ties: pairs.filter((pair) => pair.deltaMs === 0).length,
    losses: pairs.filter((pair) => pair.deltaMs > 0).length,
    pairs,
  }
}

function summarizePair({ identity, rows }, mode) {
  const pairs = pairedRows(rows, mode)
  const repetitions = group(pairs, ['repetition'])
  return {
    ...identity,
    baseline: 'string',
    mode,
    rawPairs: pairs.length,
    repetitions: repetitions.length,
    trafficMatches: pairs.every(
      (pair) => JSON.stringify(pair.baseline.traffic) === JSON.stringify(pair.candidate.traffic),
    ),
    metrics: Object.fromEntries(
      Object.keys(rows[0].metrics).map((metric) => [metric, pairedMetric(repetitions, metric)]),
    ),
  }
}

function summarizeTree(samples) {
  const rows = samples.map(treeSample)
  if (rows.length === 0) return { groups: [], paired: [] }
  const comparisonGroups = group(rows, ['lines', 'phase'])
  return {
    groups: group(rows, ['lines', 'phase', 'mode']).map(summarizeGroup),
    paired: comparisonGroups.flatMap((entry) =>
      ['sab', 'string-control'].map((mode) => summarizePair(entry, mode)),
    ),
  }
}

function summarizeFanout(fanout) {
  if (!fanout) return null
  if (!Array.isArray(fanout.samples)) fail('Missing fanout samples')
  const rows = fanout.samples.map(fanoutSample)
  const keys = ['units', 'workers', 'phase', 'retainedRead']
  return {
    metadata: fanout.metadata,
    groups: group(rows, [...keys, 'mode']).map(summarizeGroup),
    paired: group(rows, keys).map((entry) => summarizePair(entry, 'shared-utf16')),
  }
}

function ms(value) {
  return value === null ? '—' : value.toFixed(3)
}

function distribution(metric) {
  return `${ms(metric.median)} / ${ms(metric.p95)}`
}

function range(value) {
  if (value.min === value.max) return String(value.min)
  return `${value.min}–${value.max}`
}

function delta(metric) {
  return `${ms(metric.medianDeltaMs)} (${metric.wins}/${metric.repetitions})`
}

function table(headers, rows) {
  return [headers, headers.map(() => '---'), ...rows]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n')
}

function treeTable(summary) {
  const rows = summary.groups.map((row) => [
    row.lines,
    row.phase,
    row.mode,
    row.count,
    distribution(row.metrics.totalMs),
    distribution(row.metrics.mainWorkMs),
    distribution(row.metrics.workerResolveMs),
    distribution(row.metrics.workerParseMs),
    distribution(row.metrics.workerQueryMs),
    range(row.traffic.sourceUnits),
    range(row.traffic.sourceChunks),
    range(row.traffic.sourceSpans),
  ])
  return table(
    [
      'Lines',
      'Phase',
      'Mode',
      'Samples',
      'Total ms',
      'Main ms',
      'Resolve ms',
      'Parse ms',
      'Query ms',
      'Source units',
      'Chunks',
      'Spans',
    ],
    rows,
  )
}

function pairedTable(rows, fanout = false) {
  const headers = fanout ? ['Units', 'Workers', 'Phase/read'] : ['Lines', 'Phase']
  const body = rows.map((row) => [
    ...(fanout
      ? [row.units, row.workers, `${row.phase}/${row.retainedRead}`]
      : [row.lines, row.phase]),
    row.mode,
    row.repetitions,
    delta(row.metrics.totalMs),
    delta(row.metrics.mainWorkMs),
    delta(row.metrics[fanout ? 'slowestWorkerScanMs' : 'workerResolveMs']),
  ])
  return table(
    [
      ...headers,
      'Versus string',
      'Repetitions',
      'Δ total ms (wins)',
      'Δ main ms (wins)',
      fanout ? 'Δ slowest scan ms (wins)' : 'Δ resolve ms (wins)',
    ],
    body,
  )
}

function fanoutTable(summary) {
  const rows = summary.groups.map((row) => [
    row.units,
    row.workers,
    `${row.phase}/${row.retainedRead}`,
    row.mode,
    row.count,
    distribution(row.metrics.totalMs),
    distribution(row.metrics.mainWorkMs),
    row.workerScanMs.map((worker) => `${worker.worker}: ${distribution(worker)}`).join('; '),
  ])
  return table(
    ['Units', 'Workers', 'Phase/read', 'Mode', 'Samples', 'Total ms', 'Main ms', 'Worker scan ms'],
    rows,
  )
}

function markdown(summary) {
  const sections = [
    `Source: ${summary.input}`,
    'Times are median / p95 in milliseconds. p95 uses nearest rank. Missing phases remain absent, never zero.',
    'Syntax main work is descriptor construction plus synchronous postMessage. Fanout totals include preparation; main work includes preparation plus synchronous posting.',
    treeTable(summary.syntax),
    'Paired deltas are candidate minus string. Negative is faster. Wins count repetitions with a negative delta. Edit observations are matched by edit index and reduced to one median per mode per repetition before pairing. Counts describe observed runs, not statistical significance.',
    pairedTable(summary.syntax.paired),
  ]
  if (summary.fanout)
    sections.push(
      'Fanout uses direct UTF-16 scanning, not integrated editor consumers. Each retained read is separate.',
      fanoutTable(summary.fanout),
      pairedTable(summary.fanout.paired, true),
    )
  return sections.join('\n\n') + '\n'
}

async function save(path, contents) {
  if (!path) return
  const target = resolve(path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

if (positionals.length !== 1 || !['markdown', 'json'].includes(values.format)) {
  fail(
    'Usage: bun transport-summary.mjs INPUT.json [--format=markdown|json] [--json-output=PATH] [--markdown-output=PATH]',
  )
}
const input = resolve(positionals[0])
const raw = JSON.parse(await readFile(input, 'utf8'))
if (!raw.result || !Array.isArray(raw.result.samples)) fail('Missing benchmark result.samples')
const summary = {
  schemaVersion: 1,
  input,
  browserVersion: raw.browserVersion,
  capability: raw.capability,
  options: raw.options,
  manifest: raw.manifest,
  policy: {
    p95: 'nearest-rank',
    median: 'middle value, averaging the two middle values for even sample counts',
    pairedUnit: 'repetition; matched edit indices reduced to a within-mode median first',
    delta: 'candidate minus string; negative means faster',
    significance: 'not estimated',
    traffic: 'logical source units and messages, not measured physical copies or heap size',
  },
  syntax: summarizeTree(raw.result.samples),
  fanout: summarizeFanout(raw.result.fanout),
}
const json = JSON.stringify(summary, null, 2) + '\n'
const report = markdown(summary)
await save(values['json-output'], json)
await save(values['markdown-output'], report)
process.stdout.write(values.format === 'json' ? json : report)
