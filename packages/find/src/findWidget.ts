import type { EditorFindWidgetState } from './findController'

const EDITOR_THEME_VARIABLES = [
  '--editor-background',
  '--editor-foreground',
  '--editor-caret-color',
] as const

const FIND_ICONS = {
  caseSensitive: 'text-a-underline',
  close: 'x',
  next: 'caret-down',
  preserveCase: 'text-aa',
  previous: 'caret-up',
  regex: 'asterisk',
  replace: 'swap',
  replaceAll: 'arrows-clockwise',
  replaceToggle: 'caret-right',
  scope: 'selection',
  wholeWord: 'textbox',
} as const

export type EditorFindWidgetOptions = {
  readonly onSearchInput: (value: string) => void
  readonly onReplaceInput: (value: string) => void
  readonly onToggleReplace: () => void
  readonly onPrevious: () => void
  readonly onNext: () => void
  readonly onClose: () => void
  readonly onToggleCase: () => void
  readonly onToggleWholeWord: () => void
  readonly onToggleRegex: () => void
  readonly onToggleScope: () => void
  readonly onTogglePreserveCase: () => void
  readonly onReplaceOne: () => void
  readonly onReplaceAll: () => void
}

type PhosphorIconName = (typeof FIND_ICONS)[keyof typeof FIND_ICONS]

export class EditorFindWidget {
  private readonly root: HTMLDivElement
  private readonly findInput: HTMLInputElement
  private readonly replaceInput: HTMLInputElement
  private readonly replaceRow: HTMLDivElement
  private readonly count: HTMLSpanElement
  private readonly replaceToggleButton: HTMLButtonElement
  private readonly caseButton: HTMLButtonElement
  private readonly wordButton: HTMLButtonElement
  private readonly regexButton: HTMLButtonElement
  private readonly scopeButton: HTMLButtonElement
  private readonly preserveButton: HTMLButtonElement

  public constructor(
    container: HTMLElement,
    private readonly themeSource: HTMLElement,
    private readonly options: EditorFindWidgetOptions,
  ) {
    const document = container.ownerDocument
    const position = container.ownerDocument.defaultView?.getComputedStyle(container).position
    if (!position || position === 'static') container.style.position = 'relative'
    this.root = document.createElement('div')
    this.findInput = document.createElement('input')
    this.replaceInput = document.createElement('input')
    this.replaceRow = document.createElement('div')
    this.count = document.createElement('span')
    this.replaceToggleButton = createFindButton(
      document,
      FIND_ICONS.replaceToggle,
      'Toggle Replace',
    )
    this.replaceToggleButton.classList.add('editor-find-replace-toggle')
    this.caseButton = createFindButton(document, FIND_ICONS.caseSensitive, 'Match Case')
    this.wordButton = createFindButton(document, FIND_ICONS.wholeWord, 'Whole Word')
    this.regexButton = createFindButton(document, FIND_ICONS.regex, 'Use Regular Expression')
    this.scopeButton = createFindButton(document, FIND_ICONS.scope, 'Find in Selection')
    this.preserveButton = createFindButton(document, FIND_ICONS.preserveCase, 'Preserve Case')
    this.build(document)
    container.appendChild(this.root)
  }

  public show(replaceVisible: boolean): void {
    syncEditorThemeVariables(this.root, this.themeSource)
    this.root.hidden = false
    this.replaceRow.hidden = !replaceVisible
  }

  public hide(): void {
    this.root.hidden = true
  }

  public update(state: EditorFindWidgetState): void {
    syncEditorThemeVariables(this.root, this.themeSource)
    if (this.findInput.value !== state.searchString) this.findInput.value = state.searchString
    if (this.replaceInput.value !== state.replaceString)
      this.replaceInput.value = state.replaceString
    this.replaceRow.hidden = !state.replaceRevealed
    setToggleExpanded(this.replaceToggleButton, state.replaceRevealed, 'Replace')
    this.count.textContent = resultCountText(
      state.matchesPosition,
      state.matchesCount,
      state.matchesTruncated,
    )
    this.count.title = state.matchesTruncated
      ? truncatedCountTitle(state.matchesCount)
      : this.count.textContent
    setTogglePressed(this.caseButton, state.matchCase, 'Match Case')
    setTogglePressed(this.wordButton, state.wholeWord, 'Match Whole Word')
    setTogglePressed(this.regexButton, state.isRegex, 'Use Regular Expression')
    setTogglePressed(this.scopeButton, state.inSelection, 'Find in Selection')
    setTogglePressed(this.preserveButton, state.preserveCase, 'Preserve Case')
  }

  public focusFindInput(): void {
    this.findInput.focus()
    this.findInput.select()
  }

  public focusReplaceInput(): void {
    this.replaceInput.focus()
    this.replaceInput.select()
  }

  public dispose(): void {
    this.root.remove()
  }

  private build(document: Document): void {
    this.root.className = 'editor-find-widget'
    this.root.hidden = true
    this.findInput.className = 'editor-find-input'
    this.findInput.type = 'text'
    this.findInput.placeholder = 'Find'
    this.findInput.title = 'Find'
    this.findInput.spellcheck = false
    this.findInput.autocomplete = 'off'
    this.findInput.setAttribute('aria-label', 'Find')
    this.replaceInput.className = 'editor-find-input editor-find-input-standalone'
    this.replaceInput.type = 'text'
    this.replaceInput.placeholder = 'Replace'
    this.replaceInput.title = 'Replace'
    this.replaceInput.spellcheck = false
    this.replaceInput.autocomplete = 'off'
    this.replaceInput.setAttribute('aria-label', 'Replace')
    this.replaceRow.className = 'editor-find-row editor-find-replace-row'
    this.count.className = 'editor-find-count'

    this.root.append(this.findRow(document), this.replaceRow)
    this.installHandlers()
  }

