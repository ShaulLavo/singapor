import { describe, expect, it } from "vitest";

import { inferLanguage } from "../src/language";

describe("inferLanguage", () => {
  it("maps .ts to ts", () => {
    expect(inferLanguage("file.ts")).toBe("typescript");
  });

  it("maps .tsx to tsx", () => {
    expect(inferLanguage("component.tsx")).toBe("tsx");
  });

  it("maps .js to js", () => {
    expect(inferLanguage("index.js")).toBe("javascript");
  });

  it("maps .mjs to js", () => {
    expect(inferLanguage("module.mjs")).toBe("javascript");
  });

  it("maps .cts to ts", () => {
    expect(inferLanguage("config.cts")).toBe("typescript");
  });

  it("returns null for unknown extensions", () => {
    expect(inferLanguage("image.png")).toBeNull();
  });

  it("returns null for files with no extension", () => {
    expect(inferLanguage("Makefile")).toBeNull();
  });

  it("handles uppercase extensions", () => {
    expect(inferLanguage("COMPONENT.TSX")).toBe("tsx");
  });

  it("uses the last dot for extension", () => {
    expect(inferLanguage("file.test.ts")).toBe("typescript");
  });
});
