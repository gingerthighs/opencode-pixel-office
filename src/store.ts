// Pure state reducer: opencode bus events in, UI diff ops out.
// Must never throw — it runs inside opencode's event hook.

import type { ActivityInterval, ActivityRecord, ActivityState, Agent, AgentStatus, Ask, FeedEntry, FeedKind, Op, Room, Snapshot, ToolState } from "./types.ts";

const FEED_MAX = 200;
const SNAPSHOT_FEED = 60;
const SNIPPET_LEN = 90;
const EMIT_EVERY = 250;
const ROOM_TOUCH_EVERY = 5000;
export const DONE_TTL = 60_000;
export const HISTORY_TTL = 2 * 60 * 60_000;
export const MAX_ARCHIVED = 1000;
export const MAX_CLOSED_INTERVALS = 10_000;
const MAX_SEEN = 2000;
const MAX_ROLES = 5000;

export interface SessionInfo {
  id: string;
  parentID?: string;
  title?: string;
  directory?: string;
  agent?: string;
  time?: { created?: number; updated?: number };
}

export interface BusEvent {
  type?: string;
  properties?: any;
}

interface Entry {
  agent: Agent;
  feed: FeedEntry[];
  named: boolean;
  dirty: boolean;
  lastEmit: number;
  todoSummary: string;
  msgs: Map<string, { tokens: number; cost: number }>;
  seen: Set<string>;
  /** callID → file path, remembered from running tool events (completion events may lack input) */
  toolPaths: Map<string, string>;
  firstObservedAt: number;
  intervals: ActivityInterval[];
  archived: boolean;
  truncated: boolean;
  historyDirty: boolean;
  historyLastEmit: number;
  historyUrgent: boolean;
}

const WRITE_TOOL = /^(edit|write|patch|apply_patch|multiedit|multi_edit|str_replace|create_file)$/i;
const MAX_FILES = 50;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function head(text: string, n: number): string {
  const t = oneLine(text);
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function tail(text: string, n = SNIPPET_LEN): string {
  const t = oneLine(text);
  return t.length > n ? "…" + t.slice(-(n - 1)) : t;
}

const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

export function nameFromTitle(title?: string): string | undefined {
  if (!title) return;
  const m = title.match(/@([\w.-]+)/) ?? title.match(/\(([\w.-]+)\s+(?:sub)?agent\)/i);
  return m?.[1];
}

export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  for (const k of ["description", "filePath", "path", "pattern", "command", "url", "query", "prompt"]) {
    const v = rec[k];
    if (typeof v === "string" && v) return /path/i.test(k) ? basename(v) : head(v, 60);
  }
  return "";
}

const DELEGATION = /^(task|subagent|delegate|background_task|call_omo_agent|spawn)/i;

export function delegationTarget(tool: string, input: unknown): string | undefined {
  if (!DELEGATION.test(tool) || !input || typeof input !== "object") return;
  const rec = input as Record<string, unknown>;
  const t = rec.subagent_type ?? rec.agent ?? rec.subagent ?? rec.category;
  return typeof t === "string" && t ? t : undefined;
}

export class Store {
  readonly rooms = new Map<string, Room>();
  private entries = new Map<string, Entry>();
  private parents = new Map<string, string>();
  private names = new Map<string, string>();
  private roles = new Map<string, string>();
  private clock: () => number;
  private changed = new Set<Entry>();
  private historyTruncated = false;
  private lastHistoryPrune = -Infinity;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  knowParent(id: string, parentID?: string) {
    if (parentID) this.parents.set(id, parentID);
  }

  has(id: string) {
    const entry = this.entries.get(id);
    return !!entry && !entry.archived;
  }

  agent(id: string): Agent | undefined {
    const entry = this.entries.get(id);
    return entry && !entry.archived ? entry.agent : undefined;
  }

  snapshot(): Snapshot {
    return {
      rooms: [...this.rooms.values()].map((r) => ({ ...r })),
      agents: [...this.entries.values()].filter((e) => !e.archived).map((e) => ({ ...e.agent, feed: e.feed.slice(-SNAPSHOT_FEED) })),
      now: this.clock(),
      history: [...this.entries.values()].map((e) => this.activityRecord(e)),
      historyTruncated: this.historyTruncated,
    };
  }

