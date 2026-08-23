import { lspPositionToOffset, offsetToLspPosition } from '@singapor/lsp'
import type { EditorSetSelectionOptions } from '@singapor/core/editor'
import type * as lsp from 'vscode-languageserver-protocol'

import { documentUriToFileName } from './paths'
import type { LanguageServerFeatureRouter } from './serverSet'
import type { LanguageServerDefinitionTarget, LanguageServerNavigationKind } from './types'

/**
 * Half-open `[start, end)` offset range into the editor text buffer. Used
 * both to describe the identifier range under the pointer and (indirectly)
 * to suppress definition links that would just jump to the declaration the
 * user is already hovering.
 */
export type OffsetRange = {
  readonly start: number
  readonly end: number
}

/**
 * Inputs required to issue a `textDocument/definition` request against the
 * LSP client. The request is expressed in editor-native coordinates
 * (`offset` into `text`) and converted to an LSP `Position` internally.
 */
export type DefinitionRequest = {
  readonly uri: lsp.DocumentUri
  readonly text: string
  readonly offset: number
  readonly signal?: AbortSignal
}

export type NavigationRequest = DefinitionRequest & {
  readonly kind: LanguageServerNavigationKind
  readonly includeDeclaration?: boolean
}

/**
 * Normalized response from {@link requestDefinition}. The LSP protocol
 * permits a single `Location`, an array of `Location`, or an array of
 * `LocationLink` (or `null`); callers should not have to care which shape
 * was returned, so the raw result is collapsed into a flat list of
 * resolvable targets.
 */
export type DefinitionResult = {
  readonly targets: readonly LanguageServerDefinitionTarget[]
}

/**
 * Minimum editor surface required by {@link navigateToDefinition}. Matches
 * the corresponding subset of `EditorViewContributionContext` so the
 * contribution can pass its `context` through directly while keeping this
 * module decoupled from `@singapor/core`'s full contribution surface.
 */
export type NavigationEditor = {
  readonly text: string
  setSelection(
    anchor: number,
    head: number,
    timingName: string,
    options?: EditorSetSelectionOptions,
  ): void
  focusEditor(): void
}

const SET_SELECTION_TIMING_NAME = 'lspPlugin.goToDefinition'

const REQUEST_METHODS: Record<Exclude<LanguageServerNavigationKind, 'references'>, string> = {
  definition: 'textDocument/definition',
  implementation: 'textDocument/implementation',
  typeDefinition: 'textDocument/typeDefinition',
}

/**
 * Issue a `textDocument/definition` request and normalize the response
 * into a flat list of {@link LanguageServerDefinitionTarget}s. The raw LSP
 * union (`Location`, `Location[]`, `LocationLink[]`, or `null`) is hidden
 * from callers so higher-level orchestration can work with a single shape.
 */
export async function requestDefinition(
  client: LanguageServerFeatureRouter,
  request: DefinitionRequest,
): Promise<DefinitionResult> {
  return requestNavigationTargets(client, { ...request, kind: 'definition' })
}

export async function requestNavigationTargets(
  client: LanguageServerFeatureRouter,
  request: NavigationRequest,
): Promise<DefinitionResult> {
  if (request.kind === 'references') return requestReferences(client, request)

  const raw = await client.request<lsp.Location[] | lsp.Location | lsp.LocationLink[] | null>(
    REQUEST_METHODS[request.kind],
    {
      textDocument: { uri: request.uri },
      position: offsetToLspPosition(request.text, request.offset),
    } satisfies lsp.TextDocumentPositionParams,
    request.signal ? { signal: request.signal } : undefined,
  )
  return { targets: definitionTargets(raw) }
}

async function requestReferences(
  client: LanguageServerFeatureRouter,
  request: NavigationRequest,
): Promise<DefinitionResult> {
  const raw = await client.request<lsp.Location[] | null>(
    'textDocument/references',
    {
      textDocument: { uri: request.uri },
      position: offsetToLspPosition(request.text, request.offset),
      context: {
        includeDeclaration: request.includeDeclaration ?? true,
      },
    } satisfies lsp.ReferenceParams,
    request.signal ? { signal: request.signal } : undefined,
  )
  return { targets: definitionTargets(raw) }
}

/**
 * Navigate the editor to `target` by translating its LSP range into
 * offsets in the editor's current text and applying the selection. The
 * caller is responsible for ensuring `editor.text` is the text of the same
 * document `target` refers to (i.e. a same-document jump); cross-document
 * jumps should be routed through `onOpenDefinition`, not this function.
 */
export function navigateToDefinition(
  target: LanguageServerDefinitionTarget,
  editor: NavigationEditor,
): void {
  navigateToTarget(target, editor, SET_SELECTION_TIMING_NAME)
}

export function navigateToTarget(
  target: LanguageServerDefinitionTarget,
  editor: NavigationEditor,
  timingName: string,
): void {
  const start = lspPositionToOffset(editor.text, target.range.start)
  const end = lspPositionToOffset(editor.text, target.range.end)
  editor.setSelection(start, end, timingName, { revealOffset: start })
  editor.focusEditor()
}

/**
 * Pick the best target to jump to from a definition result. Prefers
 * targets inside the active document, then targets outside `node_modules`,
 * then any target; returns `null` when no targets were returned.
 */
