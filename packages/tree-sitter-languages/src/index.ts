// oxlint-disable-next-line typescript-eslint/triple-slash-reference
/// <reference path="./vite-assets.d.ts" />
import { createTreeSitterLanguagePlugin } from "@editor/tree-sitter";
import type { EditorPlugin } from "@editor/core";
import type {
  TreeSitterLanguageAssets,
  TreeSitterLanguageContribution,
  TreeSitterLanguagePluginOptions,
} from "@editor/tree-sitter";

const EMPTY_QUERY = "";

export type JavaScriptTreeSitterLanguageOptions = TreeSitterLanguagePluginOptions & {
  readonly jsx?: boolean;
};

export type TypeScriptTreeSitterLanguageOptions = TreeSitterLanguagePluginOptions & {
  readonly tsx?: boolean;
};

export const JAVASCRIPT_TREE_SITTER_LANGUAGE = createJavaScriptContribution(false);

export const TYPESCRIPT_TREE_SITTER_LANGUAGE = createTypeScriptContribution(false);

export const HTML_TREE_SITTER_LANGUAGE = {
  id: "html",
  extensions: [".htm", ".html"],
  aliases: ["html"],
  load: loadHtmlAssets,
} satisfies TreeSitterLanguageContribution;

export const CSS_TREE_SITTER_LANGUAGE = {
  id: "css",
  extensions: [".css"],
  aliases: ["css"],
  load: loadCssAssets,
} satisfies TreeSitterLanguageContribution;

export const JSON_TREE_SITTER_LANGUAGE = {
  id: "json",
  extensions: [".json"],
  aliases: ["json"],
  load: loadJsonAssets,
} satisfies TreeSitterLanguageContribution;

export const MARKDOWN_TREE_SITTER_LANGUAGE = {
  id: "markdown",
  extensions: [".md", ".markdown"],
  aliases: ["markdown", "md", "gfm"],
  load: loadMarkdownAssets,
} satisfies TreeSitterLanguageContribution;

export const MARKDOWN_INLINE_TREE_SITTER_LANGUAGE = {
  id: "markdown_inline",
  extensions: [],
  aliases: ["markdown_inline"],
  load: loadMarkdownInlineAssets,
} satisfies TreeSitterLanguageContribution;

export const TREE_SITTER_LANGUAGE_CONTRIBUTIONS = [
  createJavaScriptContribution(true),
  createTypeScriptContribution(true),
  HTML_TREE_SITTER_LANGUAGE,
  CSS_TREE_SITTER_LANGUAGE,
  JSON_TREE_SITTER_LANGUAGE,
  MARKDOWN_TREE_SITTER_LANGUAGE,
  MARKDOWN_INLINE_TREE_SITTER_LANGUAGE,
] satisfies readonly TreeSitterLanguageContribution[];

export function javaScript(options: JavaScriptTreeSitterLanguageOptions = {}): EditorPlugin {
  const { jsx = false, ...pluginOptions } = options;
  return createLanguagePlugin(
    createJavaScriptContribution(jsx),
    "tree-sitter-javascript",
    pluginOptions,
  );
}

export function typeScript(options: TypeScriptTreeSitterLanguageOptions = {}): EditorPlugin {
  const { tsx = false, ...pluginOptions } = options;
  return createLanguagePlugin(
    createTypeScriptContribution(tsx),
    "tree-sitter-typescript",
    pluginOptions,
  );
}

export function html(options?: TreeSitterLanguagePluginOptions): EditorPlugin {
  return createLanguagePlugin(HTML_TREE_SITTER_LANGUAGE, "tree-sitter-html", options);
}

export function css(options?: TreeSitterLanguagePluginOptions): EditorPlugin {
  return createLanguagePlugin(CSS_TREE_SITTER_LANGUAGE, "tree-sitter-css", options);
}

export function json(options?: TreeSitterLanguagePluginOptions): EditorPlugin {
  return createLanguagePlugin(JSON_TREE_SITTER_LANGUAGE, "tree-sitter-json", options);
}

export function markdown(options: TreeSitterLanguagePluginOptions = {}): EditorPlugin {
  return createTreeSitterLanguagePlugin(
    [MARKDOWN_TREE_SITTER_LANGUAGE, MARKDOWN_INLINE_TREE_SITTER_LANGUAGE],
    {
      ...options,
      name: options.name ?? "tree-sitter-markdown",
    },
  );
}

function createLanguagePlugin(
  contribution: TreeSitterLanguageContribution,
  name: string,
  options: TreeSitterLanguagePluginOptions = {},
): EditorPlugin {
  return createTreeSitterLanguagePlugin([contribution], {
    ...options,
    name: options.name ?? name,
  });
}

function createJavaScriptContribution(jsx: boolean): TreeSitterLanguageContribution {
  return {
    id: "javascript",
    extensions: jsx ? [".cjs", ".js", ".jsx", ".mjs"] : [".cjs", ".js", ".mjs"],
    aliases: jsx ? ["javascript", "js", "jsx", "node", "react"] : ["javascript", "js", "node"],
    load: () => loadJavaScriptAssets(jsx),
  };
}

function createTypeScriptContribution(tsx: boolean): TreeSitterLanguageContribution {
  return {
    id: "typescript",
    extensions: tsx ? [".cts", ".mts", ".ts", ".tsx"] : [".cts", ".mts", ".ts"],
    aliases: tsx ? ["typescript", "ts", "tsx", "react"] : ["typescript", "ts"],
    load: () => loadTypeScriptAssets(tsx),
  };
}

