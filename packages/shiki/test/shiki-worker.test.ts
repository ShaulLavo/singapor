import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShikiWorkerRequest, ShikiWorkerResponse } from "../src/workerTypes";

const createHighlighter = vi.hoisted(() => vi.fn());
const createIncrementalTokenizer = vi.hoisted(() => vi.fn());

vi.mock("shiki", () => ({ createHighlighter }));
vi.mock("../src/tokenizer", () => ({ createIncrementalTokenizer }));

describe("shiki worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    createHighlighter.mockReset();
    createIncrementalTokenizer.mockReset();
    delete (globalThis as { self?: unknown }).self;
  });

  it("serializes thrown errors into failed worker responses", async () => {
    const postMessage = vi.fn();
    (globalThis as { self?: unknown }).self = { postMessage };
    createHighlighter.mockRejectedValue(new Error("load failed"));
    await import("../src/shiki.worker");

    const onmessage = (globalThis as { self: { onmessage: (event: MessageEvent) => void } }).self
      .onmessage;
    onmessage(
      new MessageEvent("message", {
        data: request("open", {
          documentId: "doc",
          text: "const value = 1;",
          lang: "typescript",
          theme: "github-dark",
          langs: [],
          themes: [],
        }),
      }),
    );
    await waitFor(() => postMessage.mock.calls.length > 0);

    expect(postMessage).toHaveBeenCalledWith({
      id: 1,
      ok: false,
      error: "load failed",
    } satisfies ShikiWorkerResponse);
  });

  it("disposes cached highlighters on disposeAll", async () => {
    const dispose = vi.fn();
    const postMessage = vi.fn();
    (globalThis as { self?: unknown }).self = { postMessage };
    createHighlighter.mockResolvedValue({ dispose });
    createIncrementalTokenizer.mockResolvedValue({
      tokenizer: { getSnapshot: () => ({ lines: [] }) },
    });
    await import("../src/shiki.worker");

    const onmessage = (globalThis as { self: { onmessage: (event: MessageEvent) => void } }).self
      .onmessage;
    onmessage(
      new MessageEvent("message", {
        data: request("open", {
          documentId: "doc",
          text: "",
          lang: "typescript",
          theme: "github-dark",
          langs: [],
          themes: [],
        }),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    onmessage(new MessageEvent("message", { data: request("dispose", {}) }));
    await Promise.resolve();
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("returns editor theme colors from the loaded Shiki theme", async () => {
    const postMessage = vi.fn();
    const getTheme = vi.fn(() => ({
      bg: "#ffffff",
      fg: "#24292e",
      colors: {
        "editorCursor.foreground": "#044289",
        "editorLineNumber.foreground": "#6e7781",
      },
    }));
    (globalThis as { self?: unknown }).self = { postMessage };
    createHighlighter.mockResolvedValue({ getTheme });
    createIncrementalTokenizer.mockResolvedValue({
      tokenizer: { getSnapshot: () => ({ lines: [] }) },
    });
    await import("../src/shiki.worker");

    const onmessage = (globalThis as { self: { onmessage: (event: MessageEvent) => void } }).self
      .onmessage;
    onmessage(
      new MessageEvent("message", {
        data: request("open", {
          documentId: "doc",
          text: "",
          lang: "typescript",
          theme: "github-light",
          langs: [],
          themes: [],
        }),
      }),
    );
    await waitFor(() => postMessage.mock.calls.length > 0);

    expect(postMessage).toHaveBeenCalledWith({
      id: 1,
      ok: true,
      result: {
        documentId: "doc",
        tokens: [],
        theme: {
          backgroundColor: "#ffffff",
          foregroundColor: "#24292e",
          gutterBackgroundColor: "#ffffff",
          gutterForegroundColor: "#6e7781",
          caretColor: "#044289",
          minimapBackgroundColor: "#ffffff",
        },
      },
    } satisfies ShikiWorkerResponse);
  });
});

function request(
  type: ShikiWorkerRequest["payload"]["type"],
  payload: Omit<ShikiWorkerRequest["payload"], "type">,
): ShikiWorkerRequest {
  return { id: 1, payload: { type, ...payload } as ShikiWorkerRequest["payload"] };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for worker response");
}
