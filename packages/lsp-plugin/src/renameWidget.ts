export type RenameWidgetOptions = {
  readonly document: Document
  /** Element whose computed style carries the editor theme variables. */
  readonly themeSource: HTMLElement
  readonly classNamespace?: string
}

export type RenameWidgetPrompt = {
  readonly anchor: DOMRect
  readonly currentName: string
}

export type RenameWidgetController = {
  /** Shows the input and resolves with the new name, or null when dismissed. */
  prompt(options: RenameWidgetPrompt): Promise<string | null>
  containsTarget(target: EventTarget | null): boolean
  dispose(): void
}

const THEME_VARIABLES = [
  '--editor-background',
  '--editor-foreground',
  '--editor-font-family',
  '--editor-font-size',
] as const

/**
 * The editor's own rename input: a small floating field anchored at the symbol.
 *
 * It exists so the engine is usable on its own. A host with its own dialog language passes
 * `onRequestRenameName` instead and this is never built.
 */
export function createRenameWidgetController(
  options: RenameWidgetOptions,
): RenameWidgetController {
  const namespace = options.classNamespace ?? 'lsp-plugin'
  const element = options.document.createElement('div')
  element.className = `${namespace}-rename`
  element.style.position = 'fixed'
  element.style.zIndex = '60'
  element.style.display = 'none'

  const input = options.document.createElement('input')
  input.className = `${namespace}-rename-input`
  input.type = 'text'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.setAttribute('aria-label', 'New name')
  element.appendChild(input)
  options.document.body.appendChild(element)

  let settle: ((value: string | null) => void) | null = null

  function close(value: string | null): void {
    if (!settle) return

    const resolve = settle
    settle = null
    element.style.display = 'none'
    resolve(value)
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      // An unchanged or empty name is a cancel: renaming a symbol to itself is a no-op edit, and to
      // nothing is not a rename at all.
      const next = input.value.trim()
      close(next.length === 0 ? null : next)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(null)
    }
  })
  input.addEventListener('blur', () => close(null))

  return {
    containsTarget: (target) => target instanceof Node && element.contains(target),
    dispose() {
      close(null)
      element.remove()
    },
    prompt({ anchor, currentName }) {
      applyTheme(element, options.themeSource)
      element.style.display = 'block'
      element.style.left = `${Math.round(anchor.left)}px`
      element.style.top = `${Math.round(anchor.bottom + 4)}px`
      input.value = currentName
      input.focus()
      // Selected, so typing replaces the old name — the common case — while arrow keys still edit it.
      input.select()

      return new Promise<string | null>((resolve) => {
        close(null)
        settle = resolve
      })
    },
  }
}

function applyTheme(element: HTMLElement, source: HTMLElement): void {
  const style = getComputedStyle(source)
  for (const variable of THEME_VARIABLES) {
    const value = style.getPropertyValue(variable)
    if (value) element.style.setProperty(variable, value)
  }
}
