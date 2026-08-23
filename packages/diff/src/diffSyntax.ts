import { createDocumentTextSnapshot, createPieceTableSnapshot } from '@singapor/core/document'
import type { EditorHighlighterProvider } from '@singapor/core/extensions'
import {
  createEmptySyntaxResult,
  createSyntaxLanguageConfiguration,
  createSyntaxSnapshotTag,
  type EditorSyntaxProvider,
  type EditorSyntaxResult,
  type EditorSyntaxServiceRequest,
  type EditorSyntaxSessionOptions,
  type EditorToken,
} from '@singapor/core/syntax'
import {
  EditorSecondaryViewScheduler,
  type EditorSecondaryWorkContext,
} from '@singapor/core/secondary-views'
import { languageIdForPath } from './lines'
import type { DiffFile, DiffRenderRow, DiffSyntaxBackend } from './types'

type DiffSyntaxSide = 'old' | 'new' | 'stacked'
type DiffSyntaxSourceSide = 'old' | 'new'

const DEFAULT_THEME = 'github-dark'
let shikiModulePromise: Promise<typeof import('@singapor/core/shiki')> | null = null
let nextSyntaxControllerId = 0

export type DiffSyntaxTokenSource = {
  readonly lineStarts: readonly number[]
  readonly side: DiffSyntaxSourceSide
  readonly tokens: readonly EditorToken[]
}

export type ProjectDiffSyntaxTokensOptions = {
  readonly rows: readonly DiffRenderRow[]
  readonly side: DiffSyntaxSide
  readonly sources: readonly DiffSyntaxTokenSource[]
}

export type DiffSyntaxControllerOptions = {
  readonly side: DiffSyntaxSide
  readonly backend?: DiffSyntaxBackend
  readonly enabled?: boolean
  /** Fires when a *newly parsed* token stream lands; row-driven re-projection is synchronous. */
  readonly onDidChangeTokens: () => void
}

/**
 * The syntax half of the old `DiffView`, with one behavioural change.
 *
 * `DiffView` re-ran the whole pipeline — new sessions, new parse — on every row change, including
 * every expansion toggle (`updatePaneRows` → `refreshSyntaxHighlighting`, DiffView.ts:564). The
 * parse result does not depend on which regions are expanded: the sources are the two *full files*,
 * and expansion only changes which of their lines the projection shows. So the per-side token
 * streams are cached against the file and re-projected synchronously when rows change, which is
 * what lets a toggle repaint without an uncoloured frame (§C10).
 */
export class DiffSyntaxController {
  private readonly scheduler = new EditorSecondaryViewScheduler()
  private readonly key = `diff.syntax.${nextSyntaxControllerId++}`
  private sessions: { dispose(): void }[] = []
  private sources: readonly IndexedTokenSource[] = []
  private sourcesFile: DiffFile | null = null
  private file: DiffFile | null = null
  private rows: readonly DiffRenderRow[] = []
  private tokens: readonly EditorToken[] = []
  private disposed = false

  constructor(private readonly options: DiffSyntaxControllerOptions) {}

  /** A disposed controller is terminal — its scheduler never runs another task. */
  isDisposed(): boolean {
    return this.disposed
  }

  getTokens(): readonly EditorToken[] {
    return this.tokens
  }

  /** New file: drop the cached streams and reparse. */
  setFile(file: DiffFile | null, rows: readonly DiffRenderRow[]): void {
    this.file = file
    this.rows = rows
    this.sources = []
    this.sourcesFile = null
    this.tokens = []
    this.disposeSessions()
    this.scheduler.cancel(this.key)
    if (file) this.load(file)
  }

  /** Same file, different rows — an expansion toggle. Re-project what is already parsed. */
  setRows(rows: readonly DiffRenderRow[]): void {
    this.rows = rows
    this.reproject()
  }

  dispose(): void {
    this.disposed = true
    this.scheduler.cancel(this.key)
    this.scheduler.dispose()
    this.disposeSessions()
    this.sources = []
    this.tokens = []
  }

  private reproject(): void {
    if (this.sources.length === 0 || this.sourcesFile !== this.file) {
      this.tokens = []
      return
    }

    this.tokens = projectIndexedTokens(this.rows, this.options.side, this.sources)
  }

