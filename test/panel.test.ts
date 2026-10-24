import { test } from "node:test";
import assert from "node:assert/strict";
import { Panel } from "../web/panel.ts";
import { ClientState } from "../web/state.ts";
import { Store } from "../src/store.ts";
import type { ControlRequest } from "../src/types.ts";

// Minimal DOM surface used by Panel. Event properties deliberately do not appear in markup,
// matching the browser behavior that caused stale approval closures.
class Element {
  tag: string;
  children: Element[] = [];
  className = "";
  dataset: Record<string, string> = {};
  styles: Record<string, string> = {};
  style = { setProperty: (key: string, value: string) => { this.styles[key] = value; } };
  classList = { contains: (name: string) => this.className.split(" ").includes(name) };
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

test("approval buttons follow request/session identity while unchanged buttons retain DOM identity", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  t.after(() => { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); });
  const elements = new Map(["rooms", "agents", "detail", "show-all"].map((id) => [id, new Element("div")]));
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    getElementById: (id: string) => elements.get(id),
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => { const n = new Element("text"); n.textContent = text; return n; },
  } });
  const store = new Store();
  for (const id of ["a", "b"]) store.apply({ type: "session.created", properties: { info: { id } } });
  const state = new ClientState();
  const requests: ControlRequest[] = [];
  const panel = new Panel(state, {
    selectRoom: () => {}, select: () => {}, control: async (req) => { requests.push(req); },
    caps: () => ({ control: true }), workerName: () => undefined, personInfo: () => undefined, roster: () => [],
  });
  function render(sessionID: string, requestID: string) {
    store.apply({ type: "permission.asked", properties: { sessionID, id: requestID, permission: "bash", patterns: ["npm test"] } });
    state.load(store.snapshot()); panel.render(sessionID, sessionID);
    return elements.get("detail")!.find("Allow once")!;
  }
  const first = render("a", "request-1");
  assert.ok(first);
  assert.equal(render("a", "request-1"), first, "unchanged polling preserves clickable node");
  const second = render("a", "request-2");
  assert.notEqual(second, first, "new request refreshes captured ID despite identical visible text");
  second.onclick!(); await Promise.resolve();
  assert.deepEqual(requests[0], { action: "permission", sessionID: "a", requestID: "request-2", decision: "once" });
  // Switch sessions before feedback is rendered; identical request IDs must not reuse handlers.
  const third = render("b", "request-2"); third.onclick!(); await Promise.resolve();
  assert.deepEqual(requests[1], { action: "permission", sessionID: "b", requestID: "request-2", decision: "once" });
});
