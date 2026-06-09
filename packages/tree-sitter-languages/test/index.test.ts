import { describe, expect, it, vi } from 'vitest'

import { createPieceTableSnapshot } from '@singapor/core/document'
import type { EditorPluginContext } from '@singapor/core/extensions'
import type {
  TreeSitterLanguageAssets,
  TreeSitterLanguageContribution,
} from '@singapor/tree-sitter'
import {
  JAVASCRIPT_TREE_SITTER_LANGUAGE,
  TREE_SITTER_LANGUAGE_CONTRIBUTIONS,
  TYPESCRIPT_TREE_SITTER_LANGUAGE,
  css,
  html,
  javaScript,
  json,
  markdown,
  typeScript,
} from '../src'

describe('Tree-sitter language contributions', () => {
  it('exports the first-party language descriptors', () => {
    expect(TREE_SITTER_LANGUAGE_CONTRIBUTIONS.map((contribution) => contribution.id)).toEqual([
      'javascript',
      'typescript',
      'html',
      'css',
      'json',
      'markdown',
      'markdown_inline',
    ])
    expect(TREE_SITTER_LANGUAGE_CONTRIBUTIONS.every((contribution) => 'load' in contribution)).toBe(
      true,
    )
  })

  it('exports one configurable plugin per language', () => {
    const plugins = [
      javaScript({ jsx: true }),
      typeScript({ replace: true, tsx: true }),
      html(),
      css(),
      json(),
      markdown(),
    ]
    const context = pluginContext()
    const registerSyntaxProvider = vi.mocked(context.registerSyntaxProvider)

    for (const plugin of plugins) plugin.activate(context)

    expect(plugins.map((plugin) => plugin.name)).toEqual([
      'tree-sitter-javascript',
      'tree-sitter-typescript',
      'tree-sitter-html',
      'tree-sitter-css',
      'tree-sitter-json',
      'tree-sitter-markdown',
    ])
    expect(registerSyntaxProvider).toHaveBeenCalledTimes(1)
    expect(registerSyntaxProvider).toHaveBeenCalledWith(
      expect.objectContaining({ createSession: expect.any(Function) }),
    )
    expect(
      registerSyntaxProvider.mock.calls[0]?.[0].createSession({
        documentId: 'main.ts',
        languageId: 'typescript',
        includeHighlights: true,
        fullText: 'const a = 1;',
        snapshot: createPieceTableSnapshot('const a = 1;'),
      }),
    ).not.toBeNull()
  })

  it('loads JSX folds only for JSX-capable JavaScript and TypeScript assets', async () => {
    const [javascriptAssets, typescriptAssets, jsxJavascriptAssets, tsxTypescriptAssets] =
      await Promise.all([
        loadAssets(JAVASCRIPT_TREE_SITTER_LANGUAGE),
        loadAssets(TYPESCRIPT_TREE_SITTER_LANGUAGE),
        loadAssets(requiredContribution('javascript')),
        loadAssets(requiredContribution('typescript')),
      ])

    expect(javascriptAssets.foldQuerySource).not.toContain('jsx_element')
    expect(typescriptAssets.foldQuerySource).not.toContain('jsx_element')
    expect(jsxJavascriptAssets.foldQuerySource).toContain('jsx_element')
    expect(jsxJavascriptAssets.foldQuerySource).toContain('jsx_self_closing_element')
    expect(tsxTypescriptAssets.foldQuerySource).toContain('jsx_element')
    expect(tsxTypescriptAssets.foldQuerySource).toContain('jsx_self_closing_element')
  })
})

function requiredContribution(id: string): TreeSitterLanguageContribution {
  const contribution = TREE_SITTER_LANGUAGE_CONTRIBUTIONS.find((candidate) => candidate.id === id)
  if (!contribution) throw new Error(`Missing language contribution: ${id}`)
  return contribution
}

async function loadAssets(
  contribution: TreeSitterLanguageContribution,
): Promise<TreeSitterLanguageAssets> {
  if (!contribution.load) throw new Error(`Language contribution is not lazy: ${contribution.id}`)
  return contribution.load()
}

function pluginContext(): EditorPluginContext {
  return {
    registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
    registerSyntaxProvider: vi.fn<EditorPluginContext['registerSyntaxProvider']>(() => ({
      dispose: vi.fn(),
    })),
    registerViewContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerCommandContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerCapabilityContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerEditContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerDecorationContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerBlockProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerInjectedTextRowProvider: vi.fn(() => ({ dispose: vi.fn() })),
  }
}
