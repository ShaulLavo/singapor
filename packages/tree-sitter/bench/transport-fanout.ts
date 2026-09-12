type Digest = {
  readonly units: number
  readonly lineBreaks: number
  readonly asciiWords: number
  readonly checksum: number
}

type Mode = 'string' | 'shared-utf16'
type Request = { readonly source?: string | SharedArrayBuffer }
type Reply = { readonly id: number; readonly digest: Digest; readonly scanMs: number }
type Pending = {
  readonly resolve: (reply: Reply) => void
  readonly reject: (error: DOMException) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

export type FanoutOptions = {
  readonly repetitions: number
  readonly sizes: readonly number[]
  readonly workers: readonly number[]
}

type Sample = {
  readonly mode: Mode
  readonly phase: 'attach-and-scan' | 'retained-scan'
  readonly repetition: number
  readonly order: number
  readonly retainedRead: number
  readonly units: number
  readonly workers: number
  readonly prepareMs: number
  readonly syncPostMs: number
  readonly allReadersMs: number
  readonly totalMs: number
  readonly mainWorkMs: number
  readonly workerScanMs: readonly number[]
  readonly digest: Digest
  readonly counters: {
    readonly encodedCodeUnits: number
    readonly sabAllocatedBytes: number
    readonly stringPayloadCodeUnits: number
    readonly sharedReferenceMessages: number
    readonly stringCloneMessagesAvoided: number
  }
}

const CORPUS = 'const ascii_word42 = "名前 café 🎉";\n\uD800x\uDC00 \uFEFF \uFFFD \0 end\n'
const RETAINED_READS = 2

function scan(source: string | Uint16Array): Digest {
  let lineBreaks = 0
  let asciiWords = 0
  let checksum = 2166136261
  let inWord = false
  for (let index = 0; index < source.length; index++) {
    const unit = typeof source === 'string' ? source.charCodeAt(index) : (source[index] ?? 0)
    const word =
      (unit >= 65 && unit <= 90) ||
      (unit >= 97 && unit <= 122) ||
      (unit >= 48 && unit <= 57) ||
      unit === 95
    if (unit === 10) lineBreaks += 1
    if (word && !inWord) asciiWords += 1
    inWord = word
    checksum = Math.imul(checksum ^ unit, 16777619) >>> 0
  }
  return { units: source.length, lineBreaks, asciiWords, checksum }
}

function corpus(units: number): string {
  let text = CORPUS.repeat(Math.ceil(units / CORPUS.length)).slice(0, units)
  for (const boundary of [4096, 16384]) {
    if (boundary + 4 > units) continue
    text = `${text.slice(0, boundary - 1)}🎉\uFEFF\uFFFD\0${text.slice(boundary + 4)}`
  }
  return text
}

function sharedText(text: string): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(text.length * Uint16Array.BYTES_PER_ELEMENT)
  const units = new Uint16Array(buffer)
  for (let index = 0; index < text.length; index++) units[index] = text.charCodeAt(index)
  return buffer
}

function workerUrl(): string {
  return URL.createObjectURL(
    new Blob(
      [
        `
    const scan = ${scan.toString()};
    let source = '';
    self.onmessage = ({ data }) => {
      if (data.source !== undefined) {
        source = typeof data.source === 'string' ? data.source : new Uint16Array(data.source);
      }
      const started = performance.now();
      const digest = scan(source);
      self.postMessage({ id: data.id, digest, scanMs: performance.now() - started });
    };
  `,
      ],
      { type: 'text/javascript' },
    ),
  )
}

class Reader {
  private readonly pending = new Map<number, Pending>()
  private nextId = 0
  private readonly worker: Worker

  constructor(url: string) {
    this.worker = new Worker(url)
    this.worker.onmessage = (event: MessageEvent<Reply>) => {
      const pending = this.pending.get(event.data.id)
      if (!pending) return
      this.pending.delete(event.data.id)
      clearTimeout(pending.timeout)
      pending.resolve(event.data)
    }
    this.worker.onerror = (event) => {
      event.preventDefault()
      this.fail(event.message || 'Fanout worker failed')
    }
    this.worker.onmessageerror = () => this.fail('Fanout worker response could not be decoded')
  }

  request(request: Request): { readonly result: Promise<Reply>; readonly postMs: number } {
    const id = this.nextId++
    const result = new Promise<Reply>((resolve, reject) => {
      const timeout = setTimeout(() => this.fail('Fanout worker timed out'), 60_000)
      this.pending.set(id, { resolve, reject, timeout })
    })
    const message = { ...request, id }
    const started = performance.now()
    try {
      this.worker.postMessage(message)
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Fanout source could not be posted')
    }
    return { result, postMs: performance.now() - started }
  }

  dispose(): void {
    this.worker.terminate()
    this.fail('Fanout reader disposed')
  }

  private fail(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new DOMException(message, 'OperationError'))
    }
    this.pending.clear()
  }
}

function checkDigest(actual: Digest, expected: Digest): void {
  if (
    actual.units === expected.units &&
    actual.lineBreaks === expected.lineBreaks &&
    actual.asciiWords === expected.asciiWords &&
    actual.checksum === expected.checksum
  )
    return
  throw new DOMException('Fanout source digest differs from the parent source', 'DataError')
}

