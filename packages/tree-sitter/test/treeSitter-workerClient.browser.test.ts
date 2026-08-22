import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import documentSessionSource from '../../editor/src/documentSession.ts?raw'
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from '../../tree-sitter-languages/src/index.ts'

import {
  applyBatchToPieceTable,
  createPieceTableSnapshot,
  type TextEdit,
} from '@singapor/core/document'
import {
  createAnchorSelection,
  createSelectionSet,
  resolveSelection,
} from '@singapor/core/internal'
import {
  expandTreeSitterSelection,
  resolveTreeSitterLanguageContribution,
  selectTreeSitterToken,
  shrinkTreeSitterSelection,
  TreeSitterWorkerClient,
  type TreeSitterLanguageId,
} from '../src'
import { createTreeSitterEditPayload } from '../src/session.ts'

describe.skipIf(typeof Worker === 'undefined')('tree-sitter worker client', () => {
  let workerClient: TreeSitterWorkerClient

  beforeEach(async () => {
    workerClient = new TreeSitterWorkerClient()
    await registerDefaultLanguages(workerClient)
  })

  afterEach(async () => {
    await workerClient.dispose()
  })

  it('parses and edits through the real browser Worker', async () => {
    const documentId = 'file.ts'
    const snapshot = createPieceTableSnapshot('const answer = 1;\n')
    const parsed = await workerClient.parse({
      documentId,
      snapshotVersion: 1,
      languageId: 'typescript',
      snapshot,
    })

    expect(parsed?.documentId).toBe(documentId)
    expect(parsed?.snapshotVersion).toBe(1)
    expect(parsed?.captures.length).toBeGreaterThan(0)

    const edits = [{ from: 6, to: 12, text: 'value' }]
    const nextSnapshot = applyBatchToPieceTable(snapshot, edits)
    const payload = createTreeSitterEditPayload({
      documentId,
      previousSnapshotVersion: 1,
      snapshotVersion: 2,
      languageId: 'typescript',
      previousSnapshot: snapshot,
      nextSnapshot,
      edits,
    })
    const edited = payload ? await workerClient.edit(payload) : undefined

    expect(edited?.documentId).toBe(documentId)
    expect(edited?.snapshotVersion).toBe(2)
    expect(edited?.captures.length).toBeGreaterThan(0)
  })

  it('highlights PascalCase TSX component tag names and reports JSX folds', async () => {
    const documentId = 'main.tsx'
    const text = [
      'const view = (',
      '  <StrictMode>',
      '    <QueryClientProvider client={queryClient}>',
      '      <App />',
      '    </QueryClientProvider>',
      '  </StrictMode>',
      ');',
    ].join('\n')
    const snapshot = createPieceTableSnapshot(text)
    const parsed = await workerClient.parse({
      documentId,
      snapshotVersion: 1,
      languageId: 'typescript',
      snapshot,
    })

    expect(parsed?.captures).toContainEqual({
      startIndex: text.indexOf('StrictMode'),
      endIndex: text.indexOf('StrictMode') + 'StrictMode'.length,
      captureName: 'constructor',
      languageId: 'typescript',
    })
    expect(parsed?.captures).toContainEqual({
      startIndex: text.indexOf('QueryClientProvider'),
      endIndex: text.indexOf('QueryClientProvider') + 'QueryClientProvider'.length,
      captureName: 'constructor',
      languageId: 'typescript',
    })
    expect(parsed?.folds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endLine: 5,
          languageId: 'typescript',
          startLine: 1,
          type: 'jsx_element',
        }),
        expect.objectContaining({
          endLine: 4,
          languageId: 'typescript',
          startLine: 2,
          type: 'jsx_element',
        }),
      ]),
    )
  })

  it('returns highlights for a lower document range after a parse-only editor parse', async () => {
    const documentId = 'large-lower-range.ts'
    const text = Array.from(
      { length: 12_000 },
      (_value, index) => `export const value${index} = ${index};`,
    ).join('\n')
    const snapshot = createPieceTableSnapshot(text)
    await workerClient.parse({
      documentId,
      snapshotVersion: 1,
      languageId: 'typescript',
      resultMode: 'parseOnly',
      snapshot,
    })

    const topTarget = text.indexOf('value10')
    const topResult = await workerClient.queryRange({
      documentId,
      snapshotVersion: 1,
      languageId: 'typescript',
      includeHighlights: true,
      includeCaptures: false,
      range: { startIndex: 0, endIndex: 1_000 },
    })
    const target = text.indexOf('value10000')
    const result = await workerClient.queryRange({
      documentId,
      snapshotVersion: 1,
      languageId: 'typescript',
      includeHighlights: true,
      includeCaptures: false,
      range: { startIndex: target - 100, endIndex: target + 1_000 },
    })

    expect(packedTokensCoverRange(topResult?.tokensPacked, topTarget, topTarget + 7)).toBe(true)
    expect(packedTokensCoverRange(result?.tokensPacked, target, target + 10)).toBe(true)
  })

  it('returns an unavailable edit result when the incremental base was evicted', async () => {
    const documentId = 'missing-incremental-base.ts'
    const snapshot = createPieceTableSnapshot('const answer = 1;\n')
    const edit = { from: 6, to: 12, text: 'value' }
    const nextSnapshot = applyBatchToPieceTable(snapshot, [edit])
    const payload = createTreeSitterEditPayload({
      documentId,
      previousSnapshotVersion: 99,
      snapshotVersion: 100,
      languageId: 'typescript',
      previousSnapshot: snapshot,
      nextSnapshot,
      edits: [edit],
      resultMode: 'parseOnly',
    })

    const result = payload ? await workerClient.edit(payload) : 'missing-payload'

    expect(result).toBeUndefined()
  })

  it('matches a full parse after same-line inserts before later rows', async () => {
    const documentId = 'same-line-insert.ts'
    const text = [
      'export function alpha() {',
      '  return 1;',
      '}',
      'export function beta() {',
      '  return alpha();',
      '}',
    ].join('\n')
    const snapshot = createPieceTableSnapshot(text)
    await workerClient.parse({
      documentId,
      snapshotVersion: 1,
      languageId: 'typescript',
      snapshot,
    })

    const editOffset = text.indexOf('return 1') + 'return'.length
    const edit = { from: editOffset, to: editOffset, text: ' value' }
    const nextSnapshot = applyBatchToPieceTable(snapshot, [edit])
    const payload = createTreeSitterEditPayload({
      documentId,
      previousSnapshotVersion: 1,
      snapshotVersion: 2,
      languageId: 'typescript',
      previousSnapshot: snapshot,
      nextSnapshot,
      edits: [edit],
    })
    const incremental = payload ? await workerClient.edit(payload) : undefined
    const full = await workerClient.parse({
      documentId: `${documentId}:full`,
      snapshotVersion: 1,
      languageId: 'typescript',
      snapshot: nextSnapshot,
    })

    expect(captureSignature(incremental?.captures ?? [])).toEqual(
      captureSignature(full?.captures ?? []),
    )
  })

  it('matches a full parse after inserting inside an identifier', async () => {
    const documentId = 'identifier-insert.ts'
    const text = [
      'export type DocumentSessionChangeKind = "edit" | "selection" | "undo" | "redo";',
      '',
      'export type EditorTimingMeasurement = {',
      '  readonly name: string;',
      '  readonly durationMs: number;',
      '};',
    ].join('\n')
    const snapshot = createPieceTableSnapshot(text)
    await workerClient.parse({
      documentId,
      snapshotVersion: 1,
      languageId: 'typescript',
      snapshot,
    })

    const editOffset = text.indexOf('Document') + 'Docume'.length
    const edit = { from: editOffset, to: editOffset, text: 'f' }
    const nextSnapshot = applyBatchToPieceTable(snapshot, [edit])
    const payload = createTreeSitterEditPayload({
      documentId,
      previousSnapshotVersion: 1,
      snapshotVersion: 2,
      languageId: 'typescript',
      previousSnapshot: snapshot,
      nextSnapshot,
      edits: [edit],
    })
    const incremental = payload ? await workerClient.edit(payload) : undefined
    const full = await workerClient.parse({
      documentId: `${documentId}:full`,
      snapshotVersion: 1,
      languageId: 'typescript',
      snapshot: nextSnapshot,
    })

    expect(captureSignature(incremental?.captures ?? [])).toEqual(
      captureSignature(full?.captures ?? []),
    )
  })

  it('matches a full parse after inserting inside the real document session source', async () => {
    const documentId = 'document-session-source.ts'
    const snapshot = createPieceTableSnapshot(documentSessionSource)
    await workerClient.parse({
      documentId,
      snapshotVersion: 1,
      languageId: 'typescript',
      snapshot,
    })

    const kindOffset = documentSessionSource.indexOf('readonly kind')
    expect(kindOffset).toBeGreaterThanOrEqual(0)

    const editOffset = kindOffset + 'readonly ki'.length
    const edit = { from: editOffset, to: editOffset, text: 'g' }
    const nextSnapshot = applyBatchToPieceTable(snapshot, [edit])
    const payload = createTreeSitterEditPayload({
      documentId,
      previousSnapshotVersion: 1,
      snapshotVersion: 2,
      languageId: 'typescript',
      previousSnapshot: snapshot,
      nextSnapshot,
      edits: [edit],
    })
    const incremental = payload ? await workerClient.edit(payload) : undefined
    const full = await workerClient.parse({
      documentId: `${documentId}:full`,
      snapshotVersion: 1,
      languageId: 'typescript',
      snapshot: nextSnapshot,
    })

    expect(captureSignature(incremental?.captures ?? [])).toEqual(
      captureSignature(full?.captures ?? []),
    )
  })

  it('highlights injected script and style content', async () => {
    const documentId = 'index.html'
    const text = '<style>.x { color: red; }</style><script>const a = 1;</script>'
    const snapshot = createPieceTableSnapshot(text)
    const parsed = await workerClient.parse({
      documentId,
      snapshotVersion: 1,
      languageId: 'html',
      snapshot,
    })

    expect(parsed?.injections.map((injection) => injection.languageId).sort()).toEqual([
      'css',
      'javascript',
    ])
    expect(parsed?.captures.some((capture) => capture.languageId === 'css')).toBe(true)
    expect(parsed?.captures.some((capture) => capture.languageId === 'javascript')).toBe(true)
  })

  it('can skip highlight captures while retaining structural results', async () => {
    const documentId = 'index.html'
    const text = [
      '<style>',
      '.x {',
      '  color: red;',
      '}',
      '</style>',
      '<script>',
      'const a = 1;',
      '</script>',
    ].join('\n')
    const snapshot = createPieceTableSnapshot(text)
    const parsed = await workerClient.parse({
      documentId,
      snapshotVersion: 1,
      languageId: 'html',
      includeHighlights: false,
      includeCaptures: false,
      snapshot,
    })

    expect(parsed?.captures).toEqual([])
    expect(parsed?.folds.length).toBeGreaterThan(0)
    expect(parsed?.injections.map((injection) => injection.languageId).sort()).toEqual([
      'css',
      'javascript',
    ])
  })

  it('parses a consumer-registered language id', async () => {
    const javascript = await resolveTreeSitterLanguageContribution(
      TREE_SITTER_LANGUAGE_CONTRIBUTIONS.find((contribution) => {
        return contribution.id === 'javascript'
      })!,
    )
    await workerClient.registerLanguages([
      {
        ...javascript,
        id: 'consumer-javascript',
        extensions: ['.consumer-js'],
        aliases: ['consumer-javascript'],
      },
    ])

    const text = 'const answer = 1;\n'
    const snapshot = createPieceTableSnapshot(text)
    const parsed = await workerClient.parse({
      documentId: 'file.consumer-js',
      snapshotVersion: 1,
      languageId: 'consumer-javascript',
      snapshot,
    })

    expect(parsed?.languageId).toBe('consumer-javascript')
    expect(parsed?.captures.length).toBeGreaterThan(0)
    expect(parsed?.captures.some((capture) => capture.languageId === 'consumer-javascript')).toBe(
      true,
    )
  })

  it('highlights injected tagged template content', async () => {
    const documentId = 'template.ts'
    const text = [
      'const view = html`<style>.x { color: red; }</style><main>${name}</main>`;',
      'const data = json`{"ok": true}`;',
    ].join('\n')
    const snapshot = createPieceTableSnapshot(text)
    const parsed = await workerClient.parse({
      documentId,
      snapshotVersion: 1,
      languageId: 'typescript',
      snapshot,
    })
    const languages = Array.from(
      new Set(parsed?.injections.map((injection) => injection.languageId)),
    ).toSorted()

    expect(languages).toEqual(['css', 'html', 'json'])
    expect(parsed?.captures.some((capture) => capture.languageId === 'html')).toBe(true)
    expect(parsed?.captures.some((capture) => capture.languageId === 'css')).toBe(true)
    expect(parsed?.captures.some((capture) => capture.languageId === 'json')).toBe(true)
  })

  it('keeps injected layers active after edits outside injected content', async () => {
    const documentId = 'index.html'
    const text = '<style>.x { color: red; }</style>'
    const snapshot = createPieceTableSnapshot(text)
    await workerClient.parse({
      documentId,
      snapshotVersion: 1,
      languageId: 'html',
      snapshot,
    })

    const edits = [{ from: text.length, to: text.length, text: '\n<main>Hello</main>' }]
    const nextSnapshot = applyBatchToPieceTable(snapshot, edits)
    const payload = createTreeSitterEditPayload({
      documentId,
      previousSnapshotVersion: 1,
      snapshotVersion: 2,
      languageId: 'html',
      previousSnapshot: snapshot,
      nextSnapshot,
      edits,
    })
    const edited = payload ? await workerClient.edit(payload) : undefined

    expect(edited?.injections.map((injection) => injection.languageId)).toContain('css')
    expect(edited?.captures.some((capture) => capture.languageId === 'css')).toBe(true)
  })

  it('updates injected layers after edits inside injected content', async () => {
    const documentId = 'index.html'
    const text = '<style>.x { color: red; }</style>'
    const snapshot = createPieceTableSnapshot(text)
    await workerClient.parse({
      documentId,
      snapshotVersion: 1,
      languageId: 'html',
      snapshot,
    })

    const cssStart = text.indexOf('.x')
    const cssEnd = text.indexOf('</style>')
    const nextCss = '.x {\n  color: blue;\n}'
    const edits = [{ from: cssStart, to: cssEnd, text: nextCss }]
    const nextSnapshot = applyBatchToPieceTable(snapshot, edits)
    const payload = createTreeSitterEditPayload({
      documentId,
      previousSnapshotVersion: 1,
      snapshotVersion: 2,
      languageId: 'html',
      previousSnapshot: snapshot,
      nextSnapshot,
      edits,
    })
    const edited = payload ? await workerClient.edit(payload) : undefined
    const colorStart = cssStart + nextCss.indexOf('color')

    expect(edited?.injections.map((injection) => injection.languageId)).toContain('css')
    expect(
      edited?.captures.some((capture) => {
        if (capture.languageId !== 'css') return false
        if (capture.startIndex !== colorStart) return false
        return capture.endIndex === colorStart + 'color'.length
      }),
    ).toBe(true)
  })

  it('groups combined injections into one injected layer', async () => {
    const typescript = await resolveTreeSitterLanguageContribution(
      TREE_SITTER_LANGUAGE_CONTRIBUTIONS.find((contribution) => {
        return contribution.id === 'typescript'
      })!,
    )
    await workerClient.registerLanguages([
      {
        ...typescript,
        id: 'combined-typescript',
        extensions: ['.combined-ts'],
        aliases: ['combined-typescript'],
        injectionQuerySource: `
          (call_expression
            function: (identifier) @_name
            (#eq? @_name "css")
            arguments: (template_string
              (string_fragment) @injection.content)
            (#set! injection.language "css")
            (#set! injection.combined))
        `,
      },
    ])

    const text = 'const styles = css`.x { color: ${theme.color}; background: red; }`;'
    const snapshot = createPieceTableSnapshot(text)
    const parsed = await workerClient.parse({
      documentId: 'style.combined-ts',
      snapshotVersion: 1,
      languageId: 'combined-typescript',
      snapshot,
    })

    const cssInjections = parsed?.injections.filter((injection) => injection.languageId === 'css')
    expect(cssInjections).toHaveLength(1)
    expect(parsed?.captures.some((capture) => capture.languageId === 'css')).toBe(true)
  })

  it('matches a full parse after edits around multiple tagged-template injections', async () => {
    const text = [
      'const first = html`<section>one</section>`;',
      'const between = 1;',
      'const second = html`<aside>two</aside>`;',
    ].join('\n')
    const scenarios = [
      {
        name: 'inside',
        edit: { from: text.indexOf('one') + 1, to: text.indexOf('one') + 1, text: '!' },
      },
      {
        name: 'between',
        edit: { from: text.indexOf('between'), to: text.indexOf('between'), text: 'middle' },
      },
      { name: 'before', edit: { from: 0, to: 0, text: '// header\n' } },
    ] satisfies readonly { readonly name: string; readonly edit: TextEdit }[]

    for (const scenario of scenarios) {
      const result = await compareIncrementalInjectionsWithFullParse(workerClient, {
        documentId: `tagged-templates-${scenario.name}.ts`,
        languageId: 'typescript',
        text,
        edit: scenario.edit,
      })

      expect(result.incremental.injections.map((injection) => injection.languageId)).toEqual([
        'html',
      ])
    }
  })

  it('matches a full parse after edits around multiple markdown fences', async () => {
    const text = [
      '# Title',
      '',
      '```html',
      '<main>one</main>',
      '```',
      '',
      'Between fences.',
      '',
      '```css',
      '.two { color: red; }',
      '```',
      '',
      '```javascript',
      'const three = 3;',
      '```',
      '',
      '```html',
      '<aside>four</aside>',
      '```',
    ].join('\n')
    const scenarios = [
      {
        name: 'inside',
        edit: { from: text.indexOf('four'), to: text.indexOf('four'), text: 'number ' },
      },
      {
        name: 'between',
        edit: { from: text.indexOf('Between'), to: text.indexOf('Between'), text: 'Still ' },
      },
      { name: 'before', edit: { from: 0, to: 0, text: 'Preface\n\n' } },
    ] satisfies readonly { readonly name: string; readonly edit: TextEdit }[]

    for (const scenario of scenarios) {
      const result = await compareIncrementalInjectionsWithFullParse(workerClient, {
        documentId: `markdown-fences-${scenario.name}.md`,
        languageId: 'markdown',
        text,
        edit: scenario.edit,
      })
      const languages = new Set(
        result.incremental.injections.map((injection) => injection.languageId),
      )

      expect(languages).toEqual(
        new Set(['css', 'html', 'javascript', 'markdown_inline'] satisfies TreeSitterLanguageId[]),
      )
    }
  })

  it('creates and destroys tagged-template injections incrementally', async () => {
    const incomplete = [
      'const first = html`<main>hello</main>`;',
      'const second = html`<aside>new</aside>',
    ].join('\n')
    const created = await compareIncrementalInjectionsWithFullParse(workerClient, {
      documentId: 'create-template-injection.ts',
      languageId: 'typescript',
      text: incomplete,
      edit: { from: incomplete.length, to: incomplete.length, text: '`' },
    })

    expect(created.initial.injections.map((injection) => injection.languageId)).toEqual(['html'])
    expect(created.incremental.injections.map((injection) => injection.languageId)).toEqual([
      'html',
    ])

    const complete = [
      'const first = html`<main>hello</main>`;',
      'const second = html`<aside>old</aside>`;',
    ].join('\n')
    const secondTag = complete.lastIndexOf('html')
    const destroyed = await compareIncrementalInjectionsWithFullParse(workerClient, {
      documentId: 'destroy-template-injection.ts',
      languageId: 'typescript',
      text: complete,
      edit: { from: secondTag, to: secondTag + 'html'.length, text: '' },
    })

    expect(destroyed.initial.injections.map((injection) => injection.languageId)).toEqual(['html'])
    expect(destroyed.incremental.injections.map((injection) => injection.languageId)).toEqual([
      'html',
    ])
  })

  it('matches a full parse after an edit inside a nested markdown-html-script injection', async () => {
    const text = [
      '# Nested',
      '',
      '```html',
      '<main><script>const value = 1;</script></main>',
      '```',
    ].join('\n')
    const valueIndex = text.indexOf('1;')
    const result = await compareIncrementalInjectionsWithFullParse(workerClient, {
      documentId: 'nested-markdown-injection.md',
      languageId: 'markdown',
      text,
      edit: { from: valueIndex, to: valueIndex + 1, text: '2' },
    })
    const languages = new Set(
      result.incremental.injections.map((injection) => injection.languageId),
    )

    expect(languages).toEqual(new Set(['html', 'javascript', 'markdown_inline']))
  })

  it('expands and shrinks structural selections through the cached syntax tree', async () => {
    const documentId = 'file.ts'
    const snapshot = createPieceTableSnapshot('const answer = 1;\n')
    await workerClient.parse({
      documentId,
      snapshotVersion: 1,
      languageId: 'typescript',
      snapshot,
    })

    const selections = createSelectionSet([createAnchorSelection(snapshot, 7)])
    const token = await selectTreeSitterToken({
      backend: workerClient,
      documentId,
      languageId: 'typescript',
      snapshotVersion: 1,
      snapshot,
      selections,
    })
    const expanded = await expandTreeSitterSelection({
      backend: workerClient,
      documentId,
      languageId: 'typescript',
      snapshotVersion: 1,
      snapshot,
      selections: token.selections,
      state: token.state,
    })
    const shrunk = shrinkTreeSitterSelection({
      backend: workerClient,
      documentId,
      languageId: 'typescript',
      snapshotVersion: 1,
      snapshot,
      selections: expanded.selections,
      state: expanded.state,
    })

    const tokenRange = resolveSelection(snapshot, token.selections.selections[0]!)
    const expandedRange = resolveSelection(snapshot, expanded.selections.selections[0]!)
    const shrunkRange = resolveSelection(snapshot, shrunk.selections.selections[0]!)
    expect(tokenRange).toMatchObject({ startOffset: 6, endOffset: 12 })
    expect(expandedRange.endOffset - expandedRange.startOffset).toBeGreaterThan(6)
    expect(shrunkRange).toMatchObject({ startOffset: 6, endOffset: 12 })
  })

  it('selects tokens inside injected content through the injected layer', async () => {
    const documentId = 'index.html'
    const text = '<style>.x { color: red; }</style>'
    const snapshot = createPieceTableSnapshot(text)
    await workerClient.parse({
      documentId,
      snapshotVersion: 1,
      languageId: 'html',
      snapshot,
    })

    const offset = text.indexOf('color')
    const selections = createSelectionSet([createAnchorSelection(snapshot, offset)])
    const token = await selectTreeSitterToken({
      backend: workerClient,
      documentId,
      languageId: 'html',
      snapshotVersion: 1,
      snapshot,
      selections,
    })

    const tokenRange = resolveSelection(snapshot, token.selections.selections[0]!)
    expect(tokenRange).toMatchObject({ startOffset: offset, endOffset: offset + 'color'.length })
  })
})

