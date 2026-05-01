import { describe, expect, it } from "vitest";

import {
  createWebSocketLspTransport,
  createWorkerLspTransport,
  type LspTransportHandler,
  type LspWebSocketLike,
  type LspWorkerLike,
} from "../src/index.ts";

type Listener = (event: Event) => void;

class FakeWebSocket implements LspWebSocketLike {
  public static readonly instances: FakeWebSocket[] = [];
  public readonly sent: string[] = [];
  public readyState = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  public constructor(
    public readonly url: string | URL,
    public readonly protocols?: string | readonly string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  public send(message: string): void {
    this.sent.push(message);
  }

  public close(): void {
    this.readyState = 3;
    this.emit("close");
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

  public receive(message: string): void {
    this.emit("message", message);
  }

  public listenerCount(type: string): number {
    return this.listenersFor(type).size;
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

class FakeWorker implements LspWorkerLike {
  public readonly sent: unknown[] = [];
  public terminated = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  public postMessage(message: unknown): void {
    this.sent.push(message);
  }

  public addEventListener(type: string, handler: Listener): void {
    this.listenersFor(type).add(handler);
  }

  public removeEventListener(type: string, handler: Listener): void {
    this.listenersFor(type).delete(handler);
  }

  public terminate(): void {
    this.terminated = true;
  }

  public receive(message: unknown): void {
    const event = new MessageEvent("message", { data: message });
    for (const listener of this.listenersFor("message")) listener(event);
  }

  public listenerCount(type: string): number {
    return this.listenersFor(type).size;
  }

  private listenersFor(type: string): Set<Listener> {
    let listeners = this.listeners.get(type);
    if (listeners) return listeners;

    listeners = new Set();
    this.listeners.set(type, listeners);
    return listeners;
  }
}

describe("WebSocket LSP transport", () => {
  it("waits for the socket to open, then sends and receives JSON strings", async () => {
    FakeWebSocket.instances.length = 0;
    const promise = createWebSocketLspTransport("ws://localhost:3000", {
      WebSocketCtor: FakeWebSocket,
      protocols: "lsp",
    });
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("missing socket");

    socket.open();
    const transport = await promise;
    const received: string[] = [];
    transport.subscribe((message) => received.push(message));

    transport.send('{"method":"initialize"}');
    socket.receive('{"result":true}');

    expect(socket.url).toBe("ws://localhost:3000");
    expect(socket.protocols).toBe("lsp");
    expect(socket.sent).toEqual(['{"method":"initialize"}']);
    expect(received).toEqual(['{"result":true}']);
  });

  it("removes listeners and closes the socket", async () => {
    FakeWebSocket.instances.length = 0;
    const promise = createWebSocketLspTransport("ws://localhost:3000", {
      WebSocketCtor: FakeWebSocket,
    });
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("missing socket");

    socket.open();
    const transport = await promise;
    const handler: LspTransportHandler = () => undefined;
    transport.subscribe(handler);
    transport.close();

    expect(socket.readyState).toBe(3);
    expect(socket.listenerCount("message")).toBe(0);
  });
});

describe("Worker LSP transport", () => {
  it("sends and receives JSON strings by default", () => {
    const worker = new FakeWorker();
    const transport = createWorkerLspTransport(worker);
    const received: string[] = [];
    transport.subscribe((message) => received.push(message));

    transport.send('{"method":"initialize"}');
    worker.receive('{"result":true}');

    expect(worker.sent).toEqual(['{"method":"initialize"}']);
    expect(received).toEqual(['{"result":true}']);
  });

  it("can post structured JSON messages for worker servers", () => {
    const worker = new FakeWorker();
    const transport = createWorkerLspTransport(worker, { messageFormat: "json" });
    const received: string[] = [];
    transport.subscribe((message) => received.push(message));

    transport.send('{"method":"initialize","params":{}}');
    worker.receive({ result: true });

    expect(worker.sent).toEqual([{ method: "initialize", params: {} }]);
    expect(received).toEqual(['{"result":true}']);
  });

  it("can terminate an owned worker on close", () => {
    const worker = new FakeWorker();
    const transport = createWorkerLspTransport(worker, { terminateOnClose: true });

    transport.close();

    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.terminated).toBe(true);
  });
});
