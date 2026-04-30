import {
  Edit,
  Language,
  Parser,
  Query,
  type Node,
  type Range as TreeSitterRange,
  type Tree,
} from "web-tree-sitter";
import parserWasmUrl from "web-tree-sitter/web-tree-sitter.wasm?url";
import type { TreeSitterLanguageDescriptor } from "./registry";
import {
  clearTreeSitterSourceCache,
  disposeTreeSitterSourceDocument,
  readTreeSitterInputRange,
  readTreeSitterPieceTableInput,
  resolveTreeSitterSourceDescriptor,
  type TreeSitterSourceCache,
  type TreeSitterPieceTableInput,
} from "./source";
import type {
  BracketInfo,
  FoldRange,
  TreeSitterCapture,
  TreeSitterEditRequest,
  TreeSitterError,
  TreeSitterInjectionInfo,
  TreeSitterLanguageId,
  TreeSitterParseRequest,
  TreeSitterParseResult,
  TreeSitterSelectionRange,
  TreeSitterSelectionRequest,
  TreeSitterSelectionResult,
  TreeSitterWorkerRequest,
  TreeSitterWorkerResult,
  TreeSitterWorkerResponse,
} from "./types";

type Runtime = {
  readonly descriptor: TreeSitterLanguageDescriptor;
  readonly language: Language;
  readonly parser: Parser;
  highlightQuery: Query | null;
  foldQuery: Query | null;
  injectionQuery: Query | null;
};

type CachedSyntaxSnapshot = {
  readonly snapshotVersion: number;
  readonly languageId: TreeSitterLanguageId;
  readonly tree: Tree;
  readonly source: TreeSitterPieceTableInput;
  readonly injectedTrees: readonly Tree[];
  readonly size: number;
  lastUsed: number;
};

type DocumentCache = {
  readonly documentId: string;
  readonly snapshots: CachedSyntaxSnapshot[];
};

type CancellationContext = {
  readonly startedAt: number;
  readonly budgetMs: number;
  readonly flag: Int32Array | null;
};

type ProcessedTree = Pick<
  TreeSitterParseResult,
  "captures" | "folds" | "brackets" | "errors" | "injections"
> & {
  readonly injectedTrees: readonly Tree[];
};

type InjectionSpec = {
  readonly parentLanguageId: TreeSitterLanguageId;
  readonly languageId: TreeSitterLanguageId;
  readonly ranges: readonly TreeSitterRange[];
};

type TreeWalkVisitors = {
  readonly onBracket: (info: BracketInfo) => void;
  readonly onError: (info: TreeSitterError) => void;
};

const BRACKET_PAIRS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
};

const OPEN_BRACKETS = new Set(Object.keys(BRACKET_PAIRS));
const CLOSE_BRACKETS = new Set(Object.values(BRACKET_PAIRS));
const MAX_RETAINED_SNAPSHOTS = 6;
const MAX_RETAINED_SOURCE_UNITS = 8_000_000;
const MAX_INJECTION_DEPTH = 2;
const PARSE_BUDGET_MS = 20_000;
const QUERY_BUDGET_MS = 20_000;

let parserInitPromise: Promise<void> | null = null;
let nextUse = 1;
const languageDescriptors = new Map<TreeSitterLanguageId, TreeSitterLanguageDescriptor>();
const languageDescriptorOrder: TreeSitterLanguageId[] = [];
const runtimePromises = new Map<TreeSitterLanguageId, Promise<Runtime>>();
const documentCaches = new Map<string, DocumentCache>();
const sourceCache: TreeSitterSourceCache = new Map();

class SyntaxRequestCancelled extends Error {
  public constructor() {
    super("Tree-sitter request cancelled");
  }
}

const createErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const ensureParserRuntime = async (): Promise<void> => {
  if (parserInitPromise) return parserInitPromise;

  parserInitPromise = Parser.init({ locateFile: () => parserWasmUrl }).catch((error) => {
    parserInitPromise = null;
    throw error;
  });
  return parserInitPromise;
};

const registerLanguages = (descriptors: readonly TreeSitterLanguageDescriptor[]): void => {
  for (const descriptor of descriptors) registerLanguage(descriptor);
};

