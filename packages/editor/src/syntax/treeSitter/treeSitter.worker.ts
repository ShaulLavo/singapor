import { Edit, Language, Parser, Query, type Node, type Tree } from "web-tree-sitter";
import jsxHighlightQuerySource from "tree-sitter-javascript/queries/highlights-jsx.scm?raw";
import tsxGrammarUrl from "tree-sitter-typescript/tree-sitter-tsx.wasm?url";
import parserWasmUrl from "web-tree-sitter/web-tree-sitter.wasm?url";
import jsFoldQuerySource from "./queries/javascript-folds.scm?raw";
import jsHighlightQuerySource from "./queries/javascript-highlights.scm?raw";
import tsFoldQuerySource from "./queries/typescript-folds.scm?raw";
import tsHighlightQuerySource from "./queries/typescript-highlights.scm?raw";
import type {
  BracketInfo,
  FoldRange,
  TreeSitterCapture,
  TreeSitterEditRequest,
  TreeSitterError,
  TreeSitterParseRequest,
  TreeSitterParseResult,
  TreeSitterWorkerRequest,
  TreeSitterWorkerResponse,
} from "./types";

type CachedTree = {
  readonly tree: Tree;
  readonly text: string;
};

let parserInstance: Parser | null = null;
let languageInstance: Language | null = null;
let highlightQuery: Query | null = null;
let foldQuery: Query | null = null;
let initPromise: Promise<Parser> | null = null;
const treeCache = new Map<string, CachedTree>();

const BRACKET_PAIRS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
};

const OPEN_BRACKETS = new Set(Object.keys(BRACKET_PAIRS));
const CLOSE_BRACKETS = new Set(Object.values(BRACKET_PAIRS));
const HIGHLIGHT_QUERY_SOURCE = [
  tsHighlightQuerySource,
  jsHighlightQuerySource,
  jsxHighlightQuerySource,
].join("\n");
const FOLD_QUERY_SOURCE = [tsFoldQuerySource, jsFoldQuerySource].join("\n");

const createErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const ensureParser = async (): Promise<Parser> => {
  if (parserInstance) return parserInstance;
  if (initPromise) return initPromise;

  initPromise = createParser().catch((error) => {
    initPromise = null;
    throw error;
  });

  return initPromise;
};

const createParser = async (): Promise<Parser> => {
  await Parser.init({ locateFile: () => parserWasmUrl });
  const language = await Language.load(tsxGrammarUrl);
  const parser = new Parser();
  parser.setLanguage(language);
  languageInstance = language;
  parserInstance = parser;
  return parser;
};

const ensureHighlightQuery = async (): Promise<Query> => {
  if (highlightQuery) return highlightQuery;

  const parser = await ensureParser();
  const language = languageInstance ?? parser.language;
  if (!language) throw new Error("Tree-sitter language is not loaded");

  highlightQuery = new Query(language, HIGHLIGHT_QUERY_SOURCE);
  return highlightQuery;
};

const ensureFoldQuery = async (): Promise<Query> => {
  if (foldQuery) return foldQuery;

  const parser = await ensureParser();
  const language = languageInstance ?? parser.language;
  if (!language) throw new Error("Tree-sitter language is not loaded");

  foldQuery = new Query(language, FOLD_QUERY_SOURCE);
  return foldQuery;
};

const parseDocument = async (request: TreeSitterParseRequest): Promise<TreeSitterParseResult> => {
  const parser = await ensureParser();
  const previous = treeCache.get(request.documentId);
  const reusableTree = previous?.text === request.text ? previous.tree : null;
  const tree = parser.parse(request.text, reusableTree);
  if (!tree) throw new Error("Tree-sitter parse returned no tree");

  replaceCachedTree(request.documentId, tree, request.text);
  const result = await processTree(tree);

  return {
    documentId: request.documentId,
    snapshotVersion: request.snapshotVersion,
    languageId: request.languageId,
    ...result,
  };
};

const editDocument = async (request: TreeSitterEditRequest): Promise<TreeSitterParseResult> => {
  const parser = await ensureParser();
  const cached = treeCache.get(request.documentId);
  if (!cached) throw new Error(`Tree-sitter cache miss for "${request.documentId}"`);

  const text = applyTextEdit(
    cached.text,
    request.startIndex,
    request.oldEndIndex,
    request.insertedText,
  );

  cached.tree.edit(new Edit({
    startIndex: request.startIndex,
    oldEndIndex: request.oldEndIndex,
    newEndIndex: request.newEndIndex,
    startPosition: request.startPosition,
    oldEndPosition: request.oldEndPosition,
    newEndPosition: request.newEndPosition,
  }));

  const tree = parser.parse(text, cached.tree);
  if (!tree) throw new Error("Tree-sitter incremental parse returned no tree");

  replaceCachedTree(request.documentId, tree, text);
  const result = await processTree(tree);

  return {
    documentId: request.documentId,
    snapshotVersion: request.snapshotVersion,
    languageId: request.languageId,
    ...result,
  };
};

const applyTextEdit = (
  text: string,
  startIndex: number,
  oldEndIndex: number,
  insertedText: string,
): string => text.slice(0, startIndex) + insertedText + text.slice(oldEndIndex);

const replaceCachedTree = (documentId: string, tree: Tree, text: string): void => {
  const previous = treeCache.get(documentId);
  if (previous?.tree !== tree) previous?.tree.delete();
  treeCache.set(documentId, { tree, text });
};

type ProcessedTree = Pick<TreeSitterParseResult, "captures" | "folds" | "brackets" | "errors">;