  apply(ev: BusEvent): Op[] {
    const ops: Op[] = [];
    this.changed.clear();
    const p = ev?.properties ?? {};
    try {
      switch (ev?.type) {
        case "session.created":
        case "session.updated":
          if (p.info?.id) this.upsertSession(p.info, ops, ev.type === "session.created");
          break;
        case "session.deleted":
          if (p.info?.id) this.removeSession(p.info.id, ops);
          break;
        case "session.status": {
          const t = p.status?.type;
          if (!p.sessionID || !t) break;
          const s: AgentStatus = t === "busy" ? "busy" : t === "retry" ? "retry" : "idle";
          this.setStatus(p.sessionID, s, ops, t === "retry" ? p.status?.message : undefined);
          break;
        }
        case "session.idle":
          if (p.sessionID) this.setStatus(p.sessionID, "idle", ops);
          break;
        case "session.error":
          this.onError(p, ops);
          break;
        case "session.compacted":
          if (p.sessionID) this.log(this.ensure(p.sessionID, ops), "status", "context compacted", ops);
          break;
        case "message.updated":
          this.onMessage(p.info, ops);
          break;
        case "message.part.updated":
          this.onPart(p.part, ops);
          break;
        case "todo.updated":
          this.onTodos(p, ops);
          break;
        case "permission.updated":
        case "permission.asked": {
          if (!p.sessionID) break;
          const pats: unknown[] = Array.isArray(p.patterns) ? p.patterns : p.pattern ? [p.pattern].flat() : [];
          const title = String(p.title ?? p.permission ?? p.type ?? "permission");
          const detail = pats.length ? head(pats.map(String).join(", "), 200) : undefined;
          this.setWaiting(p.sessionID, true, title, ops, { kind: "permission", id: str(p.id) ?? str(p.requestID), title, detail });
          break;
        }
        case "question.asked": {
          if (!p.sessionID) break;
          const q = Array.isArray(p.questions) ? p.questions[0] : undefined;
          const title = String(p.title ?? q?.question ?? q?.header ?? "question");
          const raw = p.options ?? q?.options;
          const options = Array.isArray(raw) ? raw.map((o: any) => String(o?.label ?? o)).filter(Boolean).slice(0, 8) : undefined;
          this.setWaiting(p.sessionID, true, title, ops, { kind: "question", id: str(p.id) ?? str(p.requestID), title, options });
          break;
        }
        case "permission.replied":
        case "question.replied":
        case "question.rejected":
          if (p.sessionID) this.setWaiting(p.sessionID, false, "", ops);
          break;
      }
    } catch {
      // swallow: a malformed event must never break opencode
    }
    const emitted = new Set(ops.filter((o) => o.op === "agent").map((o) => o.agent.id));
    for (const e of this.changed) {
      if (this.entries.get(e.agent.id) !== e) continue;
      const transition = this.recordActivity(e);
      this.emitHistory(e, ops, transition || emitted.has(e.agent.id));
    }
    this.changed.clear();
    return ops;
  }

  /** Flush throttled updates and prune finished subagents. Call ~every 250ms. */
  tick(): Op[] {
    const now = this.clock();
    const ops: Op[] = [];
    for (const e of this.entries.values()) {
      const a = e.agent;
      if (!e.archived && a.status === "done" && a.doneAt !== undefined && now - a.doneAt > DONE_TTL) {
        e.archived = true;
        e.msgs.clear();
        e.seen.clear();
        e.toolPaths.clear();
        ops.push({ op: "agent-remove", id: a.id });
        this.emitHistory(e, ops, true);
      }
      if (e.dirty && now - e.lastEmit >= EMIT_EVERY) this.emit(e, ops);
      if (e.historyDirty) this.emitHistory(e, ops);
    }
    if (now - this.lastHistoryPrune >= 1000) {
      this.pruneHistory(now, ops);
      this.lastHistoryPrune = now;
    }
    this.changed.clear();
    return ops;
  }

  // ---- sessions ----

  private rootOf(id: string): string {
    let cur = id;
    for (let i = 0; i < 32; i++) {
      const p = this.parents.get(cur);
      if (!p) break;
      cur = p;
    }
    return cur;
  }

  private ensure(id: string, ops: Op[]): Entry {
    const e = this.entries.get(id) ?? this.upsertSession({ id }, ops, false);
    this.touch(e);
    return e;
  }

