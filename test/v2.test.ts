import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { toolEvent, V2Mapper } from "../src/v2.ts";

function run(events: Record<string, unknown>[]) {
  const store = new Store();
  const mapper = new V2Mapper();
  for (const ev of events) for (const m of mapper.map(ev)) store.apply(m);
  return store;
}

test("v2 session lifecycle maps onto rooms, subagents and done state", () => {
  const store = run([
    { type: "session.created", data: { sessionID: "root", title: "Main", location: { directory: "C:/x" } } },
    { type: "session.agent.selected", data: { sessionID: "root", agent: "orchestrator" } },
    { type: "session.execution.started", data: { sessionID: "root" } },
    { type: "session.created", data: { sessionID: "kid", parentID: "root", agent: "explorer", title: "Find" } },
    { type: "session.execution.started", data: { sessionID: "kid" } },
  ]);
  assert.equal(store.rooms.get("root")?.directory, "C:/x");
  assert.equal(store.agent("root")?.status, "busy");
  assert.equal(store.agent("kid")?.roomId, "root");
  assert.equal(store.agent("kid")?.name, "explorer");
  assert.equal(store.agent("kid")?.status, "busy");

  const mapper = new V2Mapper();
  for (const m of mapper.map({ type: "session.execution.succeeded", data: { sessionID: "kid" } })) store.apply(m);
  assert.equal(store.agent("kid")?.status, "done");
});

test("v2 streamed text accumulates into a snippet; ended text wins", () => {
  const m = { sessionID: "s", assistantMessageID: "msg1", ordinal: 0 };
  const store = run([
    { type: "session.created", data: { sessionID: "s" } },
    { type: "session.text.started", data: m },
    { type: "session.text.delta", data: { ...m, delta: "Hallo " } },
    { type: "session.text.delta", data: { ...m, delta: "Welt" } },
  ]);
  assert.equal(store.agent("s")?.snippet?.text, "Hallo Welt");
  const store2 = run([
    { type: "session.created", data: { sessionID: "s" } },
    { type: "session.reasoning.started", data: m },
    { type: "session.reasoning.ended", data: { ...m, text: "Plan: erst lesen" } },
  ]);
  assert.equal(store2.agent("s")?.snippet?.kind, "think");
  assert.equal(store2.agent("s")?.snippet?.text, "Plan: erst lesen");
});

test("v2 usage.updated is a cumulative total; step.started names the agent; interrupted is not an error", () => {
  const tokens = (input: number) => ({ input, output: 10, reasoning: 0, cache: { read: 999, write: 0 } });
  const store = run([
    { type: "session.created", data: { sessionID: "s" } },
    { type: "session.step.started", data: { sessionID: "s", agent: "oracle", model: { id: "glm" } } },
    { type: "session.usage.updated", data: { sessionID: "s", cost: 0.5, tokens: tokens(100) } },
    { type: "session.step.ended", data: { sessionID: "s", tokens: tokens(100) } },
    { type: "session.usage.updated", data: { sessionID: "s", cost: 0.7, tokens: tokens(300) } },
    { type: "session.execution.started", data: { sessionID: "s" } },
    { type: "session.execution.interrupted", data: { sessionID: "s" } },
  ]);
  assert.equal(store.agent("s")?.name, "oracle");
  assert.equal(store.agent("s")?.tokens, 310);
  assert.equal(store.agent("s")?.cost, 0.7);
  assert.equal(store.agent("s")?.status, "idle");
});

test("v2 session.tool.* lifecycle keeps name and title", () => {
  const base = { sessionID: "s", assistantMessageID: "m", id: "call1" };
  const store = run([
    { type: "session.created", data: { sessionID: "s" } },
    { type: "session.tool.input.started", data: { ...base, name: "read" } },
    { type: "session.tool.called", data: { ...base, input: { filePath: "C:/x/src/app.ts" } } },
  ]);
  assert.equal(store.agent("s")?.tool?.name, "read");
  assert.equal(store.agent("s")?.tool?.state, "running");
  assert.equal(store.agent("s")?.tool?.title, "app.ts");
  const mapper = new V2Mapper();
  for (const ev of [
    { type: "session.tool.input.started", data: { ...base, name: "read" } },
    { type: "session.tool.success", data: { ...base, content: [] } },
  ]) for (const m of mapper.map(ev)) store.apply(m);
  assert.equal(store.agent("s")?.tool?.state, "completed");
  assert.equal(store.agent("s")?.tool?.title, "app.ts");
});

test("v2 form.created (question) marks the session as waiting until replied", () => {
  const form = { id: "frm1", sessionID: "s", title: "Questions", fields: [{ key: "q0", title: "Symptom" }] };
  const store = run([
    { type: "session.created", data: { sessionID: "s" } },
    { type: "form.created", data: { form } },
  ]);
  assert.equal(store.agent("s")?.waiting, true);
  const mapper = new V2Mapper();
  for (const m of mapper.map({ type: "form.replied", data: { id: "frm1", sessionID: "s", answer: {} } })) store.apply(m);
  assert.equal(store.agent("s")?.waiting, false);
});

test("tool hooks become tool parts; subagent counts as delegation", () => {
  const store = new Store();
  store.apply({ type: "session.created", properties: { info: { id: "s" } } });
  store.apply(toolEvent({ tool: "subagent", sessionID: "s", id: "c1", input: { agent: "fixer", description: "Fix it" } }, "before")!);
  assert.equal(store.agent("s")?.tool?.state, "running");
  assert.match(store.agent("s")!.tool!.title, /@fixer/);
  store.apply(toolEvent({ tool: "bash", sessionID: "s", id: "c2", input: { command: "ls" }, status: "error", error: { message: "boom" } }, "after")!);
  assert.equal(store.agent("s")?.tool?.state, "error");
  assert.equal(toolEvent({}, "before"), undefined);
});
