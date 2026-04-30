import { MinimapWorkerRenderer } from "./renderer";
import type { MinimapWorkerRequest, MinimapWorkerResponse } from "./types";

const renderer = new MinimapWorkerRenderer();

globalThis.onmessage = (event: MessageEvent<MinimapWorkerRequest>): void => {
  const request = event.data;
  try {
    handleRequest(request);
  } catch (error) {
    post({ type: "error", message: errorMessage(error) });
  }
};

function handleRequest(request: MinimapWorkerRequest): void {
  switch (request.type) {
    case "init":
      renderer.init({
        mainCanvas: request.mainCanvas,
        decorationsCanvas: request.decorationsCanvas,
        options: request.options,
        styles: request.baseStyles,
      });
      return;
    case "updateBaseStyles":
      renderer.setBaseStyles(request.baseStyles);
      return;
    case "openDocument":
    case "replaceDocument":
      renderer.setDocument(request.document);
      return;
    case "applyEdit":
      renderer.setDocument(request.document);
      return;
    case "updateTokens":
      renderer.setTokens(request.tokens);
      return;
    case "updateSelection":
      renderer.setSelections(request.selections);
      return;
    case "updateDecorations":
      renderer.setDecorations(request.decorations);
      return;
    case "updateLayout": {
      const layout = renderer.updateLayout(request.metrics, request.viewport);
      if (layout) post({ type: "layout", sequence: 0, layout });
      return;
    }
    case "updateViewport":
      renderer.updateViewport(request.viewport);
      return;
    case "render":
      postRender(request.sequence);
      return;
    case "dispose":
      renderer.dispose();
      return;
  }
}

function postRender(sequence: number): void {
  const result = renderer.render();
  if (!result) return;

  post({
    type: "rendered",
    sequence,
    sliderNeeded: result.sliderNeeded,
    sliderTop: result.sliderTop,
    sliderHeight: result.sliderHeight,
    shadowVisible: result.shadowVisible,
  });
}

function post(response: MinimapWorkerResponse): void {
  globalThis.postMessage(response);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