const registerLanguage = (descriptor: TreeSitterLanguageDescriptor): void => {
  const normalized = normalizeLanguageDescriptor(descriptor);
  const existing = languageDescriptors.get(normalized.id);

  languageDescriptors.set(normalized.id, normalized);
  moveLanguageToEnd(normalized.id);

  if (!existing) return;
  if (languageDescriptorsEqual(existing, normalized)) return;

  disposeRuntimeForLanguage(normalized.id);
  disposeCachedSnapshotsForLanguage(normalized.id);
};

const ensureRuntime = async (languageId: TreeSitterLanguageId): Promise<Runtime> => {
  const existing = runtimePromises.get(languageId);
  if (existing) return existing;

  const promise = createRuntime(languageId);
  runtimePromises.set(languageId, promise);
  return promise;
};

const createRuntime = async (languageId: TreeSitterLanguageId): Promise<Runtime> => {
  await ensureParserRuntime();

  const descriptor = languageDescriptors.get(languageId);
  if (!descriptor) throw new Error(`Tree-sitter language "${languageId}" is not registered`);

  const language = await Language.load(descriptor.wasmUrl);
  const parser = new Parser();
  parser.setLanguage(language);

  return {
    descriptor,
    language,
    parser,
    highlightQuery: null,
    foldQuery: null,
    injectionQuery: null,
  };
};

const ensureQuery = (runtime: Runtime, kind: "highlight" | "fold" | "injection"): Query | null => {
  if (kind === "highlight") return ensureHighlightQuery(runtime);
  if (kind === "fold") return ensureFoldQuery(runtime);
  return ensureInjectionQuery(runtime);
};

const ensureHighlightQuery = (runtime: Runtime): Query | null => {
  if (!runtime.descriptor.highlightQuerySource) return null;
  if (runtime.descriptor.highlightQuerySource.trim().length === 0) return null;
  if (runtime.highlightQuery) return runtime.highlightQuery;

  runtime.highlightQuery = new Query(runtime.language, runtime.descriptor.highlightQuerySource);
  return runtime.highlightQuery;
};

const ensureFoldQuery = (runtime: Runtime): Query | null => {
  if (!runtime.descriptor.foldQuerySource) return null;
  if (runtime.foldQuery) return runtime.foldQuery;

  runtime.foldQuery = new Query(runtime.language, runtime.descriptor.foldQuerySource);
  return runtime.foldQuery;
};

const ensureInjectionQuery = (runtime: Runtime): Query | null => {
  if (!runtime.descriptor.injectionQuerySource) return null;
  if (runtime.descriptor.injectionQuerySource.trim().length === 0) return null;
  if (runtime.injectionQuery) return runtime.injectionQuery;

  runtime.injectionQuery = new Query(runtime.language, runtime.descriptor.injectionQuerySource);
  return runtime.injectionQuery;
};

const parseDocument = async (
  request: TreeSitterParseRequest,
): Promise<TreeSitterParseResult | undefined> =>
  runCancellableRequest(request, async (context) => {
    const runtime = await ensureRuntime(request.languageId);
    const source = resolveTreeSitterSourceDescriptor(
      sourceCache,
      request.documentId,
      request.source,
    );
    const parseStart = nowMs();
    const tree = parseSource(runtime.parser, source, null, context);
    const parseMs = nowMs() - parseStart;
    const queryStart = nowMs();
    const result = await processTree(tree, runtime, source, context, 0, request.includeHighlights);
    const queryMs = nowMs() - queryStart;

    replaceCachedSnapshot(request.documentId, {
      snapshotVersion: request.snapshotVersion,
      languageId: request.languageId,
      tree,
      source,
      injectedTrees: result.injectedTrees,
      size: source.length,
      lastUsed: nextUse++,
    });

    return {
      documentId: request.documentId,
      snapshotVersion: request.snapshotVersion,
      languageId: request.languageId,
      captures: result.captures,
      folds: result.folds,
      brackets: result.brackets,
      errors: result.errors,
      injections: result.injections,
      timings: [
        { name: "treeSitter.parse", durationMs: parseMs },
        { name: "treeSitter.query", durationMs: queryMs },
      ],
    };
  });

