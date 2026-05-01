import { describe, expect, it } from "vitest";

import {
  LspClient,
  LspWorkspace,
  defaultClientCapabilities,
  offsetToLspPosition,
  type LspTextEdit,
  type LspTransport,
} from "../src/index.ts";

describe("public API facade", () => {
  it("exports the LSP client, workspace, transport types, and helpers", () => {
    const transport: LspTransport = {
      send: () => undefined,
      subscribe: () => undefined,
      unsubscribe: () => undefined,
    };
    const edit: LspTextEdit = { from: 0, to: 0, text: "x" };

    expect(LspClient).toBeTypeOf("function");
    expect(LspWorkspace).toBeTypeOf("function");
    expect(defaultClientCapabilities().textDocument?.synchronization?.didSave).toBe(false);
    expect(offsetToLspPosition("abc", 1)).toEqual({ line: 0, character: 1 });
    expect(edit).toEqual({ from: 0, to: 0, text: "x" });
    expect(transport).toBeTruthy();
  });
});
