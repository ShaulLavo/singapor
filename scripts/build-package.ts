import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'vite'

type PackageManifest = {
  readonly name: string
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly exports?: Record<string, ExportTarget>
}

type ExportTarget =
  | string
  | {
      readonly default?: string
      readonly import?: string
      readonly types?: string
    }

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const packageDir = path.resolve(Bun.argv[2] ?? '.')
const packageJsonPath = path.join(packageDir, 'package.json')
const sourceRoot = path.join(packageDir, 'src')
const distRoot = path.join(packageDir, 'dist')

const manifest = await readManifest()
const entries = entriesFromExports(manifest.exports)

if (Object.keys(entries).length === 0) {
  throw new Error(`${manifest.name} has no TypeScript package exports to build`)
}

await rm(distRoot, { recursive: true, force: true })
// CSS lands before the JS that imports it, so a watching dev server never sees
// a dist where index.js exists and its `import './style.css'` cannot resolve.
await copyCss()
await buildJavaScript()
await emitDeclarations()

async function readManifest(): Promise<PackageManifest> {
  const content = await readFile(packageJsonPath, 'utf8')
  return JSON.parse(content) as PackageManifest
}

function entriesFromExports(exportsField: PackageManifest['exports']): Record<string, string> {
  if (!exportsField) return {}

  const entries: Record<string, string> = {}
  for (const [exportPath, target] of Object.entries(exportsField)) {
    const source = sourceTarget(target)
    if (!source) continue
    if (!source.endsWith('.ts')) continue

    entries[entryName(exportPath, source)] = path.resolve(packageDir, source)
  }
  return entries
}

function sourceTarget(target: ExportTarget): string | null {
  if (typeof target === 'string') return sourceTargetFromRuntimeTarget(target)
  return sourceTargetFromRuntimeTarget(target.import ?? target.default ?? null)
}

function sourceTargetFromRuntimeTarget(target: string | null): string | null {
  if (!target) return null
  if (target.startsWith('./src/')) return target
  if (!target.startsWith('./dist/')) return target

  return target.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts')
}

function entryName(exportPath: string, source: string): string {
  if (exportPath === '.') return 'index'

  const sourceName = source.replace(/^\.\/src\//, '').replace(/\.ts$/, '')
  return sourceName.replaceAll(path.sep, '/')
}

async function buildJavaScript(): Promise<void> {
  await build({
    assetsInclude: ['**/*.wasm'],
    build: {
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      emptyOutDir: false,
      lib: {
        entry: entries,
        formats: ['es'],
      },
      minify: false,
      outDir: distRoot,
      rollupOptions: {
        external: externalDependency,
        output: {
          assetFileNames: 'assets/[name][extname]',
          chunkFileNames: 'chunks/[name]-[hash].js',
          entryFileNames: '[name].js',
          preserveModules: true,
          preserveModulesRoot: sourceRoot,
        },
      },
      sourcemap: true,
      target: 'es2023',
    },
    configFile: false,
    logLevel: 'warn',
    plugins: [externalizeCssImports(), inlineModuleWorkers()],
    publicDir: false,
    root: packageDir,
    worker: {
      format: 'es',
      rollupOptions: {
        external: [],
      },
    },
  })
}

function externalDependency(id: string, importer?: string): boolean {
  if (isSourceImport(id)) return false
  if (isWorkerImport(id, importer)) return false

  return externalPackageNames().has(packageNameFromSpecifier(id))
}

function isSourceImport(id: string): boolean {
  if (id.startsWith('.')) return true
  if (id.startsWith('/')) return true
  return id.includes('?')
}

function isWorkerImport(id: string, importer?: string): boolean {
  if (id.includes('?worker')) return false
  if (!importer) return false
  return importer.includes('.worker.')
}

function externalPackageNames(): ReadonlySet<string> {
  return new Set(
    Object.keys(manifest.dependencies ?? {}).concat(
      Object.keys(manifest.peerDependencies ?? {}),
      Object.keys(manifest.optionalDependencies ?? {}),
    ),
  )
}

function packageNameFromSpecifier(specifier: string): string {
  if (!specifier.startsWith('@')) return specifier.split('/')[0] ?? specifier

  const [scope, name] = specifier.split('/')
  return `${scope}/${name}`
}

function externalizeCssImports(): Plugin {
  return {
    name: 'singapor-externalize-css-imports',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!id.endsWith('.css')) return null
      if (!importer) return null

      const resolved = await this.resolve(id, importer)
      if (!resolved) return null

      return { id: resolved.id, external: true }
    },
  }
}

function inlineModuleWorkers(): Plugin {
  return {
    name: 'singapor-inline-module-workers',
    enforce: 'pre',
    transform(code, id) {
      if (!isTypeScriptModule(id)) return null

      return inlineModuleWorkerImports(code)
    },
  }
}

function isTypeScriptModule(id: string): boolean {
  if (id.endsWith('.ts')) return true
  return id.endsWith('.tsx')
}

function inlineModuleWorkerImports(
  code: string,
): { readonly code: string; readonly map: null } | null {
  const imports = new Map<string, string>()
  const transformed = code.replace(workerConstructorPattern(), (_match, workerPath: string) => {
    const identifier = workerIdentifier(imports.size)
    imports.set(workerPath, identifier)
    return `new ${identifier}()`
  })

  if (imports.size === 0) return null

  return {
    code: `${workerImportBlock(imports)}\n${transformed}`,
    map: null,
  }
}

function workerConstructorPattern(): RegExp {
  return /new\s+Worker\s*\(\s*new\s+URL\s*\(\s*['"](\.\/[^'"]+\.worker\.ts)['"]\s*,\s*import\.meta\.url\s*\)\s*,\s*\{\s*type\s*:\s*['"]module['"]\s*,?\s*\}\s*\)/g
}

function workerIdentifier(index: number): string {
  return `__SingaporInlineWorker${index}`
}

function workerImportBlock(imports: ReadonlyMap<string, string>): string {
  return Array.from(imports, ([workerPath, identifier]) => {
    return `import ${identifier} from '${workerPath}?worker&inline'`
  }).join('\n')
}

async function emitDeclarations(): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'singapor-dts-'))
  const tsconfigPath = path.join(tempDir, 'tsconfig.json')

  try {
    await writeFile(tsconfigPath, declarationTsconfig())
    await run(['bun', 'x', 'tsc', '-p', tsconfigPath], repositoryRoot)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

function declarationTsconfig(): string {
  return JSON.stringify(
    {
      extends: path.join(repositoryRoot, 'tsconfig.json'),
      compilerOptions: {
        declaration: true,
        declarationMap: true,
        emitDeclarationOnly: true,
        noEmit: false,
        outDir: distRoot,
        rootDir: sourceRoot,
      },
      include: [path.join(sourceRoot, '**/*')],
    },
    null,
    2,
  )
}

async function copyCss(): Promise<void> {
  await copyCssDirectory(sourceRoot)
}

async function copyCssDirectory(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const source = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await copyCssDirectory(source)
      continue
    }

    if (!entry.name.endsWith('.css')) continue

    const target = path.join(distRoot, path.relative(sourceRoot, source))
    await mkdir(path.dirname(target), { recursive: true })
    await cp(source, target)
  }
}

async function run(command: readonly string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, {
    cwd,
    stdin: 'inherit',
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode === 0) return

  throw new Error(`Command failed: ${command.join(' ')}`)
}