const processTree = async (tree: Tree): Promise<ProcessedTree> => {
  const [captures, folds] = await Promise.all([collectCaptures(tree), collectFolds(tree)]);
  const { brackets, errors } = collectTreeData(tree);

  return {
    captures,
    folds,
    brackets,
    errors,
  };
};

const collectCaptures = async (tree: Tree): Promise<TreeSitterCapture[]> => {
  const query = await ensureHighlightQuery();
  const captures: TreeSitterCapture[] = [];
  const seen = new Set<string>();

  for (const match of query.matches(tree.rootNode)) {
    collectMatchCaptures(match.captures, captures, seen);
  }

  captures.sort(
    (left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex,
  );
  return captures;
};

const collectFolds = async (tree: Tree): Promise<FoldRange[]> => {
  const query = await ensureFoldQuery();
  const folds: FoldRange[] = [];
  const seen = new Set<string>();

  for (const match of query.matches(tree.rootNode)) {
    collectMatchFolds(match.captures, folds, seen);
  }

  folds.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  return folds;
};

const collectMatchCaptures = (
  matchCaptures: ReturnType<Query["matches"]>[number]["captures"],
  captures: TreeSitterCapture[],
  seen: Set<string>,
): void => {
  for (const capture of matchCaptures) {
    const startIndex = capture.node.startIndex;
    const endIndex = capture.node.endIndex;
    const captureName = capture.name ?? "";
    const key = `${startIndex}:${endIndex}:${captureName}`;
    if (seen.has(key)) continue;
    if (startIndex >= endIndex) continue;

    seen.add(key);
    captures.push({ startIndex, endIndex, captureName });
  }
};

const collectMatchFolds = (
  matchCaptures: ReturnType<Query["matches"]>[number]["captures"],
  folds: FoldRange[],
  seen: Set<string>,
): void => {
  for (const capture of matchCaptures) {
    const node = capture.node;
    const startLine = node.startPosition.row;
    const endLine = node.endPosition.row;
    if (endLine <= startLine) continue;

    const key = `${startLine}:${endLine}:${node.type}`;
    if (seen.has(key)) continue;

    seen.add(key);
    folds.push({ startLine, endLine, type: node.type });
  }
};

type TreeWalkVisitors = {
  readonly onBracket: (info: BracketInfo) => void;
  readonly onError: (info: TreeSitterError) => void;
};

const collectTreeData = (
  tree: Tree,
): Pick<TreeSitterParseResult, "brackets" | "errors"> => {
  const brackets: BracketInfo[] = [];
  const errors: TreeSitterError[] = [];
  const bracketStack: { char: string; index: number }[] = [];

  walkTree(
    tree.rootNode,
    {
      onBracket: (info) => brackets.push(info),
      onError: (info) => errors.push(info),
    },
    bracketStack,
  );

  return { brackets, errors };
};

const walkTree = (
  node: Node,
  visitors: TreeWalkVisitors,
  bracketStack: { char: string; index: number }[],
): void => {
  collectNodeDiagnostics(node, visitors, bracketStack);

  for (const child of node.children) {
    walkTree(child, visitors, bracketStack);
  }
};

const collectNodeDiagnostics = (
  node: Node,
  visitors: TreeWalkVisitors,
  bracketStack: { char: string; index: number }[],
): void => {
  const bracket = collectBracket(node, bracketStack);
  if (bracket) visitors.onBracket(bracket);

  const error = collectError(node);
  if (error) visitors.onError(error);
};

const collectBracket = (
  node: Node,
  bracketStack: { char: string; index: number }[],
): BracketInfo | null => {
  if (OPEN_BRACKETS.has(node.type)) {
    bracketStack.push({ char: node.type, index: node.startIndex });
    return { index: node.startIndex, char: node.type, depth: bracketStack.length };
  }

  if (!CLOSE_BRACKETS.has(node.type)) return null;

  const depth = bracketStack.length > 0 ? bracketStack.length : 1;
  const last = bracketStack[bracketStack.length - 1];
  if (last && BRACKET_PAIRS[last.char] === node.type) bracketStack.pop();
  return { index: node.startIndex, char: node.type, depth };
};

const collectError = (node: Node): TreeSitterError | null => {
  if (!node.isError && !node.isMissing) return null;

  return {
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    isMissing: node.isMissing,
    message: node.type,
  };
};

const disposeDocument = (documentId: string): void => {
  const cached = treeCache.get(documentId);
  cached?.tree.delete();
  treeCache.delete(documentId);
};

const disposeAll = (): void => {
  for (const cached of treeCache.values()) cached.tree.delete();
  treeCache.clear();
  highlightQuery?.delete();
  highlightQuery = null;
  foldQuery?.delete();
  foldQuery = null;
  parserInstance?.delete();
  parserInstance = null;
  languageInstance = null;
  initPromise = null;
};

const handleRequest = async (
  request: TreeSitterWorkerRequest,
): Promise<TreeSitterParseResult | undefined> => {
  const { payload } = request;

  if (payload.type === "init") {
    await ensureParser();
    return undefined;
  }

  if (payload.type === "parse") return parseDocument(payload);
  if (payload.type === "edit") return editDocument(payload);

  if (payload.type === "disposeDocument") {
    disposeDocument(payload.documentId);
    return undefined;
  }

  disposeAll();
  return undefined;
};

self.onmessage = (event: MessageEvent<TreeSitterWorkerRequest>): void => {
  const request = event.data;
  void handleRequest(request)
    .then((result) => postResponse({ id: request.id, ok: true, result }))
    .catch((error) => {
      postResponse({ id: request.id, ok: false, error: createErrorMessage(error) });
    });
};

const postResponse = (response: TreeSitterWorkerResponse): void => {
  self.postMessage(response);
};
