import { afterEach, describe, expect, it, vi } from "vitest";
import type * as lsp from "vscode-languageserver-protocol";

const createDefaultMapFromCDN = vi.hoisted(() => vi.fn());
const createSystem = vi.hoisted(() => vi.fn());
const createVirtualTypeScriptEnvironment = vi.hoisted(() => vi.fn());
const fakeTs = vi.hoisted(() => ({
  version: "5.9.3",
  ScriptTarget: { ES2023: 10 },
  ModuleKind: { ESNext: 99 },
  ModuleResolutionKind: { Bundler: 100 },
  JsxEmit: { ReactJSX: 4 },
  DiagnosticCategory: {
    Warning: 0,
    Error: 1,
    Suggestion: 2,
    Message: 3,
  },
  flattenDiagnosticMessageText: (message: string) => message,
  displayPartsToString: (parts: readonly { readonly text: string }[] = []) =>
    parts.map((part) => part.text).join(""),
  parseConfigFileTextToJson: (_fileName: string, text: string) => ({ config: JSON.parse(text) }),
  parseJsonConfigFileContent: (
    config: { readonly compilerOptions?: Record<string, unknown> },
    host: { readDirectory(rootDir: string, extensions: readonly string[]): string[] },
    basePath: string,
  ) => ({
    options: config.compilerOptions ?? {},
    fileNames: host.readDirectory(basePath, [".ts", ".tsx", ".mts", ".cts"]),
    errors: [],
  }),
}));

vi.mock("@typescript/vfs", () => ({
  createDefaultMapFromCDN,
  createSystem,
  createVirtualTypeScriptEnvironment,
}));
vi.mock("typescript", () => ({ default: fakeTs }));

describe("TypeScript LSP worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    globalThis.onmessage = null;
    createDefaultMapFromCDN.mockReset();
    createSystem.mockReset();
    createVirtualTypeScriptEnvironment.mockReset();
  });

  it("initializes, accepts workspace files, and publishes TypeScript diagnostics", async () => {
    const postMessage = vi.spyOn(globalThis, "postMessage").mockImplementation(() => undefined);
    const sourceFiles = new Map<string, string>();
    installVfsMocks(sourceFiles);
    await import("../src/typescriptLsp.worker");

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { initializationOptions: { diagnosticDelayMs: 0 } },
    });
    send({
      jsonrpc: "2.0",
      method: "editor/typescript/setWorkspaceFiles",
      params: { files: [{ path: "src/other.ts", text: "export const other = 1;" }] },
    });
    send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "file:///src/index.ts",
          languageId: "typescript",
          version: 0,
          text: "const value: string = 1;",
        },
      },
    });

    await waitFor(() => postMessage.mock.calls.some(([message]) => isPublishDiagnostics(message)));

    expect(createVirtualTypeScriptEnvironment).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["/src/other.ts", "/src/index.ts"]),
      fakeTs,
      expect.anything(),
    );
    expect(publishedDiagnostics(postMessage.mock.calls)).toMatchObject({
      uri: "file:///src/index.ts",
      version: 0,
      diagnostics: [
        {
          severity: 1,
          code: 2322,
          source: "typescript",
          message: "bad assignment",
        },
      ],
    });
  });

  it("reads compiler options from workspace tsconfig files", async () => {
    vi.spyOn(globalThis, "postMessage").mockImplementation(() => undefined);
    const sourceFiles = new Map<string, string>();
    installVfsMocks(sourceFiles);
    await import("../src/typescriptLsp.worker");

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { initializationOptions: { diagnosticDelayMs: 0 } },
    });
    send({
      jsonrpc: "2.0",
      method: "editor/typescript/setWorkspaceFiles",
      params: {
        files: [
          {
            path: "tsconfig.json",
            text: JSON.stringify({
              compilerOptions: { strict: false, lib: ["lib.es2024.d.ts"] },
            }),
          },
          { path: "src/index.ts", text: "const value: string = 1;" },
        ],
      },
    });
    send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "file:///src/index.ts",
          languageId: "typescript",
          version: 0,
          text: "const value: string = 1;",
        },
      },
    });

    await waitFor(() => createDefaultMapFromCDN.mock.calls.length > 0);

    expect(createDefaultMapFromCDN.mock.calls.at(-1)?.[0]).toMatchObject({
      lib: ["es2024"],
      strict: false,
    });
  });

  it("mirrors workspace packages into node_modules for package export resolution", async () => {
    vi.spyOn(globalThis, "postMessage").mockImplementation(() => undefined);
    const sourceFiles = new Map<string, string>();
    installVfsMocks(sourceFiles);
    await import("../src/typescriptLsp.worker");

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { initializationOptions: { diagnosticDelayMs: 0 } },
    });
    send({
      jsonrpc: "2.0",
      method: "editor/typescript/setWorkspaceFiles",
      params: {
        files: [
          {
            path: "packages/editor/package.json",
            text: JSON.stringify({
              name: "@editor/core",
              exports: { "./editor": "./src/editor.ts" },
            }),
          },
          {
            path: "packages/editor/src/editor.ts",
            text: "export class Editor {}",
          },
          {
            path: "examples/app/src/app.ts",
            text: 'import { Editor } from "@editor/core/editor";',
          },
        ],
      },
    });
    send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "file:///examples/app/src/app.ts",
          languageId: "typescript",
          version: 0,
          text: 'import { Editor } from "@editor/core/editor";',
        },
      },
    });

    await waitFor(() => sourceFiles.has("/node_modules/@editor/core/package.json"));

    expect(sourceFiles.get("/node_modules/@editor/core/package.json")).toContain("@editor/core");
    expect(sourceFiles.get("/node_modules/@editor/core/src/editor.ts")).toBe(
      "export class Editor {}",
    );
  });

  it("returns hover quick info from the TypeScript language service", async () => {
    const postMessage = vi.spyOn(globalThis, "postMessage").mockImplementation(() => undefined);
    const sourceFiles = new Map<string, string>();
    installVfsMocks(sourceFiles);
    await import("../src/typescriptLsp.worker");

    openDocumentWithInitializedWorker("const value = 1;");
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/hover",
      params: {
        textDocument: { uri: "file:///src/index.ts" },
        position: { line: 0, character: 6 },
      },
    });
    await waitFor(() => responseForId(postMessage.mock.calls, 2) !== null);

    expect(responseForId(postMessage.mock.calls, 2)).toMatchObject({
      result: {
        contents: {
          kind: "markdown",
          value: expect.stringContaining("const value: number"),
        },
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
      },
    });
  });

  it("returns workspace definition locations and demirrors node_modules package paths", async () => {
    const postMessage = vi.spyOn(globalThis, "postMessage").mockImplementation(() => undefined);
    const sourceFiles = new Map<string, string>();
    installVfsMocks(sourceFiles);
    await import("../src/typescriptLsp.worker");

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { initializationOptions: { diagnosticDelayMs: 0 } },
    });
    send({
      jsonrpc: "2.0",
      method: "editor/typescript/setWorkspaceFiles",
      params: {
        files: [
          { path: "packages/core/package.json", text: JSON.stringify({ name: "@repo/core" }) },
          { path: "packages/core/src/index.ts", text: "export const answer = 42;" },
        ],
      },
    });
    send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "file:///src/index.ts",
          languageId: "typescript",
          version: 0,
          text: "answer;",
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/definition",
      params: {
        textDocument: { uri: "file:///src/index.ts" },
        position: { line: 0, character: 1 },
      },
    });
    await waitFor(() => responseForId(postMessage.mock.calls, 2) !== null);

    expect(responseForId(postMessage.mock.calls, 2)).toMatchObject({
      result: [
        {
          uri: "file:///packages/core/src/index.ts",
          range: {
            start: { line: 0, character: 13 },
            end: { line: 0, character: 19 },
          },
        },
      ],
    });
  });
});

