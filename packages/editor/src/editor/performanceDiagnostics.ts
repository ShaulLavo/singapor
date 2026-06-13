type EditorPerformanceDiagnostic = {
  readonly name: string
  readonly durationMs?: number
  readonly detail?: Readonly<Record<string, unknown>>
}

type EditorPerformanceDiagnosticSink =
  | ((diagnostic: EditorPerformanceDiagnostic) => void)
  | {
      readonly enabled?: boolean
      readonly record?: (diagnostic: EditorPerformanceDiagnostic) => void
    }

type EditorPerformanceDiagnosticGlobal = typeof globalThis & {
  __EDITOR_PERFORMANCE_DIAGNOSTICS__?: EditorPerformanceDiagnosticSink | null
}

type DiagnosticDetail =
  | Readonly<Record<string, unknown>>
  | (() => Readonly<Record<string, unknown>> | undefined)
  | undefined

export function measureEditorPerformance<T>(
  name: string,
  run: () => T,
  detail?: DiagnosticDetail,
): T {
  if (!editorPerformanceDiagnosticsEnabled()) return run()

  const start = nowMs()
  try {
    return run()
  } finally {
    recordEditorPerformanceDiagnostic(name, detail, nowMs() - start)
  }
}

export function recordEditorPerformanceDiagnostic(
  name: string,
  detail?: DiagnosticDetail,
  durationMs?: number,
): void {
  const sink = editorPerformanceDiagnosticSink()
  if (!sink) return

  const diagnostic = createDiagnostic(name, detail, durationMs)
  if (typeof sink === 'function') {
    sink(diagnostic)
    return
  }

  sink.record?.(diagnostic)
}

export function editorPerformanceDiagnosticsEnabled(): boolean {
  const sink = editorPerformanceDiagnosticGlobal().__EDITOR_PERFORMANCE_DIAGNOSTICS__
  if (!sink) return false
  if (typeof sink === 'function') return true
  return sink.enabled === true || typeof sink.record === 'function'
}

function editorPerformanceDiagnosticSink(): EditorPerformanceDiagnosticSink | null {
  const sink = editorPerformanceDiagnosticGlobal().__EDITOR_PERFORMANCE_DIAGNOSTICS__
  if (!sink) return null
  if (typeof sink === 'function') return sink
  if (sink.enabled !== true && typeof sink.record !== 'function') return null
  return sink
}

function createDiagnostic(
  name: string,
  detail: DiagnosticDetail,
  durationMs: number | undefined,
): EditorPerformanceDiagnostic {
  const resolvedDetail = resolveDiagnosticDetail(detail)
  if (durationMs === undefined && resolvedDetail === undefined) return { name }
  if (durationMs === undefined) return { name, detail: resolvedDetail }
  if (resolvedDetail === undefined) return { name, durationMs }
  return { name, durationMs, detail: resolvedDetail }
}

function resolveDiagnosticDetail(
  detail: DiagnosticDetail,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof detail === 'function') return detail()
  return detail
}

function editorPerformanceDiagnosticGlobal(): EditorPerformanceDiagnosticGlobal {
  return globalThis as EditorPerformanceDiagnosticGlobal
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now()
}
