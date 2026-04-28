import { afterEach, describe, expect, it } from "vitest";

import {
  disposeTreeSitterWorker,
  editWithTreeSitter,
  parseWithTreeSitter,
} from "../src/syntax/treeSitter/workerClient.ts";

describe.skipIf(typeof Worker === "undefined")("tree-sitter worker client", () => {
  afterEach(async () => {
    await disposeTreeSitterWorker();
  });

  it("parses and edits through the real browser Worker", async () => {
    const documentId = "file.ts";
    const parsed = await parseWithTreeSitter({
      documentId,
      snapshotVersion: 1,
      languageId: "typescript",
      text: "const answer = 1;\n",
    });

    expect(parsed?.documentId).toBe(documentId);
    expect(parsed?.snapshotVersion).toBe(1);
    expect(parsed?.captures.length).toBeGreaterThan(0);

    const edited = await editWithTreeSitter({
      documentId,
      snapshotVersion: 2,
      languageId: "typescript",
      startIndex: 6,
      oldEndIndex: 12,
      newEndIndex: 11,
      insertedText: "value",
      startPosition: { row: 0, column: 6 },
      oldEndPosition: { row: 0, column: 12 },
      newEndPosition: { row: 0, column: 11 },
    });

    expect(edited?.documentId).toBe(documentId);
    expect(edited?.snapshotVersion).toBe(2);
    expect(edited?.captures.length).toBeGreaterThan(0);
  });
});
