import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import { Language, Parser, Query } from 'web-tree-sitter'
import type { EditorSyntaxCapture } from '@singapor/core/syntax'
import { createInlineMap, inlineRowForBufferRow } from '@singapor/core/rendering'
import { createPieceTableSnapshot } from '@singapor/core/document'
import { markdownInlineReplacements } from '../src/replacements'

/**
 * These run the real markdown grammars rather than hand-written capture fixtures. The derivation
 * reads generic capture names structurally, so fixtures would only ever re-assert the assumptions
 * the derivation was written against; parsing for real is what catches the grammar disagreeing.
 */
const languagesDir = `${process.cwd()}/../tree-sitter-languages/src/`

let parseMarkdown: (text: string) => readonly EditorSyntaxCapture[]

beforeAll(async () => {
  await Parser.init()

  const blockLanguage = await Language.load(
    await readFile(`${languagesDir}grammars/tree-sitter-markdown.wasm`),
  )
  const inlineLanguage = await Language.load(
    await readFile(`${languagesDir}grammars/tree-sitter-markdown-inline.wasm`),
  )
  const blockQuery = new Query(
    blockLanguage,
    await readFile(`${languagesDir}queries/markdown-highlights.scm`, 'utf8'),
  )
  const inlineQuery = new Query(
    inlineLanguage,
    await readFile(`${languagesDir}queries/markdown-inline-highlights.scm`, 'utf8'),
  )

  const blockParser = new Parser()
  blockParser.setLanguage(blockLanguage)
  const inlineParser = new Parser()
  inlineParser.setLanguage(inlineLanguage)

  parseMarkdown = (text) => {
    const captures: EditorSyntaxCapture[] = []
    const tree = blockParser.parse(text)!
    const root = tree.rootNode

    for (const capture of blockQuery.captures(root)) {
      captures.push({
        captureName: capture.name,
        startIndex: capture.node.startIndex,
        endIndex: capture.node.endIndex,
      })
    }

    // Mirrors the markdown -> markdown_inline injection: inline content is parsed separately and its
    // captures are shifted back into document offsets.
    for (const inlineNode of inlineNodes(root)) {
      const inlineTree = inlineParser.parse(text.slice(inlineNode.startIndex, inlineNode.endIndex))!
      for (const capture of inlineQuery.captures(inlineTree.rootNode)) {
        captures.push({
          captureName: capture.name,
          startIndex: inlineNode.startIndex + capture.node.startIndex,
          endIndex: inlineNode.startIndex + capture.node.endIndex,
        })
      }
      inlineTree.delete()
    }

    tree.delete()
    return captures
  }
})

type SyntaxNode = { type: string; startIndex: number; endIndex: number; children: SyntaxNode[] }

const inlineNodes = (node: SyntaxNode): SyntaxNode[] => {
  if (node.type === 'inline') return [node]
  return node.children.flatMap((child) => inlineNodes(child))
}

/**
 * Renders a single-line document through the real map, so assertions read as what a user sees and
 * anchoring plus overlap normalization are exercised on the way.
 */
const preview = (text: string): string => {
  const specs = markdownInlineReplacements(text, parseMarkdown(text))
  const map = createInlineMap(createPieceTableSnapshot(text), specs)
  return inlineRowForBufferRow(map, 0, text).text
}

describe('markdown inline replacements', () => {
  it('hides emphasis and strong fences', () => {
    expect(preview('a **bold** b')).toBe('a bold b')
    expect(preview('an _em_ word')).toBe('an em word')
    expect(preview('***both***')).toBe('both')
  })

  it('hides inline code fences', () => {
    expect(preview('use `code` here')).toBe('use code here')
  })

  it('hides heading markers and the space after them', () => {
    expect(preview('# Title')).toBe('Title')
    expect(preview('### Deep heading')).toBe('Deep heading')
  })

  it('collapses links and images to their label', () => {
    expect(preview('see [docs](https://x.dev) now')).toBe('see docs now')
    expect(preview('![alt](img.png)')).toBe('alt')
    expect(preview('a [ref] b')).toBe('a ref b')
  })

  it('substitutes bullets width-for-width', () => {
    expect(preview('- item')).toBe('• item')
    expect(preview('* star item')).toBe('• star item')
  })

  it('leaves ordered lists and block quotes alone', () => {
    expect(preview('1. ordered')).toBe('1. ordered')
    expect(preview('> quoted')).toBe('> quoted')
  })

  it('leaves escapes and stray punctuation alone', () => {
    expect(preview('escaped \\*not em\\*')).toBe('escaped \\*not em\\*')
    expect(preview('text with * lone star')).toBe('text with * lone star')
  })

  it('never collapses a fenced code block', () => {
    const text = '```js\nconst a = 1\n```'
    const specs = markdownInlineReplacements(text, parseMarkdown(text))

    expect(specs.filter((spec) => spec.text === '')).toEqual([])
  })

  it('groups both fences of one construct so they reveal together', () => {
    const text = 'a **bold** b'
    const specs = markdownInlineReplacements(text, parseMarkdown(text))
    const groups = new Set(specs.map((spec) => spec.groupId))

    expect(specs.length).toBeGreaterThan(1)
    expect(groups.size).toBe(1)
  })

  it('gives each construct on a line its own group', () => {
    const text = '**a** and _b_'
    const specs = markdownInlineReplacements(text, parseMarkdown(text))

    expect(new Set(specs.map((spec) => spec.groupId)).size).toBe(2)
    expect(preview(text)).toBe('a and b')
  })

  it('drops zero-width captures rather than emitting empty replacements', () => {
    const text = '- item\n- other'
    const specs = markdownInlineReplacements(text, parseMarkdown(text))

    for (const spec of specs) expect(spec.endIndex).toBeGreaterThan(spec.startIndex)
  })
})
