// Client-side mirror of the server store, fed by SSE snapshot + ops.

import type { ActivityRecord, Agent, FeedEntry, Op, Room, Snapshot } from "../src/types.ts";

const FEED_MAX = 200;

export class ClientState {
  rooms = new Map<string, Room>();
  agents = new Map<string, Agent>();
  feeds = new Map<string, FeedEntry[]>();
  /** Authoritative retained history; independent of canvas assignments. */
  history = new Map<string, ActivityRecord>();
  historyTruncated = false;
  connected = false;
  private disconnectedAt?: number;
  /** local clock minus server clock */
  skew = 0;
  version = 0;
  onReset?: () => void;
  onDelegate?: (from: string, to: string, label: string) => void;

  load(s: Snapshot) {
    this.rooms.clear();
    this.agents.clear();
    this.feeds.clear();
    this.history.clear();
    this.historyTruncated = s.historyTruncated ?? false;
    this.skew = Date.now() - s.now;
    for (const r of s.rooms) this.rooms.set(r.id, r);
    for (const { feed, ...a } of s.agents) {
      this.agents.set(a.id, a);
      this.feeds.set(a.id, feed);
    }
    for (const record of s.history ?? []) this.history.set(record.agent.id, record);
    this.version++;
    this.onReset?.();
  }

  apply(ops: Op[]) {
    for (const o of ops) {
      switch (o.op) {
        case "room":
          this.rooms.set(o.room.id, o.room);
          break;
        case "room-remove":
          this.rooms.delete(o.id);
          break;
        case "agent":
          this.agents.set(o.agent.id, o.agent);
          break;
        case "agent-remove": {
          this.agents.delete(o.id);
          this.feeds.delete(o.id);
          break;
        }
        case "history":
          this.history.set(o.record.agent.id, o.record);
          break;
        case "history-remove":
          this.history.delete(o.id);
          break;
        case "history-truncated":
          this.historyTruncated = true;
          break;
        case "feed": {
          const f = this.feeds.get(o.id) ?? [];
          f.push(o.entry);
          if (f.length > FEED_MAX) f.splice(0, f.length - FEED_MAX);
          this.feeds.set(o.id, f);
          break;
        }
        case "delegate":
          this.onDelegate?.(o.from, o.to, o.label);
          break;
      }
    }
    this.version++;
  }

  serverNow() {
    return Date.now() - this.skew;
  }

  setConnected(connected: boolean) {
    if (this.connected && !connected) this.disconnectedAt = this.serverNow();
    if (connected) this.disconnectedAt = undefined;
    this.connected = connected;
    this.version++;
  }

  /** Freeze elapsed indicators while the stream is disconnected. */
  observedNow() {
    return this.connected ? this.serverNow() : this.disconnectedAt ?? this.serverNow();
  }

  inactivityNow() {
    return this.connected ? this.serverNow() : this.disconnectedAt;
  }

  detailAgent(id: string) {
    return this.agents.get(id) ?? this.history.get(id)?.agent;
  }

  hasSelection(id: string) {
    return this.agents.has(id) || this.history.has(id);
  }

  /** server timestamp → age in ms on the local clock */
  age(ts: number) {
    return Date.now() - this.skew - ts;
  }

  roomAgents(roomId: string): Agent[] {
    return [...this.agents.values()].filter((a) => a.roomId === roomId);
  }

  roomBusy(roomId: string) {
    return this.roomAgents(roomId).some((a) => a.status === "busy" || a.status === "retry" || a.waiting);
  }

  /** Rooms sorted by recent activity. */
  sortedRooms(): Room[] {
    return [...this.rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