const editDocument = async (
  request: TreeSitterEditRequest,
): Promise<TreeSitterParseResult | undefined> =>
  runCancellableRequest(request, async (context) => {
    const runtime = await ensureRuntime(request.languageId);
    const cached = latestCachedSnapshot(request.documentId, request.languageId);
    if (!cached) throw new Error(`Tree-sitter cache miss for "${request.documentId}"`);

    const editStart = nowMs();
    const reusableTree = editReusableTree(cached.tree, request.inputEdits);
    const editMs = nowMs() - editStart;
    const source = resolveTreeSitterSourceDescriptor(
      sourceCache,
      request.documentId,
      request.source,
    );
    const parseStart = nowMs();
    const tree = parseSource(runtime.parser, source, reusableTree, context);
    const parseMs = nowMs() - parseStart;
    reusableTree.delete();

    const queryStart = nowMs();
    const result = await processTree(tree, runtime, source, context, 0, request.includeHighlights);
    const queryMs = nowMs() - queryStart;
    replaceCachedSnapshot(request.documentId, {
      snapshotVersion: request.snapshotVersion,
      languageId: request.languageId,
      tree,
      source,
      injectedTrees: result.injectedTrees,
      size: source.length,
      lastUsed: nextUse++,
    });

    return {
      documentId: request.documentId,
      snapshotVersion: request.snapshotVersion,
      languageId: request.languageId,
      captures: result.captures,
      folds: result.folds,
      brackets: result.brackets,
      errors: result.errors,
      injections: result.injections,
      timings: [
        { name: "treeSitter.edit", durationMs: editMs },
        { name: "treeSitter.parse", durationMs: parseMs },
        { name: "treeSitter.query", durationMs: queryMs },
      ],
    };
  });

const runCancellableRequest = async <
  TRequest extends TreeSitterParseRequest | TreeSitterEditRequest,
>(
  request: TRequest,
  run: (context: CancellationContext) => Promise<TreeSitterParseResult>,
): Promise<TreeSitterParseResult | undefined> => {
  const context = createCancellationContext(request.cancellationBuffer, PARSE_BUDGET_MS);

  try {
    return await run(context);
  } catch (error) {
    if (error instanceof SyntaxRequestCancelled) return undefined;
    throw error;
  }
};

const createCancellationContext = (
  cancellationBuffer: SharedArrayBuffer | undefined,
  budgetMs: number,
): CancellationContext => ({
  startedAt: nowMs(),
  budgetMs,
  flag: cancellationBuffer ? new Int32Array(cancellationBuffer) : null,
});

const parseSource = (
  parser: Parser,
  source: TreeSitterPieceTableInput,
  oldTree: Tree | null,
  context: CancellationContext,
): Tree => {
  const tree = parser.parse((index) => readTreeSitterPieceTableInput(source, index), oldTree, {
    progressCallback: () => isCancelled(context),
  });
  if (tree) return tree;
  if (isCancelled(context)) throw new SyntaxRequestCancelled();
  throw new Error("Tree-sitter parse returned no tree");
};

const editReusableTree = (
  tree: Tree,
  edits: readonly TreeSitterEditRequest["inputEdits"][number][],
): Tree => {
  const reusableTree = tree.copy();
  for (const inputEdit of edits) {
    reusableTree.edit(new Edit(inputEdit));
  }

  return reusableTree;
};

const processTree = async (
  tree: Tree,
  runtime: Runtime,
  source: TreeSitterPieceTableInput,
  context: CancellationContext,
  injectionDepth: number,
  includeHighlights: boolean,
): Promise<ProcessedTree> => {
  const queryContext = { ...context, budgetMs: QUERY_BUDGET_MS };
  const captures = includeHighlights ? collectCaptures(tree, runtime, queryContext) : [];
  const folds = collectFolds(tree, runtime, queryContext);
  const treeData = collectTreeData(tree);
  const injected = await collectInjectedTrees(
    tree,
    runtime,
    source,
    queryContext,
    injectionDepth,
    includeHighlights,
  );

  return {
    captures: mergeCaptures(captures, injected.captures),
    folds: mergeFolds(folds, injected.folds),
    brackets: [...treeData.brackets, ...injected.brackets],
    errors: [...treeData.errors, ...injected.errors],
    injections: injected.injections,
    injectedTrees: injected.injectedTrees,
  };
};

const collectCaptures = (
  tree: Tree,
  runtime: Runtime,
  context: CancellationContext,
): TreeSitterCapture[] => {
  const query = ensureQuery(runtime, "highlight");
  if (!query) return [];

  const captures: TreeSitterCapture[] = [];
  const seen = new Set<string>();
  const matches = query.matches(tree.rootNode, { progressCallback: () => isCancelled(context) });
  assertNotCancelled(context);

  for (const match of matches) {
    collectMatchCaptures(match.captures, captures, seen, runtime.descriptor.id);
  }

  return captures;
};

