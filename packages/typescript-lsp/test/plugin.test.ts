import type {
  DocumentSessionChange,
  EditorPluginContext,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewSnapshot,
  TextEdit,
} from "@editor/core";
import type { LspWorkerLike } from "@editor/lsp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTypeScriptLspPlugin, type TypeScriptLspDiagnosticSummary } from "../src";

type Listener = (event: Event) => void;
type JsonMessage = Record<string, unknown>;

class FakeWorker implements LspWorkerLike {
  public readonly sent: unknown[] = [];
  public terminated = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  public postMessage(message: unknown): void {
    this.sent.push(message);
  }

  public addEventListener(type: "message" | "error", handler: Listener): void {
    this.listenersFor(type).add(handler);
  }

  public removeEventListener(type: "message" | "error", handler: Listener): void {
    this.listenersFor(type).delete(handler);
  }

  public terminate(): void {
    this.terminated = true;
  }

  public receive(message: unknown): void {
    const event = new MessageEvent("message", { data: message });
    for (const listener of this.listenersFor("message")) listener(event);
  }

  private listenersFor(type: string): Set<Listener> {
    let listeners = this.listeners.get(type);
    if (listeners) return listeners;

    listeners = new Set();
    this.listeners.set(type, listeners);
    return listeners;
  }
}

