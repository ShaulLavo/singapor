export class Editor {
  private el: HTMLPreElement;

  constructor(container: HTMLElement) {
    this.el = document.createElement("pre");
    this.el.className = "editor";
    container.appendChild(this.el);
  }

  setContent(text: string) {
    this.el.textContent = text;
  }

  clear() {
    this.el.textContent = "";
  }
}
