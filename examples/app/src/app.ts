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
  const dirName = el("span", { id: "dir-name" });
  toolbar.append(openBtn, dirName);

  const tree = el("div", { id: "tree" });
  const editorContainer = el("div", { id: "editor-container" });
  const main = el("div", { id: "main" });
  main.append(tree, editorContainer);

  app.append(toolbar, main);

  const editor = new Editor(editorContainer);
  let fileSelectionVersion = 0;

  async function displayFile(filePath: string, content: string) {
    const selectionVersion = ++fileSelectionVersion;

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

  async function openDirectory(handle: FileSystemDirectoryHandle, selectedPath?: string) {
    fileSelectionVersion += 1;
    dirName.textContent = handle.name;
    editor.clear();
    tree.replaceChildren();
    await renderDir(handle, tree, displayFile, { selectedPath });
  }

  getCachedHandle()
    .then(async (cached) => {
      if (!cached) return;
      const perm = await cached.queryPermission({ mode: "read" });
      if (perm === "granted") {
        const selectedPath = localStorage.getItem(SELECTED_FILE_KEY) ?? undefined;
        await openDirectory(cached, selectedPath);
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
}
