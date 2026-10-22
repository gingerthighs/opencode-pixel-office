// DOM side panel + room tabs. Everything goes through textContent (no innerHTML with data).

import type { Agent, ControlRequest, FeedEntry, Room } from "../src/types.ts";
import { lookOf, roleOf, STATUS_COLOR, STATUS_LABEL } from "./roles.ts";
import type { PersonInfo } from "./scene.ts";
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

/** Fixed child sections, each swapped on its own, so a changing feed never replaces the buttons above it. */
function sections(container: HTMLElement, n: number): HTMLElement[] {
  if (container.children.length !== n || !(container.firstElementChild as HTMLElement | null)?.classList.contains("sec")) {
    container.replaceChildren(...Array.from({ length: n }, () => el("div", "sec")));
  }
  return Array.from(container.children) as HTMLElement[];
}

const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
const statusKey = (a: Agent) => (a.waiting ? "waiting" : a.status);
const roleLabel = (name: string) => roleOf(name).label;

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
      return "paper";
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

function pill(key: string, text = STATUS_LABEL[key]) {
  const p = el("span", "pill " + key, text);
  p.style.setProperty("--c", STATUS_COLOR[key] ?? "#868e96");
  return p;
}

export interface PanelCallbacks {
  selectRoom(id: string): void;
  select(key: string | undefined): void;
  control(req: ControlRequest): Promise<void>;
  caps(): { control: boolean; reason?: string };
  workerName(agentId: string): string | undefined;
  personInfo(key: string): PersonInfo | undefined;
  roster(): PersonInfo[];
}

export class Panel {
  private state: ClientState;
  private cb: PanelCallbacks;
  private tabs = document.getElementById("rooms")!;
  private list = document.getElementById("agents")!;
  private detail = document.getElementById("detail")!;
  private showAll = document.getElementById("show-all") as HTMLInputElement;
  /** UI feedback for control actions, keyed by session id */
  private actions = new Map<string, { text: string; error?: boolean; armedStop?: number }>();

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
    if (selected?.startsWith("p:")) this.renderPerson(selected);
    else this.renderDetail(selected ? this.state.agents.get(selected) : undefined);
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
    head.append(el("span", "", "Aufträge"), el("span", "muted-inline", `${busy} aktiv · ${agents.length} gesamt`));
    const nodes: HTMLElement[] = [head, ...(rows.length ? rows : [el("div", "muted", "Gerade keine Aufträge.")])];

