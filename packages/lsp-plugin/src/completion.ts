import type { DocumentSessionChange, TextEdit } from '@singapor/core/document'
import type { EditorEditContributionContext, EditorSelectionRange } from '@singapor/core/extensions'
import { createEditorCapabilityToken } from '@singapor/core/extensions'
import { lspPositionToOffset } from '@singapor/lsp'
import type * as lsp from 'vscode-languageserver-protocol'
import { parseSnippet } from '@singapor/core/internal'

export const LANGUAGE_SERVER_COMPLETION_EDIT_FEATURE_ID = 'editor.lsp-plugin.completion-edit'

export const COMPLETION_REQUEST_DEBOUNCE_MS = 80

export type LanguageServerCompletionEditFeature = {
  applyCompletion(application: LanguageServerCompletionApplication): boolean
}

export const LANGUAGE_SERVER_COMPLETION_EDIT_FEATURE =
  createEditorCapabilityToken<LanguageServerCompletionEditFeature>(
    LANGUAGE_SERVER_COMPLETION_EDIT_FEATURE_ID,
  )

export type LanguageServerCompletionApplication = {
  readonly edits: readonly TextEdit[]
  readonly selection: EditorSelectionRange
  /** Tab stops to cycle with Tab, when the accepted item was a snippet with more than one. */
  readonly snippetStops?: readonly { readonly start: number; readonly end: number }[]
}

export type LanguageServerCompletionTrigger = {
  readonly triggerKind: 1 | 2
  readonly triggerCharacter?: string
}

export type CompletionWidgetShowOptions = {
  readonly anchor: DOMRect
  readonly items: readonly lsp.CompletionItem[]
  readonly selectedIndex?: number
}

export type CompletionWidgetController = {
  show(options: CompletionWidgetShowOptions): void
  hide(): void
  isVisible(): boolean
  containsTarget(target: EventTarget | null): boolean
  moveSelection(delta: number): void
  selectedItem(): lsp.CompletionItem | null
  dispose(): void
}

export type CompletionWidgetOptions = {
  readonly document: Document
  readonly themeSource: HTMLElement
  readonly classNamespace?: string
  onSelect(index: number): void
}

type CompletionWidgetClassNames = {
  readonly root: string
  readonly item: string
}

const COMPLETION_WIDGET_GAP_PX = 4
const COMPLETION_WIDGET_WIDTH_PX = 320
const COMPLETION_WIDGET_MAX_HEIGHT_PX = 280
const COMPLETION_WIDGET_MARGIN_PX = 12
const COMPLETION_WIDGET_CLASS_NAMESPACE = 'lsp-plugin'
const COMPLETION_TRIGGER_CHARACTERS = new Set(['.', '"', "'", '`', '/', '@', '<', '#'])
const COMPLETION_THEME_VARIABLES = [
  '--editor-background',
  '--editor-foreground',
  '--editor-caret-color',
] as const

export function createCompletionWidgetController(
  options: CompletionWidgetOptions,
): CompletionWidgetController {
  const classNames = completionWidgetClassNames(options.classNamespace)
  const element = createCompletionWidgetElement(options.document, classNames)
  options.document.body.append(element)

  let items: readonly lsp.CompletionItem[] = []
  let selectedIndex = 0
  let disposed = false

  const render = (): void => {
    element.replaceChildren()
    for (let index = 0; index < items.length; index += 1) {
      element.append(completionRowElement(element.ownerDocument, items[index]!, index, classNames))
    }
    syncSelectedRows(element, selectedIndex, classNames)
  }

  const show = (showOptions: CompletionWidgetShowOptions): void => {
    items = showOptions.items
    selectedIndex = clampIndex(showOptions.selectedIndex ?? 0, items.length)
    syncEditorThemeVariables(element, options.themeSource)
    positionCompletionWidget(element, showOptions.anchor)
    render()
    element.hidden = items.length === 0
  }

  const hide = (): void => {
    element.hidden = true
    element.replaceChildren()
    items = []
    selectedIndex = 0
  }

  const moveSelection = (delta: number): void => {
    if (items.length === 0) return

    selectedIndex = wrapIndex(selectedIndex + delta, items.length)
    syncSelectedRows(element, selectedIndex, classNames)
  }

  const selectedItem = (): lsp.CompletionItem | null => items[selectedIndex] ?? null

  const handlePointerDown = (event: PointerEvent): void => {
    const row = completionRowTarget(event.target, classNames)
    if (!row) return

    event.preventDefault()
    event.stopPropagation()
    selectedIndex = rowIndex(row)
    syncSelectedRows(element, selectedIndex, classNames)
    options.onSelect(selectedIndex)
  }

  element.addEventListener('pointerdown', handlePointerDown)

  const dispose = (): void => {
    if (disposed) return

    disposed = true
    element.removeEventListener('pointerdown', handlePointerDown)
    element.remove()
  }

  return {
    show,
    hide,
    isVisible: () => !element.hidden,
    containsTarget: (target) => target instanceof Node && element.contains(target),
    moveSelection,
    selectedItem,
    dispose,
  }
}

