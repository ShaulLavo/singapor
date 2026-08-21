import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import { Language, Parser, Query } from 'web-tree-sitter'

import type { EditorSyntaxCapture, EditorToken } from '@singapor/core/syntax'
import { styleForTreeSitterCapture, treeSitterCapturesToEditorTokens } from '@singapor/core/syntax'

/**
 * Capture-to-token conversion against the grammars and queries this package actually ships.
 *
 * Hand-written capture fixtures cannot answer the question these tests ask. The defect is that
 * several shipped rules match the same span, and a fixture can only ever contain the overlaps its
 * author already thought of — running the real queries is what catches the ones nobody enumerated.
 */
const grammarsDir = `${process.cwd()}/src/grammars/`
const queriesDir = `${process.cwd()}/src/queries/`
const modulesDir = `${process.cwd()}/node_modules/`

type CaptureParser = (text: string) => readonly EditorSyntaxCapture[]

let parseTypeScript: CaptureParser
let parseMarkdown: CaptureParser

/**
 * Mirrors the worker's own collection: dedupe on start, end, name and language, then sort by span.
 * Two captures over one span with *different* names both survive that key, which is the whole
 * reason exact-span resolution has to happen afterwards.
 *
 * @see collectCapture and sortCaptures in packages/tree-sitter/src/treeSitter/treeSitter.worker.ts
 */
