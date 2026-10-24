import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { ControlRelay, Hub, hostAllowed, hostName, INGEST_HEADER } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { http } from "./http.ts";
import type { Op, Snapshot } from "../src/types.ts";
import { ClientState } from "../web/state.ts";

test("hostName strips ports and keeps IPv6 brackets", () => {
  assert.equal(hostName("LocalHost:4777"), "localhost");
  assert.equal(hostName("[::1]:4777"), "[::1]");
  assert.equal(hostName("192.168.1.5"), "192.168.1.5");
  assert.equal(hostName(undefined), "");
});

test("without a token only loopback, IP literals and allowedHosts pass", () => {
  const open = { allowedHosts: ["box.tail1.ts.net"] };
  for (const h of ["127.0.0.1:4777", "localhost:4777", "[::1]:4777", "192.168.178.25:4777", "[fd7a::1]:4777", "box.tail1.ts.net:4777"]) {
    assert.equal(hostAllowed(h, open), true, h);
  }
  for (const h of ["evil.example:4777", "127.0.0.1.evil.example", "", undefined]) assert.equal(hostAllowed(h, open), false, String(h));
  assert.equal(hostAllowed("evil.example", { token: "t" }), true, "a token protects every host");
});

function call(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

test("server rejects rebinding hosts and header-less ingest", async () => {
  const hub = new Hub(new Store(), { port: 0, host: "127.0.0.1", html: "<html></html>", js: "" });
  await hub.listen();
  const port = (hub as unknown as { server: { address(): { port: number } } }).server.address().port;
  try {
    assert.equal(await call(port, "/api/state"), 200);
    assert.equal(await call(port, "/api/state", { headers: { host: "evil.example:1" } }), 421);
    assert.equal(await call(port, "/", { headers: { host: "evil.example:1" } }), 421);
    const body = JSON.stringify({ events: [] });
    assert.equal(await call(port, "/api/ingest", { method: "POST", headers: { "content-type": "text/plain" }, body }), 403);
    assert.equal(await call(port, "/api/ingest", { method: "POST", headers: { "content-type": "application/json", [INGEST_HEADER]: "ingest" }, body }), 204);
  } finally {
    await hub.close();
  }
});

test("relay requires its private bearer and non-browser header, and validates controls", async (t) => {
  let calls = 0;
  const relay = new ControlRelay(async () => { calls++; }); t.after(() => relay.close());
  const owner = await relay.listen();
  const body = { action: "interrupt", sessionID: "s" };
  const auth = { authorization: `Bearer ${owner.token}` };
  assert.equal((await http(owner.port, "/", { method: "POST", body })).status, 401);
  assert.equal((await http(owner.port, "/", { method: "POST", headers: { ...auth }, body })).status, 403);
  const headers = { ...auth, [INGEST_HEADER]: "control" };
  assert.equal((await http(owner.port, "/", { method: "POST", headers, body: { action: "delete", sessionID: "s" } })).status, 400);
  assert.equal((await http(owner.port, "/", { method: "POST", headers, body })).status, 200);
  assert.equal(calls, 1);
});

test("capability nonce stays behind token and host checks", async (t) => {
  const hub = new Hub(new Store(), { port: 0, host: "127.0.0.1", token: "secret", html: "", js: "" });
  hub.setController(async () => {}); t.after(() => hub.close()); await hub.listen();
  assert.equal((await http(hub.port, "/api/caps")).status, 401);
  const caps = await http(hub.port, "/api/caps", { headers: { authorization: "Bearer secret" } });
  assert.equal(caps.status, 200); assert.match(JSON.parse(caps.body).nonce, /^[a-f0-9]{32}$/);
  assert.equal(caps.headers["access-control-allow-origin"], undefined);
  assert.equal(caps.headers["cache-control"], "no-store");
});

test("ingest rejects invalid callback endpoints without applying events", async (t) => {
  const store = new Store();
  const hub = new Hub(store, { port: 0, host: "127.0.0.1", html: "", js: "" });
  t.after(() => hub.close()); await hub.listen();
  const res = await http(hub.port, "/api/ingest", {
    method: "POST", headers: { [INGEST_HEADER]: "ingest" },
    body: { events: [{ type: "session.created", properties: { info: { id: "s" } } }], owner: { id: "x", port: -1, token: "x" }, sessions: ["s"] },
  });
  assert.equal(res.status, 400); assert.equal(store.has("s"), false);
});

test("SSE reconnect restores archived history; live history ops and server restart replace it", async (t) => {
  let now = 1_000_000;
  const store = new Store(() => now);
  const hub = new Hub(store, { port: 0, host: "127.0.0.1", html: "", js: "" });
  t.after(() => hub.close()); await hub.listen();
  hub.ingest({ type: "session.created", properties: { info: { id: "root" } } });
  hub.ingest({ type: "session.created", properties: { info: { id: "child", parentID: "root" } } });
  hub.ingest({ type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } });
  now += 1000;
  hub.ingest({ type: "session.error", properties: { sessionID: "child", error: { message: "failed" } } });
  hub.ingest({ type: "session.idle", properties: { sessionID: "child" } });
  now += 61_000; hub.broadcast(store.tick());
  const client = new ClientState();

  const stream = (port: number, onSnapshot?: () => void) => new Promise<Snapshot>((resolve, reject) => {
    let buffer = "", snapshot: Snapshot;
    const req = request({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (!data) continue;
          if (frame.startsWith("event: snapshot")) {
            snapshot = JSON.parse(data); client.load(snapshot);
            if (onSnapshot) onSnapshot();
            else { req.destroy(); resolve(snapshot); }
          } else if (frame.startsWith("event: ops")) {
            const ops: Op[] = JSON.parse(data); client.apply(ops);
            if (ops.some((op) => op.op === "history-remove" && op.id === "child")) {
              req.destroy(); resolve(snapshot);
            }
          }
        }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error("SSE test timed out")));
    req.on("error", reject); req.end();
  });

  const first = await stream(hub.port);
  const reloaded = JSON.parse((await http(hub.port, "/api/state")).body) as Snapshot;
  const reconnected = await stream(hub.port);
  assert.deepEqual(first.history, reloaded.history);
  assert.deepEqual(first.history, reconnected.history);
  assert.equal(client.history.get("child")?.archived, true);
  assert.equal(client.agents.has("child"), false);
  await stream(hub.port, () => {
    now += 1000;
    hub.ingest({ type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } });
    hub.ingest({ type: "session.deleted", properties: { info: { id: "child" } } });
  });
  assert.equal(client.history.get("root")?.intervals.at(-1)?.state, "working");
  assert.equal(client.history.has("child"), false);
  await hub.close();
  const restarted = new Hub(new Store(), { port: 0, host: "127.0.0.1", html: "", js: "" });
  t.after(() => restarted.close()); await restarted.listen();
  await stream(restarted.port);
  assert.equal(client.history.size, 0);
});