export function completionItems(
  result: lsp.CompletionList | readonly lsp.CompletionItem[] | null,
): readonly lsp.CompletionItem[] {
  if (!result) return []
  if (isCompletionList(result)) return result.items ?? []
  return result
}

export function completionTriggerFromChange(
  change: DocumentSessionChange | null,
): LanguageServerCompletionTrigger | null {
  if (!change || change.kind !== 'edit') return null
  if (change.edits.length !== 1) return null

  const edit = change.edits[0]
  if (!edit || edit.text.length !== 1) return null

  const character = edit.text
  if (COMPLETION_TRIGGER_CHARACTERS.has(character)) {
    return { triggerKind: 2, triggerCharacter: character }
  }
  if (isIdentifierCharacter(character)) return { triggerKind: 1 }
  return null
}

export function completionApplication(
  text: string,
  offset: number,
  item: lsp.CompletionItem,
): LanguageServerCompletionApplication | null {
  const primary = completionPrimaryEdit(text, offset, item)
  if (!primary) return null

  const additional = additionalCompletionEdits(text, item.additionalTextEdits ?? [])
  const edits = [primary, ...additional]
  const head = completionSelectionHead(primary, additional)
  // A snippet's first placeholder is selected so the next keystroke replaces it; without a stop the
  // caret sits after the insertion exactly as a plain completion leaves it.
  const insertionOffset = head - primary.text.length
  const snippet = completionSnippetSelection(item, insertionOffset)
  return {
    edits,
    selection: snippet ?? { anchor: head, head },
    snippetStops: completionSnippetStops(item, insertionOffset),
  }
}

export function completionAnchorRange(
  text: string,
  offset: number,
): { readonly start: number; readonly end: number } {
  if (text.length === 0) return { start: 0, end: 0 }

  const end = Math.max(1, Math.min(offset, text.length))
  return { start: end - 1, end }
}

export function createCompletionEditFeature(
  context: EditorEditContributionContext,
  timingName: string,
): LanguageServerCompletionEditFeature {
  return {
    applyCompletion(application: LanguageServerCompletionApplication): boolean {
      if (!context.hasDocument()) return false

      context.applyEdits(application.edits, timingName, application.selection)
      // Started after the edit so the ranges refer to the text now in the document. A host without
      // the hook simply leaves the caret on the first placeholder.
      if (application.snippetStops) context.startSnippetSession?.(application.snippetStops)
      context.focusEditor()
      return true
    },
  }
}

function createCompletionWidgetElement(
  document: Document,
  classNames: CompletionWidgetClassNames,
): HTMLDivElement {
  const element = document.createElement('div')
  element.className = classNames.root
  element.hidden = true
  element.setAttribute('role', 'listbox')
  Object.assign(element.style, {
    position: 'fixed',
    zIndex: '1001',
    width: `${COMPLETION_WIDGET_WIDTH_PX}px`,
    maxWidth: `calc(100vw - ${COMPLETION_WIDGET_MARGIN_PX * 2}px)`,
    maxHeight: `${COMPLETION_WIDGET_MAX_HEIGHT_PX}px`,
    overflowX: 'hidden',
    overflowY: 'auto',
    padding: '3px',
    border: '1px solid color-mix(in srgb, var(--editor-foreground, #d4d4d8) 22%, transparent)',
    borderRadius: '6px',
    boxSizing: 'border-box',
    background:
      'color-mix(in srgb, var(--editor-background, #18181b) 96%, var(--editor-foreground, #e4e4e7) 4%)',
    color: 'var(--editor-foreground, #e4e4e7)',
    boxShadow: '0 12px 30px color-mix(in srgb, var(--editor-background, #000000) 60%, transparent)',
    font: '12px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    userSelect: 'none',
    scrollbarGutter: 'stable',
  })
  return element
}

