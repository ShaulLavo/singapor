import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@editor/core";
import { createEditor, type SolidEditorController, type SolidEditorDocument } from "../src";

class MockHighlight extends Set<Range> {}

type MountedEditor = {
  readonly controller: SolidEditorController;
  readonly host: HTMLElement;
  dispose(): void;
};

beforeEach(() => {
  // @ts-expect-error happy-dom does not provide Highlight.
  globalThis.Highlight = MockHighlight;
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "Highlight");
});

describe("createEditor", () => {
  it("mounts, initializes signals, and disposes with the Solid owner", () => {
    const mounted = mountInRoot({
      document: () => ({ text: "alpha", documentId: "a.ts", revision: 1 }),
    });

    expect(mounted.controller.editor()).not.toBeNull();
    expect(mounted.controller.text()).toBe("alpha");
    expect(mounted.controller.state()?.length).toBe(5);
    expect(mounted.controller.snapshot()?.text).toBe("alpha");

    mounted.dispose();

    expect(mounted.controller.editor()).toBeNull();
    expect(mounted.controller.state()).toBeNull();
    expect(mounted.controller.snapshot()).toBeNull();
    expect(mounted.controller.text()).toBe("");
  });

  it("syncs state and last change after editor commands", () => {
    const mounted = mountInRoot({
      document: () => ({ text: "alpha", documentId: "a.ts", revision: 1 }),
    });

    mounted.controller.commands.edit({ from: 5, to: 5, text: "!" });

    expect(mounted.controller.text()).toBe("alpha!");
    expect(mounted.controller.state()?.length).toBe(6);
    expect(mounted.controller.lastChange()?.kind).toBe("edit");
    expect(mounted.controller.snapshot()?.text).toBe("alpha!");

    mounted.dispose();
  });

  it("syncs full view snapshots on selection updates", () => {
    const mounted = mountInRoot({
      document: () => ({ text: "alpha", documentId: "a.ts", revision: 1 }),
    });

    mounted.controller.commands.setSelection(1, 4);

    expect(mounted.controller.updateKind()).toBe("selection");
    expect(mounted.controller.snapshot()?.selections[0]).toMatchObject({
      anchorOffset: 1,
      headOffset: 4,
      startOffset: 1,
      endOffset: 4,
    });

    mounted.dispose();
  });

  it("does not clobber local edits until document identity or revision changes", async () => {
    let setDocument!: (document: SolidEditorDocument) => void;
    const mounted = mountInRoot(() => {
      const [document, nextDocument] = createSignal<SolidEditorDocument>({
        text: "alpha",
        documentId: "a.ts",
        revision: 1,
      });
      setDocument = nextDocument;
      return createEditor({ document });
    });

    mounted.controller.commands.edit({ from: 5, to: 5, text: "!" });
    setDocument({ text: "server alpha", documentId: "a.ts", revision: 1 });
    await flushEffects();

    expect(mounted.controller.text()).toBe("alpha!");

    setDocument({ text: "server beta", documentId: "a.ts", revision: 2 });
    await flushEffects();

    expect(mounted.controller.text()).toBe("server beta");
    expect(mounted.controller.snapshot()?.documentId).toBe("a.ts");

    mounted.dispose();
  });

  it("applies targeted reactive options without recreating the editor", async () => {
    let setTheme!: (theme: { readonly backgroundColor: string }) => void;
    let setHiddenCharacters!: (mode: "hidden" | "show") => void;
    let setSelection!: (selection: { readonly anchor: number; readonly head: number }) => void;
    let setScrollPosition!: (scrollPosition: {
      readonly top: number;
      readonly left: number;
    }) => void;
    const mounted = mountInRoot(() => {
      const [theme, nextTheme] = createSignal({ backgroundColor: "#111111" });
      const [hiddenCharacters, nextHiddenCharacters] = createSignal<"hidden" | "show">("hidden");
      const [selection, nextSelection] = createSignal({ anchor: 0, head: 0 });
      const [scrollPosition, nextScrollPosition] = createSignal({ top: 0, left: 0 });
      setTheme = nextTheme;
      setHiddenCharacters = nextHiddenCharacters;
      setSelection = nextSelection;
      setScrollPosition = nextScrollPosition;
      return createEditor({
        document: () => ({ text: "alpha", documentId: "a.ts", revision: 1 }),
        hiddenCharacters,
        scrollPosition,
        selection,
        theme,
      });
    });
    const instance = mounted.controller.editor();
    expect(instance).not.toBeNull();
    const setHiddenSpy = vi.spyOn(instance as Editor, "setHiddenCharacters");

    setTheme({ backgroundColor: "#222222" });
    setHiddenCharacters("show");
    setSelection({ anchor: 1, head: 3 });
    setScrollPosition({ top: 12, left: 4 });
    await flushEffects();

    expect(mounted.controller.editor()).toBe(instance);
    expect(editorElement(mounted.host)?.style.getPropertyValue("--editor-background")).toBe(
      "#222222",
    );
    expect(setHiddenSpy).toHaveBeenCalledWith("show");
    expect(mounted.controller.snapshot()?.selections[0]).toMatchObject({
      anchorOffset: 1,
      headOffset: 3,
    });
    expect(instance?.getScrollPosition()).toEqual({ top: 12, left: 4 });

    mounted.dispose();
  });

  it("exports a command facade that safely handles missing editor instances", () => {
    let controller!: SolidEditorController;
    createRoot((dispose) => {
      controller = createEditor();
      dispose();
    });

    expect(controller.commands.dispatchCommand("selectAll")).toBe(false);
    expect(controller.commands.openFind()).toBe(false);
    expect(() => controller.commands.focus()).not.toThrow();
  });
});

function mountInRoot(
  create: Parameters<typeof createEditor>[0] | (() => SolidEditorController),
): MountedEditor {
  let controller!: SolidEditorController;
  let disposeRoot!: () => void;
  const host = document.createElement("div");

  createRoot((dispose) => {
    disposeRoot = dispose;
    controller = typeof create === "function" ? create() : createEditor(create);
    controller.mount(host);
  });

  return {
    controller,
    host,
    dispose: disposeRoot,
  };
}

function editorElement(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(".editor");
}

function flushEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
