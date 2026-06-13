import { createRequire } from 'node:module'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)
const packageDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(packageDir, '../..')
const languagePackageDir = resolve(packageDir, '../tree-sitter-languages')
const servedDependencyRoots = uniqueItems(
  [
    'web-tree-sitter',
    'tree-sitter-css',
    'tree-sitter-html',
    'tree-sitter-javascript',
    'tree-sitter-json',
    'tree-sitter-typescript',
  ]
    .map(dependencyAllowRoot)
    .filter((root): root is string => Boolean(root)),
)

export default defineConfig({
  server: {
    fs: {
      allow: [workspaceRoot, ...servedDependencyRoots],
    },
  },
  test: {
    browser: {
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
    environment: 'happy-dom',
  },
})

function dependencyAllowRoot(packageName: string): string | null {
  const packageJsonPath = resolveDependency(`${packageName}/package.json`)
  if (!packageJsonPath) return null
  const packageRoot = dirname(packageJsonPath)
  return bunStoreRoot(packageRoot) ?? packageRoot
}

function resolveDependency(specifier: string): string | null {
  try {
    return require.resolve(specifier, { paths: [packageDir, languagePackageDir] })
  } catch {
    return null
  }
}

function bunStoreRoot(packageRoot: string): string | null {
  const marker = `${sep}node_modules${sep}.bun${sep}`
  const index = packageRoot.indexOf(marker)
  if (index === -1) return null
  return packageRoot.slice(0, index + marker.length - 1)
}

function uniqueItems<T>(items: readonly T[]): T[] {
  return Array.from(new Set(items))
}
