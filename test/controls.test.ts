import { test } from "node:test";
import assert from "node:assert/strict";
import { Controls } from "../web/controls.ts";
import { Hub } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { http } from "./http.ts";

test("controls refresh nonce and capabilities after hub restart without reloading the page", async (t) => {
  const opts = { port: 0, host: "127.0.0.1", html: "<head></head>", js: "" };
  const first = new Hub(new Store(), opts); t.after(() => first.close());
  first.setController(async () => {}); await first.listen();
  const port = first.port;
  const fetcher: typeof fetch = (url, options) => fetch(`http://127.0.0.1:${port}/${url}`, options);
  const controls = new Controls(fetcher);
  await controls.refresh(); const oldNonce = controls.caps.nonce;
  assert.ok(oldNonce);
  await first.close();
  const next = new Hub(new Store(), { ...opts, port }); t.after(() => next.close());
  let calls = 0; next.setController(async () => { calls++; }); await next.listen();
  const body = { action: "interrupt", sessionID: "s" } as const;
  assert.equal((await http(port, "/api/control", { method: "POST", headers: { "x-po-nonce": oldNonce }, body })).status, 403);
  // Same refresh used by the SSE snapshot handler.
  await controls.refresh(); assert.notEqual(controls.caps.nonce, oldNonce);
  await controls.send(body); assert.equal(calls, 1);
  next.setController(undefined);
  await controls.refresh(); assert.equal(controls.caps.control, false);
  await assert.rejects(controls.send(body), /no controls/); assert.equal(calls, 1);
});

test("click-time refresh works before the reconnect event and never replays a failed control", async () => {
  let nonce = "first", posts = 0;
  const controls = new Controls(async (url, options) => {
    if (url === "api/caps") return Response.json({ control: true, nonce });
    posts++;
    assert.equal(new Headers(options?.headers).get("x-po-nonce"), "second");
    return new Response("host failed", { status: 502 });
  });
  await controls.refresh(); nonce = "second";
  await assert.rejects(controls.send({ action: "interrupt", sessionID: "s" }), /host failed/);
  assert.equal(posts, 1);
});

test("late capability responses cannot overwrite newer credentials", async () => {
  let release!: (res: Response) => void;
  let count = 0;
  const controls = new Controls(async () => ++count === 1
    ? new Promise<Response>((r) => { release = r; })
    : Response.json({ control: true, nonce: "new" }));
  const old = controls.refresh(); await controls.refresh();
  release(Response.json({ control: true, nonce: "old" })); await old;
  assert.equal(controls.caps.nonce, "new");
});

test("unavailable capabilities disable controls without sending a POST", async () => {
  const urls: unknown[] = [];
  const controls = new Controls(async (url) => { urls.push(url); return new Response("unauthorized", { status: 401 }); });
  await assert.rejects(controls.send({ action: "interrupt", sessionID: "s" }), /unreachable/);
  assert.deepEqual(urls, ["api/caps"]); assert.equal(controls.caps.control, false);
});
