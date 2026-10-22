// Client-side mirror of the server store, fed by SSE snapshot + ops.

import type { Agent, FeedEntry, Op, Room, Snapshot } from "../src/types.ts";

const FEED_MAX = 200;

export class ClientState {
  rooms = new Map<string, Room>();
  agents = new Map<string, Agent>();
  feeds = new Map<string, FeedEntry[]>();
  /** every agent seen in this view, kept after the server prunes it (timeline) */
  history = new Map<string, Agent & { endedAt?: number }>();
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
    this.skew = Date.now() - s.now;
    for (const r of s.rooms) this.rooms.set(r.id, r);
    for (const { feed, ...a } of s.agents) {
      this.agents.set(a.id, a);
      this.feeds.set(a.id, feed);
      this.history.set(a.id, a);
    }
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
          for (const [id, a] of this.history) if (a.roomId === o.id) this.history.delete(id);
          break;
        case "agent":
          this.agents.set(o.agent.id, o.agent);
          this.history.set(o.agent.id, o.agent);
          break;
        case "agent-remove": {
          this.agents.delete(o.id);
          this.feeds.delete(o.id);
          const h = this.history.get(o.id);
          if (h && !h.doneAt) h.endedAt = this.serverNow();
          break;
        }
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
