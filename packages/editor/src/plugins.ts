import type { DocumentSessionChange } from "./documentSession";
import type { EditorCommandContext, EditorCommandId } from "./editor/commands";
import type { PieceTableSnapshot } from "./pieceTable/pieceTableTypes";
import type { EditorTheme } from "./theme";
import type { EditorToken, TextEdit } from "./tokens";
import {
  type EditorSyntaxLanguageId,
  type EditorSyntaxProvider,
  type EditorSyntaxSession,
  type EditorSyntaxSessionOptions,
} from "./syntax/session";
import type { BrowserTextMetrics } from "./virtualization/browserMetrics";
import type { FixedRowVisibleRange } from "./virtualization/fixedRowVirtualizer";
import type {
  EditorCursorLineHighlightOptions,
  VirtualizedFoldMarker,
  VirtualizedTextHighlightStyle,
} from "./virtualization/virtualizedTextViewTypes";

export type EditorDisposable = {
  dispose(): void;
};

export type EditorHighlightResult = {
  readonly tokens: readonly EditorToken[];
  readonly theme?: EditorTheme | null;
};

export type EditorHighlighterSessionOptions = {
  readonly documentId: string;
  readonly languageId: EditorSyntaxLanguageId | null;
  readonly text: string;
  readonly snapshot: PieceTableSnapshot;
};

export type EditorHighlighterSession = EditorDisposable & {
  refresh(snapshot: PieceTableSnapshot, text?: string): Promise<EditorHighlightResult>;
  applyChange(change: DocumentSessionChange): Promise<EditorHighlightResult>;
};

export type EditorHighlighterProvider = {
  loadTheme?(): Promise<EditorTheme | null | undefined>;
  createSession(options: EditorHighlighterSessionOptions): EditorHighlighterSession | null;
};

export type EditorResolvedSelection = {
  readonly anchorOffset: number;
  readonly headOffset: number;
  readonly startOffset: number;
  readonly endOffset: number;
};

export type EditorViewportSnapshot = {
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
  readonly clientHeight: number;
  readonly clientWidth: number;
  readonly borderBoxHeight?: number;
  readonly borderBoxWidth?: number;
  readonly visibleRange: FixedRowVisibleRange;
};

export type EditorVisibleRowSnapshot = {
  readonly index: number;
  readonly bufferRow: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
  readonly kind: "text" | "block";
  readonly primaryText: boolean;
  readonly top: number;
  readonly height: number;
};

export type EditorViewSnapshot = {
  readonly documentId: string | null;
  readonly languageId: EditorSyntaxLanguageId | null;
  readonly text: string;
  readonly textVersion: number;
  readonly lineStarts: readonly number[];
  readonly tokens: readonly EditorToken[];
  readonly selections: readonly EditorResolvedSelection[];
  readonly metrics: BrowserTextMetrics;
  readonly lineCount: number;
  readonly contentWidth: number;
  readonly totalHeight: number;
  readonly tabSize: number;
  readonly foldMarkers: readonly VirtualizedFoldMarker[];
  readonly visibleRows: readonly EditorVisibleRowSnapshot[];
  readonly viewport: EditorViewportSnapshot;
};

export type EditorOverlaySide = "left" | "right";

export type EditorViewContributionContext = {
  readonly container: HTMLElement;
  readonly scrollElement: HTMLDivElement;
  readonly highlightPrefix?: string;
  getSnapshot(): EditorViewSnapshot;
  revealLine(row: number): void;
  focusEditor(): void;
  setSelection(anchor: number, head: number, timingName: string, revealOffset?: number): void;
  setScrollTop(scrollTop: number): void;
  reserveOverlayWidth(side: EditorOverlaySide, width: number): void;
  textOffsetFromPoint(clientX: number, clientY: number): number | null;
  getRangeClientRect(start: number, end: number): DOMRect | null;
  setRangeHighlight?(
    name: string,
    ranges: readonly { readonly start: number; readonly end: number }[],
    style: VirtualizedTextHighlightStyle,
  ): void;
  clearRangeHighlight?(name: string): void;
};

export type EditorViewContributionUpdateKind =
  | "document"
  | "content"
  | "tokens"
  | "selection"
  | "viewport"
  | "layout"
  | "clear";

export type EditorViewContribution = EditorDisposable & {
  update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void;
};

export type EditorViewContributionProvider = {
  createContribution(context: EditorViewContributionContext): EditorViewContribution | null;
};