async function send(readers: readonly Reader[], request: Request, expected: Digest) {
  const started = performance.now()
  const requests = readers.map((reader) => reader.request(request))
  const replies = await Promise.all(requests.map((request) => request.result))
  const completedAt = performance.now()
  const allReadersMs = completedAt - started
  for (const reply of replies) checkDigest(reply.digest, expected)
  return {
    syncPostMs: requests.reduce((sum, request) => sum + request.postMs, 0),
    allReadersMs,
    completedAt,
    workerScanMs: replies.map((reply) => reply.scanMs),
  }
}

async function warm(readers: readonly Reader[]): Promise<void> {
  const text = corpus(64 * 1024)
  const expected = scan(text)
  const shared = sharedText(text)
  for (let iteration = 0; iteration < 4; iteration++) {
    await send(readers, { source: text }, expected)
    await send(readers, { source: shared }, expected)
  }
}

async function runPublication(
  readers: readonly Reader[],
  text: string,
  expected: Digest,
  mode: Mode,
  repetition: number,
  order: number,
): Promise<Sample[]> {
  await send(readers, { source: '' }, scan(''))
  const started = performance.now()
  const source = mode === 'string' ? text : sharedText(text)
  const prepareMs = performance.now() - started
  const counters = {
    encodedCodeUnits: mode === 'string' ? 0 : text.length,
    sabAllocatedBytes: mode === 'string' ? 0 : text.length * 2,
    stringPayloadCodeUnits: mode === 'string' ? text.length * readers.length : 0,
    sharedReferenceMessages: mode === 'string' ? 0 : readers.length,
    stringCloneMessagesAvoided: mode === 'string' ? 0 : readers.length,
  }
  const base = {
    mode,
    repetition,
    order,
    units: text.length,
    workers: readers.length,
    digest: expected,
  }
  const samples: Sample[] = [
    await samplePublication(
      readers,
      { source },
      expected,
      {
        ...base,
        phase: 'attach-and-scan',
        retainedRead: 0,
        prepareMs,
        counters,
      },
      started,
    ),
  ]
  for (let retainedRead = 1; retainedRead <= RETAINED_READS; retainedRead++) {
    const retainedStarted = performance.now()
    samples.push(
      await samplePublication(
        readers,
        {},
        expected,
        {
          ...base,
          phase: 'retained-scan',
          retainedRead,
          prepareMs: 0,
          counters: {
            encodedCodeUnits: 0,
            sabAllocatedBytes: 0,
            stringPayloadCodeUnits: 0,
            sharedReferenceMessages: 0,
            stringCloneMessagesAvoided: 0,
          },
        },
        retainedStarted,
      ),
    )
  }
  return samples
}

async function samplePublication(
  readers: readonly Reader[],
  request: Request,
  expected: Digest,
  base: Omit<Sample, 'syncPostMs' | 'allReadersMs' | 'workerScanMs' | 'totalMs' | 'mainWorkMs'>,
  started: number,
): Promise<Sample> {
  const { completedAt, ...timing } = await send(readers, request, expected)
  return {
    ...base,
    ...timing,
    totalMs: completedAt - started,
    mainWorkMs: base.prepareMs + timing.syncPostMs,
  }
}

async function runSize(readers: readonly Reader[], units: number, repetitions: number) {
  const text = corpus(units)
  const expected = scan(text)
  const samples: Sample[] = []
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const modes: readonly Mode[] =
      repetition % 2 === 0 ? ['string', 'shared-utf16'] : ['shared-utf16', 'string']
    for (const [order, mode] of modes.entries()) {
      samples.push(...(await runPublication(readers, text, expected, mode, repetition, order)))
    }
  }
  return samples
}

async function runPool(url: string, workers: number, options: FanoutOptions) {
  const readers: Reader[] = []
  try {
    for (let index = 0; index < workers; index++) readers.push(new Reader(url))
    await warm(readers)
    const samples: Sample[] = []
    for (const units of options.sizes)
      samples.push(...(await runSize(readers, units, options.repetitions)))
    return samples
  } finally {
    for (const reader of readers) reader.dispose()
  }
}

export async function runFanout(options: FanoutOptions) {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    throw new DOMException(
      'Fanout benchmark requires cross-origin isolation and SAB support',
      'NotSupportedError',
    )
  }
  const numbers = [options.repetitions, ...options.sizes, ...options.workers]
  if (
    options.sizes.length === 0 ||
    options.workers.length === 0 ||
    !numbers.every((value) => Number.isSafeInteger(value) && value > 0)
  ) {
    throw new DOMException(
      'Fanout sizes, worker counts, and repetitions must be positive integers',
      'DataError',
    )
  }
  const url = workerUrl()
  try {
    const samples: Sample[] = []
    for (const workers of options.workers) samples.push(...(await runPool(url, workers, options)))
    return {
      metadata: {
        prototype: 'Direct UTF-16 shared-source readers; not integrated minimap or LSP features',
        sizeUnit: 'UTF-16 code units',
        repetitions: options.repetitions,
        sizes: options.sizes,
        workers: options.workers,
        retainedReads: RETAINED_READS,
        workload: 'LF count, ASCII word count, FNV-1a-style checksum over UTF-16 code units',
        unicode: 'CJK, Latin-1, surrogate pairs at 4096/16384, lone surrogates, FEFF, FFFD, NUL',
        preparation:
          'Corpus generation excluded equally; SAB allocation and UTF-16 encoding included',
        publication:
          'One immutable publication per mode shared across all readers; no subsequent writes',
        counters:
          'Logical payload/encoding counts; clone messages avoided are not measured physical copies or total memory',
        timing:
          'Warm workers; alternating paired mode order; retained scans send no source content',
        userAgent: navigator.userAgent,
      },
      samples,
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}
