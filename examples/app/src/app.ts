import { createMergeConflictPlugin, Editor, type EditorPlugin } from '@singapor/core/editor'
import { createDiffPlugin } from '@singapor/diff'
import '@singapor/core/style.css'
import '@singapor/diff/style.css'
import '@singapor/find/style.css'
import '@singapor/minimap/style.css'
import '@singapor/scope-lines/style.css'
import { createEditorFindPlugin } from '@singapor/find'
import { createFoldGutterPlugin, createLineGutterPlugin } from '@singapor/gutters'
import { createMinimapPlugin } from '@singapor/minimap'
import { createScopeLinesPlugin, createStickyScrollPlugin } from '@singapor/scope-lines'
import { css, html, javaScript, json, markdown, typeScript } from '@singapor/tree-sitter-languages'
import {
  createTypeScriptLspPlugin,
  type TypeScriptLspDiagnosticSummary,
  type TypeScriptLspStatus,
} from '@singapor/typescript-lsp'
import { createEditorPane } from './components/editorPane.ts'
import { el } from './components/dom.ts'
import { createSidebar } from './components/sidebar.ts'
import { createStatusBar } from './components/statusBar.ts'
import { createTopBar } from './components/topBar.ts'
import { createFoldChevronIcon } from './foldGutterIcon.ts'
import { SourceController } from './sourceController.ts'

export function mountApp(): void {
  const app = document.getElementById('app')!
  const topBar = createTopBar()
  const sidebar = createSidebar()
  const editorPane = createEditorPane()
  const statusBar = createStatusBar()
  const main = el('div', { id: 'main' })
  main.append(sidebar.element, editorPane.element)

  app.append(topBar.element, main, statusBar.element)

  let controller: SourceController | null = null
  let typeScriptLspStatus: TypeScriptLspStatus = 'idle'
  let typeScriptDiagnostics: TypeScriptLspDiagnosticSummary | null = null
  const syncTypeScriptStatus = (): void => {
    statusBar.updateTypeScriptLsp(typeScriptLspStatus, typeScriptDiagnostics)
  }
  const typeScriptLsp = createTypeScriptLspPlugin({
    onStatusChange: (status) => {
      typeScriptLspStatus = status
      syncTypeScriptStatus()
    },
    onDiagnostics: (summary) => {
      typeScriptDiagnostics = summary
      syncTypeScriptStatus()
    },
    onOpenDefinition: (target) => controller?.openDefinition(target) ?? false,
    onError: (error) => {
      console.warn('[typescript-lsp]', error)
    },
  })
  const liveDiff = createDiffPlugin({ mode: 'overlay' })
  const languagePlugins: readonly EditorPlugin[] = [
    javaScript({ jsx: true }),
    typeScript({ tsx: true }),
    html(),
    css(),
    json(),
    markdown(),
  ]
  const lineGutter = createLineGutterPlugin()
  const foldGutter = createFoldGutterPlugin({
    width: 16,
    icon: createFoldChevronIcon,
    iconClassName: 'app-fold-gutter-icon',
  })
  const sharedPlugins: readonly EditorPlugin[] = [
    foldGutter,
    // Shiki highlighter: import createShikiHighlighterPlugin from "@singapor/core/shiki".
    // createShikiHighlighterPlugin({ theme: "github-dark" }),
    createMergeConflictPlugin(),
    createEditorFindPlugin(),
    createScopeLinesPlugin(),
    createStickyScrollPlugin(),
    createMinimapPlugin(),
    typeScriptLsp,
  ]
  const editPlugins: readonly EditorPlugin[] = languagePlugins.concat(
    lineGutter,
    liveDiff,
    sharedPlugins,
  )
  const diffPlugins: readonly EditorPlugin[] = languagePlugins.concat(liveDiff, sharedPlugins)
  const editor = new Editor(editorPane.editorHost, {
    cursorLineHighlight: {
      gutterNumber: true,
      gutterBackground: ['fold-gutter'],
      rowBackground: true,
    },
    plugins: editPlugins,
    onChange: (state) => {
      controller?.updateStatus(state)
    },
  })
  controller = new SourceController(topBar, sidebar, statusBar, editor, typeScriptLsp, liveDiff, {
    showEditor: () => {
      liveDiff.setEnabled(false)
      editor.setPlugins(editPlugins)
      editorPane.editorHost.hidden = false
    },
    showDiff: () => {
      editor.setPlugins(diffPlugins)
      editorPane.editorHost.hidden = false
    },
  })

  syncTypeScriptStatus()
  controller.start()
}