function completionRowElement(
  document: Document,
  item: lsp.CompletionItem,
  index: number,
  classNames: CompletionWidgetClassNames,
): HTMLDivElement {
  const row = document.createElement('div')
  row.className = classNames.item
  row.dataset.index = String(index)
  row.setAttribute('role', 'option')
  Object.assign(row.style, {
    display: 'grid',
    gridTemplateColumns: '44px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '8px',
    minHeight: '24px',
    padding: '2px 7px',
    borderRadius: '4px',
    cursor: 'default',
    whiteSpace: 'nowrap',
  })
  row.append(
    completionKindElement(document, item.kind),
    completionLabelElement(document, item),
    completionDetailElement(document, item),
  )
  return row
}

function completionKindElement(
  document: Document,
  kind: lsp.CompletionItemKind | undefined,
): HTMLSpanElement {
  const element = document.createElement('span')
  element.textContent = completionKindLabel(kind)
  Object.assign(element.style, {
    minWidth: '0',
    overflow: 'hidden',
    color: 'color-mix(in srgb, var(--editor-foreground, #e4e4e7) 62%, transparent)',
    fontSize: '10px',
    textTransform: 'uppercase',
  })
  return element
}

function completionLabelElement(document: Document, item: lsp.CompletionItem): HTMLSpanElement {
  const element = document.createElement('span')
  element.textContent = `${item.label}${item.labelDetails?.detail ?? ''}`
  Object.assign(element.style, {
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  })
  return element
}

function completionDetailElement(document: Document, item: lsp.CompletionItem): HTMLSpanElement {
  const element = document.createElement('span')
  element.textContent = item.labelDetails?.description ?? item.detail ?? ''
  Object.assign(element.style, {
    minWidth: '0',
    maxWidth: '140px',
    overflow: 'hidden',
    color: 'color-mix(in srgb, var(--editor-foreground, #e4e4e7) 58%, transparent)',
    textOverflow: 'ellipsis',
  })
  return element
}

function syncSelectedRows(
  element: HTMLDivElement,
  selectedIndex: number,
  classNames: CompletionWidgetClassNames,
): void {
  const rows = element.querySelectorAll<HTMLElement>(`.${classNames.item}`)
  for (const row of rows) syncSelectedRow(row, rowIndex(row) === selectedIndex)
}

function syncSelectedRow(row: HTMLElement, selected: boolean): void {
  row.setAttribute('aria-selected', selected ? 'true' : 'false')
  row.style.background = selected
    ? 'color-mix(in srgb, var(--editor-caret-color, #60a5fa) 26%, transparent)'
    : 'transparent'
}

function positionCompletionWidget(element: HTMLDivElement, anchor: DOMRect): void {
  const view = element.ownerDocument.defaultView
  const width = view?.innerWidth ?? 1024
  const height = view?.innerHeight ?? 768
  const left = Math.min(
    Math.max(COMPLETION_WIDGET_MARGIN_PX, anchor.left),
    Math.max(
      COMPLETION_WIDGET_MARGIN_PX,
      width - COMPLETION_WIDGET_WIDTH_PX - COMPLETION_WIDGET_MARGIN_PX,
    ),
  )
  const belowTop = anchor.bottom + COMPLETION_WIDGET_GAP_PX
  const aboveTop = anchor.top - COMPLETION_WIDGET_MAX_HEIGHT_PX - COMPLETION_WIDGET_GAP_PX
  const top =
    belowTop + COMPLETION_WIDGET_MAX_HEIGHT_PX <= height || aboveTop < COMPLETION_WIDGET_MARGIN_PX
      ? belowTop
      : Math.max(COMPLETION_WIDGET_MARGIN_PX, aboveTop)

  element.style.left = `${left}px`
  element.style.top = `${Math.min(top, height - COMPLETION_WIDGET_MARGIN_PX)}px`
}