const collectFolds = (tree: Tree, runtime: Runtime, context: CancellationContext): FoldRange[] => {
  const query = ensureQuery(runtime, "fold");
  if (!query) return [];

  const folds: FoldRange[] = [];
  const seen = new Set<string>();
  const matches = query.matches(tree.rootNode, { progressCallback: () => isCancelled(context) });
  assertNotCancelled(context);

  for (const match of matches) {
    collectMatchFolds(match.captures, folds, seen, runtime.descriptor.id);
  }

  return folds;
};

const collectMatchCaptures = (
  matchCaptures: ReturnType<Query["matches"]>[number]["captures"],
  captures: TreeSitterCapture[],
  seen: Set<string>,
  languageId: TreeSitterLanguageId,
): void => {
  for (const capture of matchCaptures) {
    const startIndex = capture.node.startIndex;
    const endIndex = capture.node.endIndex;
    const captureName = capture.name ?? "";
    const key = `${startIndex}:${endIndex}:${captureName}:${languageId}`;
    if (seen.has(key)) continue;
    if (startIndex >= endIndex) continue;

    seen.add(key);
    captures.push({ startIndex, endIndex, captureName, languageId });
  }
};

const collectMatchFolds = (
  matchCaptures: ReturnType<Query["matches"]>[number]["captures"],
  folds: FoldRange[],
  seen: Set<string>,
  languageId: TreeSitterLanguageId,
): void => {
  for (const capture of matchCaptures) {
    const node = capture.node;
    const startLine = node.startPosition.row;
    const endLine = node.endPosition.row;
    if (endLine <= startLine) continue;

    const key = `${node.startIndex}:${node.endIndex}:${node.type}:${languageId}`;
    if (seen.has(key)) continue;

    seen.add(key);
    folds.push({
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      startLine,
      endLine,
      type: node.type,
      languageId,
    });
  }
};

const collectInjectedTrees = async (
  tree: Tree,
  runtime: Runtime,
  source: TreeSitterPieceTableInput,
  context: CancellationContext,
  depth: number,
  includeHighlights: boolean,
): Promise<ProcessedTree> => {
  if (depth >= MAX_INJECTION_DEPTH) return createEmptyProcessedTree();

  const query = ensureQuery(runtime, "injection");
  if (!query) return createEmptyProcessedTree();

  const matches = query.matches(tree.rootNode, { progressCallback: () => isCancelled(context) });
  assertNotCancelled(context);

  const specs = injectionSpecsForMatches(matches, source, runtime.descriptor.id);
  return processInjectionSpecs(specs, source, context, depth, includeHighlights);
};

const injectionSpecsForMatches = (
  matches: readonly ReturnType<Query["matches"]>[number][],
  source: TreeSitterPieceTableInput,
  parentLanguageId: TreeSitterLanguageId,
): InjectionSpec[] => {
  const specs: InjectionSpec[] = [];

  for (const match of matches) {
    const languageId = languageIdForInjectionMatch(match, source);
    if (!languageId) continue;

    const ranges = match.captures
      .filter((capture) => capture.name === "injection.content")
      .map((capture) => rangeForNode(capture.node));
    if (ranges.length === 0) continue;

    specs.push({ parentLanguageId, languageId, ranges });
  }

  return specs;
};

const languageIdForInjectionMatch = (
  match: ReturnType<Query["matches"]>[number],
  source: TreeSitterPieceTableInput,
): TreeSitterLanguageId | null => {
  const setLanguage = match.setProperties?.["injection.language"];
  const languageId = resolveRegisteredLanguageAlias(setLanguage);
  if (languageId) return languageId;

  const languageCapture = match.captures.find((capture) => capture.name === "injection.language");
  if (!languageCapture) return null;

  const languageName = readTreeSitterInputRange(
    source,
    languageCapture.node.startIndex,
    languageCapture.node.endIndex,
  );
  return resolveRegisteredLanguageAlias(languageName);
};

