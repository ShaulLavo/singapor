import { Editor } from "@editor/core";
import "@editor/core/style.css";
import { createEditorPane } from "./components/editorPane.ts";
import { el } from "./components/dom.ts";
import { createSidebar } from "./components/sidebar.ts";
import type { Sidebar } from "./components/sidebar.ts";
import { createStatusBar } from "./components/statusBar.ts";
import type { StatusBar } from "./components/statusBar.ts";
import { createTopBar } from "./components/topBar.ts";
import type { TopBar } from "./components/topBar.ts";
import { getCachedHandle, cacheHandle } from "./db.ts";

const SELECTED_FILE_KEY = "editor-selected-file";

type AppController = {
  readonly openDirectory: (
    handle: FileSystemDirectoryHandle,
    options?: { selectedPath?: string; preserveExpandedPaths?: boolean },
  ) => Promise<void>;
  readonly refreshDirectory: () => Promise<void>;
  readonly selectedPath: () => string | undefined;
};

class DirectoryController implements AppController {
  private currentDirectoryHandle: FileSystemDirectoryHandle | null = null;
  private currentSelectedPath: string | undefined;
  private isRenderingDirectory = false;
  private readonly topBar: TopBar;
  private readonly sidebar: Sidebar;
  private readonly statusBar: StatusBar;
  private readonly editor: Editor;

  constructor(topBar: TopBar, sidebar: Sidebar, statusBar: StatusBar, editor: Editor) {
    this.topBar = topBar;
    this.sidebar = sidebar;
    this.statusBar = statusBar;
    this.editor = editor;
  }

  selectedPath(): string | undefined {
    return this.currentSelectedPath;
  }

  updateStatus(state = this.editor.getState()): void {
    this.statusBar.update(this.currentSelectedPath, state);
  }

  async openDirectory(
    handle: FileSystemDirectoryHandle,
    options?: { selectedPath?: string; preserveExpandedPaths?: boolean },
  ): Promise<void> {
    this.currentDirectoryHandle = handle;
    this.currentSelectedPath = options?.selectedPath;
    this.isRenderingDirectory = true;
    this.updateToolbarState();
    this.topBar.setDirectoryName(handle.name);
    this.clearActiveFile();

    try {
      await this.sidebar.renderDirectory(handle, this.displayFile, {
        selectedPath: options?.selectedPath,
        preserveExpandedPaths: options?.preserveExpandedPaths,
      });
    } finally {
      this.isRenderingDirectory = false;
      this.updateToolbarState();
    }
  }

  async refreshDirectory(): Promise<void> {
    if (!this.currentDirectoryHandle) return;

    await this.openDirectory(this.currentDirectoryHandle, {
      selectedPath: this.currentSelectedPath,
      preserveExpandedPaths: true,
    });
  }

  private readonly displayFile = (filePath: string, content: string): void => {
    this.currentSelectedPath = filePath;
    localStorage.setItem(SELECTED_FILE_KEY, filePath);
    this.editor.openDocument({ documentId: filePath, text: content });
    this.editor.focus();
    this.updateStatus();
  };

  private updateToolbarState(): void {
    this.topBar.setBusyState(this.isRenderingDirectory, Boolean(this.currentDirectoryHandle));
  }

  private clearActiveFile(): void {
    this.currentSelectedPath = undefined;
    this.editor.clearDocument();
    this.updateStatus();
  }
}

export function mountApp(): void {
  const app = document.getElementById("app")!;
  const topBar = createTopBar();
  const sidebar = createSidebar();
  const editorPane = createEditorPane();
  const statusBar = createStatusBar();
  const main = el("div", { id: "main" });
  main.append(sidebar.element, editorPane.element);

  app.append(topBar.element, main, statusBar.element);

  let controller: DirectoryController | null = null;
  const editor = new Editor(editorPane.element, {
    onChange: (state) => {
      controller?.updateStatus(state);
    },
  });
  controller = new DirectoryController(topBar, sidebar, statusBar, editor);

  restoreCachedDirectory(controller, topBar);
  topBar.openButton.addEventListener("click", () => {
    void openDirectoryFromPicker(controller, topBar);
  });
  topBar.refreshButton.addEventListener("click", () => {
    void refreshOpenDirectory(controller, topBar);
  });
}

function restoreCachedDirectory(controller: AppController, topBar: TopBar): void {
  getCachedHandle()
    .then(async (cached) => {
      if (!cached) return;
      const perm = await cached.queryPermission({ mode: "read" });
      if (perm === "granted") {
        const selectedPath = localStorage.getItem(SELECTED_FILE_KEY) ?? undefined;
        await controller.openDirectory(cached, { selectedPath });
      }
    })
    .catch(() => {
      topBar.setMessage("Failed to restore directory");
      return undefined;
    });
}

async function openDirectoryFromPicker(controller: AppController, topBar: TopBar): Promise<void> {
  try {
    const handle = await window.showDirectoryPicker();
    await cacheDirectoryHandle(handle);
    await controller.openDirectory(handle);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return; // user cancelled the picker
    topBar.setMessage("Failed to open directory");
    return;
  }
}

async function cacheDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    await cacheHandle(handle);
  } catch {
    return;
  }
}

async function refreshOpenDirectory(controller: AppController, topBar: TopBar): Promise<void> {
  try {
    await controller.refreshDirectory();
  } catch {
    topBar.setMessage("Failed to refresh directory");
    return;
  }
}
