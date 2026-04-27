import { describe, expect, test } from "vitest";
import {
  Anchor,
  anchorAfter,
  anchorAt,
  anchorBefore,
  applyBatchToPieceTable,
  compareAnchors,
  createPieceTableSnapshot,
  deleteFromPieceTable,
  getPieceTableText,
  insertIntoPieceTable,
  debugPieceTable,
  offsetToPoint,
  pointToOffset,
  resolveAnchor,
  resolveAnchorLinear,
} from "./index";

type PieceTableSnapshot = ReturnType<typeof createPieceTableSnapshot>;
type Random = () => number;

const FUZZ_ALPHABET = ["a", "b", "c", "d", "e", "f", "\n", " ", "\t"];

const countLineBreaks = (text: string): number => [...text].filter((char) => char === "\n").length;

const createRandom = (seed: number): Random => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const randomInt = (random: Random, maxExclusive: number): number =>
  Math.floor(random() * maxExclusive);

const randomText = (random: Random): string => {
  const length = 1 + randomInt(random, 12);
  let text = "";

  for (let index = 0; index < length; index++) {
    text += FUZZ_ALPHABET[randomInt(random, FUZZ_ALPHABET.length)];
  }

  return text;
};

const expectSnapshotText = (snapshot: PieceTableSnapshot, text: string) => {
  expect(getPieceTableText(snapshot)).toBe(text);
  expect(snapshot.length).toBe(text.length);
  expect(snapshot.root?.subtreeLineBreaks ?? 0).toBe(countLineBreaks(text));
};

const expectRandomRanges = (snapshot: PieceTableSnapshot, text: string, random: Random) => {
  for (let index = 0; index < 10; index++) {
    const start = randomInt(random, text.length + 1);
    const end = start + randomInt(random, text.length - start + 1);
    expect(getPieceTableText(snapshot, start, end)).toBe(text.slice(start, end));
  }
};

const applyRandomEdit = (
  snapshot: PieceTableSnapshot,
  text: string,
  random: Random,
): { snapshot: PieceTableSnapshot; text: string } => {
  const shouldInsert = text.length === 0 || random() < 0.62;

  if (shouldInsert) {
    const offset = randomInt(random, text.length + 1);
    const inserted = randomText(random);
    return {
      snapshot: insertIntoPieceTable(snapshot, offset, inserted),
      text: text.slice(0, offset) + inserted + text.slice(offset),
    };
  }

  const start = randomInt(random, text.length);
  const length = 1 + randomInt(random, text.length - start);
  return {
    snapshot: deleteFromPieceTable(snapshot, start, length),
    text: text.slice(0, start) + text.slice(start + length),
  };
};

const runRandomEditScenario = (seed: number): void => {
  const random = createRandom(seed);
  let snapshot = createPieceTableSnapshot(randomText(random));
  let text = getPieceTableText(snapshot);

  for (let operation = 0; operation < 250; operation++) {
    const result = applyRandomEdit(snapshot, text, random);
    snapshot = result.snapshot;
    text = result.text;
    expectSnapshotText(snapshot, text);
    expectRandomRanges(snapshot, text, random);
  }
};

const runRandomAnchorScenario = (seed: number): void => {
  const random = createRandom(seed);
  let snapshot = createPieceTableSnapshot(randomText(random));
  let text = getPieceTableText(snapshot);
  const anchors = [anchorBefore(snapshot, 0), anchorAfter(snapshot, snapshot.length)];

  for (let operation = 0; operation < 80; operation++) {
    if (anchors.length < 60) {
      const offset = randomInt(random, text.length + 1);
      anchors.push(anchorAt(snapshot, offset, random() < 0.5 ? "left" : "right"));
    }

    const result = applyRandomEdit(snapshot, text, random);
    snapshot = result.snapshot;
    text = result.text;

    for (const anchor of anchors) {
      expect(resolveAnchor(snapshot, anchor)).toEqual(resolveAnchorLinear(snapshot, anchor));
    }
  }
};

