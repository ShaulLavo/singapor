import type { EditorToken } from "@editor/core";
import type { IncrementalTokenizer } from "@editor/shiki";
import { createIncrementalTokenizer, snapshotToEditorTokens } from "@editor/shiki";

const THEME = "github-dark";

const fileExtensionToLanguage = new Map<string, string>([
  [".cjs", "js"],
  [".css", "css"],
  [".cts", "ts"],
  [".html", "html"],
  [".js", "js"],
  [".json", "json"],
  [".jsx", "jsx"],
  [".md", "md"],
  [".mjs", "js"],
  [".mts", "ts"],
  [".sh", "bash"],
  [".ts", "ts"],
  [".tsx", "tsx"],
]);

const tokenizerCache = new Map<string, ReturnType<typeof createIncrementalTokenizer>>();

export async function resetTokenizerCache() {
  for (const promise of tokenizerCache.values()) {
    try {
      const { highlighter } = await promise;
      highlighter.dispose();
    } catch {
      // Ignore disposal errors for partially-initialized entries
    }
  }
  tokenizerCache.clear();
}

export function inferLanguage(fileName: string): string | null {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const ext = fileName.slice(dotIndex).toLowerCase();
  return fileExtensionToLanguage.get(ext) ?? null;
}

function cacheKey(language: string, theme: string): string {
  return `${language}:${theme}`;
}

async function getTokenizer(language: string): Promise<IncrementalTokenizer> {
  const key = cacheKey(language, THEME);
  const existing = tokenizerCache.get(key);
  if (existing) return (await existing).tokenizer;

  const created = createIncrementalTokenizer({
    code: "",
    lang: language,
    theme: THEME,
  });

  tokenizerCache.set(key, created);

  try {
    return (await created).tokenizer;
  } catch (err) {
    tokenizerCache.delete(key);
    throw err;
  }
}

export async function tokenizeFile(fileName: string, content: string): Promise<EditorToken[]> {
  const language = inferLanguage(fileName);
  if (!language) return [];

  const tokenizer = await getTokenizer(language);
  tokenizer.update(content);
  return snapshotToEditorTokens(tokenizer.getSnapshot());
}
