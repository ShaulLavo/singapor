import { describe, expect, it } from "vitest";

import { createTopBar } from "../../src/components/topBar.ts";

describe("createTopBar", () => {
  it("tracks repository status", () => {
    const topBar = createTopBar();

    topBar.setRepositoryName("ShaulLavo/Editor");
    expect(topBar.element.querySelector("#dir-name")?.textContent).toBe("ShaulLavo/Editor");

    topBar.setBusyState(true);
    expect(topBar.element.querySelector("button")).toBeNull();

    topBar.setMessage("Failed");
    expect(topBar.element.querySelector("#dir-name")?.textContent).toBe("Failed");
  });
});
