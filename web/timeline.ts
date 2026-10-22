// Gantt-style strip: who worked when in the current room (parallel runs at a glance).

import { lookOf, STATUS_COLOR } from "./roles.ts";
import { avatarURL } from "./sprites.ts";
import type { ClientState } from "./state.ts";

const MAX_WINDOW = 60 * 60 * 1000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Timeline {
  private root: HTMLElement;
  private state: ClientState;
  private nameOf: (agentId: string) => string | undefined;
  private onPick: (agentId: string) => void;

  constructor(root: HTMLElement, state: ClientState, nameOf: (id: string) => string | undefined, onPick: (id: string) => void) {
    this.root = root;
    this.state = state;
    this.nameOf = nameOf;
    this.onPick = onPick;
  }

  render(roomId: string | undefined, selected?: string) {
    const items = roomId ? [...this.state.history.values()].filter((a) => a.roomId === roomId) : [];
    const now = this.state.serverNow();
    const start = Math.max(now - MAX_WINDOW, Math.min(now - 60_000, ...items.map((a) => a.createdAt)));
    const span = Math.max(1, now - start);
    const rows: HTMLElement[] = [];

    // time axis
    const axis = el("div", "tl-axis");
    const step = span > 30 * 60_000 ? 10 * 60_000 : span > 10 * 60_000 ? 5 * 60_000 : 60_000;
    for (let tick = Math.ceil(start / step) * step; tick <= now; tick += step) {
      const m = el("span", "tl-tick", new Date(tick).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      m.style.left = `${((tick - start) / span) * 100}%`;
      axis.append(m);
    }
    rows.push(axis);

    for (const a of items.sort((x, y) => (x.parentId ? 1 : 0) - (y.parentId ? 1 : 0) || x.createdAt - y.createdAt)) {
      const row = el("button", "tl-row" + (a.id === selected ? " sel" : ""));
      row.onclick = () => this.onPick(a.id);
      const who = el("span", "tl-who");
      const img = el("img", "tl-ava");
      img.src = avatarURL(lookOf(a.name, a.id));
      who.append(img, el("span", "", this.nameOf(a.id) ?? a.name));
      const lane = el("span", "tl-lane");
      const end = a.doneAt ?? a.endedAt ?? now;
      const bar = el("span", "tl-bar " + (a.waiting ? "waiting" : a.status));
      bar.style.left = `${Math.max(0, ((a.createdAt - start) / span) * 100)}%`;
      bar.style.width = `${Math.max(0.8, ((end - Math.max(a.createdAt, start)) / span) * 100)}%`;
      bar.style.setProperty("--c", STATUS_COLOR[a.waiting ? "waiting" : a.status]);
      bar.title = `${a.name}: ${Math.round((end - a.createdAt) / 1000)}s`;
      lane.append(bar);
      row.append(who, lane);
      rows.push(row);
    }
    if (items.length === 0) rows.push(el("div", "muted", "Noch keine Aktivität in diesem Raum."));
    this.root.replaceChildren(...rows);
  }
}
