import { describe, expect, it } from 'vitest'

import { createPieceTableSnapshot } from '@singapor/core/document'
import { TreeSitterSyntaxSession } from '../src/session.ts'
import type { TreeSitterLanguageDescriptor } from '../src/treeSitter/registry.ts'
import type { TreeSitterBackend } from '../src/treeSitter/workerClient.ts'

/**
 * The worker cannot ask for a language it was never sent, so an injection whose grammar stayed on
 * the main thread silently drops its whole layer — markdown_inline is an injection, which is why
 * markdown used to lose every inline construct.
 */

const DESCRIPTORS: Record<string, TreeSitterLanguageDescriptor> = {
  markdown: descriptor(
    'markdown',
    '((inline) @injection.content (#set! injection.language "markdown_inline"))',
  ),
  markdown_inline: descriptor(
    'markdown_inline',
    '((html_tag) @injection.content (#set! injection.language "html"))',
  ),
  html: descriptor('html'),
}

describe('injected language registration', () => {
  it('registers the languages an injection query names, transitively', async () => {
    const registered: string[][] = []
    const session = createSession('markdown', registered)

    await session.refresh(createPieceTableSnapshot('# Title\n'))

    expect(registered).toEqual([['markdown', 'markdown_inline', 'html']])
  })

  it('registers only the document language when nothing is injected', async () => {
    const registered: string[][] = []
    const session = createSession('html', registered)

    await session.refresh(createPieceTableSnapshot('<p>hi</p>'))

    expect(registered).toEqual([['html']])
  })
})

function createSession(languageId: string, registered: string[][]): TreeSitterSyntaxSession {
  return new TreeSitterSyntaxSession({
    documentId: 'doc',
    languageId,
    languageResolver: {
      resolveTreeSitterLanguage: async (id) => DESCRIPTORS[id] ?? null,
    },
    backend: recordingBackend(registered),
    snapshot: createPieceTableSnapshot(''),
  })
}

function recordingBackend(registered: string[][]): TreeSitterBackend {
  return {
    registerLanguages: async (languages) => {
      registered.push(languages.map((language) => language.id))
    },
    parse: async () => undefined,
    edit: async () => undefined,
    select: async () => undefined,
    disposeDocument: () => undefined,
  }
}

function descriptor(id: string, injectionQuerySource?: string): TreeSitterLanguageDescriptor {
  return {
    id,
    aliases: [id],
    extensions: [],
    wasmUrl: `${id}.wasm`,
    ...(injectionQuerySource ? { injectionQuerySource } : {}),
  }
}
