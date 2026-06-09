import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import * as lspApi from '../src/index.ts'
import {
  LspClient,
  LspWorkspace,
  createWorkerLspTransport,
  defaultClientCapabilities,
  offsetToLspPosition,
  type LspTextEdit,
  type LspTransport,
} from '../src/index.ts'

describe('public API facade', () => {
  it('exports the LSP client, workspace, transport types, and helpers', () => {
    const transport: LspTransport = {
      send: () => undefined,
      subscribe: () => undefined,
      unsubscribe: () => undefined,
    }
    const edit: LspTextEdit = { from: 0, to: 0, text: 'x' }

    expect(LspClient).toBeTypeOf('function')
    expect(LspWorkspace).toBeTypeOf('function')
    expect(createWorkerLspTransport).toBeTypeOf('function')
    expect(defaultClientCapabilities().textDocument?.synchronization?.didSave).toBe(false)
    expect(offsetToLspPosition('abc', 1)).toEqual({ line: 0, character: 1 })
    expect(edit).toEqual({ from: 0, to: 0, text: 'x' })
    expect(transport).toBeTruthy()
  })

  it('does not export editor plugin factories', () => {
    expect(lspApi).not.toHaveProperty('createLspPlugin')
    expect(Object.keys(lspApi).filter((name) => name.includes('Plugin'))).toEqual([])
  })

  it('stays independent from editor plugin APIs', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly dependencies?: Record<string, string>
      readonly peerDependencies?: Record<string, string>
      readonly devDependencies?: Record<string, string>
    }
    const text = sourceText()

    expect(packageJson.dependencies ?? {}).not.toHaveProperty('@singapor/core')
    expect(packageJson.peerDependencies ?? {}).not.toHaveProperty('@singapor/core')
    expect(packageJson.devDependencies ?? {}).not.toHaveProperty('@singapor/core')
    expect(text).not.toContain('@singapor/core')
    expect(text).not.toContain('EditorPlugin')
  })
})

function sourceText(): string {
  return readdirSync('src')
    .filter((file) => file.endsWith('.ts'))
    .map((file) => readFileSync(join('src', file), 'utf8'))
    .join('\n')
}
