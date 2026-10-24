import { attentionItems, duration } from "./activity.ts";
import { swap } from "./dom.ts";
import type { ClientState } from "./state.ts";

export class Attention {
  private state: ClientState;
  private list: HTMLElement;
  private count: HTMLElement;
  private warning: HTMLElement;
  private pick: (id: string) => void;
  private name: (id: string) => string | undefined;

  constructor(state: ClientState, list: HTMLElement, count: HTMLElement, warning: HTMLElement,
    pick: (id: string) => void, name: (id: string) => string | undefined) {
    this.state = state;
    this.list = list;
    this.count = count;
    this.warning = warning;
    this.pick = pick;
    this.name = name;
  }

  render() {
    const items = attentionItems(this.state);
    this.count.textContent = String(items.length);
    this.warning.hidden = this.state.connected;
    this.warning.textContent = "Disconnected — showing last received state. Inactivity checks paused.";
    const rows = items.map((item) => {
      const a = item.record.agent;
      const row = document.createElement("button");
      row.className = `attention-row ${item.kind}`;
      row.dataset.sessionId = a.id;
      row.onclick = () => this.pick(a.id);
      const title = document.createElement("strong");
      title.textContent = `${item.kind === "inactive" ? "Inactive" : item.kind === "failure" ? "Failed" : item.kind === "question" ? "Question" : "Approval"} · ${this.name(a.id) ?? a.name}`;
      const context = document.createElement("span");
      context.className = "attention-context";
      const room = this.state.rooms.get(a.roomId);
      const project = room?.directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
      context.textContent = `${project ? project + " · " : ""}${room?.title ?? a.title} · ${duration(this.state.observedNow() - item.since)}`;
      const detail = document.createElement("span");
      detail.textContent = item.text;
      row.append(title, context, detail);
      return row;
    });
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = this.state.connected ? "Nothing needs attention." : "Waiting for connection…";
      swap(this.list, [empty]);
    } else swap(this.list, rows);
  }
}
