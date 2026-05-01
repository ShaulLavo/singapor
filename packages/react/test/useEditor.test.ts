import type { Editor, EditorResolvedSelection } from "@editor/core";
import { act, createElement, useLayoutEffect, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EditorHost,
  useEditor,
  useEditorSelector,
  type ReactEditorController,
  type ReactEditorOptions,
} from "../src";

class MockHighlight extends Set<Range> {}

type MountedEditor = {
  readonly controller: ReactEditorController;
  readonly host: HTMLElement;
  render(options: ReactEditorOptions): void;
  dispose(): void;
};

type ActEnvironment = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const EMPTY_SELECTIONS: readonly EditorResolvedSelection[] = [];

beforeEach(() => {
  (globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT = true;
  // @ts-expect-error happy-dom does not provide Highlight.
  globalThis.Highlight = MockHighlight;
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "Highlight");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  document.body.replaceChildren();
});

describe("useEditor", () => {
  it("mounts, initializes the store, and disposes with the React tree", () => {
    const mounted = mountReactEditor({
      document: { text: "alpha", documentId: "a.ts", revision: 1 },
    });

    expect(mounted.controller.getEditor()).not.toBeNull();
    expect(mounted.controller.getText()).toBe("alpha");
    expect(mounted.controller.getState()?.length).toBe(5);
    expect(mounted.controller.getSnapshot()?.text).toBe("alpha");

    mounted.dispose();

    expect(mounted.controller.getEditor()).toBeNull();
    expect(mounted.controller.getState()).toBeNull();
    expect(mounted.controller.getSnapshot()).toBeNull();
    expect(mounted.controller.getText()).toBe("");
  });

  it("syncs state and last change after editor commands", () => {
    const mounted = mountReactEditor({
      document: { text: "alpha", documentId: "a.ts", revision: 1 },
    });

    act(() => mounted.controller.commands.edit({ from: 5, to: 5, text: "!" }));

    expect(mounted.controller.getText()).toBe("alpha!");
    expect(mounted.controller.getState()?.length).toBe(6);
    expect(mounted.controller.getLastChange()?.kind).toBe("edit");
    expect(mounted.controller.getSnapshot()?.text).toBe("alpha!");

    mounted.dispose();
  });

  it("syncs full view snapshots on selection updates", () => {
    const mounted = mountReactEditor({
      document: { text: "alpha", documentId: "a.ts", revision: 1 },
    });

    act(() => mounted.controller.commands.setSelection(1, 4));

    expect(mounted.controller.getUpdateKind()).toBe("selection");
    expect(mounted.controller.getSnapshot()?.selections[0]).toMatchObject({
      anchorOffset: 1,
      headOffset: 4,
      startOffset: 1,
      endOffset: 4,
    });

    mounted.dispose();
  });

  it("does not clobber local edits until document identity or revision changes", () => {
    const mounted = mountReactEditor({
      document: { text: "alpha", documentId: "a.ts", revision: 1 },
    });

    act(() => mounted.controller.commands.edit({ from: 5, to: 5, text: "!" }));
    mounted.render({
      document: { text: "server alpha", documentId: "a.ts", revision: 1 },
    });

    expect(mounted.controller.getText()).toBe("alpha!");

    mounted.render({
      document: { text: "server beta", documentId: "a.ts", revision: 2 },
    });

    expect(mounted.controller.getText()).toBe("server beta");
    expect(mounted.controller.getSnapshot()?.documentId).toBe("a.ts");

    mounted.dispose();
  });

  it("applies targeted reactive options without recreating the editor", () => {
    const mounted = mountReactEditor({
      document: { text: "alpha", documentId: "a.ts", revision: 1 },
      hiddenCharacters: "hidden",
      scrollPosition: { top: 0, left: 0 },
      selection: { anchor: 0, head: 0 },
      theme: { backgroundColor: "#111111" },
    });
    const instance = mounted.controller.getEditor();

    expect(instance).not.toBeNull();

    const setHiddenSpy = vi.spyOn(instance as Editor, "setHiddenCharacters");
    mounted.render({
      document: { text: "alpha", documentId: "a.ts", revision: 1 },
      hiddenCharacters: "show",
      scrollPosition: { top: 12, left: 4 },
      selection: { anchor: 1, head: 3 },
      theme: { backgroundColor: "#222222" },
    });

    expect(mounted.controller.getEditor()).toBe(instance);
    expect(editorElement(mounted.host)?.style.getPropertyValue("--editor-background")).toBe(
      "#222222",
    );
    expect(setHiddenSpy).toHaveBeenCalledWith("show");
    expect(mounted.controller.getSnapshot()?.selections[0]).toMatchObject({
      anchorOffset: 1,
      headOffset: 3,
    });
    expect(instance?.getScrollPosition()).toEqual({ top: 12, left: 4 });

    mounted.dispose();
  });

  it("exports a command facade that safely handles missing editor instances", () => {
    const mounted = mountReactEditor();
    const { controller } = mounted;

    mounted.dispose();

    expect(controller.commands.dispatchCommand("selectAll")).toBe(false);
    expect(controller.commands.openFind()).toBe(false);
    expect(() => controller.commands.focus()).not.toThrow();
  });

  it("only rerenders selector subscribers whose selected value changes", () => {
    const renders = {
      text: 0,
      length: 0,
      selections: 0,
    };
    let controller!: ReactEditorController;
    const host = document.createElement("div");
    const root = createRoot(host);
    document.body.append(host);

    act(() => {
      root.render(
        createElement(FineGrainedHarness, {
          onController: (nextController) => {
            controller = nextController;
          },
          renders,
        }),
      );
    });

    const mountedRenders = { ...renders };

    act(() => controller.commands.setSelection(1, 4));

    expect(renders.text).toBe(mountedRenders.text);
    expect(renders.length).toBe(mountedRenders.length);
    expect(renders.selections).toBe(mountedRenders.selections + 1);

    const selectionRenders = { ...renders };

    act(() => controller.commands.edit({ from: 5, to: 5, text: "!" }));

    expect(renders.text).toBe(selectionRenders.text + 1);
    expect(renders.length).toBe(selectionRenders.length + 1);
    expect(renders.selections).toBe(selectionRenders.selections);

    act(() => root.unmount());
    host.remove();
  });
});

