import {
  detectPlatform,
  getHotkeyManager,
  type HotkeyRegistrationHandle,
  type RawHotkey,
  type RegisterableHotkey,
} from "@tanstack/hotkeys";
import type { EditorCommandContext, EditorCommandId } from "./commands";

type EditorPlatform = ReturnType<typeof detectPlatform>;

export type EditorKeyBinding = {
  readonly hotkey: RegisterableHotkey;
  readonly command: EditorCommandId;
  readonly preventDefault?: boolean;
  readonly stopPropagation?: boolean;
};

export type EditorKeymapOptions = {
  readonly enabled?: boolean;
  readonly defaultBindings?: boolean;
  readonly bindings?: readonly EditorKeyBinding[];
};

export type EditorKeymapControllerOptions = {
  readonly target: HTMLElement;
  readonly keymap?: EditorKeymapOptions;
  readonly dispatch: (command: EditorCommandId, context: EditorCommandContext) => boolean;
};

export class EditorKeymapController {
  private readonly handles: HotkeyRegistrationHandle[] = [];

  public constructor(options: EditorKeymapControllerOptions) {
    if (options.keymap?.enabled === false) return;

    const bindings = editorKeyBindings(options.keymap);
    for (const binding of bindings) this.registerBinding(options.target, binding, options.dispatch);
  }

  public dispose(): void {
    for (const handle of this.handles) handle.unregister();
    this.handles.length = 0;
  }

  private registerBinding(
    target: HTMLElement,
    binding: EditorKeyBinding,
    dispatch: (command: EditorCommandId, context: EditorCommandContext) => boolean,
  ): void {
    const handle = getHotkeyManager().register(
      binding.hotkey,
      (event) => {
        const handled = dispatch(binding.command, { event });
        if (!handled) return;

        if (binding.preventDefault !== false) event.preventDefault();
        if (binding.stopPropagation !== false) event.stopPropagation();
      },
      {
        conflictBehavior: "replace",
        eventType: "keydown",
        ignoreInputs: false,
        preventDefault: false,
        stopPropagation: false,
        target,
      },
    );
    this.handles.push(handle);
  }
}

export function editorKeyBindings(options: EditorKeymapOptions = {}): readonly EditorKeyBinding[] {
  const defaults = options.defaultBindings === false ? [] : defaultEditorKeyBindings();
  return [...defaults, ...(options.bindings ?? [])];
}

export function defaultEditorKeyBindings(
  platform: EditorPlatform = detectPlatform(),
): readonly EditorKeyBinding[] {
  return [
    ...editingBindings(platform),
    ...horizontalNavigationBindings(platform),
    ...verticalNavigationBindings(platform),
  ];
}

const key = (keyName: string, modifiers: Omit<RawHotkey, "key"> = {}): RawHotkey => ({
  key: keyName,
  ...modifiers,
});

function editingBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const platformBindings: readonly EditorKeyBinding[] =
    platform === "mac" ? [] : [{ hotkey: key("Y", { ctrl: true }), command: "redo" }];

  return [
    { hotkey: key("Backspace"), command: "deleteBackward" },
    { hotkey: key("Delete"), command: "deleteForward" },
    { hotkey: key("A", { mod: true }), command: "selectAll" },
    { hotkey: key("Z", { mod: true }), command: "undo" },
    { hotkey: key("Z", { mod: true, shift: true }), command: "redo" },
    ...platformBindings,
  ];
}

function horizontalNavigationBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { hotkey: key("ArrowLeft"), command: "cursorLeft" },
    { hotkey: key("ArrowRight"), command: "cursorRight" },
    { hotkey: key("ArrowLeft", { shift: true }), command: "selectLeft" },
    { hotkey: key("ArrowRight", { shift: true }), command: "selectRight" },
    ...wordNavigationBindings(platform),
    ...lineBoundaryBindings(platform),
  ];
}

function verticalNavigationBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  return [
    { hotkey: key("ArrowUp"), command: "cursorUp" },
    { hotkey: key("ArrowDown"), command: "cursorDown" },
    { hotkey: key("ArrowUp", { shift: true }), command: "selectUp" },
    { hotkey: key("ArrowDown", { shift: true }), command: "selectDown" },
    { hotkey: key("PageUp"), command: "cursorPageUp" },
    { hotkey: key("PageDown"), command: "cursorPageDown" },
    { hotkey: key("PageUp", { shift: true }), command: "selectPageUp" },
    { hotkey: key("PageDown", { shift: true }), command: "selectPageDown" },
    ...documentBoundaryBindings(platform),
  ];
}

function wordNavigationBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const modifier = platform === "mac" ? { alt: true } : { ctrl: true };
  return [
    { hotkey: key("ArrowLeft", modifier), command: "cursorWordLeft" },
    { hotkey: key("ArrowRight", modifier), command: "cursorWordRight" },
    { hotkey: key("ArrowLeft", { ...modifier, shift: true }), command: "selectWordLeft" },
    { hotkey: key("ArrowRight", { ...modifier, shift: true }), command: "selectWordRight" },
  ];
}

function lineBoundaryBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  const macBindings: readonly EditorKeyBinding[] =
    platform === "mac"
      ? [
          { hotkey: key("ArrowLeft", { meta: true }), command: "cursorLineStart" },
          { hotkey: key("ArrowRight", { meta: true }), command: "cursorLineEnd" },
          { hotkey: key("ArrowLeft", { meta: true, shift: true }), command: "selectLineStart" },
          { hotkey: key("ArrowRight", { meta: true, shift: true }), command: "selectLineEnd" },
        ]
      : [];

  return [
    { hotkey: key("Home"), command: "cursorLineStart" },
    { hotkey: key("End"), command: "cursorLineEnd" },
    { hotkey: key("Home", { shift: true }), command: "selectLineStart" },
    { hotkey: key("End", { shift: true }), command: "selectLineEnd" },
    ...macBindings,
  ];
}

function documentBoundaryBindings(platform: EditorPlatform): readonly EditorKeyBinding[] {
  if (platform === "mac") {
    return [
      { hotkey: key("ArrowUp", { meta: true }), command: "cursorDocumentStart" },
      { hotkey: key("ArrowDown", { meta: true }), command: "cursorDocumentEnd" },
      { hotkey: key("ArrowUp", { meta: true, shift: true }), command: "selectDocumentStart" },
      { hotkey: key("ArrowDown", { meta: true, shift: true }), command: "selectDocumentEnd" },
    ];
  }

  return [
    { hotkey: key("Home", { ctrl: true }), command: "cursorDocumentStart" },
    { hotkey: key("End", { ctrl: true }), command: "cursorDocumentEnd" },
    { hotkey: key("Home", { ctrl: true, shift: true }), command: "selectDocumentStart" },
    { hotkey: key("End", { ctrl: true, shift: true }), command: "selectDocumentEnd" },
  ];
}