function syncEditorThemeVariables(element: HTMLElement, source: HTMLElement): void {
  const style = source.ownerDocument.defaultView?.getComputedStyle(source)
  if (!style) return

  for (const variable of COMPLETION_THEME_VARIABLES) {
    const value = style.getPropertyValue(variable)
    if (value) element.style.setProperty(variable, value)
  }
}

function completionPrimaryEdit(
  text: string,
  offset: number,
  item: lsp.CompletionItem,
): TextEdit | null {
  const textEdit = completionTextEdit(item)
  if (textEdit) return lspTextEditToTextEdit(text, textEdit, item.insertTextFormat)

  const range = defaultCompletionReplacementRange(text, offset)
  return {
    from: range.start,
    to: range.end,
    text: plainCompletionText(item.insertText ?? item.label, item.insertTextFormat),
  }
}

function completionTextEdit(item: lsp.CompletionItem): lsp.TextEdit | null {
  const textEdit = item.textEdit
  if (!textEdit) return null
  if ('range' in textEdit) return textEdit
  return { range: textEdit.insert, newText: textEdit.newText }
}

function lspTextEditToTextEdit(
  text: string,
  edit: lsp.TextEdit,
  format: lsp.InsertTextFormat | undefined,
): TextEdit {
  return {
    from: lspPositionToOffset(text, edit.range.start),
    to: lspPositionToOffset(text, edit.range.end),
    text: plainCompletionText(edit.newText, format),
  }
}

function additionalCompletionEdits(
  text: string,
  edits: readonly lsp.TextEdit[],
): readonly TextEdit[] {
  return edits.map((edit) => lspTextEditToTextEdit(text, edit, undefined))
}

function completionSelectionHead(primary: TextEdit, additional: readonly TextEdit[]): number {
  let head = primary.from + primary.text.length
  for (const edit of additional) {
    if (edit.to > primary.from) continue
    head += edit.text.length - (edit.to - edit.from)
  }
  return Math.max(0, head)
}

function defaultCompletionReplacementRange(
  text: string,
  offset: number,
): { readonly start: number; readonly end: number } {
  let start = Math.max(0, Math.min(offset, text.length))
  while (start > 0 && isIdentifierCharacter(text[start - 1] ?? '')) start -= 1

  let end = Math.max(0, Math.min(offset, text.length))
  while (end < text.length && isIdentifierCharacter(text[end] ?? '')) end += 1
  return { start, end }
}

function plainCompletionText(text: string, format: lsp.InsertTextFormat | undefined): string {
  if (format !== 2) return text

  return parseSnippet(text).text
}

/** The snippet source of the item's primary insertion, or null when it is not a snippet. */
function completionSnippetSource(item: lsp.CompletionItem): string | null {
  if (item.insertTextFormat !== 2) return null

  const textEdit = completionTextEdit(item)
  return textEdit ? textEdit.newText : (item.insertText ?? item.label)
}

/**
 * Where the caret lands after accepting a snippet: its first tab stop, selected so typing replaces
 * the placeholder. Falls back to the end of the insertion, which is what a plain completion does.
 */
/** Every tab stop of a snippet, in visit order and in document offsets. */
export function completionSnippetStops(
  item: lsp.CompletionItem,
  insertionOffset: number,
): readonly { readonly start: number; readonly end: number }[] | undefined {
  const source = completionSnippetSource(item)
  if (source === null) return undefined

  const parsed = parseSnippet(source)
  if (parsed.stops.length === 0) return undefined

  // One range per stop: a repeated stop's mirrors are not edited together yet, so the first
  // occurrence is the one the caret visits.
  return parsed.stops.flatMap((stop) => {
    const range = stop.ranges[0]
    return range ? [{ end: insertionOffset + range.end, start: insertionOffset + range.start }] : []
  })
}

export function completionSnippetSelection(
  item: lsp.CompletionItem,
  insertionOffset: number,
): { readonly anchor: number; readonly head: number } | null {
  const source = completionSnippetSource(item)
  if (source === null) return null

  const parsed = parseSnippet(source)
  const first = parsed.stops[0]?.ranges[0]
  if (!first) return null

  return { anchor: insertionOffset + first.start, head: insertionOffset + first.end }
}