function ReactEditorHarness({
  options,
  onController,
}: {
  readonly options: ReactEditorOptions;
  readonly onController: (controller: ReactEditorController) => void;
}): ReactElement {
  const controller = useEditor(options);

  useLayoutEffect(() => {
    onController(controller);
  }, [controller, onController]);

  return createElement(EditorHost, { controller });
}

function FineGrainedHarness({
  onController,
  renders,
}: {
  readonly onController: (controller: ReactEditorController) => void;
  readonly renders: { text: number; length: number; selections: number };
}): ReactElement {
  const controller = useEditor({
    document: { text: "alpha", documentId: "a.ts", revision: 1 },
  });

  useLayoutEffect(() => {
    onController(controller);
  }, [controller, onController]);

  return createElement(
    "div",
    null,
    createElement(EditorHost, { controller }),
    createElement(TextProbe, { controller, renders }),
    createElement(LengthProbe, { controller, renders }),
    createElement(SelectionProbe, { controller, renders }),
  );
}

function TextProbe({
  controller,
  renders,
}: {
  readonly controller: ReactEditorController;
  readonly renders: { text: number };
}): null {
  renders.text += 1;
  const text = useEditorSelector(controller, (snapshot) => snapshot.text);
  void text;
  return null;
}

function LengthProbe({
  controller,
  renders,
}: {
  readonly controller: ReactEditorController;
  readonly renders: { length: number };
}): null {
  renders.length += 1;
  const length = useEditorSelector(controller, (snapshot) => snapshot.state?.length ?? 0);
  void length;
  return null;
}

function SelectionProbe({
  controller,
  renders,
}: {
  readonly controller: ReactEditorController;
  readonly renders: { selections: number };
}): null {
  renders.selections += 1;
  const selections = useEditorSelector(
    controller,
    (snapshot) => snapshot.snapshot?.selections ?? EMPTY_SELECTIONS,
    selectionsEqual,
  );
  void selections;
  return null;
}

function mountReactEditor(options: ReactEditorOptions = {}): MountedEditor {
  let controller!: ReactEditorController;
  const host = document.createElement("div");
  const root = createRoot(host);
  document.body.append(host);

  const render = (nextOptions: ReactEditorOptions): void => {
    act(() => {
      root.render(
        createElement(ReactEditorHarness, {
          options: nextOptions,
          onController: (nextController) => {
            controller = nextController;
          },
        }),
      );
    });
  };

  render(options);

  return {
    get controller() {
      return controller;
    },
    host,
    render,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function editorElement(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(".editor");
}

function selectionsEqual(
  current: readonly EditorResolvedSelection[],
  next: readonly EditorResolvedSelection[],
): boolean {
  if (current.length !== next.length) return false;

  return current.every((selection, index) => {
    const nextSelection = next[index];
    if (!nextSelection) return false;

    return (
      selection.anchorOffset === nextSelection.anchorOffset &&
      selection.headOffset === nextSelection.headOffset &&
      selection.startOffset === nextSelection.startOffset &&
      selection.endOffset === nextSelection.endOffset
    );
  });
}
