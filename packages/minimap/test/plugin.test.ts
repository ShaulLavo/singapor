import { describe, expect, it, vi } from "vitest";
import type {
  EditorPluginContext,
  EditorViewContributionProvider,
  EditorViewContributionContext,
  EditorViewSnapshot,
} from "@editor/core";
import { createMinimapPlugin } from "../src/plugin";

describe("createMinimapPlugin", () => {
  it("registers a view contribution factory", () => {
    const registerViewContribution = vi.fn<EditorPluginContext["registerViewContribution"]>(() => ({
      dispose: vi.fn(),
    }));
    const plugin = createMinimapPlugin({ enabled: false });

    const disposable = plugin.activate({
      registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
      registerTreeSitterLanguage: vi.fn(() => ({ dispose: vi.fn() })),
      registerViewContribution,
      registerEditorFeatureContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
    });

    expect(plugin.name).toBe("minimap");
    expect(disposable).toBeDefined();
    expect(registerViewContribution).toHaveBeenCalledOnce();
  });

  it("returns no contribution when disabled", () => {
    let registration: EditorViewContributionProvider | undefined;
    const registerViewContribution: EditorPluginContext["registerViewContribution"] = (
      provider,
    ) => {
      registration = provider;
      return { dispose: vi.fn() };
    };
    const plugin = createMinimapPlugin({ enabled: false });

    plugin.activate({
      registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
      registerTreeSitterLanguage: vi.fn(() => ({ dispose: vi.fn() })),
      registerViewContribution,
      registerEditorFeatureContribution: vi.fn(() => ({ dispose: vi.fn() })),
      registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
    });

    expect(registration?.createContribution(context())).toBeNull();
  });

  it("uses viewport border-box metrics for native scrollbar gutters", () => {
    const restoreRuntime = installMinimapRuntime();
    try {
      let registration: EditorViewContributionProvider | undefined;
      const registerViewContribution: EditorPluginContext["registerViewContribution"] = (
        provider,
      ) => {
        registration = provider;
        return { dispose: vi.fn() };
      };
      const plugin = createMinimapPlugin({ enabled: true });

      plugin.activate({
        registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
        registerTreeSitterLanguage: vi.fn(() => ({ dispose: vi.fn() })),
        registerViewContribution,
        registerEditorFeatureContribution: vi.fn(() => ({ dispose: vi.fn() })),
        registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
      });

      const snapshotWithScrollbar = snapshot({
        borderBoxWidth: 110,
        clientHeight: 20,
        clientWidth: 80,
        scrollHeight: 80,
        scrollWidth: 80,
      });
      const testContext = context(snapshotWithScrollbar);
      defineThrowingLayoutProperty(testContext.scrollElement, "offsetHeight");
      defineThrowingLayoutProperty(testContext.scrollElement, "offsetWidth");

      const contribution = registration?.createContribution(testContext);
      const host = testContext.container.querySelector<HTMLElement>(".editor-minimap-right");

      expect(contribution).not.toBeNull();
      expect(host?.style.right).toBe("30px");
      expect(testContext.reserveOverlayWidth).toHaveBeenCalledWith("right", 30);

      vi.mocked(testContext.reserveOverlayWidth).mockClear();
      contribution?.update(snapshotWithScrollbar, "viewport");
      expect(testContext.reserveOverlayWidth).not.toHaveBeenCalled();

      const getComputedStyle = vi.spyOn(window, "getComputedStyle");
      contribution?.update(
        snapshot({
          borderBoxWidth: 112,
          clientHeight: 20,
          clientWidth: 80,
          scrollHeight: 80,
          scrollWidth: 80,
        }),
        "viewport",
      );

      expect(getComputedStyle).not.toHaveBeenCalled();
      getComputedStyle.mockRestore();

      contribution?.dispose();
    } finally {
      restoreRuntime();
    }
  });
});

function context(viewSnapshot = snapshot()): EditorViewContributionContext {
  const container = document.createElement("div");
  const scrollElement = document.createElement("div");
  container.appendChild(scrollElement);
  return {
    container,
    scrollElement,
    getSnapshot: () => viewSnapshot,
    reserveOverlayWidth: vi.fn(),
    revealLine: vi.fn(),
    focusEditor: vi.fn(),
    setSelection: vi.fn(),
    setScrollTop: vi.fn(),
    textOffsetFromPoint: vi.fn(() => null),
    getRangeClientRect: vi.fn(() => null),
  };
}

function snapshot(viewport: Partial<EditorViewSnapshot["viewport"]> = {}): EditorViewSnapshot {
  return {
    documentId: "minimap-test",
    languageId: "typescript",
    text: "",
    textVersion: 1,
    lineStarts: [0],
    tokens: [],
    selections: [],
    metrics: { rowHeight: 20, characterWidth: 8 },
    lineCount: 1,
    contentWidth: 0,
    totalHeight: 20,
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 20,
      scrollWidth: 0,
      clientHeight: 20,
      clientWidth: 80,
      borderBoxHeight: 20,
      borderBoxWidth: 80,
      visibleRange: { start: 0, end: 1 },
      ...viewport,
    },
  };
}

function installMinimapRuntime(): () => void {
  const worker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const offscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
  const transferControlToOffscreen = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "transferControlToOffscreen",
  );

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: MockWorker,
  });
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    value: class MockOffscreenCanvas {},
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "transferControlToOffscreen", {
    configurable: true,
    value: () => ({}),
  });

  return () => {
    restoreDescriptor(globalThis, "Worker", worker);
    restoreDescriptor(globalThis, "OffscreenCanvas", offscreenCanvas);
    restoreDescriptor(
      HTMLCanvasElement.prototype,
      "transferControlToOffscreen",
      transferControlToOffscreen,
    );
  };
}

class MockWorker {
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public postMessage = vi.fn();
  public terminate = vi.fn();

  public constructor(_url: URL, _options?: WorkerOptions) {}
}

function defineThrowingLayoutProperty(
  element: HTMLElement,
  property: "offsetHeight" | "offsetWidth",
): void {
  Object.defineProperty(element, property, {
    configurable: true,
    get: () => {
      throw new Error(`unexpected ${property} read`);
    },
  });
}

function restoreDescriptor(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }

  Reflect.deleteProperty(target, property);
}