  private findRow(document: Document): HTMLDivElement {
    const row = document.createElement('div')
    row.className = 'editor-find-row'
    row.append(
      this.replaceToggleButton,
      this.findInputFrame(document),
      this.count,
      this.scopeButton,
      createFindButton(document, FIND_ICONS.previous, 'Previous Match', this.options.onPrevious),
      createFindButton(document, FIND_ICONS.next, 'Next Match', this.options.onNext),
      createFindButton(document, FIND_ICONS.close, 'Close', this.options.onClose),
    )
    this.replaceRow.append(
      this.replaceInput,
      this.preserveButton,
      createFindButton(document, FIND_ICONS.replace, 'Replace', this.options.onReplaceOne),
      createFindButton(document, FIND_ICONS.replaceAll, 'Replace All', this.options.onReplaceAll),
    )
    return row
  }

  private findInputFrame(document: Document): HTMLDivElement {
    const frame = document.createElement('div')
    const controls = document.createElement('div')
    frame.className = 'editor-find-input-frame'
    controls.className = 'editor-find-input-controls'
    controls.append(this.caseButton, this.wordButton, this.regexButton)
    frame.append(this.findInput, controls)
    return frame
  }

  private installHandlers(): void {
    this.root.addEventListener('keydown', (event) => this.handleKeyDown(event))
    this.findInput.addEventListener('input', () => this.options.onSearchInput(this.findInput.value))
    this.replaceInput.addEventListener('input', () =>
      this.options.onReplaceInput(this.replaceInput.value),
    )
    this.caseButton.addEventListener('click', this.options.onToggleCase)
    this.wordButton.addEventListener('click', this.options.onToggleWholeWord)
    this.regexButton.addEventListener('click', this.options.onToggleRegex)
    this.replaceToggleButton.addEventListener('click', this.options.onToggleReplace)
    this.scopeButton.addEventListener('click', this.options.onToggleScope)
    this.preserveButton.addEventListener('click', this.options.onTogglePreserveCase)
  }

  private handleKeyDown(event: KeyboardEvent): void {
    event.stopPropagation()
    if (isFindToggleKey(event)) {
      event.preventDefault()
      this.options.onClose()
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      this.options.onClose()
      return
    }

    if (event.key !== 'Enter') return
    event.preventDefault()
    if (event.target === this.replaceInput && !event.shiftKey) {
      this.options.onReplaceOne()
      return
    }
    if (event.shiftKey) this.options.onPrevious()
    else this.options.onNext()
  }
}

function createFindButton(
  document: Document,
  icon: PhosphorIconName,
  title: string,
  onClick?: () => void,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'editor-find-button'
  button.appendChild(createPhosphorIcon(document, icon))
  setNativeTooltip(button, title)
  if (onClick) button.addEventListener('click', onClick)
  return button
}

function syncEditorThemeVariables(target: HTMLElement, source: HTMLElement): void {
  const style = source.ownerDocument.defaultView?.getComputedStyle(source)
  if (!style) return

  for (const variable of EDITOR_THEME_VARIABLES) {
    const value =
      source.style.getPropertyValue(variable).trim() || style.getPropertyValue(variable).trim()
    if (value) target.style.setProperty(variable, value)
  }
}

function createPhosphorIcon(document: Document, icon: PhosphorIconName): HTMLElement {
  const element = document.createElement('i')
  element.className = `ph ph-${icon}`
  element.setAttribute('aria-hidden', 'true')
  return element
}

function setTogglePressed(button: HTMLButtonElement, pressed: boolean, label: string): void {
  button.classList.toggle('active', pressed)
  button.setAttribute('aria-pressed', pressed ? 'true' : 'false')
  setNativeTooltip(button, toggleTooltip(label, pressed))
}

function setToggleExpanded(button: HTMLButtonElement, expanded: boolean, label: string): void {
  button.classList.toggle('active', expanded)
  button.setAttribute('aria-expanded', expanded ? 'true' : 'false')
  setNativeTooltip(button, expanded ? `Hide ${label}` : `Show ${label}`)
}

function setNativeTooltip(element: HTMLElement, value: string): void {
  element.title = value
  element.setAttribute('aria-label', value)
}

function isFindToggleKey(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== 'f') return false
  if (event.altKey || event.shiftKey) return false
  return event.metaKey || event.ctrlKey
}

function toggleTooltip(label: string, active: boolean): string {
  return active ? `${label} (On)` : `${label} (Off)`
}

function resultCountText(position: number, count: number, truncated: boolean): string {
  if (count === 0) return 'No results'
  return `${position || '?'} of ${count}${truncated ? '+' : ''}`
}

// The '+' alone reads as an error; name the operations that ignore the cap
// rather than claiming all of them do — navigation still walks the capped list
// until the incremental searcher lands.
function truncatedCountTitle(count: number): string {
  return `Only the first ${count} results are counted and highlighted. Replace All and Select All Matches still cover the entire text.`
}