describe("piece table", () => {
  test("basic insert/delete round-trip", () => {
    let snapshot = createPieceTableSnapshot("hello");
    expectSnapshotText(snapshot, "hello");

    snapshot = insertIntoPieceTable(snapshot, 5, " world");
    expectSnapshotText(snapshot, "hello world");

    snapshot = deleteFromPieceTable(snapshot, 5, 1);
    expectSnapshotText(snapshot, "helloworld");
  });

  test("keeps previous snapshots readable after later edits", () => {
    const initial = createPieceTableSnapshot("abc");
    const inserted = insertIntoPieceTable(initial, 1, "XX");
    const deleted = deleteFromPieceTable(inserted, 2, 2);

    expectSnapshotText(initial, "abc");
    expectSnapshotText(inserted, "aXXbc");
    expectSnapshotText(deleted, "aXc");
  });

  test("handles empty documents", () => {
    let snapshot = createPieceTableSnapshot("");
    expectSnapshotText(snapshot, "");
    expect(getPieceTableText(snapshot, 0, 0)).toBe("");
    expect(offsetToPoint(snapshot, 0)).toEqual({ row: 0, column: 0 });
    expect(pointToOffset(snapshot, { row: 0, column: 10 })).toBe(0);

    snapshot = insertIntoPieceTable(snapshot, 0, "a\n");
    expectSnapshotText(snapshot, "a\n");

    snapshot = deleteFromPieceTable(snapshot, 0, 2);
    expectSnapshotText(snapshot, "");
  });

  test("handles trailing newline documents", () => {
    const snapshot = createPieceTableSnapshot("alpha\nbeta\n");
    expectSnapshotText(snapshot, "alpha\nbeta\n");
    expect(offsetToPoint(snapshot, 10)).toEqual({ row: 1, column: 4 });
    expect(offsetToPoint(snapshot, 11)).toEqual({ row: 2, column: 0 });
    expect(pointToOffset(snapshot, { row: 1, column: 99 })).toBe(10);
    expect(pointToOffset(snapshot, { row: 2, column: 99 })).toBe(11);
  });

  test("handles very long single-line documents", () => {
    const text = "x".repeat(120_000);
    const snapshot = createPieceTableSnapshot(text);
    expectSnapshotText(snapshot, text);
    expect(getPieceTableText(snapshot, 60_000, 60_010)).toBe("x".repeat(10));
    expect(offsetToPoint(snapshot, 120_000)).toEqual({ row: 0, column: 120_000 });
    expect(pointToOffset(snapshot, { row: 0, column: 200_000 })).toBe(120_000);
  });

  test("allocates a distinct opaque buffer chunk for each small insertion", () => {
    let snapshot = createPieceTableSnapshot("");

    for (let index = 0; index < 1000; index++) {
      snapshot = insertIntoPieceTable(snapshot, snapshot.length, "x");
    }

    const pieces = debugPieceTable(snapshot);
    const buffers = new Set(pieces.map((piece) => piece.buffer));
    expect(pieces).toHaveLength(1000);
    expect(buffers.size).toBe(1000);
    expectSnapshotText(snapshot, "x".repeat(1000));
  });

  test("splits large inserts across bounded chunks", () => {
    const text = "x".repeat(40_000);
    const snapshot = insertIntoPieceTable(createPieceTableSnapshot(""), 0, text);
    const pieces = debugPieceTable(snapshot);

    expect(pieces.length).toBeGreaterThan(1);
    expectSnapshotText(snapshot, text);
  });

  test("keeps line-break counts correct across inserts, deletes, and splits", () => {
    let snapshot = createPieceTableSnapshot("ab\ncd\nef");
    snapshot = insertIntoPieceTable(snapshot, 4, "X\nY\n");
    snapshot = deleteFromPieceTable(snapshot, 1, 5);

    expectSnapshotText(snapshot, "aY\nd\nef");
    expect(
      debugPieceTable(snapshot).reduce(
        (sum, piece) => sum + (piece.visible ? piece.lineBreaks : 0),
        0,
      ),
    ).toBe(2);
  });

  test("converts offsets to points at line boundaries", () => {
    const snapshot = createPieceTableSnapshot("ab\ncde\n\nf");

    expect(offsetToPoint(snapshot, 0)).toEqual({ row: 0, column: 0 });
    expect(offsetToPoint(snapshot, 2)).toEqual({ row: 0, column: 2 });
    expect(offsetToPoint(snapshot, 3)).toEqual({ row: 1, column: 0 });
    expect(offsetToPoint(snapshot, 6)).toEqual({ row: 1, column: 3 });
    expect(offsetToPoint(snapshot, 7)).toEqual({ row: 2, column: 0 });
    expect(offsetToPoint(snapshot, 8)).toEqual({ row: 3, column: 0 });
    expect(offsetToPoint(snapshot, 9)).toEqual({ row: 3, column: 1 });
  });

  test("converts points to offsets and clamps columns to line ends", () => {
    const snapshot = createPieceTableSnapshot("ab\ncde\n\nf");

    expect(pointToOffset(snapshot, { row: 0, column: 99 })).toBe(2);
    expect(pointToOffset(snapshot, { row: 1, column: 2 })).toBe(5);
    expect(pointToOffset(snapshot, { row: 1, column: 99 })).toBe(6);
    expect(pointToOffset(snapshot, { row: 2, column: 99 })).toBe(7);
    expect(pointToOffset(snapshot, { row: 3, column: 1 })).toBe(9);
    expect(pointToOffset(snapshot, { row: 99, column: 0 })).toBe(9);
    expect(pointToOffset(snapshot, { row: -1, column: -1 })).toBe(0);
  });

  test("round-trips every offset through point conversion", () => {
    let snapshot = createPieceTableSnapshot("ab\ncde\n\nf");
    snapshot = insertIntoPieceTable(snapshot, 3, "XX\n");
    snapshot = deleteFromPieceTable(snapshot, 1, 2);

    for (let offset = 0; offset <= snapshot.length; offset++) {
      expect(pointToOffset(snapshot, offsetToPoint(snapshot, offset))).toBe(offset);
    }
  });

  test("matches string-model readback across randomized insert/delete sequences", () => {
    for (let seed = 1; seed <= 25; seed++) {
      runRandomEditScenario(seed);
    }
  });

  test("keeps deleted pieces invisible and out of user-facing text", () => {
    const snapshot = deleteFromPieceTable(createPieceTableSnapshot("ab\ncd"), 1, 3);
    const pieces = debugPieceTable(snapshot);

    expectSnapshotText(snapshot, "ad");
    expect(pieces.some((piece) => !piece.visible)).toBe(true);
    expect(snapshot.root?.subtreeVisibleLength ?? 0).toBe(2);
    expect(snapshot.root?.subtreeLength ?? 0).toBe(5);
    expect(snapshot.root?.subtreeLineBreaks ?? 0).toBe(0);
  });

  test("stores reverse-index roots in produced snapshots", () => {
    const initial = createPieceTableSnapshot("abc");
    const inserted = insertIntoPieceTable(initial, 1, "XX");
    const deleted = deleteFromPieceTable(inserted, 1, 2);

    expect(initial.reverseIndexRoot).not.toBeNull();
    expect(inserted.reverseIndexRoot).not.toBeNull();
    expect(deleted.reverseIndexRoot).not.toBeNull();
  });

  test("resolves sentinel anchors in every snapshot", () => {
    let snapshot = createPieceTableSnapshot("abc");
    expect(resolveAnchor(snapshot, Anchor.MIN)).toEqual({ offset: 0, liveness: "live" });
    expect(resolveAnchor(snapshot, Anchor.MAX)).toEqual({ offset: 3, liveness: "live" });

    snapshot = deleteFromPieceTable(snapshot, 0, 3);
    expect(resolveAnchor(snapshot, Anchor.MIN)).toEqual({ offset: 0, liveness: "live" });
    expect(resolveAnchor(snapshot, Anchor.MAX)).toEqual({ offset: 0, liveness: "live" });
  });

  test("creates boundary anchors using bias", () => {
    const snapshot = insertIntoPieceTable(createPieceTableSnapshot("ac"), 1, "b");
    const left = anchorBefore(snapshot, 1);
    const right = anchorAfter(snapshot, 1);

    expect(left.buffer).not.toBe(right.buffer);
    expect(resolveAnchor(snapshot, left)).toEqual({ offset: 1, liveness: "live" });
    expect(resolveAnchor(snapshot, right)).toEqual({ offset: 1, liveness: "live" });
    expect(compareAnchors(snapshot, left, right)).toBeLessThan(0);
  });

  test("reports deleted liveness after deletion", () => {
    const initial = createPieceTableSnapshot("abc");
    const anchor = anchorAfter(initial, 1);
    const deleted = deleteFromPieceTable(initial, 1, 1);

    expect(resolveAnchor(deleted, anchor)).toEqual({ offset: 1, liveness: "deleted" });
  });

  test("applies replacement bias around inserted text", () => {
    const initial = createPieceTableSnapshot("abc");
    const left = anchorAt(initial, 2, "left");
    const right = anchorAt(initial, 1, "right");
    const deleted = deleteFromPieceTable(initial, 1, 1);
    const replaced = insertIntoPieceTable(deleted, 1, "XX");

    expectSnapshotText(replaced, "aXXc");
    expect(resolveAnchor(replaced, left)).toEqual({ offset: 1, liveness: "deleted" });
    expect(resolveAnchor(replaced, right)).toEqual({ offset: 3, liveness: "deleted" });
  });

  test("rejects anchors inside surrogate pairs", () => {
    const snapshot = createPieceTableSnapshot("a😀b");

    expect(() => anchorAfter(snapshot, 2)).toThrow(RangeError);
    expect(anchorAfter(snapshot, 1)).toMatchObject({ kind: "anchor" });
    expect(anchorAfter(snapshot, 3)).toMatchObject({ kind: "anchor" });
  });

  test("resolves anchors in empty snapshots without returning sentinels", () => {
    const snapshot = createPieceTableSnapshot("");
    const anchor = anchorAfter(snapshot, 0);

    expect(anchor.kind).toBe("anchor");
    expect(resolveAnchor(snapshot, anchor)).toEqual({ offset: 0, liveness: "live" });
  });

  test("preserves empty-document anchor bias after first insert", () => {
    const snapshot = createPieceTableSnapshot("");
    const left = anchorBefore(snapshot, 0);
    const right = anchorAfter(snapshot, 0);
    const inserted = insertIntoPieceTable(snapshot, 0, "abc");

    expect(resolveAnchor(inserted, left)).toEqual({ offset: 0, liveness: "live" });
    expect(resolveAnchor(inserted, right)).toEqual({ offset: 3, liveness: "live" });
  });

  test("indexed anchor resolution matches the linear baseline across edits", () => {
    let snapshot = createPieceTableSnapshot("alpha\nbeta\ngamma");
    const anchors = [
      anchorBefore(snapshot, 0),
      anchorAfter(snapshot, 5),
      anchorAfter(snapshot, 6),
      anchorBefore(snapshot, snapshot.length),
    ];

    snapshot = insertIntoPieceTable(snapshot, 6, "INSERT\n");
    anchors.push(anchorAfter(snapshot, 8));
    snapshot = deleteFromPieceTable(snapshot, 2, 10);
    snapshot = insertIntoPieceTable(snapshot, 2, "xy");
    snapshot = deleteFromPieceTable(snapshot, snapshot.length - 3, 2);

    for (const anchor of anchors) {
      expect(resolveAnchor(snapshot, anchor)).toEqual(resolveAnchorLinear(snapshot, anchor));
    }
  });

  test("indexed anchor resolution matches linear across randomized edit patterns", () => {
    for (let seed = 1; seed <= 10; seed++) {
      runRandomAnchorScenario(seed);
    }
  });

  test("applies non-overlapping batch edits against the original snapshot", () => {
    const snapshot = createPieceTableSnapshot("abcdef");
    const edited = applyBatchToPieceTable(snapshot, [
      { from: 1, to: 3, text: "XX" },
      { from: 4, to: 6, text: "Y" },
    ]);

    expectSnapshotText(edited, "aXXdY");
    expectSnapshotText(snapshot, "abcdef");
  });
});
