import { describe, expect, it } from "vitest";
import { computeFrameLayout, computeRenderLayout, yForLineNumber } from "../src/layout";
import { resolveMinimapOptions } from "../src/options";
import { RenderMinimap, type MinimapRenderLayout, type MinimapViewport } from "../src/types";

describe("minimap layout", () => {
  it("computes proportional render dimensions from editor metrics", () => {
    const layout = computeRenderLayout({
      minimap: resolveMinimapOptions({ maxColumn: 80, scale: 2 }),
      metrics: { rowHeight: 20, characterWidth: 8, devicePixelRatio: 2 },
      viewport: viewport({ clientHeight: 400, clientWidth: 800, scrollWidth: 1200 }),
      lineCount: 100,
      contentWidth: 1200,
    });

    expect(layout.renderMinimap).toBe(RenderMinimap.Text);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.canvasInnerWidth).toBeGreaterThan(layout.width);
    expect(layout.canvasInnerHeight).toBe(800);
    expect(layout.lineHeight).toBe(8);
  });

  it("falls back to block rendering when character rendering is disabled", () => {
    const layout = computeRenderLayout({
      minimap: resolveMinimapOptions({ enabled: true, renderCharacters: false }),
      metrics: { rowHeight: 20, characterWidth: 8, devicePixelRatio: 1 },
      viewport: viewport({ clientHeight: 240, clientWidth: 600 }),
      lineCount: 20,
      contentWidth: 600,
    });

    expect(layout.renderMinimap).toBe(RenderMinimap.Blocks);
  });

  it("returns no render mode when minimap is disabled", () => {
    const layout = computeRenderLayout({
      minimap: resolveMinimapOptions({ enabled: false }),
      metrics: { rowHeight: 20, characterWidth: 8, devicePixelRatio: 1 },
      viewport: viewport(),
      lineCount: 20,
      contentWidth: 600,
    });

    expect(layout.renderMinimap).toBe(RenderMinimap.None);
  });

  it("uses contained layout for fit mode and clamps the visible range", () => {
    const renderLayout: MinimapRenderLayout = {
      width: 80,
      height: 100,
      canvasInnerWidth: 80,
      canvasInnerHeight: 100,
      canvasOuterWidth: 80,
      canvasOuterHeight: 100,
      lineHeight: 10,
      charWidth: 1,
      scale: 1,
      isSampling: false,
      heightIsEditorHeight: true,
      renderMinimap: RenderMinimap.Text,
    };

    const frame = computeFrameLayout({
      renderLayout,
      viewport: viewport({ clientHeight: 100, scrollHeight: 500, scrollTop: 200 }),
      lineCount: 50,
      realLineCount: 50,
      previous: null,
    });

    expect(frame.sliderNeeded).toBe(true);
    expect(frame.sliderTop).toBe(40);
    expect(frame.sliderHeight).toBe(20);
    expect(frame.startLineNumber).toBe(1);
    expect(frame.endLineNumber).toBe(10);
    expect(yForLineNumber(frame, 3, renderLayout.lineHeight)).toBe(20);
  });

  it("keeps proportional frame movement monotonic while scrolling", () => {
    const renderLayout: MinimapRenderLayout = {
      width: 80,
      height: 100,
      canvasInnerWidth: 80,
      canvasInnerHeight: 100,
      canvasOuterWidth: 80,
      canvasOuterHeight: 100,
      lineHeight: 5,
      charWidth: 1,
      scale: 1,
      isSampling: false,
      heightIsEditorHeight: false,
      renderMinimap: RenderMinimap.Text,
    };
    const first = computeFrameLayout({
      renderLayout,
      viewport: viewport({ visibleStart: 25, scrollTop: 50, scrollHeight: 500 }),
      lineCount: 200,
      realLineCount: 200,
      previous: null,
    });
    const second = computeFrameLayout({
      renderLayout,
      viewport: viewport({ visibleStart: 40, scrollTop: 80, scrollHeight: 500 }),
      lineCount: 200,
      realLineCount: 200,
      previous: first,
    });

    expect(second.startLineNumber).toBeGreaterThanOrEqual(first.startLineNumber);
    expect(second.endLineNumber).toBeLessThanOrEqual(200);
  });
});

function viewport(overrides: Partial<MinimapViewport> = {}): MinimapViewport {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 1000,
    scrollWidth: 800,
    clientHeight: 600,
    clientWidth: 800,
    visibleStart: 0,
    visibleEnd: 30,
    ...overrides,
  };
}
