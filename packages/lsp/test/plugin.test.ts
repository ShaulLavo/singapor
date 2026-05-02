import type {
  DocumentSessionChange,
  EditorPluginContext,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewSnapshot,
  TextEdit,
} from "@editor/core";
import { describe, expect, it } from "vitest";

import { createLspPlugin, type LspWebSocketLike } from "../src/index.ts";

type JsonMessage = Record<string, unknown>;
type Listener = (event: Event) => void;

class FakeWebSocket implements LspWebSocketLike {
  public static readonly instances: FakeWebSocket[] = [];
  public readonly sent: string[] = [];
  public readyState = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  public constructor(public readonly url: string | URL) {
    FakeWebSocket.instances.push(this);
  }

  public send(message: string): void {
    this.sent.push(message);
  }

  public close(): void {
    this.readyState = 3;
  }

  public addEventListener(type: string, handler: Listener): void {
    this.listenersFor(type).add(handler);
  }

  public removeEventListener(type: string, handler: Listener): void {
    this.listenersFor(type).delete(handler);
  }

  public open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  public receive(message: JsonMessage): void {
    this.emit("message", JSON.stringify(message));
  }

  private emit(type: string, data?: unknown): void {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data });
    for (const listener of this.listenersFor(type)) listener(event);
  }

  private listenersFor(type: string): Set<Listener> {
    let listeners = this.listeners.get(type);
    if (listeners) return listeners;

    listeners = new Set();
    this.listeners.set(type, listeners);
    return listeners;
  }
}

describe("createLspPlugin", () => {
  it("connects to a WebSocket route and syncs the active editor document", async () => {
    FakeWebSocket.instances.length = 0;
    const statuses: string[] = [];
    const plugin = createLspPlugin({
      route: "/lsp",
      rootUri: "file:///repo",
      transportOptions: { WebSocketCtor: FakeWebSocket },
      onStatusChange: (status) => statuses.push(status),
    });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(viewContributionContext(editorSnapshot()));
    if (!contribution) throw new Error("missing contribution");

    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("missing socket");

    socket.open();
    await flushPromises();
    const initialize = jsonMessage(socket.sent[0]);
    socket.receive(initializeResponse(initialize, { textDocumentSync: 2 }));
    await flushPromises();

    expect(sentMethods(socket)).toEqual(["initialize", "initialized", "textDocument/didOpen"]);
    expect(textDocumentFor(socket.sent[2])).toEqual({
      uri: "file:///src/main.ts",
      languageId: "typescript",
      version: 0,
      text: "let a = 1;",
    });

    contribution.update(
      editorSnapshot({ text: "let aa = 1;", textVersion: 2 }),
      "content",
      documentChange([{ from: 4, to: 5, text: "aa" }]),
    );

    expect(sentMethods(socket)).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/didChange",
    ]);
    expect(contentChangesFor(socket.sent[3])).toEqual([
      {
        range: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 5 },
        },
        text: "aa",
      },
    ]);

    contribution.update(editorSnapshot({ documentId: null, text: "", textVersion: 3 }), "clear");

    expect(sentMethods(socket)).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/didChange",
      "textDocument/didClose",
    ]);
    expect(statuses).toContain("connecting");
    expect(statuses).toContain("ready");
  });
});

function activatePlugin(
  plugin: ReturnType<typeof createLspPlugin>,
): EditorViewContributionProvider {
  let provider: EditorViewContributionProvider | null = null;
  plugin.activate({
    registerViewContribution: (value) => {
      provider = value;
      return { dispose: () => undefined };
    },
    registerHighlighter: () => ({ dispose: () => undefined }),
    registerSyntaxProvider: () => ({ dispose: () => undefined }),
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
    getSnapshot: () => snapshot,
    revealLine: () => undefined,
    focusEditor: () => undefined,
    setSelection: () => undefined,
    setScrollTop: () => undefined,
    reserveOverlayWidth: () => undefined,
    textOffsetFromPoint: () => null,
    getRangeClientRect: () => null,
  };
}

function editorSnapshot(options: Partial<EditorViewSnapshot> = {}): EditorViewSnapshot {
  const text = options.text ?? "let a = 1;";
  return {
    documentId: "src/main.ts",
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

function initializeResponse(request: JsonMessage, capabilities: JsonMessage): JsonMessage {
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: { capabilities },
  };
}

function sentMethods(socket: FakeWebSocket): readonly unknown[] {
  return socket.sent.map((message) => jsonMessage(message).method);
}

function textDocumentFor(message: string | undefined): unknown {
  const params = jsonMessage(message).params as { readonly textDocument: unknown };
  return params.textDocument;
}

function contentChangesFor(message: string | undefined): unknown {
  const params = jsonMessage(message).params as { readonly contentChanges: unknown };
  return params.contentChanges;
}

function jsonMessage(message: string | undefined): JsonMessage {
  if (!message) throw new Error("missing message");
  return JSON.parse(message) as JsonMessage;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
