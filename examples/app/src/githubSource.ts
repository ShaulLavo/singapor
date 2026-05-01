export const REPOSITORY_OWNER = "ShaulLavo";
export const REPOSITORY_NAME = "Editor";
export const REPOSITORY_BRANCH = "main";

const TREE_ENDPOINT = `https://api.github.com/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/git/trees/${REPOSITORY_BRANCH}?recursive=1`;
const RAW_SOURCE_BASE = `https://raw.githubusercontent.com/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/${REPOSITORY_BRANCH}`;
const FETCH_CONCURRENCY = 8;

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".lock",
  ".md",
  ".markdown",
  ".mjs",
  ".scm",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const TEXT_FILENAMES = new Set([".gitignore"]);

type GitHubTreeResponse = {
  readonly sha?: unknown;
  readonly tree?: unknown;
  readonly truncated?: unknown;
};

type GitHubTreeItem = {
  readonly path?: unknown;
  readonly type?: unknown;
  readonly sha?: unknown;
  readonly size?: unknown;
};

export type SourceFile = {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  readonly text: string;
};

export type SourceSnapshot = {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly treeSha: string;
  readonly fetchedAt: number;
  readonly files: readonly SourceFile[];
};

export async function fetchRepositorySource(): Promise<SourceSnapshot> {
  const tree = await fetchRepositoryTree();
  const entries = parseTreeEntries(tree);
  const files = await mapWithConcurrency(entries, FETCH_CONCURRENCY, fetchSourceFile);

  return {
    owner: REPOSITORY_OWNER,
    repo: REPOSITORY_NAME,
    branch: REPOSITORY_BRANCH,
    treeSha: tree.sha,
    fetchedAt: Date.now(),
    files,
  };
}

export function sourceFileRawUrl(path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${RAW_SOURCE_BASE}/${encodedPath}`;
}

export function isSourceTextPath(path: string): boolean {
  if (TEXT_FILENAMES.has(fileName(path))) return true;
  return TEXT_EXTENSIONS.has(extensionForPath(path));
}

async function fetchRepositoryTree(): Promise<{ readonly sha: string; readonly tree: unknown[] }> {
  const response = await fetch(TREE_ENDPOINT);
  if (!response.ok) throw new Error(`GitHub tree fetch failed: ${response.status}`);

  const body = (await response.json()) as GitHubTreeResponse;
  if (body.truncated === true) throw new Error("GitHub tree response was truncated");
  if (typeof body.sha !== "string") throw new Error("GitHub tree response missing sha");
  if (!Array.isArray(body.tree)) throw new Error("GitHub tree response missing tree");

  return { sha: body.sha, tree: body.tree };
}

function parseTreeEntries(tree: { readonly tree: readonly unknown[] }): GitHubTreeFileEntry[] {
  const entries: GitHubTreeFileEntry[] = [];

  for (const item of tree.tree) {
    const entry = parseTreeFileEntry(item);
    if (!entry) continue;
    entries.push(entry);
  }

  return entries.toSorted((left, right) => left.path.localeCompare(right.path));
}

function parseTreeFileEntry(item: unknown): GitHubTreeFileEntry | null {
  const entry = item as GitHubTreeItem;
  if (entry.type !== "blob") return null;
  if (typeof entry.path !== "string") return null;
  if (typeof entry.sha !== "string") return null;
  if (typeof entry.size !== "number") return null;
  if (!isSourceTextPath(entry.path)) return null;

  return {
    path: entry.path,
    sha: entry.sha,
    size: entry.size,
  };
}

type GitHubTreeFileEntry = {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
};

async function fetchSourceFile(entry: GitHubTreeFileEntry): Promise<SourceFile> {
  const response = await fetch(sourceFileRawUrl(entry.path));
  if (!response.ok)
    throw new Error(`GitHub raw fetch failed for ${entry.path}: ${response.status}`);

  return {
    ...entry,
    text: await response.text(),
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R | undefined>({ length: items.length });
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results as R[];
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extensionForPath(path: string): string {
  const name = fileName(path);
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex === -1) return "";
  return name.slice(dotIndex).toLowerCase();
}