describe("createTypeScriptLspPlugin", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("syncs the active TypeScript document through a worker and renders diagnostics", async () => {
    const worker = new FakeWorker();
    const diagnostics: TypeScriptLspDiagnosticSummary[] = [];
    const context = viewContributionContext(editorSnapshot());
    const plugin = createTypeScriptLspPlugin({
      diagnosticDelayMs: 0,
      workerFactory: () => worker,
      onDiagnostics: (summary) => diagnostics.push(summary),
    });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(context);
    if (!contribution) throw new Error("missing contribution");

    const initialize = message(worker.sent[0]);
    worker.receive(initializeResponse(initialize));
    await flushPromises();

    expect(sentMethods(worker)).toContain("textDocument/didOpen");
    expect(textDocumentFor(worker.sent.find(hasMethod("textDocument/didOpen")))).toMatchObject({
      uri: "file:///src/index.ts",
      languageId: "typescript",
      version: 0,
      text: "const value: string = 1;",
    });

    worker.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///src/index.ts",
        version: 0,
        diagnostics: [
          {
            severity: 1,
            source: "typescript",
            message: "bad assignment",
            range: {
              start: { line: 0, character: 22 },
              end: { line: 0, character: 23 },
            },
          },
        ],
      },
    });

    expect(context.setRangeHighlight).toHaveBeenCalledWith(
      "editor-test-typescript-lsp-error",
      [{ start: 22, end: 23 }],
      expect.objectContaining({
        textDecoration: expect.stringContaining("wavy"),
      }),
    );
    expect(diagnostics.at(-1)?.counts).toMatchObject({ error: 1, total: 1 });

    contribution.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("sends loaded workspace files to the worker", async () => {
    const worker = new FakeWorker();
    const plugin = createTypeScriptLspPlugin({
      workerFactory: () => worker,
    });
    const provider = activatePlugin(plugin);
    provider.createContribution(viewContributionContext(editorSnapshot()));

    const initialize = message(worker.sent[0]);
    worker.receive(initializeResponse(initialize));
    await flushPromises();
    plugin.setWorkspaceFiles([{ path: "src/other.ts", text: "export const other = 1;" }]);
    await flushPromises();

    const workspaceMessage = worker.sent
      .toReversed()
      .find(hasMethod("editor/typescript/setWorkspaceFiles"));
    expect(message(workspaceMessage).params).toEqual({
      files: [{ path: "src/other.ts", text: "export const other = 1;" }],
    });
  });

  it("ignores stale diagnostics for older document versions", async () => {
    const worker = new FakeWorker();
    const context = viewContributionContext(editorSnapshot());
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(context);
    if (!contribution) throw new Error("missing contribution");

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    contribution.update(
      editorSnapshot({ text: "const value: string = 2;", textVersion: 2 }),
      "content",
      documentChange([{ from: 22, to: 23, text: "2" }]),
    );

    worker.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///src/index.ts",
        version: 0,
        diagnostics: [
          {
            severity: 1,
            message: "stale",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
        ],
      },
    });

    expect(context.setRangeHighlight).not.toHaveBeenCalled();
  });

  it("renders hover quick info with diagnostics at the pointer", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const context = viewContributionContext(editorSnapshot());
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    provider.createContribution(context);

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    worker.receive(publishDiagnosticsMessage());

    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 12, clientY: 16, buttons: 0 }),
    );
    await vi.advanceTimersByTimeAsync(260);
    const hoverRequest = message(worker.sent.toReversed().find(hasMethod("textDocument/hover")));
    expect(hoverRequest.params).toMatchObject({
      textDocument: { uri: "file:///src/index.ts" },
      position: { line: 0, character: 22 },
    });

    worker.receive({
      jsonrpc: "2.0",
      id: hoverRequest.id,
      result: {
        contents: { kind: "markdown", value: "```ts\nconst value: string\n```" },
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
      },
    });
    await flushPromises();

    expect(document.body.textContent).toContain("const value: string");
    expect(document.body.textContent).toContain("bad assignment");
    expect(tooltipElement().querySelector("pre > code")?.textContent).toBe("const value: string");
    expect(tooltipElement().style.getPropertyValue("position-anchor")).toMatch(
      /^--editor-typescript-lsp-hover-/,
    );
    expect(tooltipElement().style.getPropertyValue("position-area")).toBe("top center");
    expect(tooltipElement().style.pointerEvents).toBe("auto");
    expect(tooltipElement().style.userSelect).toBe("text");
    expect(tooltipAnchorElement().style.display).toBe("block");
    expect(copyButton().textContent).toBe("");
    expect(copyButton().querySelector("svg")).not.toBeNull();
    expect(copyButton().getAttribute("aria-label")).toBe("Copy hover text");
    expect(copyButton().style.background).toBe("transparent");

    const hoverRequestCount = worker.sent.filter(hasMethod("textDocument/hover")).length;
    mockElementRect(tooltipElement(), new DOMRect(0, 0, 160, 72));
    mockElementRect(tooltipAnchorElement(), new DOMRect(12, 78, 40, 18));
    vi.mocked(context.textOffsetFromPoint).mockReturnValue(3);
    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 18, clientY: 76, buttons: 0 }),
    );
    await vi.advanceTimersByTimeAsync(260);
    expect(worker.sent.filter(hasMethod("textDocument/hover"))).toHaveLength(hoverRequestCount);

    copyButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("const value: string\n\nerror: bad assignment");
    expect(copyButton().getAttribute("aria-label")).toBe("Copied hover text");

    context.scrollElement.dispatchEvent(new PointerEvent("pointerleave"));
    tooltipElement().dispatchEvent(new PointerEvent("pointerenter"));
    await vi.advanceTimersByTimeAsync(190);
    expect(tooltipElement().hidden).toBe(false);

    tooltipElement().dispatchEvent(new PointerEvent("pointerleave"));
    await vi.advanceTimersByTimeAsync(190);
    expect(tooltipElement().hidden).toBe(true);
  });

  it("jumps to same-file definitions from the current selection", async () => {
    const worker = new FakeWorker();
    const context = viewContributionContext(
      editorSnapshot({
        selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
      }),
    );
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(context) as
      | (ReturnType<EditorViewContributionProvider["createContribution"]> & {
          goToDefinitionFromSelection(): boolean;
        })
      | null;
    if (!contribution) throw new Error("missing contribution");

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    expect(contribution.goToDefinitionFromSelection()).toBe(true);

    const definitionRequest = message(
      worker.sent.toReversed().find(hasMethod("textDocument/definition")),
    );
    worker.receive({
      jsonrpc: "2.0",
      id: definitionRequest.id,
      result: [
        {
          uri: "file:///src/index.ts",
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
        },
      ],
    });
    await flushPromises();

    expect(context.setSelection).toHaveBeenCalledWith(
      6,
      11,
      "typescriptLsp.goToDefinition",
      6,
    );
  });

  it("underlines jumpable symbols while hovering with a navigation modifier", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const context = viewContributionContext(
      editorSnapshot({ text: "const source = value; const value = 1;" }),
    );
    vi.mocked(context.textOffsetFromPoint).mockReturnValue(15);
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    provider.createContribution(context);

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 12,
        clientY: 16,
        ctrlKey: true,
      }),
    );

    const definitionRequest = message(
      worker.sent.toReversed().find(hasMethod("textDocument/definition")),
    );
    expect(definitionRequest.params).toMatchObject({
      textDocument: { uri: "file:///src/index.ts" },
      position: { line: 0, character: 15 },
    });

    worker.receive({
      jsonrpc: "2.0",
      id: definitionRequest.id,
      result: [
        {
          uri: "file:///src/index.ts",
          range: {
            start: { line: 0, character: 28 },
            end: { line: 0, character: 33 },
          },
        },
      ],
    });
    await flushPromises();

    expect(context.setRangeHighlight).toHaveBeenCalledWith(
      "editor-test-typescript-lsp-definition-link",
      [{ start: 15, end: 20 }],
      expect.objectContaining({
        color: "#60a5fa",
        textDecoration: expect.stringContaining("underline"),
      }),
    );
    expect(context.scrollElement.style.cursor).toBe("pointer");

    context.scrollElement.dispatchEvent(new PointerEvent("pointerleave"));
    expect(context.clearRangeHighlight).toHaveBeenCalledWith(
      "editor-test-typescript-lsp-definition-link",
    );
    expect(context.scrollElement.style.cursor).toBe("");
  });

  it("keeps hover tooltip working while hovering with a navigation modifier", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const context = viewContributionContext(
      editorSnapshot({ text: "const source = value; const value = 1;" }),
    );
    vi.mocked(context.textOffsetFromPoint).mockReturnValue(15);
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    provider.createContribution(context);

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 12,
        clientY: 16,
        ctrlKey: true,
      }),
    );

    expect(worker.sent.some(hasMethod("textDocument/definition"))).toBe(true);
    await vi.advanceTimersByTimeAsync(260);
    const hoverRequest = message(worker.sent.toReversed().find(hasMethod("textDocument/hover")));
    expect(hoverRequest.params).toMatchObject({
      textDocument: { uri: "file:///src/index.ts" },
      position: { line: 0, character: 15 },
    });

    worker.receive({
      jsonrpc: "2.0",
      id: hoverRequest.id,
      result: {
        contents: { kind: "markdown", value: "```ts\nconst value: number\n```" },
        range: {
          start: { line: 0, character: 15 },
          end: { line: 0, character: 20 },
        },
      },
    });
    await flushPromises();

    expect(tooltipElement().hidden).toBe(false);
    expect(tooltipElement().querySelector("pre > code")?.textContent).toBe("const value: number");
  });

  it("does not underline a symbol when its definition is the same range", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const context = viewContributionContext(editorSnapshot());
    vi.mocked(context.textOffsetFromPoint).mockReturnValue(6);
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    provider.createContribution(context);

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 12,
        clientY: 16,
        ctrlKey: true,
      }),
    );

    const definitionRequest = message(
      worker.sent.toReversed().find(hasMethod("textDocument/definition")),
    );
    worker.receive({
      jsonrpc: "2.0",
      id: definitionRequest.id,
      result: [
        {
          uri: "file:///src/index.ts",
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
        },
      ],
    });
    await flushPromises();

    expect(context.setRangeHighlight).not.toHaveBeenCalledWith(
      "editor-test-typescript-lsp-definition-link",
      expect.anything(),
      expect.anything(),
    );
    expect(context.clearRangeHighlight).toHaveBeenCalledWith(
      "editor-test-typescript-lsp-definition-link",
    );
    expect(context.scrollElement.style.cursor).toBe("");
  });

  it("reports cross-file definitions through the open callback", async () => {
    const worker = new FakeWorker();
    const openDefinition = vi.fn();
    const plugin = createTypeScriptLspPlugin({
      workerFactory: () => worker,
      onOpenDefinition: openDefinition,
    });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(
      viewContributionContext(
        editorSnapshot({
          selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
        }),
      ),
    ) as
      | (ReturnType<EditorViewContributionProvider["createContribution"]> & {
          goToDefinitionFromSelection(): boolean;
        })
      | null;
    if (!contribution) throw new Error("missing contribution");

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    expect(contribution.goToDefinitionFromSelection()).toBe(true);

    const definitionRequest = message(
      worker.sent.toReversed().find(hasMethod("textDocument/definition")),
    );
    worker.receive({
      jsonrpc: "2.0",
      id: definitionRequest.id,
      result: [
        {
          uri: "file:///src/other.ts",
          range: {
            start: { line: 1, character: 7 },
            end: { line: 1, character: 12 },
          },
        },
      ],
    });
    await flushPromises();

    expect(openDefinition).toHaveBeenCalledWith({
      uri: "file:///src/other.ts",
      path: "src/other.ts",
      range: {
        start: { line: 1, character: 7 },
        end: { line: 1, character: 12 },
      },
    });
  });
});