const resolveRegisteredLanguageAlias = (
  alias: string | null | undefined,
): TreeSitterLanguageId | null => {
  if (!alias) return null;

  const normalized = alias.trim().toLowerCase();
  if (!normalized) return null;

  for (let index = languageDescriptorOrder.length - 1; index >= 0; index -= 1) {
    const languageId = languageDescriptorOrder[index]!;
    const descriptor = languageDescriptors.get(languageId);
    if (!descriptor) continue;
    if (descriptor.id.toLowerCase() === normalized) return descriptor.id;
    if (descriptor.aliases.map((item) => item.toLowerCase()).includes(normalized)) {
      return descriptor.id;
    }
  }

  return null;
};

const processInjectionSpecs = async (
  specs: readonly InjectionSpec[],
  source: TreeSitterPieceTableInput,
  context: CancellationContext,
  depth: number,
  includeHighlights: boolean,
): Promise<ProcessedTree> => {
  const result = createEmptyProcessedTree();

  for (const spec of specs) {
    const processed = await processInjectionSpec(spec, source, context, depth, includeHighlights);
    mergeProcessedTree(result, processed);
  }

  return result;
};

const processInjectionSpec = async (
  spec: InjectionSpec,
  source: TreeSitterPieceTableInput,
  context: CancellationContext,
  depth: number,
  includeHighlights: boolean,
): Promise<ProcessedTree> => {
  const runtime = await ensureRuntime(spec.languageId);
  const tree = parseInjectedSource(runtime.parser, source, spec.ranges, context);
  const processed = await processTree(tree, runtime, source, context, depth + 1, includeHighlights);
  const injection = injectionInfoForSpec(spec);

  return {
    ...processed,
    injections: [injection, ...processed.injections],
    injectedTrees: [tree, ...processed.injectedTrees],
  };
};

const parseInjectedSource = (
  parser: Parser,
  source: TreeSitterPieceTableInput,
  ranges: readonly TreeSitterRange[],
  context: CancellationContext,
): Tree => {
  const tree = parser.parse((index) => readTreeSitterPieceTableInput(source, index), null, {
    includedRanges: [...ranges],
    progressCallback: () => isCancelled(context),
  });
  if (tree) return tree;
  if (isCancelled(context)) throw new SyntaxRequestCancelled();
  throw new Error("Tree-sitter injection parse returned no tree");
};

const injectionInfoForSpec = (spec: InjectionSpec): TreeSitterInjectionInfo => {
  const startIndex = Math.min(...spec.ranges.map((range) => range.startIndex));
  const endIndex = Math.max(...spec.ranges.map((range) => range.endIndex));

  return {
    parentLanguageId: spec.parentLanguageId,
    languageId: spec.languageId,
    startIndex,
    endIndex,
  };
};

const rangeForNode = (node: Node): TreeSitterRange => ({
  startIndex: node.startIndex,
  endIndex: node.endIndex,
  startPosition: node.startPosition,
  endPosition: node.endPosition,
});

