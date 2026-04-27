export type TreeSitterLanguageId = "javascript" | "typescript" | "tsx";

export type TreeSitterCapture = {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly captureName: string;
};

export type FoldRange = {
  readonly startLine: number;
  readonly endLine: number;
  readonly type: string;
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

export type TreeSitterParseResult = {
  readonly documentId: string;
  readonly snapshotVersion: number;
  readonly languageId: TreeSitterLanguageId;
  readonly captures: readonly TreeSitterCapture[];
  readonly folds: readonly FoldRange[];
  readonly brackets: readonly BracketInfo[];
  readonly errors: readonly TreeSitterError[];
};

export type TreeSitterInitRequest = {
  readonly type: "init";
};

export type TreeSitterParseRequest = {
  readonly type: "parse";
  readonly documentId: string;
  readonly snapshotVersion: number;
  readonly languageId: TreeSitterLanguageId;
  readonly text: string;
};

export type TreeSitterEditRequest = {
  readonly type: "edit";
  readonly documentId: string;
  readonly snapshotVersion: number;
  readonly languageId: TreeSitterLanguageId;
  readonly startIndex: number;
  readonly oldEndIndex: number;
  readonly newEndIndex: number;
  readonly startPosition: TreeSitterPoint;
  readonly oldEndPosition: TreeSitterPoint;
  readonly newEndPosition: TreeSitterPoint;
  readonly insertedText: string;
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
  | TreeSitterParseRequest
  | TreeSitterEditRequest
  | TreeSitterDisposeDocumentRequest
  | TreeSitterDisposeRequest;

export type TreeSitterWorkerRequest = {
  readonly id: number;
  readonly payload: TreeSitterWorkerRequestPayload;
};

export type TreeSitterWorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result?: TreeSitterParseResult;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    };
