import { performance } from "node:perf_hooks";
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from "../../tree-sitter-languages/src/index";

import {
  applyBatchToPieceTable,
  createPieceTableSnapshot,
  type PieceTableSnapshot,
  type TextEdit,
} from "@editor/core";
import { resolveTreeSitterLanguageContribution } from "../src";
import { createTreeSitterEditPayload } from "../src/session";
import {
  disposeTreeSitterWorker,
  editWithTreeSitter,
  parseWithTreeSitter,
  registerTreeSitterLanguagesWithWorker,
} from "../src/treeSitter/workerClient";
import type { TreeSitterParseResult } from "../src/treeSitter/types";

declare const Bun: { gc?: (force?: boolean) => void } | undefined;

type MemorySample = {
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly rssMb: number;
};

type SyntaxSample = {
  readonly lines: number;
  readonly textLength: number;
  readonly initialTotalMs: number;
  readonly initialParseMs: number;
  readonly initialQueryMs: number;
  readonly editTotalMs: number;
  readonly editParseMs: number;
  readonly editQueryMs: number;
  readonly captures: number;
  readonly folds: number;
  readonly memoryAfterParse: MemorySample;
  readonly memoryAfterEdit: MemorySample;
  readonly memoryAfterGc: MemorySample;
  readonly forcedGcAvailable: boolean;
};

const LINE_COUNTS = [10_000, 50_000, 100_000] as const;

const formatMs = (value: number): string => `${value.toFixed(2)}ms`;
const toMb = (bytes: number): number => bytes / 1024 / 1024;

const readMemory = (): MemorySample => {
  const usage = process.memoryUsage();
  return {
    heapUsedMb: toMb(usage.heapUsed),
    heapTotalMb: toMb(usage.heapTotal),
    rssMb: toMb(usage.rss),
  };
};

const forceGc = (): boolean => {
  if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
    Bun.gc(true);
    return true;
  }

  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    return true;
  }

  return false;
};

const timing = (result: TreeSitterParseResult | undefined, name: string): number =>
  result?.timings.find((item) => item.name === name)?.durationMs ?? Number.NaN;

const buildText = (lines: number): string => {
  const chunks: string[] = [];

  for (let line = 0; line < lines; line += 10) {
    chunks.push(`export function value${line}() {\n`);
    chunks.push("  const item = {\n");
    chunks.push(`    line: ${line},\n`);
    chunks.push(`    label: "line-${line}",\n`);
    chunks.push("  };\n");
    chunks.push("  if (item.line % 2 === 0) {\n");
    chunks.push("    return item.label;\n");
    chunks.push("  }\n");
    chunks.push("  return String(item.line);\n");
    chunks.push("}\n");
  }

  return chunks.join("");
};

const editForSnapshot = (snapshot: PieceTableSnapshot): TextEdit => {
  const midpoint = Math.floor(snapshot.length / 2);
  return { from: midpoint, to: midpoint, text: "/* syntax-bench */" };
};

const measureSyntax = async (lines: number): Promise<SyntaxSample> => {
  const text = buildText(lines);
  const snapshot = createPieceTableSnapshot(text);
  const documentId = `bench-${lines}.ts`;

  const parseStart = performance.now();
  const parsed = await parseWithTreeSitter({
    documentId,
    snapshotVersion: 1,
    languageId: "typescript",
    snapshot,
  });
  const initialTotalMs = performance.now() - parseStart;
  if (!parsed) throw new Error(`parse cancelled for ${lines} lines`);

  const memoryAfterParse = readMemory();
  const edit = editForSnapshot(snapshot);
  const nextSnapshot = applyBatchToPieceTable(snapshot, [edit]);
  const payload = createTreeSitterEditPayload({
    documentId,
    languageId: "typescript",
    snapshotVersion: 2,
    previousSnapshot: snapshot,
    nextSnapshot,
    edits: [edit],
  });
  if (!payload) throw new Error("failed to create syntax edit payload");

  const editStart = performance.now();
  const edited = await editWithTreeSitter(payload);
  const editTotalMs = performance.now() - editStart;
  if (!edited) throw new Error(`incremental parse cancelled for ${lines} lines`);

  const memoryAfterEdit = readMemory();
  const forcedGcAvailable = forceGc();

  return {
    lines,
    textLength: text.length,
    initialTotalMs,
    initialParseMs: timing(parsed, "treeSitter.parse"),
    initialQueryMs: timing(parsed, "treeSitter.query"),
    editTotalMs,
    editParseMs: timing(edited, "treeSitter.parse"),
    editQueryMs: timing(edited, "treeSitter.query"),
    captures: edited.captures.length,
    folds: edited.folds.length,
    memoryAfterParse,
    memoryAfterEdit,
    memoryAfterGc: readMemory(),
    forcedGcAvailable,
  };
};

const printMemory = (label: string, memory: MemorySample): void => {
  console.log(
    `${label}: heap ${memory.heapUsedMb.toFixed(2)} / ${memory.heapTotalMb.toFixed(2)} MiB, rss ${memory.rssMb.toFixed(2)} MiB`,
  );
};

const printSample = (sample: SyntaxSample): void => {
  console.log(`tree-sitter syntax benchmark: ${sample.lines.toLocaleString()} lines`);
  console.log(`text length: ${sample.textLength.toLocaleString()}`);
  console.log(`initial total: ${formatMs(sample.initialTotalMs)}`);
  console.log(`initial parse: ${formatMs(sample.initialParseMs)}`);
  console.log(`initial query: ${formatMs(sample.initialQueryMs)}`);
  console.log(`edit total: ${formatMs(sample.editTotalMs)}`);
  console.log(`edit parse: ${formatMs(sample.editParseMs)}`);
  console.log(`edit query: ${formatMs(sample.editQueryMs)}`);
  console.log(`captures: ${sample.captures.toLocaleString()}`);
  console.log(`folds: ${sample.folds.toLocaleString()}`);
  printMemory("memory after parse", sample.memoryAfterParse);
  printMemory("memory after edit", sample.memoryAfterEdit);
  printMemory("memory after forced gc", sample.memoryAfterGc);
  console.log(`forced gc available: ${sample.forcedGcAvailable}`);
  console.log("");
};

try {
  await registerDefaultLanguages();

  for (const lines of LINE_COUNTS) {
    printSample(await measureSyntax(lines));
  }
} finally {
  await disposeTreeSitterWorker();
}

async function registerDefaultLanguages(): Promise<void> {
  const descriptors = await Promise.all(
    TREE_SITTER_LANGUAGE_CONTRIBUTIONS.map(resolveTreeSitterLanguageContribution),
  );
  await registerTreeSitterLanguagesWithWorker(descriptors);
}
