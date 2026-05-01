import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFoldGutterContribution,
  createLineGutterContribution,
} from "../../gutters/src/index.ts";

import "../src/style.css";
import { VirtualizedTextView } from "../src";

describe.skipIf(typeof globalThis.Highlight === "undefined")(
  "VirtualizedTextView native browser geometry",
  () => {
    let container: HTMLElement;
    let view: VirtualizedTextView | null;

    beforeEach(() => {
      container = document.createElement("div");
      container.style.height = "120px";
      container.style.width = "360px";
      document.body.appendChild(container);
      view = new VirtualizedTextView(container, { rowHeight: 20, overscan: 0 });
    });

    afterEach(() => {
      view?.dispose();
      container.remove();
      view = null;
    });

    it("keeps caret, selection, and hit testing inside mounted rows", () => {
      view!.setHiddenCharacters("show");
      view!.setText("abcdef\nsecond");
      view!.setScrollMetrics(0, 40);

      const row = view!.getState().mountedRows[0];
      const chunk = row?.chunks[0];
      expect(chunk).toBeDefined();

      const selection = document.createRange();
      selection.setStart(chunk!.textNode, 1);
      selection.setEnd(chunk!.textNode, 4);
      expect(selection.getClientRects().length).toBeGreaterThan(0);

      const rowRect = row!.element.getBoundingClientRect();
      const offset = view!.textOffsetFromPoint(rowRect.left + 4, rowRect.top + 10);
      expect(offset).not.toBeNull();

      const validation = view!.validateMountedNativeGeometry();
      expect(validation.failures).toEqual([]);
      expect(validation.caretChecks).toBeGreaterThan(0);
      expect(validation.selectionChecks).toBeGreaterThan(0);
    });

    it("sets deterministic gutter CSS variables without marker measurement", () => {
      view?.dispose();
      view = new VirtualizedTextView(container, {
        rowHeight: 20,
        overscan: 0,
        gutterContributions: [createLineGutterContribution(), createFoldGutterContribution()],
      });
      view!.setText(Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join("\n"));
      view!.setScrollMetrics(9_999 * 20, 20, 360);

      expect(view!.scrollElement.style.getPropertyValue("--editor-gutter-label-columns")).toBe("");
      expect(view!.scrollElement.style.getPropertyValue("--editor-gutter-width")).toMatch(/px$/);
    });
  },
);