function activatePlugin(
  plugin: ReturnType<typeof createTypeScriptLspPlugin>,
): EditorViewContributionProvider {
  let provider: EditorViewContributionProvider | null = null;
  plugin.activate({
    registerHighlighter: () => ({ dispose: () => undefined }),
    registerSyntaxProvider: () => ({ dispose: () => undefined }),
    registerViewContribution: (value) => {
      provider = value;
      return { dispose: () => undefined };
    },
    registerEditorFeatureContribution: () => ({ dispose: () => undefined }),
    registerGutterContribution: () => ({ dispose: () => undefined }),
  } satisfies EditorPluginContext);

  if (!provider) throw new Error("missing provider");
  return provider;
}

function viewContributionContext(snapshot: EditorViewSnapshot): EditorViewContributionContext {
  const element = document.createElement("div");
  return {
    container: element,
    scrollElement: element,
    highlightPrefix: "editor-test",
    getSnapshot: () => snapshot,
    revealLine: vi.fn(),
    focusEditor: vi.fn(),
    setSelection: vi.fn(),
    setScrollTop: vi.fn(),
    reserveOverlayWidth: vi.fn(),
    textOffsetFromPoint: vi.fn(() => 22),
    getRangeClientRect: vi.fn(() => new DOMRect(10, 20, 40, 18)),
    setRangeHighlight: vi.fn(),
    clearRangeHighlight: vi.fn(),
  };
}

