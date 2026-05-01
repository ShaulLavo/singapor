import { Editor } from "@editor/core/editor";
import "@editor/core/style.css";
import "@editor/find/style.css";
import "@editor/minimap/style.css";
import "@editor/scope-lines/style.css";
import { createEditorFindPlugin } from "@editor/find";
import { createFoldGutterPlugin, createLineGutterPlugin } from "@editor/gutters";
import { createMinimapPlugin } from "@editor/minimap";
import { createScopeLinesPlugin } from "@editor/scope-lines";
import { css, html, javaScript, json, markdown, typeScript } from "@editor/tree-sitter-languages";
import {
  createTypeScriptLspPlugin,
  type TypeScriptLspDiagnosticSummary,
  type TypeScriptLspStatus,
} from "@editor/typescript-lsp";
import { createEditorPane } from "./components/editorPane.ts";
import { el } from "./components/dom.ts";
import { createSidebar } from "./components/sidebar.ts";
import { createStatusBar } from "./components/statusBar.ts";
import { createTopBar } from "./components/topBar.ts";
import { createFoldChevronIcon } from "./foldGutterIcon.ts";
import { SourceController } from "./sourceController.ts";

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
  let typeScriptLspStatus: TypeScriptLspStatus = "idle";
  let typeScriptDiagnostics: TypeScriptLspDiagnosticSummary | null = null;
  const syncTypeScriptStatus = (): void => {
    statusBar.updateTypeScriptLsp(typeScriptLspStatus, typeScriptDiagnostics);
  };
  const typeScriptLsp = createTypeScriptLspPlugin({
    onStatusChange: (status) => {
      typeScriptLspStatus = status;
      syncTypeScriptStatus();
    },
    onDiagnostics: (summary) => {
      typeScriptDiagnostics = summary;
      syncTypeScriptStatus();
    },
    onOpenDefinition: (target) => controller?.openDefinition(target) ?? false,
    onError: (error) => {
      console.warn("[typescript-lsp]", error);
    },
  });
  const editor = new Editor(editorPane.element, {
    cursorLineHighlight: {
      gutterNumber: true,
      gutterBackground: ["fold-gutter"],
      rowBackground: true,
    },
    plugins: [
      javaScript({ jsx: true }),
      typeScript({ tsx: true }),
      html(),
      css(),
      json(),
      markdown(),
      createLineGutterPlugin(),
      createFoldGutterPlugin({
        width: 16,
        icon: createFoldChevronIcon,
        iconClassName: "app-fold-gutter-icon",
      }),
      // createShikiHighlighterPlugin({ theme: "github-dark" }),
      createEditorFindPlugin(),
      createScopeLinesPlugin(),
      createMinimapPlugin(),
      typeScriptLsp,
    ],
    onChange: (state) => {
      controller?.updateStatus(state);
    },
  });
  controller = new SourceController(topBar, sidebar, statusBar, editor, typeScriptLsp);

  syncTypeScriptStatus();
  controller.start();
}