const collectTreeData = (tree: Tree): Pick<TreeSitterParseResult, "brackets" | "errors"> => {
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

const selectDocument = async (
  request: TreeSitterSelectionRequest,
): Promise<TreeSitterSelectionResult> => {
  const runtime = await ensureRuntime(request.languageId);
  const cached = cachedSnapshotForVersion(
    request.documentId,
    request.languageId,
    request.snapshotVersion,
  );

  if (!cached) return staleSelectionResult(request);

  cached.lastUsed = nextUse++;
  return {
    documentId: request.documentId,
    snapshotVersion: request.snapshotVersion,
    languageId: request.languageId,
    status: "ok",
    ranges: request.ranges.map((range) =>
      selectionRangeForAction(runtime, cached.tree, request.action, range),
    ),
  };
};

const selectionRangeForAction = (
  _runtime: Runtime,
  tree: Tree,
  action: TreeSitterSelectionRequest["action"],
  range: TreeSitterSelectionRange,
): TreeSitterSelectionRange => {
  if (action === "selectToken") return tokenRangeAt(tree.rootNode, range);
  return expandedRangeAt(tree.rootNode, range);
};

const tokenRangeAt = (root: Node, range: TreeSitterSelectionRange): TreeSitterSelectionRange => {
  const index = clampSelectionIndex(root, range.startIndex);
  const node = nonEmptyNode(root.descendantForIndex(index, index), root);
  return rangeForSelectionNode(node);
};

const expandedRangeAt = (root: Node, range: TreeSitterSelectionRange): TreeSitterSelectionRange => {
  const node = root.namedDescendantForIndex(range.startIndex, range.endIndex) ?? root;
  const containing = containingNamedNode(node, range);
  return rangeForSelectionNode(containing);
};

const containingNamedNode = (node: Node, range: TreeSitterSelectionRange): Node => {
  let current: Node | null = node;

  while (current) {
    if (current.isNamed && strictlyContainsRange(current, range)) return current;
    current = current.parent;
  }

  return node.tree.rootNode;
};

const nonEmptyNode = (node: Node | null, fallback: Node): Node => {
  let current = node;

  while (current) {
    if (current.endIndex > current.startIndex) return current;
    current = current.parent;
  }

  return fallback;
};

const rangeForSelectionNode = (node: Node): TreeSitterSelectionRange => ({
  startIndex: node.startIndex,
  endIndex: node.endIndex,
});

const strictlyContainsRange = (node: Node, range: TreeSitterSelectionRange): boolean => {
  if (node.startIndex > range.startIndex) return false;
  if (node.endIndex < range.endIndex) return false;
  return node.startIndex < range.startIndex || node.endIndex > range.endIndex;
};

const clampSelectionIndex = (root: Node, index: number): number => {
  if (root.endIndex <= root.startIndex) return root.startIndex;
  return Math.max(root.startIndex, Math.min(index, root.endIndex - 1));
};

const staleSelectionResult = (request: TreeSitterSelectionRequest): TreeSitterSelectionResult => ({
  documentId: request.documentId,
  snapshotVersion: request.snapshotVersion,
  languageId: request.languageId,
  status: "stale",
  ranges: request.ranges,
});

const replaceCachedSnapshot = (documentId: string, snapshot: CachedSyntaxSnapshot): void => {
  const cache = ensureDocumentCache(documentId);
  const existingIndex = cache.snapshots.findIndex(
    (item) => item.snapshotVersion === snapshot.snapshotVersion,
  );

  if (existingIndex !== -1) {
    const existing = cache.snapshots.splice(existingIndex, 1, snapshot)[0];
    if (existing) disposeCachedSnapshot(existing);
  } else {
    cache.snapshots.push(snapshot);
  }

  evictCachedSnapshots(cache);
};

const ensureDocumentCache = (documentId: string): DocumentCache => {
  const existing = documentCaches.get(documentId);
  if (existing) return existing;

  const cache = { documentId, snapshots: [] };
  documentCaches.set(documentId, cache);
  return cache;
};

const latestCachedSnapshot = (
  documentId: string,
  languageId: TreeSitterLanguageId,
): CachedSyntaxSnapshot | null => {
  const cache = documentCaches.get(documentId);
  if (!cache) return null;

  const matching = cache.snapshots.filter((snapshot) => snapshot.languageId === languageId);
  matching.sort((left, right) => right.snapshotVersion - left.snapshotVersion);
  const snapshot = matching[0] ?? null;
  if (snapshot) snapshot.lastUsed = nextUse++;
  return snapshot;
};

const cachedSnapshotForVersion = (
  documentId: string,
  languageId: TreeSitterLanguageId,
  snapshotVersion: number,
): CachedSyntaxSnapshot | null => {
  const cache = documentCaches.get(documentId);
  if (!cache) return null;

  return (
    cache.snapshots.find((snapshot) => {
      return snapshot.languageId === languageId && snapshot.snapshotVersion === snapshotVersion;
    }) ?? null
  );
};

const evictCachedSnapshots = (cache: DocumentCache): void => {
  cache.snapshots.sort((left, right) => right.snapshotVersion - left.snapshotVersion);

  while (cache.snapshots.length > MAX_RETAINED_SNAPSHOTS) {
    disposeOldestRetainedSnapshot(cache.snapshots);
  }

  while (retainedSourceUnits(cache.snapshots) > MAX_RETAINED_SOURCE_UNITS) {
    if (cache.snapshots.length <= 2) return;
    disposeOldestRetainedSnapshot(cache.snapshots);
  }
};

const disposeOldestRetainedSnapshot = (snapshots: CachedSyntaxSnapshot[]): void => {
  let oldestIndex = Math.min(2, snapshots.length - 1);

  for (let index = oldestIndex + 1; index < snapshots.length; index++) {
    if (snapshots[index]!.lastUsed >= snapshots[oldestIndex]!.lastUsed) continue;
    oldestIndex = index;
  }

  const [oldest] = snapshots.splice(oldestIndex, 1);
  if (oldest) disposeCachedSnapshot(oldest);
};

const retainedSourceUnits = (snapshots: readonly CachedSyntaxSnapshot[]): number =>
  snapshots.reduce((sum, snapshot) => sum + snapshot.size, 0);

const disposeCachedSnapshot = (snapshot: CachedSyntaxSnapshot): void => {
  snapshot.tree.delete();
  for (const tree of snapshot.injectedTrees) tree.delete();
};

const disposeDocument = (documentId: string): void => {
  const cache = documentCaches.get(documentId);
  disposeTreeSitterSourceDocument(sourceCache, documentId);
  if (!cache) return;

  for (const snapshot of cache.snapshots) disposeCachedSnapshot(snapshot);
  documentCaches.delete(documentId);
};

const disposeCachedSnapshotsForLanguage = (languageId: TreeSitterLanguageId): void => {
  for (const cache of documentCaches.values()) {
    disposeCachedSnapshotsMatchingLanguage(cache, languageId);
  }
};

const disposeCachedSnapshotsMatchingLanguage = (
  cache: DocumentCache,
  languageId: TreeSitterLanguageId,
): void => {
  const retained: CachedSyntaxSnapshot[] = [];

  for (const snapshot of cache.snapshots) {
    if (snapshot.languageId !== languageId) {
      retained.push(snapshot);
      continue;
    }

    disposeCachedSnapshot(snapshot);
  }

  cache.snapshots.length = 0;
  cache.snapshots.push(...retained);
};

const disposeAll = (): void => {
  for (const cache of documentCaches.values()) {
    for (const snapshot of cache.snapshots) disposeCachedSnapshot(snapshot);
  }

  documentCaches.clear();
  clearTreeSitterSourceCache(sourceCache);
  languageDescriptors.clear();
  languageDescriptorOrder.length = 0;
  for (const promise of runtimePromises.values()) {
    void promise.then(disposeRuntime).catch(() => undefined);
  }
  runtimePromises.clear();
  parserInitPromise = null;
};

const disposeRuntime = (runtime: Runtime): void => {
  runtime.highlightQuery?.delete();
  runtime.foldQuery?.delete();
  runtime.injectionQuery?.delete();
  runtime.parser.delete();
};

const disposeRuntimeForLanguage = (languageId: TreeSitterLanguageId): void => {
  const runtime = runtimePromises.get(languageId);
  if (!runtime) return;

  runtimePromises.delete(languageId);
  void runtime.then(disposeRuntime).catch(() => undefined);
};

const normalizeLanguageDescriptor = (
  descriptor: TreeSitterLanguageDescriptor,
): TreeSitterLanguageDescriptor => ({
  id: normalizeLanguageId(descriptor.id),
  wasmUrl: normalizeWasmUrl(descriptor.wasmUrl, descriptor.id),
  extensions: uniqueItems(descriptor.extensions.map(normalizeExtension)),
  aliases: uniqueItems(descriptor.aliases.map(normalizeAlias)),
  highlightQuerySource: descriptor.highlightQuerySource,
  foldQuerySource: descriptor.foldQuerySource,
  injectionQuerySource: descriptor.injectionQuerySource,
});

const moveLanguageToEnd = (languageId: TreeSitterLanguageId): void => {
  const index = languageDescriptorOrder.indexOf(languageId);
  if (index !== -1) languageDescriptorOrder.splice(index, 1);
  languageDescriptorOrder.push(languageId);
};

const languageDescriptorsEqual = (
  left: TreeSitterLanguageDescriptor,
  right: TreeSitterLanguageDescriptor,
): boolean =>
  left.id === right.id &&
  left.wasmUrl === right.wasmUrl &&
  sameItems(left.extensions, right.extensions) &&
  sameItems(left.aliases, right.aliases) &&
  left.highlightQuerySource === right.highlightQuerySource &&
  left.foldQuerySource === right.foldQuerySource &&
  left.injectionQuerySource === right.injectionQuerySource;

const sameItems = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
};