  private upsertSession(info: SessionInfo, ops: Op[], created: boolean): Entry {
    const now = this.clock();
    if (info.parentID) this.parents.set(info.id, info.parentID);
    const parentId = this.parents.get(info.id);
    const roomId = this.rootOf(info.id);

    if (parentId && this.rooms.has(info.id)) {
      // was seen before its parent link was known: fold the placeholder room into the real root
      this.rooms.delete(info.id);
      ops.push({ op: "room-remove", id: info.id });
    }

    if (!parentId) {
      const prev = this.rooms.get(info.id);
      const room: Room = {
        id: info.id,
        title: info.title || prev?.title || "Session",
        directory: info.directory || prev?.directory || "",
        createdAt: prev?.createdAt ?? info.time?.created ?? now,
        updatedAt: now,
      };
      if (!prev || prev.title !== room.title || prev.directory !== room.directory) {
        this.rooms.set(room.id, room);
        ops.push({ op: "room", room: { ...room } });
      }
    } else if (!this.rooms.has(roomId)) {
      const room: Room = { id: roomId, title: "Session", directory: info.directory ?? "", createdAt: now, updatedAt: now };
      this.rooms.set(roomId, room);
      ops.push({ op: "room", room: { ...room } });
    }

    const given = info.agent || nameFromTitle(info.title);
    if (given) this.names.set(info.id, given);

    let e = this.entries.get(info.id);
    const fresh = !e;
    if (!e) {
      const name = given ?? this.names.get(info.id);
      e = {
        agent: {
          id: info.id,
          roomId,
          parentId,
          name: name ?? (parentId ? "subagent" : "orchestrator"),
          title: info.title ?? "",
          status: "idle",
          waiting: false,
          todos: [],
          files: [],
          edits: 0,
          tokens: 0,
          cost: 0,
          createdAt: info.time?.created ?? now,
          updatedAt: now,
          lastActivityAt: now,
        },
        feed: [],
        named: !!name,
        dirty: false,
        lastEmit: 0,
        todoSummary: "",
        msgs: new Map(),
        seen: new Set(),
        toolPaths: new Map(),
        firstObservedAt: now,
        intervals: [],
        archived: false,
        truncated: false,
        historyDirty: true,
        historyLastEmit: -Infinity,
        historyUrgent: true,
      };
      this.entries.set(info.id, e);
    } else {
      const a = e.agent;
      if (info.title) a.title = info.title;
      if (given) {
        a.name = given;
        e.named = true;
      } else if (!e.named && parentId && a.name === "orchestrator") {
        a.name = "subagent";
      }
      a.parentId = parentId;
      a.roomId = roomId;
    }

    // re-home anything that lived in this session's placeholder room
    if (parentId) {
      for (const other of this.entries.values()) {
        if (other !== e && other.agent.roomId === info.id) {
          other.agent.roomId = this.rootOf(other.agent.id);
          this.emit(other, ops);
        }
      }
    }

    this.touch(e);
    this.emit(e, ops);

    if (fresh && parentId && created) {
      const parent = this.entries.get(parentId);
      if (parent) this.log(parent, "spawn", `→ @${e.agent.name} started`, ops);
      ops.push({ op: "delegate", from: parentId, to: info.id, label: e.agent.name });
    }
    return e;
  }

  private removeSession(id: string, ops: Op[]) {
    if (this.rooms.has(id)) {
      this.rooms.delete(id);
      for (const e of [...this.entries.values()]) {
        if (e.agent.roomId === id) {
          this.entries.delete(e.agent.id);
          ops.push({ op: "agent-remove", id: e.agent.id });
          ops.push({ op: "history-remove", id: e.agent.id });
          this.parents.delete(e.agent.id);
          this.names.delete(e.agent.id);
        }
      }
      ops.push({ op: "room-remove", id });
      return;
    }
    if (this.entries.delete(id)) {
      ops.push({ op: "agent-remove", id }, { op: "history-remove", id });
    }
    this.parents.delete(id);
    this.names.delete(id);
  }

  // ---- status ----

