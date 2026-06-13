import { el } from './dom.ts'

type AppViewMode = 'edit' | 'diff'
type AppDiffMode = 'split' | 'stacked'

type TopBarHandlers = {
  readonly onEditMode: () => void
  readonly onDiffMode: () => void
  readonly onSplitDiff: () => void
  readonly onStackedDiff: () => void
}

export type TopBar = {
  readonly element: HTMLDivElement
  setRepositoryName(name: string): void
  setMessage(message: string): void
  setBusyState(isBusy: boolean): void
  setHandlers(handlers: TopBarHandlers): void
  setViewMode(mode: AppViewMode): void
  setDiffMode(mode: AppDiffMode): void
  setDiffControlsVisible(visible: boolean): void
}

class TopBarController implements TopBar {
  readonly element = el('div', { id: 'toolbar' })
  private readonly repositoryName = el('span', { id: 'dir-name' })
  private readonly editButton = toolbarButton('Edit')
  private readonly diffButton = toolbarButton('Diff')
  private readonly splitButton = toolbarButton('Split')
  private readonly stackedButton = toolbarButton('Stacked')

  constructor() {
    this.element.append(
      this.repositoryName,
      this.editButton,
      this.diffButton,
      this.splitButton,
      this.stackedButton,
    )
    this.setViewMode('edit')
    this.setDiffMode('split')
    this.setDiffControlsVisible(false)
  }

  setRepositoryName(name: string): void {
    this.repositoryName.textContent = name
  }

  setMessage(message: string): void {
    this.repositoryName.textContent = message
  }

  setBusyState(_isBusy: boolean): void {
    return
  }

  setHandlers(handlers: TopBarHandlers): void {
    this.editButton.onclick = handlers.onEditMode
    this.diffButton.onclick = handlers.onDiffMode
    this.splitButton.onclick = handlers.onSplitDiff
    this.stackedButton.onclick = handlers.onStackedDiff
  }

  setViewMode(mode: AppViewMode): void {
    this.editButton.setAttribute('aria-pressed', String(mode === 'edit'))
    this.diffButton.setAttribute('aria-pressed', String(mode === 'diff'))
    this.setDiffControlsVisible(mode === 'diff')
  }

  setDiffMode(mode: AppDiffMode): void {
    this.splitButton.setAttribute('aria-pressed', String(mode === 'split'))
    this.stackedButton.setAttribute('aria-pressed', String(mode === 'stacked'))
  }

  setDiffControlsVisible(visible: boolean): void {
    this.splitButton.hidden = !visible
    this.stackedButton.hidden = !visible
  }
}

export function createTopBar(): TopBar {
  return new TopBarController()
}

function toolbarButton(label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  return button
}
