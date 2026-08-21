/*
 * A real `ts.LanguageService` over a virtual file system, with the network switched off.
 *
 * The worker's `createService` pulls its `lib.*.d.ts` files off the TypeScript playground CDN. No
 * suite of ours may do that: a test that fails when a CDN blinks is a test nobody trusts, and CI
 * has no business dialling out. The identical lib files already sit in `node_modules/typescript/lib`
 * — this reads them from there and hands the map to the seam `createService` grew for the purpose.
 *
 * The suites and `bench/semanticClassification.ts` share this module because a benchmark that
 * measures a differently-built service is measuring something no test asserts about.
 *
 * It deliberately does not import the worker to borrow its compiler options: the worker installs an
 * `onmessage` handler the moment it is imported, which pins a plain Bun process open forever. The
 * options below are a copy, and `realTypeScriptService.test.ts` fails if the copy ever drifts.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import {
  createSystem,
  createVirtualTypeScriptEnvironment,
  type VirtualTypeScriptEnvironment,
} from '@typescript/vfs'
import ts from 'typescript'

/** A copy of the worker's `defaultCompilerOptions()`, kept honest by a test. */
export const REAL_SERVICE_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  noEmit: true,
  allowJs: true,
  checkJs: false,
  allowImportingTsExtensions: true,
  esModuleInterop: true,
  skipLibCheck: true,
  resolveJsonModule: true,
}

// Reading a hundred-odd lib files is a few megabytes of I/O, and every suite in this file's orbit
// wants the same bytes. Read them once per process.
let libraryFiles: ReadonlyMap<string, string> | null = null

/**
 * The `lib.*.d.ts` set the CDN would have served, keyed the way `createSystem` expects it — a
 * leading slash and nothing else, because that is what `getDefaultLibFileName` resolves to.
 */
export const typeScriptLibraryFilesFromDisk = (): ReadonlyMap<string, string> => {
  if (libraryFiles) return libraryFiles

  const directory = typeScriptLibraryDirectory()
  const files = new Map<string, string>()
  for (const entry of readdirSync(directory)) {
    if (!isLibraryFileName(entry)) continue
    files.set(`/${entry}`, readFileSync(join(directory, entry), 'utf8'))
  }

  libraryFiles = files
  return files
}

/** Builds a language service whose only source files are the ones handed in, plus the libs. */
export const createRealTypeScriptService = (
  sourceFiles: ReadonlyMap<string, string>,
): VirtualTypeScriptEnvironment => {
  const fsMap = new Map(typeScriptLibraryFilesFromDisk())
  for (const [fileName, text] of sourceFiles) fsMap.set(fileName, text)

  return createVirtualTypeScriptEnvironment(
    createSystem(fsMap),
    Array.from(sourceFiles.keys()),
    ts,
    REAL_SERVICE_COMPILER_OPTIONS,
  )
}

const isLibraryFileName = (entry: string): boolean =>
  entry.startsWith('lib.') && entry.endsWith('.d.ts')

// `require.resolve` rather than a relative path: bun hoists this package's `typescript` to wherever
// it likes, and a hardcoded `../../node_modules` walks off a cliff the first time it does.
const typeScriptLibraryDirectory = (): string =>
  dirname(createRequire(import.meta.url).resolve('typescript'))
