// DOM side panel + room tabs. Everything goes through textContent (no innerHTML with data).

import type { Agent, FeedEntry, Room } from "../src/types.ts";
import { roleOf, STATUS_COLOR, STATUS_LABEL } from "./roles.ts";
import type { ClientState } from "./state.ts";

const STALE_ROOM = 2 * 60 * 60 * 1000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Replace children only when the markup actually changed, so hover/clicks survive the 250ms refresh. */
function swap(container: HTMLElement, nodes: HTMLElement[]) {
  const html = nodes.map((n) => n.outerHTML).join("");
  if (container.innerHTML !== html) container.replaceChildren(...nodes);
}

const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
const statusKey = (a: Agent) => (a.waiting ? "waiting" : a.status);
const roleLabel = (name: string) => {
  const label = roleOf(name).label;
  return label.toLowerCase() === name.toLowerCase() ? "" : label;
};

function fmtTokens(n: number) {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
}

function fmtAge(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  return Math.round(s / 3600) + "h";
}

const FEED_ICON: Record<FeedEntry["kind"], string> = {
  tool: "🔧",
  text: "💬",
  think: "💭",
  prompt: "📝",
  status: "•",
  spawn: "✈️",
  error: "⛔",
  todo: "📋",
  ask: "✋",
};

export interface PanelCallbacks {
  selectRoom(id: string): void;
  selectAgent(id: string | undefined): void;
}

export class Panel {
  private state: ClientState;
  private cb: PanelCallbacks;
  private tabs = document.getElementById("rooms")!;
  private list = document.getElementById("agents")!;
  private detail = document.getElementById("detail")!;
  private showAll = document.getElementById("show-all") as HTMLInputElement;

  constructor(state: ClientState, cb: PanelCallbacks) {
    this.state = state;
    this.cb = cb;
  }

  visibleRooms(current?: string): Room[] {
    const all = this.state.sortedRooms();
    if (this.showAll.checked) return all;
    return all.filter((r) => r.id === current || this.state.age(r.updatedAt) < STALE_ROOM || this.state.roomBusy(r.id));
  }

  render(roomId: string | undefined, selected: string | undefined) {
    this.renderTabs(roomId);
    this.renderList(roomId, selected);
    this.renderDetail(selected ? this.state.agents.get(selected) : undefined);
  }

  private renderTabs(current?: string) {
    const rooms = this.visibleRooms(current);
    const nodes = rooms.map((r) => {
        const b = el("button", "tab" + (r.id === current ? " active" : ""));
        b.dataset.id = r.id;
        b.title = `${r.directory}\n${r.title}`;
        const dot = el("span", "dot");
        dot.style.background = this.state.roomBusy(r.id) ? STATUS_COLOR.busy : STATUS_COLOR.idle;
        // v2 session listings carry no title until the session gets one
        const title = r.title !== "Session" ? r.title : new Date(r.createdAt).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        b.append(dot, el("span", "proj", basename(r.directory) || "—"), el("span", "ttl", title));
        b.onclick = () => this.cb.selectRoom(r.id);
        return b;
      });
    swap(this.tabs, nodes.length ? nodes : [el("span", "muted", "keine Sessions")]);
  }

  private renderList(roomId: string | undefined, selected?: string) {
    const agents = roomId ? this.state.roomAgents(roomId) : [];
    const kids = new Map<string | undefined, Agent[]>();
    for (const a of agents) {
      const p = a.parentId && agents.some((x) => x.id === a.parentId) ? a.parentId : undefined;
      kids.set(p, [...(kids.get(p) ?? []), a]);
    }
    const rows: HTMLElement[] = [];
    const walk = (parent: string | undefined, depth: number) => {
      for (const a of (kids.get(parent) ?? []).sort((x, y) => x.createdAt - y.createdAt)) {
        rows.push(this.row(a, depth, a.id === selected));
        walk(a.id, depth + 1);
      }
    };
    walk(undefined, 0);
    swap(this.list, rows.length ? rows : [el("div", "muted", "Niemand im Büro.")]);
  }

  private row(a: Agent, depth: number, selected: boolean) {
    const r = el("button", "agent" + (selected ? " sel" : "") + (a.status === "done" ? " done" : ""));
    r.dataset.id = a.id;
    r.style.paddingLeft = 10 + depth * 14 + "px";
    const dot = el("span", "dot");
    dot.style.background = STATUS_COLOR[statusKey(a)];
    const main = el("span", "main");
    const title = el("span", "name", a.name);
    title.append(el("span", "role", roleLabel(a.name)));
    main.append(title);
    const live = a.tool && (a.tool.state === "running" || a.tool.state === "pending");
    const sub = el("span", "sub", a.waiting ? "✋ wartet auf Freigabe" : live ? `${a.tool!.name} · ${a.tool!.title}` : STATUS_LABEL[statusKey(a)]);
    main.append(sub);
    r.append(dot, main);
    r.onclick = () => this.cb.selectAgent(selected ? undefined : a.id);
    return r;
  }

  private renderDetail(a?: Agent) {
    if (!a) {
      swap(this.detail, [el("div", "muted hint", "Figur oder Eintrag anklicken für Details.")]);
      return;
    }
    const head = el("div", "d-head");
    const dot = el("span", "dot");
    dot.style.background = STATUS_COLOR[statusKey(a)];
    head.append(dot, el("strong", "", a.name), el("span", "role", roleLabel(a.name)));
    const stats = el("div", "stats");
    const stat = (k: string, v: string) => {
      const s = el("div", "stat");
      s.append(el("span", "k", k), el("span", "v", v));
      stats.append(s);
    };
    stat("Status", STATUS_LABEL[statusKey(a)]);
    stat("Tokens", fmtTokens(a.tokens));
    stat("Kosten", a.cost ? "$" + a.cost.toFixed(4) : "–");
    stat("Modell", a.model ?? "–");
    const parts: HTMLElement[] = [head];
    if (a.title) parts.push(el("div", "d-title", a.title));
    parts.push(stats);

    if (a.todos.length) {
      const box = el("div", "todos");
      box.append(el("h4", "", `Todos (${a.todos.filter((t) => t.status === "completed").length}/${a.todos.length})`));
      for (const t of a.todos) {
        const mark = t.status === "completed" ? "☑" : t.status === "in_progress" ? "▶" : t.status === "cancelled" ? "✕" : "☐";
        box.append(el("div", "todo " + t.status, `${mark} ${t.content}`));
      }
      parts.push(box);
    }

    const feed = this.state.feeds.get(a.id) ?? [];
    const fb = el("div", "feed");
    fb.append(el("h4", "", "Aktivität"));
    for (const f of feed.slice(-120).reverse()) {
      const row = el("div", "f " + f.kind);
      row.append(el("span", "t", fmtAge(this.state.age(f.ts))), el("span", "i", FEED_ICON[f.kind] ?? "•"), el("span", "x", f.text));
      fb.append(row);
    }
    if (!feed.length) fb.append(el("div", "muted", "noch nichts"));
    parts.push(fb);
    swap(this.detail, parts);
  }
}
