import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type PackageJson = {
  readonly exports: Record<string, string>
  readonly dependencies?: Record<string, string>
}

const TYPE_SCRIPT_SPECIALIZATION_FILES = [
  'index.ts',
  'paths.ts',
  'plugin.ts',
  'pluginWithWorker.ts',
  'server.ts',
  'tsDiagnostics.ts',
  'types.ts',
  'typescriptLsp.worker.ts',
  'workerOwner.ts',
] as const

const SHARED_LSP_PLUGIN_FILES = [
  'completion.ts',
  'completionController.ts',
  'definitionNavigation.ts',
  'diagnosticProjection.ts',
  'diagnostics.ts',
  'diagnosticsPresenter.ts',
  'documentSync.ts',
  'hoverDefinitionController.ts',
  'lspConnection.ts',
  'markdownTooltip.ts',
  'plugin.styles.ts',
  'pluginTypes.ts',
  'tooltip.ts',
  'websocket.ts',
] as const

describe('@singapor/typescript-lsp package boundary', () => {
  it('keeps generic LSP implementation files owned by @singapor/lsp-plugin', () => {
    const files = sourceFiles()

    expect([...files].sort()).toEqual([...TYPE_SCRIPT_SPECIALIZATION_FILES].sort())
    for (const file of SHARED_LSP_PLUGIN_FILES) {
      expect(files.has(file), `${file} belongs in @singapor/lsp-plugin`).toBe(false)
    }
  })

  it('exports only TypeScript specialization entrypoints', () => {
    const packageJson = readPackageJson()

    expect(packageJson.exports).toEqual({
      '.': './src/index.ts',
      './server': './src/server.ts',
      './ts-diagnostics': './src/tsDiagnostics.ts',
    })
    expect(packageJson.dependencies).toMatchObject({
      '@singapor/lsp-plugin': 'workspace:*',
    })
    expect(packageJson.dependencies).not.toHaveProperty('unified')
    expect(packageJson.dependencies).not.toHaveProperty('remark-parse')
    expect(packageJson.dependencies).not.toHaveProperty('remark-stringify')
    expect(packageJson.dependencies).not.toHaveProperty('remark-gfm')
  })
})

function sourceFiles(): ReadonlySet<string> {
  return new Set(readdirSync(join(process.cwd(), 'src')).filter((file) => file.endsWith('.ts')))
}

function readPackageJson(): PackageJson {
  const text = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
  return JSON.parse(text) as PackageJson
}
