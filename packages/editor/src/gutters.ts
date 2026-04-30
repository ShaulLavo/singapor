import type { EditorGutterContribution, EditorGutterRowContext, EditorPlugin } from "./plugins";
import type { VirtualizedFoldMarker } from "./virtualization/virtualizedTextViewTypes";

export type LineGutterPluginOptions = {
  readonly counterStyle?: string;
  readonly minLabelColumns?: number;
  readonly minWidth?: number;
};

export type FoldGutterIconContext = {
  readonly document: Document;
  readonly state: "expanded" | "collapsed";
  readonly marker: VirtualizedFoldMarker;
};

export type FoldGutterIcon = string | ((context: FoldGutterIconContext) => string | Node);

export type FoldGutterPluginOptions = {
  readonly width?: number;
  readonly expandedIndicator?: string;
  readonly collapsedIndicator?: string;
  readonly icon?: FoldGutterIcon;
  readonly expandedIcon?: FoldGutterIcon;
  readonly collapsedIcon?: FoldGutterIcon;
  readonly buttonClassName?: string;
  readonly iconClassName?: string;
};

type FoldGutterState = FoldGutterIconContext["state"];

type FoldGutterTransition = "expand" | "collapse";

type FoldGutterIconSource = {
  readonly icon: FoldGutterIcon;
  readonly stateSpecific: boolean;
};

type FoldGutterRenderOptions = {
  readonly expandedIndicator: string;
  readonly collapsedIndicator: string;
  readonly icon?: FoldGutterIcon;
  readonly expandedIcon?: FoldGutterIcon;
  readonly collapsedIcon?: FoldGutterIcon;
  readonly iconClassName?: string;
};

const DEFAULT_COUNTER_STYLE = "decimal";
const DEFAULT_LINE_GUTTER_MIN_COLUMNS = 3;
const DEFAULT_LINE_GUTTER_MIN_WIDTH = 26;
const LINE_GUTTER_PADDING_PX = 8;
const DEFAULT_FOLD_GUTTER_WIDTH = 10;
const DEFAULT_EXPANDED_INDICATOR = "v";
const DEFAULT_COLLAPSED_INDICATOR = ">";

export function createLineGutterPlugin(options: LineGutterPluginOptions = {}): EditorPlugin {
  const contribution = createLineGutterContribution(options);

  return {
    name: "line-gutter",
    activate(context) {
      return context.registerGutterContribution(contribution);
    },
  };
}

export function createFoldGutterPlugin(options: FoldGutterPluginOptions = {}): EditorPlugin {
  const contribution = createFoldGutterContribution(options);

  return {
    name: "fold-gutter",
    activate(context) {
      return context.registerGutterContribution(contribution);
    },
  };
}

export function createLineGutterContribution(
  options: LineGutterPluginOptions = {},
): EditorGutterContribution {
  const counterStyle = options.counterStyle ?? DEFAULT_COUNTER_STYLE;
  const minLabelColumns = normalizePositiveInteger(
    options.minLabelColumns,
    DEFAULT_LINE_GUTTER_MIN_COLUMNS,
  );
  const minWidth = normalizeNonNegativeNumber(options.minWidth, DEFAULT_LINE_GUTTER_MIN_WIDTH);

  return {
    id: "line-gutter",
    createCell(document) {
      const element = document.createElement("span");
      element.className = "editor-virtualized-gutter-label editor-virtualized-line-number";
      element.setAttribute("aria-hidden", "true");
      element.style.setProperty("--editor-line-gutter-counter-style", counterStyle);
      return element;
    },
    width(context) {
      const columns = Math.max(minLabelColumns, decimalDigitCount(context.lineCount));
      return Math.max(
        minWidth,
        Math.ceil(columns * context.metrics.characterWidth + LINE_GUTTER_PADDING_PX),
      );
    },
    updateCell(element, row) {
      updateLineGutterCell(element, row);
    },
  };
}

