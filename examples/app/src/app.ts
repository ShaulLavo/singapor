import {
  createDocumentSession,
  createEditorSyntaxSession,
  debugPieceTable,
  Editor,
  offsetToPoint,
  resolveSelection,
  type DocumentSession,
  type DocumentSessionChange,
  type EditorSyntaxSession,
  type EditorTimingMeasurement,
} from "@editor/core";
import "@editor/core/style.css";
import { getCachedHandle, cacheHandle } from "./db.ts";
import { inferLanguage } from "./language.ts";
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

  const status = el("div", { id: "status" });
  const fileStatus = el("span", { id: "status-file" });
  const cursorStatus = el("span", { id: "status-cursor" });
  const lengthStatus = el("span", { id: "status-length" });
  const piecesStatus = el("span", { id: "status-pieces" });
  const historyStatus = el("span", { id: "status-history" });
  status.append(fileStatus, cursorStatus, lengthStatus, piecesStatus, historyStatus);

  const tree = el("div", { id: "tree" });
  const editorContainer = el("div", { id: "editor-container" });
  const main = el("div", { id: "main" });
  main.append(tree, editorContainer);

  app.append(toolbar, main, status);

  const editor = new Editor(editorContainer);
  const expandedDirectoryPaths = new Set<string>();
  let currentDirectoryHandle: FileSystemDirectoryHandle | null = null;
  let currentSelectedPath: string | undefined;
  let currentSession: DocumentSession | null = null;
  let currentSyntaxSession: EditorSyntaxSession | null = null;
  let isRenderingDirectory = false;
  let fileSelectionVersion = 0;

  function updateToolbarState() {
    openBtn.disabled = isRenderingDirectory;
    refreshBtn.disabled = isRenderingDirectory || !currentDirectoryHandle;
  }

  function clearActiveFile() {
    currentSession = null;
    currentSyntaxSession?.dispose();
    currentSyntaxSession = null;
    editor.clear();
    updateStatus();
  }

  function updateStatus() {
    if (!currentSession) {
      fileStatus.textContent = "No file";
      cursorStatus.textContent = "";
      lengthStatus.textContent = "";
      piecesStatus.textContent = "";
      historyStatus.textContent = "";
      return;
    }

    const snapshot = currentSession.getSnapshot();
    const selection = currentSession.getSelections().selections[0];
    const resolved = selection ? resolveSelection(snapshot, selection) : null;
    const point = offsetToPoint(snapshot, resolved?.headOffset ?? snapshot.length);
    fileStatus.textContent = currentSelectedPath ?? "Untitled";
    cursorStatus.textContent = `Ln ${point.row + 1}, Col ${point.column + 1}`;
    lengthStatus.textContent = `${snapshot.length} chars`;
    piecesStatus.textContent = `${debugPieceTable(snapshot).length} pieces`;
    historyStatus.textContent = `${currentSession.canUndo() ? "Undo" : "No undo"} / ${
      currentSession.canRedo() ? "Redo" : "No redo"
    }`;
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

  async function refreshTokensForChange(
    change: DocumentSessionChange,
    selectionVersion: number,
  ): Promise<DocumentSessionChange> {
    if (!currentSession || !currentSyntaxSession) return change;
    if (change.kind === "none" || change.kind === "selection") return change;

    const syntaxStart = nowMs();
    const syntaxResult = await currentSyntaxSession.applyChange(change);
    const { tokens } = syntaxResult;
    let timedChange = appendTiming(change, "app.syntax", syntaxStart);

    if (selectionVersion !== fileSelectionVersion) return timedChange;

    const setTokensStart = nowMs();
    currentSession.setTokens(tokens);
    timedChange = appendTiming(timedChange, "app.session.setTokens", setTokensStart);

    const highlightStart = nowMs();
    editor.setTokens(tokens);
    timedChange = appendTiming(timedChange, "app.highlight", highlightStart);

    const statusStart = nowMs();
    updateStatus();
    return appendTiming(timedChange, "app.status", statusStart);
  }

  function handleSessionChange(change: DocumentSessionChange, selectionVersion: number) {
    const statusStart = nowMs();
    updateStatus();
    const timedChange = appendTiming(change, "app.status", statusStart);

    void refreshTokensForChange(timedChange, selectionVersion)
      .then(reportTimings)
      .catch((err) => {
        console.error(`Failed to update syntax for "${currentSelectedPath ?? "file"}":`, err);
      });
  }

  async function displayFile(filePath: string, content: string) {
    const selectionVersion = ++fileSelectionVersion;

    currentSelectedPath = filePath;
    localStorage.setItem(SELECTED_FILE_KEY, filePath);
    currentSyntaxSession?.dispose();
    currentSyntaxSession = null;

    const session = createDocumentSession(content);
    const syntaxSession = createEditorSyntaxSession({
      documentId: filePath,
      languageId: inferLanguage(filePath),
      text: content,
    });
    currentSession = session;
    currentSyntaxSession = syntaxSession;
    editor.attachSession(session, {
      onChange: (change) => handleSessionChange(change, selectionVersion),
    });
    updateStatus();

    try {
      const initStart = nowMs();
      let timings: EditorTimingMeasurement[] = [
        { name: "app.syntax.init", durationMs: nowMs() - initStart },
      ];
      if (selectionVersion !== fileSelectionVersion) {
        syntaxSession.dispose();
        return;
      }
      const sessionText = session.getText();
      const syntaxStart = nowMs();
      const syntaxResult = await syntaxSession.refresh(sessionText);
      const { tokens } = syntaxResult;
      timings = [...timings, { name: "app.initialSyntax", durationMs: nowMs() - syntaxStart }];

      const sessionTokensStart = nowMs();
      const tokenChange = session.setTokens(tokens);
      timings = [
        ...timings,
        { name: "app.session.setTokens", durationMs: nowMs() - sessionTokensStart },
      ];

      const highlightStart = nowMs();
      editor.setTokens(tokens);
      timings = [...timings, { name: "app.highlight", durationMs: nowMs() - highlightStart }];

      const statusStart = nowMs();
      updateStatus();
      timings = [...timings, { name: "app.status", durationMs: nowMs() - statusStart }];
      reportTimings({ ...tokenChange, timings });
    } catch (err) {
      console.error(`Failed to update syntax for "${filePath}":`, err);
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
    clearActiveFile();
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

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function appendTiming(
  change: DocumentSessionChange,
  name: string,
  startMs: number,
): DocumentSessionChange {
  return {
    ...change,
    timings: [...change.timings, { name, durationMs: nowMs() - startMs }],
  };
}

function reportTimings(change: DocumentSessionChange): void {
  if (change.timings.length === 0) return;

  console.groupCollapsed(`[editor timings] ${change.kind}`);
  console.table(
    change.timings.map((timing) => ({
      phase: timing.name,
      durationMs: Number(timing.durationMs.toFixed(3)),
    })),
  );
  console.groupEnd();
}