export type EditorCommandHandler = (context: EditorCommandContext) => boolean;

export type EditorSelectionRange = {
  readonly anchor: number;
  readonly head: number;
};

export type EditorFeatureContributionContext = {
  readonly container: HTMLElement;
  readonly scrollElement: HTMLDivElement;
  readonly highlightPrefix: string;
  hasDocument(): boolean;
  getText(): string;
  getSelections(): readonly EditorResolvedSelection[];
  focusEditor(): void;
  setSelection(anchor: number, head: number, timingName: string, revealOffset?: number): void;
  setSelections(
    selections: readonly EditorSelectionRange[],
    timingName: string,
    revealOffset?: number,
  ): void;
  applyEdits(
    edits: readonly TextEdit[],
    timingName: string,
    selection?: EditorSelectionRange,
  ): void;
  setRangeHighlight(
    name: string,
    ranges: readonly { readonly start: number; readonly end: number }[],
    style: VirtualizedTextHighlightStyle,
  ): void;
  clearRangeHighlight(name: string): void;
  registerCommand(command: EditorCommandId, handler: EditorCommandHandler): EditorDisposable;
  registerFeature<T>(id: string, feature: T): EditorDisposable;
};

export type EditorFeatureContribution = EditorDisposable & {
  handleEditorChange?(change: DocumentSessionChange | null): void;
};

export type EditorFeatureContributionProvider = {
  createContribution(context: EditorFeatureContributionContext): EditorFeatureContribution | null;
};

export type EditorGutterWidthContext = {
  readonly lineCount: number;
  readonly metrics: BrowserTextMetrics;
};

export type EditorGutterRowContext = {
  readonly index: number;
  readonly bufferRow: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
  readonly kind: "text" | "block";
  readonly primaryText: boolean;
  readonly cursorLine: boolean;
  readonly cursorLineHighlight: Required<EditorCursorLineHighlightOptions>;
  readonly foldMarker: VirtualizedFoldMarker | null;
  readonly lineCount: number;
  toggleFold(marker: VirtualizedFoldMarker): void;
};

export type EditorGutterContribution = {
  readonly id: string;
  readonly className?: string;
  createCell(document: Document): HTMLElement;
  width(context: EditorGutterWidthContext): number;
  updateCell(element: HTMLElement, row: EditorGutterRowContext): void;
  disposeCell?(element: HTMLElement): void;
};

export type EditorPluginContext = {
  registerHighlighter(provider: EditorHighlighterProvider): EditorDisposable;
  registerSyntaxProvider(provider: EditorSyntaxProvider): EditorDisposable;
  registerViewContribution(provider: EditorViewContributionProvider): EditorDisposable;
  registerEditorFeatureContribution(provider: EditorFeatureContributionProvider): EditorDisposable;
  registerGutterContribution(contribution: EditorGutterContribution): EditorDisposable;
};

export type EditorPlugin = {
  readonly name?: string;
  activate(context: EditorPluginContext): void | EditorDisposable | readonly EditorDisposable[];
};

export class EditorPluginHost implements EditorDisposable {
  private readonly highlighters: EditorHighlighterProvider[] = [];
  private readonly syntaxProviders: EditorSyntaxProvider[] = [];
  private readonly viewContributions: EditorViewContributionProvider[] = [];
  private readonly editorFeatureContributions: EditorFeatureContributionProvider[] = [];
  private readonly gutterContributions: EditorGutterContribution[] = [];
  private readonly disposables: EditorDisposable[] = [];

  public constructor(plugins: readonly EditorPlugin[] = []) {
    const context = this.createContext();

    for (const plugin of plugins) {
      this.adoptActivationResult(plugin.activate(context));
    }
  }

  public createHighlighterSession(
    options: EditorHighlighterSessionOptions,
  ): EditorHighlighterSession | null {
    for (const provider of this.highlighters) {
      const session = provider.createSession(options);
      if (session) return session;
    }

    return null;
  }

  public async loadHighlighterTheme(): Promise<EditorTheme | null | undefined> {
    for (const provider of this.highlighters) {
      if (!provider.loadTheme) continue;

      const theme = await provider.loadTheme();
      if (theme !== undefined) return theme;
    }

    return undefined;
  }

