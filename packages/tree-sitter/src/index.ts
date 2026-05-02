export {
  TreeSitterLanguageRegistry,
  createTreeSitterLanguageRegistry,
  isTreeSitterLanguageId,
  resolveTreeSitterLanguageAlias,
  resolveTreeSitterLanguageContribution,
  type TreeSitterLanguageAssets,
  type TreeSitterLanguageContribution,
  type TreeSitterLanguageDescriptor,
  type TreeSitterLanguageDisposable,
  type TreeSitterLanguageId,
  type TreeSitterLanguageRegistrationOptions,
  type TreeSitterLanguageResolver,
} from "./treeSitter/registry";
export type {
  BracketInfo,
  FoldRange,
  TreeSitterCapture,
  TreeSitterError,
  TreeSitterInjectionInfo,
  TreeSitterParseResult,
  TreeSitterPoint,
} from "./treeSitter/types";
export {
  canUseTreeSitterWorker,
  createTreeSitterWorkerBackend,
  disposeTreeSitterDocument,
  disposeTreeSitterWorker,
  editWithTreeSitter,
  parseWithTreeSitter,
  registerTreeSitterLanguagesWithWorker,
  selectWithTreeSitter,
  type TreeSitterBackend,
  type TreeSitterEditPayload,
  type TreeSitterParsePayload,
  type TreeSitterSelectionPayload,
} from "./treeSitter/workerClient";
export {
  createTreeSitterSourceDescriptor,
  readTreeSitterInputRange,
  readTreeSitterPieceTableInput,
  resolveTreeSitterSourceDescriptor,
  type TreeSitterSourceCache,
  type TreeSitterSourceDescriptor,
} from "./treeSitter/source";
export {
  TreeSitterSyntaxSession,
  createTextDiffEdit,
  createTreeSitterEditPayload,
  type TreeSitterSyntaxSessionOptions,
} from "./session";
export {
  expandTreeSitterSelection,
  selectTreeSitterToken,
  shrinkTreeSitterSelection,
  type TreeSitterSelectionCommandOptions,
  type TreeSitterSelectionCommandResult,
  type TreeSitterSelectionExpansionState,
} from "./structuralSelection";

import type {
  EditorDisposable,
  EditorPlugin,
  EditorPluginContext,
  EditorSyntaxProvider,
} from "@editor/core";
import type {
  TreeSitterLanguageContribution,
  TreeSitterLanguageDisposable,
  TreeSitterLanguageRegistrationOptions,
  TreeSitterLanguageResolver,
} from "./treeSitter/registry";
import { TreeSitterLanguageRegistry } from "./treeSitter/registry";
import { TreeSitterSyntaxSession } from "./session";
import { createTreeSitterWorkerBackend, type TreeSitterBackend } from "./treeSitter/workerClient";

export type TreeSitterSyntaxProviderOptions = {
  readonly backend?: TreeSitterBackend;
};

export type TreeSitterSyntaxProvider = EditorSyntaxProvider &
  TreeSitterLanguageResolver & {
    registerLanguage(
      contribution: TreeSitterLanguageContribution,
      options?: TreeSitterLanguageRegistrationOptions,
    ): TreeSitterLanguageDisposable;
  };

export type TreeSitterLanguagePluginOptions = TreeSitterLanguageRegistrationOptions & {
  readonly name?: string;
};

type TreeSitterProviderRegistration = {
  readonly provider: TreeSitterSyntaxProvider;
  syntaxDisposable: { dispose(): void } | null;
  references: number;
};

const providersByContext = new WeakMap<EditorPluginContext, TreeSitterProviderRegistration>();

export const createTreeSitterSyntaxProvider = (
  options: TreeSitterSyntaxProviderOptions = {},
): TreeSitterSyntaxProvider => {
  const registry = new TreeSitterLanguageRegistry();
  const backend = options.backend ?? createTreeSitterWorkerBackend();

  return {
    createSession: (sessionOptions) => {
      if (!sessionOptions.languageId) return null;
      return new TreeSitterSyntaxSession({
        ...sessionOptions,
        languageId: sessionOptions.languageId,
        languageResolver: registry,
        backend,
      });
    },
    registerLanguage: (contribution, registrationOptions) =>
      registry.registerLanguage(contribution, registrationOptions),
    resolveTreeSitterLanguage: (languageId) => registry.resolveTreeSitterLanguage(languageId),
  };
};

export const createTreeSitterLanguagePlugin = (
  contributions: readonly TreeSitterLanguageContribution[],
  options: TreeSitterLanguagePluginOptions = {},
): EditorPlugin => ({
  name: options.name ?? "tree-sitter-languages",
  activate(context) {
    const registration = providerRegistrationForContext(context);
    const provider = registration.provider;
    return [
      retainSyntaxProvider(context, registration),
      ...contributions.map((contribution) =>
        provider.registerLanguage(contribution, {
          replace: options.replace,
        }),
      ),
    ];
  },
});

const providerRegistrationForContext = (
  context: EditorPluginContext,
): TreeSitterProviderRegistration => {
  const existing = providersByContext.get(context);
  if (existing) return existing;

  const registration = {
    provider: createTreeSitterSyntaxProvider(),
    syntaxDisposable: null,
    references: 0,
  };
  providersByContext.set(context, registration);
  return registration;
};

const retainSyntaxProvider = (
  context: EditorPluginContext,
  registration: TreeSitterProviderRegistration,
): EditorDisposable => {
  if (registration.references === 0) {
    registration.syntaxDisposable = context.registerSyntaxProvider(registration.provider);
  }

  registration.references += 1;
  return {
    dispose: () => releaseSyntaxProvider(context, registration),
  };
};

const releaseSyntaxProvider = (
  context: EditorPluginContext,
  registration: TreeSitterProviderRegistration,
): void => {
  registration.references -= 1;
  if (registration.references > 0) return;

  registration.syntaxDisposable?.dispose();
  registration.syntaxDisposable = null;
  providersByContext.delete(context);
};