  private setStatus(id: string, s: AgentStatus, ops: Op[], msg?: string) {
    const e = this.ensure(id, ops);
    const a = e.agent;
    const prev = a.status;
    let next = s;
    const clearedAsk = s === "idle" && (a.waiting || !!a.ask);
    if (s === "idle") {
      a.waiting = false;
      a.ask = undefined;
      a.waitingSince = undefined;
      a.outcome = a.failure ? "failed" : a.outcome === "interrupted" ? "interrupted" : "completed";
      a.completedAt ??= this.clock();
      if (a.parentId) next = "done";
      else if (prev === "error") next = "error";
    }
    if (s === "busy") {
      e.archived = false;
      a.failure = undefined;
      a.outcome = undefined;
      a.completedAt = undefined;
    }
    if (s === "retry") e.archived = false;
    if (next === prev) {
      if (clearedAsk) this.emit(e, ops);
      return;
    }
    a.status = next;
    if (next === "done") {
      a.doneAt = this.clock();
      this.log(e, "status", "done", ops);
    } else {
      a.doneAt = undefined;
    }
    if (next === "retry") this.log(e, "status", msg ? `Retry: ${head(String(msg), 100)}` : "Retry", ops);
    if (next === "busy" && prev === "done") this.log(e, "status", "active again", ops);
    this.emit(e, ops);
  }

  private setWaiting(id: string, waiting: boolean, what: string, ops: Op[], ask?: Ask) {
    const e = this.ensure(id, ops);
    const a = e.agent;
    if (a.waiting === waiting && !ask && (waiting || !a.ask)) return;
    if (waiting && (!a.waiting || ask?.id !== a.ask?.id || ask?.kind !== a.ask?.kind)) a.waitingSince = this.clock();
    if (!waiting) a.waitingSince = undefined;
    if (waiting && (!a.waiting || ask?.id !== a.ask?.id)) this.log(e, "ask", `waiting: ${head(what, 120)}`, ops);
    a.waiting = waiting;
    a.ask = waiting ? ask : undefined;
    this.emit(e, ops);
  }

  private onError(p: any, ops: Op[]) {
    if (!p.sessionID) return;
    const e = this.ensure(p.sessionID, ops);
    const err = p.error ?? {};
    if (err.name === "MessageAbortedError") {
      e.agent.outcome = "interrupted";
      this.log(e, "status", "aborted", ops);
      this.setStatus(p.sessionID, "idle", ops);
      return;
    }
    const msg = err.data?.message ?? err.message ?? err.name ?? "error";
    e.agent.failure = { at: this.clock(), message: head(String(msg), 200) };
    e.agent.outcome = "failed";
    e.agent.waiting = false;
    e.agent.ask = undefined;
    e.agent.waitingSince = undefined;
    this.log(e, "error", head(String(msg), 200), ops);
    if (e.agent.status !== "error") {
      e.agent.status = "error";
      this.emit(e, ops);
    }
  }

  // ---- messages & parts ----

  private onMessage(info: any, ops: Op[]) {
    if (!info?.sessionID) return;
    const e = this.ensure(info.sessionID, ops);
    const a = e.agent;
    if (info.id && info.role) {
      this.roles.set(info.id, info.role);
      if (this.roles.size > MAX_ROLES) this.roles.delete(this.roles.keys().next().value!);
    }
    let changed = false;
    const name = info.agent || info.mode;
    if (typeof name === "string" && name && name !== a.name) {
      a.name = name;
      e.named = true;
      this.names.set(a.id, name);
      changed = true;
    }
    if (info.role === "assistant" && info.id) {
      if (info.modelID && info.modelID !== a.model) {
        a.model = info.modelID;
        changed = true;
      }
      const t = info.tokens;
      const tokens = t ? (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) : 0;
      e.msgs.set(info.id, { tokens, cost: info.cost ?? 0 });
      let tt = 0;
      let cc = 0;
      for (const m of e.msgs.values()) {
        tt += m.tokens;
        cc += m.cost;
      }
      if (tt !== a.tokens || cc !== a.cost) {
        a.tokens = tt;
        a.cost = cc;
        changed = true;
      }
    }
    if (changed) this.emit(e, ops, true);
  }

