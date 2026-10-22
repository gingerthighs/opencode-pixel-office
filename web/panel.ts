// DOM side panel + room tabs. Everything goes through textContent (no innerHTML with data).

import type { Agent, FeedEntry, Room } from "../src/types.ts";
import { lookOf, roleOf, STATUS_COLOR, STATUS_LABEL } from "./roles.ts";
import { avatarURL, iconURL, toolIcon, type IconName } from "./sprites.ts";
import type { ClientState } from "./state.ts";

const STALE_ROOM = 2 * 60 * 60 * 1000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function img(src: string, cls: string, alt = ""): HTMLImageElement {
  const i = el("img", cls);
  i.src = src;
  i.alt = alt;
  return i;
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

function feedIcon(f: FeedEntry): IconName {
  switch (f.kind) {
    case "tool":
      return toolIcon(f.text.split(/[\s·]/)[0] ?? "");
    case "text":
      return "speech";
    case "think":
      return "think";
    case "prompt":
      return "page";
    case "spawn":
      return "plane";
    case "error":
      return "alert";
    case "todo":
      return "clipboard";
    case "ask":
      return "question";
    default:
      return f.text === "fertig" ? "check" : "gear";
  }
}

function pill(a: Agent) {
  const k = statusKey(a);
  const p = el("span", "pill " + k, STATUS_LABEL[k]);
  p.style.setProperty("--c", STATUS_COLOR[k]);
  return p;
}

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
      const busy = this.state.roomBusy(r.id);
      const b = el("button", "tab" + (r.id === current ? " active" : "") + (busy ? " busy" : ""));
      b.dataset.id = r.id;
      b.title = `${r.directory}\n${r.title}`;
      // v2 session listings carry no title until the session gets one
      const title = r.title !== "Session" ? r.title : new Date(r.createdAt).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      const agents = this.state.roomAgents(r.id).filter((a) => a.status !== "done").length;
      b.append(el("span", "dot"), el("span", "proj", basename(r.directory) || "—"), el("span", "ttl", title), el("span", "count", String(agents)));
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
    const head = el("div", "list-head");
    const busy = agents.filter((a) => a.status === "busy" || a.status === "retry").length;
    head.append(el("span", "", "Team"), el("span", "muted-inline", `${busy} aktiv · ${agents.length} gesamt`));
    swap(this.list, rows.length ? [head, ...rows] : [head, el("div", "muted", "Niemand im Büro.")]);
  }

  private row(a: Agent, depth: number, selected: boolean) {
    const r = el("button", "agent" + (selected ? " sel" : "") + (a.status === "done" ? " done" : ""));
    r.dataset.id = a.id;
    r.style.setProperty("--depth", String(depth));
    if (depth) r.append(el("span", "branch"));
    r.append(img(avatarURL(lookOf(a.name, a.id)), "avatar", a.name));
    const main = el("span", "main");
    const top = el("span", "top");
    top.append(el("span", "name", a.name), el("span", "role", roleLabel(a.name)), pill(a));
    main.append(top);
    const live = a.tool && (a.tool.state === "running" || a.tool.state === "pending");
    const sub = el("span", "sub");
    if (a.waiting) sub.append(img(iconURL("question"), "ico"), document.createTextNode("wartet auf Freigabe / Antwort"));
    else if (live) sub.append(img(iconURL(toolIcon(a.tool!.name)), "ico"), document.createTextNode(`${a.tool!.name} · ${a.tool!.title}`));
    else if (a.snippet && a.status === "busy") sub.append(img(iconURL(a.snippet.kind === "think" ? "think" : "speech"), "ico"), document.createTextNode(a.snippet.text));
    else sub.append(document.createTextNode(a.tokens ? `${fmtTokens(a.tokens)} Tokens` : roleOf(a.name).label));
    main.append(sub);
    r.append(main);
    r.onclick = () => this.cb.selectAgent(selected ? undefined : a.id);
    return r;
  }

  private renderDetail(a?: Agent) {
    if (!a) {
      const hint = el("div", "hint");
      hint.append(img(iconURL("magnifier"), "ico"), document.createTextNode("Figur oder Eintrag anklicken für Details."));
      swap(this.detail, [hint]);
      return;
    }
    const head = el("div", "d-head");
    head.append(img(avatarURL(lookOf(a.name, a.id)), "avatar big", a.name));
    const names = el("div", "d-names");
    const line = el("div", "d-line");
    line.append(el("strong", "", a.name), pill(a));
    names.append(line, el("span", "role", roleLabel(a.name) || roleOf(a.name).label));
    head.append(names);
    const parts: HTMLElement[] = [head];
    if (a.title) parts.push(el("div", "d-title", a.title));

    const stats = el("div", "stats");
    const stat = (k: string, v: string) => {
      const s = el("div", "stat");
      s.append(el("span", "k", k), el("span", "v", v));
      stats.append(s);
    };
    stat("Tokens", fmtTokens(a.tokens));
    stat("Kosten", a.cost ? "$" + a.cost.toFixed(4) : "–");
    stat("Modell", a.model ?? "–");
    stat("Aktiv seit", fmtAge(this.state.age(a.createdAt)));
    parts.push(stats);

    if (a.tool) {
      const cur = el("div", "current " + a.tool.state);
      cur.append(img(iconURL(a.tool.state === "error" ? "alert" : toolIcon(a.tool.name)), "ico"), el("strong", "", a.tool.name), el("span", "", a.tool.title));
      parts.push(cur);
    }

    if (a.todos.length) {
      const done = a.todos.filter((t) => t.status === "completed").length;
      const box = el("div", "todos");
      box.append(el("h4", "", `Todos ${done}/${a.todos.length}`));
      const bar = el("div", "bar");
      const fill = el("span");
      fill.style.width = `${Math.round((100 * done) / a.todos.length)}%`;
      bar.append(fill);
      box.append(bar);
      for (const t of a.todos) {
        const mark = t.status === "completed" ? "✔" : t.status === "in_progress" ? "▶" : t.status === "cancelled" ? "✕" : "·";
        const row = el("div", "todo " + t.status);
        row.append(el("span", "mark", mark), el("span", "", t.content));
        box.append(row);
      }
      parts.push(box);
    }

    const feed = this.state.feeds.get(a.id) ?? [];
    const fb = el("div", "feed");
    fb.append(el("h4", "", "Aktivität"));
    for (const f of feed.slice(-120).reverse()) {
      const row = el("div", "f " + f.kind);
      row.append(el("span", "t", fmtAge(this.state.age(f.ts))), img(iconURL(feedIcon(f)), "ico"), el("span", "x", f.text));
      fb.append(row);
    }
    if (!feed.length) fb.append(el("div", "muted", "noch nichts"));
    parts.push(fb);
    swap(this.detail, parts);
  }
}