  public createSyntaxSession(options: EditorSyntaxSessionOptions): EditorSyntaxSession | null {
    for (const provider of this.syntaxProviders) {
      const session = provider.createSession(options);
      if (session) return session;
    }

    return null;
  }

  public createViewContributions(context: EditorViewContributionContext): EditorViewContribution[] {
    const contributions: EditorViewContribution[] = [];
    for (const provider of this.viewContributions) {
      const contribution = provider.createContribution(context);
      if (contribution) contributions.push(contribution);
    }

    this.disposables.push(...contributions);
    return contributions;
  }

  public createEditorFeatureContributions(
    context: EditorFeatureContributionContext,
  ): EditorFeatureContribution[] {
    const contributions: EditorFeatureContribution[] = [];
    for (const provider of this.editorFeatureContributions) {
      const contribution = provider.createContribution(context);
      if (contribution) contributions.push(contribution);
    }

    this.disposables.push(...contributions);
    return contributions;
  }

  public getGutterContributions(): readonly EditorGutterContribution[] {
    return this.gutterContributions;
  }

  public dispose(): void {
    while (this.disposables.length > 0) this.disposables.pop()?.dispose();
    this.highlighters.length = 0;
    this.syntaxProviders.length = 0;
    this.viewContributions.length = 0;
    this.editorFeatureContributions.length = 0;
    this.gutterContributions.length = 0;
  }

  private createContext(): EditorPluginContext {
    return {
      registerHighlighter: (provider) => this.registerHighlighter(provider),
      registerSyntaxProvider: (provider) => this.registerSyntaxProvider(provider),
      registerViewContribution: (provider) => this.registerViewContribution(provider),
      registerEditorFeatureContribution: (provider) =>
        this.registerEditorFeatureContribution(provider),
      registerGutterContribution: (contribution) => this.registerGutterContribution(contribution),
    };
  }

  private registerHighlighter(provider: EditorHighlighterProvider): EditorDisposable {
    this.highlighters.push(provider);

    return {
      dispose: () => this.unregisterHighlighter(provider),
    };
  }

  private unregisterHighlighter(provider: EditorHighlighterProvider): void {
    const index = this.highlighters.indexOf(provider);
    if (index === -1) return;

    this.highlighters.splice(index, 1);
  }

  private registerSyntaxProvider(provider: EditorSyntaxProvider): EditorDisposable {
    this.syntaxProviders.push(provider);

    return {
      dispose: () => this.unregisterSyntaxProvider(provider),
    };
  }

  private unregisterSyntaxProvider(provider: EditorSyntaxProvider): void {
    const index = this.syntaxProviders.indexOf(provider);
    if (index === -1) return;

    this.syntaxProviders.splice(index, 1);
  }

  private registerViewContribution(provider: EditorViewContributionProvider): EditorDisposable {
    this.viewContributions.push(provider);

    return {
      dispose: () => this.unregisterViewContribution(provider),
    };
  }

  private unregisterViewContribution(provider: EditorViewContributionProvider): void {
    const index = this.viewContributions.indexOf(provider);
    if (index === -1) return;

    this.viewContributions.splice(index, 1);
  }

  private registerEditorFeatureContribution(
    provider: EditorFeatureContributionProvider,
  ): EditorDisposable {
    this.editorFeatureContributions.push(provider);

    return {
      dispose: () => this.unregisterEditorFeatureContribution(provider),
    };
  }

  private unregisterEditorFeatureContribution(provider: EditorFeatureContributionProvider): void {
    const index = this.editorFeatureContributions.indexOf(provider);
    if (index === -1) return;

    this.editorFeatureContributions.splice(index, 1);
  }

  private registerGutterContribution(contribution: EditorGutterContribution): EditorDisposable {
    this.gutterContributions.push(contribution);

    return {
      dispose: () => this.unregisterGutterContribution(contribution),
    };
  }

  private unregisterGutterContribution(contribution: EditorGutterContribution): void {
    const index = this.gutterContributions.indexOf(contribution);
    if (index === -1) return;

    this.gutterContributions.splice(index, 1);
  }

  private adoptActivationResult(
    result: void | EditorDisposable | readonly EditorDisposable[],
  ): void {
    if (!result) return;
    if (isDisposableList(result)) {
      this.disposables.push(...result);
      return;
    }

    this.disposables.push(result);
  }
}

const isDisposableList = (
  value: EditorDisposable | readonly EditorDisposable[],
): value is readonly EditorDisposable[] => Array.isArray(value);