  private onPart(part: any, ops: Op[]) {
    if (!part?.sessionID) return;
    const e = this.ensure(part.sessionID, ops);
    const now = this.clock();
    switch (part.type) {
      case "tool":
        this.onTool(e, part, ops);
        break;
      case "text": {
        if (part.synthetic || part.ignored || typeof part.text !== "string" || !part.text.trim()) break;
        if (this.roles.get(part.messageID) === "user") {
          if (this.markSeen(e, "u:" + part.id)) this.log(e, "prompt", head(part.text, 240), ops);
          break;
        }
        e.agent.snippet = { text: tail(part.text), kind: "text", at: now };
        if (part.time?.end && this.markSeen(e, "x:" + part.id)) this.log(e, "text", head(part.text, 240), ops);
        this.emit(e, ops, true);
        break;
      }
      case "reasoning": {
        if (typeof part.text !== "string" || !part.text.trim()) break;
        e.agent.snippet = { text: tail(part.text), kind: "think", at: now };
        if (part.time?.end && this.markSeen(e, "r:" + part.id)) this.log(e, "think", head(part.text, 160), ops);
        this.emit(e, ops, true);
        break;
      }
      case "subtask":
        if (this.markSeen(e, "s:" + part.id)) {
          const what = head(String(part.description ?? part.prompt ?? ""), 120);
          this.log(e, "spawn", `→ @${part.agent ?? "subagent"}${what ? ": " + what : ""}`, ops);
        }
        break;
    }
  }

  private onTool(e: Entry, part: any, ops: Op[]) {
    const st = part.state ?? {};
    const state: ToolState = st.status ?? "pending";
    const name = String(part.tool ?? "tool");
    const key = String(part.callID ?? part.id);
    const target = delegationTarget(name, st.input);
    const desc = typeof st.input?.description === "string" ? st.input.description : "";
    const input = st.input ?? {};
    const path = str(input.filePath) ?? str(input.path) ?? str(input.file_path) ?? str(input.file);
    if (path) {
      e.toolPaths.set(key, path);
      if (e.toolPaths.size > 500) e.toolPaths.delete(e.toolPaths.keys().next().value!);
    }
    if (WRITE_TOOL.test(name) && state === "completed" && this.markSeen(e, "w:" + key)) {
      const a = e.agent;
      a.edits++;
      const fp = e.toolPaths.get(key);
      if (fp) {
        a.files = [...a.files.filter((x) => x !== fp), fp].slice(-MAX_FILES);
      }
    }
    const prev = e.agent.tool;
    const title = target
      ? `→ @${target}${desc ? ": " + head(desc, 50) : ""}`
      : st.title || summarizeInput(st.input) || (prev?.callId === key ? prev.title : "");
    const changed = !prev || prev.callId !== key || prev.state !== state;
    e.agent.tool = { name, title: head(String(title), 80), state, callId: key, at: this.clock() };
    if (state !== "pending" && this.markSeen(e, "t:" + key)) {
      this.log(e, "tool", `${name}${title ? " · " + head(String(title), 120) : ""}`, ops);
    }
    if (state === "error" && this.markSeen(e, "e:" + key)) {
      this.log(e, "error", `${name}: ${head(String(st.error ?? "error"), 160)}`, ops);
    }
    this.emit(e, ops, !changed);
  }

  private onTodos(p: any, ops: Op[]) {
    if (!p.sessionID) return;
    const e = this.ensure(p.sessionID, ops);
    const todos = Array.isArray(p.todos) ? p.todos : [];
    e.agent.todos = todos.map((t: any) => ({
      content: String(t.content ?? ""),
      status: String(t.status ?? "pending"),
      priority: t.priority ? String(t.priority) : undefined,
    }));
    const done = e.agent.todos.filter((t) => t.status === "completed").length;
    const summary = `${done}/${e.agent.todos.length}`;
    if (summary !== e.todoSummary) {
      e.todoSummary = summary;
      this.log(e, "todo", `todos ${summary} done`, ops);
    }
    this.emit(e, ops);
  }

  // ---- helpers ----

  private markSeen(e: Entry, key: string): boolean {
    if (e.seen.has(key)) return false;
    e.seen.add(key);
    if (e.seen.size > MAX_SEEN) e.seen.delete(e.seen.values().next().value!);
    return true;
  }

  private log(e: Entry, kind: FeedKind, text: string, ops: Op[]) {
    this.changed.add(e);
    const entry: FeedEntry = { ts: this.clock(), kind, text };
    e.feed.push(entry);
    if (e.feed.length > FEED_MAX) e.feed.splice(0, e.feed.length - FEED_MAX);
    ops.push({ op: "feed", id: e.agent.id, entry });
  }

