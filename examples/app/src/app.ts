import { Editor } from "@editor/core";
import "@editor/core/style.css";
import { getCachedHandle, cacheHandle } from "./db.ts";
import { tokenizeFile } from "./highlighting.ts";
import { renderDir } from "./tree.ts";

const SELECTED_FILE_KEY = "editor-selected-file";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export function mountApp(): void {
  const app = document.getElementById("app")!;

  const toolbar = el("div", { id: "toolbar" });
  const openBtn = el("button", { id: "open-btn" });
  openBtn.textContent = "Open Directory";
  const refreshBtn = el("button", { id: "refresh-btn", title: "Refresh file tree" });
  refreshBtn.textContent = "Refresh";
  refreshBtn.disabled = true;
  const dirName = el("span", { id: "dir-name" });
  toolbar.append(openBtn, refreshBtn, dirName);

  const tree = el("div", { id: "tree" });
  const editorContainer = el("div", { id: "editor-container" });
  const main = el("div", { id: "main" });
  main.append(tree, editorContainer);

  app.append(toolbar, main);

  const editor = new Editor(editorContainer);
  const expandedDirectoryPaths = new Set<string>();
  let currentDirectoryHandle: FileSystemDirectoryHandle | null = null;
  let currentSelectedPath: string | undefined;
  let isRenderingDirectory = false;
  let fileSelectionVersion = 0;

  function updateToolbarState() {
    openBtn.disabled = isRenderingDirectory;
    refreshBtn.disabled = isRenderingDirectory || !currentDirectoryHandle;
  }

  function setDirectoryOpen(directoryPath: string, open: boolean) {
    if (open) {
      expandedDirectoryPaths.add(directoryPath);
      return;
    }

    expandedDirectoryPaths.delete(directoryPath);
    for (const path of expandedDirectoryPaths) {
      if (path.startsWith(directoryPath)) expandedDirectoryPaths.delete(path);
    }
  }

  async function displayFile(filePath: string, content: string) {
    const selectionVersion = ++fileSelectionVersion;

    currentSelectedPath = filePath;
    localStorage.setItem(SELECTED_FILE_KEY, filePath);
    editor.setContent(content);

    try {
      const tokens = await tokenizeFile(filePath, content);
      if (selectionVersion !== fileSelectionVersion) return;
      editor.setTokens(tokens);
    } catch (err) {
      console.error(`Failed to tokenize "${filePath}":`, err);
    }
  }

  async function openDirectory(
    handle: FileSystemDirectoryHandle,
    options?: { selectedPath?: string; preserveExpandedPaths?: boolean },
  ) {
    const expandedPathsToRestore = options?.preserveExpandedPaths
      ? new Set(expandedDirectoryPaths)
      : new Set<string>();

    expandedDirectoryPaths.clear();
    currentDirectoryHandle = handle;
    currentSelectedPath = options?.selectedPath;
    fileSelectionVersion += 1;
    isRenderingDirectory = true;
    updateToolbarState();
    dirName.textContent = handle.name;
    editor.clear();
    tree.replaceChildren();

    try {
      await renderDir(handle, tree, displayFile, {
        selectedPath: options?.selectedPath,
        expandedPaths: expandedPathsToRestore,
        onDirectoryToggle: setDirectoryOpen,
      });
    } finally {
      isRenderingDirectory = false;
      updateToolbarState();
    }
  }

  async function refreshDirectory() {
    if (!currentDirectoryHandle) return;

    await openDirectory(currentDirectoryHandle, {
      selectedPath: currentSelectedPath,
      preserveExpandedPaths: true,
    });
  }

  getCachedHandle()
    .then(async (cached) => {
      if (!cached) return;
      const perm = await cached.queryPermission({ mode: "read" });
      if (perm === "granted") {
        const selectedPath = localStorage.getItem(SELECTED_FILE_KEY) ?? undefined;
        await openDirectory(cached, { selectedPath });
      }
    })
    .catch((err) => {
      console.error("Failed to restore cached directory:", err);
      dirName.textContent = "Failed to restore directory";
    });

  openBtn.addEventListener("click", async () => {
    try {
      const handle = await window.showDirectoryPicker();
      await cacheHandle(handle);
      await openDirectory(handle);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // user cancelled the picker
      console.error("Failed to open directory:", err);
      dirName.textContent = "Failed to open directory";
    }
  });

  refreshBtn.addEventListener("click", async () => {
    try {
      await refreshDirectory();
    } catch (err) {
      console.error("Failed to refresh directory:", err);
      dirName.textContent = "Failed to refresh directory";
    }
  });
}