  private load(file: DiffFile): void {
    if (this.options.enabled === false) return

    const sessions: { dispose(): void }[] = []
    this.scheduler.schedule({
      key: this.key,
      taskClass: 'background-derived',
      priority: 'low',
      tags: { configuration: 'syntax', viewport: this.options.side },
      run: (context) => this.loadSources(file, context, sessions),
      apply: (sources) => this.applySources(file, sources, sessions),
      fail: () => disposeMutableSessions(sessions),
      cancel: () => disposeMutableSessions(sessions),
    })
  }

  private async loadSources(
    file: DiffFile,
    context: EditorSecondaryWorkContext,
    sessions: { dispose(): void }[],
  ): Promise<readonly DiffSyntaxTokenSource[] | null> {
    const service = await diffSyntaxService(diffSyntaxBackend(this.options.backend), file)
    if (!service) return null

    // Registered before the staleness check, and disposed here if the check fails. Creating a
    // shiki service spins up a worker owner, and this `await` is a window the task can be
    // cancelled in — `setFile` cancels on every call, so clicking through a file tree would
    // otherwise strand one owner per click with nothing left holding a reference to it. The
    // tree-sitter path hides this in tests because its service has no `dispose` at all.
    if (service.dispose) sessions.push({ dispose: () => service.dispose?.() })
    if (!context.isCurrent()) {
      disposeMutableSessions(sessions)
      return null
    }

    const sources: DiffSyntaxTokenSource[] = []
    for (const document of syntaxDocumentsForFile(file, this.options.side)) {
      if (!context.isCurrent()) return null

      const session = await service.createSession(document)
      if (!session) continue

      sessions.push(session)
      const result = await session.refresh()
      if (!context.isCurrent()) {
        disposeMutableSessions(sessions)
        return null
      }

      sources.push({
        lineStarts: document.lineStarts,
        side: document.side,
        tokens: result.tokens,
      })
    }

    return sources
  }

  private applySources(
    file: DiffFile,
    sources: readonly DiffSyntaxTokenSource[] | null,
    sessions: { dispose(): void }[],
  ): void {
    if (!sources || this.file !== file) {
      disposeMutableSessions(sessions)
      return
    }

    this.disposeSessions()
    this.sessions = sessions
    // Indexed here, once per parse. The index depends only on the token streams, and expansion
    // does not change those — so rebuilding it inside every re-projection would be repeated work
    // plus a fresh Map and N arrays of garbage on each toggle.
    this.sources = indexTokenSources(sources)
    this.sourcesFile = file
    this.reproject()
    this.options.onDidChangeTokens()
  }

  private disposeSessions(): void {
    disposeMutableSessions(this.sessions)
    this.sessions = []
  }
}

export function diffSyntaxBackend(backend: DiffSyntaxBackend | undefined): DiffSyntaxBackend {
  return backend ?? { kind: 'tree-sitter' }
}

export function projectDiffSyntaxTokens({
  rows,
  side,
  sources,
}: ProjectDiffSyntaxTokensOptions): readonly EditorToken[] {
  return projectIndexedTokens(rows, side, indexTokenSources(sources))
}

function projectIndexedTokens(
  rows: readonly DiffRenderRow[],
  side: DiffSyntaxSide,
  sources: readonly IndexedTokenSource[],
): readonly EditorToken[] {
  const projectedTokens: EditorToken[] = []
  let rowOffset = 0

  for (const row of rows) {
    const source = tokenSourceForRow(sources, row, side)
    if (source) {
      appendRowSyntaxTokens(projectedTokens, {
        lineStarts: source.lineStarts,
        row,
        rowOffset,
        side: source.side,
        tokensByLine: source.tokensByLine,
      })
    }
    rowOffset += row.text.length + 1
  }

  return projectedTokens
}

type DiffSyntaxSource = {
  readonly lineStarts: readonly number[]
  readonly side: DiffSyntaxSourceSide
  readonly text: string
}

type DiffSyntaxDocument = DiffSyntaxSource & {
  readonly documentId: string
  readonly languageId: string | null
  readonly request: EditorSyntaxServiceRequest
}

