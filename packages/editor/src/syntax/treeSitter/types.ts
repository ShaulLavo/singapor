import type { TextEdit } from "../../tokens";
import type { TreeSitterLanguageDescriptor, TreeSitterLanguageId } from "./registry";
import type { TreeSitterSourceDescriptor } from "./source";

export type { TreeSitterLanguageId } from "./registry";

export type TreeSitterCapture = {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly captureName: string;
  readonly languageId?: TreeSitterLanguageId;
};

export type FoldRange = {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly type: string;
  readonly languageId?: TreeSitterLanguageId;
};

export type BracketInfo = {
  readonly index: number;
  readonly char: string;
  readonly depth: number;
};

export type TreeSitterError = {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly message: string;
  readonly isMissing: boolean;
};

export type TreeSitterPoint = {
  readonly row: number;
  readonly column: number;
};

export type TreeSitterInputEdit = {
  readonly startIndex: number;
  readonly oldEndIndex: number;
  readonly newEndIndex: number;
  readonly startPosition: TreeSitterPoint;
  readonly oldEndPosition: TreeSitterPoint;
  readonly newEndPosition: TreeSitterPoint;
};

export type TreeSitterInjectionInfo = {
  readonly parentLanguageId: TreeSitterLanguageId;
  readonly languageId: TreeSitterLanguageId;
  readonly startIndex: number;
  readonly endIndex: number;
};

export type TreeSitterTimingMeasurement = {
  readonly name: string;
  readonly durationMs: number;
};

export type TreeSitterParseResult = {
  readonly documentId: string;
  readonly snapshotVersion: number;
  readonly languageId: TreeSitterLanguageId;
  readonly captures: readonly TreeSitterCapture[];
  readonly folds: readonly FoldRange[];
  readonly brackets: readonly BracketInfo[];
  readonly errors: readonly TreeSitterError[];
  readonly injections: readonly TreeSitterInjectionInfo[];
  readonly timings: readonly TreeSitterTimingMeasurement[];
};

export type TreeSitterInitRequest = {
  readonly type: "init";
};

export type TreeSitterRegisterLanguagesRequest = {
  readonly type: "registerLanguages";
  readonly languages: readonly TreeSitterLanguageDescriptor[];
};

export type TreeSitterParseRequest = {
  readonly type: "parse";
  readonly documentId: string;
  readonly snapshotVersion: number;
  readonly languageId: TreeSitterLanguageId;
  readonly includeHighlights: boolean;
  readonly source: TreeSitterSourceDescriptor;
  readonly generation: number;
  readonly cancellationBuffer?: SharedArrayBuffer;
};

export type TreeSitterEditRequest = {
  readonly type: "edit";
  readonly documentId: string;
  readonly snapshotVersion: number;
  readonly languageId: TreeSitterLanguageId;
  readonly includeHighlights: boolean;
  readonly source: TreeSitterSourceDescriptor;
  readonly edits: readonly TextEdit[];
  readonly inputEdits: readonly TreeSitterInputEdit[];
  readonly generation: number;
  readonly cancellationBuffer?: SharedArrayBuffer;
};

export type TreeSitterSelectionRange = {
  readonly startIndex: number;
  readonly endIndex: number;
};

export type TreeSitterSelectionAction = "selectToken" | "expand";

export type TreeSitterSelectionRequest = {
  readonly type: "selection";
  readonly documentId: string;
  readonly snapshotVersion: number;
  readonly languageId: TreeSitterLanguageId;
  readonly action: TreeSitterSelectionAction;
  readonly ranges: readonly TreeSitterSelectionRange[];
};

export type TreeSitterSelectionResult = {
  readonly documentId: string;
  readonly snapshotVersion: number;
  readonly languageId: TreeSitterLanguageId;
  readonly status: "ok" | "stale";
  readonly ranges: readonly TreeSitterSelectionRange[];
};

export type TreeSitterDisposeDocumentRequest = {
  readonly type: "disposeDocument";
  readonly documentId: string;
};

export type TreeSitterDisposeRequest = {
  readonly type: "dispose";
};

export type TreeSitterWorkerRequestPayload =
  | TreeSitterInitRequest
  | TreeSitterRegisterLanguagesRequest
  | TreeSitterParseRequest
  | TreeSitterEditRequest
  | TreeSitterSelectionRequest
  | TreeSitterDisposeDocumentRequest
  | TreeSitterDisposeRequest;

export type TreeSitterWorkerResult = TreeSitterParseResult | TreeSitterSelectionResult | undefined;

export type TreeSitterWorkerRequest = {
  readonly id: number;
  readonly payload: TreeSitterWorkerRequestPayload;
};

export type TreeSitterWorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result?: TreeSitterWorkerResult;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    };
