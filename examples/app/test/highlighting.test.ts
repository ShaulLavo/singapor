import { afterEach, describe, expect, it } from "vitest";

import { inferLanguage, resetTokenizerCache, tokenizeFile } from "../src/highlighting";

describe("inferLanguage", () => {
  it("maps .ts to ts", () => {
    expect(inferLanguage("file.ts")).toBe("ts");
  });

  it("maps .tsx to tsx", () => {
    expect(inferLanguage("component.tsx")).toBe("tsx");
  });

  it("maps .js to js", () => {
    expect(inferLanguage("index.js")).toBe("js");
  });

  it("maps .css to css", () => {
    expect(inferLanguage("styles.css")).toBe("css");
  });

  it("maps .json to json", () => {
    expect(inferLanguage("package.json")).toBe("json");
  });

  it("maps .sh to bash", () => {
    expect(inferLanguage("script.sh")).toBe("bash");
  });

  it("maps .mjs to js", () => {
    expect(inferLanguage("module.mjs")).toBe("js");
  });

  it("maps .cts to ts", () => {
    expect(inferLanguage("config.cts")).toBe("ts");
  });

  it("returns null for unknown extensions", () => {
    expect(inferLanguage("image.png")).toBeNull();
  });

  it("returns null for files with no extension", () => {
    expect(inferLanguage("Makefile")).toBeNull();
  });

  it("handles uppercase extensions", () => {
    expect(inferLanguage("README.MD")).toBe("md");
  });

  it("uses the last dot for extension", () => {
    expect(inferLanguage("file.test.ts")).toBe("ts");
  });
});

describe("tokenizeFile", () => {
  afterEach(async () => {
    await resetTokenizerCache();
  });

  it("returns empty array for unknown file types", async () => {
    const tokens = await tokenizeFile("image.png", "binary content");
    expect(tokens).toEqual([]);
  });

  it("returns tokens for a TypeScript file", async () => {
    const tokens = await tokenizeFile("example.ts", "const x = 1");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0]).toHaveProperty("start");
    expect(tokens[0]).toHaveProperty("end");
    expect(tokens[0]).toHaveProperty("style");
  });

  it("reuses cached tokenizer for the same language", async () => {
    const tokens1 = await tokenizeFile("a.ts", "const a = 1");
    const tokens2 = await tokenizeFile("b.ts", "const b = 2");
    expect(tokens1.length).toBeGreaterThan(0);
    expect(tokens2.length).toBeGreaterThan(0);
  });
});
