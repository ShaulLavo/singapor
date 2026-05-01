import { DEFAULT_TAB_SIZE, visualColumnLength } from "../displayTransforms";
import { setStyleValue } from "./virtualizedTextViewHelpers";
import type {
  VirtualizedStoredSelection,
  VirtualizedTextViewInternal,
} from "./virtualizedTextViewInternals";
import type {
  HiddenCharactersMode,
  MountedVirtualizedTextRow,
  VirtualizedTextChunk,
} from "./virtualizedTextViewTypes";

type HiddenCharacterKind = "space" | "tab";

type HiddenCharacterMarker = {
  readonly kind: HiddenCharacterKind;
  readonly offset: number;
  readonly left: number;
  readonly width: number;
};

export const DEFAULT_HIDDEN_CHARACTERS: HiddenCharactersMode = "show-on-selection";

export function normalizeHiddenCharactersMode(
  mode: HiddenCharactersMode | undefined,
): HiddenCharactersMode {
  if (mode === "hidden" || mode === "show" || mode === "show-on-selection") return mode;
  return DEFAULT_HIDDEN_CHARACTERS;
}

export function renderHiddenCharacters(view: VirtualizedTextViewInternal): void {
  for (const row of view.rowElements.values()) {
    renderHiddenCharactersForRow(view, row);
  }
}

function renderHiddenCharactersForRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): void {
  const markers = hiddenCharacterMarkersForRow(view, row);
  if (markers.length === 0) {
    clearHiddenCharactersForRow(row);
    return;
  }

  const key = hiddenCharacterMarkerKey(markers);
  if (row.hiddenCharactersKey === key) {
    attachHiddenCharacterLayer(row);
    return;
  }

  setHiddenCharactersKey(row, key);
  row.hiddenCharactersLayerElement.replaceChildren(
    ...markers.map((marker) => createHiddenCharacterMarker(row, marker)),
  );
  attachHiddenCharacterLayer(row);
}

function hiddenCharacterMarkersForRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): readonly HiddenCharacterMarker[] {
  if (view.hiddenCharacters === "hidden") return [];
  if (row.kind !== "text") return [];

  const markers: HiddenCharacterMarker[] = [];
  for (const chunk of row.chunks) {
    appendHiddenCharacterMarkersForChunk(markers, view, row, chunk);
  }

  return markers;
}

function appendHiddenCharacterMarkersForChunk(
  markers: HiddenCharacterMarker[],
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
): void {
  const charWidth = hiddenCharacterCellWidth(view);
  let visualColumn = visualColumnLength(row.text.slice(0, chunk.localStart), DEFAULT_TAB_SIZE);

  for (let index = chunk.localStart; index < chunk.localEnd; index += 1) {
    const char = row.text[index]!;
    const widthColumns = hiddenCharacterVisualWidth(char, visualColumn);
    appendHiddenCharacterMarker(
      markers,
      view,
      row,
      char,
      index,
      visualColumn,
      widthColumns,
      charWidth,
    );
    visualColumn += widthColumns;
  }
}

function appendHiddenCharacterMarker(
  markers: HiddenCharacterMarker[],
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  char: string,
  localIndex: number,
  visualColumn: number,
  widthColumns: number,
  charWidth: number,
): void {
  const kind = hiddenCharacterKind(char);
  if (!kind) return;

  const offset = row.startOffset + localIndex;
  if (!shouldShowHiddenCharacterAtOffset(view, offset)) return;

  markers.push({
    kind,
    offset,
    left: visualColumn * charWidth,
    width: widthColumns * charWidth,
  });
}

function hiddenCharacterKind(char: string): HiddenCharacterKind | null {
  if (char === " ") return "space";
  if (char === "\t") return "tab";
  return null;
}

function hiddenCharacterVisualWidth(char: string, visualColumn: number): number {
  if (char !== "\t") return 1;
  return DEFAULT_TAB_SIZE - (visualColumn % DEFAULT_TAB_SIZE);
}

function hiddenCharacterCellWidth(view: VirtualizedTextViewInternal): number {
  return Math.max(1, view.metrics.characterWidth);
}

function shouldShowHiddenCharacterAtOffset(
  view: VirtualizedTextViewInternal,
  offset: number,
): boolean {
  if (view.hiddenCharacters === "show") return true;
  if (view.hiddenCharacters !== "show-on-selection") return false;

  return view.selections.some((selection) => selectionContainsOffset(selection, offset));
}

function selectionContainsOffset(selection: VirtualizedStoredSelection, offset: number): boolean {
  if (selection.start === selection.end) return false;
  if (offset < selection.start) return false;
  return offset < selection.end;
}

function hiddenCharacterMarkerKey(markers: readonly HiddenCharacterMarker[]): string {
  return markers.map(hiddenCharacterMarkerKeyPart).join("|");
}

function hiddenCharacterMarkerKeyPart(marker: HiddenCharacterMarker): string {
  return `${marker.kind}:${marker.offset}:${marker.left}:${marker.width}`;
}

function createHiddenCharacterMarker(
  row: MountedVirtualizedTextRow,
  marker: HiddenCharacterMarker,
): HTMLSpanElement {
  const element = row.element.ownerDocument.createElement("span");
  element.className = "editor-virtualized-hidden-character-marker";
  element.dataset.editorHiddenCharacter = marker.kind;
  element.dataset.editorHiddenCharacterOffset = String(marker.offset);
  setStyleValue(element, "left", `${marker.left}px`);
  setStyleValue(element, "width", `${marker.width}px`);
  return element;
}

export function clearHiddenCharactersForRow(row: MountedVirtualizedTextRow): void {
  setHiddenCharactersKey(row, "");
  row.hiddenCharactersLayerElement.replaceChildren();
  row.hiddenCharactersLayerElement.remove();
}

function attachHiddenCharacterLayer(row: MountedVirtualizedTextRow): void {
  const layer = row.hiddenCharactersLayerElement;
  if (layer.parentElement === row.element) return;
  if (row.foldPlaceholderElement.parentElement === row.element) {
    row.element.insertBefore(layer, row.foldPlaceholderElement);
    return;
  }

  row.element.appendChild(layer);
}

function setHiddenCharactersKey(row: MountedVirtualizedTextRow, key: string): void {
  const mutable = row as { hiddenCharactersKey: string };
  mutable.hiddenCharactersKey = key;
}
