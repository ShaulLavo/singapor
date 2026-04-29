import { describe, expect, it } from "vitest";
import type { ShikiWorkerRequest, ShikiWorkerResponse } from "../src/workerTypes";

describe("Shiki worker message types", () => {
  it("accepts request and response payload shapes used by the worker client", () => {
    const request: ShikiWorkerRequest = {
      id: 1,
      payload: {
        type: "open",
        documentId: "doc",
        text: "const value = 1;",
        lang: "typescript",
        theme: "github-dark",
        langs: ["typescript"],
        themes: ["github-dark"],
      },
    };
    const response: ShikiWorkerResponse = {
      id: request.id,
      ok: true,
      result: { documentId: "doc", tokens: [] },
    };

    expect(request.payload.type).toBe("open");
    if (request.payload.type === "open") {
      expect(response.result?.documentId).toBe(request.payload.documentId);
    }
  });
});