    const off = this.cb.roster().filter((p) => !p.agentId);
    if (off.length) {
      const h2 = el("div", "list-head");
      h2.append(el("span", "", "In der Pause"), el("span", "muted-inline", String(off.length)));
      nodes.push(h2);
      const grid = el("div", "breakroom");
      for (const p of off) {
        const b = el("button", "chip" + (p.key === selected ? " sel" : ""));
        b.dataset.id = p.key;
        b.title = `${p.name} · ${p.status}`;
        b.append(img(avatarURL(p.look), "avatar sm", p.name), el("span", "", p.name));
        b.onclick = () => this.cb.select(p.key === selected ? undefined : p.key);
        grid.append(b);
      }
      nodes.push(grid);
    }
    swap(this.list, nodes);
  }

  private row(a: Agent, depth: number, selected: boolean) {
    const r = el("button", "agent" + (selected ? " sel" : "") + (a.status === "done" ? " done" : ""));
    r.dataset.id = a.id;
    r.style.setProperty("--depth", String(depth));
    if (depth) r.append(el("span", "branch"));
    const worker = this.cb.personInfo(a.id);
    r.append(img(avatarURL(worker?.look ?? lookOf(a.name, a.id)), "avatar", a.name));
    const main = el("span", "main");
    const top = el("span", "top");
    top.append(el("span", "name", worker?.name ?? a.name), el("span", "role", `${roleLabel(a.name)} · ${a.name}`), pill(statusKey(a)));
    main.append(top);
    const live = a.tool && (a.tool.state === "running" || a.tool.state === "pending");
    const sub = el("span", "sub");
    if (a.waiting) sub.append(img(iconURL("question"), "ico"), document.createTextNode(a.ask?.title ?? "wartet auf Freigabe / Antwort"));
    else if (live) sub.append(img(iconURL(toolIcon(a.tool!.name)), "ico"), document.createTextNode(`${a.tool!.name} · ${a.tool!.title}`));
    else if (a.snippet && a.status === "busy") sub.append(img(iconURL(a.snippet.kind === "think" ? "think" : "speech"), "ico"), document.createTextNode(a.snippet.text));
    else sub.append(document.createTextNode(`${fmtTokens(a.tokens)} Tokens${a.edits ? ` · ${a.edits} Änderungen` : ""}`));
    main.append(sub);
    r.append(main);
    r.onclick = () => this.cb.select(selected ? undefined : a.id);
    return r;
  }

  private renderPerson(key: string) {
    const p = this.cb.personInfo(key);
    if (!p) return this.renderDetail(undefined);
    const head = el("div", "d-head");
    head.append(img(avatarURL(p.look), "avatar big", p.name));
    const names = el("div", "d-names");
    const line = el("div", "d-line");
    line.append(el("strong", "", p.name), pill("idle", p.temp ? "Aushilfe" : "Team"));
    names.append(line, el("span", "role", roleLabel(p.team)));
    head.append(names);
    const now = el("div", "current completed");
    now.append(img(iconURL("zzz"), "ico"), el("strong", "", "Gerade"), el("span", "", p.status));
    const stats = el("div", "stats");
    const s1 = el("div", "stat");
    s1.append(el("span", "k", "Erledigt"), el("span", "v", `${p.done} Aufträge`));
    const s2 = el("div", "stat");
    s2.append(el("span", "k", "Team"), el("span", "v", p.team));
    stats.append(s1, s2);
    const secs = sections(this.detail, 4);
    swap(secs[0], [head, now, stats, el("div", "muted hint-p", "Bekommt den nächsten passenden Auftrag vom Chef.")]);
    for (const sec of secs.slice(1)) swap(sec, []);
  }

  private renderDetail(a?: Agent) {
    if (!a) {
      const hint = el("div", "hint");
      hint.append(img(iconURL("magnifier"), "ico"), document.createTextNode("Figur, Schreibtisch oder Eintrag anklicken für Details."));
      const secs = sections(this.detail, 4);
      swap(secs[0], [hint]);
      for (const sec of secs.slice(1)) swap(sec, []);
      return;
    }
    const worker = this.cb.personInfo(a.id);
    const head = el("div", "d-head");
    head.append(img(avatarURL(worker?.look ?? lookOf(a.name, a.id)), "avatar big", a.name));
    const names = el("div", "d-names");
    const line = el("div", "d-line");
    line.append(el("strong", "", worker?.name ?? a.name), pill(statusKey(a)));
    names.append(line, el("span", "role", `${roleLabel(a.name)} · Agent „${a.name}“`));
    head.append(names);
    const [secHead, secAsk, secInfo, secFeed] = sections(this.detail, 4);
    const headParts: HTMLElement[] = [head];
    if (a.title) headParts.push(el("div", "d-title", a.title));
    if (worker && worker.status && a.status !== "busy") headParts.push(el("div", "muted-inline", worker.status));
    swap(secHead, headParts);

    const askParts: HTMLElement[] = [];
    if (a.ask) askParts.push(this.askBox(a));
    const ctl = this.controls(a);
    if (ctl) askParts.push(ctl);
    swap(secAsk, askParts);

    const parts: HTMLElement[] = [];

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

    if (a.files.length) {
      const box = el("div", "files");
      box.append(el("h4", "", `Papierstapel · ${a.edits} Änderungen`));
      for (const f of [...a.files].reverse()) {
        const row = el("div", "file");
        const parts2 = f.split(/[\\/]/);
        row.append(img(iconURL("paper"), "ico"), el("span", "fname", parts2.pop() ?? f), el("span", "fdir", parts2.slice(-2).join("/")));
        row.title = f;
        box.append(row);
      }
      parts.push(box);
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

    swap(secInfo, parts);

    const feed = this.state.feeds.get(a.id) ?? [];
    const fb = el("div", "feed");
    fb.append(el("h4", "", "Aktivität"));
    for (const f of feed.slice(-120).reverse()) {
      const row = el("div", "f " + f.kind);
      row.append(el("span", "t", fmtAge(this.state.age(f.ts))), img(iconURL(feedIcon(f)), "ico"), el("span", "x", f.text));
      fb.append(row);
    }
    if (!feed.length) fb.append(el("div", "muted", "noch nichts"));
    swap(secFeed, [fb]);
  }

  private askBox(a: Agent): HTMLElement {
    const ask = a.ask!;
    const box = el("div", "ask " + ask.kind);
    const h = el("div", "ask-head");
    h.append(img(iconURL("question"), "ico"), el("strong", "", ask.kind === "permission" ? "Freigabe nötig" : "Rückfrage"));
    box.append(h, el("div", "ask-title", ask.title));
    if (ask.detail) box.append(el("code", "ask-detail", ask.detail));
    if (ask.options?.length) {
      const opts = el("div", "ask-opts");
      for (const o of ask.options) opts.append(el("span", "opt", o));
      box.append(opts);
    }
    const caps = this.cb.caps();
    const feedback = this.actions.get(a.id);
    if (ask.kind === "permission" && ask.id && caps.control) {
      const btns = el("div", "ask-btns");
      const mk = (label: string, decision: "once" | "always" | "reject", cls: string) => {
        const b = el("button", "btn " + cls, label);
        b.onclick = () => this.run(a.id, { action: "permission", sessionID: a.id, requestID: ask.id!, decision }, "Antwort gesendet");
        return b;
      };
      btns.append(mk("Einmal erlauben", "once", "ok"), mk("Immer erlauben", "always", "ok2"), mk("Ablehnen", "reject", "no"));
      box.append(btns);
    } else if (ask.kind === "question") {
      box.append(el("div", "muted-inline", "Fragen bitte im Terminal beantworten – die Plugin-API kann keine Antworten senden."));
    } else if (!caps.control) {
      box.append(el("div", "muted-inline", `Steuerung aus: ${caps.reason ?? "nicht verfügbar"}`));
    }
    if (feedback) box.append(el("div", feedback.error ? "fb err" : "fb", feedback.text));
    return box;
  }

  private controls(a: Agent): HTMLElement | undefined {
    const caps = this.cb.caps();
    if (!caps.control || !(a.status === "busy" || a.status === "retry" || a.waiting)) return;
    const armed = (this.actions.get(a.id)?.armedStop ?? 0) > Date.now();
    const wrap = el("div", "ctl");
    const b = el("button", "btn no" + (armed ? " armed" : ""), armed ? "Wirklich stoppen?" : "■ Stopp");
    b.onclick = () => {
      if (!armed) {
        this.actions.set(a.id, { text: "", armedStop: Date.now() + 3000 });
        this.render(a.roomId, a.id);
        return;
      }
      this.run(a.id, { action: "interrupt", sessionID: a.id }, "Stopp gesendet");
    };
    wrap.append(b);
    const fb = this.actions.get(a.id);
    if (fb?.text && !a.ask) wrap.append(el("span", fb.error ? "fb err" : "fb", fb.text));
    return wrap;
  }

  private run(id: string, req: ControlRequest, okText: string) {
    this.actions.set(id, { text: "sende…" });
    this.cb
      .control(req)
      .then(() => this.actions.set(id, { text: okText }))
      .catch((err) => this.actions.set(id, { text: `Fehler: ${String(err).slice(0, 120)}`, error: true }));
  }
}