export function preferredDefinitionTarget(
  activeUri: lsp.DocumentUri,
  result: DefinitionResult,
): LanguageServerDefinitionTarget | null {
  return preferredTarget(activeUri, result.targets)
}

export function preferredReferenceTarget(
  activeUri: lsp.DocumentUri,
  activeText: string,
  sourceOffset: number,
  result: DefinitionResult,
): LanguageServerDefinitionTarget | null {
  const sourceRange =
    identifierRangeAtOffset(activeText, sourceOffset) ??
    ({ start: sourceOffset, end: sourceOffset } satisfies OffsetRange)
  const sameDocumentTargets = result.targets.flatMap((target) =>
    targetWithOffset(activeUri, activeText, target),
  )
  const nextTarget = sameDocumentTargets.find((target) => target.start > sourceRange.end)
  if (nextTarget) return nextTarget.target

  const otherTarget = sameDocumentTargets.find((target) => !rangesOverlap(sourceRange, target))
  return otherTarget?.target ?? preferredTarget(activeUri, result.targets)
}

/**
 * Pick the best target to render a ctrl/cmd-hover definition link for.
 * Same preference rules as {@link preferredDefinitionTarget} but filters
 * out targets that would point back at (or overlap with) the hovered
 * identifier itself — the user would not be able to "jump" to the
 * definition they are already looking at.
 */
export function preferredJumpableDefinitionTarget(
  activeUri: lsp.DocumentUri,
  activeText: string,
  sourceRange: OffsetRange,
  result: DefinitionResult,
): LanguageServerDefinitionTarget | null {
  const targets = result.targets.filter(
    (target) => !targetIsSourceRange(activeUri, activeText, sourceRange, target),
  )
  return preferredTarget(activeUri, targets)
}

/**
 * Return the half-open offset range of the identifier at `offset`, or
 * `null` when the offset does not sit on an identifier character. An
 * identifier character is `[A-Za-z0-9_$]`, matching the set TypeScript's
 * language service treats as part of an identifier; offsets one position
 * past the identifier's last character are permitted so the function
 * behaves intuitively when the cursor is immediately after the name.
 */
export function identifierRangeAtOffset(text: string, offset: number): OffsetRange | null {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const index = identifierIndexAtOffset(text, clamped)
  if (index === null) return null

  let start = index
  while (start > 0 && isIdentifierCharacter(text[start - 1] ?? '')) start -= 1

  let end = index + 1
  while (end < text.length && isIdentifierCharacter(text[end] ?? '')) end += 1

  if (end <= start) return null
  return { start, end }
}

function preferredTarget(
  activeUri: lsp.DocumentUri,
  targets: readonly LanguageServerDefinitionTarget[],
): LanguageServerDefinitionTarget | null {
  return (
    targets.find((target) => target.uri === activeUri) ??
    targets.find((target) => !target.path.includes('/node_modules/')) ??
    targets[0] ??
    null
  )
}

function targetWithOffset(
  activeUri: lsp.DocumentUri,
  activeText: string,
  target: LanguageServerDefinitionTarget,
): readonly (OffsetRange & {
  readonly target: LanguageServerDefinitionTarget
})[] {
  if (target.uri !== activeUri) return []

  return [
    {
      start: lspPositionToOffset(activeText, target.range.start),
      end: lspPositionToOffset(activeText, target.range.end),
      target,
    },
  ]
}

function targetIsSourceRange(
  activeUri: lsp.DocumentUri,
  activeText: string,
  sourceRange: OffsetRange,
  target: LanguageServerDefinitionTarget,
): boolean {
  if (target.uri !== activeUri) return false

  const targetStart = lspPositionToOffset(activeText, target.range.start)
  const targetEnd = lspPositionToOffset(activeText, target.range.end)
  return rangesOverlap(sourceRange, { start: targetStart, end: targetEnd })
}

function rangesOverlap(left: OffsetRange, right: OffsetRange): boolean {
  return left.start < right.end && right.start < left.end
}

function definitionTargets(
  result: lsp.Location[] | lsp.Location | lsp.LocationLink[] | null,
): readonly LanguageServerDefinitionTarget[] {
  if (!result) return []
  const items = Array.isArray(result) ? result : [result]
  return items.flatMap(definitionTarget)
}

function definitionTarget(
  item: lsp.Location | lsp.LocationLink,
): readonly LanguageServerDefinitionTarget[] {
  const uri = 'targetUri' in item ? item.targetUri : item.uri
  const range = 'targetSelectionRange' in item ? item.targetSelectionRange : item.range
  const fileName = documentUriToFileName(uri)
  if (!fileName) return []

  return [
    {
      uri,
      path: fileName.replace(/^\/+/, ''),
      range,
    },
  ]
}

function identifierIndexAtOffset(text: string, offset: number): number | null {
  if (isIdentifierCharacter(text[offset] ?? '')) return offset
  if (offset > 0 && isIdentifierCharacter(text[offset - 1] ?? '')) return offset - 1
  return null
}

function isIdentifierCharacter(value: string): boolean {
  return /^[A-Za-z0-9_$]$/.test(value)
}

/**
 * Return `true` when two `OffsetRange`s cover the same `[start, end)`
 * span. Accepts `null` on the left-hand side so callers can pass in the
 * previously-stored "last link range" without an extra null check.
 */
export function sameOffsetRange(left: OffsetRange | null, right: OffsetRange): boolean {
  return left?.start === right.start && left.end === right.end
}