function completionRowTarget(
  target: EventTarget | null,
  classNames: CompletionWidgetClassNames,
): HTMLElement | null {
  if (!(target instanceof Element)) return null
  return target.closest<HTMLElement>(`.${classNames.item}`)
}

function completionWidgetClassNames(
  namespace = COMPLETION_WIDGET_CLASS_NAMESPACE,
): CompletionWidgetClassNames {
  const root = `editor-${namespace}-completion`
  return {
    root,
    item: `${root}-item`,
  }
}

function rowIndex(row: HTMLElement): number {
  const parsed = Number(row.dataset.index)
  return Number.isFinite(parsed) ? parsed : 0
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.min(Math.max(0, index), length - 1)
}

function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return ((index % length) + length) % length
}

function completionKindLabel(kind: lsp.CompletionItemKind | undefined): string {
  if (kind === 2) return 'meth'
  if (kind === 3) return 'fn'
  if (kind === 5) return 'field'
  if (kind === 6) return 'var'
  if (kind === 7) return 'class'
  if (kind === 8) return 'iface'
  if (kind === 9) return 'mod'
  if (kind === 10) return 'prop'
  if (kind === 13) return 'enum'
  if (kind === 14) return 'key'
  if (kind === 20) return 'member'
  return 'text'
}

function isIdentifierCharacter(value: string): boolean {
  return /^[A-Za-z0-9_$]$/.test(value)
}

function isCompletionList(
  value: lsp.CompletionList | readonly lsp.CompletionItem[],
): value is lsp.CompletionList {
  return !Array.isArray(value)
}

/**
 * Whether an accepted item still needs a `completionItem/resolve` round-trip.
 *
 * Servers routinely send a list whose items carry only a label, deferring documentation and — the
 * one that matters — the import edit until resolve. Applying such an item directly is what silently
 * drops auto-imports.
 */
export function completionNeedsResolve(
  item: lsp.CompletionItem,
  serverCapabilities: lsp.ServerCapabilities | null | undefined,
): boolean {
  if (item.additionalTextEdits !== undefined) return false

  return Boolean(serverCapabilities?.completionProvider?.resolveProvider)
}

/**
 * Word being typed at `offset`, which is what the list should be filtered against. The server's
 * answer is for the moment the request was sent; the user has usually typed more since.
 */
export function completionPrefix(text: string, offset: number): string {
  let start = Math.max(0, Math.min(offset, text.length))
  while (start > 0 && isIdentifierCharacter(text[start - 1] ?? '')) start -= 1

  return text.slice(start, Math.max(0, Math.min(offset, text.length)))
}

/**
 * Filters and orders a completion list against what has been typed.
 *
 * Matching goes prefix, then case-insensitive prefix, then subsequence — the order of how much the
 * user has confirmed about their intent. Ties fall back to the server's own `sortText`, which is
 * how a server expresses relevance it knows and the client does not.
 */
export function rankCompletionItems(
  items: readonly lsp.CompletionItem[],
  prefix: string,
): readonly lsp.CompletionItem[] {
  if (prefix.length === 0) return items

  const scored: { item: lsp.CompletionItem; score: number }[] = []
  for (const item of items) {
    const score = completionMatchScore(item.filterText ?? item.label, prefix)
    if (score === 0) continue

    scored.push({ item, score })
  }

  return scored
    .sort((left, right) => right.score - left.score || compareCompletionOrder(left.item, right.item))
    .map((entry) => entry.item)
}

function completionMatchScore(candidate: string, prefix: string): number {
  if (candidate.startsWith(prefix)) return 3
  if (candidate.toLowerCase().startsWith(prefix.toLowerCase())) return 2

  return isSubsequence(candidate.toLowerCase(), prefix.toLowerCase()) ? 1 : 0
}

function isSubsequence(candidate: string, prefix: string): boolean {
  let cursor = 0
  for (const char of candidate) {
    if (char === prefix[cursor]) cursor += 1
    if (cursor === prefix.length) return true
  }

  return prefix.length === 0
}

function compareCompletionOrder(left: lsp.CompletionItem, right: lsp.CompletionItem): number {
  const leftKey = left.sortText ?? left.label
  const rightKey = right.sortText ?? right.label
  return leftKey.localeCompare(rightKey)
}
