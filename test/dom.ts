// Minimal DOM surface used by Panel. Event properties deliberately do not appear in markup,
// matching the browser behavior that caused stale approval closures.
export class Element {
  tag: string;
  children: Element[] = [];
  className = "";
  dataset: Record<string, string> = {};
  styles: Record<string, string> = {};
  style = { setProperty: (key: string, value: string) => { this.styles[key] = value; } };
  classList = { contains: (name: string) => this.className.split(" ").includes(name) };
  attributes: Record<string, string> = {};
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  hidden = false;
  value = "";
  onchange?: () => void;
  checked = false;
  src = "";
  alt = "";
  title = "";
  width = 0;
  height = 0;
  private text = "";
  onclick?: () => void;
  constructor(tag: string) { this.tag = tag; }
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map((n) => n.textContent).join(""); }
  get firstElementChild() { return this.children[0]; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  get innerHTML(): string { return this.text + this.children.map((n) => n.outerHTML).join(""); }
  get outerHTML(): string {
    return `<${this.tag} class="${this.className}" data="${JSON.stringify(this.dataset)}" style="${JSON.stringify(this.styles)}" src="${this.src}" title="${this.title}">${this.innerHTML}</${this.tag}>`;
  }
  getContext() {
    return new Proxy({}, { get: (_target, key) => key === "getImageData"
      ? () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }) : () => {} });
  }
  toDataURL() { return "data:image/png;base64,test"; }
  find(text: string): Element | undefined {
    if (this.tag === "button" && this.textContent === text) return this;
    for (const child of this.children) { const found = child.find(text); if (found) return found; }
  }
}

export function installDOM(t: import("node:test").TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  t.after(() => { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); });
  const elements = new Map(["rooms", "agents", "detail", "show-all"].map((id) => [id, new Element("div")]));
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    getElementById: (id: string) => elements.get(id),
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => { const n = new Element("text"); n.textContent = text; return n; },
  } });
  return elements;
}

export function descendants(node: Element): Element[] {
  return [node, ...node.children.flatMap(descendants)];
}