const collect = (
  query: Query,
  rootNode: Parameters<Query['matches']>[0],
  languageId: string,
  offset = 0,
): EditorSyntaxCapture[] => {
  const captures: EditorSyntaxCapture[] = []
  const seen = new Set<string>()

  for (const match of query.matches(rootNode)) {
    for (const capture of match.captures) {
      const node = capture.node
      if (!node) continue

      const startIndex = offset + node.startIndex
      const endIndex = offset + node.endIndex
      const captureName = capture.name ?? ''
      const key = `${startIndex}:${endIndex}:${captureName}:${languageId}`
      if (seen.has(key)) continue
      if (startIndex >= endIndex) continue

      seen.add(key)
      captures.push({ captureName, endIndex, startIndex })
    }
  }

  return captures.toSorted((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex)
}

type SyntaxNode = { type: string; startIndex: number; endIndex: number; children: SyntaxNode[] }

const inlineNodes = (node: SyntaxNode): SyntaxNode[] => {
  if (node.type === 'inline') return [node]
  return node.children.flatMap((child) => inlineNodes(child))
}

beforeAll(async () => {
  await Parser.init()

  // What loadTypeScriptAssets ships for a non-tsx file: the TypeScript rules concatenated with the
  // JavaScript ones. Both files contribute a rule that matches a capitalised identifier.
  const typeScriptLanguage = await Language.load(
    await readFile(`${modulesDir}tree-sitter-typescript/tree-sitter-typescript.wasm`),
  )
  const typeScriptQuery = new Query(
    typeScriptLanguage,
    [
      await readFile(`${queriesDir}typescript-highlights.scm`, 'utf8'),
      await readFile(`${queriesDir}javascript-highlights.scm`, 'utf8'),
    ].join('\n'),
  )
  const typeScriptParser = new Parser()
  typeScriptParser.setLanguage(typeScriptLanguage)

  parseTypeScript = (text) => {
    const tree = typeScriptParser.parse(text)!
    const captures = collect(typeScriptQuery, tree.rootNode, 'typescript')
    tree.delete()
    return captures
  }

  const blockLanguage = await Language.load(
    await readFile(`${grammarsDir}tree-sitter-markdown.wasm`),
  )
  const inlineLanguage = await Language.load(
    await readFile(`${grammarsDir}tree-sitter-markdown-inline.wasm`),
  )
  const blockQuery = new Query(
    blockLanguage,
    await readFile(`${queriesDir}markdown-highlights.scm`, 'utf8'),
  )
  const inlineQuery = new Query(
    inlineLanguage,
    await readFile(`${queriesDir}markdown-inline-highlights.scm`, 'utf8'),
  )
  const blockParser = new Parser()
  blockParser.setLanguage(blockLanguage)
  const inlineParser = new Parser()
  inlineParser.setLanguage(inlineLanguage)

  parseMarkdown = (text) => {
    const tree = blockParser.parse(text)!
    const captures = collect(blockQuery, tree.rootNode, 'markdown')

    // Mirrors the markdown -> markdown_inline injection: inline content parses separately and its
    // captures shift back into document offsets.
    for (const inlineNode of inlineNodes(tree.rootNode as unknown as SyntaxNode)) {
      const inlineTree = inlineParser.parse(text.slice(inlineNode.startIndex, inlineNode.endIndex))!
      captures.push(
        ...collect(inlineQuery, inlineTree.rootNode, 'markdown_inline', inlineNode.startIndex),
      )
      inlineTree.delete()
    }

    tree.delete()
    return captures.toSorted((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex)
  }
})

const tokensOver = (tokens: readonly EditorToken[], start: number, end: number): EditorToken[] =>
  tokens.filter((token) => token.start === start && token.end === end)

const spanOf = (text: string, needle: string): readonly [number, number] => {
  const start = text.indexOf(needle)
  expect(start, `fixture must contain ${needle}`).toBeGreaterThanOrEqual(0)
  return [start, start + needle.length]
}

describe('exact-span capture overlaps', () => {
  // Four shipped rules match this identifier: @variable and @constant and @constructor from
  // javascript-highlights.scm, @type from typescript-highlights.scm. Before exact-span resolution
  // all four became tokens, each with its own style, all at the same highlight priority — and the
  // one that painted was decided by registry insertion order, i.e. by session history.
  const FIXTURE = 'const MAX = 10\n'

  it('emits one token for an identifier four rules claim, and it is the constant', () => {
    const tokens = treeSitterCapturesToEditorTokens(parseTypeScript(FIXTURE))
    const [start, end] = spanOf(FIXTURE, 'MAX')
    const over = tokensOver(tokens, start, end)

    expect(over).toHaveLength(1)
    expect(over[0]?.style).toEqual(styleForTreeSitterCapture('constant'))
    expect(over[0]?.style).not.toEqual(styleForTreeSitterCapture('type'))
    expect(over[0]?.style).not.toEqual(styleForTreeSitterCapture('constructor'))
    expect(over[0]?.style).not.toEqual(styleForTreeSitterCapture('variable'))
  })

  it('confirms the raw captures really do claim that span four times', () => {
    const [start, end] = spanOf(FIXTURE, 'MAX')
    const names = parseTypeScript(FIXTURE)
      .filter((capture) => capture.startIndex === start && capture.endIndex === end)
      .map((capture) => capture.captureName)
      .toSorted()

    expect(names).toEqual(['constant', 'constructor', 'type', 'variable'])
  })

  it('leaves no two tokens sharing a span across a broader fixture', () => {
    const source = [
      'const MAX = 10',
      'const Handler = class {}',
      'type Alias = string',
      'interface Shape { size: number }',
      'function build<T>(input: T): T { return input }',
      'namespace Outer { export const VALUE = 1 }',
      'const enumeration = { A: 1, B: 2 }',
      'class Widget extends Base { render() { return this.size } }',
      'export default Widget',
    ].join('\n')
    const tokens = treeSitterCapturesToEditorTokens(parseTypeScript(source))
    const spans = tokens.map((token) => `${token.start}:${token.end}`)

    expect(new Set(spans).size).toBe(spans.length)
  })

  it('produces byte-identical output for a document parsed either side of another one', () => {
    const other = 'class Other { method() { return NAME } }\nconst NAME = "x"\n'

    const first = treeSitterCapturesToEditorTokens(parseTypeScript(FIXTURE))
    treeSitterCapturesToEditorTokens(parseTypeScript(other))
    const second = treeSitterCapturesToEditorTokens(parseTypeScript(FIXTURE))

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  /**
   * Pinned, not fixed. A capture nested inside a larger one is not an exact-span duplicate, so
   * nothing chooses between the two and both still become tokens — which one paints where they
   * cover the same characters remains a function of registry order. Milestone 1 deliberately does
   * not extend the ranking to cover it; this test exists so that a change which does is visible.
   */
  it('leaves partial overlaps alone, order-dependent as they were', () => {
    const source = 'const value = obj.prop\n'
    const tokens = treeSitterCapturesToEditorTokens(parseTypeScript(source))
    const [start, end] = spanOf(source, 'obj.prop')
    const nested = tokens.filter((token) => token.start >= start && token.end <= end)

    expect(nested.length).toBeGreaterThan(1)
    expect(nested.some((token) => token.start !== start || token.end !== end)).toBe(true)
  })
})

describe('capture names deeper than the shipped queries produce', () => {
  /**
   * A grammar contributed through `registerLanguage` is free to name captures as deep as it likes,
   * and the style trie already resolves them by longest prefix — `keyword.declaration.function`
   * picks up `keyword.declaration`. The specificity table has to be read the same way, or the more
   * specific capture ranks below `variable` and loses its span to the one name the table calls the
   * fallback: the exact inversion the table exists to prevent.
   */
  it('ranks a three-segment name by its prefix rather than dropping it to the bottom', () => {
    const tokens = treeSitterCapturesToEditorTokens([
      { captureName: 'variable', endIndex: 3, startIndex: 0 },
      { captureName: 'keyword.declaration.function', endIndex: 3, startIndex: 0 },
    ])

    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.style).toEqual(styleForTreeSitterCapture('keyword.declaration'))
  })

  it('still puts an unranked name below every ranked one', () => {
    const tokens = treeSitterCapturesToEditorTokens([
      { captureName: 'variable', endIndex: 3, startIndex: 0 },
      { captureName: 'comment.doc.zig', endIndex: 3, startIndex: 0 },
    ])

    expect(tokens).toHaveLength(1)
    // `comment` is ranked, and above `variable`, so its deeper form wins the span.
    expect(tokens[0]?.style).toEqual(styleForTreeSitterCapture('comment'))
  })
})

describe('markdown emphasis and strong', () => {
  const FIXTURE = 'plain *emphasis* and **strong** text\n'

  // Both scopes used to declare a font property and nothing else. A ::highlight() rule cannot apply
  // one, so the rule was emitted, the group was registered, and the span painted exactly nothing.
  it('paints emphasis and strong with a colour of their own', () => {
    const tokens = treeSitterCapturesToEditorTokens(parseMarkdown(FIXTURE))
    const emphasis = tokens.find((token) => FIXTURE.slice(token.start, token.end) === '*emphasis*')
    const strong = tokens.find((token) => FIXTURE.slice(token.start, token.end) === '**strong**')

    expect(emphasis?.style.color).toBeTruthy()
    expect(strong?.style.color).toBeTruthy()
    expect(emphasis?.style.color).not.toBe(strong?.style.color)
  })

  // Plain markdown text carries no capture at all, so it paints in the editor's foreground. A
  // colour equal to that one would be no more visible than the font property it replaced.
  it('gives them a colour the surrounding plain text does not have', () => {
    const tokens = treeSitterCapturesToEditorTokens(parseMarkdown(FIXTURE))
    const [plainStart] = spanOf(FIXTURE, 'plain')
    const covering = tokens.filter((token) => token.start <= plainStart && token.end > plainStart)

    expect(covering).toHaveLength(0)
    expect(styleForTreeSitterCapture('text.emphasis')?.color).toBeTruthy()
    expect(styleForTreeSitterCapture('text.strong')?.color).toBeTruthy()
  })
})
