export type EditorCommandId =
  | "undo"
  | "redo"
  | "selectAll"
  | "deleteBackward"
  | "deleteForward"
  | "cursorLeft"
  | "cursorRight"
  | "cursorUp"
  | "cursorDown"
  | "selectLeft"
  | "selectRight"
  | "selectUp"
  | "selectDown"
  | "cursorWordLeft"
  | "cursorWordRight"
  | "selectWordLeft"
  | "selectWordRight"
  | "cursorLineStart"
  | "cursorLineEnd"
  | "selectLineStart"
  | "selectLineEnd"
  | "cursorPageUp"
  | "cursorPageDown"
  | "selectPageUp"
  | "selectPageDown"
  | "cursorDocumentStart"
  | "cursorDocumentEnd"
  | "selectDocumentStart"
  | "selectDocumentEnd";

export type EditorCommandContext = {
  readonly event?: KeyboardEvent;
};