export function createFoldGutterContribution(
  options: FoldGutterPluginOptions = {},
): EditorGutterContribution {
  const width = normalizeNonNegativeNumber(options.width, DEFAULT_FOLD_GUTTER_WIDTH);
  const renderOptions: FoldGutterRenderOptions = {
    expandedIndicator: options.expandedIndicator ?? DEFAULT_EXPANDED_INDICATOR,
    collapsedIndicator: options.collapsedIndicator ?? DEFAULT_COLLAPSED_INDICATOR,
    icon: options.icon,
    expandedIcon: options.expandedIcon,
    collapsedIcon: options.collapsedIcon,
    iconClassName: options.iconClassName,
  };

  return {
    id: "fold-gutter",
    createCell(document) {
      const button = document.createElement("button");
      button.className = "editor-virtualized-fold-toggle";
      addClassName(button, options.buttonClassName);
      button.type = "button";
      button.hidden = true;
      button.disabled = true;
      button.tabIndex = -1;
      button.addEventListener("mousedown", preventFoldButtonMouseDown);
      button.addEventListener("animationend", clearFoldTransition);
      button.addEventListener("animationcancel", clearFoldTransition);
      return button;
    },
    width() {
      return width;
    },
    updateCell(element, row) {
      if (!(element instanceof HTMLButtonElement)) return;
      updateFoldGutterButton(element, row, renderOptions);
    },
    disposeCell(element) {
      if (!(element instanceof HTMLButtonElement)) return;
      element.onclick = null;
      element.removeEventListener("mousedown", preventFoldButtonMouseDown);
      element.removeEventListener("animationend", clearFoldTransition);
      element.removeEventListener("animationcancel", clearFoldTransition);
    },
  };
}

function updateLineGutterCell(element: HTMLElement, row: EditorGutterRowContext): void {
  setElementHidden(element, !row.primaryText);
  element.classList.toggle(
    "editor-virtualized-line-number-active",
    row.primaryText && row.cursorLine,
  );
  if (!row.primaryText) return;

  setCounterSet(element, `editor-line ${row.bufferRow + 1}`);
}

function updateFoldGutterButton(
  button: HTMLButtonElement,
  row: EditorGutterRowContext,
  options: FoldGutterRenderOptions,
): void {
  const marker = row.foldMarker;
  if (!marker) {
    hideFoldButton(button);
    return;
  }

  const state = marker.collapsed ? "collapsed" : "expanded";
  const previousKey = button.dataset.editorFoldKey;
  const previousState = button.dataset.editorFoldState;
  showFoldButton(button, marker.key, state);
  updateFoldTransition(button, previousKey, previousState, marker.key, state);
  renderFoldIconIfNeeded(button, marker, state, options);
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    row.toggleFold(marker);
  };
}

function hideFoldButton(button: HTMLButtonElement): void {
  setElementHidden(button, true);
  if (!button.disabled) button.disabled = true;
  if (button.tabIndex !== -1) button.tabIndex = -1;
  button.onclick = null;
  delete button.dataset.editorFoldKey;
  delete button.dataset.editorFoldState;
  delete button.dataset.editorFoldIndicator;
  delete button.dataset.editorFoldIconSignature;
  delete button.dataset.editorFoldTransition;
  if (button.childNodes.length > 0) button.replaceChildren();
  button.removeAttribute("aria-label");
}

function showFoldButton(button: HTMLButtonElement, key: string, state: FoldGutterState): void {
  const label = state === "collapsed" ? "Expand folded region" : "Collapse foldable region";
  setElementHidden(button, false);
  if (button.disabled) button.disabled = false;
  if (button.tabIndex !== 0) button.tabIndex = 0;
  button.dataset.editorFoldKey = key;
  button.dataset.editorFoldState = state;
  button.setAttribute("aria-label", label);
}

