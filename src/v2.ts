// opencode 2.x plugin host: `setup(ctx)` with an event stream and tool hooks instead of v1 hooks.
// v2 events are translated into the v1-shaped events the Store already understands.

import { appendFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BusEvent } from "./store.ts";

type Rec = Record<string, any>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function payloadOf(ev: Rec): Rec {
  if (isRec(ev.data)) return ev.data;
  if (isRec(ev.properties)) return ev.properties;
  return {};
}

function sessionInfo(p: Rec): Rec | undefined {
  const id = str(p.sessionID) ?? str(p.id);
  if (!id) return;
  return {
    id,
    parentID: str(p.parentID),
    title: str(p.title),
    agent: str(p.agent),
    directory: str(p.directory) ?? str(p.location?.directory),
    time: isRec(p.time) ? p.time : undefined,
  };
}

/** Stateful translator: v2 streams text as started/delta/ended, the Store wants whole parts. */
export class V2Mapper {
  private streams = new Map<string, { id: string; text: string }>();
  private toolNames = new Map<string, string>();
  private seq = 0;

  private remember(id: string, name: string) {
    this.toolNames.set(id, name);
    if (this.toolNames.size > 2000) this.toolNames.delete(this.toolNames.keys().next().value!);
  }

  private toolPart(sid: string, id: string, name: string, state: Rec): BusEvent {
    const tool = name.toLowerCase() === "subagent" ? "task" : name;
    return { type: "message.part.updated", properties: { part: { id, callID: id, sessionID: sid, messageID: "v2", type: "tool", tool, state } } };
  }

  map(ev: Rec): BusEvent[] {
    const type = str(ev.type) ?? "";
    const p = payloadOf(ev);
    // form.* events nest the session under data.form
    const sid = str(p.sessionID) ?? str(p.form?.sessionID);
    const out: BusEvent[] = [];

    switch (type) {
      case "session.created":
      case "session.updated": {
        const info = sessionInfo(p);
        if (info) out.push({ type, properties: { info } });
        return out;
      }
      case "session.deleted":
        if (sid) out.push({ type, properties: { info: { id: sid } } });
        return out;
      case "session.execution.started":
        if (sid) out.push({ type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } });
        return out;
      case "session.execution.failed":
        if (sid) out.push({ type: "session.error", properties: { sessionID: sid, error: p.error ?? { message: "Ausführung fehlgeschlagen" } } });
        if (sid) out.push({ type: "session.idle", properties: { sessionID: sid } });
        return out;
      case "session.execution.interrupted":
        if (sid) out.push({ type: "session.error", properties: { sessionID: sid, error: { name: "MessageAbortedError" } } });
        return out;
      case "session.execution.succeeded":
        if (sid) out.push({ type: "session.idle", properties: { sessionID: sid } });
        return out;
      case "session.agent.selected":
      case "session.step.started":
        // agent (+ model) of the session; role "user" so it never counts tokens
        if (sid && str(p.agent)) {
          out.push({ type: "message.updated", properties: { info: { id: `v2-agent:${sid}`, sessionID: sid, role: "user", agent: p.agent } } });
        }
        return out;
      case "session.usage.updated": {
        // cumulative session totals → one fixed message id so the store replaces instead of summing
        const t = isRec(p.tokens) ? p.tokens : undefined;
        if (!sid || !t) return out;
        out.push({
          type: "message.updated",
          properties: {
            info: {
              id: `v2-usage:${sid}`,
              sessionID: sid,
              role: "assistant",
              modelID: str(p.model?.id),
              cost: num(p.cost) ?? 0,
              tokens: { input: num(t.input) ?? 0, output: num(t.output) ?? 0, reasoning: num(t.reasoning) ?? 0 },
            },
          },
        });
        return out;
      }
      case "session.tool.input.started": {
        const id = str(p.id);
        if (!sid || !id) return out;
        const name = str(p.name) ?? "tool";
        this.remember(id, name);
        out.push(this.toolPart(sid, id, name, { status: "pending", input: {} }));
        return out;
      }
      case "session.tool.called": {
        const id = str(p.id);
        if (!sid || !id) return out;
        const name = str(p.name) ?? this.toolNames.get(id) ?? "tool";
        out.push(this.toolPart(sid, id, name, { status: "running", input: isRec(p.input) ? p.input : {} }));
        return out;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const id = str(p.id);
        if (!sid || !id) return out;
        const name = str(p.name) ?? this.toolNames.get(id) ?? "tool";
        const state =
          type === "session.tool.failed"
            ? { status: "error", input: {}, error: str(p.error?.message) ?? str(p.error) ?? "Fehler" }
            : { status: "completed", input: {}, title: str(p.metadata?.title) ?? "" };
        out.push(this.toolPart(sid, id, name, state));
        return out;
      }
      case "permission.asked":
        if (sid) {
          out.push({
            type,
            properties: {
              sessionID: sid,
              id: str(p.id) ?? str(p.requestID),
              permission: str(p.permission) ?? str(p.action) ?? str(p.title),
              patterns: Array.isArray(p.patterns) ? p.patterns : Array.isArray(p.resources) ? p.resources : str(p.resource) ? [p.resource] : undefined,
            },
          });
        }
        return out;
      case "permission.replied":
        if (sid) out.push({ type, properties: { sessionID: sid } });
        return out;
      case "form.created":
        if (sid && sid !== "global") {
          const field = p.form?.fields?.[0];
          const title = str(field?.description) ?? str(field?.title) ?? str(p.form?.title) ?? str(p.title) ?? "Frage";
          const options = Array.isArray(field?.options) ? field.options.map((o: any) => str(o?.label) ?? str(o?.value) ?? String(o)) : undefined;
          out.push({ type: "question.asked", properties: { sessionID: sid, id: str(p.form?.id) ?? str(p.id), title, options } });
        }
        return out;
      case "form.replied":
      case "form.cancelled":
        if (sid && sid !== "global") out.push({ type: "question.replied", properties: { sessionID: sid } });
        return out;
    }

