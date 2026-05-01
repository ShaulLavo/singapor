import type * as lsp from "vscode-languageserver-protocol";

const TYPE_SCRIPT_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);

export function sourcePathToFileName(path: string): string {
  if (hasUriScheme(path)) return documentUriToFileName(path) ?? normalizeFileNamePath(path);
  return normalizeFileNamePath(path);
}

export function pathOrUriToDocumentUri(pathOrUri: string): lsp.DocumentUri {
  if (!hasUriScheme(pathOrUri)) return fileNameToDocumentUri(sourcePathToFileName(pathOrUri));

  const fileName = documentUriToFileName(pathOrUri);
  if (!fileName) return pathOrUri;
  return fileNameToDocumentUri(fileName);
}

export function fileNameToDocumentUri(fileName: string): lsp.DocumentUri {
  const normalized = normalizeFileNamePath(fileName);
  return `file://${encodePathname(normalized)}`;
}

export function documentUriToFileName(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") return null;
    return normalizeFileNamePath(decodeURIComponent(url.pathname));
  } catch {
    return null;
  }
}

export function isTypeScriptFileName(fileName: string): boolean {
  return TYPE_SCRIPT_EXTENSIONS.has(extensionForPath(fileName));
}

function normalizeFileNamePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized) return "/";
  return `/${normalized}`;
}

function encodePathname(pathname: string): string {
  return pathname
    .split("/")
    .map((part, index) => (index === 0 && part === "" ? "" : encodeURIComponent(part)))
    .join("/");
}

function extensionForPath(path: string): string {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) return "";
  return fileName.slice(dotIndex).toLowerCase();
}

function hasUriScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}