  private emit(e: Entry, ops: Op[], soft = false) {
    this.changed.add(e);
    e.historyDirty = true;
    if (!soft) e.historyUrgent = true;
    const now = this.clock();
    e.agent.updatedAt = now;
    if (soft && now - e.lastEmit < EMIT_EVERY) {
      e.dirty = true;
      return;
    }
    e.dirty = false;
    e.lastEmit = now;
    if (!e.archived) ops.push({ op: "agent", agent: { ...e.agent } });
    const room = this.rooms.get(e.agent.roomId);
    if (room && now - room.updatedAt > ROOM_TOUCH_EVERY) {
      room.updatedAt = now;
      ops.push({ op: "room", room: { ...room } });
    }
  }

  private touch(e: Entry) {
    e.agent.lastActivityAt = this.clock();
    e.historyDirty = true;
    this.changed.add(e);
  }

  private recordActivity(e: Entry): boolean {
    const a = e.agent;
    const completed = a.status === "done" || (a.status === "error" && a.completedAt !== undefined);
    const state: ActivityState | undefined = completed ? undefined : a.waiting ? "waiting"
      : a.status === "busy" ? "working" : a.status === "retry" ? "retrying" : a.status === "error" ? "failed" : "idle";
    const previous = e.intervals.at(-1);
    const current = previous?.end === undefined ? previous : undefined;
    if (current?.state === state) return false;
    const now = this.clock();
    if (current) {
      current.end = now;
      if (current.start === now) e.intervals.pop();
    }
    if (state) e.intervals.push({ state, start: now });
    e.historyDirty = true;
    return true;
  }

  private activityRecord(e: Entry): ActivityRecord {
    return structuredClone({
      agent: { ...e.agent, feed: e.feed.slice(-SNAPSHOT_FEED) },
      firstObservedAt: e.firstObservedAt,
      intervals: e.intervals,
      archived: e.archived,
      truncated: e.truncated,
    });
  }

  private emitHistory(e: Entry, ops: Op[], force = false) {
    if (!force && !e.historyUrgent && this.clock() - e.historyLastEmit < EMIT_EVERY) return;
    ops.push({ op: "history", record: this.activityRecord(e) });
    e.historyDirty = false;
    e.historyUrgent = false;
    e.historyLastEmit = this.clock();
  }

  private pruneHistory(now: number, ops: Op[]) {
    const cutoff = now - HISTORY_TTL;
    const changed = new Set<Entry>();
    const truncated = () => {
      if (!this.historyTruncated) ops.push({ op: "history-truncated" });
      this.historyTruncated = true;
    };
    const remove = (e: Entry) => {
      this.entries.delete(e.agent.id);
      ops.push({ op: "history-remove", id: e.agent.id });
      truncated();
    };
    for (const e of this.entries.values()) {
      if (e.archived && (e.agent.doneAt ?? e.agent.lastActivityAt) <= cutoff) {
        remove(e);
        continue;
      }
      if (e.agent.failure && e.agent.completedAt !== undefined && e.agent.completedAt <= cutoff) {
        e.agent.failure = undefined;
        changed.add(e);
        if (!e.archived) ops.push({ op: "agent", agent: { ...e.agent } });
      }
      const kept = e.intervals.filter((i) => i.end === undefined || i.end > cutoff);
      if (kept.length !== e.intervals.length) {
        e.intervals = kept;
        e.truncated = true;
        changed.add(e);
        truncated();
      }
      for (const i of kept) if (i.end !== undefined && i.start < cutoff) {
        i.start = cutoff;
        e.truncated = true;
        changed.add(e);
        truncated();
      }
    }
    const archived = [...this.entries.values()].filter((e) => e.archived)
      .sort((a, b) => (a.agent.doneAt ?? 0) - (b.agent.doneAt ?? 0));
    for (const e of archived.slice(0, Math.max(0, archived.length - MAX_ARCHIVED))) remove(e);
    const closed = [...this.entries.values()].flatMap((e) => e.intervals.filter((i) => i.end !== undefined).map((i) => ({ e, i })))
      .sort((a, b) => a.i.end! - b.i.end!);
    const dropped = new Set(closed.slice(0, Math.max(0, closed.length - MAX_CLOSED_INTERVALS)).map(({ e, i }) => {
      e.truncated = true;
      changed.add(e);
      truncated();
      return i;
    }));
    for (const e of changed) if (this.entries.has(e.agent.id)) {
      e.intervals = e.intervals.filter((i) => !dropped.has(i));
      this.emitHistory(e, ops, true);
    }
  }
}
