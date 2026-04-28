import { afterEach, describe, expect, it, vi } from "vitest";
import type { MinimapWorkerRequest, MinimapWorkerResponse } from "../src/types";

describe("minimap worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    globalThis.onmessage = null;
  });

  it("routes renderer errors to error responses", async () => {
    const postMessage = vi.spyOn(globalThis, "postMessage").mockImplementation(() => undefined);
    await import("../src/minimap.worker");

    const onmessage = globalThis.onmessage as ((event: MessageEvent) => void) | null;
    onmessage?.(
      new MessageEvent("message", {
        data: {
          type: "init",
          mainCanvas: { getContext: () => null } as unknown as OffscreenCanvas,
          decorationsCanvas: { getContext: () => null } as unknown as OffscreenCanvas,
          options: { enabled: true },
          baseStyles: {},
        } as MinimapWorkerRequest,
      }),
    );

    expect(postMessage).toHaveBeenCalledWith({
      type: "error",
      message: "Unable to create minimap canvas context",
    } satisfies MinimapWorkerResponse);
  });

  it("does not post a render response before initialization", async () => {
    const postMessage = vi.spyOn(globalThis, "postMessage").mockImplementation(() => undefined);
    await import("../src/minimap.worker");

    const onmessage = globalThis.onmessage as ((event: MessageEvent) => void) | null;
    onmessage?.(
      new MessageEvent("message", {
        data: { type: "render", sequence: 7 } as MinimapWorkerRequest,
      }),
    );

    expect(postMessage).not.toHaveBeenCalled();
  });
});