async function registerDefaultLanguages(workerClient: TreeSitterWorkerClient): Promise<void> {
  const descriptors = await Promise.all(
    TREE_SITTER_LANGUAGE_CONTRIBUTIONS.map(resolveTreeSitterLanguageContribution),
  )
  await workerClient.registerLanguages(descriptors)
}

type CaptureSignatureInput = {
  readonly startIndex: number
  readonly endIndex: number
  readonly captureName: string
  readonly languageId?: string
}

function captureSignature(captures: readonly CaptureSignatureInput[]): string[] {
  return captures
    .map((capture) => {
      const languageId = capture.languageId ?? ''
      return `${capture.startIndex}:${capture.endIndex}:${capture.captureName}:${languageId}`
    })
    .sort()
}

function packedTokensCoverRange(
  tokens: { readonly starts: Uint32Array; readonly ends: Uint32Array } | undefined,
  startIndex: number,
  endIndex: number,
): boolean {
  if (!tokens) return false
  return tokens.starts.some(
    (start, index) => start <= startIndex && tokens.ends[index]! >= endIndex,
  )
}

type IncrementalInjectionScenario = {
  readonly documentId: string
  readonly languageId: TreeSitterLanguageId
  readonly text: string
  readonly edit: TextEdit
}

async function compareIncrementalInjectionsWithFullParse(
  workerClient: TreeSitterWorkerClient,
  scenario: IncrementalInjectionScenario,
) {
  const snapshot = createPieceTableSnapshot(scenario.text)
  const initial = await workerClient.parse({
    documentId: scenario.documentId,
    snapshotVersion: 1,
    languageId: scenario.languageId,
    snapshot,
  })
  if (!initial) throw new Error(`Initial parse failed for ${scenario.documentId}`)

  const nextSnapshot = applyBatchToPieceTable(snapshot, [scenario.edit])
  const payload = createTreeSitterEditPayload({
    documentId: scenario.documentId,
    previousSnapshotVersion: 1,
    snapshotVersion: 2,
    languageId: scenario.languageId,
    previousSnapshot: snapshot,
    nextSnapshot,
    edits: [scenario.edit],
  })
  if (!payload) throw new Error(`Edit payload failed for ${scenario.documentId}`)

  const incremental = await workerClient.edit(payload)
  if (!incremental) throw new Error(`Incremental parse failed for ${scenario.documentId}`)

  const full = await workerClient.parse({
    documentId: `${scenario.documentId}:full`,
    snapshotVersion: 1,
    languageId: scenario.languageId,
    snapshot: nextSnapshot,
  })
  if (!full) throw new Error(`Full parse failed for ${scenario.documentId}`)

  expect(incremental.captures).toEqual(full.captures)
  expect(incremental.tokensPacked).toEqual(full.tokensPacked)
  expect(incremental.injections).toEqual(full.injections)
  return { initial, incremental, full }
}
