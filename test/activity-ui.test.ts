import { test } from "node:test";
import assert from "node:assert/strict";
import { Attention } from "../web/attention.ts";
import { Timeline } from "../web/timeline.ts";
import { Panel } from "../web/panel.ts";
import { ClientState } from "../web/state.ts";
import { DONE_TTL, Store } from "../src/store.ts";
import { descendants, Element, installDOM } from "./dom.ts";

test("timeline controls render clipped intervals and window totals, then select an archived record", (t) => {
  installDOM(t);
  let now = Date.now() - 30 * 60_000;
  const store = new Store(() => now);
  store.apply({ type: "session.created", properties: { info: { id: "child", parentID: "root", title: "Finished work" } } });
  store.apply({ type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } });
  now += 20 * 60_000;
  store.apply({ type: "permission.asked", properties: { sessionID: "child", id: "p", permission: "bash" } });
  now += 5 * 60_000;
  store.apply({ type: "session.idle", properties: { sessionID: "child" } });
  now += 5 * 60_000; store.tick();
  const state = new ClientState(); state.load(store.snapshot()); state.serverNow = () => now; state.setConnected(true);
  let selected: string | undefined;
  const root = new Element("div");
  const timeline = new Timeline(root as unknown as HTMLElement, state, () => undefined, (id) => { selected = id; });
  timeline.render("root");
  assert.equal(timeline.windowMinutes, 60);
  assert.match(root.textContent, /20m 0s work · 5m 0s wait/);
  const select = descendants(root).find((n) => n.tag === "select")!;
  assert.deepEqual(select.children.map((n) => n.value), ["15", "60", "120"]);
  select.value = "15"; select.onchange!();
  assert.match(root.textContent, /5m 0s work · 5m 0s wait/);
  const bars = descendants(root).filter((n) => n.className.startsWith("tl-bar "));
  assert.equal(bars.length, 2);
  assert.equal((bars[0].style as any).left, "0%");
  assert.ok(parseFloat((bars[0].style as any).width) < 100);
  const row = descendants(root).find((n) => n.dataset.sessionId === "child")!;
  assert.match(row.title, /archived/); row.onclick!(); assert.equal(selected, "child");
});

test("archived detail remains readable and contains no approval or stop controls", (t) => {
  const elements = installDOM(t);
  let now = Date.now(); const store = new Store(() => now);
  store.apply({ type: "session.created", properties: { info: { id: "child", parentID: "root", title: "Past task" } } });
  store.apply({ type: "permission.asked", properties: { sessionID: "child", id: "p", permission: "bash" } });
  store.apply({ type: "session.error", properties: { sessionID: "child", error: { message: "tool execution failed" } } });
  store.apply({ type: "session.idle", properties: { sessionID: "child" } });
  now += DONE_TTL + 1; store.tick();
  const state = new ClientState(); state.load(store.snapshot());
  const panel = new Panel(state, {
    selectRoom: () => {}, select: () => {}, control: async () => { assert.fail("archive is read-only"); },
    caps: () => ({ control: true }), workerName: () => undefined, personInfo: () => undefined, roster: () => [],
  });
  panel.render("root", "child");
  const detail = elements.get("detail")!;
  assert.match(detail.textContent, /Archived · failed · read-only/);
  assert.match(detail.textContent, /Past task/);
  assert.match(detail.textContent, /tool execution failed/);
  assert.equal(detail.find("Allow once"), undefined);
  assert.equal(detail.find("■ Stop"), undefined);
});

test("global attention renders ordered rows, stable selection, counts, and connection warning", (t) => {
  installDOM(t);
  let now = Date.now(); const store = new Store(() => now);
  for (const id of ["a", "b"]) store.apply({ type: "session.created", properties: { info: { id, title: `Project ${id}`, directory: `/${id}` } } });
  store.apply({ type: "session.error", properties: { sessionID: "a", error: { message: "failed" } } });
  now += 1000;
  store.apply({ type: "permission.asked", properties: { sessionID: "b", id: "p", permission: "bash" } });
  const state = new ClientState(); state.load(store.snapshot()); state.serverNow = () => now; state.setConnected(true);
  const list = new Element("div"), count = new Element("span"), warning = new Element("div");
  let selected: string | undefined;
  const attention = new Attention(state, list as unknown as HTMLElement, count as unknown as HTMLElement,
    warning as unknown as HTMLElement, (id) => { selected = id; }, () => undefined);
  attention.render();
  assert.equal(count.textContent, "2"); assert.equal(warning.hidden, true);
  assert.deepEqual(list.children.map((r) => r.dataset.sessionId), ["b", "a"]);
  const first = list.children[0]; attention.render(); assert.equal(list.children[0], first);
  first.onclick!(); assert.equal(selected, "b");
  state.setConnected(false); attention.render();
  assert.equal(warning.hidden, false); assert.match(warning.textContent, /Inactivity checks paused/);
  state.apply(store.apply({ type: "permission.replied", properties: { sessionID: "b" } }));
  attention.render(); assert.equal(count.textContent, "1");
});
