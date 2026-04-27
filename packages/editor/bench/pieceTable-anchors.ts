import { performance } from "node:perf_hooks";

import {
  anchorAfter,
  createPieceTableSnapshot,
  insertIntoPieceTable,
  resolveAnchor,
  type RealAnchor,
} from "../src/pieceTable";

type Sample = {
  lines: number;
  pieces: number;
  anchors: number;
  textLength: number;
  buildMs: number;
  averageInsertionMs: number;
  averageAnchorCreateMs: number;
  averageResolveMs: number;
  heapUsedMb: number;
};

const LINE_COUNTS = [10_000, 50_000, 100_000] as const;
const ANCHOR_STRIDE = 1_000;

const formatMs = (value: number): string => `${value.toFixed(4)}ms`;

const buildSnapshot = (lineCount: number) => {
  let snapshot = createPieceTableSnapshot("");
  const start = performance.now();

  for (let line = 0; line < lineCount; line++) {
    snapshot = insertIntoPieceTable(snapshot, snapshot.length, `line-${line}\n`);
  }

  return {
    snapshot,
    buildMs: performance.now() - start,
  };
};

const createAnchors = (snapshot: ReturnType<typeof createPieceTableSnapshot>): RealAnchor[] => {
  const anchors: RealAnchor[] = [];

  for (let offset = 0; offset <= snapshot.length; offset += ANCHOR_STRIDE) {
    anchors.push(anchorAfter(snapshot, offset));
  }

  return anchors;
};

const measure = (lineCount: number): Sample => {
  const { snapshot, buildMs } = buildSnapshot(lineCount);
  if (!snapshot.reverseIndexRoot) throw new Error("expected snapshot-owned reverse index");

  const anchorStart = performance.now();
  const anchors = createAnchors(snapshot);
  const anchorCreateMs = performance.now() - anchorStart;

  const resolveStart = performance.now();
  for (const anchor of anchors) resolveAnchor(snapshot, anchor);
  const resolveMs = performance.now() - resolveStart;

  return {
    lines: lineCount,
    pieces: snapshot.pieceCount,
    anchors: anchors.length,
    textLength: snapshot.length,
    buildMs,
    averageInsertionMs: buildMs / lineCount,
    averageAnchorCreateMs: anchorCreateMs / anchors.length,
    averageResolveMs: resolveMs / anchors.length,
    heapUsedMb: process.memoryUsage().heapUsed / 1024 / 1024,
  };
};

const printSample = (sample: Sample): void => {
  console.log(`anchor benchmark: ${sample.lines.toLocaleString()} lines`);
  console.log(`pieces: ${sample.pieces}`);
  console.log(`anchors: ${sample.anchors}`);
  console.log(`text length: ${sample.textLength}`);
  console.log(`snapshot build with index: ${formatMs(sample.buildMs)}`);
  console.log(`average insertion with index: ${formatMs(sample.averageInsertionMs)}`);
  console.log(`average anchor create: ${formatMs(sample.averageAnchorCreateMs)}`);
  console.log(`average indexed resolve: ${formatMs(sample.averageResolveMs)}`);
  console.log(`heap used: ${sample.heapUsedMb.toFixed(2)} MiB`);
};

for (const lineCount of LINE_COUNTS) {
  printSample(measure(lineCount));
}
