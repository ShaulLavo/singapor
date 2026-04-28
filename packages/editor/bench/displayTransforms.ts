import { performance } from "node:perf_hooks";

import {
  createDisplayRows,
  createFoldMap,
  createPieceTableSnapshot,
  foldPointToBufferPoint,
  type BlockRow,
} from "../src";
import { computeLineStarts } from "../src/virtualization/virtualizedTextViewHelpers";

type TransformSample = {
  readonly name: string;
  readonly lines: number;
  readonly rows: number;
  readonly buildMs: number;
  readonly roundTripMs: number;
};

const LINE_COUNTS = [10_000, 50_000, 100_000] as const;

const buildText = (lines: number): string =>
  Array.from({ length: lines }, (_, index) => {
    return `line\t${index} ${"x".repeat(index % 80)}`;
  }).join("\n");

const buildFoldMap = (text: string, lineStarts: readonly number[]) => {
  const snapshot = createPieceTableSnapshot(text);
  const folds = [];

  for (let row = 10; row + 4 < lineStarts.length; row += 250) {
    folds.push({
      startIndex: lineStarts[row]!,
      endIndex: lineStarts[row + 4]!,
      startLine: row,
      endLine: row + 4,
      type: "bench-fold",
    });
  }

  return createFoldMap(snapshot, folds);
};

const buildBlocks = (lines: number): BlockRow[] => {
  const blocks: BlockRow[] = [];
  for (let row = 25; row < lines; row += 500) {
    blocks.push({ id: `block-${row}`, anchorBufferRow: row, placement: "after", heightRows: 2 });
  }

  return blocks;
};

const measure = (
  name: string,
  lines: number,
  createRows: () => ReturnType<typeof createDisplayRows>,
): TransformSample => {
  const start = performance.now();
  const rows = createRows();
  const buildMs = performance.now() - start;

  const roundTripStart = performance.now();
  let checksum = 0;
  for (let index = 0; index < rows.length; index += 100) {
    const row = rows[index];
    if (row?.kind !== "text") continue;
    checksum += row.bufferRow + row.startOffset + row.endOffset;
  }
  const roundTripMs = performance.now() - roundTripStart;
  if (checksum === -1) console.log("unreachable");

  return { name, lines, rows: rows.length, buildMs, roundTripMs };
};

const printSample = (sample: TransformSample): void => {
  console.log(
    `${sample.name}: ${sample.lines.toLocaleString()} lines -> ${sample.rows.toLocaleString()} display rows`,
  );
  console.log(`build: ${sample.buildMs.toFixed(2)}ms`);
  console.log(`sample conversion: ${sample.roundTripMs.toFixed(2)}ms`);
  console.log("");
};

for (const lines of LINE_COUNTS) {
  const text = buildText(lines);
  const lineStarts = computeLineStarts(text);
  const foldMap = buildFoldMap(text, lineStarts);
  const visibleLineCount = Math.max(1, lines - foldMap.ranges.length * 4);
  const bufferRowForVisibleRow = (row: number): number => {
    return foldPointToBufferPoint(foldMap, { row, column: 0 } as never).row;
  };

  printSample(
    measure("plain", lines, () =>
      createDisplayRows({
        text,
        lineStarts,
        visibleLineCount: lines,
        bufferRowForVisibleRow: (row) => row,
      }),
    ),
  );
  printSample(
    measure("folds + wraps + blocks", lines, () =>
      createDisplayRows({
        text,
        lineStarts,
        visibleLineCount,
        bufferRowForVisibleRow,
        wrapColumn: 80,
        blocks: buildBlocks(lines),
      }),
    ),
  );
}
