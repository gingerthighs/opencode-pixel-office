import { test } from "node:test";
import assert from "node:assert/strict";
import { DONE_TTL, Store, delegationTarget, nameFromTitle } from "../src/store.ts";
import type { Op } from "../src/types.ts";

function setup() {
  let now = 1_000_000;
  const store = new Store(() => now);
  const ops: Op[] = [];
  const ev = (type: string, properties: unknown) => {
    const out = store.apply({ type, properties });
    ops.push(...out);
    return out;
  };
  return { store, ops, ev, advance: (ms: number) => (now += ms), tick: () => store.tick() };
}

test("root session becomes a room with an orchestrator", () => {
  const { store, ev } = setup();
  ev("session.created", { info: { id: "root", title: "Fix auth", directory: "/srv/app" } });
  assert.equal(store.rooms.get("root")?.title, "Fix auth");
  assert.equal(store.agent("root")?.name, "orchestrator");
  assert.equal(store.agent("root")?.roomId, "root");
});

test("child session joins parent room, emits delegate, finishes as done and is pruned", () => {
  const { store, ev, advance, tick } = setup();
  ev("session.created", { info: { id: "root", title: "Fix auth" } });
  const out = ev("session.created", { info: { id: "c1", parentID: "root", agent: "explorer", title: "Find auth (@explorer subagent)" } });
  assert.ok(out.some((o) => o.op === "delegate" && o.from === "root" && o.to === "c1" && o.label === "explorer"));
  const c = store.agent("c1")!;
  assert.equal(c.roomId, "root");
  assert.equal(c.name, "explorer");

  ev("session.status", { sessionID: "c1", status: { type: "busy" } });
  assert.equal(store.agent("c1")?.status, "busy");
  ev("session.idle", { sessionID: "c1" });
  assert.equal(store.agent("c1")?.status, "done");

  advance(DONE_TTL + 1);
  const pruned = tick();
  assert.ok(pruned.some((o) => o.op === "agent-remove" && o.id === "c1"));
  assert.equal(store.has("c1"), false);
});

test("root idle stays idle, error sticks until busy", () => {
  const { store, ev } = setup();
  ev("session.created", { info: { id: "root" } });
  ev("session.status", { sessionID: "root", status: { type: "busy" } });
  ev("session.idle", { sessionID: "root" });
  assert.equal(store.agent("root")?.status, "idle");
  ev("session.error", { sessionID: "root", error: { name: "APIError", data: { message: "rate limited" } } });
  assert.equal(store.agent("root")?.status, "error");
  ev("session.idle", { sessionID: "root" });
  assert.equal(store.agent("root")?.status, "error");
  ev("session.status", { sessionID: "root", status: { type: "busy" } });
  assert.equal(store.agent("root")?.status, "busy");
});

test("tool parts set current tool, log once, and show delegation target", () => {
  const { store, ev, ops } = setup();
  ev("session.created", { info: { id: "root" } });
  const part = (status: string, extra: object = {}) => ({
    part: { id: "p1", sessionID: "root", messageID: "m1", type: "tool", tool: "task", callID: "call1", state: { status, input: { subagent_type: "librarian", description: "Look up docs" }, ...extra } },
  });
  ev("message.part.updated", part("pending"));
  ev("message.part.updated", part("running"));
  ev("message.part.updated", part("running"));
  ev("message.part.updated", part("completed", { output: "ok", title: "done" }));
  const a = store.agent("root")!;
  assert.equal(a.tool?.state, "completed");
  assert.match(a.tool!.title, /@librarian/);
  const toolLogs = ops.filter((o) => o.op === "feed" && o.entry.kind === "tool");
  assert.equal(toolLogs.length, 1);
});

test("assistant text updates snippet; user text logs a prompt", () => {
  const { store, ev, ops } = setup();
  ev("session.created", { info: { id: "c", parentID: "root" } });
  ev("message.updated", { info: { id: "u1", sessionID: "c", role: "user", agent: "fixer" } });
  ev("message.part.updated", { part: { id: "t0", sessionID: "c", messageID: "u1", type: "text", text: "Fix the bug in login.ts" } });
  ev("message.updated", { info: { id: "a1", sessionID: "c", role: "assistant", agent: "fixer", modelID: "glm", cost: 0.01, tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } } });
  ev("message.part.updated", { part: { id: "t1", sessionID: "c", messageID: "a1", type: "text", text: "Looking at login.ts now", time: { start: 1, end: 2 } } });
  const a = store.agent("c")!;
  assert.equal(a.name, "fixer");
  assert.equal(a.tokens, 150);
  assert.equal(a.snippet?.text, "Looking at login.ts now");
  assert.ok(ops.some((o) => o.op === "feed" && o.entry.kind === "prompt"));
  assert.ok(ops.some((o) => o.op === "feed" && o.entry.kind === "text"));
});

test("child seen before its parent link is folded into the real room", () => {
  const { store, ev } = setup();
  ev("message.part.updated", { part: { id: "x", sessionID: "orphan", messageID: "m", type: "text", text: "hi" } });
  assert.ok(store.rooms.has("orphan"));
  ev("session.created", { info: { id: "root", title: "Main" } });
  ev("session.updated", { info: { id: "orphan", parentID: "root", agent: "oracle" } });
  assert.equal(store.rooms.has("orphan"), false);
  assert.equal(store.agent("orphan")?.roomId, "root");
  assert.equal(store.agent("orphan")?.name, "oracle");
});

test("deleting a root removes its room and agents", () => {
  const { store, ev } = setup();
  ev("session.created", { info: { id: "root" } });
  ev("session.created", { info: { id: "c", parentID: "root" } });
  ev("session.deleted", { info: { id: "root" } });
  assert.equal(store.rooms.size, 0);
  assert.equal(store.has("c"), false);
});

test("todos, permission waiting, malformed events", () => {
  const { store, ev } = setup();
  ev("session.created", { info: { id: "root" } });
  ev("todo.updated", { sessionID: "root", todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] });
  assert.equal(store.agent("root")?.todos.length, 2);
  ev("permission.asked", { id: "p", sessionID: "root", permission: "bash" });
  assert.equal(store.agent("root")?.waiting, true);
  ev("permission.replied", { sessionID: "root", requestID: "p", reply: "once" });
  assert.equal(store.agent("root")?.waiting, false);
  assert.deepEqual(store.apply({ type: "message.part.updated", properties: null }), []);
  assert.deepEqual(store.apply({} as never), []);
});

test("helpers", () => {
  assert.equal(nameFromTitle("Find stuff (@explorer subagent)"), "explorer");
  assert.equal(nameFromTitle("plain"), undefined);
  assert.equal(delegationTarget("task", { subagent_type: "fixer" }), "fixer");
  assert.equal(delegationTarget("background_output", { task_id: "x" }), undefined);
});
