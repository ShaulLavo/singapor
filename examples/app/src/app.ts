import {
  createFoldGutterPlugin,
  createLineGutterPlugin,
  Editor,
  type FoldGutterIconContext,
} from "@editor/core/editor";
import "@editor/core/style.css";
import "@editor/minimap/style.css";
import { createMinimapPlugin } from "@editor/minimap";
import { css, html, javaScript, json, typeScript } from "@editor/tree-sitter-languages";
import { createEditorPane } from "./components/editorPane.ts";
import { el } from "./components/dom.ts";
import { createSidebar } from "./components/sidebar.ts";
import type { Sidebar } from "./components/sidebar.ts";
import { createStatusBar } from "./components/statusBar.ts";
import type { StatusBar } from "./components/statusBar.ts";
import { createTopBar } from "./components/topBar.ts";
import type { TopBar } from "./components/topBar.ts";
import { createShikiHighlighterPlugin } from "@editor/shiki";
import {
  fetchRepositorySource,
  REPOSITORY_NAME,
  REPOSITORY_OWNER,
  type SourceFile,
  type SourceSnapshot,
} from "./githubSource.ts";
import { loadCachedSourceSnapshot, saveSourceSnapshotToCache } from "./sourceCache.ts";
import { findSourceFile, firstSourceFile } from "./tree.ts";

const SELECTED_FILE_KEY = "editor-selected-file";
const DEFAULT_SELECTED_FILE = "README.md";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
// Font Awesome Free v7.2.0 chevron-down path, https://fontawesome.com/license/free
const FOLD_CHEVRON_PATH =
  "M297.4 438.6C309.9 451.1 330.2 451.1 342.7 438.6L502.7 278.6C515.2 266.1 515.2 245.8 502.7 233.3C490.2 220.8 469.9 220.8 457.4 233.3L320 370.7L182.6 233.4C170.1 220.9 149.8 220.9 137.3 233.4C124.8 245.9 124.8 266.2 137.3 278.7L297.3 438.7z";

class SourceController {
  private currentSnapshot: SourceSnapshot | null = null;
  private currentSelectedPath: string | undefined;
  private isRefreshingSource = false;
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

  start(): void {
    this.statusBar.clear();
    this.topBar.setMessage("Loading cached source");
    void this.loadCachedThenRefresh();
  }

  updateStatus(state = this.editor.getState()): void {
    this.statusBar.update(this.currentSelectedPath, state);
  }

  async refreshSource(): Promise<void> {
    if (this.isRefreshingSource) return;

    this.isRefreshingSource = true;
    this.updateToolbarState();
    this.topBar.setMessage(`Fetching ${REPOSITORY_OWNER}/${REPOSITORY_NAME}`);

    try {
      const snapshot = await fetchRepositorySource();
      await persistSnapshot(snapshot);
      await this.displaySnapshot(snapshot, {
        selectedPath: this.currentSelectedPath ?? storedSelectedPath(),
        preserveExpandedPaths: Boolean(this.currentSnapshot),
      });
      this.topBar.setRepositoryName(snapshotLabel(snapshot));
    } catch {
      this.handleRefreshFailure();
    } finally {
      this.isRefreshingSource = false;
      this.updateToolbarState();
    }
  }

  private async loadCachedThenRefresh(): Promise<void> {
    const cached = await loadCachedSourceSnapshot();

    if (cached) {
      await this.displaySnapshot(cached, {
        selectedPath: storedSelectedPath(),
        preserveExpandedPaths: false,
      });
      this.topBar.setRepositoryName(`${snapshotLabel(cached)} cached`);
    }

    await this.refreshSource();
  }

  private async displaySnapshot(
    snapshot: SourceSnapshot,
    options: { readonly selectedPath?: string; readonly preserveExpandedPaths: boolean },
  ): Promise<void> {
    const selectedFile = selectedFileForSnapshot(snapshot, options.selectedPath);
    this.currentSnapshot = snapshot;
    this.currentSelectedPath = selectedFile?.path;

    if (!selectedFile) {
      this.clearActiveFile();
      this.sidebar.clear();
      return;
    }

    await this.sidebar.renderSource(snapshot.files, this.displayFile, {
      selectedPath: selectedFile.path,
      preserveExpandedPaths: options.preserveExpandedPaths,
    });
  }

  private readonly displayFile = (file: SourceFile, reason: "auto" | "user"): void => {
    this.currentSelectedPath = file.path;
    localStorage.setItem(SELECTED_FILE_KEY, file.path);
    this.editor.openDocument({
      documentId: file.path,
      text: file.text,
      languageId: languageIdForFilePath(file.path),
    });
    if (reason === "user") this.editor.focus();
    this.updateStatus();
  };

  private handleRefreshFailure(): void {
    if (this.currentSnapshot) {
      this.topBar.setMessage("Using cached source; refresh failed");
      return;
    }

    this.topBar.setMessage("Failed to fetch source");
    this.clearActiveFile();
    this.sidebar.clear();
  }

  private updateToolbarState(): void {
    this.topBar.setBusyState(this.isRefreshingSource);
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

  let controller: SourceController | null = null;
  const editor = new Editor(editorPane.element, {
    plugins: [
      javaScript({ jsx: true }),
      typeScript({ tsx: true }),
      html(),
      css(),
      json(),
      createLineGutterPlugin(),
      createFoldGutterPlugin({
        width: 14,
        icon: createFoldChevronIcon,
        iconClassName: "app-fold-gutter-icon",
      }),
      createShikiHighlighterPlugin({ theme: "github-dark" }),
      createMinimapPlugin(),
    ],
    onChange: (state) => {
      controller?.updateStatus(state);
    },
  });
  controller = new SourceController(topBar, sidebar, statusBar, editor);

  controller.start();
}

function createFoldChevronIcon({ document }: FoldGutterIconContext): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.classList.add("app-fold-chevron");
  svg.setAttribute("viewBox", "0 0 640 640");

  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", FOLD_CHEVRON_PATH);
  svg.append(path);
  return svg;
}

function selectedFileForSnapshot(
  snapshot: SourceSnapshot,
  selectedPath: string | undefined,
): SourceFile | null {
  return (
    findSourceFile(snapshot.files, selectedPath) ??
    findSourceFile(snapshot.files, DEFAULT_SELECTED_FILE) ??
    firstSourceFile(snapshot.files)
  );
}

async function persistSnapshot(snapshot: SourceSnapshot): Promise<void> {
  try {
    await saveSourceSnapshotToCache(snapshot);
  } catch {
    return;
  }
}

function storedSelectedPath(): string | undefined {
  return localStorage.getItem(SELECTED_FILE_KEY) ?? undefined;
}

function snapshotLabel(snapshot: SourceSnapshot): string {
  return `${snapshot.owner}/${snapshot.repo} @ ${snapshot.treeSha.slice(0, 7)}`;
}

function languageIdForFilePath(filePath: string): string | null {
  const extension = extensionForFilePath(filePath);
  if (!extension) return null;

  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

function extensionForFilePath(filePath: string): string | null {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex === -1) return null;

  return filePath.slice(dotIndex).toLowerCase();
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".cjs": "javascript",
  ".css": "css",
  ".cts": "typescript",
  ".htm": "html",
  ".html": "html",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".mts": "typescript",
  ".ts": "typescript",
  ".tsx": "typescript",
};