type DiffSyntaxService = {
  createSession(document: DiffSyntaxDocument): Promise<DiffSyntaxServiceSession | null>
  dispose?(): void
}

type DiffSyntaxServiceSession = {
  refresh(): Promise<EditorSyntaxResult>
  dispose(): void
}

async function diffSyntaxService(
  backend: DiffSyntaxBackend,
  file: DiffFile,
): Promise<DiffSyntaxService | null> {
  if (backend.kind === 'tree-sitter') return treeSitterDiffSyntaxService(backend.provider ?? null)
  if (backend.kind === 'highlighter') return highlighterDiffSyntaxService(backend.provider ?? null)
  return shikiDiffSyntaxService(file, backend)
}

function highlighterDiffSyntaxService(
  provider: EditorHighlighterProvider | null,
): DiffSyntaxService | null {
  if (!provider) return null

  return {
    createSession: async (document) => highlighterDiffSyntaxSession(provider, document),
  }
}

function highlighterDiffSyntaxSession(
  provider: EditorHighlighterProvider,
  document: DiffSyntaxDocument,
): DiffSyntaxServiceSession | null {
  const session = provider.createSession(highlighterSessionOptions(document))
  if (!session) return null

  return tokenHighlighterDiffSyntaxSession(document, session)
}

function treeSitterDiffSyntaxService(
  provider: EditorSyntaxProvider | null,
): DiffSyntaxService | null {
  if (!provider) return null

  return {
    createSession: async (document) => treeSitterDiffSyntaxSession(provider, document),
  }
}

function treeSitterDiffSyntaxSession(
  provider: EditorSyntaxProvider,
  document: DiffSyntaxDocument,
): DiffSyntaxServiceSession | null {
  const session = provider.createSession(syntaxSessionOptions(document))
  if (!session) return null

  return {
    dispose: () => session.dispose(),
    refresh: () => session.refresh(document.request.snapshot, document.text),
  }
}

async function shikiDiffSyntaxService(
  file: DiffFile,
  backend: Extract<DiffSyntaxBackend, { readonly kind: 'shiki' }>,
): Promise<DiffSyntaxService | null> {
  const shiki = await loadShikiModule()
  if (!shiki.canUseShikiWorker()) return null

  const lang = shikiLanguageForFile(file)
  if (!lang) return null

  const themeName = shikiThemeName(backend.shikiTheme)
  const owner = shiki.createShikiWorkerOwner()

  return {
    dispose: () => {
      void owner.dispose().catch(() => undefined)
    },
    createSession: async (document) => {
      const session = owner.createSession({
        ...highlighterSessionOptions(document),
        lang,
        langs: [lang],
        theme: themeName,
        themes: [themeName],
      })
      if (!session) return null

      return tokenHighlighterDiffSyntaxSession(document, session)
    },
  }
}

function loadShikiModule(): Promise<typeof import('@singapor/core/shiki')> {
  // A rejected promise must not be what the cache holds. One failed chunk load would otherwise be
  // replayed to every later `setFile` for the lifetime of the page, so a transient network blip
  // would turn shiki highlighting off permanently rather than for one file.
  shikiModulePromise ??= import('@singapor/core/shiki').catch((error: unknown) => {
    shikiModulePromise = null
    throw error
  })
  return shikiModulePromise
}

function tokenHighlighterDiffSyntaxSession(
  document: DiffSyntaxDocument,
  session: {
    refresh(
      snapshot: EditorSyntaxServiceRequest['snapshot'],
      fullText?: string,
    ): Promise<{ readonly tokens: readonly EditorToken[] }>
    dispose(): void
  },
): DiffSyntaxServiceSession {
  return {
    dispose: () => session.dispose(),
    refresh: async () => {
      const result = await session.refresh(document.request.snapshot, document.text)
      return syntaxResultFromTokens(document.request, result.tokens)
    },
  }
}

function syntaxSessionOptions(document: DiffSyntaxDocument): EditorSyntaxSessionOptions {
  return {
    documentId: document.documentId,
    fullText: document.text,
    includeCaptures: document.request.language.includeCaptures,
    includeHighlights: document.request.language.includeHighlights,
    languageId: document.languageId,
    snapshot: document.request.snapshot,
    syntaxMode: document.request.language.mode === 'range' ? 'range' : 'full',
    textSnapshot: document.request.textSnapshot,
  }
}

