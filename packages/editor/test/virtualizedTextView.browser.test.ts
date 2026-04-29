import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

    it("measures generated gutter markers with the active CSS counter style", () => {
      view!.scrollElement.style.setProperty("--editor-gutter-style", "decimal");
      view!.setText(Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join("\n"));
      view!.setScrollMetrics(9_999 * 20, 20);

      const gutterWidth = Number.parseFloat(
        view!.scrollElement.style.getPropertyValue("--editor-gutter-width"),
      );

      expect(gutterWidth).toBeGreaterThan(36);
    });
  },
);
