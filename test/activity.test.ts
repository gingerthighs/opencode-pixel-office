import { test } from "node:test";
import assert from "node:assert/strict";
import { DONE_TTL, HISTORY_TTL, MAX_ARCHIVED, MAX_CLOSED_INTERVALS, Store } from "../src/store.ts";
import { V2Mapper } from "../src/v2.ts";
import { ClientState } from "../web/state.ts";
import { activityTotals, attentionItems, clipIntervals, focusActivity, INACTIVE_AFTER } from "../web/activity.ts";

function fixture() {
  let now = 10_000_000;
  const store = new Store(() => now);
  const client = new ClientState();
  const event = (type: string, properties: unknown) => {
    const ops = store.apply({ type, properties });
    client.apply(ops);
    return ops;
  };
  const create = (id: string, parentID?: string, time?: object) => event("session.created", { info: { id, parentID, time } });
  const status = (id: string, type: string) => event("session.status", { sessionID: id, status: { type } });
  const advance = (ms: number) => { now += ms; };
  const tick = () => { const ops = store.tick(); client.apply(ops); return ops; };
  const record = (id: string) => store.snapshot().history.find((r) => r.agent.id === id)!;
  return { store, client, event, create, status, advance, tick, record, now: () => now };
}

test("observed work/wait/retry intervals close on completion and resume without invented history", () => {
  const f = fixture();
  f.create("root"); f.create("child", "root", { created: 1, updated: 1 });
  const start = f.now(); f.status("child", "busy");
  f.advance(1000); f.event("permission.asked", { sessionID: "child", id: "p", permission: "bash" });
  f.advance(2000); f.event("permission.replied", { sessionID: "child", requestID: "p" });
  f.advance(1000); f.status("child", "retry");
  f.advance(1000); f.status("child", "busy");
  f.advance(2000); f.status("child", "idle");
  const record = f.record("child");
  assert.equal(record.firstObservedAt, start);
  assert.deepEqual(record.intervals, [
    { state: "working", start, end: start + 1000 },
    { state: "waiting", start: start + 1000, end: start + 3000 },
    { state: "working", start: start + 3000, end: start + 4000 },
    { state: "retrying", start: start + 4000, end: start + 5000 },
    { state: "working", start: start + 5000, end: start + 7000 },
  ]);
  assert.deepEqual(activityTotals(record.intervals, start, f.now()), { working: 4000, waiting: 2000 });
  assert.equal(record.agent.outcome, "completed");
  f.advance(500); f.status("child", "idle");
  assert.deepEqual(f.record("child").intervals, record.intervals, "duplicate completion does not extend bars");
  f.advance(DONE_TTL); f.tick();
  assert.equal(f.store.has("child"), false);
  assert.equal(f.record("child").archived, true);
  f.status("child", "busy");
  assert.equal(f.record("child").archived, false);
  assert.equal(f.record("child").agent.outcome, undefined);
  assert.deepEqual(f.record("child").intervals.at(-1), { state: "working", start: f.now() });
});

test("idle time is distinct; repeated states and timer flushes do not fabricate activity", () => {
  const f = fixture(); f.create("root"); const start = f.now();
  f.advance(1000); f.status("root", "busy");
  f.advance(100); f.status("root", "busy");
  assert.equal(f.record("root").intervals.length, 2);
  const lastActivity = f.record("root").agent.lastActivityAt;
  f.advance(1000); f.tick();
  assert.equal(f.record("root").agent.lastActivityAt, lastActivity);
  f.status("root", "idle");
  assert.deepEqual(f.record("root").intervals[0], { state: "idle", start, end: start + 1000 });
  assert.equal(f.record("root").intervals.at(-1)?.state, "idle");
});

test("failed v2 completion survives pruning; next execution clears failure", () => {
  const f = fixture(); f.create("root"); f.create("child", "root"); f.status("child", "busy");
  f.advance(1000);
  for (const ev of new V2Mapper().map({ type: "session.execution.failed", data: { sessionID: "child", error: { message: "build failed" } } })) {
    f.client.apply(f.store.apply(ev));
  }
  const failure = f.record("child").agent.failure;
  assert.equal(failure?.message, "build failed");
  assert.equal(f.record("child").agent.status, "done");
  assert.equal(f.record("child").agent.outcome, "failed");
  f.advance(DONE_TTL + 1); f.tick();
  assert.equal(f.record("child").archived, true);
  assert.equal(attentionItems(f.client)[0].kind, "failure");
  f.status("child", "busy");
  assert.equal(f.record("child").agent.failure, undefined);
  assert.equal(attentionItems(f.client).length, 0);
});