function highlighterSessionOptions(
  document: DiffSyntaxDocument,
): Omit<EditorSyntaxSessionOptions, 'includeCaptures' | 'includeHighlights' | 'syntaxMode'> {
  return {
    documentId: document.documentId,
    fullText: document.text,
    languageId: document.languageId,
    snapshot: document.request.snapshot,
    textSnapshot: document.request.textSnapshot,
  }
}

function syntaxResultFromTokens(
  request: EditorSyntaxServiceRequest,
  tokens: readonly EditorToken[],
): EditorSyntaxResult {
  return {
    ...createEmptySyntaxResult({
      language: request.language,
      requestedRanges: request.requestedRanges,
      snapshot: request.snapshotTag,
    }),
    tokens,
  }
}

function shikiThemeName(theme: string | (() => string) | undefined): string {
  if (typeof theme === 'function') return theme()
  return theme ?? DEFAULT_THEME
}

/**
 * The two full files, parsed whole.
 *
 * This is the language the diff is highlighted in, and §C11 is the reason it lives here rather than
 * on the editor: the editor's own document is the *interleaved* buffer, and giving that a language
 * feeds a garbage parse into folds, brackets and injections.
 */
function syntaxDocumentsForFile(
  file: DiffFile,
  side: DiffSyntaxSide,
): readonly DiffSyntaxDocument[] {
  return syntaxSourcesForSide(file, side).map((source) => syntaxDocument(file, source))
}

function syntaxSourcesForSide(file: DiffFile, side: DiffSyntaxSide): readonly DiffSyntaxSource[] {
  if (side === 'stacked') {
    return [syntaxSource(file.oldLines, 'old'), syntaxSource(file.newLines, 'new')]
  }

  return [syntaxSource(side === 'old' ? file.oldLines : file.newLines, side)]
}

function syntaxSource(lines: readonly string[], side: DiffSyntaxSourceSide): DiffSyntaxSource {
  const text = lines.join('\n')
  return {
    lineStarts: lineStartsForLines(lines),
    side,
    text,
  }
}

function syntaxDocument(file: DiffFile, source: DiffSyntaxSource): DiffSyntaxDocument {
  const snapshot = createPieceTableSnapshot(source.text)
  const textSnapshot = createDocumentTextSnapshot(snapshot, source.text)
  const documentId = `${file.path}#diff-${source.side}`
  const languageId = diffSyntaxLanguageId(file)
  const request: EditorSyntaxServiceRequest = {
    editSummary: null,
    language: createSyntaxLanguageConfiguration({
      includeCaptures: true,
      includeHighlights: true,
      languageId,
      mode: 'full',
    }),
    requestedRanges: [{ startIndex: 0, endIndex: snapshot.length }],
    snapshot,
    snapshotTag: createSyntaxSnapshotTag({
      documentId,
      length: snapshot.length,
      version: 0,
    }),
    textSnapshot,
  }
  return { ...source, documentId, languageId, request }
}

function diffSyntaxLanguageId(file: DiffFile): string | null {
  return file.languageId ?? languageIdForPath(file.path)
}

type IndexedTokenSource = {
  readonly lineStarts: readonly number[]
  readonly side: DiffSyntaxSourceSide
  /** Tokens touching each source line, keyed by 1-based line number. */
  readonly tokensByLine: ReadonlyMap<number, readonly EditorToken[]>
}

/**
 * Buckets each source's tokens by the lines they touch, once per projection.
 *
 * Without this every row scans every token in its side's stream, so a projection costs
 * rows x tokens — and re-projection sits on the synchronous expansion-toggle path, where a
 * thousand-row file against ten thousand tokens is tens of millions of comparisons per click.
 *
 * Deliberately built by locating each token's own lines rather than by walking rows in order:
 * nothing here may assume the token stream is sorted, because tree-sitter and shiki are separate
 * producers, and a projection's rows do not visit source lines monotonically once expanded
 * regions interleave.
 */
function indexTokenSources(
  sources: readonly DiffSyntaxTokenSource[],
): readonly IndexedTokenSource[] {
  return sources.map((source) => ({
    lineStarts: source.lineStarts,
    side: source.side,
    tokensByLine: tokensByLine(source),
  }))
}

