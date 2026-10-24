import { test } from "node:test";
import assert from "node:assert/strict";
import { Instance } from "../src/instance.ts";
import { Hub } from "../src/server.ts";
import type { ControlRequest } from "../src/types.ts";
import { control, http } from "./http.ts";

const assets = { html: "<head></head>", js: "" };
function instance(port = 0) {
  return new Instance({ port, host: "127.0.0.1", allowedHosts: [], debug: false }, () => {}, assets);
}
const session = (id: string) => ({ type: "session.created", properties: { info: { id, title: id } } });
const stop = (sessionID: string): ControlRequest => ({ action: "interrupt", sessionID });
const approve = (sessionID: string): ControlRequest => ({ action: "permission", sessionID, requestID: "req", decision: "once" });

test("controls use the session's controller, never the most recently registered one", async (t) => {
  const owner = instance();
  t.after(() => owner.close());
  await owner.start();
  const calls: [string, ControlRequest][] = [];
  const a = owner.addController(async (req) => { calls.push(["A", req]); });
  const b = owner.addController(async (req) => { calls.push(["B", req]); });
  a.ingest(session("a")); b.ingest(session("b"));
  assert.equal((await control(owner.port, stop("a"))).status, 200);
  assert.equal((await control(owner.port, approve("b"))).status, 200);
  assert.deepEqual(calls, [["A", stop("a")], ["B", approve("b")]]);
  a.dispose();
  assert.equal((await control(owner.port, stop("a"))).status, 502);
  assert.equal((await control(owner.port, stop("unknown"))).status, 502);
  a.ingest(session("a"));
  assert.equal((await control(owner.port, stop("a"))).status, 502, "disposed sources cannot reclaim ownership");
  assert.equal(calls.length, 2);
});

test("forwarded sessions send controls back to their owning process and propagate failures", async (t) => {
  const owner = instance();
  t.after(() => owner.close());
  await owner.start();
  const follower = instance(owner.port);
  t.after(() => follower.close());
  await follower.start();
  assert.equal(follower.serving, false);
  const local: ControlRequest[] = [], remote: ControlRequest[] = [];
  owner.addController(async (r) => { local.push(r); }).ingest(session("local"));
  const source = follower.addController(async (r) => {
    if (r.sessionID === "failed") throw new Error("host rejected control");
    remote.push(r);
  });
  source.ingest(session("remote")); source.ingest(session("failed"));
  await follower.flush();
  assert.equal((await control(owner.port, stop("remote"))).status, 200);
  assert.equal((await control(owner.port, approve("remote"))).status, 200);
  const failed = await control(owner.port, stop("failed"));
  assert.equal(failed.status, 502); assert.match(failed.body, /host rejected control/);
  assert.deepEqual(local, []);
  assert.deepEqual(remote, [stop("remote"), approve("remote")]);
  source.dispose(); await follower.flush();
  assert.equal((await control(owner.port, stop("remote"))).status, 502);
});

test("failed batches retry automatically before newer events, with no overlapping fetches", { timeout: 10_000 }, async (t) => {
  const owner = instance(); t.after(() => owner.close()); await owner.start();
  const follower = instance(owner.port); t.after(() => follower.close()); await follower.start();
  const source = follower.addController(async () => {});
  const realFetch = globalThis.fetch;
  const batches: any[][] = [];
  let rejectFirst!: (reason: Error) => void;
  let delivered!: () => void;
  const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, opts?: RequestInit) => {
    batches.push(JSON.parse(String(opts?.body)).events);
    if (batches.length === 1) return new Promise<Response>((_, reject) => { rejectFirst = reject; });
    const res = await realFetch(url, opts); delivered(); return res;
  });
  source.ingest(session("remote"));
  const first = follower.flush();
  while (!rejectFirst) await new Promise((r) => setTimeout(r, 5));
  source.ingest({ type: "session.status", properties: { sessionID: "remote", status: { type: "busy" } } });
  assert.equal(follower.flush(), first, "only one request may be in flight");
  rejectFirst(new Error("connection lost")); await first;
  await Promise.race([delivery, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("no retry")), 4000); timer.unref(); })]);
  await follower.flush();
  assert.deepEqual(batches[1].map((e) => e.type), ["session.created", "session.status"]);
  const state = JSON.parse((await http(owner.port, "/api/state")).body);
  assert.equal(state.agents[0].status, "busy");
  assert.equal(state.rooms[0].title, "remote");
});

test("failed takeover retains batches until a later successful takeover", async (t) => {
  const owner = instance(); await owner.start(); const port = owner.port;
  t.after(() => owner.close());
  const follower = instance(port); t.after(() => follower.close()); await follower.start();
  await owner.close();
  const source = follower.addController(async () => {}); source.ingest(session("saved"));
  const realNow = Date.now;
  let offset = 11_000;
  t.mock.method(Date, "now", () => realNow() + offset);
  const realListen = Hub.prototype.listen;
  let fail = true;
  t.mock.method(Hub.prototype, "listen", function(this: Hub) {
    if (fail) return Promise.reject(new Error("temporary bind failure"));
    return realListen.call(this);
  });
  await follower.flush(); assert.equal(follower.serving, false);
  offset += 11_000; fail = false;
  await follower.flush(); assert.equal(follower.serving, true);
  const state = JSON.parse((await http(port, "/api/state")).body);
  assert.equal(state.rooms[0].title, "saved");
  assert.equal((await control(port, stop("saved"))).status, 200);
});

test("closing during a failed forward cancels retry and prevents server resurrection", { timeout: 10_000 }, async (t) => {
  const owner = instance(); t.after(() => owner.close()); await owner.start();
  const follower = instance(owner.port); t.after(() => follower.close()); await follower.start();
  let started!: () => void;
  const ready = new Promise<void>((r) => { started = r; });
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, opts: RequestInit) => {
    attempts++; started();
    return new Promise<Response>((_, reject) => opts.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  follower.addController(async () => {}).ingest(session("remote"));
  const pending = follower.flush(); await ready;
  await follower.close(); await pending; await follower.start(); await follower.flush();
  assert.equal(attempts, 1); assert.equal(follower.serving, false);
});