    // streamed assistant text / reasoning
    const m = type.match(/^session\.(?:next\.)?(text|reasoning)\.(started|delta|ended)$/);
    if (m && sid) {
      const kind = m[1] === "text" ? "text" : "reasoning";
      const key = `${sid}:${kind}:${str(p.assistantMessageID) ?? ""}:${p.ordinal ?? str(p.partID) ?? ""}`;
      let s = this.streams.get(key);
      if (!s || m[2] === "started") {
        s = { id: `v2-${kind}-${++this.seq}`, text: "" };
        this.streams.set(key, s);
      }
      const chunk = str(p.delta) ?? (m[2] === "delta" ? str(p.text) : undefined);
      if (chunk) s.text += chunk;
      if (m[2] === "ended" && str(p.text)) s.text = p.text;
      const ended = m[2] === "ended";
      if (ended) this.streams.delete(key);
      if (s.text) {
        out.push({
          type: "message.part.updated",
          properties: { part: { id: s.id, sessionID: sid, messageID: "v2", type: kind, text: s.text, time: ended ? { start: 0, end: Date.now() } : { start: 0 } } },
        });
      }
      return out;
    }

    // todo lists (exact v2 name unknown → match loosely)
    if (/todo/i.test(type) && sid && Array.isArray(p.todos)) {
      out.push({ type: "todo.updated", properties: { sessionID: sid, todos: p.todos } });
      return out;
    }

    // anything already v1-shaped passes through
    if (isRec(ev.properties)) out.push({ type, properties: ev.properties });
    return out;
  }
}

/** tool.hook("execute.before" | "execute.after") event → v1 tool part */
export function toolEvent(e: Rec, phase: "before" | "after"): BusEvent | undefined {
  const sid = str(e?.sessionID);
  const tool = str(e?.tool);
  if (!sid || !tool) return;
  const id = str(e.id) ?? str(e.callID) ?? `${tool}-${Date.now()}`;
  const name = tool.toLowerCase() === "subagent" ? "task" : tool;
  const input = isRec(e.input) ? e.input : {};
  let state: Rec;
  if (phase === "before") state = { status: "running", input };
  else if (e.status === "error") state = { status: "error", input, error: str(e.error?.message) ?? str(e.error) ?? "Fehler" };
  else state = { status: "completed", input, title: str(e.result?.metadata?.title) ?? "" };
  return { type: "message.part.updated", properties: { part: { id, callID: id, sessionID: sid, messageID: "v2", type: "tool", tool: name, state } } };
}

// ---- discovery log: first samples of every event type, strings shortened (no full prompts) ----

const MAX_PER_TYPE = 2;
const sampled = new Map<string, number>();
let samplePath: string | undefined;

function shrink(v: unknown, d = 0): unknown {
  if (typeof v === "string") return v.length > 40 ? v.slice(0, 40) + "…" : v;
  if (Array.isArray(v)) return v.length ? [shrink(v[0], d + 1), ...(v.length > 1 ? [`+${v.length - 1}`] : [])] : [];
  if (isRec(v)) return d > 5 ? "{…}" : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x, d + 1)]));
  return v;
}

export function sample(kind: string, ev: unknown) {
  const n = sampled.get(kind) ?? 0;
  if (n >= MAX_PER_TYPE || sampled.size > 300) return;
  sampled.set(kind, n + 1);
  void (async () => {
    try {
      if (!samplePath) {
        const dir = join(homedir(), ".local", "share", "opencode", "log");
        await mkdir(dir, { recursive: true }).catch(() => {});
        samplePath = join(dir, "pixel-office-events.jsonl");
      }
      await appendFile(samplePath, JSON.stringify({ kind, ev: shrink(ev) }) + "\n");
    } catch {
      samplePath = join(tmpdir(), "pixel-office-events.jsonl");
    }
  })();
}