async function loadJavaScriptAssets(jsx: boolean): Promise<TreeSitterLanguageAssets> {
  const [wasmUrl, highlightQuerySource, foldQuerySource, injectionQuerySource] = await Promise.all([
    loadDefault(import("tree-sitter-javascript/tree-sitter-javascript.wasm?url")),
    loadDefault(import("./queries/javascript-highlights.scm?raw")),
    loadDefault(import("./queries/javascript-folds.scm?raw")),
    loadDefault(import("tree-sitter-javascript/queries/injections.scm?raw")),
  ]);
  if (!jsx) return { wasmUrl, highlightQuerySource, foldQuerySource, injectionQuerySource };

  const jsxHighlightQuerySource = await loadDefault(
    import("tree-sitter-javascript/queries/highlights-jsx.scm?raw"),
  );
  return {
    wasmUrl,
    highlightQuerySource: [highlightQuerySource, jsxHighlightQuerySource].join("\n"),
    foldQuerySource,
    injectionQuerySource,
  };
}

async function loadTypeScriptAssets(tsx: boolean): Promise<TreeSitterLanguageAssets> {
  const [
    wasmUrl,
    tsHighlightQuerySource,
    jsHighlightQuerySource,
    tsFoldQuerySource,
    jsFoldQuerySource,
    injectionQuerySource,
  ] = await Promise.all([
    loadDefault(
      tsx
        ? import("tree-sitter-typescript/tree-sitter-tsx.wasm?url")
        : import("tree-sitter-typescript/tree-sitter-typescript.wasm?url"),
    ),
    loadDefault(import("./queries/typescript-highlights.scm?raw")),
    loadDefault(import("./queries/javascript-highlights.scm?raw")),
    loadDefault(import("./queries/typescript-folds.scm?raw")),
    loadDefault(import("./queries/javascript-folds.scm?raw")),
    loadDefault(import("tree-sitter-javascript/queries/injections.scm?raw")),
  ]);
  const highlightQuerySource = await typeScriptHighlightQuerySource(tsx, [
    tsHighlightQuerySource,
    jsHighlightQuerySource,
  ]);
  return {
    wasmUrl,
    highlightQuerySource,
    foldQuerySource: [tsFoldQuerySource, jsFoldQuerySource].join("\n"),
    injectionQuerySource,
  };
}

async function typeScriptHighlightQuerySource(
  tsx: boolean,
  sources: readonly string[],
): Promise<string> {
  if (!tsx) return sources.join("\n");

  const jsxHighlightQuerySource = await loadDefault(
    import("tree-sitter-javascript/queries/highlights-jsx.scm?raw"),
  );
  return [...sources, jsxHighlightQuerySource].join("\n");
}

async function loadHtmlAssets(): Promise<TreeSitterLanguageAssets> {
  return {
    wasmUrl: await loadDefault(import("tree-sitter-html/tree-sitter-html.wasm?url")),
    highlightQuerySource: await loadDefault(import("tree-sitter-html/queries/highlights.scm?raw")),
    foldQuerySource: "(element) @fold\n(script_element) @fold\n(style_element) @fold",
    injectionQuerySource: await loadDefault(import("tree-sitter-html/queries/injections.scm?raw")),
  };
}

async function loadCssAssets(): Promise<TreeSitterLanguageAssets> {
  return {
    wasmUrl: await loadDefault(import("tree-sitter-css/tree-sitter-css.wasm?url")),
    highlightQuerySource: await loadDefault(import("tree-sitter-css/queries/highlights.scm?raw")),
    foldQuerySource: "(block) @fold\n(rule_set) @fold",
    injectionQuerySource: EMPTY_QUERY,
  };
}

async function loadJsonAssets(): Promise<TreeSitterLanguageAssets> {
  return {
    wasmUrl: await loadDefault(import("tree-sitter-json/tree-sitter-json.wasm?url")),
    highlightQuerySource: await loadDefault(import("tree-sitter-json/queries/highlights.scm?raw")),
    foldQuerySource: "(object) @fold\n(array) @fold",
    injectionQuerySource: EMPTY_QUERY,
  };
}

async function loadMarkdownAssets(): Promise<TreeSitterLanguageAssets> {
  return {
    wasmUrl: await loadDefault(import("./grammars/tree-sitter-markdown.wasm?url")),
    highlightQuerySource: await loadDefault(import("./queries/markdown-highlights.scm?raw")),
    foldQuerySource: await loadDefault(import("./queries/markdown-folds.scm?raw")),
    injectionQuerySource: await loadDefault(import("./queries/markdown-injections.scm?raw")),
  };
}

async function loadMarkdownInlineAssets(): Promise<TreeSitterLanguageAssets> {
  return {
    wasmUrl: await loadDefault(import("./grammars/tree-sitter-markdown-inline.wasm?url")),
    highlightQuerySource: await loadDefault(import("./queries/markdown-inline-highlights.scm?raw")),
    foldQuerySource: EMPTY_QUERY,
    injectionQuerySource: await loadDefault(import("./queries/markdown-inline-injections.scm?raw")),
  };
}

async function loadDefault(module: Promise<{ readonly default: string }>): Promise<string> {
  return (await module).default;
}