function editorSnapshot(options: Partial<EditorViewSnapshot> = {}): EditorViewSnapshot {
  const text = options.text ?? "const value: string = 1;";
  return {
    documentId: "src/index.ts",
    languageId: "typescript",
    text,
    textVersion: 1,
    lineStarts: [0],
    tokens: [],
    selections: [],
    metrics: {} as EditorViewSnapshot["metrics"],
    lineCount: 1,
    contentWidth: 0,
    totalHeight: 0,
    tabSize: 4,
    foldMarkers: [],
    visibleRows: [],
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 0,
      scrollWidth: 0,
      clientHeight: 0,
      clientWidth: 0,
      visibleRange: { start: 0, end: 1 } as EditorViewSnapshot["viewport"]["visibleRange"],
    },
    ...options,
  };
}

function documentChange(edits: readonly TextEdit[]): DocumentSessionChange {
  return {
    kind: "edit",
    edits,
    text: "",
    tokens: [],
    timings: [],
    canUndo: false,
    canRedo: false,
  } as unknown as DocumentSessionChange;
}

function initializeResponse(request: JsonMessage): JsonMessage {
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: 2,
        },
      },
    },
  };
}

function publishDiagnosticsMessage(): JsonMessage {
  return {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri: "file:///src/index.ts",
      version: 0,
      diagnostics: [
        {
          severity: 1,
          source: "typescript",
          message: "bad assignment",
          range: {
            start: { line: 0, character: 22 },
            end: { line: 0, character: 23 },
          },
        },
      ],
    },
  };
}

function sentMethods(worker: FakeWorker): readonly unknown[] {
  return worker.sent.map((item) => message(item).method);
}

function textDocumentFor(item: unknown): unknown {
  const params = message(item).params as { readonly textDocument: unknown };
  return params.textDocument;
}

function tooltipElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".editor-typescript-lsp-hover");
  if (!element) throw new Error("missing tooltip");
  return element;
}

function tooltipAnchorElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".editor-typescript-lsp-hover-anchor");
  if (!element) throw new Error("missing tooltip anchor");
  return element;
}

function copyButton(): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(".editor-typescript-lsp-hover-copy");
  if (!element) throw new Error("missing copy button");
  return element;
}

function mockElementRect(element: HTMLElement, rect: DOMRect): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
}

function message(item: unknown): JsonMessage {
  if (!isRecord(item)) throw new Error("missing message");
  return item;
}

function hasMethod(method: string): (item: unknown) => boolean {
  return (item) => message(item).method === method;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