function installVfsMocks(sourceFiles: Map<string, string>): void {
  createDefaultMapFromCDN.mockResolvedValue(new Map([["/lib.d.ts", ""]]));
  createSystem.mockImplementation((files: Map<string, string>) => ({ files }));
  createVirtualTypeScriptEnvironment.mockImplementation(
    (system: { files: Map<string, string> }) => {
      sourceFiles.clear();
      for (const [fileName, text] of system.files) sourceFiles.set(fileName, text);
      return createEnvironment(sourceFiles);
    },
  );
}

function createEnvironment(sourceFiles: Map<string, string>): unknown {
  return {
    getSourceFile: (fileName: string) => sourceFiles.get(fileName),
    createFile: (fileName: string, text: string) => sourceFiles.set(fileName, text),
    updateFile: (fileName: string, text: string) => sourceFiles.set(fileName, text),
    deleteFile: (fileName: string) => sourceFiles.delete(fileName),
    languageService: {
      getSyntacticDiagnostics: () => [],
      getSemanticDiagnostics: (fileName: string) => [
        {
          file: { text: sourceFiles.get(fileName) ?? "" },
          start: 22,
          length: 1,
          category: fakeTs.DiagnosticCategory.Error,
          code: 2322,
          messageText: "bad assignment",
        },
      ],
      getSuggestionDiagnostics: () => [],
      getQuickInfoAtPosition: () => ({
        displayParts: [{ text: "const value: number" }],
        documentation: [{ text: "The current value." }],
        textSpan: { start: 6, length: 5 },
      }),
      getDefinitionAndBoundSpan: () => ({
        textSpan: { start: 0, length: 6 },
        definitions: [
          {
            fileName: "/node_modules/@repo/core/src/index.ts",
            textSpan: { start: 13, length: 6 },
          },
        ],
      }),
      getDefinitionAtPosition: () => [],
    },
  };
}

function openDocumentWithInitializedWorker(text: string): void {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { initializationOptions: { diagnosticDelayMs: 0 } },
  });
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///src/index.ts",
        languageId: "typescript",
        version: 0,
        text,
      },
    },
  });
}

function send(message: lsp.RequestMessage | lsp.NotificationMessage): void {
  const target = globalThis as unknown as {
    onmessage?: (event: MessageEvent) => void;
  };
  target.onmessage?.(new MessageEvent("message", { data: message }));
}

function isPublishDiagnostics(message: unknown): boolean {
  if (!isRecord(message)) return false;
  return message.method === "textDocument/publishDiagnostics";
}

function publishedDiagnostics(calls: readonly (readonly unknown[])[]): unknown {
  const message = calls.map(([item]) => item).find(isPublishDiagnostics);
  if (!isRecord(message)) return null;
  return message.params;
}

function responseForId(calls: readonly (readonly unknown[])[], id: number): unknown {
  return calls.map(([item]) => item).find((message) => isResponseForId(message, id)) ?? null;
}

function isResponseForId(message: unknown, id: number): boolean {
  if (!isRecord(message)) return false;
  return message.id === id;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for worker diagnostics");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
