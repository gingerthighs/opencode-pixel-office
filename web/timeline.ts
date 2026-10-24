// Gantt-style strip: who worked when in the current room (parallel runs at a glance).

import { lookOf } from "./roles.ts";
import { avatarURL } from "./sprites.ts";
import type { ClientState } from "./state.ts";
import { ACTIVITY_COLOR, activityTotals, clipIntervals, duration, TIMELINE_WINDOWS } from "./activity.ts";
import { swap } from "./dom.ts";

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
  private body: HTMLElement;
  private roomId?: string;
  private selected?: string;
  windowMinutes = 60;

  constructor(root: HTMLElement, state: ClientState, nameOf: (id: string) => string | undefined, onPick: (id: string) => void) {
    this.root = root;
    this.state = state;
    this.nameOf = nameOf;
    this.onPick = onPick;
    const toolbar = el("div", "tl-toolbar");
    const label = el("label", "", "Activity window ");
    const select = el("select");
    select.setAttribute("aria-label", "Activity window");
    for (const minutes of TIMELINE_WINDOWS) {
      const option = el("option", "", minutes === 120 ? "2 hours" : `${minutes} minutes`);
      option.value = String(minutes);
      select.append(option);
    }
    select.value = "60";
    select.onchange = () => {
      this.windowMinutes = Number(select.value);
      this.render(this.roomId, this.selected);
    };
    label.append(select);
    toolbar.append(label);
    for (const [state, color] of Object.entries(ACTIVITY_COLOR)) {
      const item = el("span", "tl-key", state);
      item.style.setProperty("--c", color);
      toolbar.append(item);
    }
    this.body = el("div");
    this.root.replaceChildren(toolbar, this.body);
  }

  render(roomId: string | undefined, selected?: string) {
    this.roomId = roomId;
    this.selected = selected;
    const items = roomId ? [...this.state.history.values()].filter((r) => r.agent.roomId === roomId) : [];
    const now = this.state.observedNow();
    const span = this.windowMinutes * 60_000;
    const start = now - span;
    const rows: HTMLElement[] = [];

    // time axis
    const axis = el("div", "tl-axis");
    const step = this.windowMinutes === 120 ? 30 * 60_000 : this.windowMinutes === 60 ? 15 * 60_000 : 5 * 60_000;
    for (let tick = Math.ceil(start / step) * step; tick <= now; tick += step) {
      const m = el("span", "tl-tick", new Date(tick).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      m.style.left = `${((tick - start) / span) * 100}%`;
      axis.append(m);
    }
    rows.push(axis);

    for (const record of items.sort((x, y) => (x.agent.parentId ? 1 : 0) - (y.agent.parentId ? 1 : 0) || x.firstObservedAt - y.firstObservedAt)) {
      const a = record.agent;
      const row = el("button", "tl-row" + (a.id === selected ? " sel" : ""));
      row.dataset.sessionId = a.id;
      row.onclick = () => this.onPick(a.id);
      const who = el("span", "tl-who");
      const img = el("img", "tl-ava");
      img.src = avatarURL(lookOf(a.name, a.id));
      const totals = activityTotals(record.intervals, start, now);
      const caption = el("span", "tl-caption");
      caption.append(el("span", "", this.nameOf(a.id) ?? a.name),
        el("span", "tl-totals", `${duration(totals.working)} work · ${duration(totals.waiting)} wait`));
      who.append(img, caption);
      row.title = `${a.title || a.name}${record.archived ? " · archived (read-only)" : ""}${a.outcome ? ` · ${a.outcome}` : ""}${record.truncated ? " · earlier history truncated" : ""}`;
      const lane = el("span", "tl-lane");
      for (const interval of clipIntervals(record.intervals, start, now)) {
        const bar = el("span", "tl-bar " + interval.state);
        bar.style.left = `${((interval.start - start) / span) * 100}%`;
        bar.style.width = `${((interval.end! - interval.start) / span) * 100}%`;
        bar.style.setProperty("--c", ACTIVITY_COLOR[interval.state]);
        bar.title = `${interval.state} · ${duration(interval.end! - interval.start)} · ${new Date(interval.start).toLocaleTimeString()}–${new Date(interval.end!).toLocaleTimeString()}`;
        lane.append(bar);
      }
      row.append(who, lane);
      rows.push(row);
    }
    if (items.length === 0) rows.push(el("div", "muted", "No activity in this room yet."));
    rows.push(el("div", "tl-note", `${this.state.historyTruncated ? "Earlier history expired or truncated. " : ""}Observed activity only · up to 2 hours in memory${this.state.connected ? "" : " · disconnected, times paused"}`));
    swap(this.body, rows);
  }
}
