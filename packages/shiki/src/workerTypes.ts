import type { EditorTheme, EditorToken, TextEdit } from "@editor/core";

export type ShikiWorkerDocumentOptions = {
  readonly documentId: string;
  readonly lang: string;
  readonly theme: string;
  readonly text: string;
  readonly langs: readonly string[];
  readonly themes: readonly string[];
};

export type ShikiWorkerOpenRequest = ShikiWorkerDocumentOptions & {
  readonly type: "open";
};

export type ShikiWorkerEditRequest = ShikiWorkerDocumentOptions & {
  readonly type: "edit";
  readonly edit?: TextEdit;
};

export type ShikiWorkerDisposeDocumentRequest = {
  readonly type: "disposeDocument";
  readonly documentId: string;
};

export type ShikiWorkerDisposeRequest = {
  readonly type: "dispose";
};

export type ShikiWorkerRequestPayload =
  | ShikiWorkerOpenRequest
  | ShikiWorkerEditRequest
  | ShikiWorkerDisposeDocumentRequest
  | ShikiWorkerDisposeRequest;

export type ShikiWorkerResult = {
  readonly documentId: string;
  readonly tokens: readonly EditorToken[];
  readonly theme?: EditorTheme;
};

export type ShikiWorkerRequest = {
  readonly id: number;
  readonly payload: ShikiWorkerRequestPayload;
};

export type ShikiWorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result?: ShikiWorkerResult;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    };