test("reload/reconnect restores retained history and feeds; fresh server starts empty", () => {
  const f = fixture(); f.create("root"); f.create("child", "root"); f.status("child", "busy");
  f.advance(1000); f.event("session.error", { sessionID: "child", error: { message: "failed" } });
  f.status("child", "idle"); f.advance(DONE_TTL + 1); f.tick();
  const snapshot = f.store.snapshot();
  const reconnect = new ClientState(); reconnect.load(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual([...reconnect.history.values()], JSON.parse(JSON.stringify(snapshot.history)));
  assert.equal(reconnect.agents.has("child"), false);
  assert.ok(reconnect.detailAgent("child"));
  assert.ok(reconnect.history.get("child")?.agent.feed.some((entry) => entry.text === "failed"));
  reconnect.load(new Store().snapshot());
  assert.equal(reconnect.history.size, 0);
  snapshot.history[0].intervals[0].start = 0;
  assert.notEqual(f.store.snapshot().history[0].intervals[0].start, 0, "snapshot mutations cannot alter server history");
});

test("failed root completion closes its interval and expires attention without removing live identity", () => {
  const f = fixture(); f.create("root"); f.status("root", "busy");
  f.advance(1000); f.event("session.error", { sessionID: "root", error: { message: "failed" } });
  f.advance(1000); f.status("root", "idle");
  const completed = f.now();
  assert.equal(f.record("root").agent.status, "error");
  assert.deepEqual(f.record("root").intervals.at(-1), { state: "failed", start: completed - 1000, end: completed });
  f.advance(1000); f.status("root", "idle");
  assert.equal(f.record("root").agent.completedAt, completed);
  assert.equal(attentionItems(f.client)[0]?.kind, "failure");
  f.advance(HISTORY_TTL); f.tick();
  assert.equal(attentionItems(f.client).length, 0);
  assert.equal(f.store.has("root"), true);
  assert.equal(f.record("root").agent.outcome, "failed");
  f.status("root", "busy");
  assert.deepEqual(f.record("root").intervals.at(-1), { state: "working", start: f.now() });
});

test("late parent links rehome archived descendants without resurrecting canvas agents", () => {
  const f = fixture(); f.create("parent"); f.create("child", "parent"); f.status("child", "busy");
  f.advance(1000); f.status("child", "idle"); f.advance(DONE_TTL + 1); f.tick();
  f.create("root"); f.event("session.updated", { info: { id: "parent", parentID: "root" } });
  assert.equal(f.record("child").agent.roomId, "root");
  assert.equal(f.client.history.get("child")?.agent.roomId, "root");
  assert.equal(f.client.agents.has("child"), false);
  f.event("session.updated", { info: { id: "child", title: "Updated archived title" } });
  assert.equal(f.record("child").agent.title, "Updated archived title");
  assert.equal(f.client.agents.has("child"), false);
  f.event("session.deleted", { info: { id: "root" } });
  assert.equal(f.store.snapshot().history.length, 0);
  assert.equal(f.client.history.size, 0);
});

test("explicit deletion removes one archived session without deleting its siblings", () => {
  const f = fixture(); f.create("root");
  for (const id of ["a", "b"]) { f.create(id, "root"); f.status(id, "idle"); }
  f.advance(DONE_TTL + 1); f.tick();
  f.event("session.deleted", { info: { id: "a" } });
  assert.equal(f.client.history.has("a"), false);
  assert.equal(f.client.history.has("b"), true);
});

test("two-hour retention expires archived failures and old intervals but preserves live state", () => {
  const f = fixture(); f.create("root"); f.create("child", "root");
  f.advance(1000); f.status("root", "busy");
  f.event("session.error", { sessionID: "child", error: { message: "failed" } }); f.status("child", "idle");
  f.advance(HISTORY_TTL + 1); f.tick();
  assert.equal(f.store.has("root"), true);
  assert.equal(f.record("child"), undefined);
  assert.equal(f.client.history.has("child"), false);
  assert.deepEqual(f.record("root").intervals.map((i) => i.state), ["working"]);
  assert.equal(f.record("root").truncated, true);
  assert.equal(f.client.historyTruncated, true);
});

test("archive cap evicts oldest sessions and preserves live sessions", () => {
  const f = fixture(); f.create("root");
  for (let i = 0; i <= MAX_ARCHIVED; i++) {
    f.create(`child-${i}`, "root"); f.status(`child-${i}`, "busy");
    f.advance(1); f.status(`child-${i}`, "idle");
  }
  f.advance(DONE_TTL + 1); f.tick();
  assert.equal(f.store.snapshot().history.filter((r) => r.archived).length, MAX_ARCHIVED);
  assert.equal(f.record("child-0"), undefined);
  assert.ok(f.record(`child-${MAX_ARCHIVED}`));
  assert.ok(f.store.agent("root"));
});

test("closed interval cap evicts oldest segments while retaining current intervals", () => {
  const f = fixture();
  for (let agent = 0; agent < 101; agent++) {
    const id = `root-${agent}`; f.create(id);
    for (let transition = 0; transition < 100; transition++) {
      f.advance(1); f.status(id, transition % 2 ? "idle" : "busy");
    }
  }
  f.tick();
  const records = f.store.snapshot().history;
  assert.equal(records.flatMap((r) => r.intervals).filter((i) => i.end !== undefined).length, MAX_CLOSED_INTERVALS);
  assert.equal(records.flatMap((r) => r.intervals).filter((i) => i.end === undefined).length, 101);
  assert.equal(f.record("root-0").truncated, true);
  assert.equal(f.record("root-100").truncated, false);
});

test("window clipping and totals count only visible positive intervals", () => {
  const intervals = [
    { state: "working" as const, start: 0, end: 20 },
    { state: "waiting" as const, start: 20, end: 40 },
    { state: "working" as const, start: 40 },
  ];
  assert.deepEqual(clipIntervals(intervals, 10, 50), [
    { state: "working", start: 10, end: 20 }, { state: "waiting", start: 20, end: 40 }, { state: "working", start: 40, end: 50 },
  ]);
  assert.deepEqual(activityTotals(intervals, 10, 50), { working: 20, waiting: 20 });
  assert.deepEqual(clipIntervals([{ state: "idle", start: 1, end: 1 }], 0, 10), []);
});

test("attention ranks requests, failures, inactivity; replies, execution, and incoming activity resolve entries", () => {
  const f = fixture();
  for (const id of ["approval", "question", "failed", "quiet"]) { f.create(id); f.status(id, "busy"); }
  f.event("session.error", { sessionID: "failed", error: { message: "failed" } });
  f.advance(1000); f.event("question.asked", { sessionID: "question", id: "q", title: "Which option?" });
  f.advance(1000); f.event("permission.asked", { sessionID: "approval", id: "p", permission: "bash" });
  f.client.serverNow = () => f.now(); f.client.setConnected(true);
  f.advance(INACTIVE_AFTER);
  assert.deepEqual(attentionItems(f.client).map((i) => i.kind), ["question", "approval", "failure", "inactive"]);
  const waitingSince = f.record("approval").agent.waitingSince;
  f.event("permission.asked", { sessionID: "approval", id: "p", permission: "bash" });
  assert.equal(f.record("approval").agent.waitingSince, waitingSince);
  f.event("permission.replied", { sessionID: "approval", requestID: "p" });
  f.event("question.replied", { sessionID: "question", requestID: "q" });
  f.status("failed", "busy");
  f.event("message.part.updated", { part: { id: "part", sessionID: "quiet", type: "text", text: "Still working" } });
  f.advance(250); f.tick();
  assert.deepEqual(attentionItems(f.client), []);
});

test("disconnect freezes existing inactivity entries without escalating new ones", () => {
  const f = fixture(); f.create("old"); f.status("old", "busy");
  f.advance(INACTIVE_AFTER); f.create("new"); f.status("new", "busy");
  f.client.serverNow = () => f.now(); f.client.setConnected(true);
  assert.deepEqual(attentionItems(f.client).map((i) => i.record.agent.id), ["old"]);
  f.client.setConnected(false); f.advance(INACTIVE_AFTER * 2);
  assert.deepEqual(attentionItems(f.client).map((i) => i.record.agent.id), ["old"]);
  f.client.setConnected(true);
  assert.deepEqual(attentionItems(f.client).map((i) => i.record.agent.id), ["old", "new"]);
});

test("focus navigation selects archived agents across rooms after disabling Follow", () => {
  const f = fixture(); f.create("root"); f.create("child", "root"); f.status("child", "idle");
  f.advance(DONE_TTL + 1); f.tick();
  let follow = true, room = "another", selected: string | undefined;
  focusActivity(f.client, "child", (id) => { room = id; follow = false; selected = undefined; }, (id) => { selected = id; });
  assert.equal(room, "root"); assert.equal(follow, false); assert.equal(selected, "child");
  assert.equal(f.client.hasSelection("child"), true); assert.equal(f.client.agents.has("child"), false);
});
