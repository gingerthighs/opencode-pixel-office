import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { ControlRelay, Hub, hostAllowed, hostName, INGEST_HEADER } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { http } from "./http.ts";

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