const normalizeLanguageId = (languageId: string): TreeSitterLanguageId => {
  const normalized = languageId.trim();
  if (normalized) return normalized;

  throw new Error("Tree-sitter language id cannot be empty");
};

const normalizeWasmUrl = (wasmUrl: string, languageId: string): string => {
  const normalized = wasmUrl.trim();
  if (normalized) return normalized;

  throw new Error(`Tree-sitter language "${languageId}" is missing a wasmUrl`);
};

const normalizeExtension = (extension: string): string => {
  const normalized = extension.trim().toLowerCase();
  if (!normalized) throw new Error("Tree-sitter language extension cannot be empty");
  if (normalized.startsWith(".")) return normalized;
  return `.${normalized}`;
};

const normalizeAlias = (alias: string): string => {
  const normalized = alias.trim().toLowerCase();
  if (normalized) return normalized;

  throw new Error("Tree-sitter language alias cannot be empty");
};

const uniqueItems = <T>(items: readonly T[]): readonly T[] => [...new Set(items)];

const createEmptyProcessedTree = (): ProcessedTree => ({
  captures: [],
  folds: [],
  brackets: [],
  errors: [],
  injections: [],
  injectedTrees: [],
});

const mergeProcessedTree = (target: ProcessedTree, source: ProcessedTree): void => {
  (target.captures as TreeSitterCapture[]).push(...source.captures);
  (target.folds as FoldRange[]).push(...source.folds);
  (target.brackets as BracketInfo[]).push(...source.brackets);
  (target.errors as TreeSitterError[]).push(...source.errors);
  (target.injections as TreeSitterInjectionInfo[]).push(...source.injections);
  (target.injectedTrees as Tree[]).push(...source.injectedTrees);
};