function renderFoldIconIfNeeded(
  button: HTMLButtonElement,
  marker: VirtualizedFoldMarker,
  state: FoldGutterState,
  options: FoldGutterRenderOptions,
): void {
  const source = resolveFoldIconSource(options, state);
  const signature = foldIconSignature(marker, state, source);
  if (button.dataset.editorFoldIconSignature === signature) return;

  const content = createFoldIconContent(button.ownerDocument, marker, state, source.icon);
  const icon = createFoldIconElement(button.ownerDocument, options.iconClassName);
  appendFoldIconContent(icon, content);
  button.replaceChildren(icon);
  button.dataset.editorFoldIconSignature = signature;
  syncFoldIndicatorDataset(button, content);
}

function resolveFoldIconSource(
  options: FoldGutterRenderOptions,
  state: FoldGutterState,
): FoldGutterIconSource {
  const stateIcon = state === "collapsed" ? options.collapsedIcon : options.expandedIcon;
  if (stateIcon !== undefined) return { icon: stateIcon, stateSpecific: true };
  if (options.icon !== undefined) return { icon: options.icon, stateSpecific: false };

  const icon = state === "collapsed" ? options.collapsedIndicator : options.expandedIndicator;
  return { icon, stateSpecific: true };
}

function foldIconSignature(
  marker: VirtualizedFoldMarker,
  state: FoldGutterState,
  source: FoldGutterIconSource,
): string {
  const stateKey = source.stateSpecific ? state : "shared";
  return `${marker.key}:${stateKey}`;
}

function createFoldIconContent(
  document: Document,
  marker: VirtualizedFoldMarker,
  state: FoldGutterState,
  icon: FoldGutterIcon,
): string | Node {
  if (typeof icon === "string") return icon;
  return icon({ document, state, marker });
}

function createFoldIconElement(document: Document, className: string | undefined): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.className = "editor-virtualized-fold-icon";
  icon.setAttribute("aria-hidden", "true");
  addClassName(icon, className);
  return icon;
}

function appendFoldIconContent(icon: HTMLSpanElement, content: string | Node): void {
  if (typeof content === "string") {
    icon.textContent = content;
    return;
  }

  icon.appendChild(content);
}

function syncFoldIndicatorDataset(button: HTMLButtonElement, content: string | Node): void {
  if (typeof content === "string") {
    button.dataset.editorFoldIndicator = content;
    return;
  }

  delete button.dataset.editorFoldIndicator;
}

function updateFoldTransition(
  button: HTMLButtonElement,
  previousKey: string | undefined,
  previousState: string | undefined,
  nextKey: string,
  nextState: FoldGutterState,
): void {
  if (previousKey !== nextKey) {
    delete button.dataset.editorFoldTransition;
    return;
  }
  if (!isFoldGutterState(previousState)) {
    delete button.dataset.editorFoldTransition;
    return;
  }
  if (previousState === nextState) return;

  button.dataset.editorFoldTransition = foldTransitionForState(nextState);
}

function foldTransitionForState(state: FoldGutterState): FoldGutterTransition {
  return state === "collapsed" ? "collapse" : "expand";
}

function isFoldGutterState(state: string | undefined): state is FoldGutterState {
  return state === "collapsed" || state === "expanded";
}

function preventFoldButtonMouseDown(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function clearFoldTransition(event: Event): void {
  if (!(event.currentTarget instanceof HTMLButtonElement)) return;
  delete event.currentTarget.dataset.editorFoldTransition;
}

function setElementHidden(element: HTMLElement, hidden: boolean): void {
  if (element.hidden === hidden) return;
  element.hidden = hidden;
}

function setCounterSet(element: HTMLElement, value: string): void {
  if (element.style.counterSet === value) return;
  element.style.counterSet = value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value < 0) return fallback;
  return value;
}

function addClassName(element: HTMLElement, className: string | undefined): void {
  const classNames = className?.split(/\s+/).filter(Boolean) ?? [];
  if (classNames.length === 0) return;
  element.classList.add(...classNames);
}

function decimalDigitCount(value: number): number {
  return String(Math.max(1, Math.floor(value))).length;
}
