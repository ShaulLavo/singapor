export type EditorSyntaxThemeColor =
  | "attribute"
  | "bracket"
  | "comment"
  | "constant"
  | "function"
  | "keyword"
  | "keywordDeclaration"
  | "keywordImport"
  | "namespace"
  | "number"
  | "property"
  | "string"
  | "type"
  | "typeDefinition"
  | "typeParameter"
  | "variable"
  | "variableBuiltin";

export type EditorSyntaxTheme = Partial<Record<EditorSyntaxThemeColor, string>>;

export type EditorTheme = {
  readonly backgroundColor?: string;
  readonly foregroundColor?: string;
  readonly gutterBackgroundColor?: string;
  readonly gutterForegroundColor?: string;
  readonly caretColor?: string;
  readonly minimapBackgroundColor?: string;
  readonly syntax?: EditorSyntaxTheme;
};

const EDITOR_THEME_VARIABLES = [
  { key: "backgroundColor", variable: "--editor-background" },
  { key: "foregroundColor", variable: "--editor-foreground" },
  { key: "gutterBackgroundColor", variable: "--editor-gutter-background" },
  { key: "gutterForegroundColor", variable: "--editor-gutter-foreground" },
  { key: "caretColor", variable: "--editor-caret-color" },
  { key: "minimapBackgroundColor", variable: "--editor-minimap-background" },
] satisfies ReadonlyArray<{
  readonly key: Exclude<keyof EditorTheme, "syntax">;
  readonly variable: string;
}>;

const EDITOR_SYNTAX_THEME_VARIABLES = [
  { key: "attribute", variable: "--editor-syntax-attribute" },
  { key: "bracket", variable: "--editor-syntax-bracket" },
  { key: "comment", variable: "--editor-syntax-comment" },
  { key: "constant", variable: "--editor-syntax-constant" },
  { key: "function", variable: "--editor-syntax-function" },
  { key: "keyword", variable: "--editor-syntax-keyword" },
  { key: "keywordDeclaration", variable: "--editor-syntax-keyword-declaration" },
  { key: "keywordImport", variable: "--editor-syntax-keyword-import" },
  { key: "namespace", variable: "--editor-syntax-namespace" },
  { key: "number", variable: "--editor-syntax-number" },
  { key: "property", variable: "--editor-syntax-property" },
  { key: "string", variable: "--editor-syntax-string" },
  { key: "type", variable: "--editor-syntax-type" },
  { key: "typeDefinition", variable: "--editor-syntax-type-definition" },
  { key: "typeParameter", variable: "--editor-syntax-type-parameter" },
  { key: "variable", variable: "--editor-syntax-variable" },
  { key: "variableBuiltin", variable: "--editor-syntax-variable-builtin" },
] satisfies ReadonlyArray<{
  readonly key: EditorSyntaxThemeColor;
  readonly variable: string;
}>;

type WritableEditorTheme = {
  -readonly [Key in keyof EditorTheme]: EditorTheme[Key];
};

export function applyEditorTheme(
  element: HTMLElement,
  theme: EditorTheme | null | undefined,
): void {
  clearEditorTheme(element);
  if (!theme) return;

  for (const { key, variable } of EDITOR_THEME_VARIABLES) {
    setOptionalCssVariable(element, variable, theme[key]);
  }

  for (const { key, variable } of EDITOR_SYNTAX_THEME_VARIABLES) {
    setOptionalCssVariable(element, variable, theme.syntax?.[key]);
  }
}

export function mergeEditorThemes(
  ...themes: readonly (EditorTheme | null | undefined)[]
): EditorTheme | null {
  const merged: WritableEditorTheme = {};
  let syntax: EditorSyntaxTheme | undefined;
  let hasTheme = false;

  for (const theme of themes) {
    if (!theme) continue;

    hasTheme = true;
    mergeThemeColors(merged, theme);
    syntax = mergeSyntaxTheme(syntax, theme.syntax);
  }

  if (!hasTheme) return null;
  if (syntax) merged.syntax = syntax;
  return merged;
}

function clearEditorTheme(element: HTMLElement): void {
  for (const { variable } of EDITOR_THEME_VARIABLES) element.style.removeProperty(variable);
  for (const { variable } of EDITOR_SYNTAX_THEME_VARIABLES) element.style.removeProperty(variable);
}

function setOptionalCssVariable(
  element: HTMLElement,
  variable: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  element.style.setProperty(variable, value);
}

function mergeThemeColors(target: WritableEditorTheme, theme: EditorTheme): void {
  for (const { key } of EDITOR_THEME_VARIABLES) {
    const value = theme[key];
    if (value !== undefined) target[key] = value;
  }
}

function mergeSyntaxTheme(
  previous: EditorSyntaxTheme | undefined,
  next: EditorSyntaxTheme | undefined,
): EditorSyntaxTheme | undefined {
  if (!next) return previous;
  return { ...previous, ...next };
}