const mergeCaptures = (
  left: readonly TreeSitterCapture[],
  right: readonly TreeSitterCapture[],
): TreeSitterCapture[] =>
  [...left, ...right].toSorted((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);

const mergeFolds = (left: readonly FoldRange[], right: readonly FoldRange[]): FoldRange[] =>
  [...left, ...right].toSorted((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

const isCancelled = (context: CancellationContext): boolean => {
  if (context.flag && Atomics.load(context.flag, 0) === 1) return true;
  return nowMs() - context.startedAt > context.budgetMs;
};

const assertNotCancelled = (context: CancellationContext): void => {
  if (isCancelled(context)) throw new SyntaxRequestCancelled();
};

const nowMs = (): number => globalThis.performance?.now() ?? Date.now();

const applyTextEdit = (
  text: string,
  startIndex: number,
  oldEndIndex: number,
  insertedText: string,
): string => text.slice(0, startIndex) + insertedText + text.slice(oldEndIndex);

const applyTextEdits = (
  text: string,
  edits: readonly TreeSitterEditRequest["edits"][number][],
): string => {
  let next = text;
  const sorted = edits.toSorted((left, right) => right.from - left.from || right.to - left.to);

  for (const edit of sorted) {
    next = applyTextEdit(next, edit.from, edit.to, edit.text);
  }

  return next;
};

const handleRequest = async (request: TreeSitterWorkerRequest): Promise<TreeSitterWorkerResult> => {
  const { payload } = request;

  if (payload.type === "init") {
    await ensureParserRuntime();
    return undefined;
  }

  if (payload.type === "registerLanguages") {
    registerLanguages(payload.languages);
    return undefined;
  }

  if (payload.type === "parse") return parseDocument(payload);
  if (payload.type === "edit") return editDocument(payload);
  if (payload.type === "selection") return selectDocument(payload);

  if (payload.type === "disposeDocument") {
    disposeDocument(payload.documentId);
    return undefined;
  }

  disposeAll();
  return undefined;
};

const workerScope = globalThis as typeof globalThis & {
  readonly importScripts?: unknown;
  onmessage?: (event: MessageEvent<TreeSitterWorkerRequest>) => void;
  postMessage?: (response: TreeSitterWorkerResponse) => void;
};

const shouldInstallWorkerHandler = (): boolean => {
  if (typeof workerScope.postMessage !== "function") return false;
  return typeof document === "undefined";
};

if (shouldInstallWorkerHandler()) {
  workerScope.onmessage = (event: MessageEvent<TreeSitterWorkerRequest>): void => {
    const request = event.data;
    void handleRequest(request)
      .then((result) => postResponse({ id: request.id, ok: true, result }))
      .catch((error) => {
        postResponse({ id: request.id, ok: false, error: createErrorMessage(error) });
      });
  };
}

export const __treeSitterWorkerInternalsForTests = {
  applyTextEdit,
  applyTextEdits,
  collectBracket,
  collectError,
  resolveTreeSitterSourceDescriptor,
  readTreeSitterPieceTableInput,
};

const postResponse = (response: TreeSitterWorkerResponse): void => {
  workerScope.postMessage?.(response);
};
