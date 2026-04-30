import type { DocumentSessionChange } from "./documentSession";
import type { PieceTableSnapshot } from "./pieceTable/pieceTableTypes";
import type { EditorTheme } from "./theme";
import type { EditorToken } from "./tokens";
import type { EditorSyntaxLanguageId } from "./syntax/session";
import {
  TreeSitterLanguageRegistry,
  type TreeSitterLanguageContribution,
  type TreeSitterLanguageDescriptor,
  type TreeSitterLanguageRegistrationOptions,
} from "./syntax/treeSitter/registry";
import type { BrowserTextMetrics } from "./virtualization/browserMetrics";
import type { FixedRowVisibleRange } from "./virtualization/fixedRowVirtualizer";

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
  readonly viewport: EditorViewportSnapshot;
};

export type EditorOverlaySide = "left" | "right";

export type EditorViewContributionContext = {
  readonly container: HTMLElement;
  readonly scrollElement: HTMLDivElement;
  getSnapshot(): EditorViewSnapshot;
  revealLine(row: number): void;
  setScrollTop(scrollTop: number): void;
  reserveOverlayWidth(side: EditorOverlaySide, width: number): void;
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

export type EditorPluginContext = {
  registerHighlighter(provider: EditorHighlighterProvider): EditorDisposable;
  registerTreeSitterLanguage(
    contribution: TreeSitterLanguageContribution,
    options?: TreeSitterLanguageRegistrationOptions,
  ): EditorDisposable;
  registerViewContribution(provider: EditorViewContributionProvider): EditorDisposable;
};

export type EditorPlugin = {
  readonly name?: string;
  activate(context: EditorPluginContext): void | EditorDisposable | readonly EditorDisposable[];
};

export type TreeSitterLanguagePluginOptions = TreeSitterLanguageRegistrationOptions & {
  readonly name?: string;
};

export class EditorPluginHost implements EditorDisposable {
  private readonly highlighters: EditorHighlighterProvider[] = [];
  private readonly treeSitterLanguages = new TreeSitterLanguageRegistry();
  private readonly viewContributions: EditorViewContributionProvider[] = [];
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

  public hasTreeSitterLanguage(languageId: string | null | undefined): boolean {
    return this.treeSitterLanguages.hasLanguage(languageId);
  }

  public resolveTreeSitterLanguage(
    languageId: EditorSyntaxLanguageId,
  ): Promise<TreeSitterLanguageDescriptor | null> {
    return this.treeSitterLanguages.resolveTreeSitterLanguage(languageId);
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

  public dispose(): void {
    while (this.disposables.length > 0) this.disposables.pop()?.dispose();
    this.highlighters.length = 0;
    this.treeSitterLanguages.clear();
    this.viewContributions.length = 0;
  }

  private createContext(): EditorPluginContext {
    return {
      registerHighlighter: (provider) => this.registerHighlighter(provider),
      registerTreeSitterLanguage: (contribution, options) =>
        this.registerTreeSitterLanguage(contribution, options),
      registerViewContribution: (provider) => this.registerViewContribution(provider),
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

  private registerTreeSitterLanguage(
    contribution: TreeSitterLanguageContribution,
    options: TreeSitterLanguageRegistrationOptions = {},
  ): EditorDisposable {
    return this.treeSitterLanguages.registerLanguage(contribution, options);
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

export const createTreeSitterLanguagePlugin = (
  contributions: readonly TreeSitterLanguageContribution[],
  options: TreeSitterLanguagePluginOptions = {},
): EditorPlugin => ({
  name: options.name ?? "tree-sitter-languages",
  activate(context) {
    return contributions.map((contribution) =>
      context.registerTreeSitterLanguage(contribution, {
        replace: options.replace,
      }),
    );
  },
});
