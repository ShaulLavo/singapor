import { el } from "./dom.ts";

export type TopBar = {
  readonly element: HTMLDivElement;
  setRepositoryName(name: string): void;
  setMessage(message: string): void;
  setBusyState(isBusy: boolean): void;
};

class TopBarController implements TopBar {
  readonly element = el("div", { id: "toolbar" });
  private readonly repositoryName = el("span", { id: "dir-name" });

  constructor() {
    this.element.append(this.repositoryName);
  }

  setRepositoryName(name: string): void {
    this.repositoryName.textContent = name;
  }

  setMessage(message: string): void {
    this.repositoryName.textContent = message;
  }

  setBusyState(_isBusy: boolean): void {
    return;
  }
}

export function createTopBar(): TopBar {
  return new TopBarController();
}