function tokensByLine(source: DiffSyntaxTokenSource): ReadonlyMap<number, readonly EditorToken[]> {
  const byLine = new Map<number, EditorToken[]>()
  const { lineStarts } = source

  for (const token of source.tokens) {
    if (token.end <= token.start) continue

    // A token can begin mid-line and run past the terminator, so it lands in every line it
    // overlaps; bucketing by its start alone would drop it from all but the first.
    for (
      let line = lineIndexAtOffset(lineStarts, token.start);
      line < lineStarts.length;
      line += 1
    ) {
      if (lineStarts[line]! >= token.end) break

      const bucket = byLine.get(line + 1)
      if (bucket) bucket.push(token)
      else byLine.set(line + 1, [token])
    }
  }

  return byLine
}

/** The 0-based index of the line containing `offset`: the last line starting at or before it. */
function lineIndexAtOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (lineStarts[middle]! <= offset) low = middle
    else high = middle - 1
  }
  return Math.max(0, low)
}

function tokenSourceForRow(
  sources: readonly IndexedTokenSource[],
  row: DiffRenderRow,
  side: DiffSyntaxSide,
): IndexedTokenSource | null {
  const sourceSide = sourceSideForRow(row, side)
  return sources.find((source) => source.side === sourceSide) ?? null
}

function appendRowSyntaxTokens(
  projectedTokens: EditorToken[],
  {
    lineStarts,
    row,
    rowOffset,
    side,
    tokensByLine: rowTokensByLine,
  }: {
    readonly lineStarts: readonly number[]
    readonly row: DiffRenderRow
    readonly rowOffset: number
    readonly side: DiffSyntaxSourceSide
    readonly tokensByLine: ReadonlyMap<number, readonly EditorToken[]>
  },
): void {
  const lineNumber = sourceLineNumberForRow(row, side)
  if (lineNumber === undefined) return

  const lineStart = lineStarts[lineNumber - 1]
  const nextLineStart = lineStarts[lineNumber]
  if (lineStart === undefined) return

  const lineEnd = Math.min(
    nextLineStart === undefined ? Number.POSITIVE_INFINITY : nextLineStart - 1,
    lineStart + row.text.length,
  )

  for (const token of rowTokensByLine.get(lineNumber) ?? []) {
    appendProjectedToken(projectedTokens, token, lineStart, lineEnd, rowOffset)
  }
}

function appendProjectedToken(
  projectedTokens: EditorToken[],
  token: EditorToken,
  lineStart: number,
  lineEnd: number,
  rowOffset: number,
): void {
  if (token.end <= lineStart) return
  if (token.start >= lineEnd) return

  const start = Math.max(token.start, lineStart)
  const end = Math.min(token.end, lineEnd)
  if (end <= start) return

  projectedTokens.push({
    end: rowOffset + end - lineStart,
    start: rowOffset + start - lineStart,
    style: token.style,
  })
}

function sourceLineNumberForRow(
  row: DiffRenderRow,
  side: DiffSyntaxSourceSide,
): number | undefined {
  if (side === 'old') return row.oldLineNumber
  return row.newLineNumber
}

function sourceSideForRow(row: DiffRenderRow, side: DiffSyntaxSide): DiffSyntaxSourceSide {
  if (side === 'old' || side === 'new') return side
  if (row.type === 'deletion') return 'old'

  return 'new'
}

function shikiLanguageForFile(file: DiffFile): string | null {
  const languageId = file.languageId ?? languageIdForPath(file.path)
  if (languageId === 'typescript' && pathExtension(file.path) === '.tsx') return 'tsx'
  if (languageId === 'javascript' && pathExtension(file.path) === '.jsx') return 'jsx'
  return languageId
}

function pathExtension(path: string): string {
  const fileName = path.slice(path.lastIndexOf('/') + 1)
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex === -1) return ''
  return fileName.slice(dotIndex).toLowerCase()
}

function lineStartsForLines(lines: readonly string[]): readonly number[] {
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  return starts
}

function disposeMutableSessions(sessions: { dispose(): void }[]): void {
  while (sessions.length > 0) sessions.pop()?.dispose()
}
